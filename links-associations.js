// The local user's approval that a peer's (or their own) run hint means one
// local run. Spans owns runs, so the approval lives in the run's view next to
// an immutable event, written by one run transaction with the store's
// revision and generation checks. A message never approves anything: a hint is
// only ever a lookup key into approvals the user made here, per origin, for the
// run's current plan generation.
import { createHash } from 'node:crypto';
import { associationIdOf, messageRecordOf } from './links-history.js';
import { redactSpansValue } from './spans-redaction.js';

export const LINKS_ASSOCIATION_LIMITS = Object.freeze({
  perRun: 64,
  retries: 4,
});

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = new Set(['approved', 'revoked']);
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

const failure = (code, error) => ({ code, error, ok: false });
const invalid = () =>
  failure('LINKS_INVALID', 'Invalid Links association request.');

const sha256 = (value) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const tokenOf = ({ generation, hint, origin, runId }) =>
  `associate:${sha256(['associate', runId, origin, hint, generation])}`;
const eventIdOf = (type, runId, associationId, epoch) =>
  `${type}:${sha256([type, runId, associationId, epoch])}`;

// Exactly these fields, each a bounded identifier. `confirmation` is optional
// so that its absence can be reported as such.
function readTarget(input, withConfirmation) {
  if (!isRecord(input)) {
    return null;
  }
  const allowed = new Set(['hint', 'origin', 'runId']);
  if (withConfirmation) {
    allowed.add('confirmation');
  }
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return null;
  }
  const { hint, origin, runId } = input;
  // An identifier the redactor would rewrite is refused here: stored as
  // "[REDACTED]" it would be approved, never match anything and never be
  // revocable.
  if (
    ![hint, origin, runId].every(
      (v) =>
        typeof v === 'string' && identifier.test(v) && redactSpansValue(v) === v
    )
  ) {
    return null;
  }
  const { confirmation } = input;
  if (confirmation !== undefined && typeof confirmation !== 'string') {
    return null;
  }
  return { confirmation, hint, origin, runId };
}

function recordsOf(view) {
  const all = Object.hasOwn(view, 'linksAssociations')
    ? view.linksAssociations
    : undefined;
  return isRecord(all) ? all : {};
}

function validRecord(record) {
  return (
    isRecord(record) &&
    typeof record.origin === 'string' &&
    identifier.test(record.origin) &&
    typeof record.hint === 'string' &&
    identifier.test(record.hint) &&
    isCount(record.generation) &&
    isCount(record.epoch) &&
    STATUSES.has(record.status)
  );
}

// An approval holds only for the plan generation it was given for.
const statusOf = (record, generation) => {
  if (!validRecord(record)) {
    return 'none';
  }
  if (record.status === 'revoked') {
    return 'revoked';
  }
  return record.generation === generation ? 'approved' : 'stale';
};

function describe(runId, associationId, record, generation) {
  return {
    associationId,
    epoch: record.epoch,
    generation: record.generation,
    hint: record.hint,
    origin: record.origin,
    runId,
    status: statusOf(record, generation),
  };
}

// What to do next differs: a stale approval is reviewed again; a revoke that
// raced the plan is checked, since the plan change already made the approval
// stale and stopped it attaching anything new.
const staleCopy = (doing) =>
  doing === 'revoking'
    ? 'The plan changed while revoking. Check the approval’s status, then revoke again if it is still listed.'
    : `The plan changed while ${doing}. Review it again.`;

export function createLinksAssociations({
  artifacts,
  isKnownOrigin,
  store,
} = {}) {
  if (
    !(
      typeof isKnownOrigin === 'function' &&
      typeof store?.readRun === 'function' &&
      typeof store?.commitRun === 'function' &&
      typeof store?.listRuns === 'function'
    )
  ) {
    throw new TypeError(
      'Links associations need an origin check and a Spans run store'
    );
  }

  function loadRun(runId) {
    let read;
    try {
      read = store.readRun({ runId });
    } catch {
      return failure(
        'LINKS_ARCHIVE_UNAVAILABLE',
        'The Spans archive is unavailable.'
      );
    }
    if (read?.ok === true && isRecord(read.view)) {
      return read;
    }
    return read?.code === 'SPANS_MODEL_NOT_FOUND'
      ? failure('LINKS_RUN_UNKNOWN', 'No such Spans run.')
      : failure(
          'LINKS_ARCHIVE_UNAVAILABLE',
          'The Spans archive is unavailable.'
        );
  }

  function checkTarget(target) {
    return isKnownOrigin(target.origin)
      ? null
      : failure(
          'LINKS_ORIGIN_UNKNOWN',
          'That origin is not this machine or a known peer.'
        );
  }

  function preview(input) {
    const target = readTarget(input, false);
    if (!target) {
      return invalid();
    }
    const refused = checkTarget(target);
    if (refused) {
      return refused;
    }
    const read = loadRun(target.runId);
    if (read.ok !== true) {
      return read;
    }
    const associationId = associationIdOf(target);
    const record = recordsOf(read.view)[associationId];
    return {
      ok: true,
      review: {
        associationId,
        generation: read.generation,
        hint: target.hint,
        origin: target.origin,
        revision: read.revision,
        runId: target.runId,
        status: statusOf(record, read.generation),
        token: tokenOf({ ...target, generation: read.generation }),
      },
    };
  }

  // Reads the run, lets `change` build the next view and its event, and commits
  // both with the store's revision and generation checks. A revision that moved
  // for an unrelated reason is re-read; a generation that moved is a stale
  // approval and is never retried.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The read, generation check, change and compare-and-set retry stay in one transaction boundary.
  function transact(target, change, doing = 'approving') {
    let firstGeneration;
    for (
      let attempt = 0;
      attempt < LINKS_ASSOCIATION_LIMITS.retries;
      attempt += 1
    ) {
      const read = loadRun(target.runId);
      if (read.ok !== true) {
        return read;
      }
      firstGeneration ??= read.generation;
      if (read.generation !== firstGeneration) {
        return failure('LINKS_GENERATION_STALE', staleCopy(doing));
      }
      const view = structuredClone(read.view);
      const changed = change(read, view, attempt);
      if (changed.refused) {
        return changed.refused;
      }
      if (changed.done) {
        return changed.done;
      }
      let result;
      try {
        result = store.commitRun({
          events: [changed.event],
          expectedGeneration: read.generation,
          expectedRevision: read.revision,
          runId: target.runId,
          view: redactSpansValue(view),
        });
      } catch {
        return failure(
          'LINKS_ARCHIVE_UNAVAILABLE',
          'The Spans archive is unavailable.'
        );
      }
      if (result?.ok === true) {
        return { ...changed.result, ok: true, replayed: false };
      }
      if (result?.code === 'SPANS_MODEL_STALE_GENERATION') {
        return failure('LINKS_GENERATION_STALE', staleCopy(doing));
      }
      if (result?.code !== 'SPANS_MODEL_STALE_REVISION') {
        return failure(
          'LINKS_ARCHIVE_UNAVAILABLE',
          'The Spans archive is unavailable.'
        );
      }
    }
    return failure(
      'LINKS_ARCHIVE_BUSY',
      'The Spans run keeps changing; try again.'
    );
  }

  function approve(input) {
    const target = readTarget(input, true);
    if (!target) {
      return invalid();
    }
    const refused = checkTarget(target);
    if (refused) {
      return refused;
    }
    if (!target.confirmation) {
      return failure(
        'LINKS_CONFIRMATION_REQUIRED',
        'Review the association and confirm it.'
      );
    }
    const associationId = associationIdOf(target);
    return transact(target, (read, view, attempt) => {
      if (
        target.confirmation !==
        tokenOf({ ...target, generation: read.generation })
      ) {
        return {
          refused: failure(
            attempt === 0
              ? 'LINKS_CONFIRMATION_MISMATCH'
              : 'LINKS_GENERATION_STALE',
            'The reviewed association no longer matches the run. Review it again.'
          ),
        };
      }
      const records = recordsOf(view);
      const existing = records[associationId];
      if (statusOf(existing, read.generation) === 'approved') {
        return {
          done: {
            association: describe(
              target.runId,
              associationId,
              existing,
              read.generation
            ),
            ok: true,
            replayed: true,
          },
        };
      }
      if (
        !validRecord(existing) &&
        Object.keys(records).length >= LINKS_ASSOCIATION_LIMITS.perRun
      ) {
        return {
          refused: failure(
            'LINKS_ASSOCIATION_LIMIT',
            'This run has the most associations allowed.'
          ),
        };
      }
      const epoch = validRecord(existing) ? existing.epoch + 1 : 1;
      const record = {
        epoch,
        generation: read.generation,
        hint: target.hint,
        origin: target.origin,
        status: 'approved',
      };
      view.linksAssociations = { ...records, [associationId]: record };
      return {
        event: {
          eventId: eventIdOf(
            'links.association.approved',
            target.runId,
            associationId,
            epoch
          ),
          payload: {
            associationId,
            epoch,
            generation: read.generation,
            hint: target.hint,
            origin: target.origin,
          },
          runId: target.runId,
          type: 'links.association.approved',
        },
        result: {
          association: describe(
            target.runId,
            associationId,
            record,
            read.generation
          ),
        },
      };
    });
  }

  function revoke(input) {
    const target = readTarget(input, false);
    if (!target) {
      return invalid();
    }
    const associationId = associationIdOf(target);
    return transact(
      target,
      (read, view) => {
        const records = recordsOf(view);
        const existing = records[associationId];
        if (!validRecord(existing)) {
          return {
            refused: failure(
              'LINKS_ASSOCIATION_UNKNOWN',
              'No such association.'
            ),
          };
        }
        if (existing.status === 'revoked') {
          return {
            done: {
              association: describe(
                target.runId,
                associationId,
                existing,
                read.generation
              ),
              ok: true,
              replayed: true,
            },
          };
        }
        const epoch = existing.epoch + 1;
        const record = { ...existing, epoch, status: 'revoked' };
        view.linksAssociations = { ...records, [associationId]: record };
        return {
          event: {
            eventId: eventIdOf(
              'links.association.revoked',
              target.runId,
              associationId,
              epoch
            ),
            payload: {
              associationId,
              epoch,
              generation: existing.generation,
              hint: existing.hint,
              origin: existing.origin,
            },
            runId: target.runId,
            type: 'links.association.revoked',
          },
          result: {
            association: describe(
              target.runId,
              associationId,
              record,
              read.generation
            ),
          },
        };
      },
      'revoking'
    );
  }

  const describeAll = (runId, read) =>
    Object.entries(recordsOf(read.view))
      .filter(([, record]) => validRecord(record))
      .map(([id, record]) => describe(runId, id, record, read.generation))
      .sort((a, b) => (a.associationId < b.associationId ? -1 : 1));

  function listForRun(input) {
    if (
      !(
        isRecord(input) &&
        Object.keys(input).join() === 'runId' &&
        identifier.test(input.runId)
      )
    ) {
      return invalid();
    }
    const read = loadRun(input.runId);
    return read.ok === true
      ? { associations: describeAll(input.runId, read), ok: true }
      : read;
  }

  // One bounded page of runs; the caller resumes from nextRunId. A run that
  // cannot be read is reported by id and skipped: one bad or purged run must
  // not hide the runs after it, and the cursor still moves past it.
  function pageAssociations(input, keep) {
    if (
      !(
        isRecord(input) &&
        Object.keys(input).every(
          (key) => key === 'limit' || key === 'afterRunId'
        ) &&
        Number.isInteger(input.limit) &&
        input.limit >= 1 &&
        input.limit <= 200 &&
        (input.afterRunId === undefined || identifier.test(input.afterRunId))
      )
    ) {
      return invalid();
    }
    let page;
    try {
      page = store.listRuns({
        ...(input.afterRunId === undefined
          ? {}
          : { afterRunId: input.afterRunId }),
        limit: input.limit,
      });
    } catch {
      page = null;
    }
    if (page?.ok !== true || !Array.isArray(page.runs)) {
      return failure(
        'LINKS_ARCHIVE_UNAVAILABLE',
        'The Spans archive is unavailable.'
      );
    }
    const associations = [];
    const errors = [];
    for (const { runId } of page.runs) {
      const read = loadRun(runId);
      if (read.ok === true) {
        associations.push(...describeAll(runId, read).filter(keep));
      } else {
        errors.push({ code: read.code, runId });
      }
    }
    return {
      associations,
      errors,
      hasMore: page.hasMore === true,
      nextRunId: page.nextRunId ?? input.afterRunId ?? null,
      ok: true,
    };
  }

  const listApproved = (input) =>
    pageAssociations(input, (a) => a.status === 'approved');
  // Every status, for rebuilding the derived lookup.
  const listAll = (input) => pageAssociations(input, () => true);

  // -------------------------------------------------------------------------
  // Evidence: a selected message kept against a run, with its source and the
  // digest of the redacted copy. It is a reference for the run owner to judge;
  // it changes no span, writes no completion and is not a Spans event type.
  // -------------------------------------------------------------------------

  function readEvidence(input, withConfirmation) {
    const allowed = new Set([
      'hint',
      'message',
      'messageId',
      'origin',
      'runId',
      'spanId',
    ]);
    if (withConfirmation) {
      allowed.add('confirmation');
    }
    if (
      !isRecord(input) ||
      Object.keys(input).some((key) => !allowed.has(key))
    ) {
      return invalid();
    }
    const target = readTarget(
      { hint: input.hint, origin: input.origin, runId: input.runId },
      false
    );
    const { confirmation, message, messageId, spanId } = input;
    if (
      !(
        target &&
        typeof messageId === 'string' &&
        identifier.test(messageId) &&
        (spanId === undefined ||
          (typeof spanId === 'string' && identifier.test(spanId))) &&
        (confirmation === undefined || typeof confirmation === 'string')
      )
    ) {
      return invalid();
    }
    const built = messageRecordOf(message);
    if (built.ok !== true) {
      return invalid();
    }
    const refused = checkTarget(target);
    if (refused) {
      return refused;
    }
    if (
      message.message_id !== messageId ||
      message.origin !== target.origin ||
      message.run_hint !== target.hint
    ) {
      return failure(
        'LINKS_MESSAGE_MISMATCH',
        'That message does not belong to this association.'
      );
    }
    return {
      confirmation,
      ok: true,
      record: built.record,
      spanId: spanId ?? null,
      target,
    };
  }

  // The association must be approved now, for the run's current generation.
  function evidenceFence(read, parsed) {
    const { spanId, target } = parsed;
    const associationId = associationIdOf(target);
    if (
      statusOf(recordsOf(read.view)[associationId], read.generation) !==
      'approved'
    ) {
      return {
        associationId: null,
        refused: failure(
          'LINKS_NOT_ASSOCIATED',
          'This message is not associated with the run.'
        ),
      };
    }
    if (
      spanId !== null &&
      !(isRecord(read.view.spans) && Object.hasOwn(read.view.spans, spanId))
    ) {
      return {
        associationId: null,
        refused: failure('LINKS_SPAN_UNKNOWN', 'No such span in this run.'),
      };
    }
    return { associationId, refused: null };
  }

  const evidenceToken = (parsed, associationId, generation) =>
    `evidence:${sha256([
      'evidence',
      parsed.target.runId,
      associationId,
      generation,
      parsed.record.messageId,
      parsed.spanId,
      parsed.record,
    ])}`;

  function previewEvidence(input) {
    const parsed = readEvidence(input, false);
    if (parsed.ok !== true) {
      return parsed;
    }
    const read = loadRun(parsed.target.runId);
    if (read.ok !== true) {
      return read;
    }
    const fence = evidenceFence(read, parsed);
    if (fence.refused) {
      return fence.refused;
    }
    return {
      ok: true,
      review: {
        associationId: fence.associationId,
        generation: read.generation,
        hint: parsed.target.hint,
        messageId: parsed.record.messageId,
        origin: parsed.target.origin,
        record: parsed.record,
        revision: read.revision,
        runId: parsed.target.runId,
        spanId: parsed.spanId,
        token: evidenceToken(parsed, fence.associationId, read.generation),
      },
    };
  }

  // Evidence is an event under the same fence an import uses: the run must
  // still be at the reviewed generation with the approval in place, checked in
  // the transaction that appends. The run view is not rewritten and its
  // revision does not move, so no other writer's compare-and-set is disturbed.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The checks, the artifact, the replay and the fenced append read as one ordered sequence.
  function attachEvidence(input) {
    const parsed = readEvidence(input, true);
    if (parsed.ok !== true) {
      return parsed;
    }
    if (!parsed.confirmation) {
      return failure(
        'LINKS_CONFIRMATION_REQUIRED',
        'Review the evidence and confirm it.'
      );
    }
    if (
      !(
        typeof artifacts?.put === 'function' &&
        typeof store.getEventById === 'function' &&
        typeof store.commitFencedEvents === 'function'
      )
    ) {
      return failure(
        'LINKS_ARCHIVE_UNAVAILABLE',
        'The Spans archive is unavailable.'
      );
    }
    const read = loadRun(parsed.target.runId);
    if (read.ok !== true) {
      return read;
    }
    const fence = evidenceFence(read, parsed);
    if (fence.refused) {
      return fence.refused;
    }
    const { associationId } = fence;
    if (
      parsed.confirmation !==
      evidenceToken(parsed, associationId, read.generation)
    ) {
      return failure(
        'LINKS_CONFIRMATION_MISMATCH',
        'The reviewed evidence no longer matches. Review it again.'
      );
    }
    const stored = artifacts.put({
      mediaType: 'application/json',
      text: JSON.stringify(parsed.record),
    });
    if (stored?.ok !== true) {
      return failure(
        'LINKS_ARCHIVE_UNAVAILABLE',
        'The evidence could not be stored.'
      );
    }
    const { artifactId } = stored;
    const type = 'links.evidence.attached';
    const eventId = `${type}:${sha256([
      type,
      parsed.target.runId,
      associationId,
      parsed.record.messageId,
      parsed.spanId,
      artifactId,
    ])}`;
    const evidence = {
      artifactId,
      associationId,
      messageId: parsed.record.messageId,
      origin: parsed.target.origin,
      spanId: parsed.spanId,
      targetGeneration: read.generation,
      targetRevision: read.revision,
    };
    const replay = () => {
      const existing = store.getEventById({ eventId });
      return existing?.ok === true && existing.found === true
        ? { evidence: existing.event.payload, ok: true, replayed: true }
        : null;
    };
    const earlier = replay();
    if (earlier) {
      return earlier;
    }
    const result = store.commitFencedEvents({
      events: [
        { eventId, payload: evidence, runId: parsed.target.runId, type },
      ],
      fence: {
        associationId,
        generation: read.generation,
        runId: parsed.target.runId,
      },
    });
    if (result?.ok === true) {
      return { evidence, ok: true, replayed: false };
    }
    if (result?.code === 'SPANS_MODEL_FENCE_STALE') {
      // Say which: a plan that moved, or an approval that is gone.
      const now = loadRun(parsed.target.runId);
      return now.ok === true && now.generation !== read.generation
        ? failure(
            'LINKS_GENERATION_STALE',
            'The plan changed while attaching. Review it again.'
          )
        : failure(
            'LINKS_NOT_ASSOCIATED',
            'This message is not associated with the run.'
          );
    }
    // A concurrent identical attach wins the event id; that is a replay.
    return (
      replay() ??
      failure('LINKS_ARCHIVE_UNAVAILABLE', 'The Spans archive is unavailable.')
    );
  }

  return Object.freeze({
    approve,
    attachEvidence,
    listAll,
    listApproved,
    listForRun,
    preview,
    previewEvidence,
    revoke,
  });
}
