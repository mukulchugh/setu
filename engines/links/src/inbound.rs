//! Receiving side of the transport: a peer's deposit becomes an ordinary inbox message in the one store, with
//! the recipient-side engine keeping all delivery ownership. The sender's claims (names, sizes, expiry) are
//! never believed; the roster, grants, snapshot and sharing policy decide, and the engine's own limits apply.

use crate::{
    args::Fail,
    authz, frame,
    mailbox::{self, Recipient},
    sharing::{self, Standing},
    store::Store,
    util,
    wire::{self, Locator, Published, Reply},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::json;

/// Deposits accepted from one peer per minute; more are deferred, not dropped.
pub const PEER_RATE_PER_MINUTE: i64 = 60;
/// Messages from one peer waiting in this inbox (queued or held).
pub const PEER_MAX_PENDING: i64 = 200;
/// Cancels for messages that never arrived, remembered per peer so a late deposit is refused. A peer's cancels
/// are rate-limited like its deposits and capped, so the store cannot grow without bound from one roster peer.
pub const PEER_MAX_TOMBSTONES: i64 = 200;
/// A sender retries a deposit for at most seven days; a tombstone outlives that, then is forgotten.
pub const TOMBSTONE_RETENTION_MS: i64 = 8 * 24 * 60 * 60 * 1000;
/// A sender may rely on a published session for at most this long after the frame arrives.
pub const PUBLISHED_TTL_MS: i64 = 2 * 60 * 1000;

pub struct Deposit {
    pub origin_id: String,
    pub recipient: Locator,
    pub body: String,
    pub reply_to: Option<String>,
    pub run_hint: Option<String>,
    pub span_hint: Option<String>,
}

/// The same digest the sender computes for its own idempotency, over exactly what the frame carried.
fn digest(d: &Deposit) -> String {
    util::sha256_hex(
        &json!({
            "body": d.body,
            "kind": "message",
            "reply_to": d.reply_to,
            "run_hint": d.run_hint,
            "span_hint": d.span_hint,
            "recipient": {
                "checkout": d.recipient.checkout,
                "native_id": d.recipient.native_id,
                "provider": d.recipient.provider,
                "session_hint": d.recipient.session_hint,
            },
        })
        .to_string(),
    )
}

/// A message id as senders mint them: a short plain token. Nothing else is remembered, searched or stored.
pub fn valid_origin(origin: &str) -> bool {
    (1..=128).contains(&origin.len()) && origin.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Frame fields are bounded the same way a local send's are.
fn check_shape(d: &Deposit) -> Result<(), Fail> {
    let within = |s: &str, max: usize| !s.is_empty() && s.len() <= max;
    let optional = |s: &Option<String>| s.as_deref().is_none_or(|s| within(s, 128));
    // A peer addresses a conversation only by the opaque address it was given; a path or a provider id in those
    // fields is refused, so nothing private can be stored from the wire.
    if !(valid_origin(&d.origin_id)
        && wire::valid_provider(&d.recipient.provider)
        && wire::is_address_part(&d.recipient.native_id)
        && wire::is_address_part(&d.recipient.checkout)
        && within(&d.recipient.session_hint, 128)
        && optional(&d.reply_to)
        && optional(&d.run_hint)
        && optional(&d.span_hint))
    {
        return Err(Fail::new("REQUEST_INVALID", "the deposit has an invalid field"));
    }
    if d.body.is_empty() {
        return Err(Fail::new("REQUEST_INVALID", "the deposit has an invalid field"));
    }
    if d.body.len() > mailbox::MAX_BODY_BYTES {
        return Err(Fail::new("BODY_TOO_LARGE", "the message is too large"));
    }
    Ok(())
}

fn current(tx: &rusqlite::Connection, message_id: &str, now: i64) -> rusqlite::Result<(String, Option<String>, i64)> {
    tx.query_row(
        "SELECT CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.state END,
                CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.reason END, i.state_seq
         FROM deliveries d JOIN inbound i ON i.message_id = d.message_id WHERE d.message_id = ?1",
        params![message_id, now],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
}

/// One peer deposit, decided and stored in one transaction. Rejections write nothing.
pub fn deposit(store: &mut Store, peer: &str, request: Deposit) -> Reply {
    match try_deposit(store, peer, request) {
        Ok(reply) => reply,
        Err(fail) => fail.into(),
    }
}

fn try_deposit(store: &mut Store, peer: &str, request: Deposit) -> Result<Reply, Fail> {
    check_shape(&request)?;
    let now = util::now_ms();
    let version = store.version;
    let digest = digest(&request);
    let sender = format!("peer:{peer}");
    let to: Recipient = request.recipient.clone().into();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !authz::on_roster(&tx, peer)? {
        return Err(Fail::new("PEER_NOT_AUTHORIZED", "this peer may not send to that session"));
    }
    let cancelled: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM cancel_tombstones WHERE peer_id = ?1 AND origin_id = ?2)", params![peer, request.origin_id], |row| row.get(0))?;
    if cancelled {
        return Err(Fail::new("CANCELLED", "the sender cancelled this message"));
    }
    let existing: Option<(String, String)> = tx
        .query_row("SELECT id, payload_digest FROM messages WHERE sender = ?1 AND idempotency_key = ?2", params![sender, request.origin_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((id, stored_digest)) = existing {
        if stored_digest != digest {
            return Err(Fail::new("IDEMPOTENCY_CONFLICT", "this key was used for a different message"));
        }
        let (state, reason, seq) = current(&tx, &id, now)?;
        return Ok(Reply::Deposited { state, reason, seq, replayed: true });
    }
    let admit = authz::admit_receive(&tx, version, now, peer, &to.session_hint)?;
    // The mail names a wire address; it is for this session's conversation only if the address of the session's own
    // trusted tuple is exactly that one.
    let (current_native, current_checkout) = admit.current.wire();
    let exact = admit.current.provider == to.provider && current_native == to.native_id && current_checkout == to.checkout;
    // The policy and snapshot just consulted name the project; the message carries it so a later withdrawal can hold it.
    let project: Option<String> = tx
        .query_row("SELECT project FROM binding_snapshots WHERE session_hint = ?1", [&to.session_hint], |row| row.get(0))
        .optional()?
        .flatten();
    let recent: i64 = tx.query_row("SELECT COUNT(*) FROM inbound WHERE peer_id = ?1 AND created_at > ?2", params![peer, now - 60_000], |row| row.get(0))?;
    if recent >= PEER_RATE_PER_MINUTE {
        return Ok(Reply::Busy { retry_after_ms: 5_000 });
    }
    let waiting: i64 = tx.query_row(
        "SELECT COUNT(*) FROM inbound i JOIN deliveries d ON d.message_id = i.message_id WHERE i.peer_id = ?1 AND d.state IN ('queued', 'held') AND d.expires_at > ?2",
        params![peer, now],
        |row| row.get(0),
    )?;
    if waiting >= PEER_MAX_PENDING {
        return Err(Fail::new("PEER_QUEUE_FULL", "this peer already has the most pending messages allowed").retryable());
    }
    // Every message for this conversation counts, whichever form it was stored in.
    let (c_provider, c_native, c_checkout) = if exact { (&admit.current.provider, &admit.current.native_id, &admit.current.checkout) } else { (&to.provider, &to.native_id, &to.checkout) };
    let pending: i64 = tx.query_row(
        &format!(
            "SELECT COUNT(*) FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE {} AND d.state IN ('queued', 'held') AND d.expires_at > ?4",
            mailbox::same_conversation("m", "?1", "?2", "?3")
        ),
        params![c_provider, c_native, c_checkout, now],
        |row| row.get(0),
    )?;
    if pending >= mailbox::MAX_PENDING_PER_RECIPIENT {
        return Err(Fail::new("RECIPIENT_QUEUE_FULL", "this conversation already has the most pending messages allowed").retryable());
    }
    let id = util::new_id("m");
    // The exact text the agent would see must fit one turn of provider output, metadata included: the same bound a
    // local send is held to, applied before anything from the wire is stored.
    let framed = frame::Framed { id: &id, sender: &sender, sent_at: now, reply_to: request.reply_to.as_deref(), body: &request.body };
    if !frame::fits(&[framed]) {
        return Err(Fail::new("FRAME_TOO_LARGE", "this message, with its metadata, does not fit one turn of provider output"));
    }
    // The receiver's own clock and limits decide the lifetime; whatever the sender claims about it is ignored.
    let (state, reason) = if exact { ("queued", None) } else { ("held", Some("conversation-replaced")) };
    tx.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, reply_to, run_hint, span_hint, provider, native_id, checkout, session_hint, created_at, project)
         VALUES (?1, ?2, ?3, ?4, 'message', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id, sender, request.origin_id, digest, request.body, request.body.len() as i64, request.reply_to, request.run_hint, request.span_hint,
            to.provider, to.native_id, to.checkout, to.session_hint, now, project
        ],
    )?;
    tx.execute(
        "INSERT INTO deliveries (message_id, state, reason, expires_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, state, reason, now + mailbox::EXPIRY_MS, now],
    )?;
    tx.execute(
        "INSERT INTO inbound (message_id, peer_id, origin_id, recipient_digest, state_seq, reported_seq, created_at) VALUES (?1, ?2, ?3, ?4, 1, 1, ?5)",
        params![id, peer, request.origin_id, wire::recipient_digest(&request.recipient), now],
    )?;
    crate::store::commit(tx, "deposit")?;
    Ok(Reply::Deposited { state: state.to_string(), reason: reason.map(str::to_string), seq: 1, replayed: false })
}

/// A peer's cancel of its own message, decided against the store in one transaction, so a claim and a cancel
/// cannot both win: whichever commits first decides, and the other sees the outcome.
pub fn cancel(store: &mut Store, peer: &str, origin_id: &str) -> Reply {
    match try_cancel(store, peer, origin_id) {
        Ok(reply) => reply,
        Err(fail) => fail.into(),
    }
}

fn try_cancel(store: &mut Store, peer: &str, origin_id: &str) -> Result<Reply, Fail> {
    if !valid_origin(origin_id) {
        return Err(Fail::new("REQUEST_INVALID", "the cancel names an invalid message"));
    }
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !authz::on_roster(&tx, peer)? {
        return Err(Fail::new("PEER_NOT_AUTHORIZED", "this peer may not send to that session"));
    }
    let found: Option<String> = tx
        .query_row("SELECT message_id FROM inbound WHERE peer_id = ?1 AND origin_id = ?2", params![peer, origin_id], |row| row.get(0))
        .optional()?;
    let Some(id) = found else {
        // Never seen: remember the cancel so a deposit that is still on its way is refused. Remembering costs
        // space, so it is for peers that may send here at all, at a bounded rate and count; when it cannot be
        // recorded the answer says so, and nothing claims a cancel that was not kept.
        let known: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM cancel_tombstones WHERE peer_id = ?1 AND origin_id = ?2)", params![peer, origin_id], |row| row.get(0))?;
        if !known {
            let granted: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM peer_grants WHERE peer_id = ?1 AND capability = 'receive')", [peer], |row| row.get(0))?;
            if !granted {
                return Err(Fail::new("PEER_NOT_AUTHORIZED", "this peer may not send to that session"));
            }
            let recent: i64 = tx.query_row("SELECT COUNT(*) FROM cancel_tombstones WHERE peer_id = ?1 AND created_at > ?2", params![peer, now - 60_000], |row| row.get(0))?;
            if recent >= PEER_RATE_PER_MINUTE {
                return Ok(Reply::Busy { retry_after_ms: 5_000 });
            }
            let held: i64 = tx.query_row("SELECT COUNT(*) FROM cancel_tombstones WHERE peer_id = ?1", [peer], |row| row.get(0))?;
            if held >= PEER_MAX_TOMBSTONES {
                return Err(Fail::new("TOMBSTONE_LIMIT", "too many cancels for messages that have not arrived").retryable());
            }
        }
        tx.execute("INSERT OR IGNORE INTO cancel_tombstones (peer_id, origin_id, created_at) VALUES (?1, ?2, ?3)", params![peer, origin_id, now])?;
        crate::store::commit(tx, "cancel")?;
        return Ok(Reply::CancelResult { result: "cancelled".into(), state: "cancelled".into(), reason: Some("cancelled before arrival".into()) });
    };
    let (state, reason, _) = current(&tx, &id, now)?;
    let reply = match state.as_str() {
        "cancelled" => Reply::CancelResult { result: "cancelled".into(), state, reason },
        "queued" | "held" => {
            tx.execute("UPDATE deliveries SET state = 'cancelled', reason = 'cancelled by sender', updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
            crate::store::commit(tx, "cancel")?;
            return Ok(Reply::CancelResult { result: "cancelled".into(), state: "cancelled".into(), reason: Some("cancelled by sender".into()) });
        }
        // Already claimed, handed off, acknowledged or expired: the truth is reported and nothing changes.
        _ => Reply::CancelResult { result: "refused".into(), state, reason },
    };
    Ok(reply)
}

pub struct DueReceipt {
    pub message_id: String,
    pub origin_id: String,
    pub recipient_digest: String,
    pub state: String,
    pub reason: Option<String>,
    pub seq: i64,
}

/// Receipts the peer has not yet been told: derived from the inbox itself, so nothing else is kept.
pub fn due_receipts(db: &rusqlite::Connection, peer: &str, now: i64) -> Result<Vec<DueReceipt>, Fail> {
    let mut statement = db.prepare(
        "SELECT i.message_id, i.origin_id, i.recipient_digest, i.state_seq,
                CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.state END,
                CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.reason END
         FROM inbound i JOIN deliveries d ON d.message_id = i.message_id
         WHERE i.peer_id = ?1 AND i.state_seq > i.reported_seq ORDER BY i.created_at, i.message_id LIMIT 50",
    )?;
    let rows = statement
        .query_map(params![peer, now], |row| {
            Ok(DueReceipt { message_id: row.get(0)?, origin_id: row.get(1)?, recipient_digest: row.get(2)?, seq: row.get(3)?, state: row.get(4)?, reason: row.get(5)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Records that the peer took the receipt for `seq`; a later state change makes a newer one due.
pub fn mark_reported(store: &mut Store, message_id: &str, seq: i64) -> Result<(), Fail> {
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("UPDATE inbound SET reported_seq = MAX(reported_seq, ?2) WHERE message_id = ?1", params![message_id, seq])?;
    crate::store::commit(tx, "reported")?;
    Ok(())
}

/// The sessions this machine lets `peer` see: fresh snapshots in a shared project, covered by a `visible` grant.
pub fn published_for(db: &rusqlite::Connection, version: i64, now: i64, peer: &str) -> Result<Vec<Published>, Fail> {
    let mut statement = db.prepare(
        "SELECT session_hint, provider, native_id, checkout, project, valid_until FROM binding_snapshots
         WHERE state = 'valid' AND valid_until > ?1 AND project IS NOT NULL ORDER BY session_hint LIMIT 256",
    )?;
    let rows = statement
        .query_map([now], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut entries = Vec::new();
    for (session_hint, provider, native_id, checkout, project, valid_until) in rows {
        let Standing::Valid(policy, _) = sharing::standing(db, version, &project)? else { continue };
        if !policy.visibility || !authz::grant_covers(db, peer, "visible", Some(&policy.scope), &session_hint)? {
            continue;
        }
        // The local provider id and checkout stay here; a peer is given the opaque address of each.
        let (native_id, checkout) = wire::address(&provider, &native_id, &checkout);
        entries.push(Published { session_hint, provider, native_id, checkout, scope: policy.scope, ttl_ms: (valid_until - now).clamp(1, PUBLISHED_TTL_MS) });
    }
    Ok(entries)
}

/// Cancels older than the longest retry window are forgotten; a derived memory, never mail.
pub fn forget_old_tombstones(db: &rusqlite::Connection, now: i64) -> Result<usize, Fail> {
    Ok(db.execute("DELETE FROM cancel_tombstones WHERE created_at < ?1", [now - TOMBSTONE_RETENTION_MS])?)
}
