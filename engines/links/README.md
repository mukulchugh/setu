# Setu Links engine

`setu-links` is the one durable mailbox behind `setu links`. It owns every message, every delivery
state and every receipt. Only this program opens its database; the portal and CLI are clients of its
operation protocol. Required licenses and provenance are kept apart, in `legal/`.

## Process model

One short-lived process per operation: a JSON request on standard input, a JSON reply on standard
output, `--data-dir <dir>` for the store. Reasons: it needs no daemon, supervisor or socket in this
local slice; SQLite already serializes concurrent writers; and a crash can only happen between
whole operations. A long-running mode for peer transport can later serve the same protocol over the
same store. Nothing starts on a read: a read of a missing store creates nothing.

Exit code 0 means a reply was written (even `ok: false`). Anything else is a process failure, and a
client treats a mutation without a reply as unknown, never as failed.

## Protocol `setu-links/1`

```
request: {"protocol":"setu-links/1","id":"<client string>","op":"<name>","args":{...}}
reply:   {"protocol":"setu-links/1","id":"<echo>","ok":true,"result":{...}}
       | {"protocol":"setu-links/1","id":"<echo>","ok":false,"error":{"code":"UPPER_SNAKE","message":"...","retryable":false,"details":{}}}
```

`args` must be a JSON object (absent or any other type is `REQUEST_INVALID`, before anything is opened or
changed). Unknown fields are refused (`FIELD_UNSUPPORTED`), so a caller cannot smuggle in behavior such as
a wake flag. Another protocol version is `PROTOCOL_INCOMPATIBLE`, with the versions supported. Error text never
contains message bodies. A request may be at most 1 MiB.

| Operation | Purpose |
| --- | --- |
| `send` | Idempotent. Commits the message, then replies `queued`. Same key and payload returns the same message; same key, different payload is `IDEMPOTENCY_CONFLICT`. |
| `status`, `show`, `list` | Read state, a message with its body, or a session's messages without bodies. Passive: they open an existing store read-only, never create one and never write. An optional `observed` recipient (the trusted service's observation of the session's current conversation and checkout) makes them report the effective state: queued mail for another conversation of that session reads `held`, held mail for exactly the observed conversation reads `queued`. `stored_state` is always what the store holds: mail whose time has passed reads `expired` in `state` but keeps its stored `queued`/`held` until a `sweep` or `claim` persists the expiry. |
| `cancel` | The sender retracts a `queued` or `held` message. |
| `reconcile` | The trusted service's explicit report (made on a send or claim, never by a read) of which conversation (provider, native ID, checkout) a managed session runs now. Queued mail for any other conversation of that session becomes `held`; held mail for exactly this conversation becomes `queued` again. Safe to repeat. It never delivers, re-addresses or revives cancelled, expired or claimed mail. This is the only way a hold or restore is persisted. |
| `sweep` | Persists expiry. Also applied lazily by `claim`; reads report the expiry that has passed. |
| `claim` | Atomically moves the exact conversation's queued mail to a new attempt (`handoff-unknown`) and returns it, framed. A claim for a conversation with no queued mail returns nothing and changes nothing for anyone else; it never holds another conversation's mail. |
| `confirm` | The hook's report for one exact attempt: `handoff-unknown` to `handed-off`. A report for an attempt a redelivery has superseded changes nothing. |
| `acknowledge` | The addressed conversation's user: `handed-off` to `acknowledged`. |
| `redeliver` | Names the message, its current unknown attempt and its recipient, and returns the message to `queued`; the next claim is a new, counted attempt. The engine checks all three but cannot tell whether the receiving user chose this: the service that calls it must have obtained that choice (see AGENTS.md). |
| `health` | Passive: protocol, schema version, and whether a store exists. |

There is deliberately no operation that returns a claimed message to the queue on its own.

`send` and `claim` do not decide holds. The engine is the only mailbox authority and the managed session
record is the only identity authority; `reconcile` is the one explicit, small boundary between them, and
the service calls it with the record's current binding before every send and claim. Reads never call it; they pass the same observation to the read operations instead. With no store, `reconcile` and `claim` return empty results and create nothing; only a `send` creates the store.

`run_hint` and `span_hint` on `send` are optional correlation hints for the planned Spans projection and
request correlation. They are stored with the message, are part of what an idempotency key means, and
never affect delivery. No front door sets them yet.

## States

`queued` (durable, not delivered), `held` (with a reason: `conversation-replaced`, `checkout-changed`),
`handoff-unknown`, `handed-off`, `acknowledged`, `expired`, `cancelled`. A recipient is a provider, a
native conversation and a checkout, captured at send time and immutable (enforced by the schema, not only
by the operations). The managed session ID is a locator hint: it can cause mail to be held, never
delivered. Mail for a replaced conversation stays held and is not re-addressed. It becomes `queued` again only when
`reconcile` reports that exact conversation (and checkout) as the session's, never when a different one
appears.

## Defaults

| Limit | Value | Rationale |
| --- | --- | --- |
| Message body | 16 KiB | Mail enters an agent's context. 16 KiB is several pages of text, and a single message must always fit in one turn. |
| Pending per conversation | 100 | A sender cannot flood one conversation; far more than a person triages. Counts `queued` and `held`. |
| Expiry | 7 days | Old requests should not linger; long enough for a weekend away. Expiry is visible, never a silent delete. |
| Per turn | 8 messages, 32 KiB | Bounds context injected at one turn; remaining mail waits for the next. Fixed: a caller cannot change it. |

They are tunable constants in `src/mailbox.rs`, not product decisions.

## Store

`mailbox.sqlite3` in the data directory (owner-only: directory 0700, file 0600; a directory open to
others is refused). Write-ahead logging, full synchronous writes, foreign keys. `PRAGMA user_version` is
the schema version: a newer store is refused and left untouched. Messages are append-only; delivery state
lives in a separate table. SIGKILL survival is tested; power-loss durability is not claimed.

## Build and test

The toolchain is pinned in `rust-toolchain.toml` (1.99.1) and dependencies in `Cargo.lock`; builds use
`--locked`. Dependencies are fetched from the registry, not vendored: the lock file pins checksums, and
`legal/THIRD-PARTY-LICENSES.md` is the reviewed list (a test fails if it and the lock file differ).

From the repository root, with `SETU_LINKS_CARGO` pointing at the pinned toolchain's cargo when it is
not on `PATH`:

```
bun run engine:build   # release build
bun run engine:test    # tests as shipped, then with the test-only hooks
```

The `test-hooks` feature adds deterministic kill points (`SETU_LINKS_TEST_KILL_AT`) and a settable clock
(`SETU_LINKS_TEST_NOW_MS`) for contract tests. A shipped build contains neither, and a test checks that it
ignores both.
