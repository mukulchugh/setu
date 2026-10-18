//! Mailbox operations over the store. Each mutation is one transaction and replies only after commit.

use crate::{
    args::{Args, Fail},
    frame, sharing,
    store::{SHARING_SCHEMA, Store, commit},
    util,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

/// A body this large, framed with the worst-case metadata, is still one whole turn of provider output
/// (`frame::MAX_FRAME_BYTES`). Mail stored under the earlier 16 KiB rule may be larger; see `claim`.
pub const MAX_BODY_BYTES: usize = 8 * 1024;
pub const EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

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

pub const MAX_PENDING_PER_RECIPIENT: i64 = 100;
/// One turn carries at most this many messages, and their serialized text at most `frame::MAX_FRAME_BYTES`,
/// so mail cannot flood a context and nothing is claimed that the provider would cut off.
pub const CLAIM_MAX_MESSAGES: usize = 8;

/// Mail larger than a turn can carry whole. Both the read projection and `claim` use this one rule (claim
/// also checks the exact serialized frame), so a plain read and the persisted hold always agree.
fn over_body_cap(size: i64) -> bool {
    size > MAX_BODY_BYTES as i64
}

/// Why mail that can never fit one turn is held rather than claimed.
pub const OUTPUT_LIMIT: &str = "provider-output-limit";

/// The trusted caller of a send, as the engine's client states it. The engine's protocol is local, so this
/// is not something message text can establish: a front door sets it from what it authenticated. A peer is
/// not a principal here; it becomes one only when peer grants exist.
#[derive(Clone, Debug, PartialEq)]
pub enum Principal {
    User,
    Session(String),
}

impl Principal {
    /// One column value: `user`, or `session:<id>`. Ids never contain `:`, so it decodes without ambiguity.
    pub(crate) fn encode(&self) -> String {
        match self {
            Principal::User => "user".to_string(),
            Principal::Session(id) => format!("session:{id}"),
        }
    }

    pub fn is_local_user(&self) -> bool {
        *self == Principal::User
    }

    pub(crate) fn parse(mut args: Args) -> Result<Self, Fail> {
        let kind = args.string("kind", 16)?;
        let principal = match kind.as_str() {
            "user" => Principal::User,
            "session" => {
                let id = args.string("id", 128)?;
                if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    return Err(Fail::new("REQUEST_INVALID", "field `id` is missing or invalid"));
                }
                Principal::Session(id)
            }
            _ => return Err(Fail::new("SENDER_UNSUPPORTED", "this kind of sender is not supported")),
        };
        args.finish()?;
        Ok(principal)
    }
}

/// `user` or `session:<id>` as a public sender object.
fn sender_json(encoded: &str) -> Value {
    match encoded.split_once(':') {
        Some((kind, id)) => json!({ "kind": kind, "id": id }),
        None => json!({ "kind": encoded }),
    }
}

pub struct SendRequest {
    sender: Principal,
    project: String,
    key: String,
    recipient: Recipient,
    body: String,
    reply_to: Option<String>,
    run_hint: Option<String>,
    span_hint: Option<String>,
}

/// Validates a send before any store is opened, so a refused request leaves no trace.
pub fn parse_send(mut args: Args) -> Result<SendRequest, Fail> {
    let key = args.string("idempotency_key", 128)?;
    let sender = Principal::parse(args.object("sender")?)?;
    let project = sharing::project_arg(&mut args)?;
    let recipient = Recipient::parse(args.object("recipient")?)?;
    let body = args.bounded("body", MAX_BODY_BYTES, "BODY_TOO_LARGE")?;
    let reply_to = args.optional_string("reply_to", 128)?;
    let run_hint = args.optional_string("run_hint", 128)?;
    let span_hint = args.optional_string("span_hint", 128)?;
    args.finish()?;
    Ok(SendRequest { sender, project, key, recipient, body, reply_to, run_hint, span_hint })
}

impl SendRequest {
    /// Whether the project's sharing policy has any say: the local user's own mail never depends on it.
    pub fn needs_policy(&self) -> bool {
        !self.sender.is_local_user()
    }

    pub fn project(&self) -> &str {
        &self.project
    }
}

/// Mail from a principal other than the local user is admitted only by a readable policy that lets the
/// project receive. Anything else (no policy, withdrawn, unreadable) refuses, so no failure opens access.
pub fn admit(db: &rusqlite::Connection, version: i64, project: &str) -> Result<(), Fail> {
    match sharing::standing(db, version, project)? {
        sharing::Standing::Valid(policy, _) if policy.receive => Ok(()),
        sharing::Standing::Invalid(reason) => Err(sharing::invalid_policy(project, reason)),
        _ => Err(sharing::not_shared(project)),
    }
}

pub fn send(store: &mut Store, request: SendRequest) -> Result<Value, Fail> {
    let SendRequest { sender, project, key, recipient, body, reply_to, run_hint, span_hint } = request;
    let sender_column = sender.encode();

    // The digest covers exactly what the caller supplied, in a canonical key order. Schema 1 did not know
    // projects, so its digests lack the field; `legacy_digest` is that same computation for replaying a row
    // that old.
    let digest_of = |with_project: bool| {
        let mut payload = json!({
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
        if with_project {
            payload["project"] = json!(project);
        }
        util::sha256_hex(&payload.to_string())
    };
    let digest = digest_of(true);
    let legacy_digest = digest_of(false);
    let now = util::now_ms();
    let id = util::new_id("m");
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !sender.is_local_user() {
        admit(&tx, store.version, &project)?;
    }
    let existing: Option<(String, String, Option<String>)> = tx
        .query_row("SELECT id, payload_digest, project FROM messages WHERE sender = ?2 AND idempotency_key = ?1", params![key, sender_column], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()?;
    if let Some((existing_id, existing_digest, existing_project)) = existing {
        // A row written before projects existed has no project and its original digest. The same send
        // retried after the upgrade is that message; anything that differs still conflicts, and the row
        // itself is never rewritten.
        let same = existing_digest == digest || (existing_project.is_none() && existing_digest == legacy_digest);
        if !same {
            return Err(Fail::new("IDEMPOTENCY_CONFLICT", "this key was used for a different message").with(json!({ "message_id": existing_id })));
        }
        let state = view(&tx, store.version, &existing_id, now)?;
        return Ok(json!({ "message_id": existing_id, "state": state["state"], "replayed": true }));
    }
    let pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM messages m JOIN deliveries d ON d.message_id = m.id
         WHERE m.provider = ?1 AND m.native_id = ?2 AND m.checkout = ?3
           AND d.state IN ('queued', 'held') AND d.expires_at > ?4",
        params![recipient.provider, recipient.native_id, recipient.checkout, now],
        |row| row.get(0),
    )?;
    if pending >= MAX_PENDING_PER_RECIPIENT {
        return Err(Fail::new("RECIPIENT_QUEUE_FULL", "this conversation already has the most pending messages allowed"));
    }
    // The exact text the agent would see must fit one turn, metadata included. Refused before anything is stored.
    let framed = frame::Framed { id: &id, sender: &sender_column, sent_at: now, reply_to: reply_to.as_deref(), body: &body };
    if !frame::fits(&[framed]) {
        return Err(Fail::new("FRAME_TOO_LARGE", "this message, with its metadata, does not fit one turn of provider output")
            .with(json!({ "limit_bytes": frame::MAX_FRAME_BYTES })));
    }
    tx.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, reply_to, run_hint, span_hint, provider, native_id, checkout, session_hint, created_at, project)
         VALUES (?1, ?14, ?2, ?3, 'message', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?15)",
        params![id, key, digest, body, body.len() as i64, reply_to, run_hint, span_hint, recipient.provider, recipient.native_id, recipient.checkout, recipient.session_hint, now, sender_column, project],
    )?;
    tx.execute(
        "INSERT INTO deliveries (message_id, state, expires_at, updated_at) VALUES (?1, 'queued', ?2, ?3)",
        params![id, now + EXPIRY_MS, now],
    )?;
    commit(tx, "send")?;
    Ok(json!({ "message_id": id, "state": "queued", "replayed": false }))
}

const VIEW_SQL: &str = "SELECT m.id, m.sender, m.kind, m.size, m.reply_to, m.run_hint, m.span_hint, m.provider, m.native_id, m.checkout,
        m.session_hint, m.created_at, m.body,
        CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.state END,
        CASE WHEN d.state IN ('queued', 'held') AND d.expires_at <= ?2 THEN 'expired' ELSE d.reason END,
        d.attempts, d.redeliveries, d.attempt_id, d.expires_at, d.updated_at, d.state, m.project, COALESCE(d.locator, m.session_hint)
    FROM messages m JOIN deliveries d ON d.message_id = m.id";

/// Schema 1 has no project column; its messages read as having none.
fn view_sql(version: i64) -> String {
    if version < SHARING_SCHEMA { VIEW_SQL.replace("m.project", "NULL").replace("COALESCE(d.locator, m.session_hint)", "m.session_hint") } else { VIEW_SQL.to_string() }
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
        "project": row.get::<_, Option<String>>(21)?,
        "locator": row.get::<_, String>(22)?,
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
    // Mail larger than a turn can carry is held whatever else is known; `claim` persists the same decision.
    if value["state"] == "queued" && value["size"].as_i64().is_some_and(over_body_cap) {
        value["state"] = json!("held");
        value["reason"] = json!(OUTPUT_LIMIT);
        return;
    }
    let Some(observed) = observed else { return };
    let recipient = value["recipient"].clone();
    if value["locator"] != observed.session_hint.as_str() {
        return;
    }
    let same_conversation = recipient["provider"] == observed.provider.as_str() && recipient["native_id"] == observed.native_id.as_str();
    let same = same_conversation && recipient["checkout"] == observed.checkout.as_str();
    match value["state"].as_str() {
        Some("queued") if !same => {
            value["state"] = json!("held");
            value["reason"] = json!(if same_conversation { "checkout-changed" } else { "conversation-replaced" });
        }
        Some("held") if same && matches!(value["reason"].as_str(), Some("conversation-replaced" | "checkout-changed")) => {
            value["state"] = json!("queued");
            value["reason"] = Value::Null;
        }
        _ => {}
    }
}

/// Mail from another principal that its project no longer admits reads as held. `cache` remembers each
/// project's answer for one read. This only reports; `claim` and withdrawal are what persist the hold.
fn project_policy(store: &Store, value: &mut Value, cache: &mut std::collections::HashMap<String, Option<&'static str>>) -> Result<(), Fail> {
    if value["state"] != "queued" || value["sender"]["kind"] == "user" {
        return Ok(());
    }
    let Some(project) = value["project"].as_str().map(str::to_string) else { return Ok(()) };
    if !cache.contains_key(&project) {
        let verdict = admit(&store.db, store.version, &project).err().map(|fail| sharing::hold_reason(&fail));
        cache.insert(project.clone(), verdict);
    }
    if let Some(reason) = cache[&project] {
        value["state"] = json!("held");
        value["reason"] = json!(reason);
    }
    Ok(())
}

fn view(db: &rusqlite::Connection, version: i64, id: &str, now: i64) -> Result<Value, Fail> {
    db.query_row(&format!("{} WHERE m.id = ?1", view_sql(version)), params![id, now], |row| row_json(row, true))
        .optional()?
        .ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))
}

pub fn show(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let id = args.string("message_id", 128)?;
    let observed = parse_observed(&mut args)?;
    args.finish()?;
    let store = store.ok_or_else(|| Fail::new("MESSAGE_NOT_FOUND", "no such message"))?;
    let mut value = view(&store.db, store.version, &id, util::now_ms())?;
    project(&mut value, observed.as_ref());
    project_policy(store, &mut value, &mut Default::default())?;
    Ok(value)
}

/// Messages addressed to one managed session (by its locator hint), newest last, without bodies.
pub fn list(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let session = args.string("session_hint", 128)?;
    let state = args.optional_string("state", 32)?;
    let observed = parse_observed(&mut args)?;
    args.finish()?;
    let Some(store) = store else { return Ok(json!({ "messages": [] })) };
    let found = if store.version >= 2 { "(m.session_hint = ?1 OR d.locator = ?1)" } else { "m.session_hint = ?1" };
    let mut statement = store.db.prepare(&format!("{} WHERE {found} ORDER BY m.created_at, m.id", view_sql(store.version)))?;
    let now = util::now_ms();
    let rows = statement.query_map(params![session, now], |row| row_json(row, false))?;
    let mut messages = Vec::new();
    let mut cache = Default::default();
    for row in rows {
        let mut row = row?;
        project(&mut row, observed.as_ref());
        project_policy(store, &mut row, &mut cache)?;
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
    let mut value = view(&store.db, store.version, &id, util::now_ms())?;
    project(&mut value, observed.as_ref());
    project_policy(store, &mut value, &mut Default::default())?;
    value.as_object_mut().map(|fields| fields.remove("body"));
    Ok(value)
}

/// Persists expiry for queued or held mail whose time has passed.
pub fn sweep(store: &mut Store, args: Args) -> Result<Value, Fail> {
    args.finish()?;
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let expired = expire_due(&tx, util::now_ms())?;
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
    let mut hold = tx.prepare(
        "UPDATE deliveries SET state = 'held', updated_at = ?5,
            reason = CASE WHEN (SELECT provider = ?2 AND native_id = ?3 FROM messages WHERE id = message_id)
                          THEN 'checkout-changed' ELSE 'conversation-replaced' END
         WHERE state = 'queued' AND message_id IN (
            SELECT m.id FROM messages m JOIN deliveries l ON l.message_id = m.id
             WHERE COALESCE(l.locator, m.session_hint) = ?1
              AND NOT (m.provider = ?2 AND m.native_id = ?3 AND m.checkout = ?4))
         RETURNING message_id",
    )?;
    let held = hold
        .query_map(params![current.session_hint, current.provider, current.native_id, current.checkout, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(hold);
    let mut release = tx.prepare(
        "UPDATE deliveries SET state = 'queued', reason = NULL, updated_at = ?5
         WHERE state = 'held' AND reason IN ('conversation-replaced', 'checkout-changed') AND expires_at > ?5 AND message_id IN (
            SELECT m.id FROM messages m JOIN deliveries l ON l.message_id = m.id
             WHERE COALESCE(l.locator, m.session_hint) = ?1
              AND m.provider = ?2 AND m.native_id = ?3 AND m.checkout = ?4)
         RETURNING message_id",
    )?;
    let released = release
        .query_map(params![current.session_hint, current.provider, current.native_id, current.checkout, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(release);
    commit(tx, "reconcile")?;
    Ok(json!({ "held": held, "released": released }))
}

/// Hold reasons that returning the exact conversation resolves. Any other reason is a different decision
/// and a resume never lifts it.
const RESUME_RELEASES: &str = "conversation-replaced";
const MAX_RESUME_FROM: usize = 8;

pub struct ResumeRequest {
    current: Recipient,
    from: Vec<String>,
}

pub fn parse_resume(mut args: Args) -> Result<ResumeRequest, Fail> {
    let current = Recipient::parse(args.object("recipient")?)?;
    let from = args.string_list("from", MAX_RESUME_FROM, 128)?;
    args.finish()?;
    Ok(ResumeRequest { current, from })
}

/// The trusted service's report that a verified, explicitly reviewed resume brought this exact conversation
/// (provider, native conversation and checkout) back under a new managed record. Mail already addressed to
/// that tuple and located at one of the named earlier records is now located at the new one. The recipient
/// stored on the message is never rewritten, and no state changes except that mail held because the
/// conversation was replaced is queued again. Repeating it changes nothing.
pub fn resume(store: &mut Store, request: ResumeRequest) -> Result<Value, Fail> {
    let ResumeRequest { current, from } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut moved = Vec::new();
    let mut released = Vec::new();
    {
        let mut find = tx.prepare(
            "SELECT m.id, d.state, d.reason, d.expires_at FROM messages m JOIN deliveries d ON d.message_id = m.id
             WHERE m.provider = ?1 AND m.native_id = ?2 AND m.checkout = ?3
               AND COALESCE(d.locator, m.session_hint) = ?4 AND ?4 != ?5
             ORDER BY m.created_at, m.id",
        )?;
        for hint in &from {
            let rows = find
                .query_map(params![current.provider, current.native_id, current.checkout, hint, current.session_hint], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, i64>(3)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, state, reason, expires_at) in rows {
                let release = state == "held" && expires_at > now && reason.as_deref() == Some(RESUME_RELEASES);
                // One statement for both outcomes: the mail is located at the new record, and a hold this
                // resume resolves is lifted. Any other state or reason is left exactly as it was.
                tx.execute(
                    "UPDATE deliveries SET locator = ?2,
                        state = CASE WHEN ?4 THEN 'queued' ELSE state END,
                        reason = CASE WHEN ?4 THEN NULL ELSE reason END,
                        updated_at = CASE WHEN ?4 THEN ?3 ELSE updated_at END
                     WHERE message_id = ?1",
                    params![id, current.session_hint, now, release],
                )?;
                if release {
                    released.push(id.clone());
                }
                moved.push(id);
            }
        }
    }
    commit(tx, "resume")?;
    Ok(json!({ "moved": moved, "released": released }))
}

fn expire_due(tx: &rusqlite::Connection, now: i64) -> Result<Vec<String>, Fail> {
    let mut statement = tx.prepare("SELECT message_id FROM deliveries WHERE state IN ('queued', 'held') AND expires_at <= ?1 ORDER BY message_id")?;
    let ids = statement.query_map([now], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        tx.execute("UPDATE deliveries SET state = 'expired', reason = 'expired', updated_at = ?2 WHERE message_id = ?1", params![id, now])?;
    }
    Ok(ids)
}

/// A queued row as claim reads it: id, created_at, reply_to, body, body size, attempts so far, sender, project.
type Queued = (String, i64, Option<String>, String, i64, i64, String, Option<String>);

fn framed(rows: &[Queued]) -> Vec<frame::Framed<'_>> {
    rows.iter().map(|(id, created_at, reply_to, body, _, _, sender, _)| frame::Framed { id, sender, sent_at: *created_at, reply_to: reply_to.as_deref(), body }).collect()
}

pub struct ClaimRequest {
    recipient: Recipient,
}

pub fn parse_claim(mut args: Args) -> Result<ClaimRequest, Fail> {
    let recipient = Recipient::parse(args.object("recipient")?)?;
    args.finish()?;
    Ok(ClaimRequest { recipient })
}

/// Moves queued mail for this exact conversation to a new attempt in one transaction. From the moment of
/// commit the mail is `handoff-unknown`: only a confirming report, never the passage of time, resolves it.
pub fn claim(store: &mut Store, request: ClaimRequest) -> Result<Value, Fail> {
    let ClaimRequest { recipient } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    expire_due(&tx, now)?;
    let mut statement = tx.prepare(
        "SELECT m.id, m.created_at, m.reply_to, m.body, m.size, d.attempts, m.sender, m.project FROM messages m
         JOIN deliveries d ON d.message_id = m.id
         WHERE m.provider = ?1 AND m.native_id = ?2 AND m.checkout = ?3 AND d.state = 'queued'
         ORDER BY m.created_at, m.rowid",
    )?;
    let candidates = statement
        .query_map(params![recipient.provider, recipient.native_id, recipient.checkout], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    // Mail from any principal but the local user needs its project's policy at claim time, checked here
    // from the store whatever any earlier operation did. What it no longer admits is held, in this
    // transaction, and never claimed.
    let mut queued = Vec::new();
    for candidate in candidates {
        let verdict = if candidate.6 == "user" { Ok(()) } else { admit(&tx, store.version, candidate.7.as_deref().unwrap_or("")) };
        match verdict {
            Ok(()) => queued.push(candidate),
            Err(fail) => {
                tx.execute("UPDATE deliveries SET state = 'held', reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND state = 'queued'", params![candidate.0, sharing::hold_reason(&fail), now])?;
            }
        }
    }
    // Mail that can never fit one turn is not claimed and not attempted: it is held, with the reason, and
    // stays readable in full. That is only mail stored under the earlier, larger body cap (a new send is
    // refused up front), and the exact serialized frame decides, not the body size alone.
    let (too_big, queued): (Vec<_>, Vec<_>) = queued.into_iter().partition(|(id, created_at, reply_to, body, size, _, sender, _)| {
        over_body_cap(*size) || !frame::fits(&[frame::Framed { id, sender, sent_at: *created_at, reply_to: reply_to.as_deref(), body }])
    });
    for (id, ..) in &too_big {
        tx.execute(
            "UPDATE deliveries SET state = 'held', reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND state = 'queued'",
            params![id, OUTPUT_LIMIT, now],
        )?;
    }
    // The rest go in order, whole, while the serialized text of the batch still fits one turn. The first
    // message that does not fit waits for the next turn; nothing is ever cut to make room.
    let mut taken: Vec<Queued> = Vec::new();
    for message in queued {
        taken.push(message);
        if taken.len() > CLAIM_MAX_MESSAGES || !frame::fits(&framed(&taken)) {
            taken.pop();
            break;
        }
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
    for (id, created_at, reply_to, body, _, attempts, sender, _) in &taken {
        let number = attempts + 1;
        tx.execute(
            "UPDATE deliveries SET state = 'handoff-unknown', reason = 'claimed', attempts = ?2, attempt_id = ?3, updated_at = ?4 WHERE message_id = ?1 AND state = 'queued'",
            params![id, number, attempt, now],
        )?;
        tx.execute("INSERT INTO attempt_messages (attempt_id, message_id, number) VALUES (?1, ?2, ?3)", params![attempt, id, number])?;
        messages.push(json!({ "message_id": id, "sender": sender_json(sender), "created_at": created_at, "reply_to": reply_to, "body": body, "attempt": number }));
    }
    commit(tx, "claim")?;
    Ok(json!({ "attempt_id": attempt, "messages": messages, "text": frame::for_agent(&framed(&taken)) }))
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
    if !request.recipient.is(&(provider, native_id, checkout)) {
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
    if !request.recipient.is(&(provider, native_id, checkout)) {
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
