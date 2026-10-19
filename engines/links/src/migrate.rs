//! Explicit schema migrations. Each step runs inside the caller's write transaction, only adds tables and
//! indexes, and never rewrites a message. A store newer than this engine is refused before it gets here.

/// Schema 2 to 3: peer transport. Additive; the mailbox tables and the sharing tables are untouched.
pub const TO_3: &str = "
CREATE TABLE peers (
    peer_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    addresses TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE outbox (
    message_id TEXT PRIMARY KEY REFERENCES messages (id),
    peer_id TEXT NOT NULL,
    outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending', 'deposited', 'rejected', 'expired', 'cancelled')),
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    expires_at INTEGER NOT NULL,
    remote_state TEXT,
    remote_reason TEXT,
    remote_seq INTEGER NOT NULL DEFAULT 0,
    remote_updated_at INTEGER,
    cancel_state TEXT NOT NULL DEFAULT 'none' CHECK (cancel_state IN ('none', 'requested', 'confirmed', 'refused')),
    updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_peer ON outbox (peer_id, outbox_state);
CREATE TABLE inbound (
    message_id TEXT PRIMARY KEY REFERENCES messages (id),
    peer_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    recipient_digest TEXT NOT NULL,
    state_seq INTEGER NOT NULL,
    reported_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (peer_id, origin_id)
);
CREATE INDEX inbound_peer ON inbound (peer_id, created_at);
CREATE TRIGGER inbound_state_changed AFTER UPDATE OF state, reason ON deliveries
BEGIN UPDATE inbound SET state_seq = state_seq + 1 WHERE message_id = NEW.message_id; END;
CREATE TABLE cancel_tombstones (
    peer_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (peer_id, origin_id)
);
CREATE TABLE remote_bindings (
    peer_id TEXT NOT NULL,
    session_hint TEXT NOT NULL,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    scope TEXT NOT NULL,
    valid_until INTEGER NOT NULL,
    PRIMARY KEY (peer_id, session_hint)
);
CREATE TABLE peer_grants (
    peer_id TEXT NOT NULL REFERENCES peers (peer_id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (capability IN ('receive', 'visible', 'send')),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('peer', 'project', 'session')),
    scope_id TEXT NOT NULL,
    PRIMARY KEY (peer_id, capability, scope_kind, scope_id)
);
CREATE TABLE binding_snapshots (
    session_hint TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    native_id TEXT NOT NULL,
    checkout TEXT NOT NULL,
    generation INTEGER NOT NULL,
    valid_until INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('valid', 'invalid')),
    invalid_reason TEXT,
    project TEXT,
    updated_at INTEGER NOT NULL
);
";

/// Schema 3 to 4: append-only, message-state history.  Events are written by
/// the same SQLite transaction as the mailbox/outbox change, so retries and
/// receipt bookkeeping cannot create a second authority.
pub const TO_4: &str = "
CREATE TABLE history_meta (store_id TEXT NOT NULL);
INSERT INTO history_meta (store_id) VALUES (lower(hex(randomblob(16))));
CREATE TABLE message_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id),
    at INTEGER NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL,
    redeliveries INTEGER NOT NULL,
    attempt_id TEXT,
    expires_at INTEGER NOT NULL,
    stage TEXT,
    remote_state TEXT,
    cancel TEXT NOT NULL,
    first_event INTEGER NOT NULL,
    backfill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX message_events_message ON message_events(message_id, seq);
CREATE INDEX message_events_seq ON message_events(seq);
CREATE INDEX messages_history_selector ON messages(sender, run_hint, id);
CREATE TABLE history_dirty (message_id TEXT PRIMARY KEY REFERENCES messages(id));
CREATE TRIGGER message_events_origin BEFORE INSERT ON message_events
WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.message_id AND
  (sender = 'user' OR (substr(sender, 1, 8) = 'session:' AND length(sender) > 8)
   OR (substr(sender, 1, 5) = 'peer:' AND length(sender) = 69
       AND substr(sender, 6) NOT GLOB '*[^0-9a-f]*')))
BEGIN SELECT RAISE(ABORT, 'invalid event origin'); END;
CREATE TRIGGER message_events_immutable BEFORE UPDATE ON message_events
BEGIN SELECT RAISE(ABORT, 'message events are immutable'); END;
CREATE TRIGGER message_events_permanent BEFORE DELETE ON message_events
BEGIN SELECT RAISE(ABORT, 'message events are permanent'); END;
INSERT INTO message_events (message_id, at, state, reason, attempts, redeliveries, attempt_id, expires_at, stage, remote_state, cancel, first_event, backfill)
 SELECT m.id, COALESCE(d.updated_at, o.updated_at),
   CASE WHEN d.message_id IS NOT NULL THEN d.state
        WHEN o.outbox_state = 'pending' THEN 'queued'
        WHEN o.outbox_state = 'deposited' THEN COALESCE(o.remote_state, 'queued')
        WHEN o.outbox_state = 'rejected' THEN 'rejected'
        WHEN o.outbox_state = 'cancelled' THEN 'cancelled' ELSE 'expired' END,
   CASE WHEN d.message_id IS NOT NULL THEN d.reason ELSE CASE WHEN o.outbox_state = 'rejected' THEN o.reason WHEN o.outbox_state = 'deposited' THEN o.remote_reason ELSE NULL END END,
   COALESCE(d.attempts, 0), COALESCE(d.redeliveries, 0), d.attempt_id, COALESCE(d.expires_at, o.expires_at),
   o.outbox_state, o.remote_state, COALESCE(o.cancel_state, 'none'), 1, 1
 FROM messages m LEFT JOIN deliveries d ON d.message_id = m.id LEFT JOIN outbox o ON o.message_id = m.id
 WHERE m.kind != 'attention' AND (d.message_id IS NOT NULL OR o.message_id IS NOT NULL);
CREATE TRIGGER history_delivery_insert AFTER INSERT ON deliveries
WHEN (SELECT kind FROM messages WHERE id = NEW.message_id) != 'attention'
BEGIN INSERT OR IGNORE INTO history_dirty VALUES (NEW.message_id); END;
CREATE TRIGGER history_delivery_update AFTER UPDATE OF state, reason, attempts, redeliveries, attempt_id, expires_at ON deliveries
WHEN (SELECT kind FROM messages WHERE id = NEW.message_id) != 'attention'
 AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.attempts IS NOT OLD.attempts
      OR NEW.redeliveries IS NOT OLD.redeliveries OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.expires_at IS NOT OLD.expires_at)
BEGIN INSERT OR IGNORE INTO history_dirty VALUES (NEW.message_id); END;
CREATE TRIGGER history_outbox_insert AFTER INSERT ON outbox
WHEN (SELECT kind FROM messages WHERE id = NEW.message_id) != 'attention'
BEGIN INSERT OR IGNORE INTO history_dirty VALUES (NEW.message_id); END;
CREATE TRIGGER history_outbox_update AFTER UPDATE OF outbox_state, remote_state, remote_reason, cancel_state ON outbox
WHEN (SELECT kind FROM messages WHERE id = NEW.message_id) != 'attention'
 AND (NEW.outbox_state IS NOT OLD.outbox_state OR NEW.remote_state IS NOT OLD.remote_state
      OR NEW.remote_reason IS NOT OLD.remote_reason OR NEW.cancel_state IS NOT OLD.cancel_state)
BEGIN INSERT OR IGNORE INTO history_dirty VALUES (NEW.message_id); END;
";
