# 01 — Managed Claude sessions carry a durable, authenticated native conversation identity

**GitHub:** [#8](https://github.com/mukulchugh/setu/issues/8) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 2 (identity part) · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

When a user launches a Claude session through Setu, Setu records which provider-native conversation it is, authenticates every production hook against a retained per-launch secret capability, and keeps both across a portal restart. `setu sessions` and the sessions API show the binding. A replaced conversation in the same managed session is recorded as a replacement, never silently merged.

Today the native-conversation mapping exists only in portal memory, the launch token is discarded after the first start event, and later hook events are resolved by native ID plus working directory alone (see [seams.md](../seams.md)). A portal restart loses every binding, a second conversation in the same process cannot bind, and a native ID plus cwd is accepted without proof. This slice fixes all three, which also restores and secures existing attention hooks. It needs no engine.

Rules:
- **Native ID plus cwd is only a locator.** All production hook resolution, for attention and for Links, must present the retained per-launch capability. Authentication is part of this ticket, not later hardening.
- **Persist only a digest** of the capability, never the capability. The capability is not consumed at first bind; it stays valid for the life of the managed session.
- **Verify on every resolution:** provider, managed session, checkout incarnation (the existing checkout identity) and lifecycle (owned, running, not ended or replaced).
- **Persist the binding in the existing private managed-session record** (provider, native ID, bound-at, bounded replaced-ID history). Do not add a separate Links identity table or a second store.
- Keep records backward compatible: sessions without a binding still list and still work.
- Claude only. A Codex session shows its binding as not applicable; nothing here claims Codex support.

## Acceptance criteria

- [ ] After a managed Claude session starts, `setu sessions list --json` shows its native conversation (provider and ID) and when it was bound; a session that has not yet bound shows it as pending.
- [ ] **Restart the portal while the session is running:** the binding and capability digest are still present, a valid hook event still resolves, and an existing attention event for that session still resolves (it previously did not).
- [ ] **Missing credential:** a hook event with the correct native ID and cwd but no capability resolves nothing, after a portal restart as well as before.
- [ ] **Wrong credential:** a well-formed but incorrect capability resolves nothing, after restart as well as before.
- [ ] **Cross-session credential:** session A's capability presented with session B's native ID and cwd (and the reverse) resolves nothing, after restart.
- [ ] **Ended credential:** after the managed session ends, its capability resolves nothing, after restart.
- [ ] **Replaced credential:** after a replacement conversation or a relaunch that supersedes the session, the old capability and the old native ID resolve nothing, after restart; the new ones resolve.
- [ ] Changed checkout incarnation, wrong provider, an unmanaged session, or a non-running session resolves nothing; each returns a distinct non-secret reason.
- [ ] A second start event with a different native ID, authenticated by the capability, is recorded as a replacement: the new ID becomes current, the previous ID is kept in a bounded history, and the session shows the change.
- [ ] An exact resume of the previous native ID in the same managed session with the same checkout incarnation, authenticated by the capability, is recognized as that conversation again.
- [ ] Only a digest is persisted: a search of persisted binding state and diagnostic logs for a real capability finds nothing; the record is in the existing private (owner-only) managed-session store.
- [ ] A malformed or older session record loads without data loss, and a corrupt binding fails closed to "pending" with a recoverable error rather than crashing the session list.
- [ ] Existing session, attention and handoff tests still pass (updated where they relied on cwd-only resolution); new tests are in the package test script.
- [ ] Live check: launch one managed Claude session through the real launcher and record whether the start hook fired and bound, in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md) (start-hook half of U1/U2, tested version only). If it does not bind, record the cause; do not mark the slice done.
- [ ] No global or user-level provider hook is installed or modified.

## Blocked by

None — can start immediately.

## Gates

External: none for code. U1/U2 (managed-session hook behavior) are cleared only by the live check above.

## Agreed interface details

The local public session response exposes nativeConversation with bound state, provider, id and boundAt, or pending state and provider. Unverified providers expose unavailable state and the provider-unverified reason. Keep capability digests and bounded private history out of public responses. A history bound of eight is sufficient. Reject duplicate binding of one native conversation to two concurrently live owned session records; an exact resume after the previous incarnation ends requires explicit authenticated rebinding. Use checkout filesystem incarnation, never HEAD, as the checkout proof. This slice does not add a new managed-resume launcher: if no explicit authenticated cross-record resume operation exists, refuse a native ID previously bound to an ended or unknown record rather than implicitly adopting it. Same-record authenticated resume remains required. The later native-delivery slice must provide and verify an explicit resume path for its cross-process acceptance scenario.
