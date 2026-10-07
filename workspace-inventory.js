import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const HEAD_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HEAD_REF = /^refs\/heads\//;

const reviewGates = [
  {
    id: 'ignored-data',
    label:
      'Inspect and preserve ignored local files; a clean Git status does not cover them.',
  },
  {
    id: 'shared-targets',
    label:
      'Check incoming symlinks and shared environment targets, especially the main checkout.',
  },
  {
    id: 'exact-merged-head',
    label:
      'Verify this exact HEAD is retained upstream; a merged PR label is not proof.',
  },
  {
    id: 'task-ownership',
    label:
      'Confirm active or blocked task ownership; unknown does not mean unowned.',
  },
  {
    id: 'branch-retention',
    label:
      'Retain required branch refs and detached commits before considering removal.',
  },
  {
    id: 'runtime-resources',
    label: 'Review live processes, containers, volumes and pending operations.',
  },
];

// NUL framing preserves spaces, quotes and newlines in paths and lock reasons.
export function parseLinkedWorktrees(text) {
  if (!text) {
    return [];
  }
  if (!text.endsWith('\0\0')) {
    throw new Error('Incomplete Git worktree output');
  }
  const rows = new Map();
  for (const block of text.split('\0\0').filter(Boolean)) {
    const fields = block.split('\0');
    const path = fields.shift();
    if (!(path.startsWith('worktree ') && isAbsolute(path.slice(9)))) {
      throw new Error('Invalid Git worktree path');
    }
    const attrs = new Map(
      fields.map((field) => {
        const space = field.indexOf(' ');
        return space < 0
          ? [field, '']
          : [field.slice(0, space), field.slice(space + 1)];
      })
    );
    if (attrs.has('bare')) {
      continue;
    }
    const head = attrs.get('HEAD');
    if (!HEAD_SHA.test(head ?? '')) {
      throw new Error('Invalid Git HEAD');
    }
    const row = {
      branch: attrs.get('branch')?.replace(HEAD_REF, '') ?? null,
      detached: attrs.has('detached'),
      head,
      locked: attrs.has('locked'),
      path: resolve(path.slice(9)),
      prunable: attrs.has('prunable'),
    };
    const previous = rows.get(row.path);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) {
      throw new Error('Conflicting Git worktree identities');
    }
    rows.set(row.path, row);
  }
  return [...rows.values()];
}

async function mapBounded(values, limit, task) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        // biome-ignore lint/performance/noAwaitInLoops: Each worker must finish before taking another item to enforce the concurrency bound.
        result[index] = await task(values[index]);
      }
    })
  );
  return result;
}

function reviewReasons(row, active, operation) {
  const reasons = [];
  if (!row.registered) {
    reasons.push(
      'Not registered with Setu; inspect this existing checkout before creating another.'
    );
  }
  if (row.linked === false) {
    reasons.push('Registered path is absent from the Git worktree list.');
  }
  if (row.discovery === 'unknown') {
    reasons.push(
      'Git discovery is unavailable; checkout identity is unconfirmed.'
    );
  }
  if (row.presence === 'missing') {
    reasons.push('Checkout directory is missing.');
  }
  if (row.presence === 'unknown') {
    reasons.push('Checkout directory could not be inspected.');
  }
  if (row.detached) {
    reasons.push('Detached HEAD needs an explicit retained commit reference.');
  }
  if (row.locked) {
    reasons.push(
      'Git worktree is locked; inspect the reason before any cleanup.'
    );
  }
  if (row.prunable) {
    reasons.push(
      'Git marks this record prunable; that is not deletion approval.'
    );
  }
  if (active === true || operation) {
    reasons.push(
      'Setu reports runtime activity or an operation; inspect its owner.'
    );
  }
  if (row.name === 'main' || row.branch === 'main') {
    reasons.push('Main checkout may supply shared environment targets.');
  }
  reasons.push(
    'Task ownership and last use are unknown; confirm with the current owner.'
  );
  return reasons;
}

async function checkoutPresence(path, statPath) {
  try {
    return (await statPath(path)).isDirectory() ? 'present' : 'missing';
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? 'missing'
      : 'unknown';
  }
}

// Only discovery is cached. Runtime observations are refreshed independently and
// never claim that an unknown external task owner has released a checkout.
export function createWorkspaceInventory({
  readRegistry,
  run,
  readRuntime = async () => new Map(),
  statPath = stat,
  now = Date.now,
  ttlMs = 30_000,
}) {
  let cached = null;
  let pending = null;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep discovery and registry reconciliation together so failure cannot become absence.
  async function discover() {
    const { projects, registrations } = await readRegistry();
    const previousRows = cached?.rows ?? [];
    const discoveries = await mapBounded(
      projects,
      2,
      async ({ repo, repoDir }) => {
        try {
          const result = await run(
            ['git', '-C', repoDir, 'worktree', 'list', '--porcelain', '-z'],
            {
              maxOutputBytes: 2 * 1024 * 1024,
              timeoutMs: 5000,
            }
          );
          if (result.code !== 0 || result.timedOut || result.truncated) {
            throw new Error('Git discovery failed');
          }
          return {
            checkedAt: now(),
            error: null,
            linked: parseLinkedWorktrees(result.stdout),
            repo,
            state: 'ready',
          };
        } catch {
          return {
            checkedAt: now(),
            error: 'Git worktree discovery unavailable',
            linked: previousRows.filter(
              (row) => row.repo === repo && row.linked !== false
            ),
            repo,
            state: 'unknown',
          };
        }
      }
    );
    const byRepo = new Map(discoveries.map((item) => [item.repo, item]));
    const rows = new Map();
    for (const discovery of discoveries) {
      for (const linked of discovery.linked) {
        const id = JSON.stringify([discovery.repo, linked.path]);
        rows.set(id, {
          branch: linked.branch,
          detached: linked.detached,
          discovery: discovery.state,
          head: linked.head,
          id,
          key: null,
          linked: discovery.state === 'ready' ? true : null,
          locked: linked.locked,
          name: null,
          path: linked.path,
          port: null,
          prunable: linked.prunable,
          registered: false,
          repo: discovery.repo,
        });
      }
    }
    for (const entry of registrations) {
      const path = resolve(entry.path);
      const id = JSON.stringify([entry.repo, path]);
      const existing = rows.get(id);
      const discovery = byRepo.get(entry.repo)?.state ?? 'unknown';
      rows.set(id, {
        branch: null,
        detached: false,
        discovery,
        head: null,
        id,
        linked: discovery === 'ready' ? false : null,
        locked: false,
        path,
        prunable: false,
        repo: entry.repo,
        ...existing,
        key: entry.key,
        name: entry.name,
        port: entry.port,
        registered: true,
      });
    }
    const inspected = await mapBounded([...rows.values()], 4, async (row) => ({
      ...row,
      presence: await checkoutPresence(row.path, statPath),
    }));
    const complete =
      discoveries.every((item) => item.state === 'ready') &&
      registrations.every((entry) => byRepo.has(entry.repo));
    const observedLinked = inspected.filter(
      (row) => row.linked === true
    ).length;
    return {
      checkedAt: now(),
      counts: {
        linked: complete ? observedLinked : null,
        missing: complete
          ? inspected.filter((row) => row.presence === 'missing').length
          : null,
        observedLinked,
        registered: registrations.length,
        unregistered: complete
          ? inspected.filter((row) => !row.registered).length
          : null,
      },
      repositories: discoveries.map(({ linked, ...repository }) => repository),
      rows: inspected,
      state: complete ? 'ready' : 'partial',
    };
  }

  return {
    async read() {
      if (!pending && (!cached || now() - cached.checkedAt >= ttlMs)) {
        pending = discover()
          .then((value) => {
            cached = value;
          })
          .finally(() => {
            pending = null;
          });
      }
      if (pending) {
        await pending;
      }
      const runtime = await Promise.resolve()
        .then(readRuntime)
        .catch(() => new Map());
      return {
        ...cached,
        reviewGates,
        rows: cached.rows.map((row) => {
          const observed = row.registered ? runtime.get(row.key) : null;
          const active = observed?.active ?? null;
          const operation = observed?.operation ?? null;
          const reasons = reviewReasons(row, active, operation);
          return {
            ...row,
            active,
            lastPortalActivityAt: observed?.lastPortalActivityAt ?? null,
            lastUsedAt: null,
            operation,
            owner: null,
            review: {
              reasons,
              requiredGates: reviewGates.map((gate) => gate.id),
            },
          };
        }),
      };
    },
  };
}
