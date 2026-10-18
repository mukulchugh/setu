//! The receiver snapshot: what the trusted managed-session service last published about one session's
//! conversation. It is derived data with a lifetime, not an identity record. A lapsed or invalidated snapshot
//! is as good as none, and nothing a peer sends can write one.

use crate::{
    args::{Args, Fail},
    authz,
    mailbox::{self, Recipient},
    store::Store,
    util,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

/// The longest a snapshot may be trusted without a fresh publish (five minutes).
pub const MAX_VALID_MS: u64 = 5 * 60 * 1000;
/// Generations are integers a JSON number carries exactly.
pub const MAX_GENERATION: u64 = 1 << 53;

pub struct Publish {
    recipient: Recipient,
    generation: i64,
    valid_for_ms: i64,
    project: Option<String>,
    /// Managed sessions this conversation previously ran under (an explicit, authenticated resume).
    resumed_from: Vec<String>,
    /// A lifecycle publication from the managed authority never creates a mailbox by itself.
    existing_store_only: bool,
}

impl Publish {
    pub fn existing_store_only(&self) -> bool {
        self.existing_store_only
    }
}

pub fn parse_publish(mut args: Args) -> Result<Publish, Fail> {
    let recipient = Recipient::parse(args.object("recipient")?)?;
    let generation = args.count("generation", 0, MAX_GENERATION, "FIELD_TOO_LARGE")? as i64;
    let valid_for_ms = args.count("valid_for_ms", 1, MAX_VALID_MS, "FIELD_TOO_LARGE")? as i64;
    let project = args.optional_string("project", 128)?;
    let resumed_from = match args.optional_array("resumed_from", 8)? {
        None => Vec::new(),
        Some(items) => items
            .into_iter()
            .map(|item| match item {
                Value::String(hint) if !hint.is_empty() && hint.len() <= 128 => Ok(hint),
                _ => Err(Fail::new("REQUEST_INVALID", "field `resumed_from` is missing or invalid")),
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    let existing_store_only = args.optional_boolean("existing_store_only")?;
    args.finish()?;
    Ok(Publish { recipient, generation, valid_for_ms, project, resumed_from, existing_store_only })
}

/// Stores the snapshot and applies the same hold-and-restore decision as `reconcile`, in one transaction.
pub fn publish(store: &mut Store, request: Publish) -> Result<Value, Fail> {
    let Publish { recipient, generation, valid_for_ms, project, resumed_from, .. } = request;
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored: Option<(String, String, String, i64, String)> = tx
        .query_row(
            "SELECT provider, native_id, checkout, generation, state FROM binding_snapshots WHERE session_hint = ?1",
            [&recipient.session_hint],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?;
    if let Some((provider, native_id, checkout, stored_generation, state)) = stored {
        let same = recipient.is(&(provider.clone(), native_id.clone(), checkout.clone()));
        let bare_fence = provider.is_empty();
        if generation < stored_generation {
            return Err(Fail::new("BINDING_STALE_GENERATION", "a newer snapshot or fence exists for this session"));
        }
        if generation == stored_generation && !(same && state == "valid") {
            // Same generation: only a refresh of the live, identical binding is accepted. A different
            // conversation is a conflict; an invalidated generation stays fenced.
            return Err(if state == "invalid" && (same || bare_fence) {
                Fail::new("BINDING_FENCED", "this generation was invalidated")
            } else {
                Fail::new("BINDING_CONFLICT", "this generation already names a different conversation")
            });
        }
    }
    let valid_until = now + valid_for_ms;
    tx.execute(
        "INSERT INTO binding_snapshots (session_hint, provider, native_id, checkout, generation, valid_until, state, project, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'valid', ?7, ?8)
         ON CONFLICT (session_hint) DO UPDATE SET provider = ?2, native_id = ?3, checkout = ?4, generation = ?5,
            valid_until = ?6, state = 'valid', invalid_reason = NULL, project = ?7, updated_at = ?8",
        params![recipient.session_hint, recipient.provider, recipient.native_id, recipient.checkout, generation, valid_until, project, now],
    )?;
    let (mut held, mut released) = mailbox::reconcile_in(&tx, &recipient, now)?;
    // An explicit resume moves the located mail with the one shared helper (also behind the `resume` operation).
    if !resumed_from.is_empty() {
        let (_, resumed) = mailbox::resume_in(&tx, &recipient, &resumed_from, now)?;
        released.extend(resumed);
    }
    held.extend(authz::gate_all(&tx, store.version, now)?);
    // Report what is true when this commits: mail the conversation released but authorization held again is held (and
    // listed in `held`), not released.
    keep_in_state(&tx, &mut released, "queued")?;
    crate::store::commit(tx, "binding_publish")?;
    Ok(json!({ "valid_until": valid_until, "held": held, "released": released, "stored": true }))
}

/// Keeps, once each, the ids whose delivery is in `state` right now.
fn keep_in_state(db: &rusqlite::Connection, ids: &mut Vec<String>, state: &str) -> Result<(), Fail> {
    let mut seen = std::collections::HashSet::new();
    let mut kept = Vec::new();
    for id in ids.drain(..) {
        let current: Option<String> = db.query_row("SELECT state FROM deliveries WHERE message_id = ?1", [&id], |row| row.get(0)).optional()?;
        if current.as_deref() == Some(state) && seen.insert(id.clone()) {
            kept.push(id);
        }
    }
    *ids = kept;
    Ok(())
}

const REASONS: [(&str, &str); 5] = [
    ("ended", "session-not-running"),
    ("ownership-unknown", "session-not-running"),
    ("disabled", "session-not-running"),
    ("replaced", "conversation-replaced"),
    ("checkout-changed", "checkout-changed"),
];

pub struct Invalidate {
    session_hint: String,
    generation: i64,
    reason: &'static str,
    hold_reason: &'static str,
    existing_store_only: bool,
}

impl Invalidate {
    pub fn existing_store_only(&self) -> bool {
        self.existing_store_only
    }
}

pub fn parse_invalidate(mut args: Args) -> Result<Invalidate, Fail> {
    let session_hint = args.string("session_hint", 128)?;
    let reason = args.string("reason", 32)?;
    let generation = args.count("generation", 0, MAX_GENERATION, "FIELD_TOO_LARGE")? as i64;
    let existing_store_only = args.optional_boolean("existing_store_only")?;
    args.finish()?;
    let (reason, hold_reason) = REASONS
        .iter()
        .find(|(name, _)| *name == reason)
        .copied()
        .ok_or_else(|| Fail::new("REQUEST_INVALID", "field `reason` is missing or invalid"))?;
    Ok(Invalidate { session_hint, generation, reason, hold_reason, existing_store_only })
}

/// Withdraws the snapshot now and fences its generation, so no earlier publish can bring it back, then holds the
/// session's queued mail. A session that never published gets a bare fence. Safe to repeat at the same generation.
pub fn invalidate(store: &mut Store, request: Invalidate) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored: Option<i64> = tx
        .query_row("SELECT generation FROM binding_snapshots WHERE session_hint = ?1", [&request.session_hint], |row| row.get(0))
        .optional()?;
    if stored.is_some_and(|generation| request.generation < generation) {
        return Err(Fail::new("BINDING_STALE_GENERATION", "a newer snapshot or fence exists for this session"));
    }
    tx.execute(
        "INSERT INTO binding_snapshots (session_hint, provider, native_id, checkout, generation, valid_until, state, invalid_reason, updated_at)
         VALUES (?1, '', '', '', ?2, 0, 'invalid', ?3, ?4)
         ON CONFLICT (session_hint) DO UPDATE SET generation = ?2, state = 'invalid', invalid_reason = ?3, updated_at = ?4",
        params![request.session_hint, request.generation, request.reason, now],
    )?;
    let mut hold = tx.prepare(
        "UPDATE deliveries SET state = 'held', reason = ?2, updated_at = ?3
         WHERE state = 'queued' AND COALESCE(locator, (SELECT session_hint FROM messages WHERE id = message_id)) = ?1
         RETURNING message_id",
    )?;
    let held = hold
        .query_map(params![request.session_hint, request.hold_reason, now], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(hold);
    authz::gate_all(&tx, store.version, now)?;
    crate::store::commit(tx, "binding_invalidate")?;
    Ok(json!({ "held": held, "stored": true }))
}

/// Passive: reports the snapshot as the clock reads it now, and never extends it. A fence with no conversation shows `recipient: null`.
pub fn show(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let session = args.string("session_hint", 128)?;
    args.finish()?;
    let Some(store) = store else { return Ok(json!({ "state": "absent" })) };
    // A store from the first engine has no snapshots.
    if store.version < 3 {
        return Ok(json!({ "state": "absent" }));
    }
    let row: Option<(String, String, String, i64, i64, String, Option<String>, Option<String>)> = store
        .db
        .query_row(
            "SELECT provider, native_id, checkout, generation, valid_until, state, invalid_reason, project
             FROM binding_snapshots WHERE session_hint = ?1",
            [&session],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .optional()?;
    let Some((provider, native_id, checkout, generation, valid_until, state, invalid_reason, project)) = row else {
        return Ok(json!({ "state": "absent" }));
    };
    let state = match state.as_str() {
        "valid" if valid_until <= util::now_ms() => "expired",
        other => other,
    };
    let recipient = if provider.is_empty() {
        Value::Null
    } else {
        json!({ "provider": provider, "native_id": native_id, "checkout": checkout, "session_hint": session })
    };
    Ok(json!({
        "state": state,
        "recipient": recipient,
        "generation": generation,
        "valid_until": valid_until,
        "invalid_reason": invalid_reason,
        "project": project,
    }))
}

/// The fence for a claim: the session's snapshot must be fresh, valid, exactly this conversation, at exactly the
/// generation the caller authenticated at. Reads only; a refusal changes nothing.
pub fn require_current(db: &rusqlite::Connection, to: &Recipient, generation: i64, now: i64) -> Result<(), Fail> {
    let row: Option<(String, String, String, i64, i64, String)> = db
        .query_row(
            "SELECT provider, native_id, checkout, generation, valid_until, state FROM binding_snapshots WHERE session_hint = ?1",
            [&to.session_hint],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    let refuse = |reason: &str| Fail::new("BINDING_NOT_CURRENT", "the session's current conversation is not the one that asked").with(json!({ "reason": reason }));
    let Some((provider, native_id, checkout, stored_generation, valid_until, state)) = row else { return Err(refuse("absent")) };
    if state != "valid" {
        return Err(refuse("invalid"));
    }
    if valid_until <= now {
        return Err(refuse("expired"));
    }
    if !to.is(&(provider, native_id, checkout)) {
        return Err(refuse("conversation"));
    }
    if stored_generation != generation {
        return Err(refuse("generation"));
    }
    Ok(())
}
