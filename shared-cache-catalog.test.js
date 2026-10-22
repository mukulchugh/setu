import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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

test('catalog canonicalizes checkout aliases before publishing consumers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'setu-cache-catalog-alias-'));
  try {
    const checkout = join(root, 'checkout');
    const alias = join(root, 'checkout-alias');
    const store = join(root, 'store');
    mkdirSync(checkout);
    mkdirSync(store);
    symlinkSync(checkout, alias);
    const catalog = createSharedCacheCatalog({
      readConfig: async () => ({
        dependencySharing: { storeRoot: store },
      }),
      readDependencyViews: async () => ({
        consumers: {
          alias: { checkout: alias },
          original: { checkout },
        },
      }),
      readRegistry: async () => [
        { caches: [{ kind: 'package-store', path: store }], checkout: alias },
      ],
    });

    const result = await catalog.list();
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0]).toMatchObject({
      consumers: [realpathSync(checkout)],
      incomplete: false,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('catalog refuses a relative configured store root instead of resolving it from cwd', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({ dependencySharing: { storeRoot: './cache' } }),
    readRegistry: async () => [],
  });
  await expect(catalog.list()).rejects.toThrow(
    'Shared cache storeRoot must be an absolute path'
  );
});

test('catalog refuses malformed explicit shared-cache rows instead of omitting them', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({
      sharedCaches: [{ kind: 'download-cache', path: './downloads' }],
    }),
    readRegistry: async () => [],
  });
  await expect(catalog.list()).rejects.toThrow(
    'Shared cache entries must have an absolute path and valid kind'
  );
});

test('catalog marks a store incomplete when configured consumer metadata is malformed', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({
      dependencySharing: { storeRoot: '/configured/store' },
    }),
    readDependencyViews: async () => ({
      consumers: {
        known: { checkout: '/work/known' },
        unknown: { checkout: '../relative-checkout' },
      },
    }),
    readRegistry: async () => [],
    realpathPath: async (path) => path,
  });
  await expect(catalog.list()).resolves.toMatchObject({
    ok: true,
    stores: [
      {
        consumers: ['/work/known'],
        incomplete: true,
      },
    ],
  });
});

test('catalog retains unreadable consumer metadata without certifying a complete inventory', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({
      dependencySharing: { storeRoot: '/configured/store' },
    }),
    readDependencyViews: async () => ({
      consumers: { one: { checkout: '/work/denied' } },
    }),
    readRegistry: async () => [],
    realpathPath: (path) => {
      if (path === '/work/denied') {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return path;
    },
  });
  await expect(catalog.list()).resolves.toMatchObject({
    ok: true,
    stores: [{ consumers: ['/work/denied'], incomplete: true }],
  });
});

test('catalog retains hoisted store consumers separately from isolated consumer records', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({
      dependencySharing: { storeRoot: '/stores/current' },
    }),
    readDependencyFiles: async () => ({
      version: 1,
      views: {
        first: {
          checkoutIdentity: { checkoutPath: '/work/hoisted' },
          mode: 'hoisted-cow',
          state: 'completed',
          storeIdentity: { root: '/stores/current' },
        },
        old: {
          checkoutIdentity: { checkoutPath: '/work/partial' },
          mode: 'hoisted-cow',
          state: 'partial',
          storeIdentity: { root: '/stores/previous' },
        },
      },
    }),
    readDependencyViews: async () => ({
      consumers: { one: { checkout: '/work/isolated' } },
    }),
    readRegistry: async () => [],
    realpathPath: async (path) => path,
  });
  await expect(catalog.list()).resolves.toMatchObject({
    stores: [
      {
        consumers: ['/work/hoisted', '/work/isolated'],
        incomplete: false,
        path: '/stores/current',
      },
      {
        consumers: ['/work/partial'],
        incomplete: true,
        path: '/stores/previous',
      },
    ],
  });
});

test('catalog refuses corrupted hoisted view paths instead of calling the inventory complete', async () => {
  const catalog = createSharedCacheCatalog({
    readConfig: async () => ({}),
    readDependencyFiles: async () => ({
      version: 1,
      views: {
        bad: {
          checkoutIdentity: { checkoutPath: '../escape' },
          mode: 'hoisted-cow',
          state: 'completed',
          storeIdentity: { root: '/stores/one' },
        },
      },
    }),
    readRegistry: async () => [],
  });
  await expect(catalog.list()).rejects.toThrow(
    'Hoisted dependency view metadata is invalid'
  );
});
