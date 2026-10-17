import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PORTAL_API_ROUTES } from './portal-routes.js';

const portalRouteTablePattern =
  /<!-- PORTAL_API_ROUTES_START -->([\s\S]*?)<!-- PORTAL_API_ROUTES_END -->/;

const routes = (rows) =>
  rows.flatMap(({ methods, path }) =>
    methods.map((method) => `${method} ${path}`)
  );

function documentedRoutes(markdown) {
  const match = markdown.match(portalRouteTablePattern);
  if (!match) {
    throw new Error('AGENTS.md has no marked portal route table');
  }

  const rows = [...match[1].matchAll(/^\| `([A-Z]+)` \| `([^`]+)` \|/gm)].map(
    ([, method, path]) => `${method} ${path}`
  );
  const duplicates = rows.filter((row, index) => rows.indexOf(row) !== index);
  expect(duplicates).toEqual([]);
  return rows;
}

test('AGENTS.md documents every exported portal API method and path exactly once', () => {
  const actual = routes(PORTAL_API_ROUTES).sort();
  const documented = documentedRoutes(
    readFileSync(new URL('./AGENTS.md', import.meta.url), 'utf8')
  ).sort();

  expect(documented).toEqual(actual);
  expect(documented).toContain('GET /api/mcp/oauth/callback/:serverId');
});
