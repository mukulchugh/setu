# Setu Links: test boundaries

What has been observed, what has not, and what no document may claim. Source: [live-delivery-results.md](live-delivery-results.md) (17 October 2026), the baseline review in [discovery.md](discovery.md), and the code research in [seams.md](seams.md). The synthetic harness and logs behind the live results are retained locally outside this repository and have no portable path.

## Scope of the evidence

The original hook observations O1–O7 were made with Claude Code 2.1.302 and Sonnet 5.5, in native sessions started in a cmux workspace, with tools and MCP disabled, synthetic messages, and an explicit local prompt hook. **O1–O7 are provider hook and identity observations. They are not tests of the Setu Links service**, and the sessions were **not Setu-managed sessions**. A recorded payload, a prototype receipt or a simulated demo is never provider acceptance.

## Observed

Each row is a finite observation, not a guarantee.

| # | Observation | Limits |
| --- | --- | --- |
| O1 | Two native sessions in the same directory: a mailbox addressed to one exact native conversation ID reached only that session at its next normal turn; the other returned no mail. | Same directory only. Not a Git same-branch fixture. |
| O2 | Depositing mail while the recipient was idle did not start a turn. Mail appeared only after a normal user turn. | Finite observation, not a timing guarantee. |
| O3 | **Busy deposit:** mail written while a session was visibly producing output did not appear in that turn. The turn finished without it, the session stayed idle, and the mail appeared on the next user turn. | One observation, mid-output, synthetic. Not mid-tool call, not at a permission prompt. Not a managed session. |
| O4 | A retained mailbox was emitted again on retry and on resume: three hook emissions for one message. | Shows deduplication cannot be assumed. Says nothing about how Setu should dedupe. |
| O5 | Exiting a session and resuming with its exact native ID preserved identity and hook routing. | Native session, not a Setu-managed relaunch. |
| O6 | A replacement conversation (new ID) in the same terminal and directory did not receive the old conversation's queued mail. | Native session only. |
| O7 | The mail entered through the provider prompt hook, not terminal text injection. | Hook output is context-emission evidence. An exact nonce echo is receipt evidence for this test only, not understanding or task completion. |

Code observations from reading baseline `f6dda1a`, not run: the managed-session native binding lives in memory and is lost on portal restart; the generated hook is fire-and-forget; only `Stop` gives an idle signal; the Ghostty `deliver` adapter exists but has no evidence of effect on an idle provider prompt.

## Not established

Do not state any of these as true. Each is a gate for the ticket named.

| # | Unknown | Gate for |
| --- | --- | --- |
| U1 | A prompt hook works in a **Setu-managed** Claude session launched with generated settings, and the hook program can write the provider's context output in time. | 01, 03 |
| U2 | Managed-session binding and per-launch capability authentication survive portal restart and relaunch with a real provider. Rejection of missing, wrong, cross-session, ended and replaced credentials is covered by contract tests. | 01 |
| U3 | Process death in the middle of handoff, and exactly what the provider saw. | 03 |
| U4 | Real-provider effects across a claim or confirmation failure. Engine persistence and claim/confirm transitions are covered by process and crash tests; they do not prove what a provider saw. Setu promises no silent replay, never exactly-once delivery. | 02, 03 |
| U5 | Mid-tool-call, permission-prompt and multi-prompt-race behavior of mail arriving during a turn. | 03 |
| U6 | Same-branch Git fixture with two managed sessions running real providers. | 03, 05 |
| U7 | Provider-supported idle push or any way to start a turn. Receiver-authorized wake is a separate action and is **unproven**. cmux terminal injection is not validated as a production transport. Probe outcome 18 October 2026: **not passed, inconclusive**; Send now is unavailable (see the Attention and Send now section). Still open. | 06 |
| U8 | Recipient authorization enforcement. The engine's rejection of every non-local principal is contract-tested; there is no authorized effect to exercise, so the positive half cannot be shown. Still open. | 06 |
| U9 | Cross-machine transport, direct and relay connectivity, reconnect, offline queue, sleep and revocation. | 08, 09 |
| U10 | Codex support. The first Codex harness failed on a configuration mistake and produced no result; sandboxed headless Claude runs timed out. **Neither shows a capability limit.** Codex is **unverified**, not unsupported. | 03, 05, 11 |
| U11 | Other Claude versions, other operating systems, other terminals. | 11 |
| U12 | Real device-to-device behavior of the Rust transport. | 08, 09 |
| U13 | Reproducible Rust build. Toolchain 1.99.1 is verified installed locally in an isolated build-tools directory with no PATH change. The local engine builds with its locked dependencies and passes process and crash tests. CI provisioning and cross-platform reproducibility remain unverified; transport integration is still in progress. | 02, 08 |
| U16 | An explicit authenticated resume path for a native conversation under a new or different managed session record, **run against a real Claude session.** Ticket 01 refuses cross-record adoption by itself; an explicit reviewed resume now exists (`setu sessions resume`) with contract tests only, and has not been run live. O5 covers a native session only. | 03 |
| U15 | Local Spans execution is now composed into the portal and CLI and tested with one real Claude subscription task at the service boundary. Still unverified: a complete native task through HTTP/CLI, real-process restart recovery, Linux, unknown-attempt recovery and work-request integration. See the 18 October evidence below. | 13 |

## Claims that are forbidden until their gate clears

- "Links works with Codex." Say "unverified".
- "Prompt-injection safe" or "immune". Framing gives attribution and frame integrity only; a model may still act on text it reads.
- "A failed hook wrote nothing." After claim, an uncertain result is `handoff-unknown`.
- "Messages are delivered." Say `handed-off`, which means the hook wrote it and the confirming report arrived, not that the agent read or understood it.
- "Wake is supported." Say "unproven" until ticket 06's probe passes with evidence.
- "Messages are exactly-once." Setu promises idempotent sends and no silent replay of an uncertain handoff.
- "Cross-machine works." Not until two real devices exchange messages (ticket 09).
- "cmux integration." The cmux adapter in Spans is injected-only and untested against a real effect.
- Any claim that a native cmux session result applies to a Setu-managed session before U1 is cleared.

## Contract tests for natural-turn delivery (not provider acceptance)

Added with ticket 03 (#10). They run the real managed-session service, Links service, engine binary (plain and `test-hooks` builds), the portal's real hook route over HTTP and the **real generated hook program as a child process**, in disposable state. The Claude side is a **recorded `UserPromptSubmit` payload and a fixture process**: nothing here talks to a real Claude, Ghostty or cmux, and none of it is evidence about a provider.

What they establish about Setu's own behavior, and no more:

- A queued message is written once at the next turn through stdout and reads `handed-off` only after the hook's report; it is not re-emitted.
- Failure matrix: portal down, bad credential, engine absent or too slow before the claim leave the mail `queued`; an engine killed before the claim commits leaves it `queued`; an engine killed after the commit, a response lost after the claim, a hook killed after the claim, output written followed by a killed hook, a refused or unanswered report, and a closed output pipe leave it `handoff-unknown`; none of these is re-emitted, and only a reviewed `redeliver` makes one new attempt. A report after a portal restart is accepted.
- Missing, wrong, cross-session, ended and replaced capabilities return no mail, before and after a portal restart; a second session in the same checkout gets nothing; a replacement conversation gets nothing and the old mail is held.
- Binding moved between authentication and the engine handoff (before and after the claim): the old hook gets nothing and the new conversation's mail is untouched.
- Frame integrity of the engine's framing (delimiters in any letter case, control characters, imitated sender headers, size and count limits, round-trip of sender, ID and time). This shows frame integrity only. It says nothing about whether a model resists text it reads.
- The hook sends identity fields only, never the user's prompt; it ends within its own deadline when the portal never answers.
- Provider output limit (engine side, contract-tested): a turn's serialized text stays within Claude's documented 10000-character cap on plain hook output, counted in UTF-8 bytes (never smaller than characters), whole messages only, nothing cut. Mail stored under the earlier 16 KiB rule is held (`provider-output-limit`), readable, never claimed.
- Explicit resume across managed records: review before launch, exact token, a fresh launch with `--resume`, binding only through the new launch's capability, mail following the conversation, refusal of a stray start, a live holder, an unknown ID, a changed checkout, a stale or corrupt intent.


Combined delivery/directory verification on 18 October 2026: `bun run verify` passed 2,154 Bun tests, the standalone agent/compose checks, 276 Rust tests across plain and test-hook builds, and all three TypeScript checks. Changed-file Biome checks and the locked release build passed. Added interaction tests cover session-principal framing, a policy hold surviving cross-record resume, and authenticated prompt activity reaching the directory. These remain contract tests.

**Remaining integration gate:** the current delivery service still reconciles before claiming without an engine generation fence. JavaScript reauthentication prevents returning a stale response, but cannot undo an earlier engine mutation. Before release, compose the transport binding publisher and invalidation fence, pass the captured generation into the claim transaction, and verify stale-conversation and late-publish races against the combined engine. The tests above do not clear this gate.

Observation by the parent on the provider's cap, recorded as observed and not as acceptance (18 October 2026, Claude Code 2.1.302, Sonnet 5.5, tools disabled; source `PARENT-NATIVE-HOOK-CONTEXT.json`). **Boundary: real Claude running the generated hook program and settings, answered by a synthetic authenticated HTTP response. Not a Setu-managed process, not real Links mailbox delivery.** (1) A generated hook writing exactly 10000 ASCII bytes: both random markers, at the start and the end, were visible to the model; one claim and one report were made after the write. (2) A custom 20000-byte stdout: the head marker was visible and the tail marker was missing. Limits: ASCII only, so whether the provider counts bytes or characters for multibyte text is still unmeasured (the engine's byte count is the conservative reading); one model, one version, one run each; nothing here says a managed session behaves the same. U1 and U3 stay open.

Not established by these tests (unchanged): U1 (a prompt hook in a **managed** session launched through the real launcher and a real provider, including whether the generated settings and its `timeout` are honored), U3 (what a real provider saw when a process died mid-handoff), U5 (mid-tool-call, permission-prompt and multi-prompt-race), U6 (a real same-branch two-session Git fixture), U10 (Codex) and U16 (live resume: built and contract-tested only). The provider's output form is plain stdout context as observed in the 17 October native test; it has not been re-verified against the documented contract for a managed session here.

## How a ticket clears a gate

A ticket that clears a gate records, in this file, the date, provider and version, session type (native or managed), the scenario, the exact observation, and its limits. It does not edit a limit away. Results from a failed or inconclusive run are recorded as well, with the cause if known.

## Spans execution evidence, 18 October 2026

The local execution service has a production caller, off by default under `spansExecution.enabled`. Independent spec and standards reviews covered it against issue #20; the author ran 1900 JavaScript tests and three typechecks before integration. Those process tests use a local provider fixture. They cover crashes, owner fencing, cancellation, admission, usage and explicit acceptance, but are not native-provider evidence.

One actual Claude Code 2.1.302 / Sonnet 5.5 subscription probe and task used the shipped default command, including restricted mode, no ambient setting sources, auto permission mode and the six named coding tools. No dollar budget flag was passed. The provider did not report effort, which the profile explicitly records as requested but unverified. Token and API-equivalent amounts are provider estimates, not subscription charges.

The real task created `add.mjs` in a disposable Git checkout. The parent independently imported it and checked three arithmetic cases. The build Span remained unaccepted until an explicit owner acceptance; only then did its dependent become ready. The real host had less than the default 20 GiB storage floor, so the successful one-file test used a 10 GiB floor only in its disposable service configuration. Production admission was unchanged.

A separate listening HTTP portal reopened that archive using config-enabled production composition, without an injected execution service, provider, admission or host observation. Capabilities, status and review worked; dispatch correctly returned `ADMISSION_REFUSED` with `admissionCode: STORAGE_LOW`, no launch and exact writer-recovery data. The CLI handler read status over a custom transport to that isolated HTTP port. This is not a full native task through the default-port CLI.

Parent deterministic regressions reproduced and then verified fixes for stale owner acquisition and concurrent resolve/dispatch: recovery refuses the racing dispatch; the next reviewed retry acquires a fresh action identity, writer and usage reservation while retaining the old released ledger row. These used real storage and local fixture processes. Native Ghostty delivery and two-host transport remain separate, open gates. Evidence scripts and synthetic logs are retained outside the repository.

## Attention requests and Send now, 18 October 2026 (ticket 06 / issue #13)

**Contract tests, not provider acceptance.** The real engine binary (plain and `test-hooks` builds), the real managed-session, Links and attention services, the portal's route tables and the CLI, over disposable state. The Ghostty effect and process observation are stand-ins that record every call. Nothing here talks to a real Claude, Ghostty or cmux.

What they establish about Setu's own behavior, and no more:

- Attention is off for a shared project until the user reviews and enables it; switching it off is immediate; enabling the share again keeps the choice, and a withdrawal starts over off with a new scope. A policy that grants `interrupt`, or carries anything else, is unreadable and admits nobody.
- A request is retained in full, never delivered to an agent (no delivery row; the recipient's next turn carries nothing; claim, inbox, status, cancel, acknowledge, redeliver, sweep, reconcile and resume cannot see it), starts no turn and changes no session record, admission, writer claim or terminal. It shares one idempotency namespace with messages. Size, text, rate and sender bounds hold, and a refusal stores nothing.
- Five rapid requests are five retained items and one notifying group with an exact count that is not the page size; two chains are two groups with two keys, each listed request carries its own chain's key and notification (including one beyond a group's 50 listed ids, and one retained from long ago, which carries none); a pause starts a new group; at most 20 groups notify and the rest are counted; routine mail never joins; a withdrawn opt-in keeps every request and stops notifying. Kill points before and after the commit leave nothing or exactly one request.
- Review fixes: the message text is returned only to a reader that asks for it by name (checked through a real MCP `tools/call` of `list_attention`, which never carries it, against the portal's own view, which does); a worktree's requests are reachable behind any number of newer requests for another worktree, and pages by cursor are gap-free, repeat-free and list the provider events once; a request no session can be tied to stays listed as unresolved and is never guessed at; enabling attention is refused in the write if the sharing was made again after the review (`SCOPE_CHANGED`); a blank request is refused; a request from a withdrawn share can notify again after a new opt-in only while it is inside the 15-minute window; an ended session and a replaced checkout between verification and the focus effect are refused and appear in the persisted operation journal.
- A forged provider hook (native ID and working directory without or with the wrong launch capability) creates no Links item, and no hook payload field reaches the Links engine. A Links entry has no `permission` kind and no `sessionId`, so the existing session focus cannot be taken for it.
- Opening focuses the exact verified terminal of the conversation the request was addressed to. An ended, replaced or moved conversation is reported with no terminal call; a replacement between verification and the effect is refused by the focus guard; an exact reviewed resume under a new record opens there.
- Send now answers `LINKS_WAKE_UNAVAILABLE` over HTTP and the CLI, takes no principal, tool or flag, and makes one engine call, the gate, as the local user. Nothing is launched, typed, admitted or claimed. The engine refuses every other principal before reading a store. Message and request text asking for a wake is stored as text. Source tripwires check that no shipped source types a key or drives System Events, that the terminal paste has one production caller (the review handoff), that no Links module reaches a terminal, and that the generic MCP endpoint offers no wake, send-now, open or raise tool.

### Send now probe (ticket 06): not passed, inconclusive

- Date 18 October 2026. Provider Claude Code 2.1.302 / Sonnet 5.5 (the version of the other evidence here). Terminal Ghostty. Session type: managed was intended and **not established**.
- Observation: **none.** The parent's earlier managed Ghostty launch showed no window or prompt, so the lease is unknown. Computer-use on Ghostty was denied and no other UI route was used. No wake was attempted. A recent headless managed stream probe shows real process and hook delivery only, not an interactive wake and not Ghostty.
- What is known from code, not run: the one exact-target terminal delivery (`deliver`) pastes text and does not submit it, so it is not the prompt-hook path ticket 03 uses; it is the review handoff's paste. A verified, explicitly recipient-authorized trigger of a normal turn, with the hook supplying the mail, is not excluded by the specification and has no evidence yet. The specification excludes pasted terminal text as a delivery transport.
- Result: Send now is **unavailable** (`LINKS_WAKE_UNAVAILABLE`, reason `no-verified-mechanism`); no wake path is enabled and no keystroke or submit path was added. U7 and U8 stay open.
- Limits: one provider and version; nothing observed; cmux development workers are not production evidence.

### Not established, and pending wiring

- A session's own request arriving through the session tools, a peer's request over transport, and the engine's sender-generation fence they need. The engine operation, the service ingress and their tests exist; the ingress has no route, tool or command and is not exported to the portal. Wiring waits for the authenticated tool coordinator and the fence in the same transaction; a check after the store cannot substitute.
- Real Ghostty focus of a managed session (launch unknown), a real Claude session's tool call producing a request, the sender-fence race on the combined engine, and any cross-machine behavior.
- A Links inbox in the portal UI does not exist yet, so there is no Send now control to disable there; the CLI and HTTP say why.
