//! Attention requests and the wake gate. An attention request asks the receiving person to look at a session;
//! it is not mail. It never reaches an agent's context, starts no turn and grants no permission, and wake
//! belongs to the receiving user alone.

use crate::{
    args::{Args, Fail},
    mailbox::{Principal, Recipient},
    sharing,
    store::{SHARING_SCHEMA, Store, commit},
    util,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::HashMap;

/// An attention request is a short note, not a conversation. Tunable defaults, not product decisions.
pub const MAX_BODY_BYTES: usize = 1024;
/// Requests from one sender to one conversation closer together than this form one notification group.
pub const GROUP_GAP_MS: i64 = 5 * 60 * 1000;
/// A group notifies while its newest request is no older than this.
pub const NOTIFY_WINDOW_MS: i64 = 15 * 60 * 1000;
/// At most this many groups notify at once; the rest are only counted.
pub const MAX_NOTIFYING_GROUPS: usize = 20;
/// The span over which rate is counted and notification groups are built.
pub const RATE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
pub const PER_SENDER_LIMIT: i64 = 200;
pub const PER_RECIPIENT_LIMIT: i64 = 1000;
pub const MAX_GROUP_ITEMS: usize = 50;
pub const DEFAULT_PAGE: i64 = 50;
pub const MAX_PAGE: i64 = 100;

/// The only caller that may ask for a wake is the local user, stated exactly as `{kind: "user"}`. Anything
/// else (a session, a peer, a malformed or missing principal) is refused before any store is read, so a
/// refusal is the same for every message and tells such a caller nothing.
fn authorize_wake(args: &mut Args) -> Result<(), Fail> {
    let not_authorized = || Fail::new("WAKE_NOT_AUTHORIZED", "only the receiving user can ask for a wake");
    let mut principal = args.object("principal").map_err(|_| not_authorized())?;
    let kind = principal.string("kind", 16).map_err(|_| not_authorized())?;
    principal.finish().map_err(|_| not_authorized())?;
    if kind == "user" { Ok(()) } else { Err(not_authorized()) }
}

/// Send now. No supported mechanism has been shown to start a turn in an idle managed session exactly, so
/// there is nothing to authorize: the local user is told so, and nothing is read or written. This stays the
/// only place the rule lives; a mechanism, if one is ever proven, is added behind this gate and never beside it.
pub fn wake(mut args: Args) -> Result<serde_json::Value, Fail> {
    authorize_wake(&mut args)?;
    args.string("message_id", 128)?;
    args.finish()?;
    Err(Fail::new("WAKE_UNAVAILABLE", "no supported mechanism can start a turn in an idle session; the message is handed over at the session's next normal turn")
        .with(json!({ "reason": "no-verified-mechanism" })))
}

/// Mail, or text that may be shown to a person, must not hide or reorder what the person reads.
fn is_displayable(text: &str) -> bool {
    text.chars().all(|c| {
        let hidden = matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
        !hidden && (!c.is_control() || c == '\n' || c == '\t')
    })
}

/// Raising attention needs a readable policy that the user opted in to attention. Anything else (no policy,
/// withdrawn, unreadable, attention off) refuses, so no failure opens access.
pub fn admit(db: &rusqlite::Connection, version: i64, project: &str) -> Result<(), Fail> {
    match sharing::standing(db, version, project)? {
        sharing::Standing::Valid(policy, _) if policy.attention => Ok(()),
        sharing::Standing::Valid(..) => Err(Fail::new("ATTENTION_NOT_ENABLED", "this project has not opted in to attention requests").with(json!({ "project": project }))),
        sharing::Standing::Invalid(reason) => Err(sharing::invalid_policy(project, reason)),
        sharing::Standing::Absent => Err(sharing::not_shared(project)),
    }
}

pub struct SendRequest {
    sender: Principal,
    project: String,
    key: String,
    recipient: Recipient,
    body: String,
}

impl SendRequest {
    pub fn project(&self) -> &str {
        &self.project
    }
}

/// Validates a request before any store is opened. The trusted service names the sender; text cannot.
pub fn parse_send(mut args: Args) -> Result<SendRequest, Fail> {
    let key = args.string("idempotency_key", 128)?;
    let sender = Principal::parse(args.object("sender")?)?;
    if !matches!(sender, Principal::Session(_)) {
        return Err(Fail::new("SENDER_UNSUPPORTED", "only a session can raise an attention request"));
    }
    let project = sharing::project_arg(&mut args)?;
    let recipient = Recipient::parse(args.object("recipient")?)?;
    let body = args.bounded("body", MAX_BODY_BYTES, "ATTENTION_TOO_LARGE")?;
    if body.trim().is_empty() || !is_displayable(&body) {
        return Err(Fail::new("ATTENTION_BODY_INVALID", "field `body` must be plain text without control or direction characters"));
    }
    args.finish()?;
    Ok(SendRequest { sender, project, key, recipient, body })
}

pub fn send(store: &mut Store, request: SendRequest) -> Result<Value, Fail> {
    let SendRequest { sender, project, key, recipient, body } = request;
    let sender_column = sender.encode();
    let digest = util::sha256_hex(
        &json!({
            "body": body,
            "kind": "attention",
            "project": project,
            "recipient": {
                "checkout": recipient.checkout,
                "native_id": recipient.native_id,
                "provider": recipient.provider,
                "session_hint": recipient.session_hint,
            },
        })
        .to_string(),
    );
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    admit(&tx, store.version, &project)?;
    let existing: Option<(String, String)> = tx
        .query_row("SELECT id, payload_digest FROM messages WHERE sender = ?1 AND idempotency_key = ?2", params![sender_column, key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((existing_id, existing_digest)) = existing {
        if existing_digest != digest {
            return Err(Fail::new("IDEMPOTENCY_CONFLICT", "this key was used for a different message").with(json!({ "message_id": existing_id })));
        }
        return Ok(json!({ "attention_id": existing_id, "replayed": true }));
    }
    // Bounded so a hostile sender cannot grow history without limit. A refused request is not retained, and
    // the sender is told.
    let since = now - RATE_WINDOW_MS;
    let from_sender: i64 = tx.query_row(
        "SELECT COUNT(*) FROM messages WHERE kind = 'attention' AND sender = ?1 AND provider = ?2 AND native_id = ?3 AND checkout = ?4 AND created_at > ?5",
        params![sender_column, recipient.provider, recipient.native_id, recipient.checkout, since],
        |row| row.get(0),
    )?;
    let to_recipient: i64 = tx.query_row(
        "SELECT COUNT(*) FROM messages WHERE kind = 'attention' AND provider = ?1 AND native_id = ?2 AND checkout = ?3 AND created_at > ?4",
        params![recipient.provider, recipient.native_id, recipient.checkout, since],
        |row| row.get(0),
    )?;
    if from_sender >= PER_SENDER_LIMIT || to_recipient >= PER_RECIPIENT_LIMIT {
        return Err(Fail::new("ATTENTION_RATE_LIMITED", "too many attention requests for this conversation recently").with(json!({ "window_ms": RATE_WINDOW_MS })));
    }
    let id = util::new_id("att");
    tx.execute(
        "INSERT INTO messages (id, sender, idempotency_key, payload_digest, kind, body, size, reply_to, run_hint, span_hint, provider, native_id, checkout, session_hint, created_at, project)
         VALUES (?1, ?2, ?3, ?4, 'attention', ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![id, sender_column, key, digest, body, body.len() as i64, recipient.provider, recipient.native_id, recipient.checkout, recipient.session_hint, now, project],
    )?;
    commit(tx, "attention_send")?;
    Ok(json!({ "attention_id": id, "replayed": false }))
}

struct Row {
    id: String,
    rowid: i64,
    sender: String,
    project: Option<String>,
    provider: String,
    native_id: String,
    checkout: String,
    session_hint: String,
    body: String,
    created_at: i64,
}

const COLUMNS: &str = "id, rowid, sender, project, provider, native_id, checkout, session_hint, body, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        rowid: r.get(1)?,
        sender: r.get(2)?,
        project: r.get(3)?,
        provider: r.get(4)?,
        native_id: r.get(5)?,
        checkout: r.get(6)?,
        session_hint: r.get(7)?,
        body: r.get(8)?,
        created_at: r.get(9)?,
    })
}

fn sender_id(sender: &str) -> &str {
    sender.strip_prefix("session:").unwrap_or(sender)
}

/// The (sender, recipient conversation) that repeated requests are grouped by.
fn conversation_key(row: &Row) -> String {
    format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", row.sender, row.provider, row.native_id, row.checkout)
}

/// One opaque key per chain: the conversation plus the chain's first request, so two chains of one sender
/// and conversation, separated by a pause, are two groups.
fn chain_key(conversation: &str, first_id: &str) -> String {
    util::sha256_hex(&format!("{conversation}\u{1f}{first_id}"))[..24].to_string()
}

/// Whether the project still lets requests notify, remembered per project for one read.
struct Admission<'a> {
    store: &'a Store,
    known: HashMap<String, bool>,
}

impl Admission<'_> {
    fn allows(&mut self, project: Option<&str>) -> bool {
        let project = project.unwrap_or("").to_string();
        *self.known.entry(project.clone()).or_insert_with(|| admit(&self.store.db, self.store.version, &project).is_ok())
    }
}

fn item(row: &Row, admitted: bool) -> Value {
    json!({
        "attention_id": row.id,
        "sender": { "kind": "session", "id": sender_id(&row.sender) },
        "project": row.project,
        "recipient": {
            "provider": row.provider,
            "native_id": row.native_id,
            "checkout": row.checkout,
            "session_hint": row.session_hint,
        },
        "body": row.body,
        "created_at": row.created_at,
        "admitted": admitted,
    })
}

/// A listed request also says which counted chain it belongs to (none when it is older than the window) and
/// whether that chain is one of the groups shown as notifying.
fn listed_item(row: &Row, admitted: bool, chains: &HashMap<String, (String, bool)>) -> Value {
    let mut value = item(row, admitted);
    let chain = chains.get(&row.id);
    value["group_key"] = json!(chain.map(|c| c.0.as_str()));
    value["notifying"] = json!(chain.is_some_and(|c| c.1));
    value
}

/// A store before the sharing schema has no attention requests (and no `project` column to read).
fn readable(store: Option<&Store>) -> Option<&Store> {
    store.filter(|store| store.version >= SHARING_SCHEMA)
}

fn find(store: &Store, id: &str) -> Result<Option<Row>, Fail> {
    Ok(store.db.query_row(&format!("SELECT {COLUMNS} FROM messages WHERE kind = 'attention' AND id = ?1"), [id], row).optional()?)
}

pub fn show(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let id = args.string("attention_id", 128)?;
    args.finish()?;
    let not_found = || Fail::new("ATTENTION_NOT_FOUND", "no such attention request");
    let store = readable(store).ok_or_else(not_found)?;
    let found = find(store, &id)?.ok_or_else(not_found)?;
    let mut admission = Admission { store, known: HashMap::new() };
    let admitted = admission.allows(found.project.as_deref());
    Ok(item(&found, admitted))
}

/// The sessions a read is limited to, as the caller's JSON array: at least one non-empty id. There is no count
/// cap of its own; the request protocol's size bound is the limit, and it refuses rather than cuts.
fn session_hints(value: Option<Value>) -> Result<Option<String>, Fail> {
    let invalid = || Fail::new("REQUEST_INVALID", "field `session_hints` is missing or invalid");
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) if !items.is_empty() => {
            if items.iter().all(|item| item.as_str().is_some_and(|hint| !hint.is_empty() && hint.len() <= 128)) {
                Ok(Some(Value::Array(items).to_string()))
            } else {
                Err(invalid())
            }
        }
        Some(_) => Err(invalid()),
    }
}

/// Retained requests, newest first, paged by a cursor that names a request (so new arrivals never shift a
/// page), and the notification view over the same rows. The notification view is built from every request
/// in the window, never from the page, so its counts are not page-limited.
pub fn list(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let sessions = session_hints(args.take("session_hints"))?;
    let limit = match args.optional_u64("limit")? {
        None => DEFAULT_PAGE,
        Some(limit) if (1..=MAX_PAGE).contains(&limit) => limit,
        Some(_) => return Err(Fail::new("REQUEST_INVALID", "field `limit` is missing or invalid")),
    };
    let before = args.optional_string("before_id", 128)?;
    args.finish()?;
    let empty = || json!({ "items": [], "has_more": false, "next_before": null, "notifications": { "groups": [], "suppressed": 0 } });
    let Some(store) = readable(store) else {
        return match before {
            Some(_) => Err(Fail::new("ATTENTION_NOT_FOUND", "no such attention request")),
            None => Ok(empty()),
        };
    };
    let cursor = match &before {
        Some(id) => Some(find(store, id)?.ok_or_else(|| Fail::new("ATTENTION_NOT_FOUND", "no such attention request"))?),
        None => None,
    };
    let mut admission = Admission { store, known: HashMap::new() };
    let mut statement = store.db.prepare(&format!(
        "SELECT {COLUMNS} FROM messages
         WHERE kind = 'attention' AND (?1 IS NULL OR session_hint IN (SELECT value FROM json_each(?1)))
           AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
         ORDER BY created_at DESC, rowid DESC LIMIT ?4"
    ))?;
    let mut rows = statement
        .query_map(params![sessions, cursor.as_ref().map(|c| c.created_at), cursor.as_ref().map_or(0, |c| c.rowid), limit + 1], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let next_before = if has_more { rows.last().map(|last| last.id.clone()) } else { None };
    let (notifications, chains) = notifications(store, sessions.as_deref(), &mut admission)?;
    let page: Vec<Value> = rows.iter().map(|r| listed_item(r, admission.allows(r.project.as_deref()), &chains)).collect();
    Ok(json!({ "items": page, "has_more": has_more, "next_before": next_before, "notifications": notifications }))
}

struct Group {
    key: String,
    first_at: i64,
    last_at: i64,
    count: usize,
    ids: Vec<String>,
    latest: usize,
}

/// Groups of repeated requests that still notify, built from every retained request in the window, and, for
/// each of those requests, the chain it belongs to and whether that chain is shown as notifying. Retention is
/// untouched: grouping only decides how many notifications a person sees. A request older than the window is
/// in no chain.
fn notifications(store: &Store, sessions: Option<&str>, admission: &mut Admission) -> Result<(Value, HashMap<String, (String, bool)>), Fail> {
    let now = util::now_ms();
    let scan_from = now - RATE_WINDOW_MS;
    let mut statement = store.db.prepare(&format!(
        "SELECT {COLUMNS} FROM messages WHERE kind = 'attention' AND (?1 IS NULL OR session_hint IN (SELECT value FROM json_each(?1))) AND created_at > ?2 ORDER BY created_at, rowid"
    ))?;
    let rows = statement.query_map(params![sessions, scan_from], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut open: HashMap<String, Group> = HashMap::new();
    let mut chains: Vec<Group> = Vec::new();
    for (index, request) in rows.iter().enumerate() {
        let conversation = conversation_key(request);
        if let Some(group) = open.get_mut(&conversation) {
            if request.created_at - group.last_at <= GROUP_GAP_MS {
                group.last_at = request.created_at;
                group.count += 1;
                group.ids.push(request.id.clone());
                group.latest = index;
                continue;
            }
            chains.push(open.remove(&conversation).expect("group exists"));
        }
        let key = chain_key(&conversation, &request.id);
        open.insert(conversation, Group { key, first_at: request.created_at, last_at: request.created_at, count: 1, ids: vec![request.id.clone()], latest: index });
    }
    chains.extend(open.into_values());
    let (mut notifying, quiet): (Vec<Group>, Vec<Group>) =
        chains.into_iter().partition(|group| now - group.last_at <= NOTIFY_WINDOW_MS && admission.allows(rows[group.latest].project.as_deref()));
    notifying.sort_by(|a, b| b.last_at.cmp(&a.last_at).then(b.latest.cmp(&a.latest)));
    let suppressed = notifying.len().saturating_sub(MAX_NOTIFYING_GROUPS);
    let mut membership: HashMap<String, (String, bool)> = HashMap::new();
    for (position, group) in notifying.iter().enumerate() {
        for id in &group.ids {
            membership.insert(id.clone(), (group.key.clone(), position < MAX_NOTIFYING_GROUPS));
        }
    }
    for group in &quiet {
        for id in &group.ids {
            membership.insert(id.clone(), (group.key.clone(), false));
        }
    }
    let mut groups = Vec::new();
    for group in notifying.into_iter().take(MAX_NOTIFYING_GROUPS) {
        let newest = &rows[group.latest];
        // A chain that starts at the edge of what was scanned may continue before it; say so rather than
        // present the count as the total.
        let may_continue = group.first_at - scan_from <= GROUP_GAP_MS
            && store.db.query_row(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE kind = 'attention' AND sender = ?1 AND provider = ?2 AND native_id = ?3 AND checkout = ?4 AND created_at <= ?5)",
                params![newest.sender, newest.provider, newest.native_id, newest.checkout, scan_from],
                |r| r.get::<_, bool>(0),
            )?;
        let ids: Vec<&String> = group.ids.iter().rev().take(MAX_GROUP_ITEMS).collect();
        groups.push(json!({
            "group_key": group.key,
            "sender": { "kind": "session", "id": sender_id(&newest.sender) },
            "project": newest.project,
            "recipient_session_hint": newest.session_hint,
            "count": group.count,
            "count_complete": !may_continue,
            "first_at": group.first_at,
            "last_at": group.last_at,
            "latest_attention_id": newest.id,
            "item_ids": ids,
        }));
    }
    Ok((json!({ "groups": groups, "suppressed": suppressed }), membership))
}
