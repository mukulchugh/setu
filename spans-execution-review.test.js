import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { targetDigestFor } from './spans-dispatch.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansExecutionReviews } from './spans-execution-review.js';
import { openSpansStore } from './spans-store.js';

const HEAD_SHA1 = /^[a-f0-9]{40}$/;
const ARTIFACT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROFILE_FIXTURES = Object.freeze({
  'claude-code-sonnet': {
    effort: 'medium',
    model: 'claude-sonnet-5-5',
    policy: {
      attempt: 0,
      attemptTimeoutMs: 3_600_000,
      capture: 'full-stop',
      effort: 'medium',
      maxWorkers: 2,
      model: 'claude-sonnet-5-5',
      provider: 'anthropic',
      retries: 0,
      subscriptionOnly: true,
    },
    provider: 'anthropic',
  },
  'codex:gpt-6-luna:high': {
    effort: 'high',
    model: 'gpt-6-luna',
    policy: {
      attempt: 0,
      attemptTimeoutMs: 1_800_000,
      capture: 'full-stop',
      effort: 'high',
      maxWorkers: 2,
      model: 'gpt-6-luna',
      provider: 'codex',
      retries: 0,
      subscriptionOnly: true,
    },
    provider: 'codex',
  },
});

const roots = new Set();
afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture(profileId = 'codex:gpt-6-luna:high') {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-spans-execution-review-'));
  roots.add(root);
  let store = openSpansStore({ root });
  const drafts = createSpansDrafts({ store });
  drafts.createRun({
    goal: 'Review safely',
    owner: 'test',
    runId: 'review-run',
    spans: [{ dependencies: [], spanId: 'ship', title: 'Ship' }],
  });
  let mutate;
  const selector = {
    actionId: 'action-1',
    attemptId: 'attempt-0',
    generation: 0,
    planVersion: 1,
    runId: 'review-run',
    spanId: 'ship',
  };
  const profileFixture = PROFILE_FIXTURES[profileId];
  const binding = (current = selector) => {
    const expected = {
      dependency: {
        bunVersion: '1.3.14',
        linkerMode: 'isolated',
        lockfileHash: '1'.repeat(64),
        platformNamespace: 'darwin-arm64',
      },
      dirty: { count: 0, hash: '2'.repeat(64) },
      head: 'a'.repeat(40),
      identity: {
        admin: { birthtimeNs: '1', dev: '1', ino: '1' },
        adminPath: '/tmp/fixture/repo/worktrees/feat/spans',
        checkout: { birthtimeNs: '2', dev: '1', ino: '2' },
        checkoutPath: '/tmp/fixture/repo/feat/spans',
        known: true,
        repository: { birthtimeNs: '3', dev: '1', ino: '3' },
        repositoryPath: '/tmp/fixture/repo',
      },
    };
    const result = {
      actionId: current.actionId,
      admission: { kind: 'headless-run', policyDigest: '3'.repeat(64) },
      attemptId: current.attemptId,
      checkout: {
        expected,
        repoDir: '/tmp/fixture/repo',
        wtDir: '/tmp/fixture/repo/feat/spans',
      },
      digests: {
        dependencies: '4'.repeat(64),
        dirty: '2'.repeat(64),
        head: '6'.repeat(64),
        lockfile: '1'.repeat(64),
      },
      executionVersion: 1,
      generation: current.generation,
      inputArtifact: { digest: '8'.repeat(64), id: `sha256:${'9'.repeat(64)}` },
      planVersion: current.planVersion,
      policy: structuredClone(profileFixture.policy),
      profile: {
        digest: 'a'.repeat(64),
        effort: profileFixture.effort,
        id: profileId,
        model: profileFixture.model,
        provider: profileFixture.provider,
      },
      requiredCapabilities: ['run'],
      runId: current.runId,
      spanId: current.spanId,
      target: { name: 'feat/spans', repo: 'setu' },
      targetDigest: targetDigestFor(expected),
    };
    return mutate ? mutate(result) : result;
  };
  const confirmation = { valid: true };
  const verified = {
    confirmedAt: '2026-10-20T10:00:00.000Z',
    reference: 'human-confirm-1',
    source: 'human-review',
  };
  const verifyConfirmation = async ({ confirmation: received }) =>
    received?.valid === true || received?.reference === verified.reference
      ? verified
      : null;
  const revocationProof = {
    challengeId: 'revoke-proof-1',
    response: 'Revoke review',
  };
  const revoked = {
    confirmedAt: '2026-10-20T10:05:00.000Z',
    reference: 'human-revoke-1',
    source: 'human-revocation',
  };
  const verifyRevocation = async ({ confirmation: received }) =>
    received?.challengeId === revocationProof.challengeId &&
    received?.response === revocationProof.response
      ? revoked
      : null;
  const create = (activeStore = store, options = {}) =>
    createSpansExecutionReviews({
      resolveBinding:
        options.resolveBinding ?? (async (current) => binding(current)),
      store: activeStore,
      verifyConfirmation: options.verifyConfirmation ?? verifyConfirmation,
      verifyRevocation: options.verifyRevocation ?? verifyRevocation,
      verifyWritable: options.verifyWritable ?? (async () => true),
    });
  return {
    binding,
    confirmation,
    create,
    drafts,
    reopen() {
      store.close();
      store = openSpansStore({ root });
      return create(store);
    },
    revocationProof,
    revoked,
    root,
    selector,
    setMutation(value) {
      mutate = value;
    },
    get store() {
      return store;
    },
    verified,
    wrapUncertain({ throws = false } = {}) {
      const base = store;
      const readRun = base.readRun.bind(base);
      const getEventById = base.getEventById.bind(base);
      const commitRun = (input) => {
        const committed = base.commitRun(input);
        if (throws) {
          throw new Error('commit response was lost');
        }
        if (!committed.ok) {
          return committed;
        }
        return { code: 'SPANS_MODEL_UNAVAILABLE', ok: false };
      };
      return create({ commitRun, getEventById, readRun });
    },
  };
}

async function prepareAndApprove(f, service = f.create()) {
  const result = await service.prepare(f.selector);
  if (result.ok) {
    await service.approve({
      confirmation: f.confirmation,
      reviewDigest: result.review.reviewDigest,
      runId: f.selector.runId,
    });
  }
  return result;
}

describe('durable Spans execution reviews', () => {
  test('preparation, approval and revocation preserve an existing Links approval', async () => {
    const f = fixture();
    try {
      const links = createLinksAssociations({
        isKnownOrigin: () => true,
        store: f.store,
      });
      const selected = {
        hint: 'review-run',
        origin: 'peer-A',
        runId: 'review-run',
      };
      const preview = links.preview(selected);
      expect(preview.ok).toBe(true);
      expect(
        links.approve({ ...selected, confirmation: preview.review.token }).ok
      ).toBe(true);
      const before = f.store.readRun({ runId: 'review-run' }).view
        .linksAssociations;
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(prepared.ok).toBe(true);
      const selector = {
        reviewDigest: prepared.review.reviewDigest,
        runId: 'review-run',
      };
      expect(
        f.store.readRun({ runId: 'review-run' }).view.linksAssociations
      ).toEqual(before);
      expect(
        await service.approve({ ...selector, confirmation: f.confirmation })
      ).toMatchObject({ ok: true });
      expect(
        f.store.readRun({ runId: 'review-run' }).view.linksAssociations
      ).toEqual(before);
      expect(
        await service.revoke({ ...selector, confirmation: f.revocationProof })
      ).toMatchObject({ ok: true });
      expect(
        f.store.readRun({ runId: 'review-run' }).view.linksAssociations
      ).toEqual(before);
    } finally {
      f.store.close();
    }
  });

  test('persists an immutable review and separately versioned receipt across restart', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(prepared.ok).toBe(true);
      expect(
        f.store.getArtifactReference({
          artifactId: prepared.review.binding.inputArtifact.id,
          runId: f.selector.runId,
        })
      ).toMatchObject({ found: true, ok: true });
      expect(prepared.review.binding.target.name).toBe('feat/spans');
      expect(prepared.review.binding.checkout.expected.head).toMatch(HEAD_SHA1);
      expect(prepared.review.binding.inputArtifact.id).toMatch(
        ARTIFACT_ID_PATTERN
      );
      expect(await service.prepare(f.selector)).toMatchObject({
        ok: true,
        replayed: true,
      });
      const restarted = f.reopen();
      expect(
        await restarted.read({
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      expect(
        await restarted.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      const afterRestart = f.reopen();
      expect(
        await afterRestart.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ ok: true });
      const {
        view: { execution },
      } = f.store.readRun({ runId: 'review-run' });
      expect(execution.version).toBe(1);
      expect(
        execution.receipts[prepared.review.reviewDigest].approvals
      ).toHaveLength(1);
      const current = f.store.readRun({ runId: 'review-run' });
      expect(
        createSpansDrafts({ store: f.store }).revisePlan({
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          goal: 'After restart',
          runId: 'review-run',
          spans: [{ dependencies: [], spanId: 'ship', title: 'Changed' }],
        }).ok
      ).toBe(true);
      expect(
        await afterRestart.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });
    } finally {
      f.store.close();
    }
  });

  test('rejects every changed binding field and caller asserted authority', async () => {
    const mutations = [
      (b) => {
        b.actionId = 'action-2';
      },
      (b) => {
        b.admission.policyDigest = 'b'.repeat(64);
      },
      (b) => {
        b.admission.kind = 'session';
      },
      (b) => {
        b.attemptId = 'attempt-1';
      },
      (b) => {
        b.checkout.expected.dependency.bunVersion = '2.0.0';
      },
      (b) => {
        b.checkout.expected.dependency.linkerMode = 'hoisted';
      },
      (b) => {
        b.checkout.expected.dependency.lockfileHash = 'b'.repeat(64);
      },
      (b) => {
        b.checkout.expected.dependency.lockfileHash = 'b'.repeat(64);
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.dependency.platformNamespace = 'linux-x64';
      },
      (b) => {
        b.checkout.expected.dirty.count = 1;
      },
      (b) => {
        b.checkout.expected.dirty.hash = 'b'.repeat(64);
      },
      (b) => {
        b.checkout.expected.dirty.hash = 'b'.repeat(64);
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.head = 'b'.repeat(40);
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.head = 'b'.repeat(64);
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.identity.checkout.ino = 'changed';
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.identity.repository.ino = 'changed';
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.identity.admin.ino = 'changed';
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.expected.identity.adminPath =
          '/tmp/fixture/repo/worktrees/other';
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.checkout.wtDir = '/tmp/fixture/repo/other';
      },
      (b) => {
        b.checkout.repoDir = '/tmp/fixture/other';
        b.checkout.expected.identity.repositoryPath = '/tmp/fixture/other';
        b.targetDigest = targetDigestFor(b.checkout.expected);
      },
      (b) => {
        b.digests.dependencies = 'b'.repeat(64);
      },
      (b) => {
        b.digests.dirty = 'b'.repeat(64);
      },
      (b) => {
        b.digests.head = 'b'.repeat(64);
      },
      (b) => {
        b.digests.lockfile = 'b'.repeat(64);
      },
      (b) => {
        b.executionVersion = 2;
      },
      (b) => {
        b.generation += 1;
      },
      (b) => {
        b.inputArtifact.digest = 'b'.repeat(64);
      },
      (b) => {
        b.inputArtifact.id = `sha256:${'8'.repeat(64)}`;
      },
      (b) => {
        b.planVersion += 1;
      },
      (b) => {
        b.policy.attempt = 1;
      },
      (b) => {
        b.policy.attemptTimeoutMs = 60_000;
      },
      (b) => {
        b.policy.capture = 'partial';
      },
      (b) => {
        b.policy.effort = 'medium';
      },
      (b) => {
        b.policy.maxWorkers = 3;
      },
      (b) => {
        b.policy.model = 'other-model';
      },
      (b) => {
        b.policy.provider = 'other';
      },
      (b) => {
        b.policy.retries = 1;
      },
      (b) => {
        b.policy.subscriptionOnly = false;
      },
      (b) => {
        b.profile.digest = 'b'.repeat(64);
      },
      (b) => {
        b.profile.effort = 'medium';
      },
      (b) => {
        b.profile.id = 'codex:other:high';
      },
      (b) => {
        b.profile.model = 'other-model';
      },
      (b) => {
        b.profile.provider = 'other';
      },
      (b) => {
        b.requiredCapabilities.push('shell');
      },
      (b) => {
        b.runId = 'other-run';
      },
      (b) => {
        b.spanId = 'other';
      },
      (b) => {
        b.target.name = 'feat/other';
      },
      (b) => {
        b.target.repo = 'other';
      },
      (b) => {
        b.target.repo = 'setu/other';
      },
      (b) => {
        b.targetDigest = 'b'.repeat(64);
      },
    ];
    for (const mutation of mutations) {
      const f = fixture();
      try {
        const service = f.create();
        // biome-ignore lint/performance/noAwaitInLoops: Each case owns an isolated disposable archive.
        const prepared = await service.prepare(f.selector);
        expect(prepared.ok).toBe(true);
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        });
        f.setMutation((value) => {
          mutation(value);
          return value;
        });
        expect(
          await service.authorize({
            ...f.selector,
            reviewDigest: prepared.review.reviewDigest,
          })
        ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });
        expect(
          await service.prepare({ ...f.selector, approved: true })
        ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      } finally {
        f.store.close();
      }
    }
  });

  test('refuses invented/corrupt approvals and revocation remains append-only', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(
        await service.approve({
          confirmation: { approved: true, reference: 'invented' },
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      const noVerifier = createSpansExecutionReviews({
        resolveBinding: async (selector) => f.binding(selector),
        store: f.store,
        verifyWritable: async () => true,
      });
      expect(
        await noVerifier.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      expect(
        await noVerifier.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      expect(
        await noVerifier.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      const forgedRevocationVerifier = f.create(f.store, {
        verifyRevocation: async () => null,
      });
      expect(
        await forgedRevocationVerifier.revoke({
          confirmation: {
            confirmedAt: f.revoked.confirmedAt,
            reference: f.revoked.reference,
            source: 'trusted-revocation',
          },
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      expect(
        f.store.readRun({ runId: 'review-run' }).view.execution.receipts[
          prepared.review.reviewDigest
        ].revocations
      ).toHaveLength(0);
      const hostileVerifier = createSpansExecutionReviews({
        resolveBinding: async (selector) => f.binding(selector),
        store: f.store,
        verifyConfirmation: () => ({
          get source() {
            throw new Error('hostile verifier result');
          },
        }),
        verifyWritable: async () => true,
      });
      expect(
        await hostileVerifier.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: false });
      expect(
        await service.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      expect(
        await service.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_REVOKED', ok: false });
      const current = f.store.readRun({ runId: 'review-run' });
      expect(
        current.view.execution.receipts[prepared.review.reviewDigest]
          .revocations
      ).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });

  async function preserveMainViewForProfile(profileId) {
    const f = fixture(profileId);
    try {
      const initial = f.store.readRun({ runId: 'review-run' });
      const pluralExecutions = {
        'main-action-complete': {
          actionId: 'main-action-complete',
          completion: { digest: 'c'.repeat(64), state: 'complete' },
          generation: 0,
          state: 'complete',
        },
        'main-action-running': {
          actionId: 'main-action-running',
          bindingDigest: 'b'.repeat(64),
          generation: 0,
          state: 'running',
        },
      };
      const linksAssociations = {
        'links-association-main': {
          generation: 0,
          linkId: 'links-association-main',
          peer: 'peer-main',
          status: 'approved',
        },
      };
      const seededView = structuredClone(initial.view);
      seededView.executions = pluralExecutions;
      seededView.linksAssociations = linksAssociations;
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: initial.generation,
          expectedRevision: initial.revision,
          runId: 'review-run',
          view: seededView,
        }).ok
      ).toBe(true);
      const preservesMainView = () => {
        const current = f.store.readRun({ runId: 'review-run' });
        expect(current.view.executions).toEqual(pluralExecutions);
        expect(current.view.linksAssociations).toEqual(linksAssociations);
      };

      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(prepared).toMatchObject({ ok: true });
      const profile = PROFILE_FIXTURES[profileId];
      expect(prepared.review.binding.profile).toMatchObject({
        effort: profile.effort,
        id: profileId,
        model: profile.model,
        provider: profile.provider,
      });
      expect(prepared.review.binding.policy).toEqual(profile.policy);
      preservesMainView();
      expect(
        f.store.readRun({ runId: 'review-run' }).view.execution
      ).toMatchObject({
        reviews: { [prepared.review.reviewDigest]: prepared.review },
        version: 1,
      });

      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      preservesMainView();

      expect(
        await service.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true, replayed: false });
      preservesMainView();
      const receipt = f.store.readRun({ runId: 'review-run' }).view.execution
        .receipts[prepared.review.reviewDigest];
      expect(receipt.revocations).toEqual([
        {
          at: f.revoked.confirmedAt,
          reference: f.revoked.reference,
          source: f.revoked.source,
          version: 1,
        },
      ]);
      const { events } = f.store.readEvents({
        afterSequence: 0,
        limit: 100,
        runId: 'review-run',
      });
      const reviewEvents = events.filter((event) =>
        event.type.startsWith('spans.execution-review.')
      );
      expect(reviewEvents.map((event) => event.type)).toEqual([
        'spans.execution-review.prepared',
        'spans.execution-review.approved',
        'spans.execution-review.revoked',
      ]);
      expect(
        reviewEvents.find((event) => event.type.endsWith('.revoked'))?.payload
      ).toMatchObject({
        reference: f.revoked.reference,
        revokedAt: f.revoked.confirmedAt,
        source: f.revoked.source,
      });
    } finally {
      f.store.close();
    }
  }

  test('both built-in profiles preserve plural executions and Links associations in the real store', async () => {
    await Promise.all(
      ['claude-code-sonnet', 'codex:gpt-6-luna:high'].map(
        preserveMainViewForProfile
      )
    );
  });

  test('rejects unconfigured profiles and altered Claude policy ceilings', async () => {
    const f = fixture('claude-code-sonnet');
    try {
      f.setMutation((value) => {
        value.profile.id = 'openai:unknown:high';
        return value;
      });
      expect(await f.create().prepare(f.selector)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_CHANGED',
        ok: false,
      });
      f.setMutation((value) => {
        value.policy.attemptTimeoutMs = 1_800_000;
        return value;
      });
      expect(await f.create().prepare(f.selector)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_CHANGED',
        ok: false,
      });
    } finally {
      f.store.close();
    }
  });

  test('rejects malformed/future execution versions and digest corruption', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      const base = f.store.readRun({ runId: 'review-run' });
      const corrupt = structuredClone(base.view);
      corrupt.execution.reviews[
        prepared.review.reviewDigest
      ].binding.policy.maxWorkers = 7;
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: base.generation,
          expectedRevision: base.revision,
          runId: 'review-run',
          view: corrupt,
        }).ok
      ).toBe(true);
      expect(
        await service.read({
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await service.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
    } finally {
      f.store.close();
    }
    const newer = fixture();
    try {
      const service = newer.create();
      const prepared = await service.prepare(newer.selector);
      const before = newer.store.readRun({ runId: 'review-run' });
      const view = structuredClone(before.view);
      view.execution.version = 2;
      view.execution.futureField = true;
      newer.store.commitRun({
        events: [],
        expectedGeneration: before.generation,
        expectedRevision: before.revision,
        runId: 'review-run',
        view,
      });
      expect(await service.prepare(newer.selector)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_INVALID',
        ok: false,
      });
      expect(
        await service.read({
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await service.approve({
          confirmation: newer.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await service.authorize({
          ...newer.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
    } finally {
      newer.store.close();
    }
  });

  test('CAS preserves concurrent reviews; uncertain commits never report success', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const results = await Promise.all([
        service.prepare(f.selector),
        service.prepare({ ...f.selector, actionId: 'action-2' }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(2);
      const {
        view: {
          execution: { reviews: saved },
        },
      } = f.store.readRun({ runId: 'review-run' });
      expect(Object.keys(saved)).toHaveLength(2);
      const { review } = results.find((result) => result.ok);
      const uncertain = f.wrapUncertain();
      expect(
        await uncertain.approve({
          confirmation: f.confirmation,
          reviewDigest: review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_UNKNOWN',
        ok: false,
        unknown: true,
      });
      expect(
        f.store.readRun({ runId: 'review-run' }).view.execution.receipts[
          review.reviewDigest
        ].approvals
      ).toHaveLength(1);
      expect(
        await uncertain.prepare({ ...f.selector, actionId: 'action-3' })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_UNKNOWN',
        ok: false,
        unknown: true,
      });
      const afterPrepare = f.store.readRun({ runId: 'review-run' });
      expect(Object.keys(afterPrepare.view.execution.reviews)).toHaveLength(3);
      const throwing = f.wrapUncertain({ throws: true });
      expect(
        await throwing.revoke({
          confirmation: f.revocationProof,
          reviewDigest: review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_UNKNOWN',
        ok: false,
        unknown: true,
      });
      expect(
        f.store.readRun({ runId: 'review-run' }).view.execution.receipts[
          review.reviewDigest
        ].revocations
      ).toHaveLength(1);
    } finally {
      f.store.close();
    }
  });

  test('revalidates revision after a delayed verifier, including a concurrent revocation', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await prepareAndApprove(f, service);
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = f.create(f.store, {
        verifyConfirmation: async ({ confirmation: _confirmation }) => {
          await wait;
          return f.verified;
        },
      });
      const pending = delayed.authorize({
        ...f.selector,
        reviewDigest: prepared.review.reviewDigest,
      });
      await Promise.resolve();
      await service.revoke({
        confirmation: f.revocationProof,
        reviewDigest: prepared.review.reviewDigest,
        runId: 'review-run',
      });
      release();
      expect(await pending).toMatchObject({ ok: false });
    } finally {
      f.store.close();
    }
  });

  test('rechecks plan revision after delayed approval verifier and fails on hostile callbacks', async () => {
    const f = fixture();
    try {
      const prepared = await f.create().prepare(f.selector);
      let release;
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = f.create(f.store, {
        verifyConfirmation: async () => {
          entered();
          await wait;
          return f.verified;
        },
      });
      const pending = delayed.approve({
        confirmation: f.confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: 'review-run',
      });
      await started;
      const current = f.store.readRun({ runId: 'review-run' });
      expect(
        f.drafts.revisePlan({
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          goal: 'Changed plan',
          runId: 'review-run',
          spans: [{ dependencies: [], spanId: 'ship', title: 'Changed' }],
        }).ok
      ).toBe(true);
      release();
      expect(await pending).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_CHANGED',
        ok: false,
      });
      const hostile = f.create(f.store, {
        verifyConfirmation: () => Promise.reject(new Error('hostile')),
      });
      expect(
        await hostile.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: false });
    } finally {
      f.store.close();
    }
  });

  test('serializes a concurrent approval against trusted revocation with a final run reread', async () => {
    async function race(winner) {
      const f = fixture();
      let releaseApproval;
      let releaseRevocation;
      let approvalEntered;
      let revocationEntered;
      try {
        const base = f.create();
        const prepared = await base.prepare(f.selector);
        expect(prepared.ok).toBe(true);
        expect(
          await base.approve({
            confirmation: f.confirmation,
            reviewDigest: prepared.review.reviewDigest,
            runId: 'review-run',
          })
        ).toMatchObject({ ok: true });
        const approvalReady = new Promise((resolve) => {
          approvalEntered = resolve;
        });
        const revocationReady = new Promise((resolve) => {
          revocationEntered = resolve;
        });
        const approvalGate = new Promise((resolve) => {
          releaseApproval = resolve;
        });
        const revocationGate = new Promise((resolve) => {
          releaseRevocation = resolve;
        });
        const delayed = f.create(f.store, {
          verifyConfirmation: async () => {
            approvalEntered();
            await approvalGate;
            return { ...f.verified, reference: 'human-confirm-2' };
          },
          verifyRevocation: async () => {
            revocationEntered();
            await revocationGate;
            return f.revoked;
          },
        });
        const approvalPending = delayed.approve({
          confirmation: { reference: 'human-confirm-2', valid: true },
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        });
        const revocationPending = delayed.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        });
        await Promise.all([approvalReady, revocationReady]);

        let approvalResult;
        let revocationResult;
        if (winner === 'approval') {
          releaseApproval();
          approvalResult = await approvalPending;
          releaseRevocation();
          revocationResult = await revocationPending;
        } else {
          releaseRevocation();
          revocationResult = await revocationPending;
          releaseApproval();
          approvalResult = await approvalPending;
        }

        if (winner === 'approval') {
          expect(approvalResult).toMatchObject({ ok: true, replayed: false });
          expect(revocationResult).toMatchObject({
            code: 'SPANS_EXECUTION_REVIEW_CHANGED',
            ok: false,
          });
        } else {
          expect(revocationResult).toMatchObject({ ok: true, replayed: false });
          expect(approvalResult).toMatchObject({
            code: 'SPANS_EXECUTION_REVIEW_CHANGED',
            ok: false,
          });
        }
        const receipt = f.store.readRun({ runId: 'review-run' }).view.execution
          .receipts[prepared.review.reviewDigest];
        expect(receipt.approvals).toHaveLength(winner === 'approval' ? 2 : 1);
        expect(receipt.revocations).toHaveLength(winner === 'approval' ? 0 : 1);
      } finally {
        releaseApproval?.();
        releaseRevocation?.();
        f.store.close();
      }
    }

    await race('approval');
    await race('revocation');
  });

  test('rechecks an idempotent approval replay after delayed final resolution and concurrent revoke', async () => {
    const f = fixture();
    let release;
    try {
      const service = f.create();
      const prepared = await prepareAndApprove(f, service);
      let entered;
      let resolveCount = 0;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = f.create(f.store, {
        resolveBinding: async (selector) => {
          resolveCount += 1;
          if (resolveCount === 2) {
            entered();
            await wait;
          }
          return f.binding(selector);
        },
      });
      const pending = delayed.approve({
        confirmation: f.confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: 'review-run',
      });
      await started;
      expect(
        await service.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      release();
      expect(await pending).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_CHANGED',
        ok: false,
      });
    } finally {
      release?.();
      f.store.close();
    }
  });

  test('rejects authorization when the run changes during delayed binding resolution', async () => {
    const f = fixture();
    try {
      const base = f.create();
      const prepared = await prepareAndApprove(f, base);
      let release;
      let entered;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      const delayed = f.create(f.store, {
        resolveBinding: async (selector) => {
          entered();
          await wait;
          return f.binding(selector);
        },
      });
      const pending = delayed.authorize({
        ...f.selector,
        reviewDigest: prepared.review.reviewDigest,
      });
      await started;
      const current = f.store.readRun({ runId: 'review-run' });
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          runId: 'review-run',
          view: current.view,
        }).ok
      ).toBe(true);
      release();
      expect(await pending).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_CHANGED',
        ok: false,
      });
    } finally {
      f.store.close();
    }
  });

  test('refuses approval and authorization when the trusted archive is read-only', async () => {
    const f = fixture();
    try {
      const writableService = f.create();
      const prepared = await writableService.prepare(f.selector);
      await writableService.approve({
        confirmation: f.confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: 'review-run',
      });
      f.store.close();
      const readonly = openSpansStore({
        create: false,
        readonly: true,
        root: f.root,
      });
      try {
        const service = f.create(readonly, {
          verifyWritable: async () => false,
        });
        expect(
          await service.approve({
            confirmation: f.confirmation,
            reviewDigest: prepared.review.reviewDigest,
            runId: 'review-run',
          })
        ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_STORAGE', ok: false });
        expect(
          await service.authorize({
            ...f.selector,
            reviewDigest: prepared.review.reviewDigest,
          })
        ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_STORAGE', ok: false });
        expect(
          await service.read({
            reviewDigest: prepared.review.reviewDigest,
            runId: 'review-run',
          })
        ).toMatchObject({ ok: true });
      } finally {
        readonly.close();
      }
    } finally {
      try {
        f.store.close();
      } catch {
        // The writable handle was closed before reopening the archive read-only.
      }
    }
  });

  test('rejects an imported-kind view after its readOnly flag is cleared', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });

      let current = f.store.readRun({ runId: 'review-run' });
      const imported = structuredClone(current.view);
      imported.kind = 'imported';
      imported.readOnly = true;
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          runId: 'review-run',
          view: imported,
        }).ok
      ).toBe(true);

      current = f.store.readRun({ runId: 'review-run' });
      const writableImported = structuredClone(current.view);
      writableImported.readOnly = false;
      expect(
        f.store.commitRun({
          events: [],
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          runId: 'review-run',
          view: writableImported,
        }).ok
      ).toBe(true);
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await service.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
    } finally {
      f.store.close();
    }
  });

  test('rejects hostile resolver getters, raw input, read-only stores, and source-import records', async () => {
    const f = fixture();
    try {
      const hostile = f.create(f.store, {
        resolveBinding: () => ({
          get runId() {
            throw new Error('no');
          },
        }),
      });
      expect(await hostile.prepare(f.selector)).toMatchObject({ ok: false });
      expect(
        await f
          .create()
          .prepare({ ...f.selector, input: { arbitrary: 'raw secret' } })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      expect(
        await f
          .create()
          .prepare({ ...f.selector, input: { oversized: 'x'.repeat(70_000) } })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
      const readonlyRoot = fs.mkdtempSync(
        join(tmpdir(), 'setu-spans-execution-readonly-')
      );
      roots.add(readonlyRoot);
      const writable = openSpansStore({ root: readonlyRoot });
      createSpansDrafts({ store: writable }).createRun({
        goal: 'Read only fixture',
        owner: 'test',
        runId: 'review-run',
        spans: [{ dependencies: [], spanId: 'ship', title: 'Ship' }],
      });
      writable.close();
      const readonly = openSpansStore({
        create: false,
        readonly: true,
        root: readonlyRoot,
      });
      expect(
        await f
          .create(readonly, { verifyWritable: async () => false })
          .prepare(f.selector)
      ).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_STORAGE',
        ok: false,
      });
      readonly.close();
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      const imported = f.store.readRun({ runId: 'review-run' });
      const importedCommit = f.store.commitRun({
        events: [
          {
            eventId: createHash('sha256').update('source').digest('hex'),
            payload: { sourceId: 'source-1' },
            runId: 'review-run',
            type: 'source.message',
          },
        ],
        expectedGeneration: imported.generation,
        expectedRevision: imported.revision,
        runId: 'review-run',
        view: imported.view,
      });
      expect(importedCommit.ok).toBe(true);
      expect(await f.create().prepare(f.selector)).toMatchObject({
        ok: true,
        replayed: true,
      });
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: 'review-run',
        })
      ).toMatchObject({ ok: true });
      expect(
        await service.authorize({
          ...f.selector,
          reviewDigest: prepared.review.reviewDigest,
        })
      ).toMatchObject({ ok: true });
    } finally {
      f.store.close();
    }
  });

  test('synchronously checks only the exact current approval receipt and its events', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      expect(prepared.ok).toBe(true);
      expect(
        await service.approve({
          confirmation: f.confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ ok: true });
      const selector = {
        ...f.selector,
        reviewDigest: prepared.review.reviewDigest,
      };
      const authorized = await service.authorize(selector);
      expect(authorized.ok).toBe(true);
      const current = service.checkApprovalCurrent(
        selector,
        authorized.approval
      );
      expect(current).toEqual({
        current: true,
        evidence: {
          confirmedAt: f.verified.confirmedAt,
          executionVersion: 1,
          reference: f.verified.reference,
          reviewDigest: prepared.review.reviewDigest,
          source: f.verified.source,
        },
        ok: true,
      });
      expect(current instanceof Promise).toBe(false);
      const noCallbacks = f.create(f.store, {
        resolveBinding: () => {
          throw new Error('current check must not resolve a binding');
        },
        verifyConfirmation: () => {
          throw new Error('current check must not verify asynchronously');
        },
        verifyWritable: () => {
          throw new Error('current check must not request a write gate');
        },
      });
      expect(
        noCallbacks.checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ current: true, ok: true });

      const mutations = [
        (approval) => {
          approval.confirmation.reference = 'other-confirmation';
        },
        (approval) => {
          approval.confirmation.source = 'invented-source';
        },
        (approval) => {
          approval.confirmation.confirmedAt = '2026-10-20T10:01:00.000Z';
        },
        (approval) => {
          approval.reviewDigest = 'b'.repeat(64);
        },
        (approval) => {
          approval.executionVersion = 2;
        },
      ];
      for (const mutate of mutations) {
        const expected = structuredClone(authorized.approval);
        mutate(expected);
        expect(service.checkApprovalCurrent(selector, expected)).toMatchObject({
          ok: false,
        });
      }
      expect(
        service.checkApprovalCurrent(
          { ...selector, generation: selector.generation + 1 },
          authorized.approval
        )
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });
      expect(
        service.checkApprovalCurrent(
          { ...selector, planVersion: selector.planVersion + 1 },
          authorized.approval
        )
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });

      const missingApprovalEventStore = {
        ...f.store,
        getEventById(query) {
          const result = f.store.getEventById(query);
          return result.event?.type === 'spans.execution-review.approved'
            ? { event: null, found: false, ok: true }
            : result;
        },
      };
      expect(
        f
          .create(missingApprovalEventStore)
          .checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });

      const fabricatedApprovalEventStore = {
        ...f.store,
        getEventById(query) {
          const result = f.store.getEventById(query);
          if (result.event?.type !== 'spans.execution-review.approved') {
            return result;
          }
          return {
            ...result,
            event: {
              ...result.event,
              payload: {
                ...result.event.payload,
                confirmation: {
                  ...result.event.payload.confirmation,
                  source: 'fabricated-source',
                },
              },
            },
          };
        },
      };
      expect(
        f
          .create(fabricatedApprovalEventStore)
          .checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });

      expect(
        await service.revoke({
          confirmation: f.revocationProof,
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ ok: true });
      expect(
        service.checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_REVOKED', ok: false });
    } finally {
      f.store.close();
    }
  });

  test('synchronous receipt check follows current persisted generation and plan', async () => {
    const f = fixture();
    try {
      const service = f.create();
      const prepared = await service.prepare(f.selector);
      await service.approve({
        confirmation: f.confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: f.selector.runId,
      });
      const selector = {
        ...f.selector,
        reviewDigest: prepared.review.reviewDigest,
      };
      const authorized = await service.authorize(selector);
      const current = f.store.readRun({ runId: f.selector.runId });
      expect(
        f.drafts.revisePlan({
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          goal: 'Changed plan',
          runId: f.selector.runId,
          spans: [{ dependencies: [], spanId: 'ship', title: 'Changed' }],
        }).ok
      ).toBe(true);
      expect(
        service.checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_CHANGED', ok: false });
    } finally {
      f.store.close();
    }
  });
});
