//! Mailbox operations over the store. Each mutation is one transaction and replies only after commit.

use crate::{
    args::{Args, Fail},
    frame,
    store::Store,
    util,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub const EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Every mutation ends here, so every one can be killed on either side of its commit.
pub(crate) fn commit(tx: rusqlite::Transaction, op: &str) -> Result<(), Fail> {
    util::fault(&format!("{op}:before-commit"));
    tx.commit()?;
    util::fault(&format!("{op}:after-commit"));
    Ok(())
}

pub struct Recipient {
    pub provider: String,
    pub native_id: String,
    pub checkout: String,
    pub session_hint: String,
}

impl Recipient {
    /// Identity is provider, native conversation and checkout. The session hint only locates.
    pub fn is(&self, (provider, native_id, checkout): &(String, String, String)) -> bool {
        self.provider == *provider && self.native_id == *native_id && self.checkout == *checkout
    }

    /// The address a peer would use for this conversation.
    pub fn wire(&self) -> (String, String) {
        crate::wire::address(&self.provider, &self.native_id, &self.checkout)
    }

    /// Whether a stored recipient is this conversation: the same local tuple, or the wire address of this trusted
    /// local tuple (how mail from a peer is stored). Used wherever mail is matched to a conversation; the generation
    /// fence and snapshots keep the strict `is`.
    pub fn matches_stored(&self, (provider, native_id, checkout): &(String, String, String)) -> bool {
        if self.provider != *provider {
            return false;
        }
        let (wire_native, wire_checkout) = self.wire();
        (self.native_id == *native_id && self.checkout == *checkout) || (wire_native == *native_id && wire_checkout == *checkout)
    }

    pub fn parse(mut args: Args) -> Result<Self, Fail> {
        let recipient = Recipient {
            provider: args.string("provider", 64)?,
            native_id: args.string("native_id", 256)?,
            checkout: args.string("checkout", 4096)?,
            session_hint: args.string("session_hint", 128)?,
        };
        args.finish()?;
        Ok(recipient)
    }
}

/// SQL: is the stored recipient of message alias `m` the conversation `(provider, native, checkout)`? Either the same
/// local tuple or the wire address computed from it, by the one `wire::address` (the SQL functions call it).
/// Arguments are SQL expressions, usually numbered parameters.
pub(crate) fn same_conversation(m: &str, provider: &str, native: &str, checkout: &str) -> String {
    format!(
        "({m}.provider = {provider} AND (({m}.native_id = {native} AND {m}.checkout = {checkout}) \
         OR ({m}.native_id = setu_wire_native({provider}, {native}) AND {m}.checkout = setu_wire_checkout({checkout}))))"
    )
}

/// SQL: the same conversation regardless of checkout (same provider and native conversation, either form).
pub(crate) fn same_native(m: &str, provider: &str, native: &str) -> String {
    format!("({m}.provider = {provider} AND ({m}.native_id = {native} OR {m}.native_id = setu_wire_native({provider}, {native})))")
}

pub const MAX_PENDING_PER_RECIPIENT: i64 = 100;
/// One turn carries at most this many messages and this many body bytes, so mail cannot flood a context.
pub const CLAIM_MAX_MESSAGES: usize = 8;
pub const CLAIM_MAX_BYTES: usize = 32 * 1024;

pub struct SendRequest {
    key: String,
    /// Set when the recipient is on another machine: the message then goes to the outbox, not to a local inbox.
    peer_id: Option<String>,
    recipient: Recipient,
    body: String,
    reply_to: Option<String>,
    run_hint: Option<String>,
    span_hint: Option<String>,
}

/// Validates a send before any store is opened, so a refused request leaves no trace.
pub fn parse_send(mut args: Args) -> Result<SendRequest, Fail> {
    let key = args.string("idempotency_key", 128)?;
    let mut sender = args.object("sender")?;
    let kind = sender.string("kind", 16)?;
    sender.finish()?;
    if kind != "user" {
        return Err(Fail::new("SENDER_UNSUPPORTED", "only the local user can send"));
    }
    let recipient = Recipient::parse(args.object("recipient")?)?;
    let peer_id = args.optional_string("peer_id", 64)?;
    let body = args.bounded("body", MAX_BODY_BYTES, "BODY_TOO_LARGE")?;
    let reply_to = args.optional_string("reply_to", 128)?;
    let run_hint = args.optional_string("run_hint", 128)?;
    let span_hint = args.optional_string("span_hint", 128)?;
    args.finish()?;
    Ok(SendRequest { key, peer_id, recipient, body, reply_to, run_hint, span_hint })
}

pub fn send(store: &mut Store, request: SendRequest) -> Result<Value, Fail> {
    let SendRequest { key, peer_id, recipient, body, reply_to, run_hint, span_hint } = request;

    // The digest covers exactly what the caller supplied, in a canonical key order.
    let mut canonical = json!({
            "body": body,
            "kind": "message",
            "reply_to": reply_to,
            "run_hint": run_hint,
            "span_hint": span_hint,
            "recipient": {
                "checkout": recipient.checkout,
                "native_id": recipient.native_id,
                "provider": recipient.provider,
                "session_hint": recipient.session_hint,
            },
        });
    if let Some(peer) = &peer_id {
        canonical["peer_id"] = json!(peer);
    }
    let digest = util::sha256_hex(&canonical.to_string());
    if let Some(peer_id) = peer_id {
        return crate::outbox::send(store, crate::outbox::Remote { key, peer_id, recipient, body, reply_to, run_hint, span_hint, digest });
    }
    let now = util::now_ms();
    let id = util::new_id("m");
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(String, String)> = tx
        .query_row("SELECT id, payload_digest FROM messages WHERE sender = 'user' AND idempotency_key = ?1", [&key], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    if let Some((existing_id, existing_digest)) = existing {
        if existing_digest != digest {
            return Err(Fail::new("IDEMPOTENCY_CONFLICT", "this key was used for a different message").with(json!({ "message_id": existing_id })));
        }
        let state = view(&tx, &existing_id, now)?;
        return Ok(json!({ "message_id": existing_id, "state": state["state"], "replayed": true }));
    }
    let pending: i64 = tx.query_row(
        &format!(
            "SELECT COUNT(*) FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE {} AND d.state IN ('queued', 'held') AND d.expires_at > ?4",
            same_conversation("m", "?1", "?2", "?3")
        ),
        params![recipient.provider, recipient.native_id, recipient.checkout, now],
        |row| row.get(0),
    )?;
    if pending >= MAX_PENDING_PER_RECIPIENT {
        return Err(Fail::new("RECIPIENT_QUEUE_FULL", "this conversation already has the most pending messages allowed"));
    }
    tx.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, reply_to, run_hint, span_hint, provider, native_id, checkout, session_hint, created_at)
         VALUES (?1, 'user', ?2, ?3, 'message', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![id, key, digest, body, body.len() as i64, reply_to, run_hint, span_hint, recipient.provider, recipient.native_id, recipient.checkout, recipient.session_hint, now],
    )?;
    tx.execute(
        "INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES (?1, 'queued', ?2, ?3)",
        params![id, now + EXPIRY_MS, now],
    )?;
    commit(tx, "send")?;
    Ok(json!({ "message_id": id, "state": "queued", "replayed": false }))
}

const VIEW: &str = "SELECT m.id, m.sender, m.kind, m.size, m.reply_to, m.run_hint, m.span_hint, m.provider, m.native_id, m.checkout,
        m.session_hint, m.created_at, m.body,
        CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.state END,
        CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.reason END,
        d.attempts, d.redeliveries, d.attempt_id, d.expires_at, d.updated_at, d.state
    FROM messages m JOIN deliveries d ON d.message_id = m.id";

/// Who a message is from: the local user, or a peer machine named by its authenticated key.
fn sender_json(sender: &str) -> Value {
    match sender.strip_prefix("peer:") {
        Some(peer_id) => json!({ "kind": "peer", "peer_id": peer_id }),
        None => json!({ "kind": sender }),
    }
}

fn row_json(row: &rusqlite::Row, with_body: bool) -> rusqlite::Result<Value> {
    let mut value = json!({
        "message_id": row.get::<_, String>(0)?,
        "sender": sender_json(&row.get::<_, String>(1)?),
        "kind": row.get::<_, String>(2)?,
        "size": row.get::<_, i64>(3)?,
        "reply_to": row.get::<_, Option<String>>(4)?,
        "run_hint": row.get::<_, Option<String>>(5)?,
        "span_hint": row.get::<_, Option<String>>(6)?,
        "recipient": {
            "provider": row.get::<_, String>(7)?,
            "native_id": row.get::<_, String>(8)?,
            "checkout": row.get::<_, String>(9)?,
            "session_hint": row.get::<_, String>(10)?,
        },
        "created_at": row.get::<_, i64>(11)?,
        "state": row.get::<_, String>(13)?,
        "reason": row.get::<_, Option<String>>(14)?,
        "attempts": row.get::<_, i64>(15)?,
        "redeliveries": row.get::<_, i64>(16)?,
        "attempt_id": row.get::<_, Option<String>>(17)?,
        "expires_at": row.get::<_, i64>(18)?,
        "updated_at": row.get::<_, i64>(19)?,
        "stored_state": row.get::<_, String>(20)?,
    });
    if with_body {
        value["body"] = Value::String(row.get(12)?);
    }
    Ok(value)
}

/// The service's trusted observation of the conversation a session runs now, for reads only.
fn parse_observed(args: &mut Args) -> Result<Option<Recipient>, Fail> {
    args.optional_object("observed")?.map(Recipient::parse).transpose()
}

/// What a read reports given that observation, without writing anything: queued mail for another
/// conversation of the observed session reads as held, and held mail for exactly the observed conversation
/// reads as queued. `stored_state` is the store's own value (set by the view, before expiry or observation).
/// `reconcile` is what persists the same
/// decision; nothing here changes the store.
fn project(value: &mut Value, observed: Option<&Recipient>) {
    value["observed_match"] = Value::Null;
    let Some(observed) = observed else { return };
    let recipient = value["recipient"].clone();
    let text = |field: &str| recipient[field].as_str().unwrap_or_default().to_string();
    let stored = (text("provider"), text("native_id"), text("checkout"));
    // The engine, not a caller, says whether a stored recipient is the observed conversation (either form).
    let same = observed.matches_stored(&stored);
    value["observed_match"] = json!(same);
    if recipient["session_hint"] != observed.session_hint.as_str() {
        return;
    }
    let (wire_native, _) = observed.wire();
    let same_conversation = stored.0 == observed.provider && (stored.1 == observed.native_id || stored.1 == wire_native);
    match value["state"].as_str() {
        Some("queued") if !same => {
            value["state"] = json!("held");
            value["reason"] = json!(if same_conversation { "checkout-changed" } else { "conversation-replaced" });
        }
        // Only a hold that the conversation itself explains is lifted by seeing the conversation again; a hold for
        // revoked authorization or an unshared project is not.
        Some("held") if same && matches!(value["reason"].as_str(), Some("conversation-replaced" | "checkout-changed" | "session-not-running")) => {
            value["state"] = json!("queued");
            value["reason"] = Value::Null;
        }
        _ => {}
    }
}

fn view(db: &rusqlite::Connection, id: &str, now: i64) -> Result<Value, Fail> {
    db.query_row(&format!("{VIEW} WHERE m.id = ?1"), params![id, now], |row| row_json(row, true))
        .optional()?
        .ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))
}

pub fn show(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let id = args.string("message_id", 128)?;
    let observed = parse_observed(&mut args)?;
    args.finish()?;
    let store = store.ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))?;
    let mut value = match view(&store.db, &id, util::now_ms()) {
        Err(fail) if fail.code == "MESSAGE_NOT_FOUND" && store.version >= 3 => outbound(&store.db, &id, true)?,
        other => other?,
    };
    project(&mut value, observed.as_ref());
    Ok(value)
}

/// A message this machine sent to a peer: its state is the sender's view, never a local delivery state.
fn outbound(db: &rusqlite::Connection, id: &str, with_body: bool) -> Result<Value, Fail> {
    let found = crate::outbox::view(db, id, util::now_ms(), with_body)?;
    let mut value = found.ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))?;
    value["stored_state"] = value["state"].clone();
    Ok(value)
}

/// Messages addressed to one managed session (by its locator hint), newest last, without bodies.
pub fn list(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let session = args.string("session_hint", 128)?;
    let state = args.optional_string("state", 32)?;
    let observed = parse_observed(&mut args)?;
    args.finish()?;
    let Some(store) = store else { return Ok(json!({ "messages": [] })) };
    let mut statement = store.db.prepare(&format!("{VIEW} WHERE m.session_hint = ?1 ORDER BY m.created_at, m.id"))?;
    let now = util::now_ms();
    let rows = statement.query_map(params![session, now], |row| row_json(row, false))?;
    let mut messages = Vec::new();
    for row in rows {
        let mut row = row?;
        project(&mut row, observed.as_ref());
        if state.as_deref().is_none_or(|wanted| row["state"] == wanted) {
            messages.push(row);
        }
    }
    Ok(json!({ "messages": messages }))
}

/// Delivery state without the body.
pub fn status(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let id = args.string("message_id", 128)?;
    let observed = parse_observed(&mut args)?;
    args.finish()?;
    let store = store.ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))?;
    let mut value = match view(&store.db, &id, util::now_ms()) {
        Err(fail) if fail.code == "MESSAGE_NOT_FOUND" && store.version >= 3 => outbound(&store.db, &id, false)?,
        other => other?,
    };
    project(&mut value, observed.as_ref());
    value.as_object_mut().map(|fields| fields.remove("body"));
    Ok(value)
}

/// One maintenance pass for the daemon: persist expiry and re-check peer mail against current authorization.
pub fn maintain(store: &mut Store) -> Result<(), Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    expire_due(&tx, now)?;
    crate::outbox::expire_due(&tx, now)?;
    crate::inbound::forget_old_tombstones(&tx, now)?;
    crate::authz::gate_all(&tx, store.version, now)?;
    tx.commit()?;
    Ok(())
}

/// Persists expiry for queued or held mail whose time has passed.
pub fn sweep(store: &mut Store, args: Args) -> Result<Value, Fail> {
    args.finish()?;
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = util::now_ms();
    let expired = expire_due(&tx, now)?;
    crate::outbox::expire_due(&tx, now)?;
    crate::inbound::forget_old_tombstones(&tx, now)?;
    crate::authz::gate_all(&tx, store.version, now)?;
    commit(tx, "sweep")?;
    Ok(json!({ "expired": expired }))
}

/// The trusted service's report of which conversation a managed session runs now. Mail queued for any
/// other conversation (or checkout) of that session is held; held mail for exactly this conversation is
/// queued again. A report only withholds or restores: it never delivers, re-addresses or revives anything
/// that was cancelled, expired or already claimed, and it is the only way a hold is decided.
pub fn parse_reconcile(mut args: Args) -> Result<Recipient, Fail> {
    let recipient = Recipient::parse(args.object("recipient")?)?;
    args.finish()?;
    Ok(recipient)
}

pub fn reconcile(store: &mut Store, current: Recipient) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (held, released) = reconcile_in(&tx, &current, now)?;
    commit(tx, "reconcile")?;
    Ok(json!({ "held": held, "released": released }))
}

/// The hold-and-restore decision for one session, inside the caller's write transaction.
pub fn reconcile_in(tx: &rusqlite::Connection, current: &Recipient, now: i64) -> Result<(Vec<String>, Vec<String>), Fail> {
    let mut hold = tx.prepare(&format!(
        "UPDATE deliveries SET state = 'held', updated_at = ?5,
            reason = CASE WHEN (SELECT {same_native} FROM messages mm WHERE mm.id = message_id)
                          THEN 'checkout-changed' ELSE 'conversation-replaced' END
         WHERE state = 'queued' AND message_id IN (
            SELECT id FROM messages m WHERE m.session_hint = ?1
              AND NOT {same_conversation})
         RETURNING message_id",
        same_native = same_native("mm", "?2", "?3"),
        same_conversation = same_conversation("m", "?2", "?3", "?4"),
    ))?;
    let held = hold
        .query_map(params![current.session_hint, current.provider, current.native_id, current.checkout, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(hold);
    let mut release = tx.prepare(&format!(
        "UPDATE deliveries SET state = 'queued', reason = NULL, updated_at = ?5
         WHERE state = 'held' AND expires_at > ?5 AND reason IN ('conversation-replaced', 'checkout-changed', 'session-not-running')
           AND message_id IN (
            SELECT id FROM messages m WHERE m.session_hint = ?1 AND {})
         RETURNING message_id",
        same_conversation("m", "?2", "?3", "?4")
    ))?;
    let released = release
        .query_map(params![current.session_hint, current.provider, current.native_id, current.checkout, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(release);
    Ok((held, released))
}

fn expire_due(tx: &rusqlite::Connection, now: i64) -> Result<Vec<String>, Fail> {
    let mut statement = tx.prepare("SELECT message_id FROM deliveries WHERE state IN ('queued', 'held') AND expires_at <= ?1 ORDER BY message_id")?;
    let ids = statement.query_map([now], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        tx.execute("UPDATE deliveries SET state = 'expired', reason = 'expired', updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
    }
    Ok(ids)
}

pub struct ClaimRequest {
    recipient: Recipient,
    /// The generation the trusted caller authenticated at. When present the claim is refused unless the session's
    /// snapshot is fresh, valid, this conversation and this generation. Absent keeps the original semantics.
    expected_generation: Option<i64>,
}

impl ClaimRequest {
    pub fn fenced(&self) -> bool {
        self.expected_generation.is_some()
    }
}

pub fn parse_claim(mut args: Args) -> Result<ClaimRequest, Fail> {
    let recipient = Recipient::parse(args.object("recipient")?)?;
    let expected_generation = args.optional_count("expected_generation", 0, crate::binding::MAX_GENERATION, "FIELD_TOO_LARGE")?.map(|g| g as i64);
    args.finish()?;
    Ok(ClaimRequest { recipient, expected_generation })
}

/// Moves queued mail for this exact conversation to a new attempt in one transaction. From the moment of
/// commit the mail is `handoff-unknown`: only a confirming report, never the passage of time, resolves it.
pub fn claim(store: &mut Store, request: ClaimRequest) -> Result<Value, Fail> {
    let ClaimRequest { recipient, expected_generation } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // First of all, before expiry, authorization or any mail is touched: a refusal leaves nothing behind.
    if let Some(generation) = expected_generation {
        crate::binding::require_current(&tx, &recipient, generation, now)?;
    }
    expire_due(&tx, now)?;
    // Mail from a peer is handed off only on evidence that holds right now: roster, grant, snapshot and policy.
    crate::authz::gate_all(&tx, store.version, now)?;
    let mut statement = tx.prepare(&format!(
        "SELECT m.id, m.created_at, m.reply_to, m.body, m.size, d.attempts, m.sender FROM messages m
         JOIN deliveries d ON d.message_id = m.id
         WHERE {} AND d.state = 'queued'
         ORDER BY m.created_at, m.rowid",
        same_conversation("m", "?1", "?2", "?3")
    ))?;
    let queued = statement
        .query_map(params![recipient.provider, recipient.native_id, recipient.checkout], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?, row.get::<_, String>(6)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut taken = Vec::new();
    let mut bytes = 0;
    for message in queued {
        if taken.len() >= CLAIM_MAX_MESSAGES || bytes + message.4 as usize > CLAIM_MAX_BYTES {
            break;
        }
        bytes += message.4 as usize;
        taken.push(message);
    }
    if taken.is_empty() {
        // Expiry decided above still counts.
        commit(tx, "claim")?;
        return Ok(json!({ "attempt_id": null, "messages": [], "text": "" }));
    }
    let attempt = util::new_id("a");
    tx.execute(
        "INSERT INTO attempts (id, provider, native_id, checkout, claimed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![attempt, recipient.provider, recipient.native_id, recipient.checkout, now],
    )?;
    let mut messages = Vec::new();
    for (id, created_at, reply_to, body, _, attempts, sender) in &taken {
        let number = attempts + 1;
        tx.execute(
            "UPDATE deliveries SET state = 'handoff-unknown', reason = 'claimed', attempts = ?2, attempt_id = ?3, updated_at = ?4 WHERE message_id = ?1 AND state = 'queued'",
            params![id, number, attempt, now],
        )?;
        tx.execute("INSERT INTO attempt_messages (attempt_id, message_id, number) VALUES (?1, ?2, ?3)", params![attempt, id, number])?;
        messages.push(json!({ "message_id": id, "sender": sender_json(sender), "created_at": created_at, "reply_to": reply_to, "body": body, "attempt": number }));
    }
    commit(tx, "claim")?;
    let framed: Vec<_> = taken
        .iter()
        .map(|(id, created_at, reply_to, body, _, _, sender)| frame::Framed { id, sender, sent_at: *created_at, reply_to: reply_to.as_deref(), body })
        .collect();
    Ok(json!({ "attempt_id": attempt, "messages": messages, "text": frame::for_agent(&framed) }))
}

pub struct ConfirmRequest {
    attempt_id: String,
    recipient: Recipient,
}

pub fn parse_confirm(mut args: Args) -> Result<ConfirmRequest, Fail> {
    let attempt_id = args.string("attempt_id", 128)?;
    let recipient = Recipient::parse(args.object("recipient")?)?;
    args.finish()?;
    Ok(ConfirmRequest { attempt_id, recipient })
}

/// The hook's report that it wrote the messages of this exact attempt.
pub fn confirm(store: &mut Store, request: ConfirmRequest) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let owner: Option<(String, String, String)> = tx
        .query_row("SELECT provider, native_id, checkout FROM attempts WHERE id = ?1", [&request.attempt_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    let Some(owner) = owner else {
        return Err(Fail::new("ATTEMPT_NOT_FOUND", "no such attempt"));
    };
    if !request.recipient.is(&owner) {
        return Err(Fail::new("RECIPIENT_MISMATCH", "this attempt belongs to a different conversation"));
    }
    let mut statement = tx.prepare(
        "SELECT am.message_id FROM attempt_messages am JOIN deliveries d ON d.message_id = am.message_id
         WHERE am.attempt_id = ?1 AND d.attempt_id = ?1 AND d.state = 'handoff-unknown' ORDER BY am.message_id",
    )?;
    let ids = statement.query_map([&request.attempt_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    for id in &ids {
        tx.execute("UPDATE deliveries SET state = 'handed-off', reason = NULL, updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
    }
    // Messages of this attempt that a later redelivery has moved on from: this report says nothing about them.
    let mut statement = tx.prepare(
        "SELECT am.message_id FROM attempt_messages am JOIN deliveries d ON d.message_id = am.message_id
         WHERE am.attempt_id = ?1 AND (d.attempt_id IS NOT ?1 OR d.state = 'queued') ORDER BY am.message_id",
    )?;
    let superseded = statement.query_map([&request.attempt_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    commit(tx, "confirm")?;
    Ok(json!({ "confirmed": ids, "superseded": superseded }))
}

pub struct AcknowledgeRequest {
    message_id: String,
    recipient: Recipient,
}

pub fn parse_acknowledge(mut args: Args) -> Result<AcknowledgeRequest, Fail> {
    let message_id = args.string("message_id", 128)?;
    let recipient = Recipient::parse(args.object("recipient")?)?;
    args.finish()?;
    Ok(AcknowledgeRequest { message_id, recipient })
}

/// The addressed conversation (or its user) says it handled the message. Handoff alone never implies this.
pub fn acknowledge(store: &mut Store, request: AcknowledgeRequest) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(String, String, String, String)> = tx
        .query_row(
            "SELECT m.provider, m.native_id, m.checkout, d.state FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.id = ?1",
            [&request.message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((provider, native_id, checkout, state)) = row else {
        return Err(Fail::new("MESSAGE_NOT_FOUND", "no such message"));
    };
    if !request.recipient.matches_stored(&(provider, native_id, checkout)) {
        return Err(Fail::new("RECIPIENT_MISMATCH", "this message is addressed to a different conversation"));
    }
    match state.as_str() {
        "acknowledged" => {}
        "handed-off" => {
            tx.execute("UPDATE deliveries SET state = 'acknowledged', updated_at = ?2 WHERE message_id = ?1", params![request.message_id, now])?;
            commit(tx, "acknowledge")?;
        }
        _ => return Err(Fail::new("INVALID_STATE", "only a handed-off message can be acknowledged")),
    }
    Ok(json!({ "message_id": request.message_id, "state": "acknowledged" }))
}

pub struct RedeliverRequest {
    message_id: String,
    attempt_id: String,
    recipient: Recipient,
}

pub fn parse_redeliver(mut args: Args) -> Result<RedeliverRequest, Fail> {
    let message_id = args.string("message_id", 128)?;
    let attempt_id = args.string("attempt_id", 128)?;
    let recipient = Recipient::parse(args.object("recipient")?)?;
    args.finish()?;
    Ok(RedeliverRequest { message_id, attempt_id, recipient })
}

/// The addressed user's explicit choice to accept a possible duplicate. It names the unknown attempt it
/// resolves, returns the message to the queue, and the next claim becomes a new, counted attempt.
pub fn redeliver(store: &mut Store, request: RedeliverRequest) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: Option<(String, String, String, String, Option<String>)> = tx
        .query_row(
            "SELECT m.provider, m.native_id, m.checkout, d.state, d.attempt_id FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.id = ?1",
            [&request.message_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    let Some((provider, native_id, checkout, state, attempt)) = row else {
        return Err(Fail::new("MESSAGE_NOT_FOUND", "no such message"));
    };
    if !request.recipient.matches_stored(&(provider, native_id, checkout)) {
        return Err(Fail::new("RECIPIENT_MISMATCH", "this message is addressed to a different conversation"));
    }
    if state != "handoff-unknown" {
        return Err(Fail::new("INVALID_STATE", "only a message with an unknown handoff can be redelivered"));
    }
    if attempt.as_deref() != Some(request.attempt_id.as_str()) {
        return Err(Fail::new("ATTEMPT_MISMATCH", "that is not the current unknown attempt"));
    }
    tx.execute(
        "UPDATE deliveries SET state = 'queued', reason = 'redelivery requested', redeliveries = redeliveries + 1, updated_at = ?2 WHERE message_id = ?1",
        params![request.message_id, now],
    )?;
    commit(tx, "redeliver")?;
    Ok(json!({ "message_id": request.message_id, "state": "queued" }))
}

pub struct CancelRequest {
    message_id: String,
}

pub fn parse_cancel(mut args: Args) -> Result<CancelRequest, Fail> {
    let message_id = args.string("message_id", 128)?;
    let mut sender = args.object("sender")?;
    let kind = sender.string("kind", 16)?;
    sender.finish()?;
    args.finish()?;
    if kind != "user" {
        return Err(Fail::new("SENDER_UNSUPPORTED", "only the local user can cancel"));
    }
    Ok(CancelRequest { message_id })
}

/// The sender retracts mail that no conversation has been handed.
pub fn cancel(store: &mut Store, request: CancelRequest) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // A message for a peer is retracted through its outbox, which is honest about what is still unknown.
    if crate::outbox::cancel(&tx, &request.message_id, now)?.is_some() {
        commit(tx, "cancel")?;
        let shown = crate::outbox::view(&store.db, &request.message_id, now, false)?.unwrap_or(Value::Null);
        let mut reply = json!({ "message_id": request.message_id, "state": shown["state"] });
        if shown["transport"]["cancel"] == "requested" {
            reply["cancel"] = json!("requested");
        }
        return Ok(reply);
    }
    let row: Option<(String, i64)> = tx
        .query_row("SELECT state, expires_at FROM deliveries WHERE message_id = ?1", [&request.message_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    match row.as_ref().map(|(state, expires_at)| (state.as_str(), *expires_at)) {
        None => return Err(Fail::new("MESSAGE_NOT_FOUND", "no such message")),
        Some(("cancelled", _)) => {}
        Some(("queued" | "held", expires_at)) if expires_at > now => {
            tx.execute(
                "UPDATE deliveries SET state = 'cancelled', reason = 'cancelled by sender', updated_at = ?2 WHERE message_id = ?1",
                params![request.message_id, now],
            )?;
            commit(tx, "cancel")?;
        }
        Some(_) => return Err(Fail::new("NOT_CANCELLABLE", "only mail that has not been handed off can be cancelled")),
    }
    Ok(json!({ "message_id": request.message_id, "state": "cancelled" }))
}
