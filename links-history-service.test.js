import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLinksClient } from './links-client.js';
import { ensureEngine, temporaryLinksRoot } from './links-engine-fixture.js';
import { createLinksHistoryService } from './links-history-service.js';
import {
  createFakeEngine,
  engineMessage,
} from './links-projection.engine-fixture.js';
import { createSpansDrafts } from './spans-drafts.js';
import { openSpansStore } from './spans-store.js';

const LINKS_CODE = /^LINKS_/;
const ENGINE = ensureEngine();
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

// A scripted Links client: ops answer from the handlers given, anything else
// is an engine that does not know the op. It records every call.
function scriptedClient(handlers = {}) {
  const calls = [];
  return {
    call: (op, args) => {
      calls.push({ args, op });
      const handler = handlers[op];
      return Promise.resolve(
        handler
          ? handler(args)
          : { code: 'LINKS_UNKNOWN_OP', error: 'unknown', ok: false }
      );
    },
    calls,
  };
}

function archive({ withRun = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'setu-links-history-svc-'));
  roots.push(root);
  if (withRun) {
    const store = openSpansStore({ root });
    const drafts = createSpansDrafts({ store });
    for (const runId of ['run-1', 'run-2']) {
      expect(
        drafts.createRun({
          goal: 'g',
          owner: 'codex',
          runId,
          spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
        }).ok
      ).toBe(true);
    }
    store.close();
  }
  return root;
}

const fileDigest = (root) =>
  ['spans.sqlite3', 'spans.sqlite3-wal']
    .filter((name) => fs.existsSync(join(root, name)))
    .map((name) =>
      createHash('sha256')
        .update(fs.readFileSync(join(root, name)))
        .digest('hex')
    )
    .join(':');

const eventsOf = (root, runId = 'run-1') => {
  const store = openSpansStore({ readonly: true, root });
  try {
    return store.readEvents({ limit: 200, runId }).events;
  } finally {
    store.close();
  }
};

async function approveOver(service, patch = {}) {
  const target = { hint: 'run-1', origin: 'local', runId: 'run-1', ...patch };
  const preview = await service.associationPreview(target);
  expect(preview.ok).toBe(true);
  return service.associationApprove({
    ...target,
    confirmation: preview.review.token,
  });
}

describe('associations through the service', () => {
  test('preview, approve and revoke work on an existing archive, and a read writes nothing', async () => {
    const spansRoot = archive();
    const service = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot,
    });
    const before = fileDigest(spansRoot);
    const preview = await service.associationPreview({
      hint: 'run-1',
      origin: 'local',
      runId: 'run-1',
    });
    expect(preview.ok).toBe(true);
    expect(await service.associations({ runId: 'run-1' })).toMatchObject({
      associations: [],
      ok: true,
    });
    expect(fileDigest(spansRoot)).toBe(before);

    expect(await approveOver(service)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(
      (await service.associations({ runId: 'run-1' })).associations[0]
    ).toMatchObject({ origin: 'local', status: 'approved' });
    expect(
      await service.associationRevoke({
        hint: 'run-1',
        origin: 'local',
        runId: 'run-1',
        source: 'ui',
      })
    ).toMatchObject({ ok: true });
  });

  test('never creates an archive that is not there', async () => {
    const spansRoot = join(archive({ withRun: false }), 'nothing-here');
    const service = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot,
    });
    for (const result of [
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time keeps the recorded calls ordered.
      await service.associationPreview({
        hint: 'h',
        origin: 'local',
        runId: 'r',
      }),
      await service.associationApprove({
        confirmation: 'x',
        hint: 'h',
        origin: 'local',
        runId: 'r',
      }),
      await service.associations({ runId: 'r' }),
      await service.projectionStatus({ runId: 'r' }),
      await service.project({ maxBatches: 1 }),
    ]) {
      expect(result).toMatchObject({
        code: 'LINKS_ARCHIVE_UNAVAILABLE',
        ok: false,
      });
    }
    expect(fs.existsSync(spansRoot)).toBe(false);
  });

  test('a peer origin is checked against the roster, and an unreadable roster is its own answer', async () => {
    const spansRoot = archive();
    const roster = scriptedClient({
      peer_list: async () => ({
        ok: true,
        result: { peers: [{ peer_id: 'peer-A' }] },
      }),
    });
    const service = createLinksHistoryService({ client: roster, spansRoot });
    expect(await approveOver(service, { origin: 'peer-A' })).toMatchObject({
      ok: true,
    });
    expect(
      await service.associationPreview({
        hint: 'run-1',
        origin: 'peer-Z',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_ORIGIN_UNKNOWN', ok: false });

    const down = createLinksHistoryService({
      client: scriptedClient({
        peer_list: async () => ({
          code: 'LINKS_ENGINE_UNAVAILABLE',
          error: 'x',
          ok: false,
        }),
      }),
      spansRoot,
    });
    expect(
      await down.associationPreview({
        hint: 'run-1',
        origin: 'peer-A',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_ORIGIN_UNVERIFIABLE', ok: false });
    // The local origin never needs the engine.
    expect(
      await down.associationPreview({
        hint: 'run-1',
        origin: 'local',
        runId: 'run-1',
      })
    ).toMatchObject({ ok: true });
  });

  test('refuses unknown fields and malformed identifiers', async () => {
    const service = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot: archive(),
    });
    expect(
      await service.associationPreview({
        extra: 1,
        hint: 'h',
        origin: 'local',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_INVALID' });
    expect(
      await service.associationPreview({
        hint: 'h',
        origin: '../x',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_INVALID' });
    expect(
      await service.associations({ extra: 1, runId: 'run-1' })
    ).toMatchObject({
      code: 'LINKS_INVALID',
    });
  });
});

describe('recovery', () => {
  const listed = (messages, extra = {}) => ({
    ok: true,
    result: { has_more: false, messages, next_after: null, ...extra },
  });
  const row = (id, patch = {}) => ({
    message_id: id,
    reason: null,
    run_hint: 'run-1',
    sender: { kind: 'user' },
    span_hint: null,
    state: 'held',
    ...patch,
  });

  test('delivery items are bounded engine pages with a way to open each message', async () => {
    const client = scriptedClient({
      list: async () =>
        listed(
          [
            row('m_1', { reason: 'conversation-replaced' }),
            row('m_2', { run_hint: null, state: 'handoff-unknown' }),
          ],
          {
            has_more: true,
            next_after: 'm_2',
          }
        ),
    });
    const service = createLinksHistoryService({ client, spansRoot: archive() });
    const result = await service.recovery({ limit: '25' });
    expect(client.calls[0]).toEqual({
      args: { limit: 25, states: ['held', 'handoff-unknown'] },
      op: 'list',
    });
    expect(result).toMatchObject({
      kind: 'delivery',
      moreAfter: 'm_2',
      ok: true,
    });
    expect(
      result.items.map((i) => [i.messageId, i.state, i.disposition])
    ).toEqual([
      ['m_1', 'held', 'unassociated'],
      ['m_2', 'handoff-unknown', 'unassociated'],
    ]);
    expect(result.items[0].openPath).toBe('/api/links/message?messageId=m_1');
  });

  test('the page size and cursor are validated before the engine is asked', async () => {
    const client = scriptedClient({ list: async () => listed([]) });
    const service = createLinksHistoryService({ client, spansRoot: archive() });
    for (const bad of [
      { limit: 0 },
      { limit: 201 },
      { limit: 'x' },
      { kind: 'all' },
      { afterId: '../x' },
      { extra: 1 },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: One request at a time keeps the recorded calls ordered.
      expect(await service.recovery(bad)).toMatchObject({
        code: 'LINKS_INVALID',
      });
    }
    expect(client.calls).toEqual([]);
    await service.recovery({ afterId: 'm_9', kind: 'unassociated' });
    expect(client.calls[0].args).toEqual({
      after_id: 'm_9',
      has_run_hint: true,
      limit: 50,
    });
  });

  test('an engine that is down, or too old for this listing, is said so rather than shown as empty', async () => {
    const spansRoot = archive();
    const down = createLinksHistoryService({
      client: scriptedClient({
        list: async () => ({
          code: 'LINKS_ENGINE_UNAVAILABLE',
          error: 'x',
          ok: false,
        }),
      }),
      spansRoot,
    });
    expect(await down.recovery({})).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
      ok: false,
    });
    const old = createLinksHistoryService({
      client: scriptedClient({
        list: async () => ({
          code: 'LINKS_REQUEST_INVALID',
          error: 'x',
          ok: false,
        }),
      }),
      spansRoot,
    });
    expect(await old.recovery({})).toMatchObject({
      code: 'LINKS_ENGINE_UPGRADE_REQUIRED',
      ok: false,
    });
  });

  test('unassociated items say why: unapproved, other origin, revoked, stale, unknown run', async () => {
    const spansRoot = archive();
    const roster = scriptedClient({
      list: async () =>
        listed([
          row('m_ok', { run_hint: 'run-1', state: 'handed-off' }),
          row('m_unapproved', { run_hint: 'nobody' }),
          row('m_peer', {
            origin: 'peer-A',
            run_hint: 'run-1',
            sender: { kind: 'peer' },
          }),
          row('m_revoked', { run_hint: 'was-1' }),
          row('m_stale', { run_hint: 'old-1' }),
          row('m_gone', { run_hint: 'gone-1' }),
        ]),
      peer_list: async () => ({
        ok: true,
        result: { peers: [{ peer_id: 'peer-A' }] },
      }),
    });
    const service = createLinksHistoryService({ client: roster, spansRoot });
    // Approved and current.
    await approveOver(service, { hint: 'run-1' });
    // Revoked.
    await approveOver(service, { hint: 'was-1' });
    await service.associationRevoke({
      hint: 'was-1',
      origin: 'local',
      runId: 'run-1',
    });
    // Stale: approved, then the plan moved on.
    await approveOver(service, { hint: 'old-1', runId: 'run-2' });
    const store = openSpansStore({ root: spansRoot });
    const read = store.readRun({ runId: 'run-2' });
    createSpansDrafts({ store }).revisePlan({
      expectedGeneration: read.generation,
      expectedRevision: read.revision,
      goal: 'g2',
      runId: 'run-2',
      spans: [{ dependencies: [], spanId: 'plan', title: 'Plan 2' }],
    });
    // Unknown run: an index entry whose run is not in the archive.
    store.writeCache(
      `links-assoc-index:${createHash('sha256')
        .update(JSON.stringify(['local', 'gone-1']), 'utf8')
        .digest('hex')}`,
      { runs: ['vanished'] }
    );
    store.close();

    const before = fileDigest(spansRoot);
    const result = await service.recovery({ kind: 'unassociated' });
    expect(fileDigest(spansRoot)).toBe(before);
    const byId = Object.fromEntries(result.items.map((i) => [i.messageId, i]));
    expect(Object.keys(byId).sort()).toEqual([
      'm_gone',
      'm_peer',
      'm_revoked',
      'm_stale',
      'm_unapproved',
    ]);
    expect(byId.m_unapproved.rejection).toBe('unapproved');
    expect(byId.m_peer.rejection).toBe('unapproved');
    expect(byId.m_revoked.rejection).toBe('revoked');
    expect(byId.m_stale.rejection).toBe('stale-generation');
    expect(byId.m_gone.rejection).toBe('unknown-run');
  });

  test('an attached held message is shown as attached to its run, and can be scoped to one run', async () => {
    const spansRoot = archive();
    const client = scriptedClient({
      list: async () =>
        listed([
          row('m_1', { run_hint: 'run-1' }),
          row('m_2', { run_hint: 'run-2' }),
        ]),
    });
    const service = createLinksHistoryService({ client, spansRoot });
    await approveOver(service, { hint: 'run-1' });
    await approveOver(service, { hint: 'run-2', runId: 'run-2' });
    const all = await service.recovery({});
    expect(
      all.items.map((i) => [i.messageId, i.disposition, i.runIds])
    ).toEqual([
      ['m_1', 'attached', ['run-1']],
      ['m_2', 'attached', ['run-2']],
    ]);
    const scoped = await service.recovery({ runId: 'run-2' });
    expect(scoped.items.map((i) => i.messageId)).toEqual(['m_2']);
  });

  test('with no archive every run-linked item is simply unapproved', async () => {
    const spansRoot = join(archive({ withRun: false }), 'none');
    const client = scriptedClient({ list: async () => listed([row('m_1')]) });
    const service = createLinksHistoryService({ client, spansRoot });
    const result = await service.recovery({ kind: 'unassociated' });
    expect(result.items[0]).toMatchObject({ rejection: 'unapproved' });
    expect(fs.existsSync(spansRoot)).toBe(false);
  });
});

describe('evidence through the service', () => {
  const shown = (patch = {}) => ({
    ok: true,
    result: {
      body: 'Use migration 12. token=hunter2',
      created_at: 1,
      kind: 'message',
      message_id: 'm_r',
      recipient: { native_id: 'n', provider: 'claude-code', session_hint: 's' },
      reply_to: null,
      run_hint: 'run-1',
      sender: { kind: 'user' },
      size: 30,
      span_hint: null,
      ...patch,
    },
  });

  test('takes origin and hint from the engine message, then previews and attaches', async () => {
    const spansRoot = archive();
    const client = scriptedClient({ show: async () => shown() });
    const service = createLinksHistoryService({ client, spansRoot });
    expect(
      await service.evidencePreview({ messageId: 'm_r', runId: 'run-1' })
    ).toMatchObject({ code: 'LINKS_NOT_ASSOCIATED', ok: false });
    await approveOver(service);
    const preview = await service.evidencePreview({
      messageId: 'm_r',
      runId: 'run-1',
      spanId: 'plan',
    });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview.review)).not.toContain('hunter2');
    const attached = await service.evidenceAttach({
      confirmation: preview.review.token,
      messageId: 'm_r',
      runId: 'run-1',
      source: 'ui',
      spanId: 'plan',
    });
    expect(attached).toMatchObject({ ok: true, replayed: false });
    expect(
      eventsOf(spansRoot).filter((e) => e.type === 'links.evidence.attached')
    ).toHaveLength(1);
  });

  test('a span the peer names is never the target: the default is the run itself, and a bogus hint does not block attaching', async () => {
    const spansRoot = archive();
    const client = scriptedClient({
      show: () => shown({ span_hint: 'not-a-span-here' }),
    });
    const service = createLinksHistoryService({ client, spansRoot });
    await approveOver(service);
    const preview = await service.evidencePreview({
      messageId: 'm_r',
      runId: 'run-1',
    });
    expect(preview.ok).toBe(true);
    expect(preview.review.spanId).toBeNull();
    // The peer's hint is shown as information in the record, not chosen as the target.
    expect(preview.review.record.spanHint).toBe('not-a-span-here');
    const attached = await service.evidenceAttach({
      confirmation: preview.review.token,
      messageId: 'm_r',
      runId: 'run-1',
    });
    expect(attached).toMatchObject({ evidence: { spanId: null }, ok: true });
    // Choosing a span is the user's act and must be one of the run's own.
    expect(
      await service.evidencePreview({
        messageId: 'm_r',
        runId: 'run-1',
        spanId: 'not-a-span-here',
      })
    ).toMatchObject({ code: 'LINKS_SPAN_UNKNOWN' });
    expect(
      (
        await service.evidencePreview({
          messageId: 'm_r',
          runId: 'run-1',
          spanId: 'plan',
        })
      ).review.spanId
    ).toBe('plan');
  });

  test('a caller cannot name an origin or hint, and a message without a hint cannot be attached', async () => {
    const spansRoot = archive();
    const client = scriptedClient({
      show: async () => shown({ run_hint: null }),
    });
    const service = createLinksHistoryService({ client, spansRoot });
    expect(
      await service.evidencePreview({
        hint: 'run-1',
        messageId: 'm_r',
        origin: 'local',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_INVALID' });
    expect(
      await service.evidencePreview({ messageId: 'm_r', runId: 'run-1' })
    ).toMatchObject({ code: 'LINKS_NOT_ASSOCIATED' });
  });

  test('an unavailable engine is not an empty message', async () => {
    const service = createLinksHistoryService({
      client: scriptedClient({
        show: async () => ({
          code: 'LINKS_ENGINE_UNAVAILABLE',
          error: 'x',
          ok: false,
        }),
      }),
      spansRoot: archive(),
    });
    expect(
      await service.evidencePreview({ messageId: 'm_r', runId: 'run-1' })
    ).toMatchObject({
      code: 'LINKS_ENGINE_UNAVAILABLE',
    });
  });
});

describe('projection through the service', () => {
  const indexKeyFor = (origin, hint) =>
    `links-assoc-index:${createHash('sha256')
      .update(JSON.stringify([origin, hint]), 'utf8')
      .digest('hex')}`;
  const engineClientHandlers = (engine) => ({
    events: async (args) => {
      const reply = await engine.events({
        after: args.after,
        limit: args.limit,
        origin: args.origin,
        runHint: args.run_hint,
      });
      const { ok: _ok, ...result } = reply;
      return { ok: true, result };
    },
  });
  function engineClient(engine) {
    return scriptedClient(engineClientHandlers(engine));
  }

  test('the project command also repairs a lost lookup index, so Recovery can name the run again', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    const service = createLinksHistoryService({
      client: scriptedClient({
        list: () => ({
          ok: true,
          result: {
            has_more: false,
            messages: [
              {
                message_id: 'm_1',
                reason: null,
                run_hint: 'run-1',
                sender: { kind: 'user' },
                span_hint: null,
                state: 'handed-off',
              },
            ],
            next_after: null,
          },
        }),
        ...engineClientHandlers(engine),
      }),
      spansRoot,
    });
    await approveOver(service);
    const store = openSpansStore({ root: spansRoot });
    const db = store;
    expect(db.writeCache(indexKeyFor('local', 'run-1'), { runs: [] }).ok).toBe(
      true
    );
    store.close();
    expect(
      (await service.recovery({ kind: 'unassociated' })).items[0].rejection
    ).toBe('unapproved');
    await service.project({ maxBatches: 1 });
    expect((await service.recovery({ kind: 'unassociated' })).items).toEqual(
      []
    );
  });

  test('status is passive; the explicit project command writes, and only then', async () => {
    const spansRoot = archive();
    const engine = createFakeEngine();
    engine.record('m_1', engineMessage(), 'queued');
    const service = createLinksHistoryService({
      client: engineClient(engine),
      spansRoot,
    });
    await approveOver(service);

    const before = fileDigest(spansRoot);
    const status = await service.projectionStatus({ runId: 'run-1' });
    expect(status.associations[0]).toMatchObject({
      pending: true,
      projectedThrough: 0,
    });
    expect(fileDigest(spansRoot)).toBe(before);
    expect(
      eventsOf(spansRoot).filter((e) => e.type.startsWith('links.m'))
    ).toEqual([]);

    const projected = await service.project({ maxBatches: 5 });
    expect(projected).toMatchObject({ complete: true, ok: true });
    expect(eventsOf(spansRoot).map((e) => e.type)).toContain('links.message');
    expect(
      (await service.projectionStatus({ runId: 'run-1' })).associations[0]
        .pending
    ).toBe(false);
  });

  test('the real engine projects an approved archive once across restart and gives a replacement store a new cursor', async () => {
    const spansRoot = archive();
    const first = temporaryLinksRoot();
    const second = temporaryLinksRoot();
    roots.push(first.root, second.root);
    const send = (client, key) =>
      client.call('send', {
        body: 'real engine history',
        idempotency_key: key,
        project: 'repo',
        recipient: {
          checkout: '{"path":"/work/repo","incarnation":"c1"}',
          native_id: 'native-a',
          provider: 'claude-code',
          session_hint: 'session-1',
        },
        run_hint: 'run-1',
        sender: { kind: 'user' },
      });
    const firstClient = createLinksClient({
      dataDir: join(first.root, 'links'),
      enginePath: ENGINE,
    });
    expect((await send(firstClient, 'real-history-1')).ok).toBe(true);
    const service = createLinksHistoryService({ client: firstClient, spansRoot });
    expect((await approveOver(service)).ok).toBe(true);
    expect(await service.project({ maxBatches: 5 })).toMatchObject({
      complete: true,
      ok: true,
    });
    const projected = eventsOf(spansRoot).filter((event) =>
      event.type.startsWith('links.')
    );
    expect(projected.map((event) => event.type)).toEqual([
      'links.association.approved',
      'links.message',
      'links.status',
    ]);
    const projectedIds = projected
      .filter(
        (event) => event.type === 'links.message' || event.type === 'links.status'
      )
      .map((event) => event.eventId);
    const restarted = createLinksHistoryService({ client: firstClient, spansRoot });
    expect((await restarted.project({ maxBatches: 5 })).complete).toBe(true);
    expect(
      eventsOf(spansRoot)
        .filter((event) => event.type === 'links.message' || event.type === 'links.status')
        .map((event) => event.eventId)
    ).toEqual(projectedIds);

    const secondClient = createLinksClient({
      dataDir: join(second.root, 'links'),
      enginePath: ENGINE,
    });
    expect((await send(secondClient, 'real-history-2')).ok).toBe(true);
    expect(
      (await createLinksHistoryService({ client: secondClient, spansRoot }).project({
        maxBatches: 5,
      })).complete
    ).toBe(true);
    expect(eventsOf(spansRoot).filter((event) => event.type === 'links.message')).toHaveLength(2);
  });
});

describe('withdrawing never depends on the roster or the engine', () => {
  const KEY = 'a'.repeat(64);
  const peer = `peer:${KEY}`;

  test('a peer approval can be revoked with the engine down and after the peer was removed', async () => {
    for (const roster of [
      () => ({ code: 'LINKS_ENGINE_UNAVAILABLE', error: 'x', ok: false }),
      () => ({ ok: true, result: { peers: [] } }),
    ]) {
      const spansRoot = archive();
      let current = () => ({ ok: true, result: { peers: [{ peer_id: KEY }] } });
      const service = createLinksHistoryService({
        client: scriptedClient({ peer_list: () => current() }),
        spansRoot,
      });
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      expect(await approveOver(service, { origin: peer })).toMatchObject({
        ok: true,
      });
      current = roster;
      // The same request that a preview or approve would now refuse.
      expect(
        (
          await service.associationPreview({
            hint: 'run-1',
            origin: peer,
            runId: 'run-1',
          })
        ).ok
      ).toBe(false);
      expect(
        await service.associationRevoke({
          hint: 'run-1',
          origin: peer,
          runId: 'run-1',
        })
      ).toMatchObject({ association: { status: 'revoked' }, ok: true });
      expect(
        (await service.associations({ runId: 'run-1' })).associations[0].status
      ).toBe('revoked');
    }
  });

  test('revoking still validates what it is asked to revoke and does not invent an approval', async () => {
    const service = createLinksHistoryService({
      client: scriptedClient(),
      spansRoot: archive(),
    });
    expect(
      await service.associationRevoke({
        hint: 'h',
        origin: peer,
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_ASSOCIATION_UNKNOWN', ok: false });
    expect(
      await service.associationRevoke({
        hint: 'h',
        origin: '../x',
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_INVALID', ok: false });
  });

  test('a peer origin is the peer: form of a roster key, and either form of a roster id matches it', async () => {
    const service = createLinksHistoryService({
      client: scriptedClient({
        peer_list: () => ({ ok: true, result: { peers: [{ peer_id: KEY }] } }),
      }),
      spansRoot: archive(),
    });
    expect(
      (
        await service.associationPreview({
          hint: 'run-1',
          origin: peer,
          runId: 'run-1',
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await service.associationPreview({
          hint: 'run-1',
          origin: KEY,
          runId: 'run-1',
        })
      ).ok
    ).toBe(true);
    expect(
      await service.associationPreview({
        hint: 'run-1',
        origin: `peer:${'b'.repeat(64)}`,
        runId: 'run-1',
      })
    ).toMatchObject({ code: 'LINKS_ORIGIN_UNKNOWN' });
  });
});

describe('the derived lookup never turns "not indexed" into "unapproved"', () => {
  const listedFor = (hint) => ({
    ok: true,
    result: {
      has_more: false,
      messages: [
        {
          message_id: 'm_1',
          reason: null,
          run_hint: hint,
          sender: { kind: 'user' },
          span_hint: null,
          state: 'handed-off',
        },
      ],
      next_after: null,
    },
  });

  function crowded() {
    const spansRoot = archive({ withRun: false });
    const store = openSpansStore({ root: spansRoot });
    const drafts = createSpansDrafts({ store });
    const ids = Array.from(
      { length: 17 },
      (_, i) => `run-${String(i + 1).padStart(2, '0')}`
    );
    for (const runId of ids) {
      expect(
        drafts.createRun({
          goal: 'g',
          owner: 'codex',
          runId,
          spans: [{ dependencies: [], spanId: 'plan', title: 'Plan' }],
        }).ok
      ).toBe(true);
    }
    store.close();
    const service = createLinksHistoryService({
      client: scriptedClient({ list: () => listedFor('shared-hint') }),
      spansRoot,
    });
    return { ids, service, spansRoot };
  }

  test('with more approvals than the index holds, a message nobody indexed is reported as index-incomplete', async () => {
    const { ids, service } = crowded();
    for (const runId of ids) {
      expect(
        // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
        (await approveOver(service, { hint: 'shared-hint', runId })).ok
      ).toBe(true);
    }
    // The 16 newest are indexed; withdraw them. The oldest is still approved
    // but the index no longer knows it.
    for (const runId of ids.slice(1)) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      const revoked = await service.associationRevoke({
        hint: 'shared-hint',
        origin: 'local',
        runId,
      });
      expect(revoked.ok).toBe(true);
    }
    const before = await service.recovery({ kind: 'unassociated' });
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({
      disposition: 'unassociated',
      rejection: 'index-incomplete',
    });
    expect(before.items[0].rejection).not.toBe('revoked');
    expect(before.items[0].rejection).not.toBe('unapproved');
  });

  test('a run-scoped list keeps the uncertainty instead of dropping the message', async () => {
    const { ids, service } = crowded();
    for (const runId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await approveOver(service, { hint: 'shared-hint', runId });
    }
    for (const runId of ids.slice(1)) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await service.associationRevoke({
        hint: 'shared-hint',
        origin: 'local',
        runId,
      });
    }
    // run-01 holds the one live approval but the lookup no longer lists it.
    for (const kind of ['unassociated', 'delivery']) {
      // biome-ignore lint/performance/noAwaitInLoops: Each kind is its own request.
      const scoped = await service.recovery({ kind, runId: ids[0] });
      expect(scoped.items).toHaveLength(1);
      expect(scoped.items[0]).toMatchObject({
        disposition: 'unassociated',
        rejection: 'index-incomplete',
      });
    }
    // The same uncertainty shows for any run asked about, never a silent "nothing".
    const other = await service.recovery({
      kind: 'unassociated',
      runId: ids[5],
    });
    expect(other.items[0].rejection).toBe('index-incomplete');
  });

  test('a run-scoped list still hides a message that is surely attached to a different run', async () => {
    const spansRoot = archive();
    const service = createLinksHistoryService({
      client: scriptedClient({ list: () => listedFor('h-9') }),
      spansRoot,
    });
    await approveOver(service, { hint: 'h-9', runId: 'run-1' });
    expect(
      (await service.recovery({ kind: 'delivery', runId: 'run-2' })).items
    ).toEqual([]);
    expect(
      (await service.recovery({ kind: 'delivery', runId: 'run-1' })).items[0]
        .disposition
    ).toBe('attached');
  });

  test('the project command rebuilds the lookup from the approvals, approved runs first', async () => {
    const { ids, service } = crowded();
    for (const runId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await approveOver(service, { hint: 'shared-hint', runId });
    }
    for (const runId of ids.slice(1)) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await service.associationRevoke({
        hint: 'shared-hint',
        origin: 'local',
        runId,
      });
    }
    await service.project({ maxBatches: 1 });
    const after = await service.recovery({ kind: 'unassociated' });
    // The one approved run is found again, so the message is attached and not listed.
    expect(after.items).toEqual([]);
  });

  test('with no approved run left and the lookup still crowded, the answer stays unknown rather than revoked', async () => {
    const { ids, service } = crowded();
    for (const runId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await approveOver(service, { hint: 'shared-hint', runId });
    }
    for (const runId of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: Approvals are made one at a time so each sees the last.
      await service.associationRevoke({
        hint: 'shared-hint',
        origin: 'local',
        runId,
      });
    }
    await service.project({ maxBatches: 1 });
    const result = await service.recovery({ kind: 'unassociated' });
    // 17 revoked runs exceed what is kept: some are not listed, so it cannot
    // claim "revoked" for all of them, but it knows none is approved.
    expect(result.items[0].rejection).toBe('index-incomplete');
  });

  test('a lookup that fits is exact: revoked is revoked and unseen is unapproved', async () => {
    const spansRoot = archive();
    const service = createLinksHistoryService({
      client: scriptedClient({ list: () => listedFor('h-1') }),
      spansRoot,
    });
    expect(
      (await service.recovery({ kind: 'unassociated' })).items[0].rejection
    ).toBe('unapproved');
    await approveOver(service, { hint: 'h-1' });
    await service.associationRevoke({
      hint: 'h-1',
      origin: 'local',
      runId: 'run-1',
    });
    expect(
      (await service.recovery({ kind: 'unassociated' })).items[0].rejection
    ).toBe('revoked');
  });

  test('the rebuild skips an unreadable run, says so, and marks what it rebuilt as possibly incomplete', async () => {
    const spansRoot = archive();
    const service = createLinksHistoryService({
      client: scriptedClient({ list: () => listedFor('h-2') }),
      spansRoot,
    });
    await approveOver(service, { hint: 'h-2', runId: 'run-2' });
    await service.associationRevoke({
      hint: 'h-2',
      origin: 'local',
      runId: 'run-2',
    });
    const db = new Database(join(spansRoot, 'spans.sqlite3'));
    db.run(
      "UPDATE spans_views SET view_json = '{not json' WHERE run_id = 'run-1'"
    );
    db.close();
    const projected = await service.project({ maxBatches: 1 });
    expect(projected.ok).toBe(true);
    expect(projected.indexErrors).toEqual([
      { code: expect.stringMatching(LINKS_CODE), runId: 'run-1' },
    ]);
    // run-1 is unreadable and may hold an approval, so the lookup cannot say "revoked".
    expect(
      (await service.recovery({ kind: 'unassociated' })).items[0].rejection
    ).toBe('index-incomplete');
  });
});
