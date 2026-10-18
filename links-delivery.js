// Natural-turn delivery for an authenticated Claude hook. The hook proves one exact conversation with the
// per-launch capability; that tuple is captured once and is the only thing the engine is ever asked about,
// so a conversation bound after authentication can neither receive nor confirm this one's mail. Claim,
// write and confirm are separate steps because only the hook knows it wrote the text.
//
// Before the engine claim, any failure leaves mail queued. From the claim on, any uncertainty is a
// handoff-unknown held by the engine; nothing here ever returns mail to the queue or claims it again.

import { canonicalCheckout } from './links-service.js';
import { PROMPT_HOOK_BUDGET } from './managed-claude-hook.js';

const attemptPattern = /^[A-Za-z0-9_-]{1,128}$/;
const failure = (code, error, extra = {}) => ({
  code,
  error,
  ok: false,
  ...extra,
});
// Nothing was waiting: a turn with no mail.
const noMail = Object.freeze({ attemptId: null, ok: true, text: '' });

const unauthorized = (reason) =>
  failure(
    'HOOK_BINDING_UNAUTHORIZED',
    'The hook cannot prove its launch binding',
    {
      reason,
    }
  );

const sameConversation = (a, b) =>
  a.sessionId === b.sessionId &&
  a.nativeId === b.nativeId &&
  a.boundAt === b.boundAt &&
  a.generation === b.generation &&
  canonicalCheckout(a.checkoutIdentity) ===
    canonicalCheckout(b.checkoutIdentity);

export function createLinksDelivery({
  resolve,
  links,
  announce,
  activity,
} = {}) {
  if (!(typeof resolve === 'function' && links?.claimExact)) {
    throw new TypeError('Links delivery needs hook resolution and exact claim');
  }

  function noteActivity(sessionId) {
    try {
      Promise.resolve(activity?.(sessionId)).catch(() => {
        // Bookkeeping only.
      });
    } catch {
      // Bookkeeping only.
    }
  }

  // Tells the lifecycle publisher about a session. Never throws; the wait is bounded by the announcer
  // (a few hundred milliseconds at most, and none while a call for the session is already unresolved).
  async function tell(sessionId) {
    try {
      await announce?.(sessionId);
    } catch {
      // Delivery does not depend on the publisher.
    }
  }

  // What the hook has proved right now, or why it has proved nothing.
  async function authenticate({ launchToken, payload }) {
    let resolved;
    try {
      resolved = await resolve({
        checkoutPath: payload?.cwd,
        launchToken,
        nativeSessionId: payload?.session_id,
        provider: 'claude-code',
      });
    } catch {
      return unauthorized('binding-unavailable');
    }
    if (!(resolved?.ok === true && resolved.nativeId && resolved.sessionId)) {
      // A refusal that changed the record (a replaced checkout) is still a lifecycle fact to announce.
      if (resolved?.sessionId) {
        await tell(resolved.sessionId);
      }
      return unauthorized(resolved?.reason ?? 'binding-unavailable');
    }
    return {
      ok: true,
      tuple: {
        boundAt: resolved.boundAt,
        checkoutIdentity: resolved.checkoutIdentity,
        generation: resolved.generation ?? 0,
        nativeId: resolved.nativeId,
        provider: 'claude-code',
        resumedFrom: resolved.resumedFrom ?? [],
        sessionId: resolved.sessionId,
      },
    };
  }

  const recipient = (tuple) => ({
    checkoutIdentity: tuple.checkoutIdentity,
    nativeId: tuple.nativeId,
    provider: tuple.provider,
    resumedFrom: tuple.resumedFrom,
    sessionId: tuple.sessionId,
  });

  // The conversation is still the proven one. Authentication is repeated rather than trusted, because
  // the engine call in between is asynchronous and the binding can move meanwhile.
  async function stillHolds(request, tuple) {
    const again = await authenticate(request);
    return again.ok && sameConversation(again.tuple, tuple);
  }

  async function deliver(request) {
    const first = await authenticate(request);
    if (!first.ok) {
      return first;
    }
    const { tuple } = first;
    // This prompt submission was just authenticated with the launch capability: it is the one event that
    // counts as the session's activity. Started, not awaited, and a failure never touches delivery.
    noteActivity(tuple.sessionId);
    // A normal turn of a live conversation is the heartbeat of its binding.
    await tell(tuple.sessionId);
    if (!(await stillHolds(request, tuple))) {
      return failure(
        'HOOK_BINDING_CHANGED',
        'The conversation changed before delivery'
      );
    }
    // The claim is fenced by the generation the managed authority just proved for this conversation. The engine
    // refuses it, changing nothing, unless the published snapshot is this conversation at this generation; a
    // refusal means the mail stays queued, never that the claim is retried without the fence.
    const claimed = await links.claimExact({
      expectedGeneration: tuple.generation,
      recipient: recipient(tuple),
    });
    if (!claimed.ok) {
      return failure(claimed.code, claimed.error);
    }
    if (claimed.attemptId === null) {
      return noMail;
    }
    // The provider cuts plain hook output off past its cap, so text beyond it is never handed to the hook.
    // The engine keeps every turn inside it; this is the defence, and the mail is unknown, never handed off.
    if (Buffer.byteLength(claimed.text) > PROMPT_HOOK_BUDGET.maxTextBytes) {
      return failure(
        'HOOK_OUTPUT_TOO_LARGE',
        'The delivery exceeds what one turn can carry',
        {
          attemptId: claimed.attemptId,
        }
      );
    }
    // Claimed: the mail is handoff-unknown whatever happens next. If the proof no longer holds, the text
    // is not handed to a hook that may speak for a different conversation, and the mail stays unknown.
    if (!(await stillHolds(request, tuple))) {
      return failure(
        'HOOK_BINDING_CHANGED',
        'The conversation changed during delivery',
        {
          attemptId: claimed.attemptId,
        }
      );
    }
    return { attemptId: claimed.attemptId, ok: true, text: claimed.text };
  }

  // The hook's statement that it wrote the text of one attempt. Accepted only from the same proven
  // conversation, and only the engine, which checks the attempt's owner, can turn it into handed-off.
  async function report(request, attemptId) {
    if (!(typeof attemptId === 'string' && attemptPattern.test(attemptId))) {
      return failure('HOOK_REPORT_INVALID', 'The delivery report is invalid');
    }
    const proven = await authenticate(request);
    if (!proven.ok) {
      return proven;
    }
    const confirmed = await links.confirmExact({
      attemptId,
      recipient: recipient(proven.tuple),
    });
    return confirmed.ok
      ? { confirmed: confirmed.confirmed, ok: true }
      : failure(confirmed.code, confirmed.error);
  }

  return Object.freeze({ deliver, report });
}
