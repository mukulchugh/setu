import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createSpansIntegrationRuntime } from './spans-integration-runtime.js';
import { createSpansIntegrationState } from './spans-integration-state.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = new Set();
const NOW = 1_800_000_000_000;
const skill =
  '---\nname: setu-spans\ndescription: shared workflow\n---\n# Setu Spans\n';
const updatedSkill = `${skill}\nUpdated for the next release.\n`;
const sha = (value) =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

async function fixture(content = skill) {
  const root = await mkdtemp(
    resolve(await realpath(tmpdir()), 'setu-spans-runtime-')
  );
  roots.add(root);
  const home = resolve(root, 'home');
  const integrationRoot = resolve(home, '.local/share/setu/integrations');
  const source = resolve(
    root,
    'bundle',
    'claude-plugin',
    'skills',
    'setu-spans',
    'SKILL.md'
  );
  await mkdir(home, { mode: 0o700 });
  await mkdir(resolve(home, '.local/share'), { recursive: true });
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, content);
  const manifest = resolve(
    dirname(source),
    '../..',
    '.claude-plugin/plugin.json'
  );
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify({ name: 'setu', version: '0.3.0' }));
  return { home, integrationRoot, root, source };
}

function runtime(f, overrides = {}) {
  return createSpansIntegrationRuntime({
    home: f.home,
    integrationRoot: f.integrationRoot,
    now: () => NOW,
    skillSourcePath: f.source,
    verifyConfirmation: async ({
      confirmation,
      groupDigest,
      previewDigest,
    }) => ({
      groupDigest,
      previewDigest,
      verified:
        confirmation?.token === 'trusted' &&
        confirmation.groupDigest === groupDigest &&
        confirmation.previewDigest === previewDigest,
    }),
    ...overrides,
  });
}

function approved(preview) {
  return {
    confirmation: {
      groupDigest: preview.groupDigest,
      previewDigest: preview.preview.previewDigest,
      token: 'trusted',
    },
    groupDigest: preview.groupDigest,
    preview,
  };
}

function targetPath(home) {
  return resolve(home, '.agents/skills/setu-spans/SKILL.md');
}

async function dispose() {
  await Promise.all(
    [...roots].map((root) => rm(root, { force: true, recursive: true }))
  );
  roots.clear();
}

afterEach(dispose);

test('construction and preview stay read-only; a three-client apply owns one shared file', async () => {
  const f = await fixture();
  const worker = runtime(f);
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
  expect(fs.existsSync(resolve(f.home, '.agents'))).toBe(false);

  const preview = await worker.preview();
  expect(preview).toMatchObject({ ok: true, previewOnly: true });
  expect(preview.artifactPlans).toEqual([
    {
      client: 'codex',
      consumers: ['codex', 'cursor'],
      path: targetPath(f.home),
    },
  ]);
  expect(preview.preview.operations).toEqual([
    expect.objectContaining({
      client: 'codex',
      kind: 'create',
      path: targetPath(f.home),
    }),
  ]);
  expect(preview.clientSources.claude).toMatchObject({
    activation: { enabled: 'unverified', launch: 'unverified' },
    available: true,
    source: 'packaged-plugin',
  });
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
  expect(fs.existsSync(resolve(f.home, '.agents'))).toBe(false);

  const result = await worker.apply(approved(preview));
  expect(result).toMatchObject({ idempotent: false, ok: true });
  expect(result.applied).toHaveLength(1);
  expect(await Bun.file(targetPath(f.home)).text()).toBe(skill);
  expect(fs.existsSync(resolve(f.home, '.claude/skills'))).toBe(false);
  const document = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
  }).read();
  expect(document.records).toHaveLength(1);
  expect(document.records[0]).toMatchObject({
    after: sha(skill),
    client: 'codex',
    operation: 'install',
    status: 'applied',
    target: targetPath(f.home),
  });
  expect(document.records[0].receipt).toMatchObject({
    appliedEvidence: { state: 'observed' },
    content: skill,
    digest: sha(skill),
    version: 'codex-skills-v1',
  });
  expect(await worker.close()).toEqual({ closed: true, ok: true });
});

test('a new preview after apply is idempotent and does not add another receipt', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const initial = await worker.preview();
  expect((await worker.apply(approved(initial))).ok).toBe(true);

  const retry = await worker.preview();
  expect(retry.preview.operations).toEqual([
    expect.objectContaining({ kind: 'no-op', path: targetPath(f.home) }),
  ]);
  const result = await worker.apply(approved(retry));
  expect(result).toMatchObject({ applied: [], idempotent: true, ok: true });
  expect(
    createSpansIntegrationState({ integrationRoot: f.integrationRoot }).read()
      .records
  ).toHaveLength(1);
});

test('an edit after preview is observed and preserved before apply', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const preview = await worker.preview();
  const target = targetPath(f.home);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'user edit');

  const result = await worker.apply(approved(preview));
  expect(result.ok).toBe(false);
  expect([
    'INTEGRATION_PREVIEW_CONFLICT',
    'INTEGRATION_PREVIEW_STALE',
  ]).toContain(result.code);
  expect(await Bun.file(target).text()).toBe('user edit');
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
});

test('apply rejects caller-supplied observations and altered runtime previews', async () => {
  const f = await fixture();
  const worker = runtime(f);
  expect(
    await worker.preview({
      clients: ['codex'],
      observations: [],
      receipts: [],
      targetPath: resolve(f.root, 'outside.md'),
    })
  ).toMatchObject({ code: 'INTEGRATION_INPUT_INVALID', ok: false });

  const preview = await worker.preview({ clients: ['codex'] });
  const altered = structuredClone(preview);
  altered.observations.codex.targetPath = resolve(f.root, 'outside.md');
  expect(await worker.apply(approved(altered))).toMatchObject({
    code: 'INTEGRATION_PREVIEW_UNKNOWN',
    ok: false,
  });
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
  expect(fs.existsSync(resolve(f.home, '.agents'))).toBe(false);
});

test('a changed bundled package invalidates the reviewed apply', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const preview = await worker.preview();
  await writeFile(f.source, updatedSkill);

  expect(await worker.apply(approved(preview))).toMatchObject({
    code: 'INTEGRATION_PREVIEW_STALE',
    ok: false,
  });
  expect(fs.existsSync(targetPath(f.home))).toBe(false);
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
});

test('reconciliation records an effect that completed before its receipt was written', async () => {
  const f = await fixture();
  const target = targetPath(f.home);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(f.integrationRoot), { mode: 0o700 });
  const workspaceState = createWorkspaceState({
    integrationRoot: f.integrationRoot,
  });
  const state = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
    now: () => NOW,
    state: workspaceState,
  });
  await state.beginIntent({
    allowedRoot: resolve(f.home, '.agents/skills'),
    client: 'codex',
    desiredAfter: sha(skill),
    disposition: 'retain',
    expectedBefore: null,
    operation: 'install',
    operationId: 'crashed-after-effect',
    previewDigest: sha('reviewed-preview'),
    target,
  });
  await writeFile(target, skill);

  const worker = runtime(f);
  const recovery = await worker.reconcile();
  expect(recovery).toEqual({
    ok: true,
    reconciled: [{ operationId: 'crashed-after-effect', status: 'applied' }],
  });
  const [row] = state.read().records;
  expect(row).toMatchObject({
    after: sha(skill),
    operationId: 'crashed-after-effect',
    status: 'applied',
  });
  expect(row.receipt).toMatchObject({
    appliedEvidence: { operationId: 'crashed-after-effect', state: 'observed' },
    content: skill,
    digest: sha(skill),
  });
});

test('apply requires a new review after reconciling a pending effect', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const preview = await worker.preview();
  const target = targetPath(f.home);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(f.integrationRoot), { mode: 0o700 });
  const state = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
    state: createWorkspaceState({ integrationRoot: f.integrationRoot }),
  });
  await state.beginIntent({
    allowedRoot: resolve(f.home, '.agents/skills'),
    client: 'codex',
    desiredAfter: sha(skill),
    disposition: 'retain',
    expectedBefore: null,
    operation: 'install',
    operationId: 'apply-after-recovery',
    previewDigest: sha('reviewed-preview'),
    target,
  });
  await writeFile(target, skill);

  expect(await worker.apply(approved(preview))).toMatchObject({
    code: 'INTEGRATION_RECONCILIATION_REQUIRED',
    ok: false,
  });
  expect(await worker.apply(approved(preview))).toMatchObject({
    code: 'INTEGRATION_PREVIEW_UNKNOWN',
    ok: false,
  });
  expect(await Bun.file(target).text()).toBe(skill);
  expect(state.read().records).toHaveLength(1);
  expect(state.read().records[0].status).toBe('applied');
});

test('reconciliation preserves an edit and settles the pending intent as a conflict', async () => {
  const f = await fixture();
  const target = targetPath(f.home);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(dirname(f.integrationRoot), { mode: 0o700 });
  const state = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
    state: createWorkspaceState({ integrationRoot: f.integrationRoot }),
  });
  await state.beginIntent({
    allowedRoot: resolve(f.home, '.agents/skills'),
    client: 'codex',
    desiredAfter: sha(skill),
    disposition: 'retain',
    expectedBefore: null,
    operation: 'install',
    operationId: 'crashed-before-effect',
    previewDigest: sha('reviewed-preview'),
    target,
  });
  await writeFile(target, 'a user edit');

  const worker = runtime(f);
  expect(await worker.reconcile()).toEqual({
    ok: true,
    reconciled: [{ operationId: 'crashed-before-effect', status: 'conflict' }],
  });
  expect(state.read().records[0]).toMatchObject({
    after: sha('a user edit'),
    status: 'conflict',
  });
  expect(await Bun.file(target).text()).toBe('a user edit');
});

test('competing runtime instances serialize and only one applies the reviewed create', async () => {
  const f = await fixture();
  const first = runtime(f);
  const second = runtime(f);
  const [firstPreview, secondPreview] = await Promise.all([
    first.preview(),
    second.preview(),
  ]);
  expect(firstPreview.groupDigest).toBe(secondPreview.groupDigest);

  const results = await Promise.all([
    first.apply(approved(firstPreview)),
    second.apply(approved(secondPreview)),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok).code).toBe(
    'INTEGRATION_PREVIEW_STALE'
  );
  expect(
    createSpansIntegrationState({ integrationRoot: f.integrationRoot })
      .read()
      .records.filter((row) => row.status === 'applied')
  ).toHaveLength(1);
  expect(await Bun.file(targetPath(f.home)).text()).toBe(skill);
});

test('state corruption gates preview and prevents native artifact writes', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const beforeCorruption = await worker.preview();
  await mkdir(dirname(f.integrationRoot), { mode: 0o700 });
  await mkdir(f.integrationRoot, { mode: 0o700 });
  await writeFile(resolve(f.integrationRoot, 'receipts.json'), '{broken');

  const preview = await worker.preview();
  expect(preview).toMatchObject({
    code: 'INTEGRATION_STATE_CORRUPT',
    ok: false,
  });
  expect(await worker.apply(approved(beforeCorruption))).toMatchObject({
    code: 'INTEGRATION_STATE_CORRUPT',
    ok: false,
  });
  expect(fs.existsSync(resolve(f.home, '.agents'))).toBe(false);
});

test('a symlinked native root refuses preview and never writes outside home', async () => {
  const f = await fixture();
  const outside = resolve(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, resolve(f.home, '.agents'));
  const worker = runtime(f);

  expect(await worker.preview()).toMatchObject({
    code: 'PATH_SYMLINK',
    ok: false,
  });
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
});

test('single-client removal remains unsupported without native client settings', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const preview = await worker.preview({
    clients: ['codex', 'cursor'],
    removeClient: 'cursor',
  });
  const result = await worker.apply(approved(preview));
  expect(result).toMatchObject({
    code: 'INTEGRATION_REMOVAL_UNSUPPORTED',
    ok: false,
  });
  expect(fs.existsSync(f.integrationRoot)).toBe(false);
  expect(fs.existsSync(resolve(f.home, '.agents'))).toBe(false);
});

test('shared Codex and Cursor removal names both affected consumers and records absence', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const install = await worker.preview();
  expect((await worker.apply(approved(install))).ok).toBe(true);

  const preview = await worker.preview({
    clients: ['codex', 'cursor'],
    removeSharedArtifact: true,
  });
  expect(preview).toMatchObject({
    ok: true,
    removeSharedArtifact: true,
    sharedArtifactRemoval: {
      affectedClients: ['codex', 'cursor'],
      disposition: 'remove-exact-owned-shared-artifact',
      path: targetPath(f.home),
    },
  });
  expect(preview.artifactPlans).toEqual([
    {
      client: 'codex',
      consumers: ['codex', 'cursor'],
      path: targetPath(f.home),
    },
  ]);
  expect(preview.preview.operations).toEqual([
    {
      client: 'codex',
      digest: sha(skill),
      kind: 'remove',
      path: targetPath(f.home),
      version: 'codex-skills-v1',
    },
  ]);

  const result = await worker.apply(approved(preview));
  expect(result).toMatchObject({
    applied: [
      {
        client: 'codex',
        digest: sha(skill),
        path: targetPath(f.home),
        status: 'removed',
      },
    ],
    ok: true,
  });
  expect(fs.existsSync(targetPath(f.home))).toBe(false);
  const { records } = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
  }).read();
  expect(records.at(-1)).toMatchObject({
    after: null,
    client: 'codex',
    operation: 'remove',
    status: 'applied',
    target: targetPath(f.home),
  });
  expect(records.at(-1).receipt).toBeNull();
  expect(
    await worker.preview({
      clients: ['codex', 'cursor'],
      removeSharedArtifact: true,
    })
  ).toMatchObject({ code: 'INTEGRATION_SHARED_ARTIFACT_NOT_OWNED', ok: false });
});

test('shared removal preserves edited bytes after review', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const install = await worker.preview();
  expect((await worker.apply(approved(install))).ok).toBe(true);
  const preview = await worker.preview({
    clients: ['codex', 'cursor'],
    removeSharedArtifact: true,
  });
  await writeFile(targetPath(f.home), 'user edit after review');

  expect(await worker.apply(approved(preview))).toMatchObject({
    code: 'INTEGRATION_PREVIEW_CONFLICT',
    ok: false,
  });
  expect(await Bun.file(targetPath(f.home)).text()).toBe(
    'user edit after review'
  );
  expect(
    createSpansIntegrationState({ integrationRoot: f.integrationRoot }).read()
      .records
  ).toHaveLength(1);
});

test('an interrupted shared removal reconciles absence without replay', async () => {
  const f = await fixture();
  const target = targetPath(f.home);
  let interruptRemoval = false;
  let interrupted = false;
  const worker = runtime(f, {
    fs: {
      ...fs,
      renameSync(from, to) {
        if (
          !interrupted &&
          interruptRemoval &&
          String(to) === resolve(f.integrationRoot, 'receipts.json') &&
          !fs.existsSync(target)
        ) {
          interrupted = true;
          throw Object.assign(new Error('fixture interruption'), {
            code: 'EIO',
          });
        }
        return fs.renameSync(from, to);
      },
    },
  });
  const install = await worker.preview();
  expect((await worker.apply(approved(install))).ok).toBe(true);
  interruptRemoval = true;
  const preview = await worker.preview({
    clients: ['codex', 'cursor'],
    removeSharedArtifact: true,
  });

  expect(await worker.apply(approved(preview))).toMatchObject({
    code: 'INTEGRATION_STATE_WRITE_FAILED',
    ok: false,
  });
  expect(interrupted).toBe(true);
  expect(fs.existsSync(target)).toBe(false);
  const recovery = await worker.reconcile();
  expect(recovery).toMatchObject({
    ok: true,
    reconciled: [{ status: 'removed' }],
  });
  const row = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
  })
    .read()
    .records.at(-1);
  expect(row).toMatchObject({
    after: null,
    operation: 'remove',
    status: 'applied',
  });
  expect(row.receipt).toBeNull();
});

test('construction and preview treat a missing private-root parent as empty without creating it', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const privateParent = dirname(f.integrationRoot);

  expect(await worker.preview()).toMatchObject({ ok: true, previewOnly: true });
  expect(fs.existsSync(privateParent)).toBe(false);
  const preview = await worker.preview();
  expect((await worker.apply(approved(preview))).ok).toBe(true);
  expect(fs.statSync(privateParent).mode % 0o1000).toBe(0o700);
  expect(fs.existsSync(f.integrationRoot)).toBe(true);
});

test('close waits for in-flight async preview work and rejects later calls', async () => {
  const f = await fixture();
  let entered;
  let release;
  const enteredPromise = new Promise((resolveEntered) => {
    entered = resolveEntered;
  });
  const blocked = new Promise((resolveBlocked) => {
    release = resolveBlocked;
  });
  const worker = runtime(f, {
    readHandshakes: async () => {
      entered();
      await blocked;
      return [];
    },
  });
  const preview = worker.preview();
  await enteredPromise;
  let closed = false;
  const closing = worker.close().then((result) => {
    closed = true;
    return result;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect((await preview).ok).toBe(true);
  expect(await closing).toEqual({ closed: true, ok: true });
  expect(await worker.reconcile()).toMatchObject({
    code: 'INTEGRATION_RUNTIME_CLOSED',
    ok: false,
  });
});

test('an update uses the current owned receipt and retains exact bytes across retries', async () => {
  const f = await fixture();
  const worker = runtime(f);
  const install = await worker.preview();
  expect((await worker.apply(approved(install))).ok).toBe(true);

  await writeFile(f.source, updatedSkill);
  const update = await worker.preview();
  expect(update.preview.operations).toEqual([
    expect.objectContaining({ digest: sha(updatedSkill), kind: 'update' }),
  ]);
  const updated = await worker.apply(approved(update));
  expect(updated.ok).toBe(true);
  expect(await Bun.file(targetPath(f.home)).text()).toBe(updatedSkill);
  const document = createSpansIntegrationState({
    integrationRoot: f.integrationRoot,
  }).read();
  expect(
    document.records.filter((row) => row.status === 'applied')
  ).toHaveLength(2);
  const next = await worker.preview();
  expect(next.preview.operations[0].kind).toBe('no-op');
});
