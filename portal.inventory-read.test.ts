import { expect, test } from 'bun:test';
import {
  inventoryResponse,
  parseWorkspaceInventory,
} from './portal/inventory-read';

const row = (overrides: Record<string, unknown> = {}) => ({
  active: null,
  branch: 'feat/example',
  detached: false,
  discovery: 'ready',
  head: 'abc123',
  id: 'app:/work/app/feat/example',
  key: null,
  lastPortalActivityAt: null,
  lastUsedAt: null,
  linked: true,
  locked: false,
  name: null,
  operation: null,
  owner: null,
  path: '/work/app/feat/example',
  port: null,
  presence: 'present',
  prunable: false,
  registered: false,
  repo: 'app',
  review: {
    reasons: ['Not registered with Setu; inspect this existing checkout.'],
    requiredGates: ['ignored-data'],
  },
  ...overrides,
});
const inventory = (overrides: Record<string, unknown> = {}) => ({
  checkedAt: 1000,
  counts: {
    linked: null,
    missing: 0,
    observedLinked: 1,
    registered: 0,
    unregistered: 1,
  },
  repositories: [
    { checkedAt: 1000, error: null, repo: 'app', state: 'ready' },
    {
      checkedAt: 1000,
      error: 'Git worktree discovery unavailable',
      repo: 'other',
      state: 'unknown',
    },
  ],
  reviewGates: [{ id: 'ignored-data', label: 'Inspect ignored files.' }],
  rows: [row()],
  state: 'partial',
  ...overrides,
});

test('an unknown linked total and unobserved runtime stay null, never zero or stopped', () => {
  const value = inventory();
  const parsed = parseWorkspaceInventory(value);
  expect(parsed).toBe(value);
  expect(parsed.counts.linked).toBeNull();
  expect(parsed.rows[0].active).toBeNull();
});

test('malformed or partial payloads never become an empty inventory', () => {
  for (const value of [
    null,
    [],
    '<!doctype html>',
    { error: 'failed', ok: false },
    inventory({ rows: undefined }),
    inventory({ state: 'empty' }),
    inventory({ counts: { ...inventory().counts, missing: -1 } }),
    inventory({ counts: { ...inventory().counts, linked: 'unknown' } }),
    inventory({ repositories: [{ repo: 'app', state: 'ready' }] }),
    inventory({ reviewGates: [{ id: 'ignored-data' }] }),
    inventory({ rows: [row({ active: 'unknown' })] }),
    inventory({ rows: [row({ presence: 'gone' })] }),
    inventory({ rows: [row({ review: { reasons: 'inspect' } })] }),
    inventory({ rows: [row({ operation: { kind: 'remove' } })] }),
  ]) {
    expect(() => parseWorkspaceInventory(value)).toThrow();
  }
});

test('an older running portal is unavailable, while other failures are read errors', () => {
  expect(inventoryResponse(404, null)).toEqual({ kind: 'unavailable' });
  expect(() => inventoryResponse(500, { error: 'failed', ok: false })).toThrow(
    'Inventory read failed'
  );
  expect(() => inventoryResponse(200, { rows: [] })).toThrow();
  const value = inventory();
  expect(inventoryResponse(200, value)).toEqual({
    inventory: value as never,
    kind: 'ready',
  });
});

// Contract check against the backend module, so UI validation cannot drift from it.
test('the backend inventory payload passes UI validation, including a failed repository', async () => {
  const { createWorkspaceInventory } = await import('./workspace-inventory.js');
  const record = (path: string, branch: string | null) =>
    [
      `worktree ${path}`,
      `HEAD ${'a'.repeat(40)}`,
      branch ? `branch refs/heads/${branch}` : 'detached',
      '',
      '',
    ].join('\0');
  const backend = createWorkspaceInventory({
    readRegistry: async () => ({
      projects: [
        { repo: 'r', repoDir: '/workspace/r.git' },
        { repo: 'broken', repoDir: '/workspace/broken.git' },
      ],
      registrations: [
        {
          key: 'r/main',
          name: 'main',
          path: '/workspace/r/main',
          port: 3000,
          repo: 'r',
        },
        {
          key: 'broken/main',
          name: 'main',
          path: '/workspace/broken/main',
          port: 3100,
          repo: 'broken',
        },
      ],
    }),
    run: async (command: string[]) =>
      command.includes('/workspace/broken.git')
        ? { code: 128, stdout: '', timedOut: false, truncated: false }
        : {
            code: 0,
            stdout:
              record('/workspace/r/main', 'main') +
              record('/elsewhere/detached', null),
            timedOut: false,
            truncated: false,
          },
    statPath: async () => ({ isDirectory: () => true }),
  });
  const parsed = parseWorkspaceInventory(await backend.read());
  expect(parsed.state).toBe('partial');
  expect(parsed.counts.linked).toBeNull();
  expect(parsed.rows.some((r) => !r.registered && r.detached)).toBe(true);
  expect(parsed.rows.some((r) => r.discovery === 'unknown')).toBe(true);
});
