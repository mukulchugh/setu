// The lifecycle owner for the Links peer transport: one long-running engine process per data directory.
// The engine enforces the single instance (it holds an exclusive lock) and keeps every message; this module
// only starts it, asks whether it runs, and stops it. Asking never starts anything. It writes no file and
// opens no database.
//
// Service packaging (a login item or launchd job) wraps `start` and `stop`; it is not done here.
import { execFile } from 'node:child_process';
import { createLinksClient } from './links-client.js';
import { observeProcessIdentity } from './process-observation.js';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
// A daemon records its start moment only after it holds the lock and is listening, which is moments
// after the process itself began. A process that began long before that is not the daemon it names.
const MAX_STARTUP_MS = 5 * 60 * 1000;
// `ps` reports a start time to the whole second and may round it up.
const START_TIME_SLACK_MS = 1000;
const ENGINE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const WHITESPACE = /\s/;

const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});

// The same `ps` start-time evidence agent sessions use, asked in UTC so it can be compared with a clock reading
// whatever time zone this process or its test runner believes in.
const readStartUtc = (processId) =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-p', String(processId), '-o', 'lstart='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: 4096,
        timeout: 3000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

const observeUtc = (processId) =>
  observeProcessIdentity(processId, { run: readStartUtc });

const readCommand = (processId) =>
  new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-p', String(processId), '-o', 'command='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 64 * 1024,
        timeout: 3000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))
    );
  });

// Exactly `<engine> serve --data-dir <dir>`, optionally followed by one `--listen <address>`. A sibling directory,
// another engine, a wrapper or extra arguments are all something else. Shared with the test fixture's reaper, so
// a test never stops anything that production would not recognise either.
export function isServeCommand(command, enginePath, dataDir) {
  const expected = `${enginePath} serve --data-dir ${dataDir}`;
  if (command === expected) {
    return true;
  }
  const listen = `${expected} --listen `;
  if (!command.startsWith(listen)) {
    return false;
  }
  const address = command.slice(listen.length);
  return address.length > 0 && !WHITESPACE.test(address);
}

export function createLinksTransport({
  enginePath,
  dataDir,
  listen,
  client = createLinksClient({ dataDir, enginePath }),
  spawn = Bun.spawn,
  observe = observeUtc,
  commandOf = readCommand,
  signal = (pid, value) => process.kill(pid, value),
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  if (!(typeof enginePath === 'string' && typeof dataDir === 'string')) {
    throw new TypeError(
      'The Links transport needs an engine path and data directory'
    );
  }
  let starting = null;

  // Passive: the engine reads the lock and its status file. A stale file with no lock holder reads as stopped.
  const status = () => client.call('transport_status', {});

  const listening = (result) =>
    result.running === true &&
    Array.isArray(result.listen) &&
    result.listen.length > 0;

  // Ready means a daemon that is provably this directory's and provably current. A status file left by a daemon that
  // died describes a process that is gone (or now something else), and the new daemon may not have rewritten it yet;
  // the same proof that lets `stop` signal a process decides whether it is the one that is starting. An unknown
  // answer is simply not ready yet, and a start that never gets proof times out honestly.
  const isReady = async (result) => listening(result) && (await owned(result));

  async function waitFor(done, timeoutMs, gaveUp = () => false) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Polling is sequential by nature.
      const current = await status();
      if (current.ok && (await done(current.result))) {
        return current.result;
      }
      if (Date.now() >= deadline || gaveUp()) {
        return null;
      }
      await Bun.sleep(POLL_MS);
    }
  }

  // The engine ended without becoming ready: its own reply says why (a key it will not use, an address it cannot
  // bind), and that reason is passed on instead of a bare timeout.
  async function refusal(child) {
    let reply = null;
    try {
      reply = JSON.parse(await new Response(child.stdout).text());
    } catch {
      // No usable reply.
    }
    const engineCode = reply?.error?.code;
    const message = reply?.error?.message;
    if (
      typeof engineCode === 'string' &&
      ENGINE_CODE.test(engineCode) &&
      typeof message === 'string'
    ) {
      return failure(
        'LINKS_TRANSPORT_START_FAILED',
        `The Links transport did not start: ${message.slice(0, 500)}`,
        { details: { engineCode } }
      );
    }
    return failure(
      'LINKS_TRANSPORT_START_FAILED',
      'The Links transport exited before it was ready.'
    );
  }

  async function launch() {
    const current = await status();
    if (!current.ok) {
      return failure(
        'LINKS_TRANSPORT_START_FAILED',
        'The Links engine could not be reached to start the transport.'
      );
    }
    if (await isReady(current.result)) {
      return {
        ok: true,
        result: { pid: current.result.pid, state: 'already-running' },
      };
    }
    let child;
    try {
      child = spawn(
        [
          enginePath,
          'serve',
          '--data-dir',
          dataDir,
          ...(listen ? ['--listen', listen] : []),
        ],
        { detached: true, stderr: 'ignore', stdin: 'ignore', stdout: 'pipe' }
      );
      child.unref?.();
    } catch {
      return failure(
        'LINKS_TRANSPORT_START_FAILED',
        'The Links engine could not be started.'
      );
    }
    const ready = await waitFor(
      isReady,
      readyTimeoutMs,
      () => child.exitCode !== null
    );
    if (!ready) {
      return child.exitCode === null
        ? failure(
            'LINKS_TRANSPORT_START_FAILED',
            'The Links transport did not become ready.'
          )
        : await refusal(child);
    }
    // The engine, not this module, decides which of two racing starts wins.
    return {
      ok: true,
      result: {
        pid: ready.pid,
        state: ready.pid === child.pid ? 'started' : 'already-running',
      },
    };
  }

  // Starts coalesce inside one process; across processes the engine's lock does the same job.
  function start() {
    starting ??= launch().finally(() => {
      starting = null;
    });
    return starting;
  }

  // The process may be signalled only if everything agrees it is this directory's daemon: the engine says the
  // lock is held and names the process, the live process began no later than the daemon says it started,
  // and its command line is this engine serving this directory. A recycled process ID fails the second test.
  async function owned(result) {
    if (
      !(
        Number.isSafeInteger(result.pid) &&
        Number.isSafeInteger(result.started_at)
      )
    ) {
      return false;
    }
    // A collaborator that throws, rejects or answers with something other than a live process with a readable start
    // leaves ownership unknown, which is not owned: start waits for proof it never gets, stop signals nothing.
    let observation;
    try {
      observation = await observe(result.pid);
    } catch {
      return false;
    }
    if (
      observation?.state !== 'alive' ||
      typeof observation.processStartIdentity !== 'string'
    ) {
      return false;
    }
    const began = Date.parse(`${observation.processStartIdentity} UTC`);
    if (
      !(
        Number.isFinite(began) &&
        began <= result.started_at + START_TIME_SLACK_MS &&
        result.started_at - began <= MAX_STARTUP_MS
      )
    ) {
      return false;
    }
    let command;
    try {
      command = await commandOf(result.pid);
    } catch {
      return false;
    }
    return (
      typeof command === 'string' &&
      isServeCommand(command, enginePath, dataDir)
    );
  }

  async function stop() {
    const current = await status();
    if (!current.ok) {
      return current;
    }
    if (!current.result.running) {
      return { ok: true, result: { state: 'not-running' } };
    }
    if (!(await owned(current.result))) {
      return failure(
        'LINKS_TRANSPORT_NOT_OWNED',
        'The running process is not recognised as this directory’s Links transport, so it was not signalled.'
      );
    }
    try {
      signal(current.result.pid, 'SIGTERM');
    } catch {
      return failure(
        'LINKS_TRANSPORT_STOP_FAILED',
        'The Links transport could not be signalled.'
      );
    }
    const stopped = await waitFor((result) => !result.running, stopTimeoutMs);
    return stopped
      ? { ok: true, result: { state: 'stopped' } }
      : failure(
          'LINKS_TRANSPORT_STOP_TIMEOUT',
          'The Links transport was asked to stop and has not yet.'
        );
  }

  return Object.freeze({ start, status, stop });
}
