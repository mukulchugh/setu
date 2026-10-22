import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDependencyFileJournal } from './dependency-file-journal.js';
import { dependencyObjectKey } from './dependency-file-object.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutKeys(value, excluded) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.includes(key))
  );
}

function withOverrides(value, overrides) {
  return Object.fromEntries([
    ...Object.entries(value),
    ...Object.entries(overrides),
  ]);
}

function stableReviewValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableReviewValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'atimeNs')
        .map(([key, entry]) => [key, stableReviewValue(entry)])
    );
  }
  return value;
}

function fingerprint(
  relativePath,
  { inode = '100', size = 12, content = 'file' } = {}
) {
  const attrs = [
    { digest: hash('fixture provenance'), name: 'com.apple.provenance' },
  ];
  const mode = 0o10_0644;
  const metadataHash = hash(
    canonical({ attributes: attrs, gid: 20, mode, mtimeNs: '123', uid: 501 })
  );
  const contentHash = hash(content);
  return {
    atimeNs: '789',
    attributes: attrs,
    contentHash,
    ctimeNs: '456',
    device: '7',
    gid: 20,
    identityHash: hash(
      `${relativePath}:${inode}:${contentHash}:${metadataHash}`
    ),
    inode,
    metadataHash,
    mode,
    mtimeNs: '123',
    relativePath,
    size,
    uid: 501,
  };
}

function makePlan(fx, { count = 1, createdAt = 1000, version = 1 } = {}) {
  const files = Array.from({ length: count }, (_, index) => {
    const relativePath = `node_modules/pkg-${index}/index.js`;
    const fileFingerprint = fingerprint(relativePath, {
      content: `pkg-${index}`,
      inode: String(100 + index),
    });
    return {
      fingerprint: fileFingerprint,
      index,
      objectKey: dependencyObjectKey(fileFingerprint, version),
      relativePath,
      temporaryRelativePath: `node_modules/pkg-${index}/.index.js.setu-${index}`,
    };
  });
  const plan = {
    checkoutIdentity: {
      admin: { birthtimeNs: '3', dev: '7', ino: '32' },
      adminPath: `${fx.checkout}/.git/worktrees/topic`,
      checkout: { birthtimeNs: '1', dev: '7', ino: '30' },
      checkoutPath: fx.checkout,
      known: true,
      repository: { birthtimeNs: '2', dev: '7', ino: '31' },
      repositoryPath: `${fx.root}/project.git`,
    },
    createdAt,
    files,
    head: 'a'.repeat(40),
    id: '',
    inputDigest: hash('inputs'),
    lockfileHash: hash('lockfile'),
    logicalCloneBytes: files.reduce(
      (sum, file) => sum + file.fingerprint.size,
      0
    ),
    mode: 'hoisted-cow',
    name: 'topic',
    physicalSavingsBytes: null,
    repo: 'project',
    skipped: [],
    storeIdentity: {
      device: '7',
      executable: '/usr/local/bin/bun',
      mountPath: fx.root,
      namespace: 'hoisted/darwin-arm64-bun-1.3.14',
      root: fx.storeRoot,
      version: '1.3.14',
    },
    version,
  };
  const payload = withoutKeys(plan, ['id', 'createdAt']);
  plan.id = hash(canonical(stableReviewValue(payload)));
  return plan;
}

function fixture({ now = () => 2000, state: existingState } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'setu-dependency-journal-'))
  );
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const checkout = join(workspaceRoot, 'project', 'topic');
  const storeRoot = join(root, 'private-store', 'darwin-arm64-bun-1.3.14');
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(storeRoot, { mode: 0o700, recursive: true });
  fs.chmodSync(storeRoot, 0o700);
  const state =
    existingState ??
    createWorkspaceState({
      configPath: join(root, 'setu.json'),
      setuDir: root,
      workspaceRoot,
    });
  let counter = 0;
  const journal = createDependencyFileJournal({
    now,
    randomId: () => {
      counter += 1;
      return `fixture-random-${counter}`;
    },
    state,
    storeRoot,
  });
  return {
    checkout,
    journal,
    root,
    state,
    storeRoot,
    workspaceRoot,
  };
}

function stagedFingerprint(
  planFile,
  relativePath = planFile.temporaryRelativePath
) {
  const value = fingerprint(relativePath, {
    content: `pkg-${planFile.index}`,
    inode: String(Number(planFile.fingerprint.inode) + 10_000),
    size: planFile.fingerprint.size,
  });
  return withOverrides(value, {
    attributes: structuredClone(planFile.fingerprint.attributes),
    device: planFile.fingerprint.device,
    gid: planFile.fingerprint.gid,
    metadataHash: planFile.fingerprint.metadataHash,
    mode: planFile.fingerprint.mode,
    mtimeNs: planFile.fingerprint.mtimeNs,
    uid: planFile.fingerprint.uid,
  });
}

function retainedFingerprint(planFile) {
  return withOverrides(planFile.fingerprint, {
    ctimeNs: '900',
    identityHash: hash(`retained:${planFile.index}`),
    relativePath: planFile.temporaryRelativePath,
  });
}

function fileRecord(plan, index, phase) {
  const file = plan.files[index];
  if (phase === 'prepared') {
    return { phase };
  }
  if (phase === 'staged') {
    return { phase, stagedFingerprint: stagedFingerprint(file) };
  }
  if (phase === 'swapped' || phase === 'verified' || phase === 'released') {
    return {
      phase,
      retainedFingerprint: retainedFingerprint(file),
      stagedFingerprint: stagedFingerprint(file, file.relativePath),
    };
  }
  throw new Error('unsupported test phase');
}

async function prepareAndBegin(fx, options) {
  const plan = makePlan(fx, options);
  await fx.journal.savePlan(plan);
  const operation = await fx.journal.begin(plan);
  return { operation, plan };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('plan, operation, view and release records remain bound across idempotent retries', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  const firstSaved = await fx.journal.savePlan(plan);
  expect(firstSaved).toEqual(plan);
  const storedPlanPath = join(
    fx.storeRoot,
    'dependency-files',
    'plans',
    `${plan.id}.json`
  );
  expect(fs.statSync(storedPlanPath).mode % 0o1000).toBe(0o600);
  expect(
    fs.statSync(join(fx.storeRoot, 'dependency-files')).mode % 0o1000
  ).toBe(0o700);
  expect(await fx.journal.getPlan(plan.id)).toEqual(plan);

  const operation = await fx.journal.begin(plan);
  expect(operation).toMatchObject({
    id: plan.id,
    logicalCloneBytes: 12,
    name: plan.name,
    physicalSavingsBytes: null,
    planId: plan.id,
    repo: plan.repo,
    state: 'prepared',
    totalFiles: 1,
  });
  expect(await fx.journal.begin({ ...plan, createdAt: 5000 })).toEqual(
    operation
  );
  expect(await fx.journal.getOperation(plan.id)).toEqual(operation);

  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'staged'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'swapped'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'verified'));
  const verified = await fx.journal.finish(plan.id, { state: 'completed' });
  expect(verified).toMatchObject({
    completedFiles: 1,
    retainedOriginalFiles: 1,
    state: 'completed',
  });
  await fx.journal.setView({ name: 'topic', repo: 'project' }, verified);
  expect(await fx.journal.list({ name: 'topic', repo: 'project' })).toEqual({
    operations: [verified],
    views: [verified],
  });
  expect(await fx.journal.list({ repo: 'project' })).toEqual({
    operations: [verified],
    views: [verified],
  });
  expect(await fx.journal.list({ name: 'topic' })).toEqual({
    operations: [verified],
    views: [verified],
  });

  const [checkpoint] = await fx.journal.checkpoints(plan.id);
  const releasePlan = {
    checkoutIdentity: structuredClone(plan.checkoutIdentity),
    createdAt: 3000,
    files: [
      {
        index: 0,
        installedFingerprint: withOverrides(
          structuredClone(checkpoint.stagedFingerprint),
          { atimeNs: '9998' }
        ),
        originalFingerprint: withOverrides(
          structuredClone(checkpoint.retainedFingerprint),
          { atimeNs: '9999' }
        ),
        relativePath: plan.files[0].relativePath,
        temporaryRelativePath: plan.files[0].temporaryRelativePath,
      },
    ],
    id: '',
    inputDigest: plan.inputDigest,
    manifestDigest: hash(canonical(plan)),
    mode: 'hoisted-cow',
    name: plan.name,
    operationId: plan.id,
    planId: plan.id,
    repo: plan.repo,
    storeIdentity: structuredClone(plan.storeIdentity),
    version: 1,
  };
  const payload = withoutKeys(releasePlan, ['id', 'createdAt']);
  releasePlan.id = hash(canonical(stableReviewValue(payload)));
  expect(await fx.journal.saveReleasePlan(releasePlan)).toEqual(releasePlan);
  expect(
    await fx.journal.saveReleasePlan({ ...releasePlan, createdAt: 4000 })
  ).toEqual(releasePlan);
  expect(await fx.journal.getReleasePlan(releasePlan.id)).toEqual(releasePlan);

  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'released'));
  const released = await fx.journal.finish(plan.id, { state: 'released' });
  expect(released).toMatchObject({
    completedFiles: 1,
    retainedOriginalFiles: 0,
    state: 'released',
  });
  expect(await fx.journal.getReleasePlan(releasePlan.id)).toEqual(releasePlan);
});

test('plans validate legacy and stable v2 object keys without changing plan identity rules', async () => {
  const fx = fixture();
  const legacy = makePlan(fx, { version: 1 });
  const stable = makePlan(fx, { version: 2 });

  expect(legacy.files[0].objectKey).toBe(
    hash(
      legacy.files[0].fingerprint.contentHash +
        legacy.files[0].fingerprint.metadataHash
    )
  );
  expect(stable.files[0].objectKey).toBe(
    dependencyObjectKey(stable.files[0].fingerprint, 2)
  );
  expect(stable.id).not.toBe(legacy.id);
  await expect(fx.journal.savePlan(legacy)).resolves.toEqual(legacy);
  await expect(fx.journal.savePlan(stable)).resolves.toEqual(stable);
  await expect(fx.journal.getPlan(legacy.id)).resolves.toEqual(legacy);
  await expect(fx.journal.getPlan(stable.id)).resolves.toEqual(stable);
});

test('unsupported plan versions, forged or mismatched keys, and changed v2 metadata fail closed', async () => {
  const fx = fixture();
  const legacy = makePlan(fx, { version: 1 });
  const stable = makePlan(fx, { version: 2 });
  const reidentify = (plan) => {
    plan.id = hash(
      canonical(stableReviewValue(withoutKeys(plan, ['id', 'createdAt'])))
    );
    return plan;
  };
  const invalidPlans = [
    reidentify({ ...legacy, version: 3 }),
    reidentify({
      ...stable,
      files: stable.files.map((file) => ({
        ...file,
        objectKey: 'f'.repeat(64),
      })),
    }),
    reidentify({
      ...legacy,
      files: legacy.files.map((file) => ({
        ...file,
        objectKey: dependencyObjectKey(file.fingerprint, 2),
      })),
    }),
    reidentify({
      ...stable,
      files: stable.files.map((file) => ({
        ...file,
        objectKey: dependencyObjectKey(file.fingerprint, 1),
      })),
    }),
    reidentify({
      ...stable,
      files: stable.files.map((file) => ({
        ...file,
        fingerprint: { ...file.fingerprint, mode: file.fingerprint.mode + 1 },
      })),
    }),
  ];

  await Promise.all(
    invalidPlans.map((plan) =>
      expect(fx.journal.savePlan(plan)).rejects.toMatchObject({
        code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
      })
    )
  );
  expect(fs.existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);
});

test('reads do not create journal directories and malformed or stale ids refuse before writes', async () => {
  const fx = fixture();
  expect(await fx.journal.getPlan('a'.repeat(64))).toBeNull();
  expect(fs.existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);
  await Promise.all(
    ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)].map((invalid) =>
      expect(fx.journal.getPlan(invalid)).rejects.toMatchObject({
        code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
      })
    )
  );
  expect(fs.existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);

  const plan = makePlan(fx);
  await expect(
    fx.journal.savePlan({ ...plan, id: 'b'.repeat(64) })
  ).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
  });
  await Promise.all(
    [
      '/absolute/file',
      '../outside',
      'node_modules/../outside',
      'node_modules//pkg/file',
      'node_modules/.git/config',
      'node_modules/pkg\\file',
      'node_modules/pkg/./file',
    ].map(async (relativePath) => {
      const bad = makePlan(fx);
      bad.files[0].relativePath = relativePath;
      bad.files[0].fingerprint.relativePath = relativePath;
      bad.files[0].temporaryRelativePath = `${relativePath}.tmp`;
      const payload = withoutKeys(bad, ['id', 'createdAt']);
      bad.id = hash(canonical(payload));
      await expect(fx.journal.savePlan(bad)).rejects.toMatchObject({
        code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
      });
    })
  );
  expect(fs.existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);
});

test('review identity ignores recursive atime reads while persisted manifests retain the first snapshot', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  const first = await fx.journal.savePlan(plan);
  const retried = structuredClone(plan);
  retried.files[0].fingerprint.atimeNs = '987654321';
  retried.id = hash(
    canonical(
      stableReviewValue(
        Object.fromEntries(
          Object.entries(retried).filter(
            ([key]) => !['id', 'createdAt'].includes(key)
          )
        )
      )
    )
  );
  expect(retried.id).toBe(plan.id);
  expect(await fx.journal.savePlan(retried)).toEqual(first);
  expect((await fx.journal.getPlan(plan.id)).files[0].fingerprint.atimeNs).toBe(
    plan.files[0].fingerprint.atimeNs
  );
  expect(await fx.journal.begin(retried)).toMatchObject({ id: plan.id });
});

test('returned plans are recursively frozen and cannot change an operation manifest', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  const operation = await fx.journal.begin(plan);
  const returned = await fx.journal.getPlan(plan.id);
  const operationPath = join(
    fx.storeRoot,
    'dependency-files',
    'operations',
    `${plan.id}.json`
  );
  const manifestBefore = fs.readFileSync(operationPath);

  expect(() => {
    returned.files[0].fingerprint.contentHash = hash('mutated');
  }).toThrow(TypeError);
  expect(() => {
    returned.storeIdentity.root = '/tmp/changed-store';
  }).toThrow(TypeError);
  expect(fs.readFileSync(operationPath)).toEqual(manifestBefore);
  expect(await fx.journal.getOperation(plan.id)).toEqual(operation);
  await expect(
    fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'))
  ).resolves.toMatchObject({ phase: 'prepared' });
});

test('full checkout and central store identities reject malformed paths before creating records', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  const invalidPlans = [
    {
      ...plan,
      checkoutIdentity: {
        ...plan.checkoutIdentity,
        adminPath: '/tmp/../outside',
      },
    },
    {
      ...plan,
      storeIdentity: { ...plan.storeIdentity, device: 7 },
    },
    {
      ...plan,
      storeIdentity: {
        ...plan.storeIdentity,
        root: `${fx.storeRoot}/../outside`,
      },
    },
    {
      ...plan,
      storeIdentity: { ...plan.storeIdentity, namespace: 'isolated' },
    },
  ];
  await Promise.all(
    invalidPlans.map(async (candidate) => {
      const payload = withoutKeys(candidate, ['id', 'createdAt']);
      candidate.id = hash(canonical(stableReviewValue(payload)));
      await expect(fx.journal.savePlan(candidate)).rejects.toMatchObject({
        code: 'DEPENDENCY_FILE_JOURNAL_INVALID',
      });
    })
  );
  expect(fs.existsSync(join(fx.storeRoot, 'dependency-files'))).toBe(false);
});

test('plan id collision, malformed stored records and noncanonical paths fail closed', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  const planFile = join(
    fx.storeRoot,
    'dependency-files',
    'plans',
    `${plan.id}.json`
  );
  const stored = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  stored.inputDigest = hash('different inputs');
  fs.writeFileSync(planFile, `${canonical(stored)}\n`, { mode: 0o600 });
  await expect(fx.journal.getPlan(plan.id)).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
  });

  const clean = fixture();
  try {
    const cleanPlan = makePlan(clean);
    await clean.journal.savePlan(cleanPlan);
    const operation = await clean.journal.begin(cleanPlan);
    const operationFile = join(
      clean.storeRoot,
      'dependency-files',
      'operations',
      `${cleanPlan.id}.json`
    );
    const malformed = JSON.parse(fs.readFileSync(operationFile, 'utf8'));
    malformed.summary.storeIdentity = {};
    fs.writeFileSync(operationFile, `${canonical(malformed)}\n`, {
      mode: 0o600,
    });
    await expect(
      clean.journal.getOperation(operation.id)
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
    });
  } finally {
    // afterEach owns the disposable root; this local try keeps the assertion scope clear.
  }
});

test('rejected store roots and symlink journal ancestors receive no failure artifacts', async () => {
  const fx = fixture();
  const external = join(fx.root, 'external');
  fs.mkdirSync(external, { mode: 0o700 });
  const rootLink = join(fx.root, 'store-link');
  fs.symlinkSync(fx.storeRoot, rootLink);
  const linked = createDependencyFileJournal({
    state: fx.state,
    storeRoot: rootLink,
  });
  await expect(linked.savePlan(makePlan(fx))).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_STORE_REFUSED',
  });
  expect(fs.readdirSync(fx.storeRoot)).toEqual([]);

  const childLink = join(fx.storeRoot, 'dependency-files');
  fs.symlinkSync(external, childLink);
  await expect(fx.journal.savePlan(makePlan(fx))).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_STORE_REFUSED',
  });
  expect(fs.readdirSync(external)).toEqual([]);
  expect(fs.readdirSync(fx.storeRoot)).toEqual(['dependency-files']);

  const publicRoot = join(fx.root, 'public-store');
  fs.mkdirSync(publicRoot, { mode: 0o755 });
  fs.chmodSync(publicRoot, 0o755);
  const publicJournal = createDependencyFileJournal({
    state: fx.state,
    storeRoot: publicRoot,
  });
  await expect(
    publicJournal.savePlan(makePlan({ ...fx, storeRoot: publicRoot }))
  ).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_STORE_REFUSED',
  });
  expect(fs.readdirSync(publicRoot)).toEqual([]);
});

test('workspace dependency-file state starts small and corrupt summaries cannot become defaults', async () => {
  const fx = fixture();
  const documentPath = join(fx.workspaceRoot, '.setu-dependency-files.json');
  expect(fx.state.read('dependencyFiles')).toEqual({
    operations: {},
    version: 1,
    views: {},
  });
  expect(fs.existsSync(documentPath)).toBe(false);
  expect(fx.state.read('dependencyViews')).toEqual({});

  fs.writeFileSync(
    documentPath,
    '{"version":1,"operations":{"bad":{}},"views":{}}\n'
  );
  expect(() => fx.state.read('dependencyFiles')).toThrow(
    expect.objectContaining({ code: 'STATE_CORRUPT' })
  );
  await expect(fx.journal.list()).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
  });
});

test('per-file checkpoints keep file manifests out of the small workspace summary', async () => {
  const fx = fixture();
  let rewrittenBytes = 0;
  let rewriteCount = 0;
  const baseUpdate = fx.state.update.bind(fx.state);
  const state = {
    ...fx.state,
    update: (name, mutate) => {
      if (name !== 'dependencyFiles') {
        return baseUpdate(name, mutate);
      }
      return baseUpdate(name, async (current) => {
        const next = await mutate(current);
        const encoded = `${JSON.stringify(next, null, 2)}\n`;
        rewrittenBytes += Buffer.byteLength(encoded);
        rewriteCount += 1;
        return next;
      });
    },
  };
  const journal = createDependencyFileJournal({
    now: () => 2500,
    state,
    storeRoot: fx.storeRoot,
  });
  const plan = makePlan(fx, { count: 48 });
  await journal.savePlan(plan);
  await journal.begin(plan);
  await Promise.all(
    plan.files.map((file) =>
      journal.checkpoint(
        plan.id,
        file.index,
        fileRecord(plan, file.index, 'prepared')
      )
    )
  );

  const document = JSON.parse(
    fs.readFileSync(
      join(fx.workspaceRoot, '.setu-dependency-files.json'),
      'utf8'
    )
  );
  expect(rewriteCount).toBe(49);
  expect(document.operations[plan.id]).not.toHaveProperty('files');
  expect(document.operations[plan.id]).not.toHaveProperty('checkpoints');
  expect(JSON.stringify(document).length).toBeLessThan(3000);
  expect(rewrittenBytes).toBeLessThan(100_000);
  expect((await journal.checkpoints(plan.id)).length).toBe(48);
});

test('a 1000-file manifest stays bounded and checkpoint reads reuse its validated identity', async () => {
  const fx = fixture();
  const plan = makePlan(fx, { count: 1000 });
  const planPath = join(
    fx.storeRoot,
    'dependency-files',
    'plans',
    `${plan.id}.json`
  );
  const originalOpen = fsPromises.open;
  let manifestReads = 0;
  fsPromises.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) !== planPath) {
      return handle;
    }
    let countedRead = false;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') {
          return (...readArgs) => {
            if (!countedRead) {
              manifestReads += 1;
              countedRead = true;
            }
            return target.read(...readArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    await fx.journal.savePlan(plan);
    const { size } = fs.statSync(planPath);
    expect(size).toBeGreaterThan(500_000);
    expect(size).toBeLessThan(3 * 1024 * 1024);
    await fx.journal.begin(plan);
    await Promise.all(
      plan.files
        .slice(0, 24)
        .map((file) =>
          fx.journal.checkpoint(
            plan.id,
            file.index,
            fileRecord(plan, file.index, 'prepared')
          )
        )
    );
    expect(manifestReads).toBeLessThanOrEqual(4);
    const readsBeforeTamper = manifestReads;

    const altered = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    altered.createdAt += 1;
    fs.writeFileSync(planPath, `${canonical(altered)}\n`, { mode: 0o600 });
    await expect(fx.journal.getOperation(plan.id)).rejects.toMatchObject({
      code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
    });
    expect(manifestReads).toBe(readsBeforeTamper);
  } finally {
    fsPromises.open = originalOpen;
  }
});

test('an accepted manifest above 64 MiB is cached across per-file checkpoints', async () => {
  const fx = fixture();
  const plan = makePlan(fx, { count: 4 });
  // A 64 MiB fixture is expensive to serialize repeatedly under the pinned
  // Bun matrix. Repeated valid skipped paths make the real on-disk manifest
  // exceed the former cache cap while staying below the 256 MiB accepted cap.
  plan.skipped = Array.from({ length: 66_000 }, (_, index) => ({
    reason: 'unsupported-file-type',
    relativePath: `node_modules/${String(index).padStart(5, '0')}/${'x'.repeat(1024)}`,
  }));
  plan.id = hash(
    canonical(stableReviewValue(withoutKeys(plan, ['id', 'createdAt'])))
  );
  const planPath = join(
    fx.storeRoot,
    'dependency-files',
    'plans',
    `${plan.id}.json`
  );
  const originalOpen = fsPromises.open;
  let manifestReadPasses = 0;
  fsPromises.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) !== planPath) {
      return handle;
    }
    let countedRead = false;
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') {
          return (...readArgs) => {
            if (!countedRead) {
              manifestReadPasses += 1;
              countedRead = true;
            }
            return target.read(...readArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    await fx.journal.savePlan(plan);
    expect(fs.statSync(planPath).size).toBeGreaterThan(64 * 1024 * 1024);
    expect(fs.statSync(planPath).size).toBeLessThan(256 * 1024 * 1024);
    await fx.journal.begin(plan);
    // Start measuring after save/readback and the first validated cache fill.
    await fx.journal.getPlan(plan.id);
    manifestReadPasses = 0;
    await Promise.all(
      plan.files.map((file) =>
        fx.journal.checkpoint(
          plan.id,
          file.index,
          fileRecord(plan, file.index, 'prepared')
        )
      )
    );
    // The first load validates and caches the immutable manifest; checkpoints
    // still recheck its descriptor/path/inode identity without reparsing it.
    expect(manifestReadPasses).toBe(0);
  } finally {
    fsPromises.open = originalOpen;
  }
}, 30_000);

test('record reads stop at the size limit when a file grows after its initial stat', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  await fx.journal.begin(plan);
  const operationPath = join(
    fx.storeRoot,
    'dependency-files',
    'operations',
    `${plan.id}.json`
  );
  const originalOpen = fsPromises.open;
  let grewRecord = false;
  fsPromises.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path) === operationPath && !grewRecord) {
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return (...readArgs) => {
              if (!grewRecord) {
                grewRecord = true;
                fs.appendFileSync(path, Buffer.alloc(2 * 1024 * 1024));
              }
              return target.read(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    return handle;
  };
  try {
    await expect(fx.journal.getOperation(plan.id)).rejects.toMatchObject({
      code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
      phase: 'record-size',
    });
    expect(grewRecord).toBe(true);
  } finally {
    fsPromises.open = originalOpen;
  }
});

test('checkpoint progress is per-file and nonterminal finish does not rescan all checkpoints', async () => {
  const fx = fixture();
  const plan = makePlan(fx, { count: 32 });
  await fx.journal.savePlan(plan);
  await fx.journal.begin(plan);
  const originalReadFile = fsPromises.readFile;
  let checkpointReads = 0;
  fsPromises.readFile = (path, ...args) => {
    if (String(path).includes(`/checkpoints/${plan.id}/`)) {
      checkpointReads += 1;
    }
    return originalReadFile(path, ...args);
  };
  try {
    await Promise.all(
      plan.files.map((file) =>
        fx.journal.checkpoint(plan.id, file.index, {
          index: file.index,
          phase: 'prepared',
        })
      )
    );
    await fx.journal.finish(plan.id, {
      completedFiles: 0,
      logicalCloneBytes: plan.logicalCloneBytes,
      physicalSavingsBytes: null,
      retainedOriginalFiles: 0,
      state: 'running',
      totalFiles: plan.files.length,
    });
    expect(checkpointReads).toBeLessThanOrEqual(plan.files.length * 3);
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});

test('ambiguous checkpoint and finish writes retain the operation identity and never report completion', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  const started = await fx.journal.begin(plan);
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'staged'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'swapped'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'verified'));
  const baseReplace = fx.state.replaceText.bind(fx.state);
  let makeFinishAmbiguous = true;
  const state = {
    ...fx.state,
    replaceText: async (path, text, options) => {
      const result = await baseReplace(path, text, options);
      if (
        makeFinishAmbiguous &&
        path.endsWith(`/operations/${plan.id}.json`) &&
        text.includes('"state":"completed"')
      ) {
        makeFinishAmbiguous = false;
        return {
          ...result,
          reconciled: false,
          status: 'committed-with-durability-warning',
          warning: {
            code: 'STATE_DURABILITY_UNCONFIRMED',
            phase: 'directory-sync',
          },
        };
      }
      return result;
    },
  };
  const uncertain = createDependencyFileJournal({
    now: () => 3000,
    state,
    storeRoot: fx.storeRoot,
  });
  await expect(
    uncertain.finish(plan.id, { state: 'completed' })
  ).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
    operationId: plan.id,
  });
  const after = await uncertain.getOperation(started.id);
  expect(after).toMatchObject({
    completedFiles: 1,
    id: plan.id,
    retainedOriginalFiles: 1,
    state: 'unknown',
    totalFiles: 1,
  });
  expect(after.state).not.toBe('completed');
});

test('a checkpoint that commits with an unconfirmed durability result remains recoverable as unknown', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  await fx.journal.begin(plan);
  const baseReplace = fx.state.replaceText.bind(fx.state);
  let ambiguous = true;
  const state = {
    ...fx.state,
    replaceText: async (path, text, options) => {
      const result = await baseReplace(path, text, options);
      if (ambiguous && path.endsWith(`/checkpoints/${plan.id}/0.json`)) {
        ambiguous = false;
        return {
          ...result,
          reconciled: false,
          status: 'committed-with-durability-warning',
          warning: {
            code: 'STATE_DURABILITY_UNCONFIRMED',
            phase: 'directory-sync',
          },
        };
      }
      return result;
    },
  };
  const journal = createDependencyFileJournal({
    now: () => 3000,
    state,
    storeRoot: fx.storeRoot,
  });
  await expect(
    journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'))
  ).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_OUTCOME_UNKNOWN',
    operationId: plan.id,
  });
  expect(await journal.getOperation(plan.id)).toMatchObject({
    id: plan.id,
    state: 'unknown',
    totalFiles: 1,
  });
  expect(await journal.checkpoints(plan.id)).toMatchObject([
    { index: 0, operationId: plan.id, phase: 'prepared' },
  ]);
});

test('conflicting checkpoint retries cannot replace prior identities or lower phases', async () => {
  const fx = fixture();
  const { plan } = await prepareAndBegin(fx);
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'staged'));
  await expect(
    fx.journal.checkpoint(plan.id, 0, {
      phase: 'prepared',
    })
  ).rejects.toMatchObject({ code: 'DEPENDENCY_FILE_JOURNAL_CONFLICT' });
  const different = stagedFingerprint(plan.files[0]);
  different.inode = '999999';
  await expect(
    fx.journal.checkpoint(plan.id, 0, {
      phase: 'staged',
      stagedFingerprint: different,
    })
  ).rejects.toMatchObject({ code: 'DEPENDENCY_FILE_JOURNAL_CONFLICT' });
  expect((await fx.journal.checkpoints(plan.id))[0].phase).toBe('staged');
});

test('checkpoint indexes and release intent ids are exact, immutable, and phase-bound', async () => {
  const fx = fixture();
  const { plan } = await prepareAndBegin(fx);
  await expect(
    fx.journal.checkpoint(plan.id, 0, {
      ...fileRecord(plan, 0, 'prepared'),
      index: 1,
    })
  ).rejects.toMatchObject({ code: 'DEPENDENCY_FILE_JOURNAL_CONFLICT' });
  await expect(
    fx.journal.checkpoint(plan.id, 0, {
      phase: 'prepared',
      releasePlanId: hash('release'),
    })
  ).rejects.toMatchObject({ code: 'DEPENDENCY_FILE_JOURNAL_INVALID' });
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'));
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'staged'));
  const swapped = fileRecord(plan, 0, 'swapped');
  await fx.journal.checkpoint(plan.id, 0, swapped);
  const verified = fileRecord(plan, 0, 'verified');
  await fx.journal.checkpoint(plan.id, 0, verified);
  const releasePlanId = hash('release-plan');
  await fx.journal.checkpoint(plan.id, 0, {
    ...verified,
    index: 0,
    releasePlanId,
  });
  await expect(
    fx.journal.checkpoint(plan.id, 0, {
      ...verified,
      releasePlanId: hash('different-release-plan'),
    })
  ).rejects.toMatchObject({ code: 'DEPENDENCY_FILE_JOURNAL_CONFLICT' });
  expect((await fx.journal.checkpoints(plan.id))[0]).toMatchObject({
    phase: 'verified',
    releasePlanId,
  });
});

test('private records with unexpected hard links or modes are refused on read', async () => {
  const fx = fixture();
  const plan = makePlan(fx);
  await fx.journal.savePlan(plan);
  const path = join(
    fx.storeRoot,
    'dependency-files',
    'plans',
    `${plan.id}.json`
  );
  const link = join(fx.root, 'second-link.json');
  fs.linkSync(path, link);
  await expect(fx.journal.getPlan(plan.id)).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_STORE_REFUSED',
  });
});

test('a malformed per-file checkpoint is never treated as absent progress', async () => {
  const fx = fixture();
  const { operation, plan } = await prepareAndBegin(fx);
  await fx.journal.checkpoint(plan.id, 0, fileRecord(plan, 0, 'prepared'));
  const path = join(
    fx.storeRoot,
    'dependency-files',
    'checkpoints',
    operation.id,
    '0.json'
  );
  const malformed = JSON.parse(fs.readFileSync(path, 'utf8'));
  malformed.record.phase = 'done';
  fs.writeFileSync(path, `${canonical(malformed)}\n`, { mode: 0o600 });
  await expect(fx.journal.checkpoints(plan.id)).rejects.toMatchObject({
    code: 'DEPENDENCY_FILE_JOURNAL_CORRUPT',
  });
});
