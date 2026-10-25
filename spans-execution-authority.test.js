import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targetDigestFor } from './spans-dispatch.js';
import { createSpansDrafts } from './spans-drafts.js';
import { createSpansExecutionAuthority } from './spans-execution-authority.js';
import { openSpansStore } from './spans-store.js';

const roots = new Set();
const seededExecutions = Object.freeze({
  'main-action-running': {
    actionId: 'main-action-running',
    bindingDigest: 'b'.repeat(64),
    generation: 0,
    state: 'running',
  },
});

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture({ writeArchive, resolveBinding } = {}) {
  const root = fs.mkdtempSync(
    join(tmpdir(), 'setu-spans-execution-authority-')
  );
  roots.add(root);
  let store = openSpansStore({ root });
  const drafts = createSpansDrafts({ store });
  drafts.createRun({
    goal: 'Review safely',
    owner: 'test',
    runId: 'authority-run',
    spans: [{ dependencies: [], spanId: 'ship', title: 'Ship' }],
  });
  const beforeSeed = store.readRun({ runId: 'authority-run' });
  const seeded = structuredClone(beforeSeed.view);
  seeded.executions = structuredClone(seededExecutions);
  store.commitRun({
    events: [],
    expectedGeneration: beforeSeed.generation,
    expectedRevision: beforeSeed.revision,
    runId: 'authority-run',
    view: seeded,
  });

  const selector = {
    actionId: 'action-1',
    attemptId: 'attempt-0',
    generation: 0,
    planVersion: 1,
    runId: 'authority-run',
    spanId: 'ship',
  };
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
    return {
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
      inputArtifact: {
        digest: '8'.repeat(64),
        id: `sha256:${'9'.repeat(64)}`,
      },
      planVersion: current.planVersion,
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
      profile: {
        digest: 'a'.repeat(64),
        effort: 'high',
        id: 'codex:gpt-6-luna:high',
        model: 'gpt-6-luna',
        provider: 'codex',
      },
      requiredCapabilities: ['run'],
      runId: current.runId,
      spanId: current.spanId,
      target: { name: 'feat/spans', repo: 'setu' },
      targetDigest: targetDigestFor(expected),
    };
  };
  const defaultWriter = async (effect) => await effect();
  const makeAuthority = (options = {}) =>
    createSpansExecutionAuthority({
      now: options.now,
      randomBytes: options.randomBytes,
      resolveBinding:
        options.resolveBinding ??
        resolveBinding ??
        (async (current) => binding(current)),
      store: options.store ?? store,
      writeArchive: options.writeArchive ?? writeArchive ?? defaultWriter,
    });

  return {
    binding,
    closeCurrentStore() {
      const result = store.close();
      store = null;
      return result;
    },
    drafts,
    makeAuthority,
    reopenStore() {
      store = openSpansStore({ create: false, root });
      return store;
    },
    root,
    selector,
    get store() {
      return store;
    },
  };
}

async function makeTypedApproval(authority, selector, reviewDigest) {
  const issued = await authority.issue({
    intent: 'approve',
    reviewDigest,
    runId: selector.runId,
  });
  expect(issued.ok).toBe(true);
  return {
    confirmation: {
      challengeId: issued.challengeId,
      response: issued.phrase,
    },
    issued,
  };
}

describe('Spans execution authority facade', () => {
  test('composes separate prepare, typed issue, approve, authorize, and current receipt checks', async () => {
    const f = fixture();
    const authority = f.makeAuthority();
    try {
      const prepared = await authority.prepare(f.selector);
      expect(prepared).toMatchObject({ ok: true, replayed: false });
      const afterPrepare = f.store.readRun({ runId: f.selector.runId });
      expect(
        await authority.read({
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ ok: true, review: prepared.review });
      expect(f.store.readRun({ runId: f.selector.runId }).revision).toBe(
        afterPrepare.revision
      );
      const { confirmation, issued } = await makeTypedApproval(
        authority,
        f.selector,
        prepared.review.reviewDigest
      );
      expect(issued.intent).toBe('approve');
      expect(f.store.readRun({ runId: f.selector.runId }).revision).toBe(
        afterPrepare.revision
      );
      expect(
        await authority.approve({
          confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({
        approval: {
          confirmation: {
            reference: issued.challengeId,
            source: 'portal-human-confirmation',
          },
          executionVersion: 1,
          reviewDigest: prepared.review.reviewDigest,
        },
        ok: true,
      });

      const selector = {
        ...f.selector,
        reviewDigest: prepared.review.reviewDigest,
      };
      const authorized = await authority.authorize(selector);
      expect(authorized).toMatchObject({ ok: true });
      expect(
        authority.checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({
        current: true,
        evidence: {
          executionVersion: 1,
          reference: issued.challengeId,
          reviewDigest: prepared.review.reviewDigest,
          source: 'portal-human-confirmation',
        },
        ok: true,
      });

      const run = f.store.readRun({ runId: f.selector.runId });
      expect(run.view.executions).toEqual(seededExecutions);
      expect(run.view.execution.version).toBe(1);
      expect(
        run.view.execution.receipts[prepared.review.reviewDigest].approvals
      ).toHaveLength(1);
      expect(
        await authority.approve({
          confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });

  test('checksum-only and fabricated provenance cannot approve or authorize', async () => {
    const f = fixture();
    const authority = f.makeAuthority();
    try {
      const prepared = await authority.prepare(f.selector);
      const digest = prepared.review.reviewDigest;
      expect(
        await authority.approve({
          confirmation: {
            confirmedAt: '2026-10-20T10:00:00.000Z',
            reference: digest,
            source: 'human-review',
          },
          reviewDigest: digest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });
      expect(
        await authority.authorize({ ...f.selector, reviewDigest: digest })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_UNAPPROVED', ok: false });
      expect(
        await authority.prepare({ ...f.selector, approved: true })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });

  test('confirmation challenges are one use and cannot cross approval and revocation intents', async () => {
    const f = fixture();
    const authority = f.makeAuthority();
    try {
      const prepared = await authority.prepare(f.selector);
      const digest = prepared.review.reviewDigest;
      const firstApproval = await makeTypedApproval(
        authority,
        f.selector,
        digest
      );
      await authority.approve({
        confirmation: firstApproval.confirmation,
        reviewDigest: digest,
        runId: f.selector.runId,
      });
      const selector = { ...f.selector, reviewDigest: digest };
      const authorized = await authority.authorize(selector);
      expect(authorized.ok).toBe(true);
      expect(
        await authority.approve({
          confirmation: firstApproval.confirmation,
          reviewDigest: digest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });

      const revocation = await authority.issue({
        intent: 'revoke',
        reviewDigest: digest,
        runId: f.selector.runId,
      });
      expect(revocation).toMatchObject({ intent: 'revoke', ok: true });
      const revokeProof = {
        challengeId: revocation.challengeId,
        response: revocation.phrase,
      };
      expect(
        await authority.approve({
          confirmation: revokeProof,
          reviewDigest: digest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_APPROVAL', ok: false });

      const nextRevocation = await authority.issue({
        intent: 'revoke',
        reviewDigest: digest,
        runId: f.selector.runId,
      });
      expect(
        await authority.revoke({
          confirmation: {
            challengeId: nextRevocation.challengeId,
            response: nextRevocation.phrase,
          },
          reviewDigest: digest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ ok: true, replayed: false });
      expect(await authority.authorize(selector)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_REVOKED',
        ok: false,
      });
      expect(
        authority.checkApprovalCurrent(selector, authorized.approval)
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_REVOKED', ok: false });
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });

  test('reopens from the same real store without minting another approval', async () => {
    const f = fixture();
    const first = f.makeAuthority();
    try {
      const prepared = await first.prepare(f.selector);
      const { confirmation } = await makeTypedApproval(
        first,
        f.selector,
        prepared.review.reviewDigest
      );
      await first.approve({
        confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: f.selector.runId,
      });
      const digest = prepared.review.reviewDigest;
      const approvalsBefore = f.store.readRun({ runId: f.selector.runId }).view
        .execution.receipts[digest].approvals;
      expect(approvalsBefore).toHaveLength(1);
      await first.close();
      f.closeCurrentStore();

      f.reopenStore();
      const restarted = f.makeAuthority();
      const selector = { ...f.selector, reviewDigest: digest };
      expect(
        await restarted.read({ reviewDigest: digest, runId: f.selector.runId })
      ).toMatchObject({ ok: true, review: prepared.review });
      expect(await restarted.authorize(selector)).toMatchObject({
        approval: {
          executionVersion: 1,
          reviewDigest: digest,
        },
        ok: true,
      });
      expect(
        f.store.readRun({ runId: f.selector.runId }).view.execution.receipts[
          digest
        ].approvals
      ).toEqual(approvalsBefore);
      expect(
        f.store.readRun({ runId: f.selector.runId }).view.executions
      ).toEqual(seededExecutions);
      await restarted.close();
    } finally {
      if (f.store) {
        f.closeCurrentStore();
      }
    }
  });

  test('a refused parent gate leaves the review, approval, and receipt unchanged', async () => {
    const f = fixture();
    const initial = f.makeAuthority();
    try {
      const prepared = await initial.prepare(f.selector);
      const { confirmation } = await makeTypedApproval(
        initial,
        f.selector,
        prepared.review.reviewDigest
      );
      await initial.approve({
        confirmation,
        reviewDigest: prepared.review.reviewDigest,
        runId: f.selector.runId,
      });
      await initial.close();
      const before = f.store.readRun({ runId: f.selector.runId });
      const refused = f.makeAuthority({
        writeArchive: async () => ({ code: 'ARCHIVE_BUSY', ok: false }),
      });
      const digest = prepared.review.reviewDigest;
      try {
        expect(
          await refused.prepare({ ...f.selector, actionId: 'action-2' })
        ).toMatchObject({ code: 'ARCHIVE_BUSY', ok: false });
        const proof = await makeTypedApproval(refused, f.selector, digest);
        expect(
          await refused.approve({
            confirmation: proof.confirmation,
            reviewDigest: digest,
            runId: f.selector.runId,
          })
        ).toMatchObject({ code: 'ARCHIVE_BUSY', ok: false });
        const revoke = await refused.issue({
          intent: 'revoke',
          reviewDigest: digest,
          runId: f.selector.runId,
        });
        expect(
          await refused.revoke({
            confirmation: {
              challengeId: revoke.challengeId,
              response: revoke.phrase,
            },
            reviewDigest: digest,
            runId: f.selector.runId,
          })
        ).toMatchObject({ code: 'ARCHIVE_BUSY', ok: false });
        expect(
          await refused.authorize({ ...f.selector, reviewDigest: digest })
        ).toMatchObject({ code: 'ARCHIVE_BUSY', ok: false });
        const after = f.store.readRun({ runId: f.selector.runId });
        expect(after.revision).toBe(before.revision);
        expect(after.view).toEqual(before.view);
      } finally {
        await refused.close();
      }
    } finally {
      await initial.close();
      f.closeCurrentStore();
    }
  });

  test('approve and revoke preserve bounded hostile request refusal without reading caller properties', async () => {
    const f = fixture();
    const authority = f.makeAuthority();
    try {
      const prepared = await authority.prepare(f.selector);
      const digest = prepared.review.reviewDigest;
      const approval = await makeTypedApproval(authority, f.selector, digest);
      const beforeApproval = f.store.readRun({ runId: f.selector.runId });
      const beforeApprovalEvents = f.store.readEvents({
        afterSequence: 0,
        limit: 100,
        runId: f.selector.runId,
      }).events;

      let approvalGetterReads = 0;
      const approvalWithGetter = {
        confirmation: approval.confirmation,
        reviewDigest: digest,
      };
      Object.defineProperty(approvalWithGetter, 'runId', {
        enumerable: true,
        get() {
          approvalGetterReads += 1;
          return f.selector.runId;
        },
      });
      expect(await authority.approve(approvalWithGetter)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_INVALID',
        ok: false,
      });
      expect(approvalGetterReads).toBe(0);

      let approvalProxyReads = 0;
      const approvalWithUnsupportedFlag = new Proxy(
        {
          approved: true,
          confirmation: approval.confirmation,
          reviewDigest: digest,
          runId: f.selector.runId,
        },
        {
          get(target, key, receiver) {
            approvalProxyReads += 1;
            return Reflect.get(target, key, receiver);
          },
        }
      );
      expect(
        await authority.approve(approvalWithUnsupportedFlag)
      ).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_INVALID',
        ok: false,
      });
      expect(approvalProxyReads).toBe(0);

      const beforeApprovalCheck = f.store.readRun({
        runId: f.selector.runId,
      });
      expect(beforeApprovalCheck.revision).toBe(beforeApproval.revision);
      expect(beforeApprovalCheck.view).toEqual(beforeApproval.view);
      expect(
        f.store.readEvents({
          afterSequence: 0,
          limit: 100,
          runId: f.selector.runId,
        }).events
      ).toEqual(beforeApprovalEvents);
      expect(
        beforeApprovalCheck.view.execution.receipts[digest]
      ).toBeUndefined();

      expect(
        await authority.approve({
          confirmation: approval.confirmation,
          reviewDigest: digest,
          runId: f.selector.runId,
        })
      ).toMatchObject({ ok: true });
      const revocation = await authority.issue({
        intent: 'revoke',
        reviewDigest: digest,
        runId: f.selector.runId,
      });
      expect(revocation.ok).toBe(true);
      const beforeRevocation = f.store.readRun({ runId: f.selector.runId });
      const beforeRevocationEvents = f.store.readEvents({
        afterSequence: 0,
        limit: 100,
        runId: f.selector.runId,
      }).events;

      let revokeGetterReads = 0;
      const revokeWithGetter = {
        confirmation: {
          challengeId: revocation.challengeId,
          response: revocation.phrase,
        },
        reviewDigest: digest,
      };
      Object.defineProperty(revokeWithGetter, 'runId', {
        enumerable: true,
        get() {
          revokeGetterReads += 1;
          return f.selector.runId;
        },
      });
      expect(await authority.revoke(revokeWithGetter)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_INVALID',
        ok: false,
      });
      expect(revokeGetterReads).toBe(0);

      let revokeProxyReads = 0;
      const revokeWithUnsupportedFlag = new Proxy(
        {
          confirmation: {
            challengeId: revocation.challengeId,
            response: revocation.phrase,
          },
          reviewDigest: digest,
          revoke: true,
          runId: f.selector.runId,
        },
        {
          get(target, key, receiver) {
            revokeProxyReads += 1;
            return Reflect.get(target, key, receiver);
          },
        }
      );
      expect(await authority.revoke(revokeWithUnsupportedFlag)).toMatchObject({
        code: 'SPANS_EXECUTION_REVIEW_INVALID',
        ok: false,
      });
      expect(revokeProxyReads).toBe(0);

      const after = f.store.readRun({ runId: f.selector.runId });
      expect(after.revision).toBe(beforeRevocation.revision);
      expect(after.view).toEqual(beforeRevocation.view);
      expect(
        f.store.readEvents({
          afterSequence: 0,
          limit: 100,
          runId: f.selector.runId,
        }).events
      ).toEqual(beforeRevocationEvents);
      expect(after.view.execution.receipts[digest].approvals).toHaveLength(1);
      expect(after.view.execution.receipts[digest].revocations).toEqual([]);
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });

  test('a parent success that differs from a refused effect is reported unknown', async () => {
    const f = fixture({
      writeArchive: async (effect) => {
        await effect();
        return { ok: true };
      },
    });
    const authority = f.makeAuthority();
    try {
      const result = await authority.prepare({
        ...f.selector,
        unsupported: true,
      });
      expect(result).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_UNKNOWN',
        ok: false,
      });
      expect(result.ok).not.toBe(true);
      expect(
        f.store.readRun({ runId: f.selector.runId }).view.execution
      ).toBeUndefined();
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }

    const mutated = fixture({
      writeArchive: async (effect) => {
        const result = await effect();
        result.ok = true;
        return result;
      },
    });
    const mutatedAuthority = mutated.makeAuthority();
    try {
      expect(
        await mutatedAuthority.prepare({
          ...mutated.selector,
          unsupported: true,
        })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_UNKNOWN',
        ok: false,
      });
      expect(
        mutated.store.readRun({ runId: mutated.selector.runId }).view.execution
      ).toBeUndefined();
    } finally {
      await mutatedAuthority.close();
      mutated.closeCurrentStore();
    }
  });

  test('a parent throw after an approval commit leaves the outcome unknown', async () => {
    let throwAfterEffect = false;
    const f = fixture({
      writeArchive: async (effect) => {
        const result = await effect();
        if (throwAfterEffect) {
          throw new Error('parent lost the effect result');
        }
        return result;
      },
    });
    const authority = f.makeAuthority();
    try {
      const prepared = await authority.prepare(f.selector);
      const { confirmation } = await makeTypedApproval(
        authority,
        f.selector,
        prepared.review.reviewDigest
      );
      throwAfterEffect = true;

      expect(
        await authority.approve({
          confirmation,
          reviewDigest: prepared.review.reviewDigest,
          runId: f.selector.runId,
        })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_UNKNOWN',
        ok: false,
      });
      const digest = prepared.review.reviewDigest;
      const current = f.store.readRun({ runId: f.selector.runId });
      expect(current.view.execution.receipts[digest].approvals).toHaveLength(1);
      expect(
        f.store
          .readEvents({ afterSequence: 0, limit: 100, runId: f.selector.runId })
          .events.filter(
            (event) => event.type === 'spans.execution-review.approved'
          )
      ).toHaveLength(1);
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });

  test('matching effect results and trusted parent admission refusals retain their outcomes', async () => {
    const f = fixture({ writeArchive: (effect) => effect() });
    const authority = f.makeAuthority();
    try {
      expect(await authority.prepare(f.selector)).toMatchObject({
        ok: true,
        replayed: false,
      });
      expect(
        await authority.prepare({ ...f.selector, unsupported: true })
      ).toMatchObject({ code: 'SPANS_EXECUTION_REVIEW_INVALID', ok: false });
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }

    const refused = fixture();
    const admissionRefusal = { code: 'ARCHIVE_BUSY', ok: false };
    const refusedAuthority = refused.makeAuthority({
      writeArchive: async () => admissionRefusal,
    });
    try {
      expect(await refusedAuthority.prepare(refused.selector)).toBe(
        admissionRefusal
      );
      expect(
        refused.store.readRun({ runId: refused.selector.runId }).view.execution
      ).toBeUndefined();
    } finally {
      await refusedAuthority.close();
      refused.closeCurrentStore();
    }
  });

  test('missing, late, and duplicate parent effect calls are refused safely', async () => {
    const missing = fixture({ writeArchive: async () => ({ ok: true }) });
    const missingAuthority = missing.makeAuthority();
    try {
      expect(await missingAuthority.prepare(missing.selector)).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_GATE',
        ok: false,
      });
      expect(
        missing.store.readRun({ runId: missing.selector.runId }).view.execution
      ).toBeUndefined();
    } finally {
      await missingAuthority.close();
      missing.closeCurrentStore();
    }

    let lateEffect;
    const late = fixture({
      writeArchive: (effect) => {
        lateEffect = effect;
        return Promise.resolve({ ok: true });
      },
    });
    const lateAuthority = late.makeAuthority();
    try {
      expect(await lateAuthority.prepare(late.selector)).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_GATE',
        ok: false,
      });
      expect(await lateEffect()).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_GATE',
        ok: false,
      });
      expect(
        late.store.readRun({ runId: late.selector.runId }).view.execution
      ).toBeUndefined();
    } finally {
      await lateAuthority.close();
      late.closeCurrentStore();
    }

    const duplicate = fixture({
      writeArchive: async (effect) => {
        await effect();
        return await effect();
      },
    });
    const duplicateAuthority = duplicate.makeAuthority();
    try {
      expect(
        await duplicateAuthority.prepare(duplicate.selector)
      ).toMatchObject({ code: 'SPANS_EXECUTION_AUTHORITY_UNKNOWN', ok: false });
      const { events } = duplicate.store.readEvents({
        afterSequence: 0,
        limit: 100,
        runId: duplicate.selector.runId,
      });
      expect(
        events.filter(
          (event) => event.type === 'spans.execution-review.prepared'
        )
      ).toHaveLength(1);
    } finally {
      await duplicateAuthority.close();
      duplicate.closeCurrentStore();
    }
  });

  test('close rejects new calls and drains a pending effect before closing confirmation', async () => {
    let enteredResolve;
    let finishResolve;
    const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    });
    const finish = new Promise((resolve) => {
      finishResolve = resolve;
    });
    const f = fixture({
      resolveBinding: async (selector) => {
        enteredResolve();
        await finish;
        return f.binding(selector);
      },
    });
    const authority = f.makeAuthority();
    try {
      const pendingPrepare = authority.prepare(f.selector);
      await entered;
      let didClose = false;
      const pendingClose = authority.close().then((result) => {
        didClose = true;
        return result;
      });
      expect(
        await authority.issue({
          reviewDigest: 'a'.repeat(64),
          runId: f.selector.runId,
        })
      ).toMatchObject({ code: 'SPANS_EXECUTION_AUTHORITY_CLOSED', ok: false });
      await Promise.resolve();
      expect(didClose).toBe(false);
      finishResolve();
      expect(await pendingPrepare).toMatchObject({ ok: true, replayed: false });
      expect(await pendingClose).toMatchObject({ ok: true });
      expect(
        f.store.readRun({ runId: f.selector.runId }).view.execution.version
      ).toBe(1);
      expect(
        await authority.read({
          reviewDigest: 'a'.repeat(64),
          runId: f.selector.runId,
        })
      ).toMatchObject({
        code: 'SPANS_EXECUTION_AUTHORITY_CLOSED',
        ok: false,
      });
    } finally {
      await authority.close();
      f.closeCurrentStore();
    }
  });
});
