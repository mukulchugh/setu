# 02 — Setu-owned engine: durable local inbox with honest statuses through `setu links`

**GitHub:** [#9](https://github.com/mukulchugh/setu/issues/9) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 1 (local part) · **Release scope:** first public release · **Status:** published, ready-for-agent

## What to build

A user sends a message to one of their managed sessions with `setu links send`, sees it in `setu links inbox`, checks `setu links status`, and cancels it, all against the single durable store of a Setu-owned engine derived from selected reviewed store source. Messages survive engine and portal restarts. Statuses are honest.

This ticket builds the engine, its client, and the claim/confirm operations that ticket 03 drives from the provider hook. It does not wire the provider. A queued message can still be inspected and every state transition is verifiable through the CLI and contract tests.

**Engine source.** Reuse is already authorized; no further approval or decision record is needed. Derive the `setu-links` engine from the selected reviewed store source (durable store, inbox/outbox, operation handling), pinned to a recorded revision and checksum. Bring in only what Setu needs. Rename every first-party surface (package, binary, strings, prompts, config, socket and file names, fixtures, docs) to Setu-native names. Remove inherited login, installer, self-update and unused standalone surfaces. Keep licenses and provenance in separate legal metadata that travels with artifacts; do not mix them into feature names or product docs. Add a naming scan over first-party source with a narrow exception only for the legal metadata. Expose a versioned, Setu-namespaced operation protocol that does not assume a local caller. The first local mode may be one process per operation, as supported by the reused store; record the choice. **There is one mailbox store, the engine's.** Only the engine opens its database; JavaScript never does. Do not create a second mailbox, queue or delivery table anywhere.

**Toolchain.** Rust 1.99.1 is verified installed in an isolated build-tools directory with no shell PATH change. Invoke it explicitly. Record the pinned version in the repository and make a clean checkout build reproducibly in CI. Decide dependency vendoring and review dependency licenses.

**Operations:** send (idempotent), status, list inbox, show, cancel, expire sweep, claim, confirm, acknowledge, redeliver. States and rules are in the spec's Contracts section. Defaults for maximum message size, pending messages per recipient, expiry and per-turn claim size are set here and recorded with a rationale.

**JavaScript side:** a thin client with bounded timeouts and strict response parsing, a Links service composed in the portal, `/api/links/*` routes registered through the route table, dispatch tables and composed service, and `setu links send|inbox|show|status|cancel|ack`. The recipient is chosen by repo, branch and exact session ID, mirroring `setu sessions`. The CLI refuses with PORTAL_REQUIRED when the portal is down. The sender is the local user.

**Recipient identity is immutable and requires a verified binding.** At send time the service reads the managed session record's verified native conversation binding (provider, native ID, checkout identity; managed session ID as a locator hint) and passes it to the engine, which stores it on the message and never rewrites it. **A send to a session with no verified native binding, an ended session, a changed checkout incarnation, or a provider without verified delivery (Codex) is rejected with a stable code and nothing stored.** It is never queued or held to be attached later to some other conversation. Do not infer identity from branch, directory or terminal. The binding itself is produced by ticket 01; until it merges, positive-path tests use session-record fixtures in the exact shape ticket 01 specifies, and real bound sends are verified end to end in ticket 03.

## Acceptance criteria

- [ ] The pinned toolchain builds a clean checkout locally and in CI; the pinned engine-source revision and checksum are recorded; dependency licenses reviewed; licenses and provenance are in separate legal metadata.
- [ ] The naming scan passes over first-party source with only the legal-metadata exception; inherited login, installer and self-update surfaces are absent.
- [ ] `setu links send` returns a message ID and status `queued` only after the engine has durably committed it.
- [ ] Repeating a send with the same idempotency key and payload returns the same message; the same key with a different payload returns a conflict; a lost response retried creates one message.
- [ ] Killing the engine at each point around the commit leaves either no message or exactly one, never a partial one. Restarting the portal and engine keeps all queued messages.
- [ ] Sending to an unknown session, an unbound native conversation, an ended session, a changed checkout incarnation, or a Codex session is rejected with distinct stable codes and stores nothing. A later bind does not attach to or release anything, because nothing was stored.
- [ ] The recipient identity on a stored message cannot be changed by any operation; a test attempts to alter it.
- [ ] Mail queued for conversation X becomes `held: conversation replaced` if the session's binding later moves to a different native ID, and is not delivered to the new one.
- [ ] Oversized messages, a full inbox, and expired messages are rejected or expired with visible reasons.
- [ ] Claim moves queued messages to an attempt atomically; confirm moves them to `handed-off`; a kill at or after claim and before confirm leaves `handoff-unknown`, never `queued`; claim never returns an unknown attempt again; only redeliver creates a new attempt and the count is visible. Contract tests kill the process at each step. A failure before claim leaves messages `queued`.
- [ ] A wrong-recipient claim or acknowledgement fails.
- [ ] Message bodies do not appear in generic logs or error messages.
- [ ] A test or lint rule shows JavaScript never opens the engine's database and no second mailbox store exists.
- [ ] Rust tests, Bun contract tests, CLI/route parity and `bun run verify` pass. New test files are in the package test script and new modules/artifacts in the packaged file list, or packaging is explicitly deferred to ticket 11.

## Blocked by

None — can start immediately.

## Gates

External: reproducible CI toolchain provisioning and dependency licensing (U13). No legal or approval gate.
