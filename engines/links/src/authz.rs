//! The one authorization rule for peer mail, read from the store inside the transaction that stores or hands
//! off. Nothing a peer says is consulted: only the roster, grants and snapshots written by the trusted
//! service, and the sharing policy (#11's single authority). A lapse of any of them is the same as never
//! having had it.

use crate::{
    args::Fail,
    mailbox::Recipient,
    sharing::{self, Standing},
};
use rusqlite::{Connection, OptionalExtension, params};

/// What the receive check established beyond "allowed": the session's own trusted conversation, which the caller
/// compares with whatever the mail names (the local tuple, or its wire address).
pub struct Admit {
    pub current: Recipient,
}

fn denied() -> Fail {
    Fail::new("PEER_NOT_AUTHORIZED", "this peer may not send to that session")
}

pub fn on_roster(db: &Connection, peer: &str) -> rusqlite::Result<bool> {
    db.query_row("SELECT EXISTS (SELECT 1 FROM peers WHERE peer_id = ?1)", [peer], |row| row.get(0))
}

/// Whether a grant of `capability` covers the session: every session, the project's current scope, or the session.
pub fn grant_covers(db: &Connection, peer: &str, capability: &str, scope: Option<&str>, session_hint: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS (SELECT 1 FROM peer_grants WHERE peer_id = ?1 AND capability = ?2 AND (
            scope_kind = 'peer'
            OR (scope_kind = 'project' AND scope_id = ?3)
            OR (scope_kind = 'session' AND scope_id = ?4)))",
        params![peer, capability, scope.unwrap_or(""), session_hint],
        |row| row.get(0),
    )
}

/// Receive-side admission for one recipient. Order matters: a peer with no receive grant at all learns nothing
/// about which sessions exist.
pub fn admit_receive(db: &Connection, version: i64, now: i64, peer: &str, session_hint: &str) -> Result<Admit, Fail> {
    if !on_roster(db, peer)? {
        return Err(denied());
    }
    let any: bool = db.query_row("SELECT EXISTS (SELECT 1 FROM peer_grants WHERE peer_id = ?1 AND capability = 'receive')", [peer], |row| row.get(0))?;
    if !any {
        return Err(denied());
    }
    let snapshot: Option<(String, String, String, Option<String>, String, i64)> = db
        .query_row(
            "SELECT provider, native_id, checkout, project, state, valid_until FROM binding_snapshots WHERE session_hint = ?1",
            [session_hint],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()?;
    let Some((provider, native_id, checkout, project, state, valid_until)) = snapshot else {
        return Err(Fail::new("RECIPIENT_BINDING_UNKNOWN", "the session has no current conversation on record").retryable());
    };
    if state != "valid" || valid_until <= now {
        return Err(Fail::new("RECIPIENT_BINDING_UNKNOWN", "the session has no current conversation on record").retryable());
    }
    // A session outside every project, or in one that is not shared, admits no peer, whatever it was granted.
    let Some(project) = project else { return Err(denied()) };
    let scope = match sharing::standing(db, version, &project)? {
        Standing::Valid(policy, _) if policy.receive => policy.scope,
        _ => return Err(denied()),
    };
    if !grant_covers(db, peer, "receive", Some(&scope), session_hint)? {
        return Err(denied());
    }
    Ok(Admit { current: Recipient { provider, native_id, checkout, session_hint: session_hint.to_string() } })
}

/// Re-checks every queued or lapsed-held peer message: mail that no longer passes is held with the reason, and
/// mail held only for lapsed authorization is queued again once it passes. Stale evidence never hands anything off.
pub fn gate_all(db: &Connection, version: i64, now: i64) -> Result<Vec<String>, Fail> {
    let mut statement = db.prepare(
        "SELECT d.message_id, d.state, i.peer_id, m.provider, m.native_id, m.checkout, COALESCE(d.locator, m.session_hint)
         FROM inbound i JOIN deliveries d ON d.message_id = i.message_id JOIN messages m ON m.id = i.message_id
         WHERE (d.state = 'queued' OR (d.state = 'held' AND d.reason = 'authorization-lapsed')) AND d.expires_at > ?1",
    )?;
    let rows = statement
        .query_map([now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                (row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?),
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut held = Vec::new();
    for (id, state, peer, stored, hint) in rows {
        let hold = |reason: &str| {
            db.execute("UPDATE deliveries SET state = 'held', reason = ?2, updated_at = ?3 WHERE message_id = ?1 AND state = 'queued'", params![id, reason, now])
        };
        match admit_receive(db, version, now, &peer, &hint) {
            Err(fail) if state == "queued" => {
                let reason = if fail.code == "PEER_NOT_AUTHORIZED" && !on_roster(db, &peer)? { "peer-revoked" } else { "authorization-lapsed" };
                hold(reason)?;
                held.push(id);
            }
            Ok(admit) if state == "queued" && !admit.current.matches_stored(&stored) => {
                hold("conversation-replaced")?;
                held.push(id);
            }
            Ok(admit) if state == "held" && admit.current.matches_stored(&stored) => {
                db.execute("UPDATE deliveries SET state = 'queued', reason = NULL, updated_at = ?2 WHERE message_id = ?1 AND state = 'held'", params![id, now])?;
            }
            _ => {}
        }
    }
    Ok(held)
}
