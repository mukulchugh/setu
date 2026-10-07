import { isDeepStrictEqual } from 'node:util';
import {
  boundedTail,
  DEFAULT_MAX_BUDGET_USD,
  pumpLines,
  RUN_TIMEOUT_MS,
} from './agent.js';
import { observeProcessIdentity } from './process-observation.js';

const ACTIVE = new Set(['starting', 'running', 'cancelling', 'unknown']);
const RUN_STATES = new Set([
  ...ACTIVE,
  'cancelled',
  'completed',
  'failed',
  'timed out',
]);
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'dontAsk']);
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = DEFAULT_OUTPUT_BYTES;
const MAX_WALL_CLOCK_MS = RUN_TIMEOUT_MS;
const DEFAULT_ESCALATION_MS = 5000;
const BUDGET_ENFORCED = 'enforced by Claude Code --max-budget-usd';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity = isDeepStrictEqual;
const validId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validModel = (value) =>
  value == null ||
  (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value));
const validStoredModel = (value) =>
  value === null ||
  (typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value));
const validTargetPart = (value) =>
  typeof value === 'string' &&
  /^[^/\\\s:\x00-\x20]+$/.test(value) &&
  !['.', '..'].includes(value) &&
  !value.startsWith('-');
const validTarget = (repo, name) =>
  validTargetPart(repo) &&
  typeof name === 'string' &&
  name.split('/').every(validTargetPart);
const validPositive = (value) => Number.isFinite(value) && value > 0;
const validTime = (value) => Number.isFinite(value);
const validOptionalTime = (value) => value === undefined || validTime(value);
const validSession = (value) =>
  value === null ||
  (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value));
const validLimits = (value) =>
  object(value) &&
  validPositive(value.maxBudgetUsd) &&
  value.maxBudgetUsd <= DEFAULT_MAX_BUDGET_USD &&
  Number.isInteger(value.outputBytes) &&
  value.outputBytes >= 1 &&
  value.outputBytes <= MAX_OUTPUT_BYTES &&
  validPositive(value.wallClockMs) &&
  value.wallClockMs <= MAX_WALL_CLOCK_MS;
const validRun = (run, key) => {
  const hasPid = run?.pid !== undefined,
    hasProcessStart = run?.processStart !== undefined;
  return (
    object(run) &&
    validId(key) &&
    run.id === key &&
    object(run.checkoutIdentity) &&
    typeof run.checkoutPath === 'string' &&
    Boolean(run.checkoutPath) &&
    validTime(run.createdAt) &&
    validLimits(run.limits) &&
    validStoredModel(run.model) &&
    validTarget(run.repo, run.name) &&
    run.provider === 'claude' &&
    run.providerBudget === BUDGET_ENFORCED &&
    (run.resumedFrom === null || validId(run.resumedFrom)) &&
    validSession(run.resumeSession) &&
    RUN_STATES.has(run.state) &&
    hasPid === hasProcessStart &&
    (!hasPid ||
      (Number.isInteger(run.pid) &&
        run.pid > 0 &&
        typeof run.processStart === 'string' &&
        Boolean(run.processStart))) &&
    (run.ownedGroup === undefined ||
      (hasPid && typeof run.ownedGroup === 'boolean')) &&
    (run.exitCode === undefined ||
      run.exitCode === null ||
      Number.isInteger(run.exitCode)) &&
    (run.stopReason === undefined ||
      run.stopReason === 'cancelled' ||
      run.stopReason === 'timed out') &&
    [
      run.endedAt,
      run.failedAt,
      run.inputErrorAt,
      run.startedAt,
      run.stopRequestedAt,
      run.streamErrorAt,
      run.unknownAt,
    ].every(validOptionalTime)
  );
};

function providerArgs({ maxBudgetUsd, model, permissionMode, resumeSession }) {
  const args = [
    'claude',
    '--bare',
    '-p',
    '-',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--permission-mode',
    permissionMode,
    '--permission-prompts',
    'none',
  ];
  if (model) {
    args.push('--model', model);
  }
  if (resumeSession) {
    args.push('--resume', resumeSession);
  }
  return args;
}

function terminalState(record, child) {
  if (record.state === 'unknown') {
    return 'unknown';
  }
  if (record.stopReason === 'timed out') {
    return 'timed out';
  }
  if (record.stopReason === 'cancelled') {
    return 'cancelled';
  }
  if (child.signalCode != null || child.exitCode == null) {
    return 'failed';
  }
  return child.exitCode === 0 ? 'completed' : 'failed';
}

// A single-provider, bare-process lifecycle. Containers are deliberately not
// offered here: the existing agent compose mount is hardened by another owner.
export function createHeadlessRun({
  admit,
  clearTimeout: clear = clearTimeout,
  escalationMs = DEFAULT_ESCALATION_MS,
  id = () => crypto.randomUUID(),
  launch = ({ args, cwd, stdin }) => {
    const child = Bun.spawn(args, {
      cwd,
      detached: true,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    });
    return {
      exited: child.exited,
      ownedGroup: true,
      pid: child.pid,
      get signalCode() {
        return child.signalCode;
      },
      stderr: child.stderr,
      stdout: child.stdout,
      writeInput() {
        child.stdin.write(stdin);
        child.stdin.end();
      },
    };
  },
  now = () => Date.now(),
  observeGroup,
  observeProcess = observeProcessIdentity,
  release = async () => {},
  setTimeout: schedule = setTimeout,
  signal = (pid, value) => process.kill(pid, value),
  state,
  withTargetLock = async (_input, work) => work(),
} = {}) {
  if (
    !(
      state &&
      typeof state.read === 'function' &&
      typeof state.update === 'function'
    )
  ) {
    throw new Error('createHeadlessRun requires workspace state');
  }
  if (typeof admit !== 'function') {
    throw new Error('createHeadlessRun requires admit');
  }

  const current = new Map(),
    logs = new Map(),
    sessions = new Map(),
    timers = new Map();
  const journalError = () =>
    Object.assign(new Error('HEADLESS_RUN_JOURNAL_INVALID'), {
      code: 'HEADLESS_RUN_JOURNAL_INVALID',
    });
  const journalFailure = () => ({
    code: 'HEADLESS_RUN_JOURNAL_INVALID',
    error: 'Headless run records are invalid and were not changed.',
    ok: false,
  });
  const runsFrom = (document) => {
    const runs = document?.runs === undefined ? {} : document.runs;
    if (
      !(
        object(document) &&
        object(runs) &&
        Object.entries(runs).every(
          ([key, run]) => validId(key) && validRun(run, key)
        )
      )
    ) {
      throw journalError();
    }
    return runs;
  };
  const readRuns = () => runsFrom(state.read('headlessRuns'));
  const get = (runId) => {
    try {
      return readRuns()[runId] ?? null;
    } catch {
      return null;
    }
  };
  const updateRun = (runId, mutate) =>
    state.update('headlessRuns', (document) => {
      const runs = runsFrom(document);
      const record = runs[runId];
      if (!record) {
        return document;
      }
      const next = mutate(record);
      return next
        ? { ...document, runs: { ...runs, [runId]: next } }
        : document;
    });
  const logFor = (runId, limit) => {
    let log = logs.get(runId);
    if (!log) {
      log = { tail: boundedTail(limit), truncated: false, written: 0 };
      logs.set(runId, log);
    }
    return log;
  };
  const addOutput = (runId, limit, line, details = {}) => {
    const log = logFor(runId, limit),
      text = `${line}\n`;
    log.written += Buffer.byteLength(text);
    log.truncated ||= log.written > limit || details.truncated === true;
    log.tail.push(text);
    try {
      const event = JSON.parse(line);
      if (
        typeof event.session_id === 'string' &&
        /^[a-zA-Z0-9_-]{1,256}$/.test(event.session_id)
      ) {
        sessions.set(runId, event.session_id);
      }
    } catch {
      /* Provider output is diagnostic data, not a record format. */
    }
  };
  const sameProcess = (record, observation) =>
    observation?.state === 'alive' &&
    observation.processId === record.pid &&
    observation.processStartIdentity === record.processStart;
  const groupState = async (record) => {
    if (!record.ownedGroup) {
      return 'alive';
    }
    if (typeof observeGroup === 'function') {
      return observeGroup(record.pid);
    }
    try {
      signal(-record.pid, 0);
      return 'alive';
    } catch (error) {
      return error?.code === 'ESRCH' ? 'absent' : 'unknown';
    }
  };
  const clearTimers = (runId) => {
    const entries = timers.get(runId);
    if (!entries) {
      return;
    }
    clear(entries.deadline);
    clear(entries.escalation);
    timers.delete(runId);
  };
  const markUnknown = async (runId) => {
    try {
      await updateRun(runId, (stored) =>
        ACTIVE.has(stored.state)
          ? { ...stored, state: 'unknown', unknownAt: now() }
          : stored
      );
    } catch {
      /* Durable intent remains the exclusion. */
    }
  };
  const ownedNow = async (record) => {
    if (!(record.pid && record.processStart)) {
      return false;
    }
    try {
      return (
        sameProcess(record, await observeProcess(record.pid)) &&
        (await groupState(record)) === 'alive'
      );
    } catch {
      return false;
    }
  };

  async function signalOwned(record, reason, value) {
    if (!(await ownedNow(record))) {
      await markUnknown(record.id);
      return {
        code: 'RUN_PROCESS_UNKNOWN',
        error: 'Run process cannot be confirmed.',
        ok: false,
      };
    }
    if (value === 'SIGTERM') {
      try {
        await updateRun(record.id, (stored) =>
          ACTIVE.has(stored.state)
            ? {
                ...stored,
                state: 'cancelling',
                stopReason: reason,
                stopRequestedAt: now(),
              }
            : stored
        );
      } catch {
        await markUnknown(record.id);
        return {
          code: 'STATE_WRITE_FAILED',
          error: 'Run cancellation could not be saved.',
          ok: false,
        };
      }
    }
    const latest = get(record.id) ?? record;
    if (!(await ownedNow(latest))) {
      await markUnknown(record.id);
      return {
        code: 'RUN_PROCESS_UNKNOWN',
        error: 'Run process cannot be confirmed.',
        ok: false,
      };
    }
    try {
      signal(latest.ownedGroup ? -latest.pid : latest.pid, value);
    } catch {
      await markUnknown(record.id);
      return {
        code: 'RUN_PROCESS_UNKNOWN',
        error: 'Run process could not be signalled safely.',
        ok: false,
      };
    }
    return { ok: true, state: 'cancelling' };
  }

  function scheduleEscalation(record) {
    const entries = timers.get(record.id) ?? {};
    entries.escalation = schedule(() => {
      void (async () => {
        const stored = get(record.id);
        if (stored && ACTIVE.has(stored.state)) {
          await signalOwned(
            stored,
            stored.stopReason ?? 'cancelled',
            'SIGKILL'
          );
        }
      })().catch(() => {});
    }, escalationMs);
    timers.set(record.id, entries);
  }

  async function stopOwned(record, reason) {
    const result = await signalOwned(record, reason, 'SIGTERM');
    if (result.ok) {
      scheduleEscalation(record);
    }
    return result;
  }

  function observeOutput(runId, process, outputBytes) {
    const pumps = [];
    if (process.stdout) {
      pumps.push(
        pumpLines(
          process.stdout,
          (line, details) => addOutput(runId, outputBytes, line, details),
          { maxBytes: outputBytes }
        )
      );
    }
    if (process.stderr) {
      pumps.push(
        pumpLines(
          process.stderr,
          (line, details) => addOutput(runId, outputBytes, line, details),
          { maxBytes: outputBytes }
        )
      );
    }
    return pumps;
  }

  function monitor(record, process, admission, outputBytes, wallClockMs) {
    const entries = timers.get(record.id) ?? {};
    entries.deadline = schedule(() => {
      void (async () => {
        const stored = get(record.id);
        record.deadlineExpired = true;
        if (stored?.processStart && ACTIVE.has(stored.state)) {
          await stopOwned(stored, 'timed out');
        }
      })().catch(() => {});
    }, wallClockMs);
    timers.set(record.id, entries);
    const pumps = observeOutput(record.id, process, outputBytes);
    for (const pump of pumps) {
      void Promise.resolve(pump).catch(async () => {
        try {
          await updateRun(record.id, (stored) =>
            ACTIVE.has(stored.state)
              ? { ...stored, streamErrorAt: now() }
              : stored
          );
        } catch {
          /* Exit watcher retains ownership. */
        }
      });
    }
    const completion = Promise.resolve(process.exited)
      .then(async (exitCode) => {
        await record.startup;
        await Promise.allSettled(pumps);
        clearTimers(record.id);
        const stored = get(record.id);
        if (!stored) {
          return;
        }
        let descendants = 'unknown';
        try {
          descendants = record.ownedGroup ? await groupState(record) : 'absent';
        } catch {
          descendants = 'unknown';
        }
        if (!record.identityProven || descendants !== 'absent') {
          await markUnknown(record.id);
          return;
        }
        try {
          await updateRun(record.id, (run) =>
            ACTIVE.has(run.state)
              ? {
                  ...run,
                  endedAt: now(),
                  exitCode: exitCode ?? null,
                  resumeSession: sessions.get(record.id) ?? run.resumeSession,
                  state: terminalState(run, {
                    exitCode,
                    signalCode: process.signalCode,
                  }),
                }
              : run
          );
          await release(admission.lease);
        } catch {
          await markUnknown(record.id);
        }
      })
      .catch(async () => {
        clearTimers(record.id);
        await markUnknown(record.id);
      });
    current.set(record.id, completion);
    void completion.finally(() => current.delete(record.id));
  }

  async function start(input) {
    const runId = input.id ?? id(),
      wallClockMs = input.wallClockMs ?? RUN_TIMEOUT_MS,
      outputBytes = input.outputBytes ?? DEFAULT_OUTPUT_BYTES,
      maxBudgetUsd = input.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      permissionMode = input.permissionMode ?? 'dontAsk';
    if (!(validId(runId) && validTarget(input.repo, input.name))) {
      return {
        code: 'HEADLESS_RUN_INVALID',
        error: 'Run and worktree identifiers are invalid.',
        ok: false,
      };
    }
    if (
      !(
        typeof input.checkoutPath === 'string' &&
        input.checkoutPath &&
        object(input.checkoutIdentity) &&
        Object.keys(input.checkoutIdentity).length > 0
      )
    ) {
      return {
        code: 'CHECKOUT_IDENTITY_REQUIRED',
        error: 'An exact checkout identity is required.',
        ok: false,
      };
    }
    if (input.provider !== undefined && input.provider !== 'claude') {
      return {
        code: 'PROVIDER_UNSUPPORTED',
        error: 'Only Claude Code is available for bounded headless runs.',
        ok: false,
      };
    }
    if (!(typeof input.prompt === 'string' && input.prompt)) {
      return {
        code: 'PROMPT_REQUIRED',
        error: 'A run prompt is required.',
        ok: false,
      };
    }
    if (!validModel(input.model)) {
      return { code: 'MODEL_INVALID', error: 'Model is invalid.', ok: false };
    }
    if (!PERMISSION_MODES.has(permissionMode)) {
      return {
        code: 'PERMISSION_MODE_INVALID',
        error: 'Permission mode is not permitted for headless runs.',
        ok: false,
      };
    }
    if (
      !validPositive(wallClockMs) ||
      wallClockMs > MAX_WALL_CLOCK_MS ||
      !Number.isInteger(outputBytes) ||
      outputBytes < 1 ||
      outputBytes > MAX_OUTPUT_BYTES ||
      !validPositive(maxBudgetUsd) ||
      maxBudgetUsd > DEFAULT_MAX_BUDGET_USD
    ) {
      return {
        code: 'HEADLESS_RUN_LIMIT_INVALID',
        error: 'Run limits are invalid or exceed the allowed maximum.',
        ok: false,
      };
    }
    try {
      readRuns();
    } catch {
      return journalFailure();
    }

    const initial = {
      checkoutIdentity: input.checkoutIdentity,
      checkoutPath: input.checkoutPath,
      createdAt: now(),
      id: runId,
      limits: { maxBudgetUsd, outputBytes, wallClockMs },
      model: input.model ?? null,
      name: input.name,
      provider: 'claude',
      providerBudget: BUDGET_ENFORCED,
      repo: input.repo,
      resumedFrom: input.resumedFrom ?? null,
      resumeSession: input.resumeSession ?? null,
      state: 'starting',
    };
    if (!validRun(initial, runId)) {
      return {
        code: 'HEADLESS_RUN_INVALID',
        error: 'Run metadata is invalid.',
        ok: false,
      };
    }
    let claimed = false;
    try {
      await state.update('headlessRuns', (document) => {
        const runs = runsFrom(document);
        if (
          runs[runId] ||
          Object.values(runs).some(
            (run) =>
              run.repo === input.repo &&
              run.name === input.name &&
              ACTIVE.has(run.state)
          )
        ) {
          return document;
        }
        claimed = true;
        return { ...document, runs: { ...runs, [runId]: initial } };
      });
    } catch (error) {
      return error?.code === 'HEADLESS_RUN_JOURNAL_INVALID'
        ? journalFailure()
        : {
            code: 'STATE_WRITE_FAILED',
            error: 'Run intent could not be saved.',
            ok: false,
          };
    }
    if (!claimed) {
      return {
        code: 'HEADLESS_RUN_ACTIVE',
        error:
          'This worktree already has an active or unresolved headless run.',
        ok: false,
      };
    }

    const runOutcome = (state, outcome) => ({ ...outcome, id: runId, state });

    let admission;
    try {
      admission = await admit({
        kind: 'headless-run',
        operationId: runId,
        target: { name: input.name, repo: input.repo },
      });
    } catch {
      await markUnknown(runId);
      return runOutcome('unknown', {
        code: 'ADMISSION_FAILED',
        error: 'Headless run admission could not be confirmed.',
        ok: false,
      });
    }
    if (!admission?.ok) {
      try {
        await updateRun(runId, (record) => ({
          ...record,
          failedAt: now(),
          state: 'failed',
        }));
      } catch {
        await markUnknown(runId);
        return runOutcome('unknown', {
          code: admission?.code ?? 'ADMISSION_REFUSED',
          error: 'Headless run admission was refused.',
          ok: false,
          recovery: { state: 'unavailable' },
        });
      }
      return runOutcome('failed', {
        code: admission?.code ?? 'ADMISSION_REFUSED',
        error: 'Headless run admission was refused.',
        ok: false,
        position: admission?.position,
        queued: admission?.queued,
        reason: admission?.reason,
      });
    }

    const unknownResult = () =>
      runOutcome('unknown', {
        code: 'RUN_PROCESS_UNKNOWN',
        error: 'A launched process could not be confirmed.',
        ok: false,
      });
    const monitorableProcess = (candidate) =>
      Number.isInteger(candidate?.pid) &&
      candidate.pid > 0 &&
      typeof candidate.exited?.then === 'function';
    // A launcher throw is ambiguous unless it explicitly says no child could
    // have been spawned. Adapters use launchAttempt: 'prelaunch' for that
    // narrow case; every other throw retains the admission lease as unknown.
    const explicitPrelaunch = (error) =>
      error?.launchAttempt === 'prelaunch' ||
      error?.possiblyLaunched === false ||
      error?.code === 'RUN_SPAWN_REFUSED';
    const malformedOwnership = (candidate) =>
      Object.hasOwn(candidate, 'ownedGroup') &&
      typeof candidate.ownedGroup !== 'boolean';
    const failBeforeLaunch = async (error) => {
      const recovery = {};
      try {
        await updateRun(runId, (record) => ({
          ...record,
          failedAt: now(),
          state: 'failed',
        }));
      } catch {
        recovery.state = 'unavailable';
      }
      try {
        const released = await release(admission.lease);
        if (released?.ok === false) {
          recovery.release = released.code ?? 'ADMISSION_RELEASE_UNAVAILABLE';
        }
      } catch {
        recovery.release = 'ADMISSION_RELEASE_UNAVAILABLE';
      }
      return runOutcome('failed', {
        code:
          error?.code === 'CHECKOUT_REPLACED'
            ? 'CHECKOUT_REPLACED'
            : 'RUN_LAUNCH_FAILED',
        error:
          error?.code === 'CHECKOUT_REPLACED'
            ? 'The worktree checkout changed before launch.'
            : 'Claude Code could not be launched.',
        ok: false,
        ...(Object.keys(recovery).length ? { recovery } : {}),
        ...(recovery.release ? { leaseRetained: true } : {}),
      });
    };
    const trackLaunched = async (process, uncertain) => {
      let publishStartup;
      const runtime = {
        ...initial,
        identityProven: false,
        ownedGroup: process.ownedGroup === true,
        pid: process.pid,
        startup: new Promise((resolve) => {
          publishStartup = resolve;
        }),
        state: 'unknown',
      };
      monitor(runtime, process, admission, outputBytes, wallClockMs);
      let inputFailed = false;
      if (!uncertain) {
        try {
          process.writeInput?.();
        } catch {
          inputFailed = true;
        }
      }
      let observation;
      try {
        observation = await observeProcess(process.pid);
      } catch {
        observation = null;
      }
      if (
        observation?.state !== 'alive' ||
        observation.processId !== process.pid ||
        !observation.processStartIdentity
      ) {
        await markUnknown(runId);
        publishStartup();
        return unknownResult();
      }
      runtime.identityProven = true;
      runtime.processStart = observation.processStartIdentity;
      runtime.startedAt = now();
      runtime.state = uncertain ? 'unknown' : 'running';
      try {
        await updateRun(runId, (record) => ({
          ...record,
          inputErrorAt: inputFailed ? now() : undefined,
          ownedGroup: runtime.ownedGroup,
          pid: runtime.pid,
          processStart: runtime.processStart,
          startedAt: runtime.startedAt,
          state: uncertain || inputFailed ? 'unknown' : 'running',
        }));
      } catch {
        await markUnknown(runId);
        publishStartup();
        return uncertain
          ? unknownResult()
          : runOutcome('unknown', {
              code: 'STATE_WRITE_FAILED',
              error:
                'Run launched but its durable process identity could not be saved.',
              ok: false,
            });
      }
      publishStartup();
      if (runtime.deadlineExpired) {
        void stopOwned(get(runId) ?? runtime, 'timed out').catch(() => {});
      }
      if (uncertain) {
        return unknownResult();
      }
      if (inputFailed) {
        return runOutcome('unknown', {
          code: 'RUN_INPUT_FAILED',
          error: 'Run launched but its input could not be delivered.',
          ok: false,
        });
      }
      return { budget: BUDGET_ENFORCED, id: runId, ok: true, state: 'running' };
    };

    let process,
      launchAttempt = 'not-attempted';
    try {
      await withTargetLock(initial, async (fresh = {}) => {
        if (
          (fresh.checkoutPath !== undefined &&
            fresh.checkoutPath !== input.checkoutPath) ||
          (fresh.checkoutIdentity !== undefined &&
            !sameIdentity(fresh.checkoutIdentity, input.checkoutIdentity))
        ) {
          throw Object.assign(new Error('checkout replaced'), {
            code: 'CHECKOUT_REPLACED',
          });
        }
        launchAttempt = 'uncertain';
        try {
          process = await launch({
            args: providerArgs({
              maxBudgetUsd,
              model: input.model,
              permissionMode,
              resumeSession: input.resumeSession,
            }),
            cwd: input.checkoutPath,
            stdin: input.prompt,
          });
          launchAttempt = 'returned';
          return process;
        } catch (error) {
          process = error?.child ?? error?.process ?? process;
          if (explicitPrelaunch(error)) {
            launchAttempt = 'prelaunch';
          }
          throw error;
        }
      });
    } catch (error) {
      if (monitorableProcess(process)) {
        return trackLaunched(process, true);
      }
      if (launchAttempt === 'uncertain' || launchAttempt === 'returned') {
        await markUnknown(runId);
        return unknownResult();
      }
      return failBeforeLaunch(error);
    }
    if (!monitorableProcess(process)) {
      await markUnknown(runId);
      return unknownResult();
    }
    return trackLaunched(process, malformedOwnership(process));
  }

  async function cancel({ id: runId, checkoutIdentity }) {
    try {
      readRuns();
    } catch {
      return journalFailure();
    }
    const record = get(runId);
    if (!(record && ACTIVE.has(record.state))) {
      return {
        code: 'HEADLESS_RUN_NOT_ACTIVE',
        error: 'Run is not active.',
        ok: false,
      };
    }
    if (!sameIdentity(record.checkoutIdentity, checkoutIdentity)) {
      return {
        code: 'CHECKOUT_REPLACED',
        error: 'The worktree checkout has changed.',
        ok: false,
      };
    }
    return stopOwned(record, 'cancelled');
  }

  async function resume({ runId, ...input }) {
    try {
      readRuns();
    } catch {
      return journalFailure();
    }
    const previous = get(runId);
    if (!previous || previous.provider !== 'claude') {
      return {
        code: 'RESUME_UNSUPPORTED',
        error: 'This provider has no documented resume mechanism for this run.',
        ok: false,
      };
    }
    if (!previous.resumeSession) {
      return {
        code: 'RESUME_UNAVAILABLE',
        error:
          'Claude Code did not return a session reference that can be resumed.',
        ok: false,
      };
    }
    if (!sameIdentity(previous.checkoutIdentity, input.checkoutIdentity)) {
      return {
        code: 'CHECKOUT_REPLACED',
        error: 'The worktree checkout has changed.',
        ok: false,
      };
    }
    return start({
      ...input,
      provider: 'claude',
      resumedFrom: runId,
      resumeSession: previous.resumeSession,
    });
  }

  async function reconcile() {
    let runs;
    try {
      runs = readRuns();
    } catch {
      return journalFailure();
    }
    const changed = [];
    for (const record of Object.values(runs)) {
      if (!ACTIVE.has(record.state)) {
        continue;
      }
      if (!(await ownedNow(record))) {
        await markUnknown(record.id);
        changed.push(record.id);
      }
    }
    return { ok: true, unknown: changed };
  }

  return {
    cancel,
    get,
    getLog: (runId) => {
      const log = logs.get(runId);
      return log
        ? { text: log.tail.toString(), truncated: log.truncated }
        : null;
    },
    list: () => {
      try {
        return { ok: true, runs: Object.values(readRuns()) };
      } catch {
        return journalFailure();
      }
    },
    reconcile,
    resume,
    start,
    wait: (runId) => current.get(runId) ?? Promise.resolve(),
  };
}

export {
  BUDGET_ENFORCED,
  DEFAULT_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_WALL_CLOCK_MS,
  validRun as validHeadlessRunRecord,
};
