# Live Claude delivery experiment

17 October 2026. Claude Code 2.1.302; Sonnet 5.5; Claude Max. A new cmux workspace was used for the lab. Synthetic messages only. Tools and MCP disabled in recipient sessions; local explicit UserPromptSubmit hook, no global hook installation. These native sessions were not registered as Setu-managed sessions.

## Observed

| Check | Result |
| --- | --- |
| Two native sessions in one directory | A echoed its unique mailbox nonce on a normal turn; B returned NO_MAIL. Same directory, not a Git branch test. |
| Idle deposit | Depositing A's mailbox left both sessions idle until a normal user turn was submitted. Finite observation, not a universal timing guarantee. |
| Busy deposit | A fresh session was visibly producing numbered output when its mailbox was written. It finished BUSY_DONE without the nonce, stayed idle, then echoed the nonce on the next user turn. |
| Retry without durable receipt | A's retained mailbox was emitted again; hook events show three emissions for one message across initial handoff, retry, and resume. Deduplication cannot be assumed. |
| Process restart/resume | Exiting A and using --resume with its exact native ID preserved identity and hook routing. The hook event, not model memory alone, confirms re-emission. |
| Replacement conversation | A new UUID in B's same terminal and directory returned NO_MAIL despite old B having a queued message. |

Normal user turns were submitted through cmux as test-driver input. The mailbox nonce itself entered through Claude's prompt hook, not terminal text injection. The test does not validate cmux terminal injection as a production transport or implement recipient authorization. Hook output is context-emission evidence. The synthetic exact nonce response is evidence of receipt for this test, not understanding or task completion.

## Implementation consequences

Bind messages to verified native conversation identity, never branch/cwd/pane alone. Keep pending mail durable and expose separate queued, handoff, unknown, and acknowledged states. Claim/emit/receipt transitions need crash tests: do not silently replay an uncertain insertion. Receiver-authorized wake is a separate action, not a side effect of inbox arrival. Preserve existing writer-claim, admission, attention and Spans completion authorities.

## Not established

Production managed-session binding; actual service/CLI/API integration; same-branch Git fixture; cross-machine transport, reconnect and revocation; provider-supported idle push; recipient authorization enforcement; process death in the middle of handoff; engine persistence or exactly-once effects; Codex support. The first Codex harness had a malformed MCP override and produced no acceptance result. Sandboxed headless Claude attempts timed out. Neither failure demonstrates a provider capability limit.

## Evidence

The synthetic harness and logs are retained locally outside this repository. They are not part of it and have no portable path.
- `cmux-sessions.json`: synthetic native IDs.
- `mail_hook.py`, `test-settings.json`: explicit local hook.
- `hook-events.jsonl`: session/message emission events, including a labeled synthetic self-check session.
- `a-resume-screen.txt`: A's receipt, retry, and resume responses.
- `busy-at-deposit.txt`, `busy-deposit.json`, `busy-completed-held.txt`, `busy-next-turn.txt`: busy boundary and next-turn receipt.
- `busy_test.py`: bounded active-output deposit driver.

Assertions checked nonce absence before the next turn, presence afterward, active-output evidence at deposit, and three A hook emissions. Exact routing and replacement responses were inspected live. Test recipient processes were exited; their synthetic persisted conversations remain available for evidence. Specification worker is separate and remains active.
