import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { observeProcessIdentity } from './process-observation.js';
import { proveProcessGroupOwnership } from './process-tree.js';
import { createNativeSessionObserver } from './spans-native-session.js';

// The process side of a Spans worker attempt: a durable output spool and the
// one supervisor that owns each child process. The worker engine
// (spans-worker.js) decides what is recorded; this module only starts the
// process, forwards what it printed, reports how it ended, and signals it when
// asked. It never admits, reserves, claims or accepts anything, so a launch
// cannot reserve a second time or have a second supervisor.

const DIGEST = /^[0-9a-f]{64}$/;
const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;
const RECORDS_FILE = 'records.jsonl';
const FINAL_FILE = 'final.json';
const DEFAULT_ESCALATION_MS = 5000;
const DEFAULT_EXIT_GRACE_MS = 5000;
const BACKPRESSURE_WAIT_MS = 10;
const GROUP_POLL_MS = 50;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Spool: records of captured output, kept on disk until the attempt is
// finalized into a content-addressed artifact.
// ---------------------------------------------------------------------------

export function createSpansExecutionSpool({
  artifacts,
  fs = fsPromises,
  root,
}) {
  const loaded = new Map();
  const spoolRoot = join(root, 'spool');

  const directoryFor = (attemptDigest) =>
    DIGEST.test(attemptDigest) ? join(spoolRoot, attemptDigest) : null;

  async function ensureDirectory(path) {
    await fs.mkdir(path, { mode: PRIVATE_DIRECTORY, recursive: true });
    await fs.chmod(path, PRIVATE_DIRECTORY);
  }

  // Reads the records already on disk. A final line without its newline is a
  // write a crash cut short; it is cut off so the next append stays whole.
  async function scan(directory) {
    const path = join(directory, RECORDS_FILE);
    let text;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { bytes: 0, digests: [], texts: [] };
      }
      throw error;
    }
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete.length !== text.length) {
      await fs.truncate(path, Buffer.byteLength(complete, 'utf8'));
    }
    const digests = [];
    const texts = [];
    let bytes = 0;
    for (const line of complete.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (
        record.seq !== digests.length ||
        sha256(record.text) !== record.digest
      ) {
        throw new Error('spool record is out of sequence or altered');
      }
      digests.push(record.digest);
      texts.push(record.text);
      bytes += Buffer.byteLength(record.text, 'utf8');
    }
    return { bytes, digests, texts };
  }

  async function stateFor(directory) {
    const known = loaded.get(directory);
    if (known) {
      return known;
    }
    const state = await scan(directory);
    loaded.set(directory, state);
    return state;
  }

  async function readFinal(directory) {
    try {
      return JSON.parse(await fs.readFile(join(directory, FINAL_FILE), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async function append({ attemptDigest, bytes, digest, seq, text }) {
    const directory = directoryFor(attemptDigest);
    if (!(directory && sha256(text) === digest)) {
      return { ok: false };
    }
    try {
      await ensureDirectory(spoolRoot);
      await ensureDirectory(directory);
      if (await readFinal(directory)) {
        return { ok: false };
      }
      const state = await stateFor(directory);
      if (seq < state.digests.length) {
        // The worker resends a record after an interrupted answer.
        return state.digests[seq] === digest ? { ok: true } : { ok: false };
      }
      if (seq !== state.digests.length) {
        return { ok: false };
      }
      const handle = await fs.open(
        join(directory, RECORDS_FILE),
        'a',
        PRIVATE_FILE
      );
      try {
        await handle.appendFile(`${JSON.stringify({ digest, seq, text })}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      state.digests.push(digest);
      state.texts.push(text);
      state.bytes += bytes;
      return { ok: true };
    } catch {
      loaded.delete(directory);
      return { ok: false, retryable: true };
    }
  }

  async function stat({ attemptDigest }) {
    const directory = directoryFor(attemptDigest);
    if (!directory) {
      return { ok: false };
    }
    try {
      const final = await readFinal(directory);
      if (final) {
        return { bytes: final.bytes, chunks: final.chunks, ok: true };
      }
      const state = await stateFor(directory);
      return { bytes: state.bytes, chunks: state.digests.length, ok: true };
    } catch {
      return { ok: false };
    }
  }

  // Publishes the captured records as one artifact. Repeating it for the same
  // chain returns the same artifact; a different chain is refused.
  async function finalize({ attemptDigest, chainDigest, chunks, complete }) {
    const directory = directoryFor(attemptDigest);
    if (!directory) {
      return { ok: false };
    }
    try {
      const final = await readFinal(directory);
      if (final) {
        return final.chainDigest === chainDigest && final.complete === complete
          ? { artifactId: final.artifactId, ok: true }
          : { ok: false };
      }
      const state = await stateFor(directory);
      if (
        state.digests.length !== chunks ||
        sha256(state.digests.join('\n')) !== chainDigest
      ) {
        return { ok: false };
      }
      const stored = artifacts.put({
        mediaType: 'text/plain',
        text: state.texts.join(''),
      });
      if (stored?.ok !== true) {
        return { ok: false };
      }
      await fs.writeFile(
        join(directory, FINAL_FILE),
        JSON.stringify({
          artifactId: stored.artifactId,
          bytes: state.bytes,
          chainDigest,
          chunks,
          complete,
        }),
        { flag: 'wx', mode: PRIVATE_FILE }
      );
      await fs.rm(join(directory, RECORDS_FILE), { force: true });
      loaded.delete(directory);
      return { artifactId: stored.artifactId, ok: true };
    } catch {
      return { ok: false };
    }
  }

  return Object.freeze({ append, finalize, stat });
}

// ---------------------------------------------------------------------------
// Launcher: starts one child process in its own process group, forwards its
// output to the worker's sink, reports how it ended, and signals only a
// process whose identity it can still prove.
// ---------------------------------------------------------------------------

// Splits text on code point boundaries so each piece fits the worker's chunk
// bound. A piece larger than the bound would be refused and lost.
function splitForBound(text, maxBytes) {
  const pieces = [];
  let piece = '';
  let size = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8');
    if (size + width > maxBytes) {
      pieces.push(piece);
      piece = '';
      size = 0;
    }
    piece += character;
    size += width;
  }
  if (piece) {
    pieces.push(piece);
  }
  return pieces;
}

export function createSpansExecutionLauncher({
  escalationMs = DEFAULT_ESCALATION_MS,
  exitGraceMs = DEFAULT_EXIT_GRACE_MS,
  maxChunkBytes,
  launchEffect = (_binding, effect) => ({ child: effect(), ok: true }),
  observeProcess = observeProcessIdentity,
  onExit = () => undefined,
  proveGroup = proveProcessGroupOwnership,
  resolveLaunch,
  resolveProcess = () => null,
  signal = (pid, value) => process.kill(pid, value),
  spawn = Bun.spawn,
}) {
  const children = new Map();
  const background = new Set();
  const timers = new Set();

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise)).catch(() => undefined);
    return promise;
  }

  function groupState(pid) {
    try {
      signal(-pid, 0);
      return 'alive';
    } catch (error) {
      return error.code === 'ESRCH' ? 'absent' : 'unknown';
    }
  }

  async function settledGroup(pid) {
    let state = groupState(pid);
    for (
      let waited = 0;
      state === 'alive' && waited < exitGraceMs;
      waited += GROUP_POLL_MS
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: Poll the owned group sequentially until it is gone or the grace ends.
      await sleep(GROUP_POLL_MS);
      state = groupState(pid);
    }
    return state;
  }

  // Sends one piece and waits for the worker to take it. A refusal other than
  // "closed" or "retry" means output may be missing without the worker having
  // named a gap, so the exit is then not reported as a clean end.
  async function deliver(sink, text, state) {
    for (const piece of splitForBound(text, maxChunkBytes)) {
      while (!state.broken) {
        // biome-ignore lint/performance/noAwaitInLoops: Output must reach the worker in order, one piece at a time.
        const result = await sink.chunk(piece);
        if (result?.ok === true) {
          break;
        }
        if (result?.retryable === true) {
          await sleep(BACKPRESSURE_WAIT_MS);
          continue;
        }
        // Keep draining the pipe so the process is not blocked, but capture no
        // more. A closed attempt was already held with its gap named.
        state.broken = true;
        state.lost = result?.code !== 'ATTEMPT_CLOSED';
      }
    }
  }

  async function pump(stream, sink, state, { watchSession }) {
    const decoder = new TextDecoder();
    const observer = watchSession ? createNativeSessionObserver() : null;
    const observeNative = async (id) => {
      if (!id) {
        return;
      }
      try {
        const result = await sink.native(id);
        state.nativeSent = result?.ok === true;
      } catch {
        // A session observation is not a durable binding until its write succeeds.
        state.nativeSent = false;
      }
    };
    const forward = async (text) => {
      if (!text) {
        return;
      }
      await deliver(sink, text, state);
      await observeNative(observer?.push(text));
    };
    for await (const chunk of stream) {
      await forward(decoder.decode(chunk, { stream: true }));
    }
    await forward(decoder.decode());
    await observeNative(observer?.finish());
  }

  async function watchExit({ binding, child, entry, pumps, sink, state }) {
    try {
      await child.exited;
      const captured = await Promise.allSettled(pumps);
      // A wrapper exiting is not the work ending: report an exit only when the
      // whole owned group is gone. Otherwise the attempt stays running and the
      // deadline or recovery holds it.
      if (
        captured.some((pumpResult) => pumpResult.status === 'rejected') ||
        (await settledGroup(entry.pid)) !== 'absent' ||
        state.lost
      ) {
        return;
      }
      const result = await sink.exit({
        code: child.exitCode ?? null,
        signal: child.signalCode ?? null,
      });
      await onExit({ binding, result });
    } catch {
      // The attempt stays at its last durable status for recovery.
    } finally {
      children.delete(entry.key);
    }
  }

  async function launch({ attemptDigest, binding, sink }) {
    let plan;
    try {
      plan = await resolveLaunch(binding);
    } catch {
      plan = { code: 'WORKER_UNAVAILABLE', ok: false };
    }
    if (plan?.ok !== true) {
      return {
        code: plan?.code ?? 'WORKER_REFUSED',
        launched: false,
        ok: false,
      };
    }
    if (children.has(attemptDigest)) {
      // One supervisor per attempt. A second call cannot know the first's state.
      throw new Error('attempt already supervised');
    }
    let child;
    try {
      const launched = launchEffect(binding, () =>
        spawn(plan.argv, {
          cwd: plan.cwd,
          detached: true,
          env: plan.env,
          stderr: 'pipe',
          stdin: 'pipe',
          stdout: 'pipe',
        })
      );
      if (launched?.ok !== true || !launched.child) {
        return { code: 'WORKER_REFUSED', launched: false, ok: false };
      }
      ({ child } = launched);
    } catch {
      return { code: 'WORKER_UNAVAILABLE', launched: false, ok: false };
    }
    // From here the process exists. Nothing below is a clean failure.
    const entry = { key: attemptDigest, pid: child.pid, startId: null };
    children.set(attemptDigest, entry);
    const state = { broken: false, lost: false, nativeSent: false };
    const pumps = [
      track(pump(child.stdout, sink, state, { watchSession: true })),
      track(pump(child.stderr, sink, state, { watchSession: false })),
    ];
    try {
      child.stdin.write(plan.stdin);
      child.stdin.end();
    } catch {
      // A process that is already gone shows up as its exit.
    }
    track(watchExit({ binding, child, entry, pumps, sink, state }));
    const observed = await observeProcess(child.pid);
    if (
      !(
        observed?.state === 'alive' &&
        observed.processId === child.pid &&
        observed.processStartIdentity
      )
    ) {
      throw new Error('process identity unproven');
    }
    entry.startId = observed.processStartIdentity;
    return {
      ok: true,
      processStart: { id: observed.processStartIdentity, pid: child.pid },
    };
  }

  async function provenProcess(request) {
    const known = children.get(request.attemptDigest);
    const entry = known?.startId
      ? known
      : await resolveProcess(request.binding);
    const startId = entry?.startId ?? entry?.id ?? null;
    if (!(entry?.pid && startId && startId === request.processStartId)) {
      return null;
    }
    const observed = await observeProcess(entry.pid);
    if (
      !(
        observed?.state === 'alive' &&
        observed.processId === entry.pid &&
        observed.processStartIdentity === startId
      )
    ) {
      return null;
    }
    const owned = await proveGroup({
      groupId: entry.pid,
      pid: entry.pid,
      processStart: startId,
    });
    return owned?.state === 'owned' ? { pid: entry.pid, startId } : null;
  }

  // Delivers a termination signal to a proven owned group. Delivery is not an
  // exit: the attempt ends only when the exit itself is observed.
  async function stop(request) {
    const proven = await provenProcess(request);
    if (!proven) {
      return { ok: false };
    }
    try {
      signal(-proven.pid, 'SIGTERM');
    } catch {
      return { ok: false };
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      track(
        (async () => {
          if (await provenProcess(request)) {
            try {
              signal(-proven.pid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
        })()
      );
    }, escalationMs);
    timer.unref?.();
    timers.add(timer);
    return { ok: true };
  }

  return Object.freeze({
    // Resolves when every pump and exit watcher has finished.
    async idle() {
      while (background.size > 0) {
        // biome-ignore lint/performance/noAwaitInLoops: New work can start while waiting, so re-check after each wait.
        await Promise.allSettled([...background]);
      }
    },
    launch,
    shutdown() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
    stop,
  });
}
