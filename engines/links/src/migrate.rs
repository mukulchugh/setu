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
