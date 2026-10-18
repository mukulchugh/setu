//! The roster of peers and what each is granted. Written only by trusted operations; a message, receipt or
//! hello from a peer never creates a peer, a grant or anything that stands in for one. Default is deny.

use crate::{
    args::{Args, Fail},
    mailbox,
    store::Store,
    util,
};
use rusqlite::{TransactionBehavior, params};
use serde_json::{Value, json};
use std::{net::SocketAddr, str::FromStr};

const MAX_ADDRESSES: usize = 8;

/// A peer is its transport public key, in the one canonical (lowercase hex) spelling.
fn peer_id(args: &mut Args) -> Result<String, Fail> {
    let id = args.string("peer_id", 64)?;
    match iroh::EndpointId::from_str(&id) {
        Ok(key) if key.to_string() == id => Ok(id),
        _ => Err(Fail::new("REQUEST_INVALID", "field `peer_id` is missing or invalid")),
    }
}

pub struct AddPeer {
    peer_id: String,
    label: String,
    addresses: Vec<String>,
}

pub fn parse_add(mut args: Args) -> Result<AddPeer, Fail> {
    let peer_id = peer_id(&mut args)?;
    let label = util::one_line(&args.string("label", 256)?, 64);
    let addresses = args.strings("addresses", MAX_ADDRESSES, 64)?;
    args.finish()?;
    if label.is_empty() || addresses.iter().any(|address| SocketAddr::from_str(address).is_err()) {
        return Err(Fail::new("REQUEST_INVALID", "field `label` or `addresses` is invalid"));
    }
    Ok(AddPeer { peer_id, label, addresses })
}

/// Adds a peer, or updates the label and addresses of one already there. Grants are untouched.
pub fn add(store: &mut Store, request: AddPeer) -> Result<Value, Fail> {
    let now = util::now_ms();
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO peers (peer_id, label, addresses, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (peer_id) DO UPDATE SET label = ?2, addresses = ?3",
        params![request.peer_id, request.label, json!(request.addresses).to_string(), now],
    )?;
    mailbox::commit(tx, "peer_add")?;
    Ok(json!({ "peer_id": request.peer_id }))
}

pub struct RemovePeer {
    pub peer_id: String,
}

pub fn parse_remove(mut args: Args) -> Result<RemovePeer, Fail> {
    let peer_id = peer_id(&mut args)?;
    args.finish()?;
    Ok(RemovePeer { peer_id })
}

/// Revokes a peer: it and its grants are gone. Safe to repeat.
pub fn remove(store: &mut Store, request: RemovePeer) -> Result<Value, Fail> {
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM peers WHERE peer_id = ?1", [&request.peer_id])?;
    // Revocation is visible at once: the peer's waiting mail is held, not left looking queued.
    crate::authz::gate_all(&tx, store.version, util::now_ms())?;
    mailbox::commit(tx, "peer_remove")?;
    Ok(json!({ "peer_id": request.peer_id }))
}

#[derive(Clone)]
pub struct Grant {
    pub peer_id: String,
    capability: String,
    scope_kind: String,
    scope_id: String,
}

pub fn parse_grant(mut args: Args) -> Result<Grant, Fail> {
    let peer_id = peer_id(&mut args)?;
    let capability = args.string("capability", 16)?;
    let mut scope = args.object("scope")?;
    let scope_kind = scope.string("kind", 16)?;
    let scope_id = scope.optional_string("id", 128)?;
    scope.finish()?;
    args.finish()?;
    if !["receive", "visible", "send"].contains(&capability.as_str()) {
        return Err(Fail::new("REQUEST_INVALID", "field `capability` is missing or invalid"));
    }
    let scope_id = match (scope_kind.as_str(), scope_id) {
        ("peer", None) => String::new(),
        ("peer", Some(_)) => return Err(Fail::new("FIELD_UNSUPPORTED", "field `id` is not supported for this scope")),
        ("project" | "session", Some(id)) => id,
        _ => return Err(Fail::new("REQUEST_INVALID", "field `scope` is missing or invalid")),
    };
    Ok(Grant { peer_id, capability, scope_kind, scope_id })
}

pub fn grant(store: &mut Store, request: Grant) -> Result<Value, Fail> {
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let known: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM peers WHERE peer_id = ?1)", [&request.peer_id], |row| row.get(0))?;
    if !known {
        return Err(Fail::new("PEER_UNKNOWN", "no such peer"));
    }
    tx.execute(
        "INSERT OR IGNORE INTO peer_grants (peer_id, capability, scope_kind, scope_id) VALUES (?1, ?2, ?3, ?4)",
        params![request.peer_id, request.capability, request.scope_kind, request.scope_id],
    )?;
    mailbox::commit(tx, "peer_grant")?;
    Ok(json!({ "peer_id": request.peer_id }))
}

pub fn remove_grant(store: &mut Store, request: Grant) -> Result<Value, Fail> {
    let tx = store.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "DELETE FROM peer_grants WHERE peer_id = ?1 AND capability = ?2 AND scope_kind = ?3 AND scope_id = ?4",
        params![request.peer_id, request.capability, request.scope_kind, request.scope_id],
    )?;
    crate::authz::gate_all(&tx, store.version, util::now_ms())?;
    mailbox::commit(tx, "peer_grant_remove")?;
    Ok(json!({ "peer_id": request.peer_id }))
}

/// Every peer with the addresses to dial it at.
pub fn roster(db: &rusqlite::Connection) -> Result<Vec<(String, Vec<String>)>, Fail> {
    let mut statement = db.prepare("SELECT peer_id, addresses FROM peers ORDER BY peer_id")?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(|(id, addresses)| (id, serde_json::from_str(&addresses).unwrap_or_default())).collect())
}

/// Passive: the roster with each peer's grants.
pub fn list(store: Option<&Store>, args: Args) -> Result<Value, Fail> {
    args.finish()?;
    let Some(store) = store else { return Ok(json!({ "peers": [] })) };
    if store.version < 3 {
        return Ok(json!({ "peers": [] }));
    }
    let mut peers = store.db.prepare("SELECT peer_id, label, addresses, created_at FROM peers ORDER BY peer_id")?;
    let rows = peers
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut grants = store.db.prepare(
        "SELECT capability, scope_kind, scope_id FROM peer_grants WHERE peer_id = ?1 ORDER BY capability, scope_kind, scope_id",
    )?;
    let mut listed = Vec::new();
    for (peer_id, label, addresses, created_at) in rows {
        let granted = grants
            .query_map([&peer_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(capability, kind, id)| {
                let scope = if kind == "peer" { json!({ "kind": kind }) } else { json!({ "kind": kind, "id": id }) };
                json!({ "capability": capability, "scope": scope })
            })
            .collect::<Vec<_>>();
        // What the peer itself has published as reachable, while the sender may still rely on it.
        let published = store
            .db
            .prepare("SELECT session_hint, scope, provider, native_id, checkout FROM remote_bindings WHERE peer_id = ?1 AND valid_until > ?2 ORDER BY session_hint")?
            .query_map(params![peer_id, util::now_ms()], |row| {
                let hint = row.get::<_, String>(0)?;
                Ok(json!({
                    "session_hint": hint,
                    "scope": row.get::<_, String>(1)?,
                    "recipient": { "provider": row.get::<_, String>(2)?, "native_id": row.get::<_, String>(3)?, "checkout": row.get::<_, String>(4)?, "session_hint": hint },
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        listed.push(json!({
            "published": published,
            "peer_id": peer_id,
            "label": label,
            "addresses": serde_json::from_str::<Value>(&addresses).unwrap_or(json!([])),
            "grants": granted,
            "created_at": created_at,
        }));
    }
    Ok(json!({ "peers": listed }))
}
