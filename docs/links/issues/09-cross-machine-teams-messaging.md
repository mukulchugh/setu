# 09 — Teammates on separate machines exchange messages

**GitHub:** [#16](https://github.com/mukulchugh/setu/issues/16) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 5 (messaging part) · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

A team owner creates a team and invites a teammate with a Setu-native invitation token. The teammate joins from another machine, sees the exact fields they will share, and their enabled shared projects appear in each other's directory. Agents or users on either machine can message the other's managed sessions. Messages queue while a peer is asleep or offline, converge after restart, and stop on revocation.

Commands (names indicative): team create, invite, join, revoke, rotate, remove, leave, `connection` diagnostics. Membership of the user's own other machines uses the same mechanism. Onboarding reports four separate states: membership saved, peer connected, adapter ready, message delivery verified. Direct connectivity first; relay connectivity only if one is available (see gates).

Remote recipients are still exact native conversations (ticket 03 rules): a replacement conversation does not inherit mail, on any machine. The sender's engine owns the outbox and the recipient's engine owns the inbox (ticket 08). Sharing policy is enforced by the receiving engine. Local sessions keep working with the network down; Links never blocks local work. Invitation secrets and message bodies stay out of generic logs.

## Acceptance criteria

- [ ] On two real devices on different networks (or the closest available real pair, recorded precisely), create team, invite, join, enable a shared project on each side, and exchange messages both ways to managed sessions with correct sender identity.
- [ ] Sleep the recipient, send, wake it: the message is delivered at the recipient's next turn once, with correct status on both ends.
- [ ] Restart each engine mid-exchange: no duplicate, no loss.
- [ ] Revoke the invitation or remove the member: sending stops, the peer shows revoked, queued mail to that peer is held or cancelled with a reason, and previously received mail stays.
- [ ] A rotated invitation invalidates the old token; an expired or reused token is refused.
- [ ] A replaced conversation on the remote machine does not receive old mail.
- [ ] With the network cut, local sends, inbox and delivery work unchanged; Links errors are recoverable and visible.
- [ ] Onboarding output keeps the four states distinct and never reports "verified" before a real delivery check.
- [ ] Incompatible peer versions are rejected explicitly.
- [ ] Shared-field preview appears before join; nothing else is shared; transcripts are not forwarded.
- [ ] Results (devices, networks, versions, limits) are recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md) for U9 and U12; anything not exercised stays open.
- [ ] `bun run verify` and Rust tests pass.

## Blocked by

- [#10](https://github.com/mukulchugh/setu/issues/10) (03) — A queued message reaches the exact managed Claude conversation at its next normal turn
- [#11](https://github.com/mukulchugh/setu/issues/11) (04) — Enable a shared project and discover its managed sessions
- [#15](https://github.com/mukulchugh/setu/issues/15) (08) — Two engines exchange a message with durable retry and recipient-scoped acknowledgement

## Gates

External, unresolved: how two machines find each other when direct connection is impossible (a relay) and who operates it. This specification does not add a hosted service. If no relay exists, release scope is direct connectivity only, documented as a limit. Real-device behavior (NAT, sleep, reconnect, revocation) is untested.
