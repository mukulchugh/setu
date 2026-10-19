import { expect, test } from 'bun:test';
import { createLinksRuntime } from './links-runtime.js';
import { dispatchPortalResourceRoute } from './portal-resource-services.js';
import { PORTAL_API_ROUTES } from './portal-routes.js';

const PROJECT_OR_INDEX = /project(?!ion\/status)|index/;
const HISTORY_ROUTES = {
  'GET /api/links/associations': 'linksAssociations',
  'GET /api/links/associations/preview': 'linksAssociationPreview',
  'GET /api/links/evidence/preview': 'linksEvidencePreview',
  'GET /api/links/projection/status': 'linksProjectionStatus',
  'GET /api/links/recovery': 'linksRecovery',
  'POST /api/links/associations/approve': 'linksAssociationApprove',
  'POST /api/links/associations/revoke': 'linksAssociationRevoke',
  'POST /api/links/evidence/attach': 'linksEvidenceAttach',
};

function recordingServices() {
  const calls = [];
  const services = Object.fromEntries(
    Object.values(HISTORY_ROUTES).map((action) => [
      action,
      (input) => {
        calls.push({ action, input });
        return Promise.resolve({ ok: true });
      },
    ])
  );
  return { calls, services };
}

test('the history routes are registered exactly once each, and none can start the projection', () => {
  const registered = PORTAL_API_ROUTES.filter((route) =>
    Object.keys(HISTORY_ROUTES).includes(`${route.methods[0]} ${route.path}`)
  );
  expect(registered).toHaveLength(Object.keys(HISTORY_ROUTES).length);
  // Projection and indexing are explicit commands, never a route.
  expect(
    PORTAL_API_ROUTES.filter(
      (route) =>
        PROJECT_OR_INDEX.test(route.path) && route.path.includes('links')
    )
  ).toEqual([]);
});

test('each history route reaches its service action: GET with the query, POST with the body and its source', async () => {
  for (const [route, action] of Object.entries(HISTORY_ROUTES)) {
    const [method, path] = route.split(' ');
    const { calls, services } = recordingServices();
    const url = `http://localhost${path}${method === 'GET' ? '?runId=run-1&limit=5' : ''}`;
    // biome-ignore lint/performance/noAwaitInLoops: One route at a time keeps the recording unambiguous.
    const response = await dispatchPortalResourceRoute(
      services,
      new Request(url, {
        body:
          method === 'POST' ? JSON.stringify({ runId: 'run-1' }) : undefined,
        headers: { 'x-setu-source': 'ui' },
        method,
      })
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe(action);
    expect(calls[0].input).toMatchObject(
      method === 'GET'
        ? { limit: '5', runId: 'run-1' }
        : { runId: 'run-1', source: 'ui' }
    );
  }
});

test('with Links history unavailable a route is simply not served', async () => {
  for (const route of Object.keys(HISTORY_ROUTES)) {
    const [method, path] = route.split(' ');
    // biome-ignore lint/performance/noAwaitInLoops: Sequential for clarity.
    const response = await dispatchPortalResourceRoute(
      {},
      new Request(`http://localhost${path}`, {
        body: method === 'POST' ? '{}' : undefined,
        method,
      })
    );
    expect(response).toBeNull();
  }
});

test('the runtime composes every history action and nothing for agents', () => {
  const runtime = createLinksRuntime({
    enginePath: '/nonexistent/setu-links',
    resolveTarget: () => null,
    root: '/nonexistent/links',
    sessions: { list: async () => ({ ok: true, sessions: [] }) },
    spansRoot: '/nonexistent/spans',
  });
  for (const action of Object.values(HISTORY_ROUTES)) {
    expect(typeof runtime[action]).toBe('function');
  }
});
