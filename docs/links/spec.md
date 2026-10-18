# Setu Links: specification

Status: published as [issue #7](https://github.com/mukulchugh/setu/issues/7); slices are issues #8–#20 (see [issues/README.md](issues/README.md)). Not implemented. Baseline: Setu 0.3.0 main, `f6dda1a384bd03566e5e88f2ca898a6ce3a3976d`.

Vocabulary follows [CONTEXT.md](../../CONTEXT.md). Decisions follow [ADR 0001](../adr/0001-project-opt-in-session-discovery.md) and [ADR 0002](../adr/0002-recipient-authorizes-agent-wake.md). Product choices are in [discovery.md](discovery.md). Observed versus unknown provider and transport behavior is in [TEST-BOUNDARIES.md](TEST-BOUNDARIES.md); existing code seams are in [seams.md](seams.md); build tickets are indexed in [issues/README.md](issues/README.md).

## Problem Statement

A person working with several agent sessions across worktrees, and sometimes across machines, has no reliable way to let those sessions ask each other questions, hand each other facts, or ask the person for attention. Today they copy text between terminals. A pasted message cannot be tied to the exact conversation it was meant for. If the target is busy or restarts, nothing says whether the message arrived. Nothing prevents a peer's message from being treated as permission to run work or spend usage. Spans already records planned work and history, but it cannot show the conversation around that work.

## Solution

Setu Links lets opted-in sessions discover each other and exchange messages, with Spans as the place where run-linked exchanges become history.

- A person explicitly enables collaboration for a **shared project**. Its **managed sessions** then appear in a directory with the identity and task fields shown at enablement. Transcripts stay private.
- A message is addressed to one exact **native conversation**. It waits as a **queued message** and is handed to that conversation at its next normal turn. Statuses never claim more than was observed: queued, held, handoff unknown, handed off, acknowledged.
- Only the receiving user can choose **Send now** to start an idle **agent wake**. A peer can send an **attention request**, which notifies the person and neither wakes the agent nor grants permission to run work.
- The same inbox works across machines for invited teammates, and run-linked exchanges appear once in Spans history.
- Live Span execution follows as a separate product increment and keeps its own completion authority.

Useful messaging does not wait for execution, and a user never needs a dummy run to ask another agent a question.

## User Stories

Local delivery
1. As a developer, I want to send a message to one specific running Claude session from my terminal, so that I do not have to paste text between windows.
2. As a developer, I want the message stored durably the moment I send it, so that a crash or restart does not lose it.
3. As a developer, I want the message to appear in the target agent's context at its next normal turn, so that it does not interrupt work in progress.
4. As a developer, I want a message sent while the target is mid-output to wait for its next turn, so that it never corrupts the running turn.
5. As a developer, I want a send refused clearly if the target session is unknown or has no verified native conversation, so that mail is never queued for a conversation that cannot be identified.
6. As a developer, I want a message addressed to a conversation to stay with that conversation after a process restart and exact resume, so that a restart does not strand it.
7. As a developer, I want a replacement conversation in the same terminal and checkout not to receive the old conversation's mail, so that a new context never inherits a stale instruction.
8. As a developer, I want two sessions on the same branch or in the same directory to be addressed separately, so that one is never confused with the other.
9. As a developer, I want a retried send with the same idempotency key to produce one message, so that a lost response does not duplicate it.
10. As a developer, I want the same key with different content rejected, so that a conflicting retry is never silently accepted.
11. As a developer, I want each message to show its status, so that I know whether it is waiting, held, handed to the provider, or acknowledged.
12. As a developer, I want a handoff whose outcome is uncertain labeled uncertain and never replayed automatically, so that the agent is not shown the same instruction twice without my choice.
13. As a developer, I want to explicitly redeliver an uncertain message, so that I decide when a possible duplicate is acceptable.
14. As a developer, I want the receiving agent's context to carry each message in a bounded, structured frame with the sender's metadata kept separate from the message body, so that peer text is clearly attributed and cannot forge the frame.
15. As a developer, I want oversized messages and full inboxes refused with a clear reason, so that a sender cannot flood a session.
16. As a developer, I want old unhandled messages to expire visibly, so that stale requests do not linger.
17. As a developer, I want to cancel a message that has not been handed off, so that I can retract a mistaken send.
18. As a developer, I want delivery to keep working in the Claude sessions Setu launched, with no global hook installed on my machine, so that the feature stays scoped.
19. As a developer, I want a session whose provider delivery is not verified to say so, so that I never assume it works.

Sharing and discovery
20. As a project owner, I want to enable collaboration for one project, so that its managed sessions become discoverable without per-session setup.
21. As a project owner, I want to see exactly which identity and task fields will be shared before I enable it, so that I consent knowingly.
22. As a project owner, I want transcripts never shared by enabling a project, so that discovery does not leak conversation history.
23. As a project owner, I want unrelated projects to stay invisible, so that enabling one does not expose others.
24. As a project owner, I want to disable sharing and have discovery and incoming mail stop, so that I can withdraw.
25. As a project owner, I want a malformed sharing policy to disable delivery with a recoverable error, so that a bad file never opens access.
26. As a developer, I want a directory of discoverable sessions with owner, task, reachability and freshness, so that I can choose a recipient.
27. As a developer, I want a stale observation to stay visible as stale, so that I do not trust old presence.
28. As a developer, I want observed sessions kept distinct from managed sessions, so that only verified sessions can receive mail.

Agent collaboration
29. As an agent, I want a small set of tools to list linked sessions, send a message, and read my messages, so that I can ask a teammate's agent a question.
30. As an agent, I want my messages attributed to my own verified session, so that no one can impersonate another sender.
31. As an agent, I want to reply to a message and have the reply tied to the original, so that a request and its answer stay together.
32. As an agent, I want to send an FYI without expecting a reply, so that routine information flows with low overhead.
33. As an agent, I want to acknowledge a message explicitly, so that the sender sees it was handled and not merely handed off.
34. As a teammate, I want agents in a shared project to exchange routine text without per-message approval, so that collaboration is not blocked on me.
35. As a teammate, I want files and artifacts to require explicit sharing and transcripts never to be forwarded automatically, so that routine messages cannot leak data.

Attention and wake
36. As a developer, I want a peer to be able to request my attention, so that I am told when my input is needed.
37. As a developer, I want an attention request to neither wake my agent nor authorize work, so that a peer cannot spend my usage.
38. As a developer, I want repeated attention requests grouped while each item stays recorded, so that I am not spammed and lose nothing.
39. As a developer, I want routine messages and FYIs to stay in the inbox without notifying me, so that only attention requests interrupt.
40. As a developer, I want to choose Send now on a queued message to wake my idle agent, so that urgent mail is handled immediately.
41. As a developer, I want no one but me to be able to authorize that wake, so that a peer's message cannot start work.
42. As a developer, I want Send now shown as unavailable, with the reason, where it is not supported, so that I am not misled.
43. As a developer, I want attention to open the exact verified target session, so that I land in the right place.

Spans history
44. As a run owner, I want a message tied to a run to appear once in that run's conversation history, so that I can see the discussion around the work.
45. As a run owner, I want a replayed projection after a crash not to duplicate history, so that history stays trustworthy.
46. As a run owner, I want a remote message never to attach evidence to a run without a previously approved local association, so that a peer cannot write my run.
47. As a run owner, I want run references from different peers namespaced, so that identical run IDs cannot collide.
48. As a run owner, I want a stale generation to be rejected, so that old results cannot satisfy a revised plan.
49. As a run owner, I want unsafe message content stored inert and redacted, so that history is safe to render and search.
50. As a run owner, I want held and uncertain deliveries shown in Recovery, so that I can resolve them.
51. As a developer, I want Spans planning and history to work with Links disabled, so that Links is optional.

Cross-machine
52. As a team owner, I want to create a team and invite teammates with a Setu-native token, so that I do not depend on a hosted join page.
53. As a team owner, I want to revoke or rotate an invitation and remove a member, so that access is controllable.
54. As a teammate, I want to join with an invitation and see which fields I am sharing, so that I consent knowingly.
55. As a teammate, I want membership saved, peer connected, adapter ready, and message verified shown as distinct states, so that I know exactly what is working.
56. As a teammate, I want messages queued while a peer is asleep or offline, so that I do not resend.
57. As a teammate, I want revocation to stop delivery and be visible, so that a removed peer cannot keep sending.
58. As a developer, I want incompatible peers rejected explicitly, so that version skew never corrupts mail.
59. As a developer, I want local sessions to keep working during a network failure, so that Links never blocks local work.
60. As a teammate, I want a work request from a peer to arrive as data with a proposed scope, so that I decide whether to run it.
61. As a teammate, I want to choose the local checkout and approve any execution through my own controls, so that a request cannot start work by itself.
62. As a coordinating run owner, I want returned evidence to carry source peer, target revision and digest, so that I can judge whether it satisfies a span.

Front doors and operations
63. As a user, I want the portal, CLI, MCP and Raycast to agree on state and authority, so that I can use whichever is at hand.
64. As a user, I want a changed target or input to invalidate an earlier approval, so that I never approve one thing and run another.
65. As a user, I want an unknown outcome reconciled before any retry, so that nothing is sent twice by accident.
66. As a user, I want message bodies and invitation secrets kept out of generic logs, so that diagnostics are safe to share.
67. As a user, I want the inbox to work with keyboard, narrow layouts, and loading, empty, error and stale states, so that it is usable in every condition.

Release and lifecycle
68. As a user, I want setup to preview and apply adapter changes safely, preserving my other configuration, so that Links never overwrites my settings.
69. As a user, I want a clean install, update, disable and uninstall, with a choice about retained data, so that I control what stays.
70. As a user, I want an update interruption or rollback never to corrupt the mail database, so that an upgrade cannot lose messages.
71. As a maintainer, I want a naming check over first-party source and assets, with required third-party notices kept separate, so that product naming stays Setu-native.

Live execution (follow-on)
72. As a run owner, I want a planned span dispatched to one real local worker, so that Spans can execute work and not only plan it.
73. As a run owner, I want a process exit, a reported outcome, and accepted completion kept distinct, so that a message saying "done" never completes a span.
74. As a run owner, I want a kill or restart at any boundary to hold unknown work, so that nothing is relaunched blindly.
75. As a run owner, I want dependent spans to become ready only after accepted completion, so that the plan stays correct.

## Implementation Decisions

### Ownership

- **The Setu-owned Links engine is the single authoritative store** for messages, per-recipient delivery state, receipts, sharing policy and, later, peer roster and transport receipts. Only the engine opens its database. JavaScript is a client of the engine's operation protocol and never reads or writes message state, and no JavaScript mailbox exists beside it, even temporarily.
- **Setu session services remain authoritative for local identity**: process, checkout identity, provider-native conversation binding and exact terminal focus. The native conversation binding becomes durable on the session record. Links does not keep a parallel identity table.
- **Spans remains authoritative for runs, spans, attempts and accepted completion.** It receives redacted, bounded projections of message outcomes and never owns delivery state.
- **Existing writer claims, admission, attention and operation outcomes keep their authority.** A remote presence row is never a local lock, a spend approval or a wake authorization.
- **Each message state field has exactly one owner.** The sender-side engine owns submission and outbox state. The recipient-side engine owns inbox, claim, handoff and acknowledgement state. A transport only moves envelopes between them and may keep a retry queue derivable from the outbox.

### Engine and transport boundary

- **The engine is derived from selected parts of the reviewed Rust store and transport source, pinned to a recorded revision and checksum.** Reuse is already authorized and is not a gate. Only the parts Setu needs are brought in (durable store, outbox/inbox, transport, roster, reconnect). First-party surfaces are renamed to Setu-native names, and inherited login, installer, self-update and unused standalone surfaces are removed. Required licenses and provenance are kept in separate legal metadata, outside the product documents, and travel with distributed artifacts.
- The engine exposes a versioned, Setu-namespaced operation protocol that does not assume a local caller. The first local mode may be one short-lived process per operation (JSON request in, JSON response out) over the engine's durable store; a long-running mode for peer transport uses the same protocol and the same store. The choice of first mode follows what the reused store supports and is confirmed in the engine ticket.
- Peer transport is added later behind that same protocol and store. It consumes the outbox and calls the recipient engine's deposit operation. It never replaces local delivery ownership.
- **There is one engine and one store.** The reused store is the sole mailbox. No second mailbox, queue or delivery table is created in JavaScript or beside the engine.
- **Toolchain.** Rust 1.99.1 is verified installed in an isolated build-tools directory with no shell PATH change. Builds invoke that toolchain explicitly, the pinned version is recorded in the repository, and reproducible provisioning in CI is an acceptance item of the engine ticket.
- Engine state lives in Setu's private data directory under a Links subdirectory, with owner-only permissions. Reads are passive; nothing starts on a status read. The engine is a Setu-managed process, not a standalone product: no login, no installer, no self-update.

### Contracts

**Identity.** The recipient is a native conversation, identified by provider, native conversation ID and checkout identity, with the managed session ID recorded as a locator hint. All are captured from the managed session record at send time and are immutable on the message. Display names are not identity. **A send to a session with no verified native conversation binding is rejected** (stable code, nothing stored); it is never queued or held for a later arbitrary conversation, and mail is never delivered through a process, terminal, branch or directory fallback. A different native ID, including a replacement conversation in the same managed session, never receives the old conversation's mail; that mail is `held` as conversation replaced. An exact resume of the same native ID within the same managed session record keeps its mail, provided delivery-time verification below passes and the checkout incarnation still matches. The same native ID is never bound to two concurrently live records. Resuming it under a different or new record, after the previous one ended, is refused unless an explicit authenticated rebinding operation exists; ticket 03 must provide and verify that path for its cross-process scenario (issue #8).

**Binding record.** The verified binding is stored on the existing private managed-session record: provider, native ID, bound-at, and a bounded history of replaced IDs. It is not stored in a Links table.

**Hook authentication.** A native ID plus a working directory is only a locator, never proof. Every production hook resolution, for attention and for Links, requires the retained per-launch secret capability. Only a digest of that capability is persisted. Resolution also verifies provider, managed session, checkout incarnation and lifecycle (the session is owned, running and not ended or replaced). The capability is not consumed at first bind. Missing, wrong, cross-session, ended or replaced credentials resolve nothing, including after a portal restart.

**Message record.** Message ID, caller idempotency key, SHA-256 digest of the exact payload, sender, recipient locator, optional reply-to, optional run/span correlation hint, size, created time, expiry. The same key with the same digest returns the existing message. The same key with a different digest is a conflict.

**Delivery states.**

| State | Meaning | Does not mean |
| --- | --- | --- |
| `queued` | Durably accepted; waiting for the recipient's next eligible turn | Delivered, read |
| `held` | Cannot be delivered under current evidence; carries a reason code such as conversation replaced, session not running, checkout changed, policy disabled | Failed permanently |
| `handoff-unknown` | A claim happened and the outcome is uncertain for any reason, including output written followed by a failed report; never replayed automatically | Queued, lost, or seen |
| `handed-off` | The hook wrote the message and the confirming report was received | Understood, read, or acted on |
| `acknowledged` | The recipient, or the receiving user, explicitly acknowledged it | Task completion |
| `expired`, `cancelled` | Ended without handoff | |

**Handoff protocol.** Live observation showed a retained mailbox is emitted again on every retry and resume, so deduplication belongs to the engine. The sequence is claim, emit, confirm. Claim atomically moves queued messages to an attempt before any output and returns them with an attempt ID.

- **Before claim**, any failure (portal down, authentication failure, engine unavailable, hook timeout) leaves the messages `queued`.
- **At or after claim**, the state is `handoff-unknown` until a confirming report is received. This covers a response lost on the way to the hook, a hook that crashed, output written followed by a failed or missing report, and a portal or engine killed mid-sequence. Such messages are never returned to `queued` and never re-claimed automatically.
- A confirming report moves them to `handed-off`.
- Only an explicit redeliver by the receiving user creates a new attempt; the record keeps the attempt count.

The hook never blocks the user's turn, but no guarantee is made that a failed hook wrote nothing.

**Context framing.** Messages enter context in a bounded, structured frame: sender metadata (sender, message ID, time) is kept apart from the body, the body is encoded so that frame delimiters inside it are escaped, and count and total size per turn are limited. This keeps attribution intact and stops a body from forging the frame. **It is not a defense against prompt injection, and no document may claim immunity**: a model may still act on text it reads. Setu's protection is that an incoming request carries no authority in Setu's own controls (claims, admission, usage, completion); it cannot execute or spend by itself.

**Authority.** A transport acknowledgement or a handoff cannot accept completion, release a writer claim, unblock a dependency, or authorize a wake. Executing a received request requires the receiving user's local, reviewed authorization bound to target, input, plan and generation.

### Session integration

- Extend the managed Claude launch with one more hook event for prompt submission. The portal authenticates the request with the per-launch capability (see Hook authentication), verifies the binding on the session record, calls the engine to claim, and returns the framed text. The generated hook writes it and then reports back. Failures before claim leave mail queued; failures at or after claim leave it `handoff-unknown`.
- Authentication is part of this scope, not later hardening. The existing attention path is brought under the same rule in ticket 01.
- Only Claude is in scope for natural-turn delivery until provider evidence exists. A send to a Codex session is rejected with a provider-unverified code. This is a statement about unverified evidence, not unsupported.
- Agent-facing tools use a session-bound entrypoint so a call is attributed to a verified session. The generic local MCP endpoint cannot identify its caller and is not used for agent messaging.

### Sharing

- Enabling a project shows the exact fields that will be shared (owner identity, task label, reachability, freshness) before it takes effect. Transcripts, paths, environment and provider context are never part of presence.
- Visibility, receiving messages, interrupting an agent, and raising human attention are four separate permissions. Project visibility and wake permission are separate decisions.
- The local user may message their own managed sessions without a shared project. Session-to-session and cross-machine messaging require an enabled shared project and, across machines, an invitation. Same-machine delivery follows an explicit policy as well. A malformed policy fails closed.

### Surfaces

- Names: UI "Links"; CLI `setu links ...`; HTTP `/api/links/*`; environment `SETU_LINKS_*`; session tools `list_linked_sessions`, `send_session_message`, `read_session_messages`; engine and package `setu-links`; archive event namespace `links.*`.
- All front doors call one Links service composed in the portal. Routes are registered through the public route table, the dispatch tables and the composed service, with parity tests. The CLI refuses rather than launching when the portal is down.
- Invitations use a Setu-native CLI token. Protocol and handshake are Setu-versioned; incompatible peers are rejected explicitly. No compatibility with any other product's protocol or environment names is promised.

### Spans projection

- A run-linked message is projected into the Spans archive with a deterministic event ID, committed together with an advance of the engine event cursor in one archive transaction. Replay is safe. A missing projection is pending, not lost.
- A peer supplies correlation hints only. The receiving service accepts them only against a previously approved local association. Remote run references are namespaced by peer identity. Unassociated messages stay in the Links inbox.
- Projections are redacted and bounded. Search extraction learns the new bounded event shapes. Indexing is an explicit background writer with a durable cursor and an opt-in lifecycle; a read never builds an index.

### Live execution

A narrow execution composition beside the offline runtime wires the existing dispatch, actions, worker and recovery modules to real local adapters for one owned worker and one provider. One owner reserves each resource, so a launch never reserves twice. Process exit, reported outcome and accepted completion stay distinct. Active-plan edits are not a workaround; replanning an active run needs its own specified transition.

The first Claude Code profile uses the receiving user's existing subscription, without a dollar budget or `--max-budget-usd` (user decision, 2026-10-18). Usage records retain observed tokens and provider cost estimates, clearly distinguished from subscription charges. Cancellation, wall-clock limits, writer ownership and shared resource admission still apply. A profile that explicitly requires a monetary ceiling must still refuse when that ceiling cannot be enforced. Requested effort and observed effort are separate: an absent runtime observation is not reported as verified.

### Naming

All authored code, docs, prompts, hooks, configs and assets use Setu-native names. A branding check covers first-party source and distributable assets, with narrow exceptions for required notices and provenance. Source provenance and license text for any reused code are maintained separately in a legal-notices location and in shipped artifacts. That work is tracked outside these product documents.

## Testing Decisions

- A good test exercises external behavior through the highest seam: the actual CLI against a running portal against the engine process, or the real hook entrypoint, never a private function. Assertions are on observable state and exit codes.
- **Primary seam:** the CLI and portal HTTP surface, backed by the real engine binary and a real database in a temporary directory. This is the single seam most tickets share.
- **Provider seam:** the real hook entrypoint driven with recorded provider hook payloads for fast tests, plus a scripted live acceptance run against a real managed Claude session for each provider/OS combination claimed. A recorded payload is a contract test, not provider evidence.
- **Crash tests are required for claim, emit and confirm:** kill the hook, portal and engine at each step and after each store commit. Assert: failure before claim leaves `queued`; any failure at or after claim, including output written followed by a failed report, is `handoff-unknown` and never `queued`; only a received report gives `handed-off`; nothing replays on its own.
- **Engine tests** run under the Rust test harness. Bun contract tests cover the client, service, routes, CLI parity and hook. Cross-machine tests use two engine instances with separate data directories first, then real devices.
- Prior art: the existing session, attention and handoff tests use injected adapters and fake clocks; the route table has parity tests; Spans store tests cover idempotent event commits and generation fencing. New engine-side tests have no prior art in this repository.
- New test files must be added to the explicit test script, and new modules and artifacts to the packaged file list.
- Full `bun run verify` must pass; Rust tests and the naming check are added to the verification path once the toolchain is provisioned.
- Live provider results are recorded in TEST-BOUNDARIES with dates and versions. A simulated or recorded result is never reported as provider acceptance.

## Out of Scope

- Automatic code synchronization, remote shell access, automatic merges, shared provider credentials, enterprise SSO, multi-writer distributed run storage.
- A second plan editor, transcript archive, budget ledger or writer-lock system.
- A hosted join page or hosted relay product. Relay availability for cross-machine connectivity is an open dependency of the cross-machine ticket, not a new service in this scope.
- Forwarding transcripts, paths or environment automatically.
- Terminal text injection as a delivery transport. Natural-turn delivery uses the provider's prompt hook.
- Treating imported history or remote assertions as anything but observations.
- Codex natural-turn delivery until evidence exists.
- Compatibility with any other product's protocol, environment names or standalone installer, login or self-update flows.
- A hosted installer, launchd packaging and update-transaction packaging before the release-lifecycle ticket.

## Further Notes

- **First ready slice:** tickets 01 (session identity) and 02 (engine inbox) can start together; ticket 03 joins them into the first useful end-to-end slice. See the index.
- **Largest risks, in order:** (1) the managed-session hook path has not been exercised with a prompt hook, and the live evidence used native, not managed, sessions; (2) the compiler is verified locally; the engine has not yet been built or verified in CI; (3) the Send now mechanism is unproven; (4) cross-machine connectivity and revocation are untested; (5) adapting the reused store and transport to the Setu protocol is untested.
- **Relation to the integration plan:** this specification follows it. The engine is authoritative from the first increment and is derived from selected reviewed source. Licenses and provenance live in separate legal metadata.
- **Code-research finding to carry forward:** the existing hook binding that maps a native session to a managed session is held only in memory, so it is lost on portal restart. Ticket 01 fixes it as a prerequisite of exact delivery and it benefits existing attention too.
- **Proposed glossary additions (not applied; CONTEXT.md is unchanged):** Native conversation binding, Handoff, Handoff attempt, Inbox. Add them if the parent agrees.
- Message size, queue length, expiry and per-turn context limits are tunable defaults set in ticket 02 and recorded there with their rationale; they are not product decisions.
