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
| U1 | The managed prompt path reached real Claude through the generated launcher/settings under an injected subprocess launcher (18 October evidence below). Production Ghostty launch, interactive prompt behavior and native timeout enforcement remain unverified. | 01, 03 |
| U2 | Managed-session binding and per-launch capability authentication survive portal restart and relaunch with a real provider. Rejection of missing, wrong, cross-session, ended and replaced credentials is covered by contract tests. | 01 |
| U3 | Process death in the middle of handoff, and exactly what the provider saw. | 03 |
| U4 | Real-provider effects across a claim or confirmation failure. Engine persistence and claim/confirm transitions are covered by process and crash tests; they do not prove what a provider saw. Setu promises no silent replay, never exactly-once delivery. | 02, 03 |
| U5 | Mid-tool-call, permission-prompt and multi-prompt-race behavior of mail arriving during a turn. | 03 |
| U6 | Two real managed Claude processes on one Git checkout passed exact-recipient delivery/isolation under an injected launcher. Agent-facing request/reply/FYI and the production terminal path remain unverified. | 03, 05 |
| U7 | Provider-supported idle push or any way to start a turn. Receiver-authorized wake is a separate action and is **unproven**. cmux terminal injection is not validated as a production transport. | 06 |
| U8 | Recipient authorization enforcement. | 06 |
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

Not established by these tests (unchanged): U1 (a prompt hook in a **managed** session launched through the real launcher and a real provider, including whether the generated settings and its `timeout` are honored), U3 (what a real provider saw when a process died mid-handoff), U5 (mid-tool-call, permission-prompt and multi-prompt-race), U6 (a real same-branch two-session Git fixture), U10 (Codex) and U16 (live resume: built and contract-tested only). The later managed-provider probe below establishes plain stdout context under an injected launcher, with its own limits; these contract tests alone cannot establish that provider behavior.

## How a ticket clears a gate

A ticket that clears a gate records, in this file, the date, provider and version, session type (native or managed), the scenario, the exact observation, and its limits. It does not edit a limit away. Results from a failed or inconclusive run are recorded as well, with the cause if known.

## Spans execution evidence, 18 October 2026

The local execution service has a production caller, off by default under `spansExecution.enabled`. Independent spec and standards reviews covered it against issue #20; the author ran 1900 JavaScript tests and three typechecks before integration. Those process tests use a local provider fixture. They cover crashes, owner fencing, cancellation, admission, usage and explicit acceptance, but are not native-provider evidence.

One actual Claude Code 2.1.302 / Sonnet 5.5 subscription probe and task used the shipped default command, including restricted mode, no ambient setting sources, auto permission mode and the six named coding tools. No dollar budget flag was passed. The provider did not report effort, which the profile explicitly records as requested but unverified. Token and API-equivalent amounts are provider estimates, not subscription charges.

The real task created `add.mjs` in a disposable Git checkout. The parent independently imported it and checked three arithmetic cases. The build Span remained unaccepted until an explicit owner acceptance; only then did its dependent become ready. The real host had less than the default 20 GiB storage floor, so the successful one-file test used a 10 GiB floor only in its disposable service configuration. Production admission was unchanged.

A separate listening HTTP portal reopened that archive using config-enabled production composition, without an injected execution service, provider, admission or host observation. Capabilities, status and review worked; dispatch correctly returned `ADMISSION_REFUSED` with `admissionCode: STORAGE_LOW`, no launch and exact writer-recovery data. The CLI handler read status over a custom transport to that isolated HTTP port. This is not a full native task through the default-port CLI.

Parent deterministic regressions reproduced and then verified fixes for stale owner acquisition and concurrent resolve/dispatch: recovery refuses the racing dispatch; the next reviewed retry acquires a fresh action identity, writer and usage reservation while retaining the old released ledger row. These used real storage and local fixture processes. Native Ghostty delivery and two-host transport remain separate, open gates. Evidence scripts and synthetic logs are retained outside the repository.

## Managed provider delivery through an injected launcher, 18 October 2026

Real Claude Code 2.1.302 / Sonnet 5.5 ran twice on the same real Git checkout, using subscription authentication, no dollar budget, no tools and no session persistence. The generated launch scripts, private settings, hook programs, managed-session authority, process observation, admission, mailbox engine and HTTP hook route were real. The test substituted a subprocess launcher for Ghostty and used a test-only shell wrapper to select isolated CLI settings and stream input/output. The disposable admission profile used a 10 GiB reserve; the production 20 GiB default was unchanged.

The addressed process saw an unpredictable marker supplied only through its mailbox. The other owned process did not receive that mail, and a subsequent turn did not claim the handed-off message again. Reconstructing the managed and Links services over persisted state, while keeping the provider process alive, still allowed a new message to be delivered. This is service reconstruction, not a portal-process restart. The evidence is `managed-native-stream-probe.json` in the parent's isolated test artifacts.

The first run found that `ps -o lstart=` may contain trailing whitespace, which the generated launcher did not remove. The registration parser correctly refused the unnormalized timestamp. A failing PTY regression reproduced it; trimming both ends in the launcher made 57 launcher/managed-session checks and the live delivery run pass. The parser's identity validation was not relaxed.

Limits: no production Ghostty launch, interactive prompt UI, crash during a real handoff, busy tool/permission turn, cross-record resume, session tools, network peer, or full portal-process restart was exercised. The live run proves the managed prompt path and same-checkout isolation under the injected launcher; it does not clear those other gates. Both provider PIDs were verified absent after cleanup, but their managed records became unknown and retained two admission leases. That session-end/reconciliation behavior remains an open lifecycle issue; the delivery result is not evidence of successful lifecycle cleanup.
