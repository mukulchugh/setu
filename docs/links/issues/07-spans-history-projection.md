# 07 — A run-linked exchange appears once in Spans history

**GitHub:** [#14](https://github.com/mukulchugh/setu/issues/14) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 3 · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

A message sent with a run (and optionally span) hint, once the local user approves the association, appears exactly once in that run's Conversation in the Spans portal, with its delivery status. Held and uncertain deliveries appear in Recovery. A selected reply can be attached as Evidence. Messages with no approved association stay in the Links inbox.

- **Association.** A peer's run reference is a hint. Association to a local run is a separate, explicit local approval (`setu links associate`), validated against the run and its current plan generation. Remote run references are namespaced by peer identity so identical IDs from different peers cannot collide.
- **Projection.** An explicit, opt-in projection worker reads the engine's durable event cursor and writes redacted, bounded events into the Spans archive with deterministic IDs. Each batch commits events and advances the cursor in one archive transaction. A crash and replay produces no duplicate. A missing projection shows as pending, not lost.
- **Rendering.** Conversation renders message events explicitly, with status, sender and reply-to. Recovery lists held, handoff-unknown and unassociated items. Evidence can reference a selected reply with source and digest.
- **Search.** Extraction learns the new bounded event shapes. Indexing is an explicit command or background worker; a read never builds an index, and coverage is shown until it runs.
- **Safety.** Unsafe content is stored inert and redacted. Archive reads stay passive. Spans planning works with Links disabled and with the projection off.

The engine remains the only owner of delivery state; the archive stores a derived, redacted record only.

## Acceptance criteria

- [ ] Send with a run hint, approve the association, run the projection: the Conversation panel shows the message once with its current status. Updating the status in the engine and re-projecting updates the displayed status without a duplicate message row; status changes remain separate immutable archive events.
- [ ] Kill the worker at each point around the archive commit and restart: no duplicate event, no skipped message, cursor and events consistent.
- [ ] A message whose run reference is unapproved, unknown, from another peer with a colliding ID, or for a stale plan generation is not attached and is shown as unassociated or rejected with a reason.
- [ ] A peer cannot change a run's generation, accepted completion or any span state through a message.
- [ ] Held and `handoff-unknown` items appear in Recovery with a way to open the message; resolving them does not itself mutate Spans completion.
- [ ] Attaching a selected reply as Evidence records source, target revision and digest and does not accept the span.
- [ ] Message content containing markup, control characters or secrets is stored inert and redacted in events and search text; bounds are enforced.
- [ ] Search finds a projected message after the explicit index step and shows reduced coverage before it; no GET starts indexing.
- [ ] With Links disabled or the engine absent, existing Spans listing, planning and history work unchanged and existing Spans tests pass.
- [ ] Portal checks: loading, empty, error and stale states for the new panels; `bun run verify` passes.

## Blocked by

- [#10](https://github.com/mukulchugh/setu/issues/10) (03) — A queued message reaches the exact managed Claude conversation at its next normal turn

## Gates

None external. If the archive needs a cursor or transactional projection API not present at baseline, add the smallest addition to the model store inside this ticket.
