export type LinksTarget = {
  name: string;
  repo: string;
  sessionId: string;
};

export type SendDraft = LinksTarget & {
  body: string;
  idempotencyKey: string;
  replyTo?: string;
};

export type RedeliveryReview = {
  attemptId: string;
  messageId: string;
  recipient: { nativeId: string; provider: string; sessionId: string };
  token: string;
};

export type ShareReview = {
  fields: { field: string; keys: string[]; meaning: string }[];
  never: string[];
  owner: string;
  permissions: Record<string, boolean>;
  project: string;
  token: string;
};

export type AttentionReview = {
  effect: string;
  never: string[];
  project: string;
  token: string;
};

export type DraftStore = {
  get: (target: LinksTarget) => SendDraft | undefined;
  remove: (draft: SendDraft) => void;
  set: (draft: SendDraft) => void;
};

export type SendBegin =
  | { ok: true }
  | {
      ok: false;
      pending?: SendDraft;
      reason: "in-flight" | "storage-failed" | "unresolved";
    };

export type DeliverySession = LinksTarget & {
  nativeConversation?: { provider?: string; state?: string } | null;
  ownership?: string;
  state?: string;
  tool?: string;
};

export function newSendDraft(
  target: LinksTarget,
  idempotencyKey: string,
): SendDraft {
  return { ...target, body: "", idempotencyKey };
}

export function createSendController(store: DraftStore) {
  const submitting = new Set<string>();
  const targetKey = (target: LinksTarget) =>
    `${target.repo}\u0000${target.name}\u0000${target.sessionId}`;

  return {
    begin(draft: SendDraft) {
      const key = targetKey(draft);
      if (submitting.has(key)) return { ok: false, reason: "in-flight" } as SendBegin;
      try {
        const pending = store.get(draft);
        if (pending && !sameSendIntent(pending, draft))
          return { ok: false, pending, reason: "unresolved" } as SendBegin;
        // Keep the exact intent before the effect, so navigation or a lost
        // response cannot replace the key needed for an explicit retry.
        if (!pending) store.set(draft);
        submitting.add(key);
        return { ok: true } as SendBegin;
      } catch {
        return { ok: false, reason: "storage-failed" } as SendBegin;
      }
    },
    change(draft: SendDraft, change: Pick<SendDraft, "body" | "replyTo">, nextKey: string) {
      return changeSendDraft(draft, change, nextKey);
    },
    finish(draft: SendDraft, outcome: { code?: string; ok: boolean }) {
      try {
        if (outcome.code !== "LINKS_OUTCOME_UNKNOWN") store.remove(draft);
        return true;
      } catch {
        return false;
      } finally {
        submitting.delete(targetKey(draft));
      }
    },
    recovered(target: LinksTarget) {
      try {
        return store.get(target);
      } catch {
        return undefined;
      }
    },
  };
}

export async function refreshAfterSuccess<T extends { ok: boolean }>(
  action: () => Promise<T>,
  refresh: () => Promise<unknown>,
): Promise<T> {
  const result = await action();
  if (result.ok) await refresh();
  return result;
}

// A changed draft is a new intent, even if it later resembles an earlier draft.
// This preserves the original key only for an exact retry after an unknown result.
export function changeSendDraft(
  draft: SendDraft,
  change: Pick<SendDraft, "body" | "replyTo">,
  nextKey: string,
): SendDraft {
  const next = { ...draft, ...change };
  return sameSendIntent(draft, next) ? draft : { ...next, idempotencyKey: nextKey };
}

export function sameSendIntent(a: SendDraft, b: SendDraft): boolean {
  return (
    a.repo === b.repo &&
    a.name === b.name &&
    a.sessionId === b.sessionId &&
    a.body === b.body &&
    (a.replyTo ?? "") === (b.replyTo ?? "") &&
    a.idempotencyKey === b.idempotencyKey
  );
}

// The local record is only a selector. The service repeats this check against
// current managed-session and checkout evidence before accepting a send.
export function deliveryEligibility(session: DeliverySession): {
  available: boolean;
  reason: string;
} {
  if (session.tool !== "claude-code")
    return { available: false, reason: "Provider delivery is unverified" };
  if (session.state !== "running" || session.ownership !== "owned")
    return { available: false, reason: "Session is not currently owned and running" };
  if (session.nativeConversation?.state !== "bound")
    return { available: false, reason: "No verified native conversation" };
  return { available: true, reason: "Setu will verify this binding when sending" };
}

export function directoryReachability(entry: {
  stale: boolean;
  reachability: { reason?: string | null; state: string };
}): string {
  if (entry.stale) return "Unknown (stale)";
  if (entry.reachability.state !== "reachable")
    return entry.reachability.reason
      ? `Unavailable: ${entry.reachability.reason}`
      : "Unavailable";
  return "Reachable";
}

export function validRedeliveryReview(
  review: Partial<RedeliveryReview> | undefined,
  target: LinksTarget,
  messageId: string,
  attemptId: string,
): review is RedeliveryReview {
  return Boolean(
    review &&
      validText(review.token) &&
      review.messageId === messageId &&
      review.attemptId === attemptId &&
      review.recipient?.sessionId === target.sessionId &&
      validText(review.recipient.nativeId) &&
      validText(review.recipient.provider),
  );
}

export function validShareReview(
  review: Partial<ShareReview> | undefined,
  project: string,
): review is ShareReview {
  return Boolean(
    review &&
      validText(review.token) &&
      review.project === project &&
      validText(review.owner) &&
      Array.isArray(review.fields) &&
      review.fields.length > 0 &&
      review.fields.every(
        (field) =>
          validText(field?.field) &&
          validText(field?.meaning) &&
          Array.isArray(field?.keys) &&
          field.keys.length > 0 &&
          field.keys.every(validText),
      ) &&
      validStrings(review.never) &&
      isPermissions(review.permissions),
  );
}

export function validAttentionReview(
  review: Partial<AttentionReview> | undefined,
  project: string,
): review is AttentionReview {
  return Boolean(
    review &&
      validText(review.token) &&
      review.project === project &&
      validText(review.effect) &&
      validStrings(review.never),
  );
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(validText);
}

function isPermissions(value: unknown): value is Record<string, boolean> {
  if (!(value && typeof value === "object") || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.join(",") === "attention,interrupt,receive,visibility" &&
    keys.every((key) => typeof (value as Record<string, unknown>)[key] === "boolean")
  );
}

// Routine failure UI never reflects an arbitrary server string, which could
// include an echoed message body or key. The portal remains the recovery view.
export function safeFailureMessage(result: {
  code?: unknown;
}): string {
  const code = typeof result.code === "string" ? result.code : "LINKS_FAILED";
  const recovery: Record<string, string> = {
    LINKS_CHECKOUT_CHANGED: "The selected checkout changed. Return to Links and choose the current session.",
    LINKS_ENGINE_UNAVAILABLE: "The local Links service is unavailable. Refresh before taking another action.",
    LINKS_MESSAGE_NOT_FOUND: "The message is no longer available. Refresh the inbox.",
    LINKS_NOT_SHARED: "Share this project before enabling attention.",
    LINKS_OUTCOME_UNKNOWN: "Refresh the inbox or message status before deciding whether to retry.",
    LINKS_POLICY_INVALID: "Sharing policy is unreadable. Disable and re-enable sharing only after reviewing the current status.",
    LINKS_RECIPIENT_MISMATCH: "This message belongs to another conversation. Refresh and select its current session.",
    LINKS_SESSION_ENDED: "The selected session has ended. Choose a running managed session.",
    LINKS_SESSION_NOT_FOUND: "The selected managed session no longer exists. Return to Links and choose it again.",
    LINKS_SESSION_NOT_RUNNING: "The selected session is not verifiably running. Refresh before sending.",
  };
  return `${code}: ${recovery[code] ?? "Refresh the current Links state before taking another action."}`;
}
