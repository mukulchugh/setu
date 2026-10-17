# 10 — Every front door agrees, and uncertain operations are recoverable

**GitHub:** [#17](https://github.com/mukulchugh/setu/issues/17) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 6 · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

A user can use the portal, CLI, MCP and Raycast interchangeably for Links and see the same state and the same authority. Setup, sending, membership and policy changes are recorded as operations with durable correlation IDs, so a partial or unknown result can be inspected and reconciled before any retry.

- **Portal.** A Links inbox and directory: list, message detail with status and reply-to, send, acknowledge, redeliver, cancel; sharing and team settings; the Send now control per ticket 06's outcome. Session rows and the Agents panel show owner, task, reachability and linked run. Attention items reuse the existing attention list; do not create a second human inbox.
- **Front doors.** CLI, MCP administrative tools and Raycast commands call the same Links service. Spans planning/history/execution stays under `setu spans`; Links communication and teams stay under `setu links`. Agent-facing tools remain the small set from ticket 05.
- **Operations.** Use the existing operation outcomes for setup, sending, membership and policy changes. Record correlation IDs and partial/unknown results without message bodies or invitation secrets in generic logs. Reconcile before retry.
- **Authority.** A changed target or input invalidates a previous approval. An inaccessible target is explicit. No front door grants itself wake permission.
- **Docs.** The agent reference documents the Links routes and commands; route and parity tests cover the public route table, dispatch and docs.
- **Quality.** Keyboard navigation, narrow layouts, loading, empty, error and stale states, and notification suppression for routine messages.

## Acceptance criteria

- [ ] For the same inbox, portal, CLI, MCP and Raycast show identical messages, statuses and permitted actions; a parity test enumerates them.
- [ ] Every Links route appears in the route table, dispatch tables and docs; a test fails when any of the three is missing.
- [ ] Interrupt a send, a membership change and a policy change after commit but before the response: an operation record exists with a correlation ID; retrying reconciles and does not duplicate; the unknown state is visible.
- [ ] Generic logs and operation records for those flows contain no message bodies or invitation secrets (tested).
- [ ] Approve an action, change its target or input, and the approval no longer applies.
- [ ] A target that cannot be accessed is reported explicitly with a stable code, in every front door.
- [ ] Portal checks pass for keyboard-only use, a narrow viewport, and each of loading, empty, error and stale; routine messages cause no notification and attention requests do.
- [ ] Agent-facing tools expose no administrative capability (test enumerates).
- [ ] `bun run verify` passes, including importability and docs tests.

## Blocked by

- [#12](https://github.com/mukulchugh/setu/issues/12) (05) — Two real sessions exchange a request, a reply and an FYI
- [#13](https://github.com/mukulchugh/setu/issues/13) (06) — Attention requests notify the person; only the receiving user can Send now
- [#16](https://github.com/mukulchugh/setu/issues/16) (09) — Teammates on separate machines exchange messages

## Gates

None external.
