// agent.js — headless agent runs in a Setu-owned container.
//
// Mirrors pr-review.js's split: invocation/protocol logic lives here,
// deliberately unaware of HTTP routing, the worktree registry, and container
// lifecycle. portal.js resolves repo/worktree context, brings the container up,
// and injects `stopContainer` so this file's `close()` can tear it down without
// importing portal internals.
//
// Why a Setu-owned container instead of sandcastle's own docker provider:
// sandcastle's provider runs `docker run -d --name sandcastle-<uuid>` and
// registers its own shutdown handler. That container is invisible to `procs`,
// to the concurrency cap, to checkMemoryCeilings, and to reconcileDevServers —
// exactly the untracked-process class behind the 30GB incident that `setu
// prune` exists to catch. So Setu spawns and tracks the container; sandcastle
// only ever reaches into it via `docker exec`.
//
// Verified against @ai-hero/sandcastle@0.12.0's BindMountSandboxHandle contract.
// Two of its requirements are load-bearing and easy to violate silently:
//   1. `exec` MUST stream line-by-line via onLine *during* the process. Idle
//      timeouts and live logs both hang off it; a buffered implementation that
//      only fires onLine at exit satisfies the types and breaks both.
//   2. `stdin` is how the prompt actually arrives — claudeCode builds
//      `claude ... -p -` and passes the prompt as stdin (avoids the 128KB
//      per-arg limit). Forget `docker exec -i` and the agent blocks on a stdin
//      that never closes, surfacing as an opaque 600s idle timeout.

import { HOME } from './lib.js';

// Matches writeDockerCompose's `working_dir: /workspace` — the agent container
// bind-mounts the same worktree at the same path as the dev container, so a
// path in a log line means the same thing in both.
export const SANDBOX_REPO_DIR = '/workspace';
export const SANDBOX_HOME = '/home/agent';

// Retained-output cap per stream. Output is delivered to onLine live regardless;
// this only bounds what `exec` returns, so a multi-hour stream-json run can't
// grow a single string past V8's max length and take the portal down with it.
const MAX_TAIL_BYTES = 64 * 1024;

const RUN_TIMEOUT_MS = 60 * 60 * 1000; // wall-clock ceiling on one agent run
const IDLE_TIMEOUT_SECONDS = 600;

// Real money on the user's account per run -- same ceiling pr-review.js
// applies to its own `claude -p` invocation. Overridable per call via
// runAgent's `maxBudgetUsd`.
const DEFAULT_MAX_BUDGET_USD = 2.0;

// ── agent adapters ───────────────────────────────────────────────────────────

// Maps a Setu agent id (the same ids as AGENT_CLIS in lib.js) to sandcastle's
// agent provider plus how that CLI's credential travels into the container.
//
// Setu never brokers credentials — it doesn't implement OAuth, hold refresh
// tokens, or call vendor APIs. Each CLI already authenticates itself; the only
// job here is making its *own* credential visible where it runs. Two kinds
// cover every eligible CLI:
//   'env'  — the vendor ships a sanctioned headless token (verified: `claude
//            setup-token` exists on 2.1.247, bills to the subscription, lasts a
//            year, and does NOT auto-refresh — hence the doctor check).
//   'file' — the credential is already a portable 0600 file; mount it read-only.
//
// Deliberately absent: cursor and antigravity. Their credentials are macOS
// Keychain / Electron Safe Storage with no documented headless export, so they
// stay interactive-only via the existing "Open in ..." handoff. An honest
// capability boundary beats a brittle keychain-decryption hack — and it means
// no code path here ever wants access to the host keychain.
export const AGENT_ADAPTERS = {
  claude: {
    credential: {
      key: 'CLAUDE_CODE_OAUTH_TOKEN',
      kind: 'env',
      mint: 'claude setup-token',
    },
    label: 'Claude Code',
  },
  codex: {
    credential: {
      hostPath: `${HOME}/.codex/auth.json`,
      kind: 'file',
      mint: 'codex login --device-auth',
      sandboxPath: `${SANDBOX_HOME}/.codex/auth.json`,
    },
    label: 'Codex',
  },
  opencode: {
    credential: {
      hostPath: `${HOME}/.local/share/opencode/auth.json`,
      kind: 'file',
      mint: 'opencode auth login',
      sandboxPath: `${SANDBOX_HOME}/.local/share/opencode/auth.json`,
    },
    label: 'opencode',
  },
};

async function sandcastle() {
  return import('@ai-hero/sandcastle');
}

function agentProvider(agentId, model, sandcastleModule) {
  if (agentId === 'claude') {
    return sandcastleModule.claudeCode(model ?? 'claude-opus-4-8');
  }
  if (agentId === 'codex') {
    return sandcastleModule.codex(model ?? 'gpt-5.4');
  }
  return sandcastleModule.opencode(model ?? 'claude-opus-4-8');
}

// Interactive-only agents, with the reason — surfaced by the portal so the UI
// can explain *why* a tool it can otherwise launch isn't offered for AFK runs,
// rather than silently omitting it.
export const INTERACTIVE_ONLY = {
  antigravity:
    'credential is an encrypted Electron Safe Storage blob in the macOS Keychain',
  cursor:
    'credential is Keychain-bound (cursor-access-token) with no headless export',
};

export function headlessAgents() {
  return Object.entries(AGENT_ADAPTERS).map(([id, a]) => ({
    id,
    label: a.label,
  }));
}

// Resolves what a given agent needs injected. Returns `{env, mounts}` on
// success or `{error}` when the credential simply isn't there yet — callers
// surface `mint` so the fix is one copyable command rather than a support
// question.
export function resolveCredential(agentId) {
  const adapter = AGENT_ADAPTERS[agentId];
  if (!adapter) {
    const why = INTERACTIVE_ONLY[agentId];
    return {
      error: why
        ? `${agentId} is interactive-only: ${why}`
        : `unknown agent "${agentId}"`,
    };
  }

  const { credential: c } = adapter;

  if (c.kind === 'env') {
    const value = process.env[c.key];
    if (!value) {
      return { error: `${c.key} is not set — mint one with \`${c.mint}\`` };
    }
    return { env: { [c.key]: value }, mounts: [] };
  }

  // kind === 'file'
  if (!Bun.file(c.hostPath).size) {
    return { error: `${c.hostPath} not found — sign in with \`${c.mint}\`` };
  }
  // Read-only: the agent needs to *use* the credential, never rewrite it. A
  // writable mount would also let a compromised run persist a swapped token
  // back onto the host.
  return {
    env: {},
    mounts: [
      { hostPath: c.hostPath, readonly: true, sandboxPath: c.sandboxPath },
    ],
  };
}

// ── spend guard ──────────────────────────────────────────────────────────────

// pr-review.js caps `claude -p` with `--max-budget-usd`. sandcastle can't
// take that from us directly, and three things had to be verified (not
// assumed) before landing on the approach below:
//
//   1. No passthrough option. dist/index.d.ts's ClaudeCodeOptions accepts
//      only effort/env/captureSessions/sessionStorage/permissionMode --
//      there is no budget field and no arbitrary-flag escape hatch.
//   2. No env var either. `strings` on the installed 2.1.250 claude binary
//      (`/Users/mukulchugh/.local/share/claude/versions/2.1.250`) finds
//      `--max-budget-usd` wired only to `options.maxBudgetUsd` in the CLI's
//      own arg parser -- no `*BUDGET*` environment variable is ever read.
//      So there is nothing to inject through resolveCredential's env
//      channel; option 1 from the plan does not exist for claude.
//   3. codex and opencode have no budget mechanism at all. `codex exec
//      --help` and `opencode run --help` list no budget/cost/limit flag,
//      and neither reads a budget env var (same binary-string check found
//      nothing). There is nothing to wrap or inject for either -- they stay
//      unguarded by necessity, not oversight.
//
// What's left, and what actually works: wrap the AgentProvider claudeCode()
// returns and rewrite the command its buildPrintCommand hands to
// sandcastle's run(). Verified empirically, not inferred from source
// reading alone -- a scratch call to claudeCode('model').buildPrintCommand
// with the exact {dangerouslySkipPermissions: true, resumeSession,
// forkSession} shape run()'s own execEffect passes (index.js:252) produced:
//   claude --print --verbose --dangerously-skip-permissions --output-format
//   stream-json --model 'claude-opus-4-8' -p -
// and with resumeSession+forkSession set:
//   ...--model 'claude-opus-4-8' --resume 'abc-123' --fork-session -p -
// The command always ends in ` -p -`: `-p` is `--print` again and `-` is
// the stdin marker (the prompt itself travels via `stdin`, never argv --
// see the file header). Splicing the flag in before that trailing sentinel
// keeps it an option before the positional placeholder, in both the fresh
// and resumed/forked shapes.
//
// This is a string splice against a shape sandcastle owns, not a documented
// contract -- a future sandcastle bump could change the suffix and make the
// regex a no-op. A silent no-op here is worse than the regression this file
// exists to fix: the caller would still see `guarded: true` and believe a
// run is capped when it isn't. So the splice checks its own result and
// throws rather than hand back an uncapped command wearing a capped label.
const CLAUDE_PRINT_SENTINEL_RE = / -p -$/;

function withClaudeBudget(provider, maxBudgetUsd) {
  return {
    ...provider,
    buildPrintCommand(options) {
      const built = provider.buildPrintCommand(options);
      const command = built.command.replace(
        CLAUDE_PRINT_SENTINEL_RE,
        ` --max-budget-usd ${maxBudgetUsd} -p -`
      );
      if (!command.includes('--max-budget-usd')) {
        throw new Error(
          `withClaudeBudget: claudeCode's print command no longer ends in ` +
            `" -p -" -- the budget flag did not land, refusing to run ` +
            `unguarded under a "guarded" label. Got: ${built.command}`
        );
      }
      return { ...built, command };
    },
  };
}

// Per-agent budget mechanisms, keyed like AGENT_ADAPTERS. Only claude has
// one -- see above. An agent id with no entry here is guarded by nothing,
// on purpose: codex and opencode simply have no such flag to wrap.
const BUDGET_WRAPPERS = {
  claude: withClaudeBudget,
};

// Applies the agent's budget mechanism when one exists; otherwise returns
// the provider untouched. `guarded` is the degrade-safely signal a caller
// needs: the run must proceed either way (an unguarded agent is still
// useful), but nothing here may let an unlimited run masquerade as capped.
export function applyBudgetGuard(agentId, provider, maxBudgetUsd) {
  const wrap = BUDGET_WRAPPERS[agentId];
  if (!wrap) {
    return { guarded: false, provider };
  }
  return { guarded: true, provider: wrap(provider, maxBudgetUsd) };
}

// ── docker exec ──────────────────────────────────────────────────────────────

// Bounded FIFO of decoded output. Keeps the tail (what a failure message needs)
// rather than the head, and counts bytes not characters so a stream of
// multi-byte JSON can't blow past the cap.
export function boundedTail(limit) {
  const parts = [];
  let bytes = 0;
  const utf8Tail = (text) => {
    const tail = Buffer.from(text).subarray(-limit);
    for (let offset = 0; offset < tail.length; offset += 1) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          tail.subarray(offset)
        );
      } catch {
        // The cap may split a multi-byte character. Drop only its incomplete
        // prefix, never return replacement characters in structured output.
      }
    }
    return '';
  };
  return {
    push(s) {
      parts.push(s);
      bytes += Buffer.byteLength(s);
      while (bytes > limit) {
        if (parts.length > 1) {
          bytes -= Buffer.byteLength(parts.shift());
          continue;
        }
        const trimmed = utf8Tail(parts[0]);
        bytes = Buffer.byteLength(trimmed);
        parts[0] = trimmed;
      }
    },
    toString: () => parts.join(''),
  };
}

export async function pumpLines(
  stream,
  onChunk,
  { maxBytes = MAX_TAIL_BYTES } = {}
) {
  const decoder = new TextDecoder();
  let buf = '';
  let truncated = false;
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 1;
  const cap = () => {
    if (Buffer.byteLength(buf) <= limit) {
      return;
    }
    const tail = Buffer.from(buf).subarray(-limit);
    for (let offset = 0; offset < tail.length; offset += 1) {
      try {
        buf = new TextDecoder('utf-8', { fatal: true }).decode(
          tail.subarray(offset)
        );
        truncated = true;
        return;
      } catch {
        // The retained tail starts partway through a UTF-8 character.
      }
    }
    buf = '';
    truncated = true;
  };
  const drain = () => {
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      onChunk(buf.slice(0, nl), { truncated });
      buf = buf.slice(nl + 1);
      truncated = false;
      nl = buf.indexOf('\n');
    }
  };
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    cap();
    drain();
  }
  buf += decoder.decode();
  cap();
  drain();
  // Trailing partial line — a stream-json run that dies mid-write still has its
  // last (possibly diagnostic) bytes here, so don't drop them.
  if (buf) {
    onChunk(buf, { truncated });
  }
}

export async function dockerExec(container, command, options = {}) {
  const { cwd, onLine, stdin } = options;

  const args = ['docker', 'exec'];
  if (stdin !== undefined) {
    args.push('-i');
  }
  if (cwd) {
    args.push('-w', cwd);
  }
  args.push(container, 'sh', '-c', command);

  const proc = Bun.spawn(args, {
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
  });

  if (stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }

  const outTail = boundedTail(MAX_TAIL_BYTES);
  const errTail = boundedTail(MAX_TAIL_BYTES);

  // Both pumps must run concurrently with `exited`: a process that fills the
  // stderr pipe while nobody drains it deadlocks, and awaiting `exited` first
  // would never let the drain start.
  const [, , exitCode] = await Promise.all([
    pumpLines(proc.stdout, (line) => {
      outTail.push(`${line}\n`);
      onLine?.(line);
    }),
    pumpLines(proc.stderr, (line) => errTail.push(`${line}\n`)),
    proc.exited,
  ]);

  if (proc.signalCode) {
    throw new Error(
      `Agent command was terminated by signal ${proc.signalCode}`
    );
  }
  return {
    exitCode,
    stderr: errTail.toString(),
    stdout: outTail.toString(),
  };
}

// ── the sandbox provider ─────────────────────────────────────────────────────

// `stopContainer` is injected rather than imported so this file stays unaware of
// portal.js (same reason pr-review.js takes `spawnText`). It must actually stop
// the container: on an idle timeout sandcastle abandons the exec *promise*
// without cancelling the underlying process, so a no-op close() would leave the
// agent running inside a container nobody is reading from — burning subscription
// budget with no output consumer, which is the worst of both worlds.
export function setuSandbox({
  container,
  createBindMountSandboxProvider,
  env = {},
  stopContainer,
}) {
  return createBindMountSandboxProvider({
    create: async () => ({
      close: async () => {
        await stopContainer();
      },
      copyFileIn: async (hostPath, sandboxPath) => {
        await Bun.spawn([
          'docker',
          'cp',
          hostPath,
          `${container}:${sandboxPath}`,
        ]).exited;
      },
      copyFileOut: async (sandboxPath, hostPath) => {
        await Bun.spawn([
          'docker',
          'cp',
          `${container}:${sandboxPath}`,
          hostPath,
        ]).exited;
      },
      exec: (command, opts) =>
        dockerExec(container, command, { cwd: SANDBOX_REPO_DIR, ...opts }),
      worktreePath: SANDBOX_REPO_DIR,
    }),
    env,
    name: 'setu',
    sandboxHomedir: SANDBOX_HOME,
  });
}

// ── run state ────────────────────────────────────────────────────────────────

// key: `${repo}/${name}` -> { agentId, budgetGuarded, error, iteration,
// maxIterations, phase, startedAt, tool }. Same fire-and-forget shape as
// portal.js's deploy maps, and like them it does not survive a portal
// restart -- durable run records are a later stage.
//
// Deliberately NOT portal.js's `procs`: that map is keyed by worktree and every
// consumer assumes the entry is a dev server. An agent entry there would count
// against maxConcurrentDevServers, and checkMemoryCeilings would "restart" it
// by spawning `bun dev` over the top of it.
const agentRuns = new Map();

export function agentStatus(repo, name) {
  return agentRuns.get(`${repo}/${name}`) ?? null;
}

// The onAgentStreamEvent callback sandcastle invokes for every text chunk and
// tool call the agent emits. Does no I/O and broadcasts nothing on purpose:
// these arrive at roughly token frequency, so a push per event would flood
// every connected client. The portal's existing 3s `worktrees` tick already
// carries this map to the UI, which makes mutating in place sufficient -- and
// keeps the hot path to two field writes.
function streamHandler(key) {
  return (event) => {
    const runState = agentRuns.get(key);
    if (!runState) {
      return;
    }
    runState.iteration = event.iteration;
    // Only toolCall carries a name; text/raw events leave the last tool shown,
    // which is what you want -- the agent is still working on that tool's
    // result, not on nothing.
    if (event.type === 'toolCall') {
      runState.tool = event.name;
    }
  };
}

// budgetGuarded is null when the caller hasn't resolved a budget mechanism
// yet (e.g. a direct test of run-state bookkeeping); runAgent always passes
// the real applyBudgetGuard result so a live run's status is never left
// looking capped by default.
export function agentRunStart(
  repo,
  name,
  { agentId, budgetGuarded = null, maxIterations }
) {
  const key = `${repo}/${name}`;
  agentRuns.set(key, {
    agentId,
    budgetGuarded,
    error: null,
    iteration: 1,
    maxIterations,
    phase: 'running',
    startedAt: Date.now(),
    tool: null,
  });
  return streamHandler(key);
}

export function agentRunFinish(repo, name, { error = null } = {}) {
  const runState = agentRuns.get(`${repo}/${name}`);
  if (!runState) {
    return;
  }
  runState.error = error;
  runState.phase = error ? 'failed' : 'done';
  runState.tool = null;
}

// ── running an agent ─────────────────────────────────────────────────────────

// One agent run against one worktree. Assumes the caller has already brought the
// container up and reserved a concurrency slot — admission has to be gated
// *before* this is called, because sandcastle wraps provider `create()` in a
// 120s timeout and a slot wait inside it would surface as a spurious container
// start failure.
//
// branchStrategy is always `head`: the worktree already exists and is Setu's,
// so sandcastle must not create one of its own under `.sandcastle/worktrees/`
// (setu doctor flags git worktrees missing from the registry, and they'd get no
// port, domain, or .envrc). `head` + `cwd` makes sandcastle operate in place.
export async function runAgent({
  agentId,
  container,
  cwd,
  logPath,
  maxBudgetUsd = DEFAULT_MAX_BUDGET_USD,
  maxIterations = 1,
  model,
  name,
  prompt,
  promptArgs,
  promptFile,
  repo,
  resumeSession,
  signal,
  stopContainer,
}) {
  const adapter = AGENT_ADAPTERS[agentId];
  if (!adapter) {
    throw new Error(`no headless adapter for agent "${agentId}"`);
  }
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    throw new Error('maxBudgetUsd must be a finite positive number');
  }

  const cred = resolveCredential(agentId);
  if (cred.error) {
    throw new Error(cred.error);
  }

  const sandcastleModule = await sandcastle();
  const { guarded: budgetGuarded, provider } = applyBudgetGuard(
    agentId,
    agentProvider(agentId, model, sandcastleModule),
    maxBudgetUsd
  );

  const onStreamEvent = agentRunStart(repo, name, {
    agentId,
    budgetGuarded,
    maxIterations,
  });

  try {
    const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let timeoutId;
    try {
      const timeoutResult = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          void Promise.resolve(stopContainer()).catch(() => {});
          reject(
            new Error(`Agent run exceeded ${RUN_TIMEOUT_MS}ms wall-clock limit`)
          );
        }, RUN_TIMEOUT_MS);
      });
      const result = await Promise.race([
        (async () =>
          sandcastleModule.run({
            agent: provider,
            branchStrategy: { type: 'head' },
            cwd,
            idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
            // Sandcastle's default writes .sandcastle/logs/<branch>.log *inside* the
            // repo — which here is a live worktree with a dev server watching it. Always
            // pass an explicit path under Setu's own log tree.
            logging: {
              onAgentStreamEvent: onStreamEvent,
              path: logPath,
              type: 'file',
            },
            maxIterations,
            name,
            prompt,
            promptArgs,
            promptFile,
            resumeSession,
            // Credential env rides the provider channel rather than a .sandcastle/.env
            // file scattered into every worktree. EnvResolver only forwards keys named
            // in that file and silently yields nothing when it's absent, which would
            // look exactly like a broken token.
            sandbox: setuSandbox({
              container,
              createBindMountSandboxProvider:
                sandcastleModule.createBindMountSandboxProvider,
              env: cred.env,
              stopContainer,
            }),
            signal: runSignal,
            timeouts: { commitCollectionMs: 60_000, gitSetupMs: 30_000 },
          }))(),
        timeoutResult,
      ]);
      agentRunFinish(repo, name);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e) {
    // The chip has to show the failure, not silently revert to "no run" -- a
    // vanished chip reads as "nothing happened" when something did. `e` here
    // is a caught value, not a typed Error -- something can throw null or a
    // plain string, and `e.message` on a nullish throw would itself throw
    // before the `?? e` fallback ever ran, so the optional chain is
    // load-bearing, not accidental.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: e may be a non-Error throw (null/string) -- see comment above
    agentRunFinish(repo, name, { error: String(e?.message ?? e) });
    throw e;
  }
}

export { DEFAULT_MAX_BUDGET_USD, RUN_TIMEOUT_MS };
