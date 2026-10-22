import { expect, test } from 'bun:test';
import { dispatchPortalResourceRoute } from './portal-resource-services.js';
import { PORTAL_API_ROUTES, portalApiRoute } from './portal-routes.js';

const digest = 'a'.repeat(64);

const routeActions = [
  [
    '/api/dependency-sharing/prepare',
    'dependencyPrepare',
    { name: 'topic', repo: 'r' },
  ],
  [
    '/api/dependency-sharing/apply',
    'dependencyApply',
    { confirmation: digest, name: 'topic', planId: digest, repo: 'r' },
  ],
  [
    '/api/dependency-sharing/recover',
    'dependencyRecover',
    { name: 'topic', operationId: digest, repo: 'r' },
  ],
  [
    '/api/dependency-sharing/prepare-release',
    'dependencyPrepareRelease',
    { name: 'topic', operationId: digest, repo: 'r' },
  ],
  [
    '/api/dependency-sharing/release',
    'dependencyRelease',
    { confirmation: digest, name: 'topic', releaseId: digest, repo: 'r' },
  ],
];

function servicesFor(calls) {
  return Object.fromEntries(
    routeActions.map(([, action]) => [
      action,
      (input) => {
        calls.push({ action, input });
        return {
          ok: true,
          operationId: input.operationId,
          plan: action === 'dependencyPrepare' ? { id: digest } : undefined,
          releaseId: input.releaseId,
          state: 'prepared',
        };
      },
    ])
  );
}

function dispatch(services, path, body, headers = {}) {
  return dispatchPortalResourceRoute(
    services,
    new Request(`http://portal.test${path}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    })
  );
}

test('dependency file endpoints are exact POST routes in the portal manifest', () => {
  expect(new Set(PORTAL_API_ROUTES.map((route) => route.path)).size).toBe(
    PORTAL_API_ROUTES.length
  );
  for (const [path] of routeActions) {
    expect(portalApiRoute(path, 'POST')).toEqual({
      methods: ['POST'],
      path,
    });
    expect(portalApiRoute(path, 'GET')).toBeUndefined();
  }
});

test('dependency file dispatch validates strict bodies and preserves reviewed result envelopes', async () => {
  const calls = [];
  const services = servicesFor(calls);
  const responses = await Promise.all(
    routeActions.map(([path, , body]) =>
      dispatch(services, path, body, { 'x-setu-source': 'ui' })
    )
  );
  await Promise.all(
    responses.map(async (response, index) => {
      const [, action] = routeActions[index];
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        state: 'prepared',
      });
      expect(calls.find((call) => call.action === action)).toMatchObject({
        action,
        input: { name: 'topic', repo: 'r', source: 'ui' },
      });
    })
  );
  expect(calls).toHaveLength(routeActions.length);
  expect(calls[1].input).toMatchObject({
    confirmation: digest,
    planId: digest,
  });
});

test('dependency file dispatch rejects path and unrecognized fields before calling services', async () => {
  const calls = [];
  const services = servicesFor(calls);
  const response = await dispatch(services, '/api/dependency-sharing/prepare', {
    name: 'topic',
    path: '/tmp/checkout',
    repo: 'r',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  expect(calls).toHaveLength(0);

  const internalRecoveryFlag = await dispatch(
    services,
    '/api/dependency-sharing/recover',
    {
      name: 'topic',
      operationId: digest,
      repo: 'r',
      setupRecoveryComplete: true,
    }
  );
  expect(internalRecoveryFlag.status).toBe(400);
  expect(await internalRecoveryFlag.json()).toMatchObject({
    code: 'DEPENDENCY_FILE_INPUT_INVALID',
    ok: false,
  });
  expect(calls).toHaveLength(0);

  const bodySource = await dispatch(
    services,
    '/api/dependency-sharing/prepare',
    { name: 'topic', repo: 'r', source: 'mcp' },
    { 'x-setu-source': 'ui' }
  );
  expect(bodySource.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('dependency file apply and release require the exact confirmation identity', async () => {
  const calls = [];
  const services = servicesFor(calls);
  const apply = await dispatch(services, '/api/dependency-sharing/apply', {
    confirmation: 'b'.repeat(64),
    name: 'topic',
    planId: digest,
    repo: 'r',
  });
  expect(apply.status).toBe(400);
  const release = await dispatch(services, '/api/dependency-sharing/release', {
    confirmation: 'b'.repeat(64),
    name: 'topic',
    releaseId: digest,
    repo: 'r',
  });
  expect(release.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('dependency file dispatch reports a missing portal service without claiming success', async () => {
  const response = await dispatch({}, '/api/dependency-sharing/prepare', {
    name: 'topic',
    repo: 'r',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: 'DEPENDENCY_FILE_SERVICE_UNAVAILABLE',
    ok: false,
  });
});
