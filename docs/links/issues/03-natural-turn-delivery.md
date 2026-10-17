# 03 — A queued message reaches the exact managed Claude conversation at its next normal turn

**GitHub:** [#10](https://github.com/mukulchugh/setu/issues/10) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 2 · **Release scope:** first public release · **Status:** published, ready-for-agent · **First useful end-to-end slice**

## What to build

A user runs `setu links send` to one managed Claude session. At that session's next normal user turn, the message appears in the agent's context in a bounded structured frame. The user sees the status move `queued` → `handed-off`, or `handoff-unknown` when the outcome is uncertain. Nothing starts a turn, and nothing is injected into a turn already running.

Build on ticket 01 (authenticated native identity) and ticket 02 (engine claim/confirm):
- Register one more hook event for prompt submission in the managed Claude launch, alongside the existing events. The generated hook posts to the portal with the retained per-launch capability, reads the response, writes the provider's context output (use the output form observed in the live test and verify it against the documented contract for the tested Claude version), then makes a second call reporting that it wrote it. The hook must never block the user's turn and must finish within a short timeout.
- **Authentication:** the portal resolves the request only with the capability from ticket 01, verifying provider, managed session, checkout incarnation and lifecycle. Native ID and cwd are only a locator. Then it calls the engine to claim only messages whose immutable recipient identity matches that exact native conversation. A replaced conversation or a different managed session gets nothing.
- **Failure semantics.** Before claim (portal down, authentication failure, engine unavailable, timeout) messages stay `queued`. At or after claim, any uncertain result is `handoff-unknown`: a response lost on the way to the hook, a hook that crashed, **output written followed by a failed or missing report**, or a portal or engine killed mid-sequence. `handoff-unknown` is never returned to `queued` and never resent automatically; only the receiving user's explicit redeliver creates a new attempt. Do not claim that a failed hook wrote nothing.
- **Framing.** Each message is encoded in a bounded structured frame: sender, message ID and time are separate metadata fields, the body is encoded with frame delimiters escaped, and count and total size per turn are limited. This is attribution and frame integrity. It is **not prompt-injection immunity**, and no test or doc may claim it.
- Codex and any provider without verified delivery: sends are rejected at ticket 02's boundary with a provider-unverified code. This says unverified, not unsupported.

## Acceptance criteria

- [ ] Send to a live managed Claude session, then submit a normal turn in it: the message text appears in the agent's response context exactly once and the status is `handed-off`. (Real launcher, real portal, real engine, real provider.)
- [ ] Busy deposit: send while the session is mid-output; the running turn does not see it; the next normal turn does. Record the result.
- [ ] A second session in the same repo and branch does not receive it. A replacement conversation (new native ID) in the same managed session does not receive it and the message is `held: conversation replaced`.
- [ ] Exit and exact-resume the same native conversation: pending `queued` mail is emitted once; mail already `handed-off` or `handoff-unknown` is not re-emitted.
- [ ] **Failure matrix, each case asserted:**
  - failure before claim (portal down, bad credential, engine unavailable) → `queued`, nothing emitted, turn proceeds;
  - killed at claim → `handoff-unknown`;
  - response lost after claim → `handoff-unknown`;
  - hook killed after claim and before output → `handoff-unknown`;
  - **output written, then report fails or never arrives → `handoff-unknown`, not `queued`, and the next turn does not re-emit it**;
  - report received → `handed-off`.
  In every `handoff-unknown` case `setu links redeliver` explicitly creates one new attempt.
- [ ] A hook request with a missing, wrong, cross-session, ended or replaced capability returns no mail, including after a portal restart.
- [ ] Framing tests (deterministic, no model involved): a body containing the frame delimiters, control characters, fake sender headers, or oversized text is escaped, bounded or rejected; sender metadata remains in its own fields and cannot be altered by the body; the encoding round-trips. These tests demonstrate frame integrity only.
- [ ] No global or user-level hook is installed or modified (user settings byte-identical before and after).
- [ ] Results (date, Claude version, session type managed, scenario, observation, limits) are recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md), clearing or narrowing U1, U3, U4, U5 and U6 only to what was observed. U5's mid-tool-call and permission-prompt cases and U10 stay open unless actually run.
- [ ] Recorded provider payload tests exist for speed but are labeled contract tests, not provider acceptance.
- [ ] `bun run verify`, Rust tests and the naming scan pass.

## Blocked by

- [#8](https://github.com/mukulchugh/setu/issues/8) (01) — Managed Claude sessions carry a durable, authenticated native conversation identity
- [#9](https://github.com/mukulchugh/setu/issues/9) (02) — Setu-owned engine: durable local inbox with honest statuses

## Gates

External: U1 (prompt hook in a Setu-managed session) is cleared only by this ticket's live run. If the generated hook cannot emit in a managed session, stop and report with the observed cause; do not fall back to terminal text injection.
