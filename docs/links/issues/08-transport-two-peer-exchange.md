# 08 — Two engines exchange a message with durable retry and recipient-scoped acknowledgement

**GitHub:** [#15](https://github.com/mukulchugh/setu/issues/15) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 1 (transport part) · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

Add peer transport to the existing Setu-owned engine, behind the same operation protocol and the same store as ticket 02. Two engine instances with separate data directories on one machine, standing in for two machines, connect over an authenticated Setu-versioned handshake. A message sent to a remote recipient is stored in the sender's outbox, moved by the transport, deposited idempotently in the recipient's engine, and the recipient's acknowledgement is scoped to that recipient and flows back as a receipt.

**Source.** Reuse of the selected reviewed transport source (transport, outbox, roster, reconnect) is already authorized and needs no decision record or further approval. Derive it the same way as ticket 02: pinned revision and checksum recorded, only needed parts, all first-party surfaces renamed to Setu-native names, inherited login, installer, self-update and unused surfaces removed, naming scan extended with a narrow exception only for the separate legal metadata. Licenses and provenance stay in that legal metadata. **No second mailbox store:** the transport owns no message state; its retry queue is derivable from the engine's outbox, and local delivery ownership (claim, handoff, acknowledgement) stays with the recipient-side engine.

Include protocol capability negotiation: incompatible peers are rejected explicitly. Handle schema changes with an explicit migration before any build is published. Long-running mode needs a lifecycle owner: one process per user, single-instance guard, passive health reads, nothing started by a status read; service packaging is ticket 11.

## Acceptance criteria

- [ ] Two engine processes with separate data directories exchange a message in each direction; the sender's status reaches the remote engine's receipt state; the recipient acknowledgement reaches the sender.
- [ ] Killing either engine at each protocol step and restarting converges to one message in the recipient's inbox and consistent status at both ends.
- [ ] A lost response retried creates one logical message. The same key with a different payload is a conflict. A wrong-recipient acknowledgement is rejected.
- [ ] A peer speaking an incompatible protocol version is rejected with an explicit reason and no state change.
- [ ] A recipient identity naming a replaced conversation yields `held` on the remote side too, never delivery. A send naming an unbound conversation is rejected at the sender and, if forged, at the receiver.
- [ ] Per-peer limits and expiry apply on the receiving side regardless of what the sender claims.
- [ ] Starting twice yields one long-running process; status reads start nothing.
- [ ] The pinned revision and checksum are recorded; a repository scan finds no non-Setu product names outside the legal metadata; a test shows only one mailbox store exists.
- [ ] Rust tests and `bun run verify` pass.

## Blocked by

- [#9](https://github.com/mukulchugh/setu/issues/9) (02) — Setu-owned engine: durable local inbox with honest statuses

## Gates

External: reproducible Rust build (U13). Same-machine peers do not prove real network behavior (U9, U12); ticket 09 does. No legal or approval gate.
