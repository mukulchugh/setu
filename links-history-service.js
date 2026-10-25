// The Links side of Spans history: association approvals, evidence, recovery
// and projection, composed over the Links client (the engine is the only owner
// of message state) and the Spans archive (the only owner of runs). Every
// reader here is passive: a GET never writes the archive, never builds an
// index and never starts the projection. Mutations are explicit user actions,
// each one a single archive transaction.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { createLinksAssociations } from './links-associations.js';
import { associationIdOf } from './links-history.js';
import {
  createLinksEventsReader,
  createLinksProjection,
} from './links-projection.js';
import { createSpansArtifacts } from './spans-artifacts.js';
import { SPANS_MODEL_LIMITS } from './spans-model-store.js';
import { openSpansStore, SPANS_STORE_DATABASE_FILE } from './spans-store.js';

export const LINKS_RECOVERY_LIMITS = Object.freeze({ default: 50, max: 200 });
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = new Set(['delivery', 'unassociated']);
const ATTENTION_STATES = ['held', 'handoff-unknown'];
const MAX_INDEXED_RUNS = 16;
// Each individual model write is bounded by one maximum batch, one maximum
// document and SQLite journal/WAL bookkeeping. This bound is reused for every
// import batch and every fixed-size derived index entry, never multiplied by
// the number of runs in a projection pass.
export const LINKS_ARCHIVE_WRITE_MAX_BYTES =
  2 * SPANS_MODEL_LIMITS.batchBytes + SPANS_MODEL_LIMITS.documentBytes;
const admissionOutcomeUnknown = () => ({
  ...failure(
    'SPANS_ARCHIVE_WRITE_UNKNOWN',
    'Archive write outcome is unknown; inspect the archive before retrying.'
  ),
  unknown: true,
});
// Replies by which an engine that predates a listing refuses the request.
const UPGRADE_CODES = new Set([
  'LINKS_FIELD_UNSUPPORTED',
  'LINKS_REQUEST_INVALID',
  'LINKS_UNKNOWN_OP',
]);

const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});
const invalid = () => failure('LINKS_INVALID', 'Invalid Links request.');
const archiveUnavailable = () =>
  failure(
    'LINKS_ARCHIVE_UNAVAILABLE',
    'There is no Spans archive to read or change yet.'
  );
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The dispatcher adds `source` to POST bodies; it is attribution only.
function withoutSource(input) {
  if (!isRecord(input)) {
    return null;
  }
  const { source: _source, ...rest } = input;
  return rest;
}

// A derived lookup from an (origin, hint) pair to the runs that have approved
// it, so Recovery can name the run without scanning every run. The run view
// stays the authority: an entry is only ever a pointer that is checked against
// the run before it is believed, and a missing one means "no approval found".
// A peer is `peer:<key>`; the roster lists the bare key. A bare 64-hex key is
// taken as that peer, so both spellings name one origin.
const BARE_KEY = /^[0-9a-f]{64}$/;
const canonicalOrigin = (origin) =>
  BARE_KEY.test(origin) ? `peer:${origin}` : origin;

const indexKey = (origin, hint) =>
  `links-assoc-index:${createHash('sha256')
    .update(JSON.stringify([origin, hint]), 'utf8')
    .digest('hex')}`;

// `overflow` means more runs approved this pair than the entry keeps, or a run
// could not be read when the entry was built: what is listed is then a floor,
// never the whole story.
function readIndex(store, origin, hint) {
  const read = store.readCache(indexKey(origin, hint));
  const entry = read?.ok === true ? read.entry : undefined;
  return {
    overflow: entry?.overflow === true,
    runs: Array.isArray(entry?.runs)
      ? entry.runs.filter((id) => typeof id === 'string' && IDENTIFIER.test(id))
      : [],
  };
}

function writeIndex(store, origin, hint, update) {
  const current = readIndex(store, origin, hint);
  const wanted = update(current.runs);
  return store.writeCache(indexKey(origin, hint), {
    overflow: current.overflow || wanted.length > MAX_INDEXED_RUNS,
    runs: wanted.slice(-MAX_INDEXED_RUNS),
  });
}

async function useArchiveHandle(store, work) {
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await work(store);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeResult;
  let closeError;
  try {
    closeResult = store.close();
  } catch (error) {
    closeError = error;
  }
  if (closeError || closeResult?.ok === false) {
    throw new Error('Archive connection could not close.', {
      cause: closeError ?? operationError,
    });
  }
  if (operationFailed) {
    throw operationError;
  }
  return result;
}

export function createLinksHistoryService({
  client,
  listPeers,
  newArtifacts = (root) => createSpansArtifacts({ root }),
  openStore = openSpansStore,
  archiveWrite,
  spansRoot,
} = {}) {
  if (!(typeof client?.call === 'function' && typeof spansRoot === 'string')) {
    throw new TypeError(
      'Links history needs a client and a Spans archive root'
    );
  }
  // Roster read through the same client; absent in an engine without peers.
  const rosterOf =
    listPeers ??
    (async () => {
      const reply = await client.call('peer_list', {});
      return reply.ok
        ? {
            ok: true,
            peers: (reply.result.peers ?? []).map((peer) => peer.peer_id),
          }
        : reply;
    });

  // A missing archive is reported, never created: initialisation belongs to
  // explicit draft creation.
  function archiveExists() {
    try {
      const file = lstatSync(join(spansRoot, SPANS_STORE_DATABASE_FILE));
      return file.isFile() && !file.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async function withArchive(mode, work) {
    if (!archiveExists()) {
      return archiveUnavailable();
    }
    let store;
    try {
      store = openStore({
        create: false,
        readonly: mode === 'read',
        root: spansRoot,
      });
    } catch {
      return failure(
        'LINKS_ARCHIVE_UNAVAILABLE',
        'The Spans archive could not be opened.'
      );
    }
    return await useArchiveHandle(store, work);
  }

  // Projection keeps its reader open across engine pages and imports. Each
  // admitted write uses a separate connection that can only open an existing
  // current archive; a refused admission never reaches this open.
  async function withExistingWritableArchive(work) {
    const store = openStore({ create: false, root: spansRoot });
    return await useArchiveHandle(store, work);
  }

  // The injected production collaborator admits exactly one bounded SQLite
  // write. Direct service tests remain a trusted lower-level seam and may run
  // the same connection-scoped effect without an admission coordinator.
  async function writeArchive(effect, onAttempt) {
    const runEffect = async () => {
      onAttempt?.();
      return await withExistingWritableArchive(effect);
    };
    if (typeof archiveWrite !== 'function') {
      try {
        return { ok: true, value: await runEffect() };
      } catch {
        return admissionOutcomeUnknown();
      }
    }
    let effectRan = false;
    try {
      const admitted = await archiveWrite(
        {
          maxBytes: LINKS_ARCHIVE_WRITE_MAX_BYTES,
          root: resolvePath(spansRoot),
        },
        async () => {
          if (effectRan) {
            throw new Error('Archive admission effect ran more than once.');
          }
          effectRan = true;
          return await runEffect();
        }
      );
      if (admitted?.ok !== true) {
        return effectRan
          ? admissionOutcomeUnknown()
          : (admitted ?? admissionOutcomeUnknown());
      }
      if (!(effectRan && Object.hasOwn(admitted, 'value'))) {
        return admissionOutcomeUnknown();
      }
      return { ok: true, value: admitted.value };
    } catch {
      return admissionOutcomeUnknown();
    }
  }

  // `local` is this machine. A peer must be on the roster, read now; an
  // unreadable roster is its own answer, never a silent "unknown peer".
  async function originCheck(origin) {
    if (typeof origin !== 'string' || !IDENTIFIER.test(origin)) {
      return invalid();
    }
    if (origin === 'local') {
      return { known: new Set(['local']), ok: true, origin };
    }
    const canonical = canonicalOrigin(origin);
    const roster = await rosterOf();
    if (roster?.ok !== true) {
      return failure(
        'LINKS_ORIGIN_UNVERIFIABLE',
        'The peer roster could not be read, so this origin cannot be confirmed. Start the Links engine and try again.'
      );
    }
    return roster.peers.some((id) => canonicalOrigin(id) === canonical)
      ? { known: new Set([canonical]), ok: true, origin: canonical }
      : failure(
          'LINKS_ORIGIN_UNKNOWN',
          'That origin is not this machine or a known peer.'
        );
  }

  const associationsOver = (store, known, artifacts) =>
    createLinksAssociations({
      artifacts,
      isKnownOrigin: (origin) => known.has(origin),
      store,
    });

  async function viaAssociations(mode, input, run, { artifacts = false } = {}) {
    const request = withoutSource(input);
    if (!request) {
      return invalid();
    }
    const checked = await originCheck(request.origin);
    if (checked.ok !== true) {
      return checked;
    }
    const canonical = { ...request, origin: checked.origin };
    return withArchive(mode, (store) =>
      run(
        associationsOver(
          store,
          checked.known,
          artifacts ? newArtifacts(spansRoot) : undefined
        ),
        canonical,
        store
      )
    );
  }

  const associationPreview = (input) =>
    viaAssociations('read', input, (links, request) => links.preview(request));

  const associationApprove = (input) =>
    viaAssociations('write', input, (links, request, store) => {
      const result = links.approve(request);
      if (result.ok) {
        writeIndex(store, request.origin, request.hint, (runs) =>
          runs.includes(request.runId) ? runs : [...runs, request.runId]
        );
      }
      return result;
    });

  // Withdrawing must work when the engine is down and after the peer was
  // removed, which is when it matters most: it needs no roster and no
  // network, only a well-formed request naming an approval that exists.
  // The index keeps a revoked run so Recovery can say "revoked".
  function associationRevoke(input) {
    const request = withoutSource(input);
    if (!(request && typeof request.origin === 'string')) {
      return Promise.resolve(invalid());
    }
    return withArchive('write', (store) =>
      createLinksAssociations({ isKnownOrigin: () => true, store }).revoke({
        ...request,
        origin: canonicalOrigin(request.origin),
      })
    );
  }

  async function associations(input) {
    const request = withoutSource(input);
    if (
      !(request && IDENTIFIER.test(request.runId ?? '')) ||
      Object.keys(request).length !== 1
    ) {
      return invalid();
    }
    return await withArchive('read', (store) =>
      createLinksAssociations({ isKnownOrigin: () => true, store }).listForRun(
        request
      )
    );
  }

  // The engine's message, in the shape the archive record is built from.
  // `origin` is the engine's own once it reports one; before that, only the
  // local user can have sent a message the baseline engine returns.
  async function messageOf(messageId) {
    if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
      return invalid();
    }
    const shown = await client.call('show', { message_id: messageId });
    if (!shown.ok) {
      return shown;
    }
    const message = shown.result;
    const origin =
      message.origin ?? (message.sender?.kind === 'user' ? 'local' : null);
    if (origin === null) {
      return failure(
        'LINKS_ORIGIN_UNVERIFIABLE',
        'The engine did not say where this message came from.'
      );
    }
    return {
      message: {
        ...message,
        origin,
        recipient: {
          provider: message.recipient?.provider,
          session_hint: message.recipient?.session_hint,
        },
      },
      ok: true,
    };
  }

  // Evidence is requested by run and message only. The origin and the hint
  // come from the engine's own record of the message, never from the caller,
  // so a request cannot name an association the message does not carry.
  async function viaEvidence(mode, input, run) {
    const request = withoutSource(input);
    const allowed = new Set(['confirmation', 'messageId', 'runId', 'spanId']);
    if (!(request && Object.keys(request).every((key) => allowed.has(key)))) {
      return invalid();
    }
    const found = await messageOf(request.messageId);
    if (found.ok !== true) {
      return found;
    }
    if (typeof found.message.run_hint !== 'string') {
      return failure(
        'LINKS_NOT_ASSOCIATED',
        'This message carries no run hint, so it cannot be tied to a run.'
      );
    }
    return viaAssociations(
      mode,
      {
        ...request,
        hint: found.message.run_hint,
        message: found.message,
        origin: found.message.origin,
      },
      (links, target) => run(links, target),
      { artifacts: true }
    );
  }

  const evidencePreview = (input) =>
    viaEvidence('read', input, (links, target) =>
      links.previewEvidence(target)
    );
  const evidenceAttach = (input) =>
    viaEvidence('write', input, (links, target) =>
      links.attachEvidence(target)
    );

  // The projection reads the engine through the client, one process round
  // trip at a time, and writes through the archive's fenced import only.
  function projectionOver(store, onWriteAttempt) {
    const projectionStore = Object.freeze({
      commitImport: async (input) => {
        const outcome = await writeArchive(
          (writer) => writer.commitImport(input),
          onWriteAttempt
        );
        return outcome?.ok === true ? outcome.value : outcome;
      },
      readRun: store.readRun,
      readSourceCursor: store.readSourceCursor,
    });
    return createLinksProjection({
      associations: createLinksAssociations({
        isKnownOrigin: () => true,
        store,
      }),
      engine: createLinksEventsReader(client),
      store: projectionStore,
    });
  }

  async function projectionStatus(input) {
    const request = withoutSource(input);
    if (!(request && Object.keys(request).join() === 'runId')) {
      return invalid();
    }
    return await withArchive('read', (store) =>
      projectionOver(store).status(request)
    );
  }

  // Approvals are the authority; the lookup index is only a pointer to them.
  // Projecting walks every run's approvals in bounded pages, so it rebuilds each
  // entry from them: approved runs first, the rest while there is room, and
  // `overflow` when something had to be left out or a run could not be read.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One bounded walk builds every entry, so it stays in one place.
  async function refreshIndex(store, onWriteAttempt) {
    const links = createLinksAssociations({
      isKnownOrigin: () => true,
      store,
    });
    const pairs = new Map();
    const errors = [];
    let afterRunId;
    for (;;) {
      const page = links.listAll({
        ...(afterRunId === undefined ? {} : { afterRunId }),
        limit: 50,
      });
      if (page.ok !== true) {
        return { errors, failure: page, ok: false };
      }
      errors.push(...page.errors);
      for (const association of page.associations) {
        const key = JSON.stringify([association.origin, association.hint]);
        const pair = pairs.get(key) ?? {
          approved: [],
          hint: association.hint,
          origin: association.origin,
          others: [],
        };
        (association.status === 'approved' ? pair.approved : pair.others).push(
          association.runId
        );
        pairs.set(key, pair);
      }
      if (!(page.hasMore && page.nextRunId)) {
        break;
      }
      afterRunId = page.nextRunId;
    }
    for (const pair of pairs.values()) {
      const runs = [...pair.others, ...pair.approved];
      // biome-ignore lint/performance/noAwaitInLoops: Every cache row needs a separate admission, and refusal stops later writes.
      const written = await writeArchive(
        (writer) =>
          writer.writeCache(indexKey(pair.origin, pair.hint), {
            overflow: runs.length > MAX_INDEXED_RUNS || errors.length > 0,
            runs: runs.slice(-MAX_INDEXED_RUNS),
          }),
        onWriteAttempt
      );
      if (written?.ok !== true) {
        return { errors, failure: written, ok: false };
      }
      if (written.value?.ok !== true) {
        return { errors, failure: written.value, ok: false };
      }
    }
    return { errors, ok: true };
  }

  async function project({ maxBatches } = {}) {
    let writeAttempted = false;
    try {
      return await withArchive('read', async (store) => {
        const onWriteAttempt = () => {
          writeAttempted = true;
        };
        const index = await refreshIndex(store, onWriteAttempt);
        if (!index.ok) {
          return (
            index.failure ??
            failure(
              'LINKS_ARCHIVE_UNAVAILABLE',
              'The Spans archive index could not be refreshed.'
            )
          );
        }
        const result = await projectionOver(store, onWriteAttempt).runOnce({
          maxBatches,
        });
        return index.errors.length > 0
          ? { ...result, indexErrors: index.errors }
          : result;
      });
    } catch {
      // A reader close can fail after an admitted write already committed.
      // Report an unknown outcome so callers do not treat it as safe replay.
      return writeAttempted
        ? admissionOutcomeUnknown()
        : failure(
            'LINKS_ARCHIVE_UNAVAILABLE',
            'The Spans archive could not be opened.'
          );
    }
  }

  // -------------------------------------------------------------------------
  // Recovery: bounded engine pages, classified against approvals by index.
  // -------------------------------------------------------------------------

  function recoveryRequest(input) {
    const request = withoutSource(input);
    const allowed = new Set(['afterId', 'kind', 'limit', 'runId']);
    if (!(request && Object.keys(request).every((key) => allowed.has(key)))) {
      return null;
    }
    const kind = request.kind ?? 'delivery';
    const limit =
      request.limit === undefined
        ? LINKS_RECOVERY_LIMITS.default
        : Number(request.limit);
    if (
      !(
        KINDS.has(kind) &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= LINKS_RECOVERY_LIMITS.max &&
        (request.afterId === undefined || MESSAGE_ID.test(request.afterId)) &&
        (request.runId === undefined || IDENTIFIER.test(request.runId))
      )
    ) {
      return null;
    }
    return { afterId: request.afterId, kind, limit, runId: request.runId };
  }

  const originOf = (message) =>
    message.origin ?? (message.sender?.kind === 'user' ? 'local' : null);

  function engineFailure(reply) {
    // An engine that predates the run-linked listing refuses the new
    // arguments; say that instead of showing an empty list.
    return UPGRADE_CODES.has(reply.code)
      ? failure(
          'LINKS_ENGINE_UPGRADE_REQUIRED',
          'This Links engine cannot list run-linked messages yet.'
        )
      : failure(
          'LINKS_ENGINE_UNAVAILABLE',
          'The Links engine is unavailable, so message state is not shown.'
        );
  }

  // Where does this origin+hint stand against the archive's approvals?
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The run statuses map to one rejection reason in a single table.
  function disposition(store, cache, origin, hint) {
    const cacheKey = `${origin}\u0000${hint}`;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    let answer = { attached: false, rejection: 'unapproved', runIds: [] };
    const links = store
      ? createLinksAssociations({ isKnownOrigin: () => true, store })
      : null;
    if (links && origin !== null && IDENTIFIER.test(hint ?? '')) {
      const statuses = [];
      const indexed = readIndex(store, origin, hint);
      for (const runId of indexed.runs) {
        const listed = links.listForRun({ runId });
        const wanted = associationIdOf({ hint, origin, runId });
        const row = listed.ok
          ? listed.associations.find((a) => a.associationId === wanted)
          : null;
        statuses.push({
          runId,
          status: listed.ok ? (row?.status ?? 'none') : 'unknown-run',
        });
      }
      const current = statuses.filter((s) => s.status === 'approved');
      if (current.length > 0) {
        answer = { attached: true, runIds: current.map((s) => s.runId) };
      } else if (indexed.overflow) {
        // Not everything that may approve this pair is listed, so neither
        // "revoked" nor "unapproved" is a claim that can be made.
        answer = {
          attached: false,
          rejection: 'index-incomplete',
          runIds: statuses.map((s) => s.runId),
        };
      } else if (statuses.length > 0) {
        const order = ['stale', 'revoked', 'unknown-run', 'none'];
        const first = order.find((o) => statuses.some((s) => s.status === o));
        answer = {
          attached: false,
          rejection: {
            none: 'unapproved',
            revoked: 'revoked',
            stale: 'stale-generation',
            'unknown-run': 'unknown-run',
          }[first],
          runIds: statuses.map((s) => s.runId),
        };
      }
    } else if (links && origin === null) {
      answer = { attached: false, rejection: 'origin-unknown', runIds: [] };
    }
    cache.set(cacheKey, answer);
    return answer;
  }

  async function recovery(input) {
    const request = recoveryRequest(input);
    if (!request) {
      return invalid();
    }
    const args =
      request.kind === 'delivery'
        ? { states: ATTENTION_STATES }
        : { has_run_hint: true };
    const listed = await client.call('list', {
      ...args,
      limit: request.limit,
      ...(request.afterId === undefined ? {} : { after_id: request.afterId }),
    });
    if (!listed.ok) {
      return engineFailure(listed);
    }
    const page = listed.result;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One pass classifies each listed message against the approvals.
    const resolve = (store) => {
      const cache = new Map();
      const items = [];
      for (const message of page.messages) {
        const origin = originOf(message);
        const hint = message.run_hint ?? null;
        const where =
          hint === null
            ? { attached: false, rejection: null, runIds: [] }
            : disposition(store, cache, origin, hint);
        // A message the lookup cannot place might belong to the run asked
        // about, so it stays in view with its uncertainty rather than vanish.
        const scoped =
          request.runId === undefined ||
          where.runIds.includes(request.runId) ||
          where.rejection === 'index-incomplete';
        const show =
          request.kind === 'delivery' ? scoped : !where.attached && scoped;
        if (show) {
          items.push({
            disposition: where.attached ? 'attached' : 'unassociated',
            hint,
            messageId: message.message_id,
            openPath: `/api/links/message?messageId=${encodeURIComponent(message.message_id)}`,
            origin,
            ...(where.rejection ? { rejection: where.rejection } : {}),
            reason: message.reason ?? null,
            runIds: where.runIds,
            spanHint: message.span_hint ?? null,
            state: message.state,
          });
        }
      }
      return items;
    };
    // With no archive, nothing can be approved: every run-linked item is
    // simply unapproved, and delivery items are still shown.
    const items = archiveExists()
      ? await withArchive('read', resolve)
      : await resolve(null);
    if (items.ok === false) {
      return items;
    }
    return {
      items,
      kind: request.kind,
      moreAfter: page.has_more === true ? (page.next_after ?? null) : null,
      ok: true,
    };
  }

  return Object.freeze({
    associationApprove,
    associationPreview,
    associationRevoke,
    associations,
    evidenceAttach,
    evidencePreview,
    project,
    projectionStatus,
    recovery,
  });
}
