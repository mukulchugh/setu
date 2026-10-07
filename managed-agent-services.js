import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentSessionLaunch,
  parseSessionRegistration,
} from './agent-session-launcher.js';
import { createAgentSessions } from './agent-sessions.js';
import { createHeadlessRun } from './headless-run.js';
import {
  buildGhosttyScriptLaunch,
  createGhosttyTerminalAdapter,
  parseGhosttyLaunchResponse,
} from './native-terminal.js';
import { observeProcessIdentity } from './process-observation.js';
import { findProcessChildren } from './process-tree.js';
import { createReviewHandoff } from './review-handoff.js';
import {
  createTerminalAttention,
  createTrustedHookIngress,
} from './terminal-attention.js';

const tokenPattern = /^[A-Za-z0-9_-]{16,128}$/;
const safeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const same = (a, b) => {
  if (a === b) {
    return true;
  }
  if (
    !(a && b && typeof a === 'object' && typeof b === 'object') ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false;
  }
  if (Array.isArray(a)) {
    return (
      a.length === b.length && a.every((value, index) => same(value, b[index]))
    );
  }
  const aKeys = Object.keys(a).sort(),
    bKeys = Object.keys(b).sort();
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && same(a[key], b[key]))
  );
};
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const failure = (code, error) => ({ code, error, ok: false });

function normalTool(tool) {
  return tool === 'claude' || tool === 'claude-code'
    ? 'claude-code'
    : tool === 'codex'
      ? 'codex'
      : null;
}

function safeSession(session) {
  if (!session) {
    return null;
  }
  const { managedLease, ...visible } = session;
  return visible;
}

function safeRun(run) {
  if (!run || typeof run !== 'object') {
    return null;
  }
  const fields = [
    'checkoutIdentity',
    'createdAt',
    'endedAt',
    'exitCode',
    'id',
    'limits',
    'model',
    'name',
    'provider',
    'providerBudget',
    'repo',
    'resumedFrom',
    'startedAt',
    'state',
    'stopReason',
    'unknownAt',
  ];
  return Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(run, key))
      .map((key) => [key, run[key]])
  );
}

function claudeSettings({ hookPath }) {
  const command = (event) => `${shellQuote(hookPath)} ${shellQuote(event)}`;
  const hooks = (event, matcher) => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ command: command(event), type: 'command' }],
    },
  ];
  return JSON.stringify({
    hooks: {
      Notification: hooks('Notification', 'agent_needs_input'),
      PermissionRequest: hooks('PermissionRequest'),
      SessionStart: hooks('SessionStart'),
      Stop: hooks('Stop'),
    },
  });
}

function claudeHookProgram(ingressUrl) {
  return `#!/usr/bin/env bun
const event = process.argv[2];
const token = process.env.SETU_SESSION_TOKEN;
if (!/^[A-Za-z0-9_-]{16,128}$/.test(token ?? '')) process.exit(0);
let input = '';
let bytes = 0;
for await (const part of process.stdin) {
  bytes += Buffer.byteLength(part);
  if (bytes > 131072) process.exit(0);
  input += part;
}
let payload;
try { payload = JSON.parse(input); } catch { process.exit(0); }
if (payload?.hook_event_name !== event) process.exit(0);
try {
  await fetch(${JSON.stringify(ingressUrl)}, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({provider:'claude-code', launchToken:token, payload}),
    signal: AbortSignal.timeout(1000),
  });
} catch {}
`;
}

async function defaultPrivateFiles({ id, runtimeDir = tmpdir() }) {
  await mkdir(runtimeDir, { mode: 0o700, recursive: true });
  const dir = await mkdtemp(join(runtimeDir, `setu-agent-${id}-`));
  await chmod(dir, 0o700);
  const files = {
    dir,
    hookPath: join(dir, 'claude-hook.js'),
    launcherPath: join(dir, 'launch.zsh'),
    registrationPath: join(dir, 'registration.json'),
    settingsPath: join(dir, 'claude-settings.json'),
  };
  return {
    ...files,
    async read(path) {
      return readFile(path, 'utf8');
    },
    async remove() {
      await rm(dir, { force: true, recursive: true });
    },
    async write(path, data, mode) {
      await writeFile(path, data, { mode });
      await chmod(path, mode);
    },
  };
}

async function defaultAppleScript(command) {
  try {
    const child = Bun.spawn(command.args, {
      stderr: 'pipe',
      stdout: 'pipe',
      timeout: 5000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code === 0) {
      return { availability: 'available', stdout: stdout.trim() };
    }
    return {
      availability: /not authorized|not permitted/i.test(stderr)
        ? 'disabled'
        : 'unknown',
      stdout: stdout.trim(),
    };
  } catch {
    return { availability: 'unavailable', stdout: '' };
  }
}

async function defaultOpen(command) {
  try {
    const child = Bun.spawn(command.args, {
      stderr: 'ignore',
      stdout: 'ignore',
      timeout: 5000,
    });
    return (await child.exited) === 0 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function resultTarget(record, target) {
  return (
    record &&
    record.repo === target.repo &&
    record.name === target.name &&
    same(record.checkoutIdentity, target.checkoutIdentity)
  );
}

// Owns composition only: it never creates HTTP routes, scans transcripts, or
// falls back from an exact action to a new terminal.
export function createManagedAgentServices({
  admission,
  operationEvents,
  resolveTarget,
  state,
  runtimeDir,
  ingressUrl = 'http://127.0.0.1:2999/api/attention/hook',
  privateFiles,
  launchNative,
  launchOpen,
  runAppleScript = defaultAppleScript,
  observeProcess = observeProcessIdentity,
  findChildren = ({ pid, processStart }) =>
    findProcessChildren(pid, { observeProcess, processStart }),
  signal = (pid, value) => process.kill(pid, value),
  now = () => Date.now(),
  id = () => crypto.randomUUID(),
  token = () =>
    crypto.randomUUID().replaceAll('-', '') +
    crypto.randomUUID().replaceAll('-', '').slice(0, 16),
  registrationAttempts = 20,
  registrationDelayMs = 50,
  sleep = (ms) => Bun.sleep(ms),
  source: serviceSource = 'portal',
  monitorMs = 5000,
  setInterval: scheduleInterval = setInterval,
  clearInterval: clearMonitor = clearInterval,
  headless: headlessOptions = {},
} = {}) {
  if (
    !(
      state?.read &&
      state?.update &&
      admission?.admit &&
      admission?.release &&
      operationEvents?.record &&
      typeof resolveTarget === 'function'
    )
  ) {
    throw new TypeError(
      'managed agent services need state, admission, events and target resolver'
    );
  }
  const sessions = createAgentSessions({
    findChildren,
    now,
    observeProcess,
    signal,
    state,
  });
  const ingress = createTrustedHookIngress({ sessions });
  const verifySession = async ({ sessionId, checkoutIdentity }) => {
    const reconciled = await sessions.reconcile();
    const session = sessions.get(sessionId);
    return reconciled.ok &&
      session?.ownership === 'owned' &&
      session.state === 'running' &&
      same(session.checkoutIdentity, checkoutIdentity)
      ? { ok: true, session }
      : failure(
          'SESSION_OWNERSHIP_UNKNOWN',
          'The managed session could not be verified'
        );
  };
  const terminal = createGhosttyTerminalAdapter({
    runAppleScript,
    verifySession,
  });
  const attention = createTerminalAttention({
    launcher: terminal,
    now,
    resolveHookSession: ingress.resolveHookSession,
    sessions,
    state,
  });
  const handoff = createReviewHandoff({
    deliver: terminal.deliver,
    sessions,
    verifySession,
  });
  const headless = createHeadlessRun({
    admit: admission.admit,
    observeProcess,
    release: admission.release,
    state,
    ...headlessOptions,
    withTargetLock: async (record, work) =>
      state.withTargets(
        [{ name: record.name, repo: record.repo }],
        async () => {
          const fresh = await target({ name: record.name, repo: record.repo });
          if (!fresh) {
            throw Object.assign(new Error('target changed'), {
              code: 'TARGET_CHANGED',
            });
          }
          return work({
            checkoutIdentity: fresh.checkoutIdentity,
            checkoutPath: fresh.wtDir,
          });
        }
      ),
  });
  const runtimes = new Map();
  // Avoid a second local release when the first release succeeded but the
  // subsequent durable forget failed. A recreated service may safely attempt
  // recovery again; this instance never disguises that cleanup error as a
  // fresh admission failure.
  const locallyReleasedLeases = new Set();
  let monitor;
  const validSource = (value) =>
    ['portal', 'ui', 'cli', 'mcp', 'raycast'].includes(value);
  const validPendingOutcome = (value) =>
    value &&
    ['completed', 'unknown'].includes(value.state) &&
    (value.code === undefined || typeof value.code === 'string') &&
    validSource(value.source);
  const validLease = (lease) =>
    lease &&
    lease.kind === 'session' &&
    safeId(lease.operationId) &&
    Number.isSafeInteger(lease.acquiredAt) &&
    lease.owner &&
    Number.isSafeInteger(lease.owner.pid) &&
    typeof lease.owner.processStart === 'string' &&
    lease.target &&
    typeof lease.target.repo === 'string' &&
    typeof lease.target.name === 'string';
  const leaseEntry = (value) =>
    validLease(value)
      ? { lease: value, source: serviceSource }
      : value &&
          validLease(value.lease) &&
          validSource(value.source) &&
          (value.pendingOutcome === undefined ||
            validPendingOutcome(value.pendingOutcome))
        ? value
        : null;
  const leaseEntries = (document) => {
    if (document?.managedLeases === undefined) {
      return {};
    }
    if (
      !(
        document?.managedLeases &&
        typeof document.managedLeases === 'object' &&
        !Array.isArray(document.managedLeases)
      )
    ) {
      throw Object.assign(
        new Error('managed session lease journal is invalid'),
        { code: 'SESSION_LEASE_JOURNAL_INVALID' }
      );
    }
    if (!Object.values(document.managedLeases).every(leaseEntry)) {
      throw Object.assign(
        new Error('managed session lease journal is invalid'),
        { code: 'SESSION_LEASE_JOURNAL_INVALID' }
      );
    }
    return document.managedLeases;
  };
  // Keep non-secret lease associations in agentSessions, whose document already
  // owns session lifecycle state. AgentSessions preserves unrelated fields.
  const leaseDocument = () => leaseEntries(state.read('agentSessions'));
  const rememberLease = async (sessionId, lease, source) =>
    state.update('agentSessions', (document) => ({
      ...document,
      managedLeases: {
        ...leaseEntries(document),
        [sessionId]: { lease, source: source ?? serviceSource },
      },
    }));
  const forgetLease = async (sessionId) =>
    state.update('agentSessions', (document) => {
      const managedLeases = { ...leaseEntries(document) };
      delete managedLeases[sessionId];
      return { ...document, managedLeases };
    });
  const setPendingOutcome = async (sessionId, pendingOutcome) =>
    state.update('agentSessions', (document) => {
      const managedLeases = { ...leaseEntries(document) };
      const entry = leaseEntry(managedLeases[sessionId]);
      if (!entry) {
        throw Object.assign(new Error('managed session lease is missing'), {
          code: 'SESSION_LEASE_MISSING',
        });
      }
      managedLeases[sessionId] = { ...entry, pendingOutcome };
      return { ...document, managedLeases };
    });
  const clearPendingOutcome = async (sessionId) =>
    state.update('agentSessions', (document) => {
      const managedLeases = { ...leaseEntries(document) };
      const entry = leaseEntry(managedLeases[sessionId]);
      if (!entry) {
        throw Object.assign(new Error('managed session lease is missing'), {
          code: 'SESSION_LEASE_MISSING',
        });
      }
      const { pendingOutcome, ...rest } = entry;
      managedLeases[sessionId] = rest;
      return { ...document, managedLeases };
    });

  const event = async ({
    id: eventId,
    kind,
    state: eventState,
    target,
    code,
    source = serviceSource,
  }) => {
    try {
      const recorded = await operationEvents.record({
        at: now(),
        code,
        id: eventId,
        kind,
        source,
        state: eventState,
        target: { name: target.name, repo: target.repo },
      });
      return recorded?.ok
        ? { ok: true }
        : {
            code: recorded?.code ?? 'OPERATION_EVENT_UNAVAILABLE',
            error: recorded?.error ?? 'Operation outcome was not recorded',
            ok: false,
          };
    } catch {
      return {
        code: 'OPERATION_EVENT_UNAVAILABLE',
        error: 'Operation outcome was not recorded',
        ok: false,
      };
    }
  };
  const target = async ({ repo, name }) => {
    if (
      !(typeof repo === 'string' && repo && typeof name === 'string' && name)
    ) {
      return null;
    }
    let resolved;
    try {
      resolved = await resolveTarget({ name, repo });
    } catch {
      return null;
    }
    return resolved &&
      resolved.repo === repo &&
      resolved.name === name &&
      resolved.wtDir &&
      resolved.checkoutIdentity !== undefined
      ? resolved
      : null;
  };
  const filesFor = async (sessionId) =>
    privateFiles?.create
      ? privateFiles.create({ id: sessionId, runtimeDir })
      : defaultPrivateFiles({ id: sessionId, runtimeDir });
  const readRegistration = async (files, sessionId, launchToken) => {
    for (let attempt = 0; attempt < registrationAttempts; attempt += 1) {
      try {
        const parsed = parseSessionRegistration(
          await files.read(files.registrationPath),
          { launchToken, sessionId }
        );
        if (parsed) {
          return parsed;
        }
      } catch {}
      if (attempt + 1 < registrationAttempts) {
        await sleep(registrationDelayMs);
      }
    }
    return null;
  };
  const releaseEndedSessions = async ({ retain = new Set() } = {}) => {
    const leases = leaseDocument();
    for (const session of sessions.list()) {
      if (session.state !== 'ended' || !leases[session.id]) {
        continue;
      }
      const entry = leaseEntry(leases[session.id]);
      if (!locallyReleasedLeases.has(session.id)) {
        let released;
        try {
          released = await admission.release(entry.lease);
        } catch {
          released = null;
        }
        if (!released?.ok) {
          continue;
        }
        locallyReleasedLeases.add(session.id);
      }
      // An outcome recorder outage cannot hold a proven-ended process slot.
      // Keep its attribution for retry after releasing only the exact lease.
      if (retain.has(session.id) || entry.pendingOutcome) {
        continue;
      }
      try {
        await forgetLease(session.id);
      } catch {
        continue;
      }
      const runtime = runtimes.get(session.id);
      if (runtime?.files?.remove) {
        await runtime.files.remove().catch(() => {});
      }
      runtimes.delete(session.id);
    }
  };
  const withTargetResult = async (selected, work) => {
    let result;
    try {
      return await state.withTargets([selected], async () => {
        result = await work();
        return result;
      });
    } catch (error) {
      if (result !== undefined) {
        return {
          ...result,
          recovery: { ...result.recovery, targetLockRelease: 'unavailable' },
        };
      }
      throw error;
    }
  };
  const ensureMonitor = () => {
    if (!monitor) {
      monitor = scheduleInterval(() => {
        void reconcileSessions().catch(() => {});
      }, monitorMs);
    }
  };
  const sessionForTarget = async ({
    repo,
    name,
    sessionId,
    checkoutIdentity,
  }) => {
    const resolved = await target({ name, repo });
    if (!resolved) {
      return {
        error: failure(
          'TARGET_CHANGED',
          'The selected worktree is no longer registered'
        ),
      };
    }
    const session = sessions.get(sessionId);
    return checkoutIdentity !== undefined &&
      resultTarget(session, resolved) &&
      same(checkoutIdentity, resolved.checkoutIdentity)
      ? { resolved, session }
      : {
          error: failure(
            'TARGET_CHANGED',
            'The session does not belong to the current selected checkout'
          ),
        };
  };
  const trackRun = (runId, resolved, source) => {
    void headless
      .wait(runId)
      .then(async () => {
        const run = headless.get(runId);
        if (!resultTarget(run, resolved)) {
          return;
        }
        const stateName =
          run.state === 'completed'
            ? 'completed'
            : run.state === 'failed' ||
                run.state === 'cancelled' ||
                run.state === 'timed out'
              ? 'failed'
              : 'unknown';
        await event({
          id: `headless-${runId}`,
          kind: 'headless-run',
          source,
          state: stateName,
          target: resolved,
        });
      })
      .catch(() => {});
  };

  async function open({ repo, name, tool = 'claude-code', source } = {}) {
    let resolved = await target({ name, repo });
    const reviewed = resolved && {
      checkoutIdentity: resolved.checkoutIdentity,
      wtDir: resolved.wtDir,
    };
    const provider = normalTool(tool);
    if (!resolved) {
      return failure(
        'TARGET_CHANGED',
        'The selected worktree is no longer registered'
      );
    }
    if (!provider) {
      return failure(
        'TOOL_UNSUPPORTED',
        'This coding tool is not supported for managed sessions'
      );
    }
    const sessionId = id();
    const launchToken = token();
    if (!(safeId(sessionId) && tokenPattern.test(launchToken))) {
      return failure(
        'SESSION_ID_INVALID',
        'A safe session identity could not be created'
      );
    }
    const operationId = `session-${sessionId}`;
    const outcomeSource = validSource(source) ? source : serviceSource;
    let admitted;
    try {
      admitted = await admission.admit({
        kind: 'session',
        operationId: sessionId,
        target: { name, repo },
      });
    } catch {
      admitted = null;
    }
    if (!admitted?.ok) {
      return failure(
        admitted?.code ?? 'ADMISSION_REFUSED',
        'Managed session admission was refused'
      );
    }
    let nativeStarted = false;
    let files,
      hasRecord = false,
      lockResult;
    let releaseAttempted = false;
    let remembered = false;
    const releaseOnce = async () => {
      if (releaseAttempted) {
        return null;
      }
      releaseAttempted = true;
      try {
        const released = await admission.release(admitted.lease);
        if (released?.ok) {
          locallyReleasedLeases.add(sessionId);
        }
        return released;
      } catch {
        return null;
      }
    };
    const prelaunchFailure = async ({
      code,
      error,
      files,
      hasRecord = false,
    }) => {
      const cleanup = {};
      if (hasRecord) {
        try {
          if (
            !(
              await sessions.fail(sessionId, {
                checkoutIdentity: reviewed.checkoutIdentity,
              })
            ).ok
          ) {
            cleanup.sessionState = 'unavailable';
          }
        } catch {
          cleanup.sessionState = 'unavailable';
        }
      }
      const released = await releaseOnce();
      if (!released?.ok) {
        cleanup.release = released?.code ?? 'ADMISSION_RELEASE_UNAVAILABLE';
      }
      if (remembered && released?.ok) {
        try {
          await forgetLease(sessionId);
          remembered = false;
        } catch {
          cleanup.forgetLease = 'unavailable';
        }
      }
      if (files?.remove) {
        try {
          await files.remove();
        } catch {
          cleanup.files = 'unavailable';
        }
      }
      runtimes.delete(sessionId);
      const recording = await event({
        code,
        id: operationId,
        kind: 'interactive-session',
        source: outcomeSource,
        state: 'failed',
        target: resolved ?? { name, repo },
      });
      return {
        ...failure(code, error),
        operationId,
        ...(Object.keys(cleanup).length ? { cleanup } : {}),
        ...(!released?.ok || remembered ? { leaseRetained: true } : {}),
        ...(recording.ok ? {} : { recording }),
      };
    };
    const unknownAfterLaunch = async (code, error) => {
      await sessions.reconcile().catch(() => {});
      ensureMonitor();
      const recording = await event({
        code,
        id: operationId,
        kind: 'interactive-session',
        source: outcomeSource,
        state: 'unknown',
        target: resolved ?? { name, repo },
      });
      return {
        ...failure(code, error),
        leaseRetained: true,
        operationId,
        ...(recording.ok ? {} : { recording }),
      };
    };
    const launchLocked = async () => {
      // Admission is deliberately outside this lock. The registry is re-read
      // while locked, so no pre-admission target observation reaches launch.
      resolved = await target({ name, repo });
      if (
        !resolved ||
        resolved.wtDir !== reviewed.wtDir ||
        !same(resolved.checkoutIdentity, reviewed.checkoutIdentity)
      ) {
        return prelaunchFailure({
          code: 'TARGET_CHANGED',
          error: 'The selected worktree changed before launch',
        });
      }
      const acceptedRecording = await event({
        id: operationId,
        kind: 'interactive-session',
        source: outcomeSource,
        state: 'accepted',
        target: resolved,
      });
      try {
        files = await filesFor(sessionId);
      } catch {
        return prelaunchFailure({
          code: 'SESSION_FILES_FAILED',
          error: 'Private launch files could not be created',
        });
      }
      let initial;
      hasRecord = true;
      try {
        initial = await sessions.register({
          checkoutIdentity: resolved.checkoutIdentity,
          checkoutPath: resolved.wtDir,
          id: sessionId,
          name,
          repo,
          tool: provider,
        });
      } catch {
        return prelaunchFailure({
          code: 'SESSION_START_WRITE_FAILED',
          error: 'The starting session record could not be saved',
          files,
          hasRecord,
        });
      }
      if (!initial.ok) {
        return prelaunchFailure({
          code: initial.code ?? 'SESSION_START_WRITE_FAILED',
          error:
            initial.error ?? 'The starting session record could not be saved',
          files,
        });
      }
      // A state write can report failure after an atomic rename. Treat the
      // association as possibly durable until its explicit removal succeeds.
      remembered = true;
      try {
        await rememberLease(sessionId, admitted.lease, outcomeSource);
      } catch {
        return prelaunchFailure({
          code: 'SESSION_LEASE_WRITE_FAILED',
          error: 'The session lease could not be saved',
          files,
          hasRecord: true,
        });
      }
      runtimes.set(sessionId, {
        files,
        lease: admitted.lease,
        source: outcomeSource,
      });
      const settings =
        provider === 'claude-code'
          ? claudeSettings({ hookPath: files.hookPath })
          : null;
      const command =
        provider === 'claude-code'
          ? `claude --settings "$(cat -- ${shellQuote(files.settingsPath)})"`
          : 'codex';
      const launch = buildAgentSessionLaunch({
        checkoutPath: resolved.wtDir,
        command,
        launcherPath: files.launcherPath,
        launchToken,
        registrationPath: files.registrationPath,
        sessionId,
      });
      try {
        if (provider === 'claude-code') {
          await files.write(
            files.hookPath,
            claudeHookProgram(ingressUrl),
            0o700
          );
          await files.write(files.settingsPath, settings, 0o600);
        }
        // `open -na` has no documented per-launch environment option. Keep the
        // token only in this 0700 launcher so its registration can still be bound.
        await files.write(
          files.launcherPath,
          `export SETU_SESSION_TOKEN=${shellQuote(launchToken)}\n${launch.script}`,
          0o700
        );
        await files.write(files.registrationPath, '', 0o600);
      } catch {
        return prelaunchFailure({
          code: 'SESSION_FILES_FAILED',
          error: 'Private launch files could not be written',
          files,
          hasRecord: true,
        });
      }
      if (provider === 'claude-code') {
        const registrationBinding = ingress.registerLaunch({
          checkoutIdentity: resolved.checkoutIdentity,
          checkoutPath: resolved.wtDir,
          launchToken,
          provider,
          sessionId,
        });
        if (!registrationBinding.ok) {
          return prelaunchFailure({
            code: registrationBinding.code,
            error: registrationBinding.error,
            files,
            hasRecord: true,
          });
        }
      }
      const scripted = buildGhosttyScriptLaunch({
        checkoutPath: resolved.wtDir,
        launcherPath: files.launcherPath,
        launchToken,
      });
      let native;
      nativeStarted = true;
      try {
        native = await (launchNative ?? runAppleScript)(scripted);
      } catch {
        native = { availability: 'unknown' };
      }
      const terminalId =
        native?.availability === 'available'
          ? parseGhosttyLaunchResponse(native.stdout)
          : null;
      const exactTerminal = Boolean(terminalId);
      if (
        !terminalId &&
        (native?.availability === 'unavailable' ||
          native?.availability === 'disabled' ||
          native?.stdout?.trim() === 'SETU:SCRIPTING_DISABLED')
      ) {
        try {
          const fallback = await (launchOpen ?? defaultOpen)(launch);
          if (!fallback?.ok) {
            throw new Error('open failed');
          }
        } catch {
          return unknownAfterLaunch(
            'TERMINAL_LAUNCH_UNKNOWN',
            'Ghostty launch could not be confirmed'
          );
        }
      } else if (!terminalId) {
        return unknownAfterLaunch(
          native?.availability === 'disabled'
            ? 'GHOSTTY_AUTOMATION_DISABLED'
            : 'TERMINAL_LAUNCH_UNKNOWN',
          'Ghostty launch could not be confirmed'
        );
      }
      const registration = await readRegistration(
        files,
        sessionId,
        launchToken
      );
      if (!registration) {
        return unknownAfterLaunch(
          'SESSION_REGISTRATION_UNKNOWN',
          'A terminal window does not prove the coding session started'
        );
      }
      const registered = await sessions.register({
        ...initial.session,
        ...registration,
        terminal: terminalId ? { id: terminalId, kind: 'ghostty' } : undefined,
      });
      if (!registered.ok) {
        return unknownAfterLaunch(
          registered.code ?? 'SESSION_REGISTRATION_UNKNOWN',
          registered.error ?? 'The coding process could not be registered'
        );
      }
      const runningRecording = await event({
        id: operationId,
        kind: 'interactive-session',
        source: outcomeSource,
        state: 'running',
        target: resolved,
      });
      ensureMonitor();
      return {
        capability: { exactTerminal, trustedHooks: provider === 'claude-code' },
        ok: true,
        operationId,
        session: safeSession(registered.session),
        ...(acceptedRecording.ok
          ? runningRecording.ok
            ? {}
            : { recording: runningRecording }
          : { recording: acceptedRecording }),
      };
    };
    try {
      return await state.withTargets([{ name, repo }], async () => {
        lockResult = await launchLocked();
        return lockResult;
      });
    } catch {
      if (!nativeStarted) {
        if (lockResult) {
          return {
            ...lockResult,
            cleanup: {
              ...lockResult.cleanup,
              targetLockRelease: 'unavailable',
            },
          };
        }
        return prelaunchFailure({
          code: 'TARGET_LOCK_FAILED',
          error: 'The target could not be locked before launch',
          files,
          hasRecord,
        });
      }
      return unknownAfterLaunch(
        'SESSION_LAUNCH_UNKNOWN',
        'The launch outcome could not be confirmed'
      );
    }
  }

  async function reconcileSessions() {
    let before, result, leases;
    try {
      before = new Map(
        sessions.list().map((session) => [session.id, session.state])
      );
      leases = leaseDocument();
      result = await sessions.reconcile();
    } catch {
      return failure('SESSION_STATE_CORRUPT', 'Session state is malformed');
    }
    const recording = [];
    const retain = new Set();
    if (result.ok) {
      for (const session of result.sessions) {
        const entry = leaseEntry(leases[session.id]);
        const pending = entry?.pendingOutcome;
        if (
          before.get(session.id) === session.state &&
          ['ended', 'unknown'].includes(session.state) &&
          !pending
        ) {
          continue;
        }
        if (session.state === 'ended' || session.state === 'unknown') {
          const outcome =
            pending &&
            !(session.state === 'ended' && pending.state === 'unknown')
              ? pending
              : {
                  state: session.state === 'ended' ? 'completed' : 'unknown',
                  ...(session.state === 'unknown'
                    ? { code: 'SESSION_OWNERSHIP_UNKNOWN' }
                    : {}),
                  source:
                    runtimes.get(session.id)?.source ??
                    entry?.source ??
                    serviceSource,
                };
          try {
            await setPendingOutcome(session.id, outcome);
          } catch {
            retain.add(session.id);
            recording.push(
              failure(
                'OPERATION_EVENT_PENDING_UNAVAILABLE',
                'The session outcome could not be retained'
              )
            );
            continue;
          }
          const recorded = await event({
            code: outcome.code,
            id: `session-${session.id}`,
            kind: 'interactive-session',
            source: outcome.source,
            state: outcome.state,
            target: session,
          });
          recording.push(recorded);
          if (!recorded.ok) {
            retain.add(session.id);
            continue;
          }
          try {
            await clearPendingOutcome(session.id);
          } catch {
            retain.add(session.id);
          }
        }
      }
      try {
        await releaseEndedSessions({ retain });
      } catch {
        return {
          ok: true,
          recording: failure(
            'SESSION_LEASE_JOURNAL_INVALID',
            'Session lease cleanup could not be completed'
          ),
          sessions: result.sessions.map(safeSession),
        };
      }
    }
    return result.ok
      ? {
          ok: true,
          sessions: result.sessions.map(safeSession),
          ...(recording.find((item) => !item.ok)
            ? { recording: recording.find((item) => !item.ok) }
            : {}),
        }
      : result;
  }

  async function endSession({
    repo,
    name,
    sessionId,
    checkoutIdentity,
    source,
  } = {}) {
    return withTargetResult({ name, repo }, async () => {
      const selected = await sessionForTarget({
        checkoutIdentity,
        name,
        repo,
        sessionId,
      });
      if (selected.error) {
        return selected.error;
      }
      const result = await sessions.end(sessionId, { checkoutIdentity });
      const operationId = `session-${sessionId}`;
      let recording;
      if (result.session?.state === 'ended') {
        const entry = (() => {
          try {
            return leaseEntry(leaseDocument()[sessionId]);
          } catch {
            return null;
          }
        })();
        // A lifecycle completion belongs to the front door that launched this
        // owned process; a later portal recovery/end request must not rewrite it.
        const outcome = {
          source:
            entry?.source ?? (validSource(source) ? source : serviceSource),
          state: 'completed',
        };
        try {
          await setPendingOutcome(sessionId, outcome);
          recording = await event({
            id: operationId,
            kind: 'interactive-session',
            source: outcome.source,
            state: outcome.state,
            target: selected.resolved,
          });
          if (recording.ok) {
            await clearPendingOutcome(sessionId);
          }
        } catch {
          recording = failure(
            'OPERATION_EVENT_PENDING_UNAVAILABLE',
            'The session outcome could not be retained'
          );
        }
        await releaseEndedSessions({
          retain: recording?.ok ? new Set() : new Set([sessionId]),
        }).catch(() => {});
      } else if (!result.ok && result.session?.state === 'unknown') {
        const entry = (() => {
          try {
            return leaseEntry(leaseDocument()[sessionId]);
          } catch {
            return null;
          }
        })();
        recording = await event({
          code: result.code,
          id: operationId,
          kind: 'interactive-session',
          source:
            entry?.source ?? (validSource(source) ? source : serviceSource),
          state: 'unknown',
          target: selected.resolved,
        });
      }
      return {
        ...result,
        operationId,
        ...(recording && !recording.ok ? { recording } : {}),
      };
    });
  }

  async function receiveHook({ provider, payload, launchToken } = {}) {
    const canonical = normalTool(provider);
    if (!canonical) {
      return failure(
        'HOOK_PROVIDER_UNSUPPORTED',
        'The hook provider is unsupported'
      );
    }
    if (payload?.hook_event_name === 'SessionStart') {
      return ingress.bind({
        checkoutPath: payload.cwd,
        launchToken,
        nativeSessionId: payload.session_id,
        provider: canonical,
      });
    }
    return attention.receive({ payload, provider: canonical });
  }

  async function listAttention({ repo, name } = {}) {
    const listed = attention.list();
    if (!listed.ok) {
      return listed;
    }
    const only =
      repo === undefined && name === undefined
        ? null
        : await target({ name, repo });
    if ((repo !== undefined || name !== undefined) && !only) {
      return failure(
        'TARGET_CHANGED',
        'The selected worktree is no longer registered'
      );
    }
    const events = [];
    for (const item of listed.events) {
      const session = item.sessionId ? sessions.get(item.sessionId) : null;
      const resolved =
        session && session.ownership === 'owned' && session.state === 'running'
          ? await target({ name: session.name, repo: session.repo })
          : null;
      const valid =
        resolved &&
        resultTarget(session, resolved) &&
        (!only || (only.repo === resolved.repo && only.name === resolved.name));
      if (!only || valid) {
        events.push({
          ...item,
          session: valid ? safeSession(session) : null,
          target: valid ? { name: resolved.name, repo: resolved.repo } : null,
        });
      }
    }
    return { events, ok: true };
  }

  async function focus({
    repo,
    name,
    sessionId,
    checkoutIdentity,
    source,
  } = {}) {
    const operationId = `terminal-focus-${id()}`;
    const outcomeSource = validSource(source) ? source : serviceSource;
    try {
      return await withTargetResult({ name, repo }, async () => {
        const selected = await sessionForTarget({
          checkoutIdentity,
          name,
          repo,
          sessionId,
        });
        if (selected.error) {
          const recording = await event({
            code: selected.error.code,
            id: operationId,
            kind: 'terminal-focus',
            source: outcomeSource,
            state: 'failed',
            target: { name, repo },
          });
          return {
            ...selected.error,
            operationId,
            ...(recording.ok ? {} : { recording }),
          };
        }
        if (selected.session.terminal?.kind !== 'ghostty') {
          const outcome = failure(
            'GHOSTTY_TERMINAL_UNAVAILABLE',
            'This session was not launched with an exact Ghostty terminal mapping'
          );
          const recording = await event({
            code: outcome.code,
            id: operationId,
            kind: 'terminal-focus',
            source: outcomeSource,
            state: 'failed',
            target: selected.resolved,
          });
          return {
            ...outcome,
            operationId,
            ...(recording.ok ? {} : { recording }),
          };
        }
        const outcome = await attention.returnToTerminal(sessionId);
        const recording = await event({
          code: outcome.code,
          id: operationId,
          kind: 'terminal-focus',
          source: outcomeSource,
          state: outcome.ok ? 'completed' : 'failed',
          target: selected.resolved,
        });
        return {
          ...outcome,
          operationId,
          ...(recording.ok ? {} : { recording }),
        };
      });
    } catch {
      const outcome = failure(
        'TARGET_LOCK_FAILED',
        'The selected worktree could not be locked'
      );
      const recording = await event({
        code: outcome.code,
        id: operationId,
        kind: 'terminal-focus',
        source: outcomeSource,
        state: 'failed',
        target: { name, repo },
      });
      return {
        ...outcome,
        operationId,
        ...(recording.ok ? {} : { recording }),
      };
    }
  }

  async function handoffFinding({
    repo,
    name,
    sessionId,
    checkoutIdentity,
    artifact,
    findings,
    source,
  } = {}) {
    const operationId = `review-handoff-${id()}`;
    const outcomeSource = validSource(source) ? source : serviceSource;
    try {
      return await withTargetResult({ name, repo }, async () => {
        const selected = await sessionForTarget({
          checkoutIdentity,
          name,
          repo,
          sessionId,
        });
        if (selected.error) {
          const recording = await event({
            code: selected.error.code,
            id: operationId,
            kind: 'review-handoff',
            source: outcomeSource,
            state: 'failed',
            target: { name, repo },
          });
          return {
            ...selected.error,
            operationId,
            ...(recording.ok ? {} : { recording }),
          };
        }
        if (selected.session.terminal?.kind !== 'ghostty') {
          const outcome = failure(
            'HANDOFF_DELIVERY_UNAVAILABLE',
            'This session has no exact native-terminal delivery capability'
          );
          const recording = await event({
            code: outcome.code,
            id: operationId,
            kind: 'review-handoff',
            source: outcomeSource,
            state: 'failed',
            target: selected.resolved,
          });
          return {
            ...outcome,
            operationId,
            ...(recording.ok ? {} : { recording }),
          };
        }
        const outcome = await handoff.deliver({
          artifact,
          checkoutIdentity,
          findings,
          sessionId,
          target: { name, repo },
        });
        const recording = await event({
          code: outcome.code,
          id: operationId,
          kind: 'review-handoff',
          source: outcomeSource,
          state: outcome.ok ? 'completed' : 'failed',
          target: selected.resolved,
        });
        return {
          ...outcome,
          operationId,
          ...(recording.ok ? {} : { recording }),
        };
      });
    } catch {
      const outcome = failure(
        'TARGET_LOCK_FAILED',
        'The selected worktree could not be locked'
      );
      const recording = await event({
        code: outcome.code,
        id: operationId,
        kind: 'review-handoff',
        source: outcomeSource,
        state: 'failed',
        target: { name, repo },
      });
      return {
        ...outcome,
        operationId,
        ...(recording.ok ? {} : { recording }),
      };
    }
  }

  async function startRun({ repo, name, source, ...input } = {}) {
    const resolved = await target({ name, repo });
    if (!resolved) {
      return failure(
        'TARGET_CHANGED',
        'The selected worktree is no longer registered'
      );
    }
    const outcome = await headless.start({
      ...input,
      checkoutIdentity: resolved.checkoutIdentity,
      checkoutPath: resolved.wtDir,
      name,
      repo,
    });
    const operationId = outcome.id
      ? `headless-${outcome.id}`
      : `headless-refused-${safeId(input.id) ? input.id : id()}`;
    const recording = await event({
      code: outcome.code,
      id: operationId,
      kind: 'headless-run',
      source,
      state: outcome.ok
        ? 'running'
        : outcome.state === 'unknown' || outcome.code === 'RUN_PROCESS_UNKNOWN'
          ? 'unknown'
          : 'failed',
      target: resolved,
    });
    if (outcome.id && (outcome.ok || outcome.state === 'unknown')) {
      trackRun(outcome.id, resolved, source);
    }
    return { ...outcome, operationId, ...(recording.ok ? {} : { recording }) };
  }

  async function cancelRun({
    repo,
    name,
    runId,
    checkoutIdentity,
    source,
  } = {}) {
    return withTargetResult({ name, repo }, async () => {
      const resolved = await target({ name, repo });
      const run = headless.get(runId);
      if (
        !(
          resolved &&
          resultTarget(run, resolved) &&
          same(checkoutIdentity, resolved.checkoutIdentity)
        )
      ) {
        return failure(
          'TARGET_CHANGED',
          'The run does not belong to the current selected checkout'
        );
      }
      const outcome = await headless.cancel({ checkoutIdentity, id: runId });
      const recording = outcome.ok
        ? null
        : await event({
            code: outcome.code,
            id: `headless-${runId}`,
            kind: 'headless-run',
            source,
            state: 'unknown',
            target: resolved,
          });
      return {
        ...outcome,
        operationId: `headless-${runId}`,
        ...(recording && !recording.ok ? { recording } : {}),
      };
    });
  }

  async function resumeRun({ repo, name, runId, source, ...input } = {}) {
    const resolved = await target({ name, repo });
    const run = headless.get(runId);
    if (!(resolved && resultTarget(run, resolved))) {
      return failure(
        'TARGET_CHANGED',
        'The run does not belong to the current selected checkout'
      );
    }
    const outcome = await headless.resume({
      ...input,
      checkoutIdentity: resolved.checkoutIdentity,
      checkoutPath: resolved.wtDir,
      name,
      repo,
      runId,
    });
    const operationId = outcome.id
      ? `headless-${outcome.id}`
      : `headless-refused-${safeId(input.id) ? input.id : id()}`;
    const recording = await event({
      code: outcome.code,
      id: operationId,
      kind: 'headless-run',
      source,
      state: outcome.ok
        ? 'running'
        : outcome.state === 'unknown' || outcome.code === 'RUN_PROCESS_UNKNOWN'
          ? 'unknown'
          : 'failed',
      target: resolved,
    });
    if (outcome.id && (outcome.ok || outcome.state === 'unknown')) {
      trackRun(outcome.id, resolved, source);
    }
    return {
      ...outcome,
      operationId,
      ...(recording && !recording.ok ? { recording } : {}),
    };
  }

  async function listRuns({ repo, name } = {}) {
    const listed = headless.list();
    if (!listed.ok) {
      return listed;
    }
    const runs = listed.runs;
    const only =
      repo === undefined && name === undefined
        ? null
        : await target({ name, repo });
    if ((repo !== undefined || name !== undefined) && !only) {
      return failure(
        'TARGET_CHANGED',
        'The selected worktree is no longer registered'
      );
    }
    return {
      ok: true,
      runs: runs.filter((run) => !only || resultTarget(run, only)).map(safeRun),
    };
  }

  async function recover() {
    const [sessionResult, runResult] = await Promise.all([
      reconcileSessions(),
      headless.reconcile(),
    ]);
    if (sessionResult.ok) {
      let leases = {};
      try {
        leases = leaseDocument();
      } catch {
        return {
          ok: false,
          runs: runResult,
          sessions: failure(
            'SESSION_STATE_CORRUPT',
            'Session lease state is malformed'
          ),
        };
      }
      if (
        sessionResult.sessions.some((session) => leaseEntry(leases[session.id]))
      ) {
        ensureMonitor();
      }
    }
    return {
      ok: sessionResult.ok && runResult.ok,
      runs: runResult,
      sessions: sessionResult,
    };
  }

  return Object.freeze({
    cancelRun,
    dispose: async () => {
      if (monitor) {
        clearMonitor(monitor);
        monitor = null;
      }
      return { ok: true };
    },
    endSession,
    focus,
    handoff: handoffFinding,
    listAttention,
    listRuns,
    listSessions: async ({ repo, name } = {}) => {
      const only =
        repo === undefined && name === undefined
          ? null
          : await target({ name, repo });
      if ((repo !== undefined || name !== undefined) && !only) {
        return failure(
          'TARGET_CHANGED',
          'The selected worktree is no longer registered'
        );
      }
      try {
        return {
          ok: true,
          sessions: sessions
            .list()
            .filter((session) => !only || resultTarget(session, only))
            .map(safeSession),
        };
      } catch {
        return failure('SESSION_STATE_CORRUPT', 'Session state is malformed');
      }
    },
    open,
    receiveHook,
    reconcileSessions,
    recover,
    resumeRun,
    startRun,
  });
}
