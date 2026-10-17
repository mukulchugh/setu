# 06 — Attention requests notify the person; only the receiving user can Send now

**GitHub:** [#13](https://github.com/mukulchugh/setu/issues/13) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Decision:** [ADR 0002](../../adr/0002-recipient-authorizes-agent-wake.md) · **Increment:** 2 · **Release scope:** first public release (wake part may ship as "unavailable") · **Status:** published, ready-for-agent

## What to build

Two receiving-user controls, one ticket because both live on the recipient's inbox.

**Attention requests.** A peer or session can send an attention request. It appears as an attention item in Setu's existing attention list, marked as coming from Links with the sender and message, through a separate authenticated incoming path. It is never presented as a provider hook, never wakes the agent, and never grants permission to run work. Opening it focuses the exact verified target session using the existing focus path, or says plainly that focus is unavailable. Repeated requests from the same sender are grouped for notification, while every individual item stays recorded. Routine messages and FYIs never notify.

**Send now.** The receiving user may choose Send now on a queued message to start a turn in their idle agent, where supported. No peer, tool call or message can authorize it: the engine rejects a wake request whose principal is not the local receiving user, and the agent-facing tools expose no wake. Start with a capability probe: does the existing exact-target terminal delivery cause a normal turn in an idle managed Claude session, with the message arriving via the same prompt path as ticket 03, not as pasted terminal text? Record the result.
- If the probe passes: implement Send now for that provider and terminal combination only, with the target verified exactly at the effect boundary and a confirmation that names the usage it may consume.
- If it does not pass: Send now is shown as unavailable with the reason, the command refuses with a stable code, and no wake path is enabled. This outcome completes the ticket.

## Acceptance criteria

- [ ] An attention request from a shared-project peer produces one attention item with sender and message, does not change the recipient's session, and does not start a turn.
- [ ] Five rapid requests produce grouped notification behavior and five retained items.
- [ ] Opening an item focuses the exact verified session; with an ended or replaced target it reports that clearly and focuses nothing else.
- [ ] Routine messages and FYIs create no notification.
- [ ] A forged provider hook payload (native ID and cwd without the per-launch capability) cannot create a Links attention item, and a Links item cannot satisfy a provider permission request.
- [ ] A wake request from any non-local principal, from a session tool, or embedded in message text is rejected by the engine.
- [ ] The capability probe's result (date, provider and version, terminal, session type, observation, limits) is recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md), clearing or leaving open U7 and U8.
- [ ] Probe passed: Send now on an idle managed Claude session starts a turn that shows the message exactly once; the status moves as in ticket 03; a changed target aborts it.
- [ ] Probe failed or inconclusive: Send now is unavailable, the CLI and any UI say why, and a test proves no code path wakes a session.
- [ ] Wake does not release or take a writer claim and does not bypass admission.
- [ ] `bun run verify` passes.

## Blocked by

- [#10](https://github.com/mukulchugh/setu/issues/10) (03) — A queued message reaches the exact managed Claude conversation at its next normal turn
- [#12](https://github.com/mukulchugh/setu/issues/12) (05) — Two real sessions exchange a request, a reply and an FYI

## Gates

External: whether any supported mechanism can start a turn in an idle session exactly (U7, U8). Terminal text injection through cmux is not validated as a production transport and must not be assumed. Codex is unverified.
