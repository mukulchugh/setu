import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inspectCheckoutIdentity } from './checkout-identity.js';
import { inspectSpansCapacity } from './spans-capacity.js';
import { isRecord } from './spans-execution-core.js';
import {
  checkWriter,
  claimWriter,
  releaseWriter,
  writerBaseline,
} from './writer-claims.js';

// Real adapters for the Spans dispatch coordinator. Each one reads or changes
// an existing Setu owner (checkout identity, setup progress, writer claims,
// archive capacity) and reports what it saw. None of them reports success for
// something it could not observe: an unknown answer is a failure, never a
// default.

const execFileAsync = promisify(execFile);
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
];
const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LINKER_SECTION = /^\[install\]$/;
const ANY_SECTION = /^\[.+\]$/;
const LINE_BREAK = /\r?\n/;
const LINE_COMMENT = /#.*$/;
const WRITER_HELD = /^Worktree held by /;
const LINKER_VALUE = /^linker\s*=\s*["']([a-z]+)["']$/;

async function gitText(dir, args) {
  const env = { ...process.env };
  for (const key of GIT_ENV_KEYS) {
    delete env[key];
  }
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '-C', dir, ...args],
    { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }
  );
  return stdout;
}

export function createCheckoutAdapter({
  baseline = writerBaseline,
  fs = fsPromises,
  head = async (dir) =>
    (await gitText(dir, ['rev-parse', '--verify', 'HEAD'])).trim(),
  identity = inspectCheckoutIdentity,
} = {}) {
  return {
    async observe({ repoDir, wtDir }) {
      try {
        const checkoutIdentity = await identity({ repoDir, wtDir }, fs);
        const observedHead = await head(wtDir);
        if (
          !(checkoutIdentity?.known === true && HEAD_PATTERN.test(observedHead))
        ) {
          return { ok: false };
        }
        return {
          dirty: baseline(wtDir),
          head: observedHead,
          identity: checkoutIdentity,
          ok: true,
        };
      } catch {
        return { ok: false };
      }
    },
  };
}

async function installLinker(wtDir) {
  let text;
  try {
    text = await fsPromises.readFile(join(wtDir, 'bunfig.toml'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 'default';
    }
    throw error;
  }
  let inInstall = false;
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.replace(LINE_COMMENT, '').trim();
    if (LINKER_SECTION.test(line)) {
      inInstall = true;
    } else if (ANY_SECTION.test(line)) {
      inInstall = false;
    } else if (inInstall) {
      const match = LINKER_VALUE.exec(line);
      if (match) {
        return match[1];
      }
    }
  }
  return 'default';
}

// The dependency inputs a worker will run against, observed from the checkout.
// A checkout without a lockfile has no identity to bind, so it is unknown.
export function createDependencyAdapter({ bunVersion = Bun.version } = {}) {
  return {
    async observe({ wtDir }) {
      try {
        const lock = await fsPromises.readFile(join(wtDir, 'bun.lock'));
        return {
          identity: {
            bunVersion,
            linkerMode: await installLinker(wtDir),
            lockfileHash: createHash('sha256').update(lock).digest('hex'),
            platformNamespace: `${process.platform}-${process.arch}-bun-${bunVersion}`,
          },
          ok: true,
        };
      } catch {
        return { ok: false };
      }
    },
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Setup is complete only when the durable setup record says so for this exact
// checkout. A missing record is not ready: nothing here runs setup.
export function createSetupAdapter({ setupProgress }) {
  return {
    ensure({ checkoutIdentity, target }) {
      let record;
      try {
        record = setupProgress.get(target);
      } catch {
        return { code: 'OPERATION_UNKNOWN', ok: false };
      }
      if (record?.ok === false) {
        return { code: 'SETUP_PROGRESS_UNAVAILABLE', ok: false };
      }
      if (!record) {
        return { ok: true, state: 'absent' };
      }
      if (!sameIdentity(record.checkoutIdentity, checkoutIdentity)) {
        return { code: 'CHECKOUT_IDENTITY_MISMATCH', ok: false };
      }
      if (record.state === 'running') {
        return { code: 'SETUP_ALREADY_RUNNING', ok: false };
      }
      if (record.state === 'unknown') {
        return { code: 'OPERATION_UNKNOWN', ok: false };
      }
      return record.state === 'completed'
        ? { ok: true, state: 'ready' }
        : { code: 'SETUP_ATTEMPT_INVALID', ok: false };
    },
  };
}

export function createArchiveAdapter({ budgetBytes, root }) {
  return {
    capacity: () => inspectSpansCapacity({ budgetBytes, root }),
  };
}

// Reads the committed run view for the coordinator's fenced checks.
export function createRunStateAdapter({ store }) {
  return {
    read({ actionId, runId }) {
      const read = store.readRun({ runId });
      if (read?.ok !== true || !isRecord(read.view)) {
        return { ok: false };
      }
      const { view } = read;
      const action = isRecord(view.actions?.[actionId])
        ? view.actions[actionId]
        : null;
      const span =
        action && isRecord(view.spans?.[action.spanId])
          ? view.spans[action.spanId]
          : null;
      return {
        action,
        generation: read.generation,
        ok: true,
        planVersion: view.planVersion,
        span,
      };
    },
  };
}

function heldByAnother(error) {
  return WRITER_HELD.test(String(error?.message));
}

// Writer claims are cooperative coordination owned by writer-claims.js. The
// release is fenced to an accepted span here, at the effect: the committed
// run view must still show this exact acceptance before the claim file goes.
export function createWriterAdapter({
  check = checkWriter,
  claim = claimWriter,
  pid = process.pid,
  release = releaseWriter,
  store,
}) {
  function acceptedFor(binding) {
    const read = store.readRun({ runId: binding.runId });
    if (read?.ok !== true || read.generation !== binding.generation) {
      return false;
    }
    const span = read.view?.spans?.[binding.spanId];
    const action = read.view?.actions?.[binding.actionId];
    return (
      isRecord(span) &&
      isRecord(action) &&
      action.state === 'completed' &&
      span.state === 'completed' &&
      span.acceptedActionId === binding.actionId &&
      span.acceptedEvidenceId === binding.acceptedEvidenceId
    );
  }

  return {
    check({ checkoutPath, session }) {
      try {
        return check(checkoutPath, session);
      } catch {
        return { ok: false };
      }
    },
    claim({ checkoutPath, owner }) {
      try {
        return claim(checkoutPath, { ...owner, pid });
      } catch (error) {
        if (heldByAnother(error)) {
          return { code: 'WRITER_BUSY', ok: false };
        }
        throw error;
      }
    },
    release({ binding, checkoutPath, session }) {
      if (
        !acceptedFor(binding) ||
        binding.checkoutIdentity?.checkoutPath === undefined
      ) {
        return { code: 'ACCEPTANCE_PENDING', ok: false };
      }
      try {
        return release(checkoutPath, session);
      } catch {
        return { ok: false };
      }
    },
  };
}
