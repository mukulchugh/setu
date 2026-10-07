import { expect, test } from 'bun:test';
import { PORTAL_API_ROUTES, portalApiRoute } from './portal-routes.js';

test('portal API route manifest has one explicit method entry for every public API path', () => {
  expect(new Set(PORTAL_API_ROUTES.map((route) => route.path)).size).toBe(
    PORTAL_API_ROUTES.length
  );
  expect(portalApiRoute('/api/worktrees', 'GET')).toEqual({
    methods: ['GET'],
    path: '/api/worktrees',
  });
  expect(portalApiRoute('/api/worktrees', 'POST')).toBeUndefined();
  expect(portalApiRoute('/api/operations', 'GET')).toEqual({
    methods: ['GET'],
    path: '/api/operations',
  });
  expect(portalApiRoute('/api/mcp/oauth/callback/example', 'GET')).toEqual({
    methods: ['GET'],
    path: '/api/mcp/oauth/callback/:serverId',
  });
  expect(
    portalApiRoute('/api/mcp/oauth/callback/example', 'POST')
  ).toBeUndefined();
});
