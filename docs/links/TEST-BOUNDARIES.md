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
| U2 | Managed-session binding and per-launch capability authentication survive portal restart and relaunch as designed, including rejection of missing, wrong, cross-session, ended and replaced credentials. | 01 |
| U3 | Process death in the middle of handoff, and exactly what the provider saw. | 03 |
| U4 | Engine persistence, claim/confirm behavior and any exactly-once effect. (Setu will not promise exactly-once; it promises no silent replay.) | 02, 03 |
| U5 | Mid-tool-call, permission-prompt and multi-prompt-race behavior of mail arriving during a turn. | 03 |
| U6 | Same-branch Git fixture with two managed sessions. | 03, 05 |
| U7 | Provider-supported idle push or any way to start a turn. Receiver-authorized wake is a separate action and is **unproven**. cmux terminal injection is not validated as a production transport. | 06 |
| U8 | Recipient authorization enforcement. | 06 |
| U9 | Cross-machine transport, direct and relay connectivity, reconnect, offline queue, sleep and revocation. | 08, 09 |
| U10 | Codex support. The first Codex harness failed on a configuration mistake and produced no result; sandboxed headless Claude runs timed out. **Neither shows a capability limit.** Codex is **unverified**, not unsupported. | 03, 05, 11 |
| U11 | Other Claude versions, other operating systems, other terminals. | 11 |
| U12 | Real device-to-device behavior of the Rust transport. | 08, 09 |
| U13 | Reproducible Rust build. Toolchain 1.99.1 is verified installed locally in an isolated build-tools directory with no PATH change. No engine source tree exists yet, and CI provisioning and adapting the reused store and transport to the Setu protocol are untested. | 02, 08 |
| U16 | An explicit authenticated resume path for a native conversation under a new or different managed session record. Ticket 01 refuses cross-record adoption; no such resume operation exists or has been run. O5 covers a native session only. | 03 |
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

## How a ticket clears a gate

A ticket that clears a gate records, in this file, the date, provider and version, session type (native or managed), the scenario, the exact observation, and its limits. It does not edit a limit away. Results from a failed or inconclusive run are recorded as well, with the cause if known.

## Spans execution evidence, 18 October 2026

The local execution service has a production caller, off by default under `spansExecution.enabled`. Independent spec and standards reviews covered it against issue #20; the author ran 1900 JavaScript tests and three typechecks before integration. Those process tests use a local provider fixture. They cover crashes, owner fencing, cancellation, admission, usage and explicit acceptance, but are not native-provider evidence.

One actual Claude Code 2.1.302 / Sonnet 5.5 subscription probe and task used the shipped default command, including restricted mode, no ambient setting sources, auto permission mode and the six named coding tools. No dollar budget flag was passed. The provider did not report effort, which the profile explicitly records as requested but unverified. Token and API-equivalent amounts are provider estimates, not subscription charges.

The real task created `add.mjs` in a disposable Git checkout. The parent independently imported it and checked three arithmetic cases. The build Span remained unaccepted until an explicit owner acceptance; only then did its dependent become ready. The real host had less than the default 20 GiB storage floor, so the successful one-file test used a 10 GiB floor only in its disposable service configuration. Production admission was unchanged.

A separate listening HTTP portal reopened that archive using config-enabled production composition, without an injected execution service, provider, admission or host observation. Capabilities, status and review worked; dispatch correctly returned `ADMISSION_REFUSED` with `admissionCode: STORAGE_LOW`, no launch and exact writer-recovery data. The CLI handler read status over a custom transport to that isolated HTTP port. This is not a full native task through the default-port CLI.

Parent deterministic regressions reproduced and then verified fixes for stale owner acquisition and concurrent resolve/dispatch: recovery refuses the racing dispatch; the next reviewed retry acquires a fresh action identity, writer and usage reservation while retaining the old released ledger row. These used real storage and local fixture processes. Native Ghostty delivery and two-host transport remain separate, open gates. Evidence scripts and synthetic logs are retained outside the repository.
