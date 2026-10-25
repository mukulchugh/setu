import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpansIntegrationState } from './spans-integration-state.js';
import { planSpansIntegrationUpdate } from './spans-integrations.js';
import { createWorkspaceState } from './workspace-state.js';

const roots = [];
const sha = (value) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'setu-integrations-test-'))
  );
  roots.push(root);
  const privateRoot = join(root, 'private');
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  const allowedRoot = join(root, 'client');
  fs.mkdirSync(allowedRoot);
  return {
    allowedRoot,
    privateRoot,
    root,
    target: join(allowedRoot, 'skill.md'),
  };
}
const intent = (f, overrides = {}) => ({
  allowedRoot: f.allowedRoot,
  client: 'codex',
  desiredAfter: sha('managed'),
  disposition: 'retain',
  expectedBefore: null,
  operation: 'install',
  operationId: 'op-1',
  previewDigest: sha('preview'),
  target: f.target,
  ...overrides,
});
const receipt = (f, operationId = 'op-1', overrides = {}) => ({
  appliedEvidence: { operationId, state: 'observed' },
  client: 'codex',
  content: 'managed',
  digest: sha('managed'),
  path: f?.target ?? '/tmp/fixture/skill.md',
  version: '1',
  ...overrides,
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('construction and missing reads do no I/O; receipts are private and outside workspace/archive', async () => {
  const f = fixture();
  const missingRoot = join(f.root, 'not-created');
  const store = createSpansIntegrationState({ integrationRoot: missingRoot });
  expect(fs.existsSync(missingRoot)).toBe(false);
  expect(store.read()).toEqual({ records: [], version: 1 });
  expect(fs.existsSync(missingRoot)).toBe(false);
  const real = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  await real.beginIntent(intent(f));
  expect(fs.existsSync(join(f.privateRoot, 'receipts.json'))).toBe(true);
  expect(fs.existsSync(join(f.root, 'receipts.json'))).toBe(false);
  expect(fs.existsSync(join(f.root, '.setu-state.lock'))).toBe(false);
  // biome-ignore lint/suspicious/noBitwiseOperators: File modes are Unix permission fields.
  expect(fs.statSync(join(f.privateRoot, 'receipts.json')).mode & 0o777).toBe(
    0o600
  );
});

test('concurrent instances serialize same-target intents and allow only exact idempotence', async () => {
  const f = fixture();
  const a = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  const b = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  const outcomes = await Promise.allSettled([
    a.beginIntent(intent(f)),
    b.beginIntent(intent(f)),
  ]);
  expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(2);
  expect(a.read().records).toHaveLength(1);
  await expect(
    b.beginIntent(intent(f, { operationId: 'op-2' }))
  ).rejects.toMatchObject({ code: 'INTEGRATION_RECONCILIATION_REQUIRED' });
  await expect(
    b.beginIntent(intent(f, { desiredAfter: sha('different') }))
  ).rejects.toMatchObject({ code: 'INTEGRATION_OPERATION_ID_CONFLICT' });
});

test('reopened pending work stays uncertain; observed user edits conflict and retain before/after', async () => {
  const f = fixture();
  await createSpansIntegrationState({
    integrationRoot: f.privateRoot,
  }).beginIntent(intent(f));
  const reopened = createSpansIntegrationState({
    integrationRoot: f.privateRoot,
  });
  expect(reopened.read().records[0].status).toBe('pending');
  await reopened.reconcileEvidence({
    observedDigest: sha('user edit'),
    operationId: 'op-1',
  });
  expect(reopened.read().records[0]).toMatchObject({
    after: sha('user edit'),
    before: null,
    status: 'conflict',
  });
  await reopened.beginIntent(intent(f, { operationId: 'op-2' }));
});

test('unknown blocks new intents until a matching observed receipt reconciles', async () => {
  const f = fixture();
  const store = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  await store.beginIntent(intent(f));
  await store.settleEvidence({
    evidenceKnown: false,
    observedDigest: null,
    operationId: 'op-1',
  });
  await expect(
    store.beginIntent(intent(f, { operationId: 'op-2' }))
  ).rejects.toMatchObject({ code: 'INTEGRATION_RECONCILIATION_REQUIRED' });
  await store.reconcileEvidence({
    observedDigest: sha('managed'),
    operationId: 'op-1',
    receipt: receipt(f),
  });
  expect(store.read().records[0]).toMatchObject({
    after: sha('managed'),
    receipt: receipt(f),
    status: 'applied',
  });
});

test('post-rename durability warning reports unknown while retaining the pending intent', async () => {
  const f = fixture();
  const state = createWorkspaceState({
    fs: {
      ...fs,
      fsyncSync(fd) {
        if (fs.fstatSync(fd).isDirectory()) {
          throw Object.assign(new Error('fixture failure'), { code: 'EIO' });
        }
        return fs.fsyncSync(fd);
      },
    },
    integrationRoot: f.privateRoot,
  });
  const store = createSpansIntegrationState({
    integrationRoot: f.privateRoot,
    state,
  });
  const result = await store.beginIntent(intent(f));
  expect(result).toEqual({
    code: 'INTEGRATION_STATE_WRITE_UNKNOWN',
    status: 'unknown',
  });
  expect(store.read().records[0].status).toBe('pending');
});

test.each([
  ['missing receipt', null],
  [
    'wrong content and digest',
    receipt(null, 'op-1', { content: 'other', digest: sha('other') }),
  ],
  [
    'content does not hash to desired digest',
    receipt(null, 'op-1', { content: 'other' }),
  ],
  ['wrong receipt digest', receipt(null, 'op-1', { digest: sha('other') })],
  ['wrong client', receipt(null, 'op-1', { client: 'claude' })],
  ['wrong path', receipt(null, 'op-1', { path: '/tmp/fixture/other.md' })],
  ['wrong operation id', receipt(null, 'other-op')],
  [
    'non-observed evidence',
    receipt(null, 'op-1', {
      appliedEvidence: { operationId: 'op-1', state: 'pending-reconciliation' },
    }),
  ],
])(
  'install evidence with %s cannot create an applied ownership receipt',
  async (name, receiptValue) => {
    const f = fixture();
    const store = createSpansIntegrationState({
      integrationRoot: f.privateRoot,
    });
    await store.beginIntent(intent(f));
    const observed =
      receiptValue && name !== 'wrong path'
        ? { ...receiptValue, path: f.target }
        : receiptValue;
    await store.settleEvidence({
      observedDigest: sha('managed'),
      operationId: 'op-1',
      receipt: observed,
    });
    expect(store.read().records[0]).toMatchObject({
      after: sha('managed'),
      receipt: null,
      status: 'conflict',
    });
  }
);

test('operation preconditions and removal evidence are validated conservatively', async () => {
  const f = fixture();
  const store = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  await expect(
    store.beginIntent(intent(f, { expectedBefore: sha('old') }))
  ).rejects.toMatchObject({ code: 'INTEGRATION_INTENT_INVALID' });
  const remove = intent(f, {
    desiredAfter: null,
    disposition: 'remove',
    expectedBefore: sha('managed'),
    operation: 'remove',
  });
  await store.beginIntent(remove);
  await store.settleEvidence({
    observedDigest: sha('managed'),
    operationId: 'op-1',
  });
  expect(store.read().records[0]).toMatchObject({
    after: sha('managed'),
    receipt: null,
    status: 'conflict',
  });
  const second = intent(f, {
    desiredAfter: null,
    disposition: 'remove',
    expectedBefore: sha('managed'),
    operation: 'remove',
    operationId: 'op-2',
  });
  await store.beginIntent(second);
  await store.settleEvidence({ observedDigest: null, operationId: 'op-2' });
  expect(store.read().records[1]).toMatchObject({
    after: null,
    receipt: null,
    status: 'applied',
  });
});

test('observed bytes that differ from desired install bytes are conflict evidence', async () => {
  const f = fixture();
  const store = createSpansIntegrationState({ integrationRoot: f.privateRoot });
  await store.beginIntent(intent(f));
  await store.settleEvidence({
    observedDigest: sha('managed'),
    operationId: 'op-1',
    receipt: receipt(f),
  });
  const another = intent(f, {
    operationId: 'op-2',
    previewDigest: sha('preview-2'),
  });
  await store.beginIntent(another);
  await store.settleEvidence({
    observedDigest: sha('other'),
    operationId: 'op-2',
    receipt: receipt(f, 'op-2'),
  });
  expect(store.read().records[1]).toMatchObject({
    after: sha('other'),
    receipt: null,
    status: 'conflict',
  });
});

test('planner preview and persisted ownership receipt roundtrip to its no-op plan', async () => {
  const f = fixture();
  const plan = planSpansIntegrationUpdate({
    allowedRoots: [{ client: 'codex', path: f.allowedRoot }],
    desiredFiles: [
      { client: 'codex', content: 'managed', path: f.target, version: '1' },
    ],
    handshakes: [],
    now: 1_800_000_000_000,
    observations: [
      {
        ancestorSymlink: false,
        digest: null,
        kind: 'missing',
        path: f.target,
        realPath: f.target,
        symlink: false,
      },
    ],
    previousReceipts: [],
  });
  expect(plan.operations[0].kind).toBe('create');
  const store = createSpansIntegrationState({
    integrationRoot: f.privateRoot,
    now: () => 1_800_000_000_000,
  });
  await store.beginIntent({
    allowedRoot: f.allowedRoot,
    client: 'codex',
    desiredAfter: sha('managed'),
    disposition: 'retain',
    expectedBefore: null,
    operation: 'install',
    operationId: 'op-1',
    previewDigest: plan.previewDigest,
    target: f.target,
  });
  await store.settleEvidence({
    observedDigest: sha('managed'),
    operationId: 'op-1',
    receipt: receipt(f),
  });
  const observed = {
    ancestorSymlink: false,
    digest: sha('managed'),
    kind: 'regular-file',
    path: f.target,
    realPath: f.target,
    symlink: false,
  };
  const noOp = planSpansIntegrationUpdate({
    allowedRoots: [{ client: 'codex', path: f.allowedRoot }],
    desiredFiles: [
      { client: 'codex', content: 'managed', path: f.target, version: '1' },
    ],
    handshakes: [],
    now: 1_800_000_000_000,
    observations: [observed],
    previousReceipts: [store.read().records[0].receipt],
  });
  expect(noOp.operations[0].kind).toBe('no-op');
});

test('snapshots caller data before a lock wait and rejects hostile or oversized inputs without state I/O', async () => {
  const f = fixture();
  const raw = createWorkspaceState({ integrationRoot: f.privateRoot });
  let release;
  const gate = new Promise((resolveGate) => {
    release = resolveGate;
  });
  const delayed = {
    read: (...args) => raw.read(...args),
    update: async (...args) => {
      await gate;
      return raw.update(...args);
    },
  };
  const store = createSpansIntegrationState({
    integrationRoot: f.privateRoot,
    state: delayed,
  });
  const input = intent(f);
  const pending = store.beginIntent(input);
  input.desiredAfter = sha('mutated');
  release();
  await pending;
  expect(store.read().records[0].desiredAfter).toBe(sha('managed'));
  const before = fs.readdirSync(f.privateRoot).sort();
  const accessor = { ...intent(f, { operationId: 'op-2' }) };
  Object.defineProperty(accessor, 'target', {
    enumerable: true,
    get() {
      throw new Error('secret');
    },
  });
  await expect(store.beginIntent(accessor)).rejects.toMatchObject({
    code: 'INTEGRATION_INPUT_INVALID',
  });
  await expect(
    store.beginIntent(new Proxy(intent(f, { operationId: 'op-3' }), {}))
  ).rejects.toMatchObject({ code: 'INTEGRATION_INPUT_INVALID' });
  await expect(
    store.beginIntent(
      intent(f, { operationId: 'op-4', target: `${f.target}\0bad` })
    )
  ).rejects.toMatchObject({ code: 'INTEGRATION_INPUT_INVALID' });
  const nestedEvidence = {
    observedDigest: sha('managed'),
    operationId: 'op-1',
    receipt: receipt(f),
  };
  Object.defineProperty(nestedEvidence.receipt, 'content', {
    enumerable: true,
    get() {
      throw new Error('secret');
    },
  });
  await expect(store.settleEvidence(nestedEvidence)).rejects.toMatchObject({
    code: 'INTEGRATION_INPUT_INVALID',
  });
  expect(fs.readdirSync(f.privateRoot).sort()).toEqual(before);
});

test('corrupt and newer documents remain untouched; symlinked targets and unsafe roots refuse', async () => {
  const f = fixture();
  const path = join(f.privateRoot, 'receipts.json');
  async function assertCorruptDocumentRefused(text) {
    fs.writeFileSync(path, text, { mode: 0o600 });
    const before = fs.readFileSync(path);
    const store = createSpansIntegrationState({
      integrationRoot: f.privateRoot,
    });
    expect(() => store.read()).toThrow();
    await expect(store.beginIntent(intent(f))).rejects.toThrow();
    expect(fs.readFileSync(path)).toEqual(before);
    fs.unlinkSync(path);
  }
  await assertCorruptDocumentRefused('{broken');
  await assertCorruptDocumentRefused(
    JSON.stringify({ records: [], version: 999 })
  );
  fs.symlinkSync(join(f.allowedRoot, 'missing'), join(f.allowedRoot, 'link'));
  await expect(
    createSpansIntegrationState({ integrationRoot: f.privateRoot }).beginIntent(
      intent(f, { target: join(f.allowedRoot, 'link') })
    )
  ).rejects.toMatchObject({ code: 'INTEGRATION_TARGET_SYMLINK' });
  const openRoot = join(f.root, 'open');
  fs.mkdirSync(openRoot, { mode: 0o755 });
  await expect(
    createSpansIntegrationState({ integrationRoot: openRoot }).beginIntent(
      intent({ ...f, privateRoot: openRoot })
    )
  ).rejects.toMatchObject({ code: 'INTEGRATION_ROOT_PERMISSIONS' });
});

test('workspace-only store cannot fall back to workspaceRoot for integration receipts', () => {
  const f = fixture();
  const store = createWorkspaceState({ workspaceRoot: f.root });
  expect(() => store.read('integrationReceipts')).toThrow(
    expect.objectContaining({
      code: 'STATE_UNREADABLE',
      phase: 'explicit-path-required',
    })
  );
});
