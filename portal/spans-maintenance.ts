export type MaintenanceOperation = 'backup' | 'restore';

export interface MaintenanceInput {
  backupRoot?: string;
  destination: string;
  operation: MaintenanceOperation;
}

interface MaintenanceCounts {
  artifactBytes: number;
  artifacts: number;
  cacheEntries: number;
  databaseBytes: number;
  events: number;
  sources: number;
  views: number;
}

export type MaintenanceResult =
  | { kind: 'success'; counts: MaintenanceCounts }
  | { kind: 'refused' | 'incomplete' | 'unknown'; message: string };

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_VALIDATION_MESSAGE = 'Enter valid absolute archive paths.';
const UNKNOWN_MESSAGE =
  'The result is unknown. Inspect the destination before acting again.';

const SAFE_ERRORS: Record<string, string> = {
  ADMISSION_CLOSED: 'Setu is updating. Wait for the update to finish.',
  SPANS_BACKUP_ARTIFACT_INVALID: 'The archive contains an invalid artifact.',
  SPANS_BACKUP_ARTIFACT_MISSING: 'A referenced archive artifact is missing.',
  SPANS_BACKUP_ARTIFACT_TOO_LARGE:
    'An archive artifact exceeds the supported size.',
  SPANS_BACKUP_BUSY: 'The archive is busy. Try again later.',
  SPANS_BACKUP_CORRUPT: 'The archive failed an integrity check.',
  SPANS_BACKUP_DESTINATION_EXISTS: 'The destination already exists.',
  SPANS_BACKUP_FAILED: 'The archive operation could not be completed.',
  SPANS_BACKUP_INCOMPLETE: 'The backup is incomplete and was retained.',
  SPANS_BACKUP_MANIFEST_INVALID: 'The backup receipt is invalid.',
  SPANS_BACKUP_MISMATCH: 'The backup contents do not match its receipt.',
  SPANS_BACKUP_OPTIONS_INVALID: SAFE_VALIDATION_MESSAGE,
  SPANS_BACKUP_OUTCOME_UNKNOWN: UNKNOWN_MESSAGE,
  SPANS_BACKUP_PATH_UNSAFE: 'The selected path is unavailable or unsafe.',
  SPANS_BACKUP_RUNTIME_CLOSED: 'Archive maintenance is unavailable.',
  SPANS_BACKUP_SCHEMA_NEWER: 'The archive was created by a newer version.',
  SPANS_BACKUP_SCHEMA_UNSUPPORTED: 'The archive format is unsupported.',
  SPANS_BACKUP_SOURCE_UNAVAILABLE:
    'The archive or backup source is unavailable.',
  SPANS_BACKUP_STORAGE_FULL: 'There is not enough storage space.',
  SPANS_BACKUP_TOO_LARGE: 'The archive exceeds the supported size.',
  SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN: UNKNOWN_MESSAGE,
  SPANS_BACKUP_WORKER_UNAVAILABLE: 'Archive maintenance is unavailable.',
  SPANS_SERVICE_UNAVAILABLE: 'Archive maintenance is unavailable.',
};

const COUNT_FIELDS = [
  'artifactBytes',
  'artifacts',
  'cacheEntries',
  'databaseBytes',
  'events',
  'sources',
  'views',
] as const;

function validatePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.trim().length > 0 &&
    path.startsWith('/') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}

export function validateMaintenanceInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return SAFE_VALIDATION_MESSAGE;
  }
  const value = input as Partial<MaintenanceInput>;
  if (value.operation !== 'backup' && value.operation !== 'restore') {
    return SAFE_VALIDATION_MESSAGE;
  }
  if (!validatePath(value.destination)) {
    return SAFE_VALIDATION_MESSAGE;
  }
  let body: { backupRoot?: string; destination: string };
  if (value.operation === 'backup') {
    if (Object.hasOwn(value, 'backupRoot')) {
      return SAFE_VALIDATION_MESSAGE;
    }
    body = { destination: value.destination };
  } else {
    if (!validatePath(value.backupRoot)) {
      return SAFE_VALIDATION_MESSAGE;
    }
    body = {
      backupRoot: value.backupRoot,
      destination: value.destination,
    };
  }
  return new TextEncoder().encode(JSON.stringify(body)).byteLength >
    MAX_REQUEST_BYTES
    ? SAFE_VALIDATION_MESSAGE
    : null;
}

function refusal(code: unknown): MaintenanceResult {
  const key = typeof code === 'string' ? code : '';
  return {
    kind: 'refused',
    message: SAFE_ERRORS[key] ?? 'Archive maintenance was refused.',
  };
}

function decode(body: unknown): MaintenanceResult | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const value = body as Record<string, unknown>;
  if (value.ok === true) {
    if (
      Object.keys(value).length !== COUNT_FIELDS.length + 1 ||
      !COUNT_FIELDS.every(
        (field) =>
          Number.isSafeInteger(value[field]) && (value[field] as number) >= 0
      )
    ) {
      return null;
    }
    const counts = Object.fromEntries(
      COUNT_FIELDS.map((field) => [field, value[field]])
    ) as unknown as MaintenanceCounts;
    return { counts, kind: 'success' };
  }
  if (value.ok !== false || typeof value.code !== 'string') {
    return null;
  }
  if (
    ['incomplete', 'outcomeUnknown'].some(
      (field) =>
        Object.hasOwn(value, field) && typeof value[field] !== 'boolean'
    )
  ) {
    return null;
  }
  if (value.outcomeUnknown === true || value.code.includes('OUTCOME_UNKNOWN')) {
    return {
      kind: 'unknown',
      message: UNKNOWN_MESSAGE,
    };
  }
  if (value.incomplete === true) {
    return {
      kind: 'incomplete',
      message: Object.hasOwn(SAFE_ERRORS, value.code)
        ? SAFE_ERRORS[value.code]
        : 'The incomplete destination was retained.',
    };
  }
  if (!Object.hasOwn(SAFE_ERRORS, value.code)) {
    return null;
  }
  return refusal(value.code);
}

async function readBounded(response: Response): Promise<unknown | null> {
  if (!response.body) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Read the response stream one chunk at a time.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function submitSpansMaintenance(
  input: MaintenanceInput
): Promise<MaintenanceResult> {
  const invalid = validateMaintenanceInput(input);
  if (invalid) {
    return { kind: 'refused', message: invalid };
  }
  const path =
    input.operation === 'backup' ? '/api/spans/backup' : '/api/spans/restore';
  const body =
    input.operation === 'backup'
      ? { destination: input.destination }
      : { backupRoot: input.backupRoot, destination: input.destination };
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
    return { kind: 'refused', message: SAFE_VALIDATION_MESSAGE };
  }
  try {
    const response = await fetch(path, {
      body: serialized,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const result = decode(await readBounded(response));
    if (!result || (!response.ok && result.kind === 'success')) {
      return { kind: 'unknown', message: UNKNOWN_MESSAGE };
    }
    return result;
  } catch {
    return { kind: 'unknown', message: UNKNOWN_MESSAGE };
  }
}
