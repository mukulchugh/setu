import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceState } from './workspace-state.js';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-dependency-state-'));
  const workspaceRoot = join(root, 'workspace');
  fs.mkdirSync(join(workspaceRoot, 'project', 'topic'), { recursive: true });
  return {
    documentPath: join(workspaceRoot, '.setu-dependency-files.json'),
    root,
    state: createWorkspaceState({
      configPath: join(root, 'setu.json'),
      setuDir: root,
      workspaceRoot,
    }),
    workspaceRoot,
  };
}

function summary() {
  return {
    checkoutIdentity: {
      admin: { birthtimeNs: '6', dev: '2', ino: '7' },
      adminPath: '/tmp/workspace/project.git/worktrees/topic',
      checkout: { birthtimeNs: '1', dev: '2', ino: '3' },
      checkoutPath: '/tmp/workspace/project/topic',
      known: true,
      repository: { birthtimeNs: '4', dev: '2', ino: '5' },
      repositoryPath: '/tmp/workspace/project.git',
    },
    completedFiles: 0,
    createdAt: 100,
    id: hash('plan'),
    inputDigest: hash('inputs'),
    logicalCloneBytes: 20,
    mode: 'hoisted-cow',
    name: 'topic',
    physicalSavingsBytes: null,
    planId: hash('plan'),
    repo: 'project',
    retainedOriginalFiles: 0,
    state: 'prepared',
    storeIdentity: {
      device: '7',
      executable: '/tmp/bin/bun',
      mountPath: '/tmp',
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      root: '/tmp/store',
      version: '1.3.14',
    },
    totalFiles: 2,
    updatedAt: 100,
    version: 1,
  };
}

function withOverrides(value, overrides) {
  return Object.fromEntries([
    ...Object.entries(value),
    ...Object.entries(overrides),
  ]);
}

test('dependencyFiles has a passive versioned initial value and leaves legacy documents alone', () => {
  const fx = fixture();
  try {
    expect(fx.state.read('dependencyFiles')).toEqual({
      operations: {},
      version: 1,
      views: {},
    });
    expect(fs.existsSync(fx.documentPath)).toBe(false);
    expect(fx.state.read('dependencyViews')).toEqual({});
    expect(fx.state.read('config')).toEqual({});
  } finally {
    fs.rmSync(fx.root, { force: true, recursive: true });
  }
});

test('dependencyFiles accepts exact summaries and writes the document privately', async () => {
  const fx = fixture();
  try {
    const record = summary();
    const result = await fx.state.update('dependencyFiles', (current) => ({
      ...current,
      operations: { ...current.operations, [record.id]: record },
      views: { 'project/topic': record },
    }));
    expect(result).toMatchObject({
      committed: true,
      reconciled: true,
      status: 'committed',
    });
    expect(fx.state.read('dependencyFiles')).toEqual({
      operations: { [record.id]: record },
      version: 1,
      views: { 'project/topic': record },
    });
    expect(fs.statSync(fx.documentPath).mode % 0o1000).toBe(0o600);
  } finally {
    fs.rmSync(fx.root, { force: true, recursive: true });
  }
});

test('unknown versions, malformed ids, extra data and inconsistent summaries fail closed', () => {
  const fx = fixture();
  const base = summary();
  const invalidDocuments = [
    { operations: {}, version: 2, views: {} },
    { operations: { stale: base }, version: 1, views: {} },
    {
      operations: {
        [base.id]: withOverrides(base, { id: 'f'.repeat(64) }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, { planId: 'e'.repeat(64) }),
      },
      version: 1,
      views: {},
    },
    {
      operations: { [base.id]: withOverrides(base, { state: 'done' }) },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, { completedFiles: 3 }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, { state: 'completed' }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, {
          completedFiles: 2,
          retainedOriginalFiles: 1,
          state: 'released',
        }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, { physicalSavingsBytes: 10 }),
      },
      version: 1,
      views: {},
    },
    {
      operations: { [base.id]: withOverrides(base, { unexpected: true }) },
      version: 1,
      views: {},
    },
    { operations: {}, version: 1, views: { wrong: base } },
    {
      operations: { [base.id]: withOverrides(base, { repo: '../outside' }) },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, {
          checkoutIdentity: { checkoutPath: 'relative', known: true },
        }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, {
          storeIdentity: { nested: { bad: Number.MAX_SAFE_INTEGER + 1 } },
        }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, {
          checkoutIdentity: withOverrides(base.checkoutIdentity, {
            checkout: withOverrides(base.checkoutIdentity.checkout, {
              ino: 3,
            }),
          }),
        }),
      },
      version: 1,
      views: {},
    },
    {
      operations: {
        [base.id]: withOverrides(base, {
          storeIdentity: withOverrides(base.storeIdentity, { device: 7 }),
        }),
      },
      version: 1,
      views: {},
    },
    { extra: 'refused', operations: {}, version: 1, views: {} },
  ];
  try {
    for (const value of invalidDocuments) {
      fs.writeFileSync(fx.documentPath, `${JSON.stringify(value)}\n`);
      expect(() => fx.state.read('dependencyFiles')).toThrow(
        expect.objectContaining({ code: 'STATE_CORRUPT' })
      );
    }
  } finally {
    fs.rmSync(fx.root, { force: true, recursive: true });
  }
});

test('a failed dependencyFiles update never repairs malformed state or its mode', async () => {
  const fx = fixture();
  try {
    const corrupt = '{"version":1,"operations":{"bad":{}},"views":{}}\n';
    fs.writeFileSync(fx.documentPath, corrupt, { mode: 0o600 });
    const before = fs.readFileSync(fx.documentPath);
    await expect(
      fx.state.update('dependencyFiles', () => ({
        operations: {},
        version: 1,
        views: {},
      }))
    ).rejects.toMatchObject({ code: 'STATE_CORRUPT', committed: false });
    expect(fs.readFileSync(fx.documentPath)).toEqual(before);
  } finally {
    fs.rmSync(fx.root, { force: true, recursive: true });
  }
});
