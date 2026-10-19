import { afterEach, expect, mock, test } from "bun:test";
import { createLinksService } from "./links-service.js";
import {
  changeSendDraft,
  createSendController,
  deliveryEligibility,
  directoryReachability,
  newSendDraft,
  refreshAfterSuccess,
  safeFailureMessage,
  sameSendIntent,
  validAttentionReview,
  validRedeliveryReview,
  validShareReview,
} from "./raycast/src/lib/links-controller";

mock.module("@raycast/api", () => ({
  getPreferenceValues: () => ({ portalUrl: "http://setu.test" }),
}));

const { linksCapabilities, linksInbox, linksMessage, linksSend, portalLinksUrl } = await import("./raycast/src/lib/api");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const selected = {
  checkoutIdentity: { checkout: { birthtimeNs: "1", dev: "2", ino: "3" }, known: true },
  id: "session-1",
  name: "topic",
  nativeConversation: { boundAt: 1, id: "native-a", provider: "claude-code", state: "bound" },
  ownership: "owned",
  repo: "repo",
  state: "running",
  tool: "claude-code",
};
const target = { name: "topic", repo: "repo", sessionId: "session-1" };

function serviceWith(outcomes: { code?: string; error?: string; ok: boolean; result?: Record<string, unknown> }[]) {
  const calls: { args: unknown; op: string }[] = [];
  const service = createLinksService({
    client: {
      call: async (op: string, args: unknown) => {
        calls.push({ args, op });
        return outcomes.shift() ?? { ok: false, code: "LINKS_ENGINE_UNAVAILABLE", error: "engine unavailable" };
      },
    },
    resolveTarget: async ({ name, repo }: { name: string; repo: string }) =>
      name === "topic" && repo === "repo"
        ? { checkoutIdentity: selected.checkoutIdentity, name, repo }
        : null,
    sessions: { list: async () => ({ ok: true, sessions: [selected] }) },
  });
  return { calls, service };
}

test("the controller saves the exact intent before the real service reaches its injected engine", async () => {
  const stored = new Map<string, ReturnType<typeof newSendDraft>>();
  const controller = createSendController({
    get: (recipient) => stored.get(recipient.sessionId),
    remove: (draft) => {
      if (sameSendIntent(stored.get(draft.sessionId) ?? draft, draft)) stored.delete(draft.sessionId);
    },
    set: (draft) => stored.set(draft.sessionId, draft),
  });
  const original = { ...newSendDraft(target, "exact-key"), body: "private message" };
  const calls: { args: unknown; op: string }[] = [];
  const service = createLinksService({
    client: { call: async (op: string, args: unknown) => {
      calls.push({ args, op });
      expect(createSendController({ get: (recipient) => stored.get(recipient.sessionId), remove: () => {}, set: () => {} }).recovered(target)).toEqual(original);
      return { code: "LINKS_OUTCOME_UNKNOWN", error: "unknown", ok: false };
    } },
    resolveTarget: async ({ name, repo }: { name: string; repo: string }) =>
      name === "topic" && repo === "repo" ? { checkoutIdentity: selected.checkoutIdentity, name, repo } : null,
    sessions: { list: async () => ({ ok: true, sessions: [selected] }) },
  });

  expect(controller.begin(original)).toEqual({ ok: true });
  const beforeResponse = createSendController({
    get: (recipient) => stored.get(recipient.sessionId),
    remove: () => {},
    set: () => {},
  });
  expect(beforeResponse.recovered(target)).toEqual(original);
  controller.finish(original, await service.send(original));
  expect(controller.recovered(target)).toEqual(original);

  const changed = controller.change(original, { body: "new intent" }, "new-key");
  expect(changed.idempotencyKey).toBe("new-key");
  expect(controller.recovered(target)).toEqual(original);
  expect(controller.begin(changed)).toEqual({ ok: false, pending: original, reason: "unresolved" });
  expect(calls).toHaveLength(1);
  expect(controller.begin(original)).toEqual({ ok: true });
  controller.finish(original, { ok: false });
  expect(controller.recovered(target)).toBeUndefined();
  expect(calls[0]).toMatchObject({
    args: expect.objectContaining({ body: "private message", idempotency_key: "exact-key", project: "repo", sender: { kind: "user" } }),
    op: "send",
  });
});

test("the original same-key retry is the only allowed follow-up effect after an unknown send", async () => {
  const stored = new Map<string, ReturnType<typeof newSendDraft>>();
  const store = {
    get: (recipient: typeof target) => stored.get(recipient.sessionId),
    remove: (draft: ReturnType<typeof newSendDraft>) => {
      if (sameSendIntent(stored.get(draft.sessionId) ?? draft, draft)) stored.delete(draft.sessionId);
    },
    set: (draft: ReturnType<typeof newSendDraft>) => stored.set(draft.sessionId, draft),
  };
  const controller = createSendController(store);
  const original = { ...newSendDraft(target, "exact-key"), body: "private message" };
  const changed = controller.change(original, { body: "new intent" }, "new-key");
  const { calls, service } = serviceWith([
    { code: "LINKS_OUTCOME_UNKNOWN", error: "unknown", ok: false },
    { ok: true, result: { message_id: "m1", replayed: false, state: "queued" } },
  ]);

  expect(controller.begin(original)).toEqual({ ok: true });
  controller.finish(original, await service.send(original));
  expect(controller.begin(changed)).toEqual({ ok: false, pending: original, reason: "unresolved" });
  expect(controller.begin(original)).toEqual({ ok: true });
  controller.finish(original, await service.send(original));
  expect(calls.filter((call) => call.op === "send")).toHaveLength(2);
  expect(controller.recovered(target)).toBeUndefined();
});

test("a definitive refusal clears only its matching pending intent, and storage failures never send", async () => {
  const stored = new Map<string, ReturnType<typeof newSendDraft>>();
  const store = {
    get: (recipient: typeof target) => stored.get(recipient.sessionId),
    remove: (draft: ReturnType<typeof newSendDraft>) => {
      if (sameSendIntent(stored.get(draft.sessionId) ?? draft, draft)) stored.delete(draft.sessionId);
    },
    set: (draft: ReturnType<typeof newSendDraft>) => stored.set(draft.sessionId, draft),
  };
  const controller = createSendController(store);
  const original = { ...newSendDraft(target, "exact-key"), body: "private message" };
  const changed = controller.change(original, { body: "changed" }, "changed-key");
  expect(controller.begin(original)).toEqual({ ok: true });
  controller.finish(changed, { code: "LINKS_SESSION_NOT_FOUND", ok: false });
  expect(controller.recovered(target)).toEqual(original);
  controller.finish(original, { code: "LINKS_SESSION_NOT_FOUND", ok: false });
  expect(controller.recovered(target)).toBeUndefined();

  let engineCalls = 0;
  const service = createLinksService({
    client: { call: async () => { engineCalls += 1; return { ok: true, result: { message_id: "m1", replayed: false, state: "queued" } }; } },
    resolveTarget: async ({ name, repo }: { name: string; repo: string }) =>
      name === "topic" && repo === "repo" ? { checkoutIdentity: selected.checkoutIdentity, name, repo } : null,
    sessions: { list: async () => ({ ok: true, sessions: [selected] }) },
  });
  const broken = createSendController({ get: () => undefined, remove: () => {}, set: () => { throw new Error("cache unavailable"); } });
  if (broken.begin(original).ok) await service.send(original);
  expect(engineCalls).toBe(0);
  expect(broken.recovered(target)).toBeUndefined();
});

test("an unexpected injected-engine call error releases the in-flight gate and retains its possible outcome", async () => {
  const stored = new Map<string, ReturnType<typeof newSendDraft>>();
  const controller = createSendController({
    get: (recipient) => stored.get(recipient.sessionId),
    remove: (draft) => stored.delete(draft.sessionId),
    set: (draft) => stored.set(draft.sessionId, draft),
  });
  const original = { ...newSendDraft(target, "exact-key"), body: "private message" };
  const service = createLinksService({
    client: { call: async () => { throw new Error("connection reset after request"); } },
    resolveTarget: async ({ name, repo }: { name: string; repo: string }) =>
      name === "topic" && repo === "repo" ? { checkoutIdentity: selected.checkoutIdentity, name, repo } : null,
    sessions: { list: async () => ({ ok: true, sessions: [selected] }) },
  });
  expect(controller.begin(original)).toEqual({ ok: true });
  await expect(service.send(original)).rejects.toThrow("connection reset after request");
  controller.finish(original, { code: "LINKS_OUTCOME_UNKNOWN", ok: false });
  expect(controller.recovered(target)).toEqual(original);
  expect(controller.begin(original)).toEqual({ ok: true });
  controller.finish(original, { code: "LINKS_OUTCOME_UNKNOWN", ok: false });
});

test("editing a draft or changing its target creates a new intent instead of a same-key retry", () => {
  const original = { ...newSendDraft(target, "key-1"), body: "first" };
  const changed = changeSendDraft(original, { body: "second" }, "key-2");
  expect(changed.idempotencyKey).toBe("key-2");
  expect(sameSendIntent(original, changed)).toBe(false);
  expect(sameSendIntent(original, { ...original, sessionId: "session-2" })).toBe(false);
  expect(changeSendDraft(original, { body: "first" }, "unused")).toBe(original);
});

test("malformed nested reviews never enable redelivery, sharing, or attention confirmation", () => {
  expect(validRedeliveryReview({ attemptId: "a1", messageId: "m1", recipient: { nativeId: "native", provider: "claude-code", sessionId: "other" }, token: "t" }, target, "m1", "a1")).toBe(false);
  const complete = { fields: [{ field: "owner", keys: ["owner"], meaning: "shown" }], never: ["paths"], owner: "Mukul", permissions: { attention: false, interrupt: false, receive: true, visibility: true }, project: "repo", token: "t" };
  expect(validShareReview(complete, "repo")).toBe(true);
  expect(validShareReview({ ...complete, project: "changed" }, "repo")).toBe(false);
  for (const review of [
    { fields: [null], never: ["paths"], owner: "Mukul", permissions: { attention: false, interrupt: false, receive: true, visibility: true }, project: "repo", token: "t" },
    { fields: [{ field: "owner", keys: ["owner"], meaning: "shown" }], never: [null], owner: "Mukul", permissions: { attention: false, interrupt: false, receive: true, visibility: true }, project: "repo", token: "t" },
    { fields: [{ field: "owner", keys: ["owner"], meaning: "shown" }], never: ["paths"], owner: "Mukul", permissions: [], project: "repo", token: "t" },
    { fields: [{ field: "owner", keys: ["owner"], meaning: "shown" }], never: ["paths"], owner: "Mukul", permissions: { arbitrary: true }, project: "repo", token: "t" },
  ]) expect(validShareReview(review as never, "repo")).toBe(false);
  expect(validAttentionReview({ effect: "no wake", never: [null], project: "repo", token: "t" } as never, "repo")).toBe(false);
});

test("an active view refreshes after success, never after a refusal", async () => {
  let refreshed = 0;
  await refreshAfterSuccess(async () => ({ ok: true }), async () => { refreshed += 1; });
  await refreshAfterSuccess(async () => ({ ok: false }), async () => { refreshed += 1; });
  expect(refreshed).toBe(1);
});

test("Raycast validates malformed reads, sends the exact source header and payload, and links to /links", async () => {
  const requests: { body?: unknown; headers?: Headers; path: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers), path: new URL(String(url)).pathname });
    if (new URL(String(url)).pathname.endsWith("/inbox")) return Response.json({ messages: [null], ok: true });
    return Response.json({ messageId: "m1", ok: true, replayed: false, state: "queued" });
  }) as typeof fetch;
  await expect(linksInbox(target)).resolves.toMatchObject({ code: "LINKS_RESPONSE_INVALID", ok: false });
  await linksSend({ ...target, body: "private message", idempotencyKey: "exact-key" });
  expect(requests).toEqual([
    expect.objectContaining({ path: "/api/links/inbox" }),
    expect.objectContaining({ body: { body: "private message", idempotencyKey: "exact-key", name: "topic", repo: "repo", sessionId: "session-1" }, path: "/api/links/send" }),
  ]);
  expect(requests[1].headers?.get("x-setu-source")).toBe("raycast");
  expect(portalLinksUrl()).toBe("http://setu.test/links");
});

test("read failures remain unknown rather than empty, and a public run hint is a reference only", async () => {
  globalThis.fetch = (async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/capabilities")) return Response.json({ ok: true, wake: { available: false, code: "LINKS_WAKE_UNAVAILABLE" } });
    return Response.json({
      attemptId: null, attempts: 0, body: "message", createdAt: 1, expiresAt: 2, messageId: "m1",
      reason: null, recipient: { currentSessionId: "session-1", nativeId: "native", provider: "claude-code", sessionId: "session-1" },
      redeliveries: 0, replyTo: null, runHint: "run-reference", sender: { kind: "user" }, size: 7,
      state: "queued", storedState: "queued", updatedAt: 1, ok: true,
    });
  }) as typeof fetch;
  await expect(linksCapabilities()).resolves.toMatchObject({ wake: { available: false } });
  await expect(linksMessage("m1")).resolves.toMatchObject({ runHint: "run-reference" });
  expect(safeFailureMessage({ code: "LINKS_SESSION_NOT_FOUND", error: "private message" })).not.toContain("private message");
  expect(safeFailureMessage({ code: "LINKS_SESSION_NOT_FOUND" })).toContain("LINKS_SESSION_NOT_FOUND");
});

test("delivery UI never calls a Codex, unreachable, or stale target ready", () => {
  expect(deliveryEligibility({ ...target, tool: "codex", ownership: "owned", state: "running", nativeConversation: { state: "bound" } })).toEqual({ available: false, reason: "Provider delivery is unverified" });
  expect(deliveryEligibility({ ...target, tool: "claude-code", ownership: "unknown", state: "running", nativeConversation: { state: "bound" } }).available).toBe(false);
  expect(directoryReachability({ stale: true, reachability: { state: "reachable" } })).toBe("Unknown (stale)");
  expect(directoryReachability({ stale: false, reachability: { reason: "provider-unverified", state: "unreachable" } })).toContain("Unavailable");
});
