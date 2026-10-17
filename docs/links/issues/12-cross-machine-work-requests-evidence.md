# 12 — A teammate's work request is approved locally and selected evidence returns

**GitHub:** [#19](https://github.com/mukulchugh/setu/issues/19) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 5 (work-request part) · **Release scope:** release-optional; may follow the first public release · **Status:** published, ready-for-agent

## What to build

A request/approval/evidence exchange between machines. **This ticket does not run any work.** Live execution is ticket 13; until it is merged and connected, approval records the teammate's authorization and nothing starts.

A coordinating run owner sends a teammate a work request with a proposed scope and correlation ID. It arrives as data in the teammate's inbox. The teammate chooses a local checkout and session and records an approval through their own controls. The teammate then returns bounded, selected evidence with source peer, target revision and digest, which the coordinating run owner can attach to the run and judge. The owner decides whether it satisfies the span.

The request is data and grants no authority. A transport acknowledgement or a "done" message never accepts completion, releases a writer, or unblocks a dependency. Local claims do not become distributed locks. Remote run references are namespaced by peer; a result for a different plan or generation is kept as an observation and cannot satisfy the span. Active-plan edits are not used to assign a collaborator.

## Acceptance criteria

- [ ] A request from machine A appears in machine B's inbox as data; nothing starts on B, and no worker, claim or admission state changes, before or after B approves.
- [ ] B's approval is bound to target, input, plan and generation; changing any invalidates it. The approval is recorded and visible to B and, as a status, to A.
- [ ] B returns selected evidence; A sees source peer, target revision and digest, stored as evidence and not as completion.
- [ ] Evidence for a stale generation, another plan or another peer's colliding run ID is not attached to the run.
- [ ] Neither a message saying "done" nor an acknowledgement changes accepted completion, a writer claim or dependency readiness.
- [ ] Only explicitly selected evidence leaves B; no transcript, path or environment is included; size and redaction limits hold.
- [ ] Disconnect and restart mid-exchange converge without duplicate evidence.
- [ ] Verified on two real devices; results recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md).
- [ ] The documentation and any UI state plainly that approval does not start execution.
- [ ] `bun run verify` passes.

## Blocked by

- [#14](https://github.com/mukulchugh/setu/issues/14) (07) — A run-linked exchange appears once in Spans history
- [#16](https://github.com/mukulchugh/setu/issues/16) (09) — Teammates on separate machines exchange messages

Not blocked by ticket 13. Connecting an approved request to execution is a criterion of ticket 13, not of this ticket.

## Gates

Inherits ticket 09's real-device and relay gates (U9, U12).

- [ ] If slice 13 is already complete, connect approved requests to its reviewed dispatch path and test target/input/plan/generation revalidation. Otherwise this slice remains data-only and slice 13 owns that integration when it lands.
