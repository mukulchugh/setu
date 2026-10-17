# Setu Links discovery

Status: six product choices confirmed by the user. Technical delivery evidence remains pending. This is a decision record for specification preparation, not an implementation specification.

## Confirmed direction

- Build session collaboration into Setu, taking the released Spans product into account.
- Use Setu-native product and code naming. Preserve required third-party legal notices separately when reusing code.
- Specifications and build tickets belong in mukulchugh/setu GitHub Issues.
- Use the default five triage label mappings and preserve existing labels.
- First public release: cross-machine communication plus Spans history. Live Span execution follows as part of the overall product plan.
- Sharing: explicitly enable a project, then automatically expose its managed sessions. Show the identity/task fields being shared; keep transcripts private.
- Delivery: messages wait for the agent's next normal turn by default. Only the receiving user may authorize Send now to wake their idle agent where supported. Peers may request attention but cannot authorize a wake.
- Sending: shared-project agents may exchange routine text with invited teammates without per-message approval. Files and artifacts require explicit sharing; transcripts are never automatically forwarded.
- Notifications: only explicit attention requests notify the person. Routine messages and FYIs remain in the inbox. Repeated notifications are grouped without deleting durable attention items.

## Verified baseline

Setu 0.3.0 main at f6dda1a384bd03566e5e88f2ca898a6ce3a3976d exposes offline Spans planning and retained history through portal, CLI and MCP. Dispatch, worker, recovery, usage and cmux modules are tested foundations without live runtime composition. Full configured verification passed on Bun 1.3.14: 1,760 tests, two standalone scripts and configured typechecks.

## Proposals awaiting decisions or evidence

- Setu Links is the working name.
- Reuse a pinned, Setu-branded Rust transport engine and existing Spans persistence/UI rather than duplicate either subsystem.
- First technical proof: two real managed Claude/Codex sessions exchange a request and reply with correct identity and honest delivery status.
- Live provider delivery and busy/restart behavior need a bounded prototype.

## Next evidence boundary

The product choices above were confirmed in two rounds. An interactive state prototype should make their consequences reviewable before the specification is finalized. A separate live provider experiment must establish exact-conversation binding, natural-turn delivery, busy behavior and restart handling; a simulated demo cannot establish provider support.

The eventual specification and tickets must retain these evidence gaps explicitly. Do not convert a prototype receipt into a claim of real provider acceptance.

## Policy prototype

An in-memory delivery demo is captured locally on the `prototype/links-delivery` branch at `5522fd5` (a separate local checkout, not part of this repository). Open `prototype-links-delivery.html` and read `PROTOTYPE-LINKS-NOTES.md` on that branch. It checks the agreed policy, not actual provider delivery. Logic self-checks passed; browser acceptance was not performed.

The native-provider experiment's results are recorded in [live-delivery-results.md](live-delivery-results.md). Its technical evidence feeds the specification and tickets.
