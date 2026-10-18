//! Connections between engines: authenticated and encrypted by the transport library (a peer is its public key),
//! direct addresses only, no relay and no public lookup. This module moves frames; every message, receipt and
//! decision lives in the engine store, so a restart loses nothing and the retry queue is just the outbox.

use crate::{
    args::Fail,
    authz, inbound, outbox,
    store::Store,
    util,
    wire::{self, Reply, Request, WireError},
};
use iroh::{
    Endpoint, EndpointAddr, EndpointId,
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const REPUBLISH: Duration = Duration::from_secs(30);
const INCOMPATIBLE_FOR: Duration = Duration::from_secs(60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Runs a store operation off the async threads. Each operation opens the store, so a crash between two of
/// them can only fall between whole transactions.
pub async fn db<T: Send + 'static>(dir: &Path, f: impl FnOnce(&mut Store) -> Result<T, Fail> + Send + 'static) -> Result<T, Fail> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut store = Store::open_or_create(&dir)?;
        f(&mut store)
    })
    .await
    .map_err(|_| Fail::new("STORE_FAILURE", "the store could not complete the operation"))?
}

/// Reads the store without a write transaction: a stranger's handshake and every polling pass only look, so
/// none of them can queue behind (or in front of) a claim.
pub async fn read_db<T: Send + 'static>(dir: &Path, f: impl FnOnce(&Store) -> Result<T, Fail> + Send + 'static) -> Result<T, Fail> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || f(&Store::open_existing(&dir)?))
        .await
        .map_err(|_| Fail::new("STORE_FAILURE", "the store could not complete the operation"))?
}

#[derive(Clone)]
struct Link {
    id: u64,
    conn: Connection,
    dialer: String,
}

#[derive(Default)]
struct PeerState {
    hello_ok: AtomicBool,
}

pub struct Net {
    dir: PathBuf,
    endpoint: Endpoint,
    me: String,
    base_status: Value,
    links: Mutex<HashMap<String, Link>>,
    dialing: Mutex<HashSet<String>>,
    backoff: Mutex<HashMap<String, (Instant, Duration)>>,
    incompatible: Mutex<HashMap<String, (String, Instant)>>,
    next_link: AtomicU64,
}

#[derive(Clone)]
pub struct Handler(pub Arc<Net>);

impl std::fmt::Debug for Handler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Handler")
    }
}

impl ProtocolHandler for Handler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer = conn.remote_id().to_string();
        let known = read_db(&self.0.dir, {
            let peer = peer.clone();
            move |store| Ok(authz::on_roster(&store.db, &peer)?)
        })
        .await
        .unwrap_or(false);
        // A stranger learns nothing and leaves nothing behind: no row is written for a key the roster does not hold.
        if !known {
            conn.close(403u32.into(), b"not authorized");
            return Ok(());
        }
        self.0.clone().run_link(conn, false).await;
        Ok(())
    }
}

/// One request on its own stream and its single reply, bounded in time. `after_send` is a test kill point.
async fn request(conn: &Connection, request: &Request, after_send: Option<&str>) -> Result<Reply, WireError> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(|_| WireError::Io)?;
    wire::write_frame(&mut send, request).await?;
    send.finish().map_err(|_| WireError::Io)?;
    if let Some(point) = after_send {
        util::fault(point);
    }
    wire::read_frame::<Reply>(&mut recv).await.map(Reply::checked)
}

/// Whether the peer on this connection answers within a moment.
async fn probe(conn: &Connection) -> bool {
    matches!(tokio::time::timeout(PROBE_TIMEOUT, request(conn, &Request::Ping {}, None)).await, Ok(Ok(Reply::Ok {})))
}

fn log(message: &str) {
    eprintln!("[{}] transport: {message}", util::now_ms());
}

impl Net {
    pub fn new(dir: PathBuf, endpoint: Endpoint, base_status: Value) -> Arc<Net> {
        Arc::new(Net {
            dir,
            me: endpoint.id().to_string(),
            endpoint,
            base_status,
            links: Mutex::default(),
            dialing: Mutex::default(),
            backoff: Mutex::default(),
            incompatible: Mutex::default(),
            next_link: AtomicU64::new(1),
        })
    }

    /// Rewrites the status file with who is connected, so a passive status read can say.
    fn refresh_status(&self) {
        let mut status = self.base_status.clone();
        let connected: Vec<String> = self.links.lock().unwrap().keys().cloned().collect();
        let mut links: Vec<Value> = connected.iter().map(|peer| json!({ "peer_id": peer, "state": "connected" })).collect();
        for (peer, (code, until)) in self.incompatible.lock().unwrap().iter() {
            if *until > Instant::now() && !connected.contains(peer) {
                links.push(json!({ "peer_id": peer, "state": "incompatible", "code": code }));
            }
        }
        links.sort_by_key(|link| link["peer_id"].as_str().map(str::to_string));
        status["links"] = json!(links);
        let _ = crate::daemon::write_status(&self.dir, &status);
    }

    pub fn start(self: &Arc<Self>) {
        tokio::spawn(self.clone().dial_loop());
        tokio::spawn(self.clone().maintenance_loop());
    }

    /// Expires what has lapsed and holds peer mail whose authorization has, so status converges without a claim.
    async fn maintenance_loop(self: Arc<Self>) {
        loop {
            let _ = db(&self.dir, |store| crate::mailbox::maintain(store)).await;
            tokio::time::sleep(Duration::from_millis(util::tick_ms())).await;
        }
    }

    async fn dial_loop(self: Arc<Self>) {
        loop {
            let roster = read_db(&self.dir, |store| crate::peers::roster(&store.db)).await.unwrap_or_default();
            for (peer, addresses) in roster {
                let skip = self.links.lock().unwrap().contains_key(&peer)
                    || self.dialing.lock().unwrap().contains(&peer)
                    || self.incompatible.lock().unwrap().get(&peer).is_some_and(|(_, until)| *until > Instant::now())
                    || self.backoff.lock().unwrap().get(&peer).is_some_and(|(at, _)| *at > Instant::now());
                if skip || peer == self.me {
                    continue;
                }
                self.dialing.lock().unwrap().insert(peer.clone());
                tokio::spawn(self.clone().dial(peer, addresses));
            }
            tokio::time::sleep(Duration::from_millis(util::tick_ms())).await;
        }
    }

    async fn dial(self: Arc<Self>, peer: String, addresses: Vec<String>) {
        let result = async {
            let id = EndpointId::from_str(&peer).ok()?;
            let mut address = EndpointAddr::new(id);
            for text in &addresses {
                address = address.with_ip_addr(SocketAddr::from_str(text).ok()?);
            }
            tokio::time::timeout(DIAL_TIMEOUT, self.endpoint.connect(address, wire::ALPN)).await.ok()?.ok()
        }
        .await;
        self.dialing.lock().unwrap().remove(&peer);
        match result {
            Some(conn) => {
                self.backoff.lock().unwrap().remove(&peer);
                self.run_link(conn, true).await;
            }
            None => {
                let mut backoff = self.backoff.lock().unwrap();
                let wait = backoff.get(&peer).map_or(Duration::from_millis(util::tick_ms()), |(_, w)| (*w * 2).min(Duration::from_secs(30)));
                backoff.insert(peer, (Instant::now() + wait, wait));
            }
        }
    }

    /// Runs one connection until it ends. Both sides may dial at once; both keep the connection the smaller key dialed.
    async fn run_link(self: Arc<Self>, conn: Connection, outgoing: bool) {
        let peer = conn.remote_id().to_string();
        let dialer = if outgoing { self.me.clone() } else { peer.clone() };
        let smaller = self.me.clone().min(peer.clone());
        let id = self.next_link.fetch_add(1, Ordering::Relaxed);
        // Two machines dialing each other at once end up with the connection the smaller key dialed. A
        // connection left behind by a peer that died is not a reason to turn its restarted self away, so the
        // older one has to answer before it wins.
        let older = self.links.lock().unwrap().get(&peer).cloned();
        if let Some(old) = older
            && old.conn.close_reason().is_none()
            && dialer != smaller
            && old.dialer == smaller
            && probe(&old.conn).await
        {
            conn.close(0u32.into(), b"duplicate connection");
            return;
        }
        {
            let mut links = self.links.lock().unwrap();
            if let Some(old) = links.get(&peer) {
                old.conn.close(0u32.into(), b"replaced");
            }
            links.insert(peer.clone(), Link { id, conn: conn.clone(), dialer });
        }
        self.refresh_status();
        let state = Arc::new(PeerState::default());
        let server = tokio::spawn(self.clone().serve_streams(conn.clone(), peer.clone(), state.clone()));
        let hello = Request::Hello {
            versions: wire::VERSIONS.to_vec(),
            capabilities: wire::CAPABILITIES.iter().map(|c| c.to_string()).collect(),
            engine_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: crate::store::SCHEMA_VERSION,
        };
        match request(&conn, &hello, None).await {
            // The dialer holds the answer to the same standard as the listener: a version this engine does not speak, or a
            // missing mandatory capability, ends the link before anything is published or deposited. Extra, optional
            // capabilities are welcome.
            Ok(Reply::HelloOk { version, capabilities }) => {
                if !wire::VERSIONS.contains(&version) {
                    self.mark_incompatible(&peer, "PROTOCOL_INCOMPATIBLE");
                } else if !wire::CAPABILITIES.iter().all(|needed| capabilities.iter().any(|c| c == needed)) {
                    self.mark_incompatible(&peer, "CAPABILITY_MISSING");
                } else {
                    self.pump(&conn, &peer).await;
                }
            }
            Ok(Reply::Rejected { code, .. }) => self.mark_incompatible(&peer, &code),
            _ => {}
        }
        server.abort();
        conn.close(0u32.into(), b"bye");
        {
            let mut links = self.links.lock().unwrap();
            if links.get(&peer).is_some_and(|l| l.id == id) {
                links.remove(&peer);
            }
        }
        self.refresh_status();
    }

    fn mark_incompatible(&self, peer: &str, code: &str) {
        log(&format!("{peer} is not compatible: {code}"));
        self.incompatible.lock().unwrap().insert(peer.to_string(), (code.to_string(), Instant::now() + INCOMPATIBLE_FOR));
    }

    async fn serve_streams(self: Arc<Self>, conn: Connection, peer: String, state: Arc<PeerState>) {
        while let Ok((send, recv)) = conn.accept_bi().await {
            tokio::spawn(self.clone().handle_stream(conn.clone(), peer.clone(), state.clone(), send, recv));
        }
    }

    async fn handle_stream(self: Arc<Self>, conn: Connection, peer: String, state: Arc<PeerState>, mut send: SendStream, mut recv: RecvStream) {
        let reply = match wire::read_frame::<Request>(&mut recv).await {
            Ok(request) => self.handle(&peer, &state, request).await,
            Err(WireError::TooLarge) => Reply::rejected("FRAME_TOO_LARGE", false),
            Err(WireError::Malformed) => Reply::rejected("REQUEST_INVALID", false),
            Err(WireError::Io) => return,
        };
        let incompatible = matches!(&reply, Reply::Rejected { code, .. } if code == "PROTOCOL_INCOMPATIBLE" || code == "CAPABILITY_MISSING");
        if wire::write_frame(&mut send, &reply).await.is_ok() {
            let _ = send.finish();
        }
        if incompatible {
            if let Reply::Rejected { code, .. } = &reply {
                self.mark_incompatible(&peer, code);
            }
            // Let the explanation reach the peer before the connection goes.
            tokio::time::sleep(Duration::from_millis(300)).await;
            conn.close(400u32.into(), b"incompatible");
            return;
        }
        // A peer taken off the roster is dropped at its next frame.
        if matches!(&reply, Reply::Rejected { code, .. } if code == "PEER_NOT_AUTHORIZED") {
            let peer_id = peer.clone();
            let on = read_db(&self.dir, move |store| Ok(authz::on_roster(&store.db, &peer_id)?)).await.unwrap_or(true);
            if !on {
                conn.close(403u32.into(), b"not authorized");
            }
        }
    }

    async fn handle(&self, peer: &str, state: &PeerState, request: Request) -> Reply {
        if let Request::Ping {} = &request {
            return Reply::Ok {};
        }
        if let Request::Hello { versions, capabilities, .. } = &request {
            // Negotiation reads nothing and writes nothing: an incompatible peer changes no state here.
            let Some(version) = wire::VERSIONS.iter().rev().find(|v| versions.contains(v)).copied() else {
                return Reply::Rejected { code: "PROTOCOL_INCOMPATIBLE".into(), retryable: false, supported: Some(wire::VERSIONS.to_vec()) };
            };
            if !wire::CAPABILITIES.iter().all(|needed| capabilities.iter().any(|c| c == needed)) {
                return Reply::rejected("CAPABILITY_MISSING", false);
            }
            state.hello_ok.store(true, Ordering::SeqCst);
            return Reply::HelloOk { version, capabilities: wire::CAPABILITIES.iter().map(|c| c.to_string()).collect() };
        }
        if !state.hello_ok.load(Ordering::SeqCst) {
            return Reply::rejected("HELLO_REQUIRED", false);
        }
        let peer = peer.to_string();
        let outcome = db(&self.dir, move |store| {
            Ok(match request {
                // Answered above, before the store is opened; listed so the match stays exhaustive.
                Request::Hello { .. } | Request::Ping {} => Reply::rejected("REQUEST_INVALID", false),
                Request::Deposit { origin_id, recipient, body, reply_to, run_hint, span_hint } => {
                    inbound::deposit(store, &peer, inbound::Deposit { origin_id, recipient, body, reply_to, run_hint, span_hint })
                }
                Request::Cancel { origin_id } => inbound::cancel(store, &peer, &origin_id),
                Request::Receipt { origin_id, recipient_digest, state, reason, seq } => {
                    outbox::apply_receipt(store, &peer, &origin_id, &recipient_digest, &state, reason.as_deref(), seq)
                }
                Request::Published { entries } => outbox::store_published(store, &peer, &entries),
            })
        })
        .await;
        outcome.unwrap_or_else(|fail| Reply::rejected(fail.code, true))
    }

    /// Everything this side owes the peer, offered in order: what it may see, deposits, cancels, receipts.
    async fn pump(self: &Arc<Self>, conn: &Connection, peer: &str) {
        let mut last_published: Option<(String, Instant)> = None;
        loop {
            if conn.close_reason().is_some() || !self.round(conn, peer, &mut last_published).await {
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(util::tick_ms())) => {}
                _ = conn.closed() => return,
            }
        }
    }

    /// One pass. False means the link should end (a failure, or the peer is no longer on the roster).
    async fn round(&self, conn: &Connection, peer: &str, last_published: &mut Option<(String, Instant)>) -> bool {
        let id = peer.to_string();
        match read_db(&self.dir, move |store| Ok(authz::on_roster(&store.db, &id)?)).await {
            Ok(true) => {}
            Ok(false) => {
                conn.close(403u32.into(), b"not authorized");
                return false;
            }
            Err(_) => return true,
        }
        let (id, now) = (peer.to_string(), util::now_ms());
        let Ok(entries) = read_db(&self.dir, move |store| inbound::published_for(&store.db, store.version, now, &id)).await else { return true };
        let text = serde_json::to_string(&entries.iter().map(|e| (&e.session_hint, &e.provider, &e.native_id, &e.checkout, &e.scope)).collect::<Vec<_>>()).unwrap_or_default();
        if last_published.as_ref().is_none_or(|(sent, at)| *sent != text || at.elapsed() > REPUBLISH) {
            match request(conn, &Request::Published { entries: entries.clone() }, None).await {
                Ok(_) => *last_published = Some((text, Instant::now())),
                Err(_) => return false,
            }
        }
        self.deposits(conn, peer).await && self.cancels(conn, peer).await && self.receipts(conn, peer).await
    }

    async fn deposits(&self, conn: &Connection, peer: &str) -> bool {
        let (id, now) = (peer.to_string(), util::now_ms());
        let Ok(due) = read_db(&self.dir, move |store| outbox::due_deposits(&store.db, &id, now)).await else { return true };
        for message in due {
            let id = message.message_id.clone();
            if !db(&self.dir, move |store| outbox::begin_attempt(store, &id)).await.unwrap_or(false) {
                continue;
            }
            util::fault("deposit:before-send");
            let frame = Request::Deposit {
                origin_id: message.message_id.clone(),
                recipient: message.recipient,
                body: message.body,
                reply_to: message.reply_to,
                run_hint: message.run_hint,
                span_hint: message.span_hint,
            };
            let Ok(reply) = request(conn, &frame, Some("deposit:after-send")).await else { return false };
            let id = message.message_id;
            let _ = db(&self.dir, move |store| outbox::apply_deposit_reply(store, &id, &reply)).await;
        }
        true
    }

    async fn cancels(&self, conn: &Connection, peer: &str) -> bool {
        let id = peer.to_string();
        let Ok(due) = read_db(&self.dir, move |store| outbox::due_cancels(&store.db, &id)).await else { return true };
        for message_id in due {
            let Ok(reply) = request(conn, &Request::Cancel { origin_id: message_id.clone() }, Some("cancel:after-send")).await else { return false };
            let _ = db(&self.dir, move |store| outbox::apply_cancel_result(store, &message_id, &reply)).await;
        }
        true
    }

    async fn receipts(&self, conn: &Connection, peer: &str) -> bool {
        let (id, now) = (peer.to_string(), util::now_ms());
        let Ok(due) = read_db(&self.dir, move |store| inbound::due_receipts(&store.db, &id, now)).await else { return true };
        for receipt in due {
            let frame = Request::Receipt {
                origin_id: receipt.origin_id,
                recipient_digest: receipt.recipient_digest,
                state: receipt.state,
                reason: receipt.reason,
                seq: receipt.seq,
            };
            let Ok(reply) = request(conn, &frame, Some("receipt:after-send")).await else { return false };
            // Taken, or permanently refused (the sender no longer knows the message): either way, stop offering it.
            if matches!(reply, Reply::Ok {} | Reply::Rejected { retryable: false, .. }) {
                let (message_id, seq) = (receipt.message_id, receipt.seq);
                let _ = db(&self.dir, move |store| inbound::mark_reported(store, &message_id, seq)).await;
            }
        }
        true
    }
}
