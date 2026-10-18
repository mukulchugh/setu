import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { associationIdOf } from './links-history.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const REVOKING_COPY = /while revoking/;
const APPROVING_COPY = /while approving/;
const LINKS_CODE = /^LINKS_/;
const ASSOCIATE_TOKEN = /^associate:[0-9a-f]{64}$/;
const EVIDENCE_TOKEN = /^evidence:[0-9a-f]{64}$/;
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/;
const roots = [];
const stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function fixture({ origins = ['local', 'peer-A', 'peer-B'] } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-assoc-'));
  roots.push(root);
  const store = openSpansStore({ root });
  stores.push(store);
  const drafts = createSpansDrafts({ store });
  const artifacts = createSpansArtifacts({ root });
  const links = createLinksAssociations({
    artifacts,
    isKnownOrigin: (origin) => origins.includes(origin),
    store,
  });
  return { artifacts, drafts, links, root, store };
}

function newRun(drafts, runId = 'run-1') {
  expect(
    drafts.createRun({
      goal: 'Ship it',
      owner: 'codex',
      runId,
      spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
    }).ok
  ).toBe(true);
}

const revise = (drafts, store, runId = 'run-1') => {
  const read = store.readRun({ runId });
  return drafts.revisePlan({
    expectedGeneration: read.generation,
    expectedRevision: read.revision,
    goal: 'Revised',
    runId,
    spans: [{ dependencies: [], spanId: 'plan', title: 'Plan again' }],
  });
};

const target = (patch = {}) => ({
  hint: 'run-1',
  origin: 'local',
  runId: 'run-1',
  ...patch,
});

function approve(links, patch) {
  const preview = links.preview(target(patch));
  expect(preview.ok).toBe(true);
  return links.approve({
    ...target(patch),
    confirmation: preview.review.token,
  });
}

const eventsOf = (store, runId = 'run-1') =>
  store.readEvents({ limit: 200, runId }).events;
const linksEvents = (store, runId) =>
  eventsOf(store, runId).filter((e) => e.type.startsWith('links.'));

describe('previewing an association', () => {
  test('shows exactly what would be approved, bound to the run generation', () => {
    const { drafts, links } = fixture();
    newRun(drafts);
    const { ok, review } = links.preview(target());
    expect(ok).toBe(true);
    expect(review).toMatchObject({
      associationId: associationIdOf(target()),
      generation: 0,
      hint: 'run-1',
      origin: 'local',
      runId: 'run-1',
      status: 'none',
    });
    expect(review.token).toMatch(ASSOCIATE_TOKEN);
  });

  test('refuses unknown runs, unknown origins and unusable hints, writing nothing', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    expect(links.preview(target({ runId: 'nope' }))).toMatchObject({
      code: 'LINKS_RUN_UNKNOWN',
      ok: false,
    });
    expect(links.preview(target({ origin: 'peer-Z' }))).toMatchObject({
      code: 'LINKS_ORIGIN_UNKNOWN',
      ok: false,
    });
    for (const hint of ['', '__proto__', 'has space', 'x'.repeat(129), 7]) {
      expect(links.preview(target({ hint })).code).toBe('LINKS_INVALID');
    }
    expect(links.preview({ ...target(), extra: 1 }).code).toBe('LINKS_INVALID');
    expect(store.readRun({ runId: 'run-1' }).revision).toBe(1);
  });

  test('the token changes with the run, the origin, the hint and the generation', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    newRun(drafts, 'run-2');
    const base = links.preview(target()).review.token;
    expect(links.preview(target({ runId: 'run-2' })).review.token).not.toBe(
      base
    );
    expect(links.preview(target({ origin: 'peer-A' })).review.token).not.toBe(
      base
    );
    expect(links.preview(target({ hint: 'other' })).review.token).not.toBe(
      base
    );
    expect(revise(drafts, store).ok).toBe(true);
    expect(links.preview(target()).review.token).not.toBe(base);
  });
});

describe('approving an association', () => {
  test('needs the reviewed token and records the approval with its event in one commit', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    const before = store.readRun({ runId: 'run-1' });

    expect(links.approve(target()).code).toBe('LINKS_CONFIRMATION_REQUIRED');
    expect(
      links.approve({ ...target(), confirmation: 'associate:x' }).code
    ).toBe('LINKS_CONFIRMATION_MISMATCH');
    expect(store.readRun({ runId: 'run-1' }).revision).toBe(before.revision);

    const result = approve(links);
    expect(result).toMatchObject({
      association: { generation: 0, status: 'approved' },
      ok: true,
      replayed: false,
    });
    const after = store.readRun({ runId: 'run-1' });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.generation).toBe(0);
    const id = associationIdOf(target());
    expect(after.view.linksAssociations[id]).toEqual({
      epoch: 1,
      generation: 0,
      hint: 'run-1',
      origin: 'local',
      status: 'approved',
    });
    // Nothing else in the run moved: no span, action, checkpoint or plan change.
    const { linksAssociations: _added, ...rest } = after.view;
    expect(rest).toEqual(before.view);
    const [event] = linksEvents(store);
    expect(event).toMatchObject({
      payload: {
        associationId: id,
        epoch: 1,
        generation: 0,
        hint: 'run-1',
        origin: 'local',
      },
      type: 'links.association.approved',
    });
  });

  test('an exact repeat changes nothing', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    approve(links);
    const { revision } = store.readRun({ runId: 'run-1' });
    expect(approve(links)).toMatchObject({ ok: true, replayed: true });
    expect(store.readRun({ runId: 'run-1' }).revision).toBe(revision);
    expect(linksEvents(store)).toHaveLength(1);
  });

  test('a token from before a plan revision is void', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    const stale = links.preview(target()).review.token;
    expect(revise(drafts, store).ok).toBe(true);
    expect(links.approve({ ...target(), confirmation: stale })).toMatchObject({
      code: 'LINKS_CONFIRMATION_MISMATCH',
      ok: false,
    });
    expect(linksEvents(store)).toHaveLength(0);
  });

  test('a plan revision that lands during the commit is refused, not approved for the old plan', () => {
    const { drafts, store } = fixture();
    newRun(drafts);
    const racing = {
      ...store,
      commitRun(request) {
        // The revision wins the race: the commit then carries a stale generation.
        revise(drafts, store);
        return store.commitRun(request);
      },
      readRun: store.readRun,
    };
    const links = createLinksAssociations({
      isKnownOrigin: () => true,
      store: racing,
    });
    const { token } = links.preview(target()).review;
    expect(links.approve({ ...target(), confirmation: token })).toMatchObject({
      code: 'LINKS_GENERATION_STALE',
      ok: false,
    });
    expect(linksEvents(store)).toHaveLength(0);
  });

  test('an unrelated writer bumping the revision does not void a reviewed approval', () => {
    const { drafts, store } = fixture();
    newRun(drafts);
    let bumped = false;
    const noisy = {
      ...store,
      commitRun(request) {
        if (!bumped) {
          bumped = true;
          const read = store.readRun({ runId: 'run-1' });
          store.commitRun({
            events: [],
            expectedGeneration: read.generation,
            expectedRevision: read.revision,
            runId: 'run-1',
            view: read.view,
          });
        }
        return store.commitRun(request);
      },
      readRun: store.readRun,
    };
    const links = createLinksAssociations({
      isKnownOrigin: () => true,
      store: noisy,
    });
    const { token } = links.preview(target()).review;
    expect(links.approve({ ...target(), confirmation: token }).ok).toBe(true);
  });

  test('equal hints from different origins are different associations', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    expect(approve(links, { origin: 'peer-A' }).ok).toBe(true);
    expect(links.listForRun({ runId: 'run-1' }).associations).toHaveLength(1);
    expect(approve(links, { origin: 'peer-B' }).ok).toBe(true);
    const listed = links.listForRun({ runId: 'run-1' }).associations;
    expect(listed.map((a) => a.origin).sort()).toEqual(['peer-A', 'peer-B']);
    expect(links.revoke(target({ origin: 'peer-A' })).ok).toBe(true);
    const states = Object.fromEntries(
      links
        .listForRun({ runId: 'run-1' })
        .associations.map((a) => [a.origin, a.status])
    );
    expect(states).toEqual({ 'peer-A': 'revoked', 'peer-B': 'approved' });
    expect(linksEvents(store).map((e) => e.type)).toEqual([
      'links.association.approved',
      'links.association.approved',
      'links.association.revoked',
    ]);
  });

  test('hints that look like object internals are plain keys', () => {
    const { drafts, links } = fixture();
    newRun(drafts);
    expect(approve(links, { hint: 'constructor' }).ok).toBe(true);
    expect(approve(links, { hint: 'toString' }).ok).toBe(true);
    expect(links.listForRun({ runId: 'run-1' }).associations).toHaveLength(2);
  });

  test('a run holds a bounded number of associations', () => {
    const { drafts, links } = fixture({ origins: ['local'] });
    newRun(drafts);
    for (let index = 0; index < 64; index += 1) {
      expect(approve(links, { hint: `h${index}` }).ok).toBe(true);
    }
    const preview = links.preview(target({ hint: 'one-too-many' }));
    expect(
      links.approve({
        ...target({ hint: 'one-too-many' }),
        confirmation: preview.review?.token ?? 'x',
      }).code
    ).toBe('LINKS_ASSOCIATION_LIMIT');
  });
});

describe('a plan revision, revocation and reapproval', () => {
  test('a revised plan makes an old approval stale until it is approved again', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    approve(links);
    expect(links.listApproved({ limit: 10 }).associations).toHaveLength(1);

    expect(revise(drafts, store).ok).toBe(true);
    expect(links.listApproved({ limit: 10 }).associations).toEqual([]);
    expect(links.listForRun({ runId: 'run-1' }).associations[0]).toMatchObject({
      generation: 0,
      status: 'stale',
    });
    expect(links.preview(target()).review.status).toBe('stale');

    expect(approve(links)).toMatchObject({
      association: { epoch: 2, generation: 1, status: 'approved' },
      ok: true,
    });
    expect(links.listApproved({ limit: 10 }).associations).toHaveLength(1);
    const ids = linksEvents(store).map((e) => e.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  test('a revoke that races a plan revision says it was revoking, not approving', () => {
    const { drafts, store } = fixture();
    newRun(drafts);
    const plain = createLinksAssociations({ isKnownOrigin: () => true, store });
    approve(plain);
    const racing = createLinksAssociations({
      isKnownOrigin: () => true,
      store: {
        ...store,
        commitRun(request) {
          revise(drafts, store);
          return store.commitRun(request);
        },
        listRuns: store.listRuns,
        readRun: store.readRun,
      },
    });
    const result = racing.revoke(target());
    expect(result).toMatchObject({ code: 'LINKS_GENERATION_STALE', ok: false });
    expect(result.error).toMatch(REVOKING_COPY);
    expect(result.error).not.toMatch(APPROVING_COPY);
    // The approval is untouched, and stale because the plan moved on.
    expect(plain.listForRun({ runId: 'run-1' }).associations[0].status).toBe(
      'stale'
    );
    // The approval side keeps its own wording.
    const approving = createLinksAssociations({
      isKnownOrigin: () => true,
      store: {
        ...store,
        commitRun(request) {
          revise(drafts, store);
          return store.commitRun(request);
        },
        listRuns: store.listRuns,
        readRun: store.readRun,
      },
    });
    const { review } = approving.preview(target({ hint: 'other' }));
    expect(
      approving.approve({
        ...target({ hint: 'other' }),
        confirmation: review.token,
      }).error
    ).toMatch(APPROVING_COPY);
  });

  test('revoking is idempotent, needs no token and can be undone only by a new reviewed approval', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    expect(links.revoke(target()).code).toBe('LINKS_ASSOCIATION_UNKNOWN');
    approve(links);
    expect(links.revoke(target())).toMatchObject({
      association: { epoch: 2, status: 'revoked' },
      ok: true,
      replayed: false,
    });
    expect(links.revoke(target())).toMatchObject({ ok: true, replayed: true });
    expect(links.listApproved({ limit: 10 }).associations).toEqual([]);
    expect(approve(links)).toMatchObject({
      association: { epoch: 3, status: 'approved' },
      ok: true,
    });
    expect(linksEvents(store)).toHaveLength(3);
  });
});

describe('finding approved associations', () => {
  test('pages are bounded and resumable', () => {
    const { drafts, links } = fixture();
    for (const id of ['run-a', 'run-b', 'run-c']) {
      newRun(drafts, id);
      approve(links, { hint: id, runId: id });
    }
    const first = links.listApproved({ limit: 2 });
    expect(first.associations.map((a) => a.runId)).toEqual(['run-a', 'run-b']);
    expect(first.hasMore).toBe(true);
    const second = links.listApproved({
      afterRunId: first.nextRunId,
      limit: 2,
    });
    expect(second.associations.map((a) => a.runId)).toEqual(['run-c']);
    expect(second.hasMore).toBe(false);
    expect(links.listApproved({ limit: 201 }).code).toBe('LINKS_INVALID');
    expect(links.listApproved({}).code).toBe('LINKS_INVALID');
  });

  test('a run without associations contributes nothing', () => {
    const { drafts, links } = fixture();
    newRun(drafts);
    expect(links.listApproved({ limit: 10 })).toMatchObject({
      associations: [],
      hasMore: false,
      ok: true,
    });
  });
});

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
const reply = (patch = {}) => ({
  body: `Use migration 12 first. token=hunter2 ${SECRET}`,
  created_at: 1_700_000_000_000,
  kind: 'message',
  message_id: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  origin: 'peer-A',
  recipient: {
    native_id: 'conv-1',
    provider: 'claude-code',
    session_hint: 's1',
  },
  reply_to: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  run_hint: 'run-1',
  sender: { kind: 'peer' },
  size: 60,
  span_hint: 'plan',
  ...patch,
});
const evidenceTarget = (patch = {}) => ({
  hint: 'run-1',
  message: reply(),
  messageId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  origin: 'peer-A',
  runId: 'run-1',
  spanId: 'plan',
  ...patch,
});
function attach(links, patch) {
  const preview = links.previewEvidence(evidenceTarget(patch));
  expect(preview.ok).toBe(true);
  return links.attachEvidence({
    ...evidenceTarget(patch),
    confirmation: preview.review.token,
  });
}
const approved = (links, patch = { origin: 'peer-A' }) =>
  expect(approve(links, patch).ok).toBe(true);

describe('attaching a reply as evidence', () => {
  test('the review shows the exact redacted record that would be stored, bound to the approval', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    const { ok, review } = links.previewEvidence(evidenceTarget());
    expect(ok).toBe(true);
    expect(review).toMatchObject({
      generation: 0,
      messageId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      origin: 'peer-A',
      spanId: 'plan',
    });
    expect(JSON.stringify(review.record)).not.toContain(SECRET);
    expect(JSON.stringify(review.record)).not.toContain('hunter2');
    expect(review.record.text).toContain('Use migration 12 first.');
    expect(review.token).toMatch(EVIDENCE_TOKEN);
    // Reviewing writes nothing.
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toEqual([]);
  });

  test('records source, target revision and the digest of the redacted artifact, and never accepts the span', () => {
    const { artifacts, drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    const before = store.readRun({ runId: 'run-1' });

    const result = attach(links);
    expect(result).toMatchObject({ ok: true, replayed: false });
    const after = store.readRun({ runId: 'run-1' });
    // Evidence is an event, not a view change: the run (view, revision,
    // generation) is exactly as it was, so a worker's compare-and-set is
    // not disturbed and Spans keeps its own completion authority.
    expect(after).toEqual(before);
    const attached = linksEvents(store).filter(
      (e) => e.type === 'links.evidence.attached'
    );
    expect(attached).toHaveLength(1);
    const { payload } = attached[0];
    expect(payload).toMatchObject({
      associationId: associationIdOf({
        hint: 'run-1',
        origin: 'peer-A',
        runId: 'run-1',
      }),
      messageId: 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      origin: 'peer-A',
      spanId: 'plan',
      targetGeneration: 0,
      targetRevision: before.revision,
    });
    expect(payload.artifactId).toMatch(ARTIFACT_ID);
    expect(result.evidence.artifactId).toBe(payload.artifactId);
    const stored = artifacts.read({ artifactId: payload.artifactId });
    expect(stored.ok).toBe(true);
    expect(stored.text).not.toContain(SECRET);
    expect(stored.text).not.toContain('hunter2');
    expect(JSON.stringify(attached[0])).not.toContain(SECRET);
    // No Spans event of any kind was written for it.
    expect(
      eventsOf(store).filter((e) => e.type.startsWith('spans.accept'))
    ).toEqual([]);
  });

  test('a concurrent revision bump by another writer does not stop an attachment', () => {
    const { artifacts, drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    let bumped = false;
    const noisy = createLinksAssociations({
      artifacts,
      isKnownOrigin: () => true,
      store: {
        ...store,
        commitFencedEvents(request) {
          if (!bumped) {
            bumped = true;
            const read = store.readRun({ runId: 'run-1' });
            store.commitRun({
              events: [],
              expectedGeneration: read.generation,
              expectedRevision: read.revision,
              runId: 'run-1',
              view: read.view,
            });
          }
          return store.commitFencedEvents(request);
        },
        getEventById: store.getEventById,
        listRuns: store.listRuns,
        readRun: store.readRun,
      },
    });
    const preview = noisy.previewEvidence(evidenceTarget());
    expect(
      noisy.attachEvidence({
        ...evidenceTarget(),
        confirmation: preview.review.token,
      }).ok
    ).toBe(true);
  });

  test('an exact repeat is recognised, not duplicated', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    attach(links);
    const { revision } = store.readRun({ runId: 'run-1' });
    expect(attach(links)).toMatchObject({ ok: true, replayed: true });
    expect(store.readRun({ runId: 'run-1' }).revision).toBe(revision);
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toHaveLength(1);
  });

  test('needs an approved association for this origin, this hint and the current generation', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    const refused = (patch, code) =>
      expect(links.previewEvidence(evidenceTarget(patch))).toMatchObject({
        code,
        ok: false,
      });
    refused({}, 'LINKS_NOT_ASSOCIATED');
    approved(links);
    refused(
      { message: reply({ origin: 'peer-B' }), origin: 'peer-B' },
      'LINKS_NOT_ASSOCIATED'
    );
    refused({ message: reply({ origin: 'peer-B' }) }, 'LINKS_MESSAGE_MISMATCH');
    refused(
      { message: reply({ run_hint: 'other' }) },
      'LINKS_MESSAGE_MISMATCH'
    );
    refused({ messageId: 'm_other' }, 'LINKS_MESSAGE_MISMATCH');
    refused({ spanId: 'nope' }, 'LINKS_SPAN_UNKNOWN');
    refused({ message: { ...reply(), body: 7 } }, 'LINKS_INVALID');
    expect(revise(drafts, store).ok).toBe(true);
    refused({}, 'LINKS_NOT_ASSOCIATED');
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toEqual([]);
  });

  test('a stale or missing confirmation attaches nothing', () => {
    const { drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    const { review } = links.previewEvidence(evidenceTarget());
    expect(links.attachEvidence(evidenceTarget()).code).toBe(
      'LINKS_CONFIRMATION_REQUIRED'
    );
    expect(
      links.attachEvidence({
        ...evidenceTarget({ message: reply({ body: 'a different reply' }) }),
        confirmation: review.token,
      }).code
    ).toBe('LINKS_CONFIRMATION_MISMATCH');
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toEqual([]);
  });

  test('a revocation that lands during the commit stops the attachment', () => {
    const { artifacts, drafts, store } = fixture();
    newRun(drafts);
    const plain = createLinksAssociations({
      artifacts,
      isKnownOrigin: () => true,
      store,
    });
    approved(plain);
    const racing = createLinksAssociations({
      artifacts,
      isKnownOrigin: () => true,
      store: {
        ...store,
        commitFencedEvents(request) {
          plain.revoke({ hint: 'run-1', origin: 'peer-A', runId: 'run-1' });
          return store.commitFencedEvents(request);
        },
        getEventById: store.getEventById,
        listRuns: store.listRuns,
        readRun: store.readRun,
      },
    });
    const preview = racing.previewEvidence(evidenceTarget());
    expect(
      racing.attachEvidence({
        ...evidenceTarget(),
        confirmation: preview.review.token,
      })
    ).toMatchObject({ code: 'LINKS_NOT_ASSOCIATED', ok: false });
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toEqual([]);
  });

  test('a plan revision that lands during the commit stops the attachment', () => {
    const { artifacts, drafts, links, store } = fixture();
    newRun(drafts);
    approved(links);
    const racing = createLinksAssociations({
      artifacts,
      isKnownOrigin: () => true,
      store: {
        ...store,
        commitFencedEvents(request) {
          revise(drafts, store);
          return store.commitFencedEvents(request);
        },
        getEventById: store.getEventById,
        listRuns: store.listRuns,
        readRun: store.readRun,
      },
    });
    const preview = racing.previewEvidence(evidenceTarget());
    expect(
      racing.attachEvidence({
        ...evidenceTarget(),
        confirmation: preview.review.token,
      })
    ).toMatchObject({ code: 'LINKS_GENERATION_STALE', ok: false });
    expect(
      linksEvents(store).filter((e) => e.type === 'links.evidence.attached')
    ).toEqual([]);
  });
});

describe('identifiers the redactor would change are refused, not stored corrupted', () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'token:abcdef123456',
  ];

  test('preview, approve, revoke and evidence refuse them by name with nothing written', () => {
    const { drafts, links, store } = fixture({
      origins: ['local', ...secrets],
    });
    newRun(drafts);
    const { revision } = store.readRun({ runId: 'run-1' });
    for (const value of secrets) {
      for (const patch of [{ hint: value }, { origin: value }]) {
        expect(links.preview(target(patch))).toMatchObject({
          code: 'LINKS_INVALID',
          ok: false,
        });
        expect(
          links.approve({ ...target(patch), confirmation: 'associate:x' })
        ).toMatchObject({ code: 'LINKS_INVALID', ok: false });
        expect(links.revoke(target(patch))).toMatchObject({
          code: 'LINKS_INVALID',
          ok: false,
        });
      }
    }
    expect(links.preview(target({ runId: secrets[0] })).code).toBe(
      'LINKS_INVALID'
    );
    expect(store.readRun({ runId: 'run-1' }).revision).toBe(revision);
    expect(links.listForRun({ runId: 'run-1' }).associations).toEqual([]);
  });

  test('an ordinary identifier is unaffected', () => {
    const { drafts, links } = fixture();
    newRun(drafts);
    expect(approve(links, { hint: 'build-42.release' }).ok).toBe(true);
  });
});

describe('one unreadable run does not hide the others', () => {
  const corrupt = (root, runId) => {
    const db = new Database(join(root, 'spans.sqlite3'));
    db.run('UPDATE spans_views SET view_json = ? WHERE run_id = ?', [
      '{not json',
      runId,
    ]);
    db.close();
  };

  test('a corrupted run is reported by id and the later runs are still listed', () => {
    const { drafts, links, root, store } = fixture();
    for (const id of ['run-a', 'run-b', 'run-c']) {
      newRun(drafts, id);
      approve(links, { hint: id, runId: id });
    }
    corrupt(root, 'run-a');
    const page = links.listApproved({ limit: 10 });
    expect(page.ok).toBe(true);
    expect(page.associations.map((a) => a.runId)).toEqual(['run-b', 'run-c']);
    expect(page.errors).toEqual([
      { code: expect.stringMatching(LINKS_CODE), runId: 'run-a' },
    ]);
    expect(store.readRun({ runId: 'run-b' }).ok).toBe(true);
  });

  test('a run that vanishes between listing and reading is reported, not fatal', () => {
    const { drafts, links, store } = fixture();
    for (const id of ['run-a', 'run-b']) {
      newRun(drafts, id);
      approve(links, { hint: id, runId: id });
    }
    const racing = createLinksAssociations({
      isKnownOrigin: () => true,
      store: {
        commitRun: store.commitRun,
        listRuns: store.listRuns,
        readRun: (query) =>
          query.runId === 'run-a'
            ? { code: 'SPANS_MODEL_NOT_FOUND', ok: false }
            : store.readRun(query),
      },
    });
    const page = racing.listApproved({ limit: 10 });
    expect(page.associations.map((a) => a.runId)).toEqual(['run-b']);
    expect(page.errors).toEqual([
      { code: 'LINKS_RUN_UNKNOWN', runId: 'run-a' },
    ]);
  });

  test('paging advances past a bad run even when it is the whole page', () => {
    const { drafts, links, root } = fixture();
    for (const id of ['run-a', 'run-b']) {
      newRun(drafts, id);
      approve(links, { hint: id, runId: id });
    }
    corrupt(root, 'run-a');
    const first = links.listApproved({ limit: 1 });
    expect(first).toMatchObject({
      associations: [],
      hasMore: true,
      nextRunId: 'run-a',
    });
    expect(first.errors).toHaveLength(1);
    const second = links.listApproved({
      afterRunId: first.nextRunId,
      limit: 1,
    });
    expect(second.associations.map((a) => a.runId)).toEqual(['run-b']);
  });

  test('a healthy archive reports no errors', () => {
    const { drafts, links } = fixture();
    newRun(drafts);
    approve(links);
    expect(links.listApproved({ limit: 10 }).errors).toEqual([]);
  });
});
