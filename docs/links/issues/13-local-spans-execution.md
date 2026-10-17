# 13 — A planned span runs on one real local worker and completes only on accepted evidence

**GitHub:** [#20](https://github.com/mukulchugh/setu/issues/20) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 4 · **Release scope:** live execution follow-on (after the first public release) · **Status:** published, ready-for-agent

## What to build

Spans today plans and records history; dispatch, worker, recovery, usage and cmux modules are tested foundations with no production caller. Build one execution composition beside the offline runtime, so that a reviewed span is dispatched to one real local worker on one provider and finishes through accepted completion. This is independent of Links messaging and does not wait for it.

- Keep effects out of read and planning services. Start with one owned local worker and one provider; widen only after acceptance tests.
- Supply real adapters for: authorization, checkout and dependencies, setup, capability probes (trusted local probing, not peer or model claims), archive capacity, writer claims, shared admission, usage and worker launch/completion. Map usage reserve/reconcile/read to dispatch's reserve/release/settle contract with verified receipts and contract tests; no successful no-ops. One owner reserves each resource so a managed or headless launch never reserves twice. Only one process supervisor owns a worker attempt.
- Wire durable launch intent, bounded output capture, deadline driving, cancellation, completion verification and startup reconciliation. Register a completion verifier that checks the reviewed tree and acceptance evidence. Process exit, reported outcome and accepted span completion stay distinct.
- Use the current plan; do not bypass the refusal to revise a plan with action history. Active replanning needs its own specified transition and is out of scope here.
- The ticket is large. Land it in two checkpoints that each pass verification: (A) dispatch through a real worker with captured artifacts; (B) completion verification, accepted completion, dependent readiness and restart reconciliation.

## Acceptance criteria

- [ ] Planned span → reviewed dispatch → writer, admission and usage reservation → one real worker → captured artifacts → verified outcome → accepted completion → dependent span ready → resources released appropriately. Demonstrated end to end.
- [ ] Kill the process at each boundary (after intent, after reservation, mid-launch, mid-run, after exit, after outcome, before acceptance) and restart: unknown work is held and not relaunched; resources stay retained until resolved.
- [ ] A worker exit without verifiable evidence, or a reported "done", does not accept completion or make dependents ready.
- [ ] A late-generation report stays historical and does not advance current work.
- [ ] Cancellation delivery is distinguished from exit; a cancelled attempt is not completion.
- [ ] Usage adapters satisfy the dispatch contract by contract tests; a missing method is a failure, not a no-op.
- [ ] Capability evidence comes from local probes; peer or model-supplied JSON cannot establish capability or authorize spend.
- [ ] Reads, planning and history behave exactly as before with execution disabled; existing tests pass.
- [ ] Only if ticket 12 has already merged: a work request approved under ticket 12 can be dispatched through this path, and the approval's target, input, plan and generation binding is re-checked at dispatch. If 12 has not merged, this criterion is deferred to whichever of the two merges second.
- [ ] `bun run verify` passes. Results for U15 recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md).

## Blocked by

None — can start immediately (follow-on by product priority, not by dependency). It is not blocked by ticket 12; the connection to approved work requests is the conditional criterion above.

## Gates

External: a real provider run for the chosen provider and OS; results are recorded as observed. cmux effect-boundary adapters stay optional and unverified.
