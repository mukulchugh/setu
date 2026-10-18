//! Sending side of the transport. A message for a remote recipient is an ordinary `messages` row (same
//! idempotency, immutability and limits) with an `outbox` row of sender-owned submission state and, on purpose,
//! no `deliveries` row: every local operation joins deliveries, so none of them can ever claim, hold or hand
//! it off locally. What the recipient's engine later reports is stored beside it, never in place of it.

use crate::{
    args::Fail,
    authz,
    mailbox::{self, Recipient},
    store::Store,
    util,
    wire::{self, Locator, Published, Reply},
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

/// How long a sender waits before offering a message to a peer again.
pub fn retry_after_ms() -> i64 {
    util::tick_ms() as i64 * 2
}

pub struct Remote {
    pub key: String,
    pub peer_id: String,
    pub recipient: Recipient,
    pub body: String,
    pub reply_to: Option<String>,
    pub run_hint: Option<String>,
    pub span_hint: Option<String>,
    pub digest: String,
}

/// Accepts a send to a peer: authorized against the roster, a `send` grant and the receiver's own published
/// view of the session, then stored durably before the reply says `queued`.
pub fn send(store: &mut Store, request: Remote) -> Result<Value, Fail> {
    let now = util::now_ms();
    let id = util::new_id("m");
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(String, String)> = tx
        .query_row("SELECT id, payload_digest FROM messages WHERE sender = 'user' AND idempotency_key = ?1", [&request.key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((existing_id, existing_digest)) = existing {
        if existing_digest != request.digest {
            return Err(Fail::new("IDEMPOTENCY_CONFLICT", "this key was used for a different message").with(json!({ "message_id": existing_id })));
        }
        let state = view(&tx, &existing_id, now, false)?.map_or(Value::Null, |v| v["state"].clone());
        return Ok(json!({ "message_id": existing_id, "state": state, "replayed": true }));
    }
    let to = &request.recipient;
    if !authz::on_roster(&tx, &request.peer_id)? {
        return Err(Fail::new("PEER_UNKNOWN", "no such peer"));
    }
    // A peer is addressed by the opaque address it published, never by a local tuple: nothing private is stored here.
    if !(wire::valid_provider(&to.provider) && wire::is_address_part(&to.native_id) && wire::is_address_part(&to.checkout)) {
        return Err(Fail::new("RECIPIENT_ADDRESS_INVALID", "a peer is addressed by the address it published"));
    }
    // The cache is what the receiver itself published; it filters, and the receiver decides again.
    let entry: Option<(String, String, String, String, i64)> = tx
        .query_row(
            "SELECT provider, native_id, checkout, scope, valid_until FROM remote_bindings WHERE peer_id = ?1 AND session_hint = ?2",
            params![request.peer_id, to.session_hint],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let scope = match entry {
        Some((provider, native_id, checkout, scope, valid_until)) if valid_until > now && to.is(&(provider.clone(), native_id.clone(), checkout.clone())) => scope,
        _ => return Err(Fail::new("RECIPIENT_UNBOUND", "that peer has not published this conversation as reachable")),
    };
    if !authz::grant_covers(&tx, &request.peer_id, "send", Some(&scope), &to.session_hint)? {
        return Err(Fail::new("PEER_NOT_AUTHORIZED", "this peer may not be sent to"));
    }
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM outbox o JOIN messages m ON m.id = o.message_id
         WHERE o.peer_id = ?1 AND m.provider = ?2 AND m.native_id = ?3 AND m.checkout = ?4 AND o.expires_at > ?5
           AND (o.outbox_state = 'pending' OR (o.outbox_state = 'deposited' AND o.remote_state IN ('queued', 'held')))",
        params![request.peer_id, to.provider, to.native_id, to.checkout, now],
        |row| row.get(0),
    )?;
    if pending >= mailbox::MAX_PENDING_PER_RECIPIENT {
        return Err(Fail::new("RECIPIENT_QUEUE_FULL", "this conversation already has the most pending messages allowed"));
    }
    tx.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, reply_to, run_hint, span_hint, provider, native_id, checkout, session_hint, created_at)
         VALUES (?1, 'user', ?2, ?3, 'message', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id, request.key, request.digest, request.body, request.body.len() as i64, request.reply_to, request.run_hint, request.span_hint,
            to.provider, to.native_id, to.checkout, to.session_hint, now
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox (message_id, peer_id, outbox_state, expires_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?4)",
        params![id, request.peer_id, now + mailbox::EXPIRY_MS, now],
    )?;
    mailbox::commit(tx, "send")?;
    Ok(json!({ "message_id": id, "state": "queued", "replayed": false }))
}

const COLUMNS: &str = "m.id, m.kind, m.size, m.reply_to, m.run_hint, m.span_hint, m.provider, m.native_id, m.checkout, m.session_hint, m.created_at, m.body,
        o.peer_id, o.outbox_state, o.reason, o.attempts, o.expires_at, o.remote_state, o.remote_reason, o.remote_updated_at, o.cancel_state, o.updated_at";

/// The message as its sender may see it: the best-known recipient state, with the outbox stage kept explicit so
/// `queued` in a sender's outbox is never mistaken for deposited at the recipient.
fn row_json(row: &rusqlite::Row, now: i64, with_body: bool) -> rusqlite::Result<Value> {
    let outbox: String = row.get(13)?;
    let reason: Option<String> = row.get(14)?;
    let expires_at: i64 = row.get(16)?;
    let remote_state: Option<String> = row.get(17)?;
    let remote_reason: Option<String> = row.get(18)?;
    let (state, state_reason) = match outbox.as_str() {
        "pending" if expires_at <= now => ("expired".to_string(), Some("expired".to_string())),
        "pending" => ("queued".to_string(), None),
        "deposited" => (remote_state.clone().unwrap_or_else(|| "queued".into()), remote_reason.clone()),
        "cancelled" => ("cancelled".to_string(), Some("cancelled by sender".to_string())),
        "rejected" => ("rejected".to_string(), reason.clone()),
        _ => ("expired".to_string(), Some("expired".to_string())),
    };
    let mut value = json!({
        "message_id": row.get::<_, String>(0)?,
        "sender": { "kind": "user" },
        "kind": row.get::<_, String>(1)?,
        "size": row.get::<_, i64>(2)?,
        "reply_to": row.get::<_, Option<String>>(3)?,
        "run_hint": row.get::<_, Option<String>>(4)?,
        "span_hint": row.get::<_, Option<String>>(5)?,
        "recipient": {
            "provider": row.get::<_, String>(6)?,
            "native_id": row.get::<_, String>(7)?,
            "checkout": row.get::<_, String>(8)?,
            "session_hint": row.get::<_, String>(9)?,
        },
        "created_at": row.get::<_, i64>(10)?,
        "state": state,
        "reason": state_reason,
        "attempts": 0,
        "redeliveries": 0,
        "attempt_id": Value::Null,
        "expires_at": expires_at,
        "updated_at": row.get::<_, i64>(21)?,
        "transport": {
            "peer_id": row.get::<_, String>(12)?,
            "outbox": outbox,
            "remote_state": remote_state,
            "remote_reason": remote_reason,
            "remote_updated_at": row.get::<_, Option<i64>>(19)?,
            "cancel": row.get::<_, String>(20)?,
            "attempts": row.get::<_, i64>(15)?,
            "last_error": reason,
        },
    });
    if with_body {
        value["body"] = Value::String(row.get(11)?);
    }
    Ok(value)
}

pub fn view(db: &rusqlite::Connection, id: &str, now: i64, with_body: bool) -> rusqlite::Result<Option<Value>> {
    db.query_row(&format!("SELECT {COLUMNS} FROM messages m JOIN outbox o ON o.message_id = m.id WHERE m.id = ?1"), [id], |row| row_json(row, now, with_body)).optional()
}

/// Passive: this machine's outbound messages, newest last, without bodies.
pub fn list(db: &rusqlite::Connection, peer: Option<&str>, now: i64) -> Result<Vec<Value>, Fail> {
    let mut statement = db.prepare(&format!(
        "SELECT {COLUMNS} FROM messages m JOIN outbox o ON o.message_id = m.id WHERE (?1 IS NULL OR o.peer_id = ?1) ORDER BY m.created_at, m.id"
    ))?;
    let rows = statement.query_map([peer], |row| row_json(row, now, false))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The sender's own retraction of an outbound message. Before any attempt to hand it over it is cancelled here,
/// atomically. After one, the recipient's engine must say whether it got there first, and until it does the
/// message is only `requested`, never called cancelled.
pub fn cancel(tx: &Transaction, id: &str, now: i64) -> Result<Option<Value>, Fail> {
    let row: Option<(String, i64, String)> = tx
        .query_row("SELECT outbox_state, attempts, cancel_state FROM outbox WHERE message_id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((state, attempts, cancel)) = row else { return Ok(None) };
    match (state.as_str(), cancel.as_str()) {
        ("cancelled", _) => {}
        ("pending", "none") if attempts == 0 => {
            tx.execute("UPDATE outbox SET outbox_state = 'cancelled', updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
        }
        ("pending" | "deposited", "none") => {
            tx.execute("UPDATE outbox SET cancel_state = 'requested', updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
        }
        (_, "requested" | "confirmed") => {}
        _ => return Err(Fail::new("NOT_CANCELLABLE", "only mail that has not been handed off can be cancelled")),
    }
    Ok(Some(json!({})))
}

pub struct DueDeposit {
    pub message_id: String,
    pub body: String,
    pub reply_to: Option<String>,
    pub run_hint: Option<String>,
    pub span_hint: Option<String>,
    pub recipient: Locator,
}

/// Pending messages for one peer that are due another attempt.
pub fn due_deposits(db: &rusqlite::Connection, peer: &str, now: i64) -> Result<Vec<DueDeposit>, Fail> {
    let mut statement = db.prepare(
        "SELECT m.id, m.body, m.reply_to, m.run_hint, m.span_hint, m.provider, m.native_id, m.checkout, m.session_hint
         FROM outbox o JOIN messages m ON m.id = o.message_id
         WHERE o.peer_id = ?1 AND o.outbox_state = 'pending' AND o.cancel_state = 'none' AND o.expires_at > ?2
           AND m.native_id LIKE 'w1:%' AND length(m.native_id) = 67 AND m.checkout LIKE 'w1:%' AND length(m.checkout) = 67
           AND (o.last_attempt_at IS NULL OR o.last_attempt_at + ?3 <= ?2)
         ORDER BY m.created_at, m.id LIMIT 20",
    )?;
    let rows = statement
        .query_map(params![peer, now, retry_after_ms()], |row| {
            Ok(DueDeposit {
                message_id: row.get(0)?,
                body: row.get(1)?,
                reply_to: row.get(2)?,
                run_hint: row.get(3)?,
                span_hint: row.get(4)?,
                recipient: Locator { provider: row.get(5)?, native_id: row.get(6)?, checkout: row.get(7)?, session_hint: row.get(8)? },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Records, durably and before anything leaves, that an attempt is being made. Returns false if the message is
/// no longer to be sent (cancelled, expired or already settled meanwhile).
pub fn begin_attempt(store: &mut Store, id: &str) -> Result<bool, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE outbox SET attempts = attempts + 1, last_attempt_at = ?2, updated_at = ?2
         WHERE message_id = ?1 AND outbox_state = 'pending' AND cancel_state = 'none' AND expires_at > ?2",
        params![id, now],
    )?;
    if changed == 0 {
        return Ok(false);
    }
    mailbox::commit(tx, "attempt")?;
    Ok(true)
}

/// Applies the recipient's answer to a deposit. A retryable refusal leaves the message pending and says why; a
/// permanent one ends it, visibly.
pub fn apply_deposit_reply(store: &mut Store, id: &str, reply: &Reply) -> Result<(), Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match reply {
        Reply::Deposited { state, reason, seq, .. } => {
            tx.execute(
                "UPDATE outbox SET outbox_state = CASE WHEN outbox_state = 'pending' THEN 'deposited' ELSE outbox_state END,
                    remote_state = ?2, remote_reason = ?3, remote_seq = ?4, remote_updated_at = ?5, updated_at = ?5, reason = NULL
                 WHERE message_id = ?1 AND outbox_state IN ('pending', 'deposited') AND remote_seq <= ?4",
                params![id, state, reason, seq, now],
            )?;
        }
        Reply::Rejected { code, retryable: true, .. } => {
            tx.execute("UPDATE outbox SET reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND outbox_state = 'pending'", params![id, code, now])?;
        }
        Reply::Rejected { code, .. } => {
            tx.execute(
                "UPDATE outbox SET outbox_state = 'rejected', reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND outbox_state = 'pending'",
                params![id, code, now],
            )?;
        }
        _ => return Ok(()),
    }
    mailbox::commit(tx, "ack")?;
    Ok(())
}

pub fn due_cancels(db: &rusqlite::Connection, peer: &str) -> Result<Vec<String>, Fail> {
    let mut statement = db.prepare(
        "SELECT message_id FROM outbox WHERE peer_id = ?1 AND cancel_state = 'requested' AND outbox_state IN ('pending', 'deposited') ORDER BY updated_at, message_id LIMIT 20",
    )?;
    let ids = statement.query_map([peer], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Applies the recipient's answer to a cancel. Only a confirmation makes the message cancelled.
pub fn apply_cancel_result(store: &mut Store, id: &str, reply: &Reply) -> Result<(), Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match reply {
        Reply::CancelResult { result, state, reason } if result == "cancelled" => {
            tx.execute(
                "UPDATE outbox SET outbox_state = 'cancelled', cancel_state = 'confirmed', remote_state = ?2, remote_reason = ?3, remote_updated_at = ?4, updated_at = ?4, reason = NULL
                 WHERE message_id = ?1 AND cancel_state = 'requested'",
                params![id, state, reason, now],
            )?;
        }
        Reply::CancelResult { state, reason, .. } => {
            tx.execute(
                "UPDATE outbox SET outbox_state = 'deposited', cancel_state = 'refused', remote_state = ?2, remote_reason = ?3, remote_updated_at = ?4, updated_at = ?4, reason = NULL
                 WHERE message_id = ?1 AND cancel_state = 'requested'",
                params![id, state, reason, now],
            )?;
        }
        Reply::Rejected { code, retryable: false, .. } => {
            tx.execute(
                "UPDATE outbox SET cancel_state = 'refused', reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND cancel_state = 'requested'",
                params![id, code, now],
            )?;
        }
        // The peer's answer was unusable or it could not answer now: the cancel stays requested, and says why.
        Reply::Rejected { code, retryable: true, .. } => {
            tx.execute("UPDATE outbox SET reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND cancel_state = 'requested'", params![id, code, now])?;
        }
        _ => return Ok(()),
    }
    mailbox::commit(tx, "cancel_apply")?;
    Ok(())
}

/// A receipt from the recipient's engine. It counts only from the peer the message went to, naming the exact
/// recipient it was addressed to, and only if it is newer than what is already known.
pub fn apply_receipt(store: &mut Store, peer: &str, origin_id: &str, digest: &str, state: &str, reason: Option<&str>, seq: i64) -> Reply {
    match try_receipt(store, peer, origin_id, digest, state, reason, seq) {
        Ok(()) => Reply::Ok {},
        Err(fail) => fail.into(),
    }
}

fn try_receipt(store: &mut Store, peer: &str, origin_id: &str, digest: &str, state: &str, reason: Option<&str>, seq: i64) -> Result<(), Fail> {
    if !(wire::valid_state(state) && wire::valid_reason(&reason.map(str::to_string)) && wire::valid_seq(seq)) {
        return Err(Fail::new("REQUEST_INVALID", "the receipt has an invalid field"));
    }
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !authz::on_roster(&tx, peer)? {
        return Err(Fail::new("PEER_NOT_AUTHORIZED", "unknown peer"));
    }
    let row: Option<(String, String, String, String, String, i64, String)> = tx
        .query_row(
            "SELECT o.peer_id, m.provider, m.native_id, m.checkout, m.session_hint, o.remote_seq, o.cancel_state
             FROM outbox o JOIN messages m ON m.id = o.message_id WHERE o.message_id = ?1",
            [origin_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .optional()?;
    let Some((to_peer, provider, native_id, checkout, session_hint, known_seq, cancel)) = row else {
        return Err(Fail::new("MESSAGE_NOT_FOUND", "no such message"));
    };
    // A receipt from a machine the message was not sent to is not about this message.
    if to_peer != peer {
        return Err(Fail::new("MESSAGE_NOT_FOUND", "no such message"));
    }
    if wire::recipient_digest(&Locator { provider, native_id, checkout, session_hint }) != digest {
        return Err(Fail::new("RECEIPT_RECIPIENT_MISMATCH", "the receipt names a different recipient"));
    }
    if seq <= known_seq {
        return Ok(());
    }
    let cancelled = state == "cancelled" && cancel == "requested";
    tx.execute(
        "UPDATE outbox SET outbox_state = CASE WHEN ?6 THEN 'cancelled' WHEN outbox_state = 'pending' THEN 'deposited' ELSE outbox_state END,
            cancel_state = CASE WHEN ?6 THEN 'confirmed' ELSE cancel_state END,
            remote_state = ?2, remote_reason = ?3, remote_seq = ?4, remote_updated_at = ?5, updated_at = ?5
         WHERE message_id = ?1 AND outbox_state IN ('pending', 'deposited')",
        params![origin_id, state, reason, seq, now, cancelled],
    )?;
    mailbox::commit(tx, "receipt")?;
    Ok(())
}

/// Replaces what `peer` has published, each entry good for the shorter of its claim and our own bound, counted by
/// this machine's clock from now. Nothing here extends a lifetime by itself.
pub fn store_published(store: &mut Store, peer: &str, entries: &[Published]) -> Reply {
    let now = util::now_ms();
    let mut run = || -> Result<(), Fail> {
        let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !authz::on_roster(&tx, peer)? {
            return Err(Fail::new("PEER_NOT_AUTHORIZED", "unknown peer"));
        }
        tx.execute("DELETE FROM remote_bindings WHERE peer_id = ?1", [peer])?;
        for entry in entries.iter().take(256) {
            let within = |s: &str, max: usize| !s.is_empty() && s.len() <= max;
            // Only opaque addresses are accepted: a path or a provider id cannot enter this database from the wire.
            if !(within(&entry.session_hint, 128) && wire::valid_provider(&entry.provider) && wire::is_address_part(&entry.native_id) && wire::is_address_part(&entry.checkout) && within(&entry.scope, 128)) {
                return Err(Fail::new("REQUEST_INVALID", "an entry is invalid"));
            }
            tx.execute(
                "INSERT INTO remote_bindings (peer_id, session_hint, provider, native_id, checkout, scope, valid_until) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![peer, entry.session_hint, entry.provider, entry.native_id, entry.checkout, entry.scope, now + entry.ttl_ms.clamp(1, crate::inbound::PUBLISHED_TTL_MS)],
            )?;
        }
        mailbox::commit(tx, "published")
    };
    match run() {
        Ok(()) => Reply::Ok {},
        Err(fail) => fail.into(),
    }
}

/// Persists the expiry of outbound mail that was never handed over, ends (visibly) pending mail that was addressed
/// with a local tuple by an earlier build, and forgets cached peer sessions that expired or are not opaque addresses.
/// Nothing here rewrites or deletes a message: a legacy message stays as it was written and readable, and is simply
/// never sent, because sending it would put a local path or provider id on the wire.
pub fn expire_due(db: &rusqlite::Connection, now: i64) -> Result<usize, Fail> {
    let expired = db.execute("UPDATE outbox SET outbox_state = 'expired', reason = 'expired', updated_at = ?1 WHERE outbox_state = 'pending' AND expires_at <= ?1", [now])?;
    db.execute(
        "UPDATE outbox SET outbox_state = 'rejected', reason = 'LEGACY_PRIVATE_ADDRESS', updated_at = ?1
         WHERE outbox_state = 'pending' AND message_id IN (
            SELECT id FROM messages WHERE NOT (native_id LIKE 'w1:%' AND length(native_id) = 67 AND checkout LIKE 'w1:%' AND length(checkout) = 67))",
        [now],
    )?;
    db.execute(
        "DELETE FROM remote_bindings WHERE valid_until <= ?1 OR NOT (native_id LIKE 'w1:%' AND length(native_id) = 67 AND checkout LIKE 'w1:%' AND length(checkout) = 67)",
        [now],
    )?;
    Ok(expired)
}
