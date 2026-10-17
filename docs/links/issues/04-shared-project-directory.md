# 04 — Enable a shared project and discover its managed sessions

**GitHub:** [#11](https://github.com/mukulchugh/setu/issues/11) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Decision:** [ADR 0001](../../adr/0001-project-opt-in-session-discovery.md) · **Increment:** 2 · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

A user enables collaboration for one project with `setu links share enable <repo>`. First they are shown the exact fields that will be shared (owner identity, task label, reachability, freshness) and nothing is changed until they confirm. After that, that project's managed sessions appear in `setu links directory`. Unrelated projects, observed-only sessions, and transcripts never appear. `share status` shows the current policy; `share disable` withdraws it and discovery stops.

The sharing policy is stored and enforced by the engine, the single authority. A malformed policy fails closed: delivery for that project is disabled with a recoverable error. Visibility, receiving messages, interrupting an agent and raising attention are separate permissions; this ticket delivers visibility and the receive permission, and records the other two as off.

The local user messaging their own sessions (ticket 03) stays allowed without sharing. Messages from any other principal to a project that is not shared are refused by the engine.

Directory entries show owner, task, reachability and freshness. A stale observation stays visible and marked stale. Enablement does not grant transcript access or editing ownership, and does not touch writer claims.

## Acceptance criteria

- [ ] `share enable` shows the field list first and applies nothing until confirmed; a declined or interrupted confirmation leaves policy unchanged.
- [ ] After enabling, the directory lists only that project's managed sessions with the shared fields; another project's sessions and any observed-only session are absent.
- [ ] `share disable` removes the sessions from the directory and the engine then refuses messages from non-local principals to that project.
- [ ] A corrupt or unknown-version policy file disables delivery for the project, reports a recoverable error, and never opens access. A restart preserves the policy.
- [ ] Task and activity freshness is recorded; an old observation is returned marked stale, not dropped or shown as live.
- [ ] No transcript, path, environment or provider context appears in directory output or in the stored presence.
- [ ] Enabling or disabling does not alter any writer claim or admission state.
- [ ] Engine-level contract tests with a test sender principal prove enforcement (end-to-end enforcement for real session senders is verified in ticket 05).
- [ ] CLI and route parity tests pass; `bun run verify` and Rust tests pass.

## Blocked by

- [#8](https://github.com/mukulchugh/setu/issues/8) (01) — Managed Claude sessions carry a durable, authenticated native conversation identity
- [#9](https://github.com/mukulchugh/setu/issues/9) (02) — Setu-owned engine: durable local inbox with honest statuses

## Gates

None external.
