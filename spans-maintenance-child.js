// Private child boundary for synchronous archive maintenance primitives.
// Input and output are one bounded JSON document each; no paths or exception
// messages are written to stderr or added to structured results.
import { runSpansMaintenanceCommand } from './spans-maintenance-command.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UNKNOWN = {
  code: 'SPANS_BACKUP_WORKER_OUTCOME_UNKNOWN',
  error:
    'The Spans maintenance worker ended without a confirmed result. The destination was kept and may exist; the outcome is unknown.',
  ok: false,
  outcomeUnknown: true,
};

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

let result;
try {
  const request = await readRequest();
  if (
    request === null ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !['backup', 'restore'].includes(request.operation)
  ) {
    result = runSpansMaintenanceCommand({});
  } else {
    result = runSpansMaintenanceCommand(request);
  }
} catch {
  result = UNKNOWN;
}

let response;
try {
  response = JSON.stringify(result);
} catch {
  response = JSON.stringify(UNKNOWN);
}
if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
  response = JSON.stringify(UNKNOWN);
}
process.stdout.write(response);
