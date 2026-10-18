// The explicit, opt-in worker that derives Spans history from the Links
// engine's durable event log. It holds no state of its own: the engine owns
// delivery state, Spans owns the run, and the only thing remembered here is
// how far each approved association has been read, kept in the Spans archive
// and advanced by the same transaction that writes the events.
//
// The store it is given is deliberately narrow: it can read a run, read a
// cursor and commit an import. It has no way to commit a run view, so a
// message cannot change a plan generation, a span or an accepted completion.
import {
  LINKS_HISTORY_LIMITS,
  mapEngineBatch,
  projectionKeyOf,
} from './links-history.js';

const MAX_CONFLICT_RETRIES = 3;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUNS_PER_PAGE = 50;
const isFunction = (value) => typeof value === 'function';

export function createLinksProjection({
  associations,
  batchEvents = LINKS_HISTORY_LIMITS.batchEvents,
  engine,
  store,
} = {}) {
  if (
    !(
      isFunction(engine?.events) &&
      isFunction(associations?.listApproved) &&
      isFunction(store?.commitImport) &&
      isFunction(store?.readSourceCursor) &&
      Number.isInteger(batchEvents) &&
      batchEvents >= 1 &&
      batchEvents <= LINKS_HISTORY_LIMITS.batchEvents
    )
  ) {
    throw new TypeError(
      'The Links projection needs an engine reader, associations and an import store'
    );
  }

  // Reads one page of the engine log for one association's hint and origin.
  // The engine answers later (a child process per operation), so this is a
  // promise: the run, its approval and the cursor can all change before it
  // settles, and only the archive's own fence decides what may be written.
  const readPage = (association, after, limit = batchEvents) =>
    engine.events({
      after,
      limit,
      origin: association.origin,
      runHint: association.hint,
    });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One association is read, mapped and committed in a single loop so every exit leaves the cursor consistent.
  async function projectOne(association, storeId, maxBatches) {
    const key = projectionKeyOf({
      associationId: association.associationId,
      storeId,
    });
    const fence = {
      associationId: association.associationId,
      generation: association.generation,
      runId: association.runId,
    };
    const summary = {
      associationId: association.associationId,
      engineHead: null,
      hint: association.hint,
      origin: association.origin,
      pending: false,
      projected: 0,
      projectedThrough: 0,
      runId: association.runId,
      state: 'ok',
    };
    const stop = (state, code) => ({
      ...summary,
      state,
      ...(code ? { code } : {}),
      pending: true,
    });

    let conflicts = 0;
    for (let batch = 0; batch < maxBatches; ) {
      const cursor = store.readSourceCursor(key);
      if (cursor?.ok !== true) {
        return stop('archive-unavailable', 'LINKS_ARCHIVE_UNAVAILABLE');
      }
      const { offset } = cursor;
      summary.projectedThrough = offset;
      // biome-ignore lint/performance/noAwaitInLoops: each batch depends on the cursor the previous one committed.
      const page = await readPage(association, offset);
      if (page?.ok !== true) {
        return stop('engine-unavailable', 'LINKS_ENGINE_UNAVAILABLE');
      }
      if (page.store_id !== storeId) {
        return stop('engine-changed', 'LINKS_ENGINE_CHANGED');
      }
      summary.engineHead = page.head;
      const mapped = mapEngineBatch({
        events: page.events,
        expectedOffset: offset,
        next: page.next,
        runId: association.runId,
        storeId,
      });
      if (mapped.ok !== true) {
        return stop('blocked', mapped.code);
      }
      if (mapped.events.length === 0 && mapped.nextOffset === offset) {
        summary.pending = page.has_more === true || page.head > offset;
        return summary;
      }
      const committed = store.commitImport({
        ...key,
        events: mapped.events,
        expectedOffset: offset,
        fence,
        nextOffset: mapped.nextOffset,
      });
      if (committed?.ok !== true) {
        // A concurrent worker won this offset: read the cursor again.
        if (committed?.code === 'SPANS_MODEL_OFFSET_CONFLICT') {
          conflicts += 1;
          if (conflicts > MAX_CONFLICT_RETRIES) {
            return stop('busy', 'LINKS_ARCHIVE_BUSY');
          }
          continue;
        }
        if (committed?.code === 'SPANS_MODEL_FENCE_STALE') {
          return stop('stale', 'LINKS_ASSOCIATION_STALE');
        }
        if (committed?.code === 'SPANS_MODEL_EVENT_REFUSED') {
          return stop('blocked', 'LINKS_PROJECTION_CONFLICT');
        }
        return stop('archive-unavailable', 'LINKS_ARCHIVE_UNAVAILABLE');
      }
      batch += 1;
      summary.projected += committed.duplicate ? 0 : mapped.events.length;
      summary.projectedThrough = mapped.nextOffset;
      const pending = page.has_more === true || page.head > mapped.nextOffset;
      summary.pending = pending;
      if (!pending) {
        return summary;
      }
    }
    return summary;
  }

  /**
   * Projects every currently approved association, at most `maxBatches` engine
   * pages each. `complete` is true only when nothing is left pending. Anything
   * unexpected from the archive is not caught here: a worker that dies
   * mid-batch leaves the cursor where the last whole batch put it.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The pass over runs, failures and associations is one ordered loop.
  async function runOnce({ maxBatches = 20, maxRuns = 10_000 } = {}) {
    // The probe learns which engine store this is; it reads one row at most.
    const probe = await engine.events({ after: 0, limit: 1 });
    if (probe?.ok !== true) {
      return {
        associations: [],
        complete: false,
        engine: 'unavailable',
        ok: true,
      };
    }
    if (probe.store_id === null) {
      return { associations: [], complete: true, engine: 'absent', ok: true };
    }
    const results = [];
    let afterRunId;
    let scanned = 0;
    let more = true;
    while (more && scanned < maxRuns) {
      // biome-ignore lint/performance/noAwaitInLoops: pages of runs are walked in order from the previous page's cursor.
      const page = await associations.listApproved({
        ...(afterRunId === undefined ? {} : { afterRunId }),
        limit: RUNS_PER_PAGE,
      });
      if (page?.ok !== true) {
        results.push({
          code: page?.code,
          pending: true,
          state: 'archive-unavailable',
        });
        break;
      }
      // A run that could not be read is named and the pass goes on: one bad
      // or purged run must not stop the runs after it.
      for (const failed of page.errors ?? []) {
        results.push({
          code: failed.code,
          pending: true,
          runId: failed.runId,
          state: 'run-unreadable',
        });
      }
      for (const association of page.associations) {
        // biome-ignore lint/performance/noAwaitInLoops: associations are projected one at a time so each leaves its own cursor consistent.
        results.push(await projectOne(association, probe.store_id, maxBatches));
      }
      scanned += RUNS_PER_PAGE;
      afterRunId = page.nextRunId ?? undefined;
      more = page.hasMore === true && afterRunId !== undefined;
    }
    return {
      associations: results,
      complete: !more && results.every((r) => r.pending === false),
      engine: 'ok',
      ok: true,
    };
  }

  /**
   * What is still to project for one run: a passive read. It writes nothing,
   * starts nothing and builds no index; an engine that is absent or down is
   * said so rather than reported as "nothing pending".
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The passive status mirrors the projection's own checks one for one.
  async function status({ runId } = {}) {
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
      return {
        code: 'LINKS_INVALID',
        error: 'Invalid Links request.',
        ok: false,
      };
    }
    const listed = await associations.listForRun({ runId });
    if (listed?.ok !== true) {
      return listed;
    }
    const rows = [];
    // With nothing approved there is nothing to be behind on, so the engine
    // is not asked: a run that does not use Links never depends on it.
    if (!listed.associations.some((a) => a.status === 'approved')) {
      return {
        associations: listed.associations.map((association) => ({
          associationId: association.associationId,
          engineHead: 0,
          generation: association.generation,
          hint: association.hint,
          origin: association.origin,
          pending: false,
          projectedThrough: 0,
          status: association.status,
        })),
        engine: 'unchecked',
        ok: true,
      };
    }
    const probe = await engine.events({ after: 0, limit: 1 });
    if (probe?.ok !== true) {
      return { associations: [], engine: 'unavailable', ok: true };
    }
    const absent = probe.store_id === null;
    for (const association of listed.associations) {
      const row = {
        associationId: association.associationId,
        engineHead: absent ? 0 : probe.head,
        generation: association.generation,
        hint: association.hint,
        origin: association.origin,
        pending: false,
        projectedThrough: 0,
        status: association.status,
      };
      if (association.status === 'approved' && !absent) {
        const key = projectionKeyOf({
          associationId: association.associationId,
          storeId: probe.store_id,
        });
        const cursor = store.readSourceCursor(key);
        row.projectedThrough = cursor?.ok === true ? cursor.offset : 0;
        // biome-ignore lint/performance/noAwaitInLoops: one bounded probe per association of a single run.
        const page = await readPage(association, row.projectedThrough, 1);
        if (page?.ok !== true) {
          return { associations: [], engine: 'unavailable', ok: true };
        }
        row.pending = page.events.length > 0 || page.has_more === true;
      }
      rows.push(row);
    }
    return { associations: rows, engine: absent ? 'absent' : 'ok', ok: true };
  }

  return Object.freeze({ runOnce, status });
}

/**
 * The projection's engine reader over the Links client. The client starts one
 * engine process per operation and answers later, so this is asynchronous all
 * the way down: nothing here blocks the portal. A failed or malformed answer
 * is a failure, never an empty page.
 */
export function createLinksEventsReader(client) {
  if (!isFunction(client?.call)) {
    throw new TypeError('The events reader needs a Links client');
  }
  return Object.freeze({
    async events({ after, limit, origin, runHint }) {
      const reply = await client.call('events', {
        after,
        limit,
        ...(origin === undefined ? {} : { origin }),
        ...(runHint === undefined ? {} : { run_hint: runHint }),
      });
      return reply?.ok === true
        ? { ok: true, ...reply.result }
        : { code: reply?.code ?? 'LINKS_ENGINE_UNAVAILABLE', ok: false };
    },
  });
}
