# 05 — Two real sessions exchange a request, a reply and an FYI

**GitHub:** [#12](https://github.com/mukulchugh/setu/issues/12) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 2 · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

An agent in one managed Claude session lists linked sessions in a shared project, sends a request to another session, and that session's agent reads it, replies, and sends an FYI. Each message is attributed to the sender's verified session, replies are tied to the original, and the sender sees honest status for each.

Agent-facing tools get only what they need: `list_linked_sessions`, `send_session_message`, `read_session_messages`. They are served by a session-bound entrypoint started for that managed session, so every call is attributed to the verified session and native conversation. The existing generic local MCP endpoint cannot identify its caller and is not used. Administrative actions such as sharing policy stay out of the agent surface.

Message kinds are request, reply and FYI. A reply references the original message ID. An FYI expects no reply. `read_session_messages` shows the agent its inbox and can acknowledge, which is the only way a message becomes `acknowledged` besides the receiving user. A request is data: it never grants permission to run work or spend usage. Routine text between invited teammates' agents in a shared project needs no per-message approval; files, artifacts and transcripts are not carried.

Claude only, as in ticket 03. How the session-bound entrypoint is attached to a managed launch alongside the existing settings is an open implementation question; verify the provider accepts it for the tested version before building further.

## Acceptance criteria

- [ ] In two managed Claude sessions on the **same branch** in a shared project, session A's agent sends a request; session B receives it at its next turn (ticket 03 path), replies; A receives the reply tied to the request; A sends an FYI. Sender identity is correct on every message. (Live, real provider.)
- [ ] A tool call cannot spoof another session as sender: the session-bound entrypoint authenticates with the retained per-launch capability (ticket 01); a missing, wrong, cross-session, ended or replaced capability is refused, including after a portal restart. A call from an unbound or unshared session is refused with a distinct reason.
- [ ] `list_linked_sessions` returns only shared-project sessions with the shared fields.
- [ ] A reply to a message addressed to a different recipient is refused; a reply to an expired or cancelled message reports it.
- [ ] Acknowledgement by the recipient agent moves the message to `acknowledged`, visible to the sender; handoff alone never does.
- [ ] A message containing instructions does not change any claim, admission or usage state in Setu and does not cause Setu to run work. (This is about Setu's controls; it makes no claim that a model ignores the text.)
- [ ] The tool surface contains none of the administrative operations; a test enumerates it.
- [ ] A send to a session that is not shared, has no verified native binding, or is a Codex session is rejected with a stable code and stores nothing; there is no delivery by fallback.
- [ ] A Codex session is listed with delivery shown as unverified.
- [ ] Results are recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md), including the same-branch fixture (U6).
- [ ] `bun run verify` and Rust tests pass.

## Blocked by

- [#10](https://github.com/mukulchugh/setu/issues/10) (03) — A queued message reaches the exact managed Claude conversation at its next normal turn
- [#11](https://github.com/mukulchugh/setu/issues/11) (04) — Enable a shared project and discover its managed sessions

## Gates

External: whether the provider accepts a session-bound tool entrypoint in a managed launch (to be observed in the first step). If it does not, report; do not substitute the generic endpoint.
