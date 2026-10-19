//! Passive projection of schema-4's immutable message event log.

use crate::{args::{Args, Fail}, store::{HISTORY_SCHEMA, Store}};
use rusqlite::params;
use serde_json::{json, Value};

/// The JS client refuses a serialized protocol reply over 2 MiB. Reserve enough
/// space for the result envelope and fixed page fields before adding whole events.
const EVENT_PAGE_BYTES: usize = 2 * 1024 * 1024 - 4096;
/// Older databases can contain bodies larger than current admission allows. Do
/// not materialize one until its bounded legacy size has been checked.
const MAX_EVENT_BODY_BYTES: usize = 256 * 1024;

pub fn origin(sender: &str) -> Result<&str, Fail> {
    if sender == "user" || sender.strip_prefix("session:").is_some_and(|id| !id.is_empty()) { return Ok("local"); }
    if sender.len() == 69 && sender.starts_with("peer:") && sender[5..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Ok(sender);
    }
    Err(Fail::new("ORIGIN_INVALID", "the message has a non-canonical origin"))
}

pub fn requested_origin(origin: &str) -> Result<(), Fail> {
    if origin == "local" || (origin.len() == 69 && origin.starts_with("peer:") && origin[5..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        Ok(())
    } else {
        Err(Fail::new("REQUEST_INVALID", "the origin is not canonical"))
    }
}

/// Records the final visible state of each message dirtied by this transaction.
/// Triggers only collect ids, so a transaction that moves a message several times
/// still appends one truthful state and retry bookkeeping stays silent.
pub fn flush(tx: &rusqlite::Transaction) -> Result<(), Fail> {
    tx.execute(
        "WITH current AS (
         SELECT h.message_id, COALESCE(d.updated_at, o.updated_at) AS at,
           CASE WHEN d.message_id IS NOT NULL THEN d.state
                WHEN o.outbox_state = 'pending' THEN 'queued'
                WHEN o.outbox_state = 'deposited' THEN COALESCE(o.remote_state, 'queued')
                WHEN o.outbox_state = 'rejected' THEN 'rejected'
                WHEN o.outbox_state = 'cancelled' THEN 'cancelled' ELSE 'expired' END AS state,
           CASE WHEN d.message_id IS NOT NULL THEN d.reason
                WHEN o.outbox_state = 'rejected' THEN o.reason
                WHEN o.outbox_state = 'deposited' THEN o.remote_reason ELSE NULL END AS reason,
           COALESCE(d.attempts, 0) AS attempts, COALESCE(d.redeliveries, 0) AS redeliveries, d.attempt_id,
           COALESCE(d.expires_at, o.expires_at) AS expires_at, o.outbox_state AS stage, o.remote_state,
           COALESCE(o.cancel_state, 'none') AS cancel,
           NOT EXISTS (SELECT 1 FROM message_events e WHERE e.message_id = h.message_id) AS first_event
         FROM history_dirty h JOIN messages m ON m.id = h.message_id
         LEFT JOIN deliveries d ON d.message_id = m.id LEFT JOIN outbox o ON o.message_id = m.id
         WHERE m.kind != 'attention' AND (d.message_id IS NOT NULL OR o.message_id IS NOT NULL)
         )
         INSERT INTO message_events (message_id, at, state, reason, attempts, redeliveries, attempt_id, expires_at, stage, remote_state, cancel, first_event, backfill)
         SELECT c.message_id, c.at, c.state, c.reason, c.attempts, c.redeliveries, c.attempt_id, c.expires_at, c.stage, c.remote_state, c.cancel, c.first_event, 0
         FROM current c
         WHERE NOT EXISTS (
           SELECT 1 FROM message_events e WHERE e.message_id = c.message_id
             AND e.seq = (SELECT MAX(latest.seq) FROM message_events latest WHERE latest.message_id = c.message_id)
             AND e.state IS c.state AND e.reason IS c.reason AND e.attempts IS c.attempts
             AND e.redeliveries IS c.redeliveries AND e.attempt_id IS c.attempt_id
             AND e.expires_at IS c.expires_at AND e.stage IS c.stage
             AND e.remote_state IS c.remote_state AND e.cancel IS c.cancel
         )
         ORDER BY c.message_id",
        [],
    )?;
    tx.execute("DELETE FROM history_dirty", [])?;
    Ok(())
}

fn json_string_bytes(value: &str) -> usize {
    2 + value
        .bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r' => 2,
            0..=0x1f => 6,
            _ => 1,
        })
        .sum::<usize>()
}

/// Reads never create or migrate. A missing or pre-history store has no event log.
pub fn events(store: Option<&Store>, mut args: Args) -> Result<Value, Fail> {
    let after = args.optional_u64("after")?.unwrap_or(0);
    let limit = args.optional_u64("limit")?.unwrap_or(100);
    let wanted_origin = args.optional_string("origin", 69)?;
    let run_hint = args.optional_string("run_hint", 128)?;
    args.finish()?;
    if after < 0 || !(1..=200).contains(&limit) { return Err(Fail::new("REQUEST_INVALID", "the event cursor or limit is invalid")); }
    if run_hint.is_some() && wanted_origin.is_none() { return Err(Fail::new("REQUEST_INVALID", "run_hint requires origin")); }
    if let Some(origin) = wanted_origin.as_deref() { requested_origin(origin)?; }
    let Some(store) = store else { return Ok(json!({"store_id":null,"head":0,"next":0,"has_more":false,"events":[]})) };
    if store.version < HISTORY_SCHEMA { return Ok(json!({"store_id":null,"head":0,"next":0,"has_more":false,"events":[]})) }
    let store_id: String = store.db.query_row("SELECT store_id FROM history_meta LIMIT 1", [], |r| r.get(0))?;
    let head: i64 = store.db.query_row("SELECT COALESCE(MAX(seq), 0) FROM message_events", [], |r| r.get(0))?;
    let mut stmt = store.db.prepare("SELECT e.seq,e.first_event,e.backfill,e.at,e.message_id,e.state,e.reason,e.attempts,e.redeliveries,e.attempt_id,e.expires_at,e.stage,e.remote_state,e.cancel,length(CAST(m.body AS BLOB)),m.created_at,m.kind,m.sender,m.provider,m.session_hint,m.reply_to,m.run_hint,m.size,m.span_hint
      FROM message_events e JOIN messages m ON m.id=e.message_id
      WHERE e.seq>?1 AND e.seq<=?2 AND (?3 IS NULL OR (?3='local' AND (m.sender='user' OR m.sender LIKE 'session:%')) OR m.sender=?3)
        AND (?4 IS NULL OR m.run_hint=?4) ORDER BY e.seq LIMIT ?5")?;
    let rows = stmt.query_map(params![after, head, wanted_origin, run_hint, limit + 1], |r| Ok((
      r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,i64>(10)?,r.get::<_,Option<String>>(11)?,r.get::<_,Option<String>>(12)?,r.get::<_,String>(13)?,r.get::<_,i64>(14)?,r.get::<_,i64>(15)?,r.get::<_,String>(16)?,r.get::<_,String>(17)?,r.get::<_,String>(18)?,r.get::<_,String>(19)?,r.get::<_,Option<String>>(20)?,r.get::<_,Option<String>>(21)?,r.get::<_,i64>(22)?,r.get::<_,Option<String>>(23)?)))?;
    let mut events = Vec::new();
    let mut has_more = false;
    let mut bytes = 0;
    for row in rows { let r=row?; let actual=origin(&r.17)?;
      if events.len() == limit as usize { has_more = true; break; }
      if r.14 as usize > MAX_EVENT_BODY_BYTES { return Err(Fail::new("EVENT_TOO_LARGE", "a legacy event cannot fit the history reply limit")); }
      let body: String = store.db.query_row("SELECT body FROM messages WHERE id = ?1", [&r.4], |row| row.get(0))?;
      let mut event = json!({"seq":r.0,"first":r.1!=0,"backfill":r.2!=0,"at":r.3,"message_id":r.4,"state":r.5,"reason":r.6,"attempts":r.7,"redeliveries":r.8,"attempt_id":r.9,"expires_at":r.10,"stage":r.11,"remote_state":r.12,"cancel":r.13,"message":{"body":"","created_at":r.15,"kind":r.16,"origin":actual,"recipient":{"provider":r.18,"session_hint":r.19},"reply_to":r.20,"run_hint":r.21,"sender":{"kind":if r.17.starts_with("peer:"){"peer"}else if r.17.starts_with("session:"){"session"}else{"user"}},"size":r.22,"span_hint":r.23}});
      let event_bytes = serde_json::to_vec(&event).map_err(|_| Fail::new("STORE_FAILURE", "the store could not complete the operation"))?.len() - 2 + json_string_bytes(&body);
      let separator = usize::from(!events.is_empty());
      if event_bytes + separator > EVENT_PAGE_BYTES { return Err(Fail::new("EVENT_TOO_LARGE", "an event cannot fit the history reply limit")); }
      if bytes + event_bytes + separator > EVENT_PAGE_BYTES { has_more = true; break; }
      event["message"]["body"] = json!(body);
      bytes += event_bytes + separator;
      events.push(event);
    }
    let next = if has_more { events.last().and_then(|v| v["seq"].as_i64()).unwrap_or(after) } else { head.max(after) };
    Ok(json!({"store_id":store_id,"head":head,"next":next,"has_more":has_more,"events":events}))
}
