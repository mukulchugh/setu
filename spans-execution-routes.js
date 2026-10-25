// HTTP front door for Spans execution. Every route calls one service method
// and returns its result; nothing here decides, authorizes or starts anything.
// With execution disabled each route answers 503 and no service exists.

const BODY_BYTES = 1024 * 1024;

export const SPANS_EXECUTION_GET_ROUTES = Object.freeze({
  '/api/spans/execution/capabilities': {
    action: 'spansExecutionCapabilities',
    query: ['profile'],
  },
  '/api/spans/execution/saved-review': {
    action: 'spansExecutionReadReview',
    query: ['runId', 'reviewDigest'],
  },
  '/api/spans/execution/status': {
    action: 'spansExecutionStatus',
    query: ['runId'],
  },
});

export const SPANS_EXECUTION_POST_ROUTES = Object.freeze({
  '/api/spans/execution/accept': 'spansExecutionAccept',
  '/api/spans/execution/approval-challenge': 'spansExecutionApprovalChallenge',
  '/api/spans/execution/approve': 'spansExecutionApprove',
  '/api/spans/execution/cancel': 'spansExecutionCancel',
  '/api/spans/execution/complete': 'spansExecutionComplete',
  '/api/spans/execution/dispatch': 'spansExecutionDispatch',
  '/api/spans/execution/prepare': 'spansExecutionPrepare',
  '/api/spans/execution/probe': 'spansExecutionProbe',
  '/api/spans/execution/reconcile': 'spansExecutionReconcile',
  '/api/spans/execution/report': 'spansExecutionReport',
  '/api/spans/execution/resolve': 'spansExecutionResolve',
  '/api/spans/execution/review': 'spansExecutionReview',
  '/api/spans/execution/revoke': 'spansExecutionRevoke',
});

const disabled = Object.freeze({
  code: 'SPANS_EXECUTION_DISABLED',
  error: 'Spans execution is not enabled.',
  ok: false,
});
const invalid = Object.freeze({
  code: 'SPANS_EXEC_REQUEST_INVALID',
  error: 'The request does not use the expected format.',
  ok: false,
});

async function readBody(request) {
  if (!request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Read the bounded request stream in order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

// Returns the query as an object, or null for repeated, unknown or missing keys.
function readQuery(url, allowed) {
  const input = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !allowed.includes(key)) {
      return null;
    }
    [input[key]] = values;
  }
  return allowed.every((key) => key in input) ? input : null;
}

async function run(services, action, input, response) {
  if (typeof services[action] !== 'function') {
    return response(disabled, 503);
  }
  try {
    const result = await services[action](input);
    // A setting that is present but malformed is unavailable, like a disabled one.
    return result?.code === 'SPANS_EXECUTION_CONFIG_INVALID'
      ? response(result, 503)
      : response(result);
  } catch {
    // The service's message is never forwarded.
    return response(
      {
        code: 'SPANS_EXEC_UNAVAILABLE',
        error: 'Spans execution is unavailable.',
        ok: false,
      },
      503
    );
  }
}

// Returns a Response for a Spans execution route, or null for any other path.
export async function dispatchSpansExecutionRoute(
  services,
  request,
  url,
  response
) {
  if (request.method === 'GET') {
    const route = Object.hasOwn(SPANS_EXECUTION_GET_ROUTES, url.pathname)
      ? SPANS_EXECUTION_GET_ROUTES[url.pathname]
      : null;
    if (!route) {
      return null;
    }
    const input = readQuery(url, route.query);
    return input
      ? await run(services, route.action, input, response)
      : response(invalid, 400);
  }
  if (
    request.method !== 'POST' ||
    !Object.hasOwn(SPANS_EXECUTION_POST_ROUTES, url.pathname)
  ) {
    return null;
  }
  const body = await readBody(request);
  if (url.search || !body || typeof body !== 'object' || Array.isArray(body)) {
    return response(invalid, 400);
  }
  return await run(
    services,
    SPANS_EXECUTION_POST_ROUTES[url.pathname],
    body,
    response
  );
}
