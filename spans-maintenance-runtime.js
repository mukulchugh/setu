// Shared asynchronous backup and restore service for callers that already
// have a trusted archive root. The maintenance primitives remain the only
// filesystem writer and run in an owned local Bun child process.
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INVALID_ROOT =
  'Spans maintenance root must be a canonical absolute path.';
const BACKUP_FIELDS = ['destination'];
const RESTORE_FIELDS = ['backupRoot', 'destination'];
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CHILD_PATH = fileURLToPath(
  new URL('./spans-maintenance-child.js', import.meta.url)
);
const BUSY = Object.freeze({
  code: 'SPANS_BACKUP_BUSY',
  error: 'A Spans maintenance operation is already active in this runtime.',
  ok: false,
});
const CLOSED = Object.freeze({
  code: 'SPANS_BACKUP_RUNTIME_CLOSED',
  error: 'Spans maintenance runtime is closed.',
  ok: false,
});
const UNAVAILABLE = Object.freeze({
  code: 'SPANS_BACKUP_WORKER_UNAVAILABLE',
  error: 'The Spans maintenance worker could not be started.',
  ok: false,
});
const UNKNOWN = Object.freeze({
  code: 'SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN',
  error:
    'The Spans maintenance worker ended without a confirmed result. The destination was kept and may exist; the outcome is unknown.',
  ok: false,
  outcomeUnknown: true,
});

function readExactInput(raw, fields) {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const keys = Reflect.ownKeys(raw);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field))
    ) {
      return null;
    }
    const values = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (!(descriptor && Object.hasOwn(descriptor, 'value'))) {
        return null;
      }
      values[field] = descriptor.value;
    }
    return values;
  } catch {
    // Proxies and hostile descriptors are invalid public input.
    return null;
  }
}

function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function validResponse(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (value.ok === true) {
    const counts = [
      'artifactBytes',
      'artifacts',
      'cacheEntries',
      'databaseBytes',
      'events',
      'sources',
      'views',
    ];
    return (
      Object.keys(value).length === counts.length + 1 &&
      counts.every(
        (field) => Number.isSafeInteger(value[field]) && value[field] >= 0
      )
    );
  }
  return (
    value.ok === false &&
    typeof value.code === 'string' &&
    typeof value.error === 'string' &&
    ['incomplete', 'outcomeUnknown'].every(
      (field) =>
        !Object.hasOwn(value, field) || typeof value[field] === 'boolean'
    )
  );
}

function invalidOptions() {
  return Promise.resolve({
    code: 'SPANS_BACKUP_OPTIONS_INVALID',
    error: 'Options must be exactly the required absolute root paths.',
    ok: false,
  });
}

function unknownOutcome() {
  return { ...UNKNOWN };
}

function runChild(command) {
  let serialized;
  try {
    serialized = JSON.stringify(command);
  } catch {
    return invalidOptions();
  }
  if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
    return invalidOptions();
  }

  return new Promise((resolveResult) => {
    let child;
    let started = false;
    let settled = false;
    let transportError = false;
    let stdoutBytes = 0;
    let responseTooLarge = false;
    const chunks = [];
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    };

    try {
      child = spawn(process.execPath, [CHILD_PATH], {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      settle(UNAVAILABLE);
      return;
    }

    child.once('spawn', () => {
      started = true;
      try {
        child.stdin.end(serialized);
      } catch {
        // The child has started, so a missing response is uncertain.
        transportError = true;
        child.stdin.destroy();
      }
    });
    child.stdin.on('error', () => {
      transportError = true;
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESPONSE_BYTES) {
        responseTooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', () => {
      transportError = true;
    });
    child.once('error', () => {
      transportError = true;
    });
    child.once('close', (code) => {
      if (!started) {
        settle(UNAVAILABLE);
        return;
      }
      if (
        code !== 0 ||
        transportError ||
        responseTooLarge ||
        chunks.length === 0
      ) {
        settle(unknownOutcome());
        return;
      }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!validResponse(response)) {
          settle(unknownOutcome());
          return;
        }
        settle(response);
      } catch {
        settle(unknownOutcome());
      }
    });
  });
}

export function createSpansMaintenanceRuntime(options) {
  const trusted = readExactInput(options, ['root']);
  const root = trusted?.root;
  if (!validPath(root)) {
    throw new TypeError(INVALID_ROOT);
  }
  // Archive availability and filesystem identity are checked at the operation,
  // so constructing the portal never initializes or requires an archive.
  let active;
  let closing = false;
  let closePromise;

  function operate(operation, input, fields) {
    const values = readExactInput(input, fields);
    if (!(values && fields.every((field) => validPath(values[field])))) {
      return invalidOptions();
    }
    if (closing) {
      return Promise.resolve(CLOSED);
    }
    if (active) {
      return Promise.resolve(BUSY);
    }
    const command =
      operation === 'backup'
        ? { destination: values.destination, operation, root }
        : {
            backupRoot: values.backupRoot,
            destination: values.destination,
            operation,
          };
    const current = runChild(command).finally(() => {
      if (active === current) {
        active = undefined;
      }
    });
    active = current;
    return current;
  }

  function close() {
    closing = true;
    closePromise ??= (async () => {
      if (active) {
        await active;
      }
      return { ok: true };
    })();
    return closePromise;
  }

  return Object.freeze({
    backup(input) {
      return operate('backup', input, BACKUP_FIELDS);
    },
    close,
    restore(input) {
      return operate('restore', input, RESTORE_FIELDS);
    },
  });
}
