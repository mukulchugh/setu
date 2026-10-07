import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedCacheCatalog } from './shared-cache-catalog.js';

test('catalogs configured stores and caches once with known consumers without scanning home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-cache-catalog-'));
  try {
    const store = join(root, 'store');
    const downloads = join(root, 'downloads');
    mkdirSync(store);
    mkdirSync(downloads);
    const catalog = createSharedCacheCatalog({
      readConfig: async () => ({
        dependencySharing: {
          storeRoot: store,
        },
      }),
      readDependencyViews: async () => ({
        consumers: {
          '/work/a/main': { checkout: '/work/a/main', linkerMode: 'isolated' },
          '/work/b/main': { checkout: '/work/b/main', linkerMode: 'isolated' },
        },
      }),
      readRegistry: async () => [
        {
          caches: [{ kind: 'download-cache', path: downloads }],
          checkout: '/work/a/main',
        },
        {
          caches: [{ kind: 'download-cache', path: downloads }],
          checkout: '/work/b/main',
        },
      ],
    });
    const result = await catalog.list();
    expect(result.ok).toBe(true);
    expect(result.stores).toHaveLength(2);
    expect(
      result.stores.find((row) => row.path === realpathSync(store))
    ).toMatchObject({
      consumers: ['/work/a/main', '/work/b/main'],
      incomplete: false,
      kind: 'package-store',
    });
    expect(
      result.stores.find((row) => row.path === realpathSync(downloads))
    ).toMatchObject({
      consumers: ['/work/a/main', '/work/b/main'],
      incomplete: false,
      kind: 'download-cache',
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('catalog keeps an unreadable configured cache and marks consumers incomplete', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({
      sharedCaches: [{ kind: 'task-cache', path: '/configured/task-cache' }],
    }),
    readRegistry: async () => [],
    realpathPath: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  });
  await expect(catalog.list()).resolves.toEqual({
    ok: true,
    stores: [
      {
        consumers: [],
        incomplete: true,
        kind: 'task-cache',
        path: '/configured/task-cache',
      },
    ],
  });
});
