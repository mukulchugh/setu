import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { planSpansIntegrationUpdate } from './spans-integrations.js';

const root = '/clients/claude';
const target = `${root}/skills/spans/SKILL.md`;
const content = '# Setu Spans\n';
const version = 'spans-skill-1';
const now = 1_800_000_000_000;
const PREVIEW_DIGEST = /^sha256:[a-f0-9]{64}$/;

function hash(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function observation(path = target, overrides = {}) {
  return {
    ancestorSymlink: false,
    digest: null,
    kind: 'missing',
    path,
    realPath: path,
    symlink: false,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    appliedEvidence: { observedAt: now - 1000, state: 'observed' },
    client: 'claude',
    content,
    digest: hash(content),
    path: target,
    version,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    allowedRoots: [{ client: 'claude', path: root }],
    desiredFiles: [{ client: 'claude', content, path: target, version }],
    handshakes: [],
    now,
    observations: [observation()],
    previousReceipts: [],
    ...overrides,
  };
}

describe('planSpansIntegrationUpdate', () => {
  test('previews creation for an absent file without installing it', () => {
    const result = planSpansIntegrationUpdate(request());

    expect(result.ok).toBe(true);
    expect(result.previewOnly).toBe(true);
    expect(result.operations).toEqual([
      {
        client: 'claude',
        digest: hash(content),
        kind: 'create',
        path: target,
        version,
      },
    ]);
    expect(result.statuses.claude).toEqual({
      connected: 'unknown',
      installed: 'not-verified',
      verified: 'unverified',
    });
  });

  test('preserves an edited previously owned file', () => {
    const result = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(target, {
            digest: hash('local edit'),
            kind: 'regular-file',
          }),
        ],
        previousReceipts: [receipt()],
      })
    );

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([
      { client: 'claude', code: 'OWNED_FILE_EDITED', path: target },
    ]);
    expect(result.operations).toEqual([]);
  });

  test('refuses a collision with an unowned file', () => {
    const result = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(target, { digest: hash(content), kind: 'regular-file' }),
        ],
      })
    );

    expect(result.conflicts[0]?.code).toBe('UNOWNED_COLLISION');
    expect(result.operations).toEqual([]);
  });

  test('refuses a receipt owned by a different client', () => {
    const result = planSpansIntegrationUpdate(
      request({
        previousReceipts: [receipt({ client: 'codex' })],
      })
    );

    expect(result.conflicts[0]?.code).toBe('WRONG_CLIENT_RECEIPT');
    expect(result.operations).toEqual([]);
  });

  test('requires reconciliation for an interrupted owned update', () => {
    const result = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(target, {
            digest: hash('old version'),
            kind: 'regular-file',
          }),
        ],
        previousReceipts: [
          receipt({
            appliedEvidence: {
              operationId: 'update-1',
              state: 'pending-reconciliation',
            },
            content: 'old version',
            digest: hash('old version'),
            version: 'old-version',
          }),
        ],
      })
    );

    expect(result.conflicts[0]?.code).toBe('RECONCILIATION_REQUIRED');
    expect(result.operations).toEqual([]);
  });

  test('is a no-op for the same exact receipt and observed digest', () => {
    const result = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(target, { digest: hash(content), kind: 'regular-file' }),
        ],
        previousReceipts: [receipt()],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.operations[0]?.kind).toBe('no-op');
    expect(result.statuses.claude.installed).toBe('installed');
    expect(result.statuses.claude.verified).toBe('unverified');
  });

  test('does not verify activation from a stale handshake', () => {
    const result = planSpansIntegrationUpdate(
      request({
        handshakes: [
          {
            activatedDigests: [hash(content)],
            client: 'claude',
            connected: true,
            freshSession: true,
            observedAt: now - 10 * 60 * 1000,
            previousSessionId: 'old-session',
            sessionId: 'new-session',
            transport: 'mcp',
          },
        ],
      })
    );

    expect(result.statuses.claude.connected).toBe('unknown');
    expect(result.statuses.claude.verified).toBe('unverified');
    expect(result.statuses.claude.connected).toBe('unknown');
  });

  test('requires matching installed bytes before activation can be verified', () => {
    const handshake = {
      activatedDigests: [hash(content)],
      client: 'claude',
      connected: true,
      freshSession: true,
      observedAt: now - 1000,
      previousSessionId: 'old-session',
      sessionId: 'new-session',
      transport: 'mcp',
    };
    for (const observed of [
      observation(),
      observation(target, { digest: hash('edited'), kind: 'regular-file' }),
    ]) {
      const result = planSpansIntegrationUpdate(
        request({
          handshakes: [handshake],
          observations: [observed],
          previousReceipts: observed.kind === 'regular-file' ? [receipt()] : [],
        })
      );
      expect(result.statuses.claude.verified).toBe('unverified');
    }
  });

  test('rejects duplicate contradictory observations, ownership receipts and handshakes', () => {
    const contradictory = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(),
          observation(target, { digest: hash(content), kind: 'regular-file' }),
        ],
      })
    );
    const duplicateReceipt = planSpansIntegrationUpdate(
      request({ previousReceipts: [receipt(), receipt()] })
    );
    const duplicateHandshake = planSpansIntegrationUpdate(
      request({
        handshakes: [
          { client: 'claude', connected: true },
          { client: 'claude', connected: false },
        ],
      })
    );
    expect(contradictory.code).toBe('OBSERVATION_DUPLICATE');
    expect(duplicateReceipt.code).toBe('RECEIPT_DUPLICATE');
    expect(duplicateHandshake.code).toBe('HANDSHAKE_DUPLICATE');
  });

  test('rejects oversized content and accessor-backed inputs without exposing exceptions', () => {
    const huge = planSpansIntegrationUpdate(
      request({
        desiredFiles: [
          {
            client: 'claude',
            content: 'x'.repeat(1024 * 1024 + 1),
            path: target,
            version,
          },
        ],
      })
    );
    const accessor = request();
    Object.defineProperty(accessor, 'now', {
      enumerable: true,
      get() {
        throw new Error('secret getter error');
      },
    });
    const thrown = planSpansIntegrationUpdate(accessor);
    expect(huge.code).toBe('INPUT_INVALID');
    expect(thrown.code).toBe('INPUT_INVALID');
    expect(thrown.error).not.toContain('secret');
  });

  test('rejects case aliases that identify one actual target across clients', () => {
    const codexRoot = '/clients';
    const codexTarget = `${codexRoot}/Skills/spans.md`;
    const result = planSpansIntegrationUpdate(
      request({
        allowedRoots: [
          { client: 'claude', path: '/clients' },
          { client: 'codex', path: codexRoot },
        ],
        desiredFiles: [
          { client: 'claude', content, path: target, version },
          { client: 'codex', content, path: codexTarget, version },
        ],
        observations: [
          observation(target, { realPath: `${root}/Skills/spans.md` }),
          observation(codexTarget, { realPath: `${root}/Skills/spans.md` }),
        ],
      })
    );
    expect(result.code).toBe('TARGET_IDENTITY_CONFLICT');
  });

  test('rejects distinct same-client entries that share a canonical target', () => {
    const aliases = [
      `${root}/Skills/spans/SKILL.md`,
      `${root}/alternate/SKILL.md`,
    ];
    for (const alias of aliases) {
      for (const aliasContent of [content, `${content}different`]) {
        const result = planSpansIntegrationUpdate(
          request({
            desiredFiles: [
              { client: 'claude', content, path: target, version },
              { client: 'claude', content: aliasContent, path: alias, version },
            ],
            observations: [
              observation(target),
              observation(alias, { realPath: target }),
            ],
          })
        );
        expect(result.code).toBe('TARGET_IDENTITY_CONFLICT');
      }
    }
  });

  test('requires a desired path to be strictly below its client root', () => {
    const result = planSpansIntegrationUpdate(
      request({
        desiredFiles: [{ client: 'claude', content, path: root, version }],
        observations: [observation(root)],
      })
    );
    expect(result.code).toBe('PATH_OUTSIDE_ALLOWED_ROOT');
  });

  test('does not accept a root assigned to a different client', () => {
    const otherRoot = '/clients/codex';
    const otherTarget = `${otherRoot}/skills/spans.md`;
    const result = planSpansIntegrationUpdate(
      request({
        allowedRoots: [{ client: 'codex', path: otherRoot }],
        desiredFiles: [
          {
            client: 'claude',
            content,
            path: otherTarget,
            version,
          },
        ],
        observations: [observation(otherTarget)],
      })
    );
    expect(result.code).toBe('PATH_OUTSIDE_ALLOWED_ROOT');
  });

  test('binds preview digest to desired content and expected prior fingerprints', () => {
    const first = planSpansIntegrationUpdate(request());
    const changed = planSpansIntegrationUpdate(
      request({
        desiredFiles: [
          {
            client: 'claude',
            content: `${content}changed`,
            path: target,
            version,
          },
        ],
      })
    );
    expect(first.previewDigest).toMatch(PREVIEW_DIGEST);
    expect(first.previewDigest).not.toBe(changed.previewDigest);
  });

  test('binds preview digest to receipt identity, version and applied evidence', () => {
    const baseline = planSpansIntegrationUpdate(
      request({
        observations: [
          observation(target, {
            digest: hash(content),
            kind: 'regular-file',
          }),
        ],
        previousReceipts: [receipt()],
      })
    );
    const changedReceipts = [
      receipt({ client: 'codex' }),
      receipt({ path: `${root}/other/SKILL.md` }),
      receipt({ version: 'older-skill-version' }),
      receipt({
        appliedEvidence: {
          observedAt: now - 1000,
          state: 'pending-reconciliation',
        },
      }),
      receipt({
        appliedEvidence: { operationId: 'update-2', state: 'observed' },
      }),
    ];

    expect(baseline.ok).toBe(true);
    for (const changedReceipt of changedReceipts) {
      const changed = planSpansIntegrationUpdate(
        request({
          observations: [
            observation(target, {
              digest: hash(content),
              kind: 'regular-file',
            }),
          ],
          previousReceipts: [changedReceipt],
        })
      );
      expect(changed.previewDigest).not.toBe(baseline.previewDigest);
    }
  });

  test('fails closed on a symlinked target and on traversal outside a candidate root', () => {
    const linked = planSpansIntegrationUpdate(
      request({ observations: [observation(target, { symlink: true })] })
    );
    const traversal = planSpansIntegrationUpdate(
      request({
        desiredFiles: [
          { client: 'claude', content, path: `${root}/../outside`, version },
        ],
        observations: [observation(`${root}/../outside`)],
      })
    );

    expect(linked.code).toBe('PATH_OBSERVATION_UNSAFE');
    expect(traversal.code).toBe('PATH_NOT_NORMALIZED');
  });
});
