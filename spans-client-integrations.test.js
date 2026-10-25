import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpansClientIntegrations } from './spans-client-integrations.js';

const skillSourcePath = fileURLToPath(
  new URL('./claude-plugin/skills/setu-spans/SKILL.md', import.meta.url)
);
const skillText = readFileSync(skillSourcePath, 'utf8');
const fixedNow = Date.parse('2026-10-20T12:00:00.000Z');
const REVIEW_ID_PATTERN = /^[a-f0-9]{64}$/;
const EXPIRY_PATTERN = /^\d{4}-\d\d-\d\dT/;
const RECEIPT_PROPERTY_PATTERN = /"receipt"\s*:/;
const roots = [];
const services = [];

afterEach(async () => {
  await Promise.all(
    services.splice(0).map((service) => service.close().catch(() => undefined))
  );
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture({ now = () => fixedNow, readHandshakes = () => [] } = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'setu-client-integrations-'))
  );
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, '.local', 'share'), { mode: 0o700, recursive: true });
  mkdirSync(join(home, '.local', 'share', 'setu'), {
    mode: 0o700,
  });
  const integrationRoot = join(home, '.local', 'share', 'setu', 'integrations');
  const service = createSpansClientIntegrations({
    home,
    integrationRoot,
    now,
    readHandshakes,
    skillSourcePath,
  });
  services.push(service);
  return {
    home,
    integrationRoot,
    service,
    skillPath: join(home, '.agents', 'skills', 'setu-spans', 'SKILL.md'),
  };
}

async function approve(service, selection = {}) {
  const reviewed = await service.review(selection);
  expect(reviewed.ok).toBe(true);
  expect(reviewed.summary.ready).toBe(true);
  expect(reviewed.reviewId).toMatch(REVIEW_ID_PATTERN);
  expect(reviewed.expiresAt).toMatch(EXPIRY_PATTERN);
  const applied = await service.apply({
    response: reviewed.phrase,
    reviewId: reviewed.reviewId,
  });
  return { applied, reviewed };
}

function assertNoPrivateBodies(value) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(skillText);
  expect(serialized).not.toContain('mcpServers');
  expect(serialized).not.toContain('synthetic-private-config');
  expect(serialized).not.toMatch(RECEIPT_PROPERTY_PATTERN);
}

describe('createSpansClientIntegrations', () => {
  test('three clients install one shared Codex-owned skill after separate confirmation', async () => {
    const f = fixture();
    const unrelatedConfigs = [
      [
        join(f.home, '.codex', 'config.toml'),
        'synthetic-private-config = "hidden"\n',
      ],
      [
        join(f.home, '.claude', 'settings.json'),
        '{"mcpServers":{"private":"hidden"}}\n',
      ],
      [
        join(f.home, '.cursor', 'mcp.json'),
        '{"private":"synthetic-private-config"}\n',
      ],
    ];
    for (const [path, text] of unrelatedConfigs) {
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    }

    const preview = await f.service.preview();
    expect(preview).toMatchObject({ ok: true, summary: { ready: true } });
    expect(preview.summary.clients).toEqual(['codex', 'claude', 'cursor']);
    expect(preview.summary.operations).toHaveLength(1);
    expect(preview.summary.operations[0]).toMatchObject({
      client: 'codex',
      consumers: ['codex', 'cursor'],
      kind: 'install',
    });
    expect(preview.summary.statuses).toEqual([
      {
        client: 'codex',
        connected: 'unknown',
        freshSession: 'unknown',
        installed: 'unknown',
        ownership: 'unverified',
        skillActivated: 'unknown',
      },
      {
        client: 'claude',
        connected: 'unknown',
        freshSession: 'unknown',
        installed: 'unknown',
        ownership: 'bundled-plugin',
        skillActivated: 'unknown',
      },
      {
        client: 'cursor',
        connected: 'unknown',
        freshSession: 'unknown',
        installed: 'unknown',
        ownership: 'unverified',
        skillActivated: 'unknown',
      },
    ]);
    expect(existsSync(f.skillPath)).toBe(false);
    expect(existsSync(f.integrationRoot)).toBe(false);
    expect(existsSync(join(f.home, '.agents'))).toBe(false);
    assertNoPrivateBodies(preview);

    const forged = await f.service.review();
    expect(forged.ok).toBe(true);
    expect(existsSync(f.skillPath)).toBe(false);
    expect(existsSync(f.integrationRoot)).toBe(false);
    const rejected = await f.service.apply({
      response: 'approved',
      reviewId: forged.reviewId,
    });
    expect(rejected).toMatchObject({
      code: 'CLIENT_INTEGRATION_CONFIRMATION_REQUIRED',
      ok: false,
    });
    expect(existsSync(f.skillPath)).toBe(false);
    expect(existsSync(f.integrationRoot)).toBe(false);

    const { applied, reviewed } = await approve(f.service);
    expect(reviewed.summary.operations).toHaveLength(1);
    expect(applied).toMatchObject({
      applied: [{ client: 'codex', status: 'applied' }],
      idempotent: false,
      ok: true,
    });
    expect(readFileSync(f.skillPath, 'utf8')).toBe(skillText);
    expect(
      existsSync(join(f.home, '.claude', 'skills', 'setu-spans', 'SKILL.md'))
    ).toBe(false);
    expect(
      existsSync(join(f.home, '.cursor', 'skills', 'setu-spans', 'SKILL.md'))
    ).toBe(false);
    for (const [path, text] of unrelatedConfigs) {
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
    assertNoPrivateBodies(reviewed);
    assertNoPrivateBodies(applied);

    const document = JSON.parse(
      readFileSync(join(f.integrationRoot, 'receipts.json'), 'utf8')
    );
    expect(document.version).toBe(1);
    expect(document.records).toHaveLength(1);
    expect(Object.keys(document.records[0]).sort()).toEqual(
      [
        'after',
        'before',
        'client',
        'createdAt',
        'desiredAfter',
        'disposition',
        'expectedBefore',
        'operation',
        'operationId',
        'previewDigest',
        'receipt',
        'status',
        'target',
      ].sort()
    );
    expect(Object.keys(document.records[0].receipt).sort()).toEqual(
      [
        'appliedEvidence',
        'client',
        'content',
        'digest',
        'path',
        'version',
      ].sort()
    );
  });

  test('status projection reports only observed true evidence or unknown', async () => {
    let handshakes = [];
    const f = fixture({ readHandshakes: () => handshakes });
    const installed = await approve(f.service);
    expect(installed.applied.ok).toBe(true);
    const digest = `sha256:${createHash('sha256')
      .update(skillText)
      .digest('hex')}`;
    const handshake = (client, freshSession) => ({
      activatedDigests: freshSession ? [digest] : [],
      client,
      connected: true,
      freshSession,
      observedAt: fixedNow,
      previousSessionId: freshSession ? 'previous-session' : 'same-session',
      sessionId: freshSession ? 'new-session' : 'same-session',
      transport: 'mcp',
    });

    handshakes = [handshake('codex', false), handshake('cursor', false)];
    const connected = await f.service.preview();
    expect(connected.ok).toBe(true);
    expect(connected.summary.statuses).toEqual([
      {
        client: 'codex',
        connected: true,
        freshSession: 'unknown',
        installed: true,
        ownership: 'verified',
        skillActivated: 'unknown',
      },
      {
        client: 'claude',
        connected: 'unknown',
        freshSession: 'unknown',
        installed: 'unknown',
        ownership: 'bundled-plugin',
        skillActivated: 'unknown',
      },
      {
        client: 'cursor',
        connected: true,
        freshSession: 'unknown',
        installed: true,
        ownership: 'verified',
        skillActivated: 'unknown',
      },
    ]);
    assertNoPrivateBodies(connected);

    handshakes = [handshake('codex', true), handshake('cursor', true)];
    const activated = await f.service.preview();
    expect(activated.ok).toBe(true);
    expect(activated.summary.statuses).toEqual([
      {
        client: 'codex',
        connected: true,
        freshSession: true,
        installed: true,
        ownership: 'verified',
        skillActivated: true,
      },
      {
        client: 'claude',
        connected: 'unknown',
        freshSession: 'unknown',
        installed: 'unknown',
        ownership: 'bundled-plugin',
        skillActivated: 'unknown',
      },
      {
        client: 'cursor',
        connected: true,
        freshSession: true,
        installed: true,
        ownership: 'verified',
        skillActivated: true,
      },
    ]);
    assertNoPrivateBodies(activated);
  });

  test('shared removal review names both consumers and removes only the owned file', async () => {
    const f = fixture();
    const installed = await approve(f.service);
    expect(installed.applied.ok).toBe(true);
    const review = await f.service.review({
      clients: ['codex', 'cursor'],
      removeSharedArtifact: true,
    });
    expect(review.ok).toBe(true);
    expect(review.summary.ready).toBe(true);
    expect(review.phrase.startsWith('Remove ')).toBe(true);
    expect(review.phrase).toContain('Codex');
    expect(review.phrase).toContain('Cursor');
    expect(review.summary.sharedArtifactRemoval).toEqual({
      affectedClients: ['codex', 'cursor'],
      path: f.skillPath,
    });
    expect(review.summary.operations).toEqual([
      expect.objectContaining({
        client: 'codex',
        consumers: ['codex', 'cursor'],
        kind: 'remove',
        path: f.skillPath,
      }),
    ]);

    const removed = await f.service.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(removed).toMatchObject({
      applied: [{ client: 'codex', path: f.skillPath, status: 'removed' }],
      idempotent: false,
      ok: true,
    });
    expect(existsSync(f.skillPath)).toBe(false);
    assertNoPrivateBodies(review);
    assertNoPrivateBodies(removed);
  });

  test('single-client removal remains unsupported by the shared owner', async () => {
    const f = fixture();
    const selection = {
      clients: ['codex', 'cursor'],
      removeClient: 'cursor',
    };
    const review = await f.service.review(selection);
    expect(review).toMatchObject({ ok: true, summary: { ready: true } });
    const result = await f.service.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(result).toMatchObject({
      code: 'CLIENT_INTEGRATION_REMOVAL_UNSUPPORTED',
      ok: false,
    });
    expect(existsSync(f.skillPath)).toBe(false);
    expect(existsSync(f.integrationRoot)).toBe(false);
  });

  test('exact request validation refuses forged claims, cross-review phrases, expiry and replay', async () => {
    let now = fixedNow;
    const f = fixture({ now: () => now });
    const first = await f.service.review();
    const second = await f.service.review();

    const forgedClaims = await f.service.apply({
      approved: true,
      response: first.phrase,
      reviewId: first.reviewId,
      source: 'user',
    });
    expect(forgedClaims).toMatchObject({
      code: 'CLIENT_INTEGRATION_INPUT_INVALID',
      ok: false,
    });
    expect(existsSync(f.skillPath)).toBe(false);

    const crossReview = await f.service.apply({
      response: first.phrase,
      reviewId: second.reviewId,
    });
    expect(crossReview).toMatchObject({
      code: 'CLIENT_INTEGRATION_CONFIRMATION_REQUIRED',
      ok: false,
    });
    const otherCrossReview = await f.service.apply({
      response: second.phrase,
      reviewId: first.reviewId,
    });
    expect(otherCrossReview.ok).toBe(false);

    const expired = await f.service.review();
    now += 5 * 60 * 1000;
    const expiredResult = await f.service.apply({
      response: expired.phrase,
      reviewId: expired.reviewId,
    });
    expect(expiredResult).toMatchObject({
      code: 'CLIENT_INTEGRATION_REVIEW_EXPIRED',
      ok: false,
    });
    expect(existsSync(f.skillPath)).toBe(false);

    now += 1;
    const current = await f.service.review();
    const firstUse = await f.service.apply({
      response: current.phrase,
      reviewId: current.reviewId,
    });
    expect(firstUse.ok).toBe(true);
    const replay = await f.service.apply({
      response: current.phrase,
      reviewId: current.reviewId,
    });
    expect(replay.ok).toBe(false);
    expect(existsSync(f.skillPath)).toBe(true);
  });

  test('review issuance remains bounded to sixty four active proofs', async () => {
    const f = fixture();
    const issued = [];
    // Sequential issuance makes the oldest-review eviction deterministic.
    for (let index = 0; index < 65; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: This test pins insertion order for the bounded queue.
      issued.push(await f.service.review());
    }
    expect(issued.every((review) => review.ok && review.summary.ready)).toBe(
      true
    );
    const evicted = await f.service.apply({
      response: issued[0].phrase,
      reviewId: issued[0].reviewId,
    });
    expect(evicted).toMatchObject({
      code: 'CLIENT_INTEGRATION_REVIEW_INVALID',
      ok: false,
    });
    const newest = await f.service.apply({
      response: issued.at(-1).phrase,
      reviewId: issued.at(-1).reviewId,
    });
    expect(newest.ok).toBe(true);
    expect(existsSync(f.skillPath)).toBe(true);
  });

  test('changed native bytes invalidate a review and preserve the user file', async () => {
    const f = fixture();
    const review = await f.service.review();
    expect(review.summary.operations[0].kind).toBe('install');
    const userText = '# Local user edit\n';
    mkdirSync(dirname(f.skillPath), { mode: 0o700, recursive: true });
    writeFileSync(f.skillPath, userText, { mode: 0o600 });

    const result = await f.service.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(result).toMatchObject({
      code: 'CLIENT_INTEGRATION_CONFLICT',
      ok: false,
    });
    expect(readFileSync(f.skillPath, 'utf8')).toBe(userText);
    expect(existsSync(f.integrationRoot)).toBe(false);
  });

  test('unknown receipt reconciliation consumes the review and blocks replay', async () => {
    const f = fixture();
    const review = await f.service.review();
    const target = f.skillPath;
    mkdirSync(dirname(target), { mode: 0o700, recursive: true });
    symlinkSync('absent-user-target', target);
    mkdirSync(f.integrationRoot, { mode: 0o700, recursive: true });
    const desiredDigest = `sha256:${'a'.repeat(64)}`;
    const operationId = 'fixture-unknown-operation';
    writeFileSync(
      join(f.integrationRoot, 'receipts.json'),
      `${JSON.stringify({
        records: [
          {
            after: null,
            before: null,
            client: 'codex',
            createdAt: fixedNow,
            desiredAfter: desiredDigest,
            disposition: 'retain',
            expectedBefore: null,
            operation: 'install',
            operationId,
            previewDigest: `sha256:${'b'.repeat(64)}`,
            receipt: null,
            status: 'pending',
            target,
          },
        ],
        version: 1,
      })}\n`,
      { mode: 0o600 }
    );

    const apply = await f.service.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(apply).toMatchObject({ ok: false, unknown: true });
    const replay = await f.service.apply({
      response: review.phrase,
      reviewId: review.reviewId,
    });
    expect(replay.ok).toBe(false);
    const reconciled = await f.service.reconcile();
    expect(reconciled).toEqual({
      ok: true,
      reconciled: [{ operationId, status: 'unknown' }],
      unknown: true,
    });
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    assertNoPrivateBodies(apply);
    assertNoPrivateBodies(reconciled);
  });

  test('close drains in-flight reads and refuses new work', async () => {
    let releaseHandshake;
    let enteredHandshake;
    const entered = new Promise((resolveEntered) => {
      enteredHandshake = resolveEntered;
    });
    const blockedHandshake = new Promise((resolveHandshake) => {
      releaseHandshake = resolveHandshake;
    });
    const f = fixture({
      readHandshakes: async () => {
        enteredHandshake();
        return await blockedHandshake;
      },
    });
    const pending = f.service.preview();
    await entered;
    let drained = false;
    const closing = f.service.close().then((result) => {
      drained = true;
      return result;
    });
    expect(drained).toBe(false);
    expect(await f.service.preview()).toMatchObject({
      code: 'CLIENT_INTEGRATION_CLOSED',
      ok: false,
    });
    releaseHandshake([]);
    expect((await pending).ok).toBe(true);
    expect(await closing).toEqual({ closed: true, ok: true });
    expect(await f.service.reconcile()).toMatchObject({
      code: 'CLIENT_INTEGRATION_CLOSED',
      ok: false,
    });
  });

  test('construction and requests require explicit trusted paths and exact own data', async () => {
    expect(() => createSpansClientIntegrations({})).toThrow();
    const f = fixture();
    const inherited = Object.create({ clients: ['codex'] });
    expect(await f.service.preview(inherited)).toMatchObject({
      code: 'CLIENT_INTEGRATION_INPUT_INVALID',
      ok: false,
    });
    const accessor = {};
    Object.defineProperty(accessor, 'clients', {
      get() {
        throw new Error('must not run');
      },
    });
    expect(await f.service.review(accessor)).toMatchObject({
      code: 'CLIENT_INTEGRATION_INPUT_INVALID',
      ok: false,
    });
  });
});
