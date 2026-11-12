//! Host-routing HTTP reverse proxy. Structure adapted from jdx/pitchfork's proxy (MIT).
#![allow(dead_code)]

use crate::activity::{ActivityGuard, ActivityTracker, GuardedBody};
use crate::model::{Lookup, Routes, RunId};
use bytes::Bytes;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue, ACCEPT, CONNECTION, HOST, RETRY_AFTER, UPGRADE};
use hyper::{Request, Response, StatusCode, Version};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

type Body = UnsyncBoxBody<Bytes, hyper::Error>;

const HOPS_HEADER: &str = "x-setu-hops";
const MAX_HOPS: u32 = 3;
#[cfg(not(test))]
const CONNECT_RETRY: Duration = Duration::from_secs(3);
#[cfg(test)]
const CONNECT_RETRY: Duration = Duration::from_millis(600);
const RETRY_STEP: Duration = Duration::from_millis(250);
const START_WAIT: Duration = Duration::from_secs(60);

struct State {
    routes: Arc<dyn Routes>,
    activity: Arc<ActivityTracker>,
    client: Client<HttpConnector, Incoming>,
}

pub async fn serve(
    listener: TcpListener,
    routes: Arc<dyn Routes>,
    activity: Arc<ActivityTracker>,
) -> anyhow::Result<()> {
    serve_all(vec![listener], routes, activity).await
}

/// Serve every listener (for example one IPv4 and one IPv6 loopback socket) with one routing state.
pub async fn serve_all(
    listeners: Vec<TcpListener>,
    routes: Arc<dyn Routes>,
    activity: Arc<ActivityTracker>,
) -> anyhow::Result<()> {
    let mut connector = HttpConnector::new();
    connector.set_connect_timeout(Some(Duration::from_secs(5)));
    let client = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(30))
        .build(connector);
    let state = Arc::new(State {
        routes,
        activity,
        client,
    });
    let mut listeners = listeners;
    let Some(last) = listeners.pop() else {
        anyhow::bail!("the proxy has no listener");
    };
    for l in listeners {
        tokio::spawn(accept_loop(l, state.clone()));
    }
    accept_loop(last, state).await
}

async fn accept_loop(listener: TcpListener, state: Arc<State>) -> anyhow::Result<()> {
    let local_port = listener.local_addr()?.port();
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        if !is_loopback(peer.ip()) {
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(handle(state, req, peer, local_port).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), svc)
                .with_upgrades()
                .await;
        });
    }
}

/// Wildcard bind, as v1's Caddy did: `0.0.0.0` (required) plus `[::]` with IPV6_V6ONLY on, so
/// `http://name.zone` works whichever address the resolver or browser picks. Two sockets, one
/// per family, because a single dual-stack `[::]` socket on macOS binds happily next to another
/// program's `0.0.0.0:80` (Caddy) instead of reporting the port as taken. The IPv6 socket is
/// best effort: a host without IPv6 just serves IPv4. A taken port is reported as is, so the
/// caller can fall back to another port.
pub fn bind_wildcard(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let v4 = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port))?;
    v4.set_nonblocking(true)?;
    let port = v4.local_addr()?.port();
    let mut out = vec![TcpListener::from_std(v4)?];
    if let Ok(v6) = bind_v6_only(port) {
        out.push(v6);
    }
    Ok(out)
}

fn bind_v6_only(port: u16) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    sock.set_only_v6(true)?;
    sock.set_reuse_address(true)?;
    sock.bind(&SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
    sock.listen(1024)?;
    sock.set_nonblocking(true)?;
    TcpListener::from_std(sock.into())
}

/// Loopback bind on both families: `127.0.0.1` must work, `::1` is added when the host has it.
pub fn bind_loopback(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let v4 = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))?;
    v4.set_nonblocking(true)?;
    let mut out = vec![TcpListener::from_std(v4)?];
    if let Ok(v6) = std::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)) {
        v6.set_nonblocking(true)?;
        out.push(TcpListener::from_std(v6)?);
    }
    Ok(out)
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

fn page(status: StatusCode, title: &str, msg: &str, refresh: bool) -> Response<Body> {
    let meta = if refresh {
        "<meta http-equiv=\"refresh\" content=\"2\">"
    } else {
        ""
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{meta}<title>{t}</title></head>\
         <body style=\"font-family:system-ui;margin:3em\"><h1>{t}</h1><p>{m}</p></body></html>",
        t = esc(title),
        m = esc(msg)
    );
    let mut b = Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store");
    if refresh {
        b = b.header(RETRY_AFTER, "2");
    }
    b.body(full(html)).unwrap()
}

fn boxed<B>(b: B) -> Body
where
    B: hyper::body::Body<Data = Bytes, Error = hyper::Error> + Send + 'static,
{
    b.boxed_unsync()
}

fn full(b: impl Into<Bytes>) -> Body {
    Full::new(b.into()).map_err(|n| match n {}).boxed_unsync()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn request_host(req: &Request<Incoming>) -> Option<String> {
    let raw = req
        .headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()))?;
    Some(strip_port(&raw).to_ascii_lowercase())
}

fn strip_port(h: &str) -> &str {
    if h.starts_with('[') {
        return h.find(']').map_or(h, |i| &h[..=i]);
    }
    match h.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => h,
    }
    .trim_end_matches('.')
}

async fn handle(
    st: Arc<State>,
    req: Request<Incoming>,
    peer: SocketAddr,
    local_port: u16,
) -> Response<Body> {
    let hops = req
        .headers()
        .get(HOPS_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(0);
    if hops >= MAX_HOPS {
        // 508 Loop Detected
        return page(
            StatusCode::LOOP_DETECTED,
            "Proxy loop",
            "Request passed through Setu too many times.",
            false,
        );
    }
    let Some(host) = request_host(&req) else {
        return page(
            StatusCode::BAD_REQUEST,
            "Missing Host header",
            "No Host header.",
            false,
        );
    };

    let mut pending: Option<RunId> = None;
    match st.routes.lookup(&host) {
        Lookup::Up { run, port } => match st.activity.begin(&run) {
            Some(g) => return forward(&st, req, peer, local_port, &run, port, g).await,
            None => pending = Some(run),
        },
        Lookup::Starting { run } => pending = Some(run),
        Lookup::Preparing { run, installing } => {
            // Two different waits behind the same status: a start that is installing missing
            // dependencies (any worktree), and a newly created worktree running its setup steps.
            let (title, msg) = if installing {
                (format!("Installing dependencies for {run}\u{2026}"), "Installing dependencies for this worktree. This page refreshes when it is ready to start.")
            } else {
                (format!("Setting up {run}\u{2026}"), "Setting up the new worktree. This page refreshes when it is ready to start.")
            };
            return page(StatusCode::SERVICE_UNAVAILABLE, &title, msg, true);
        }
        Lookup::SetupFailed { run } => {
            return page(StatusCode::SERVICE_UNAVAILABLE, &format!("Setup failed for {run}"), &format!("The new worktree's setup did not finish, so it was not started. Fix the cause (see the setup log), then run `setu retry-setup {run}`."), false);
        }
        Lookup::NoServer { run } => {
            return page(StatusCode::SERVICE_UNAVAILABLE, &format!("{run} has no dev server"), &format!("{run} has no dev server configured. Add a [procs.web] to ~/.config/setu/projects/{}.toml", run.project), false);
        }
        Lookup::NoHttp { run } => {
            return page(StatusCode::SERVICE_UNAVAILABLE, &format!("{run} serves no HTTP"), &format!("{run} serves no HTTP: none of its procs has a port. Give a proc `port = \"web\"` in ~/.config/setu/projects/{}.toml to get a URL here.", run.project), false);
        }
        Lookup::Down { run } => {
            if let Err(msg) = st.routes.request_start(&run) {
                return page(
                    StatusCode::SERVICE_UNAVAILABLE,
                    &format!("Cannot start {run}"),
                    &msg,
                    false,
                );
            }
            pending = Some(run);
        }
        Lookup::Unknown => {}
    }
    let Some(run) = pending else {
        return page(
            StatusCode::NOT_FOUND,
            "Not found",
            &format!("No Setu run for {host}"),
            false,
        );
    };

    let wants_html = req
        .headers()
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/html"));
    if wants_html {
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            &format!("Starting {run}\u{2026}"),
            "This page refreshes when the app is ready.",
            true,
        );
    }

    let deadline = tokio::time::Instant::now() + START_WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(RETRY_STEP).await;
        match st.routes.lookup(&host) {
            Lookup::Up { run, port } => {
                if let Some(g) = st.activity.begin(&run) {
                    return forward(&st, req, peer, local_port, &run, port, g).await;
                }
            }
            // The start turned into a failed install: say so now instead of timing out.
            Lookup::SetupFailed { run } => {
                return page(StatusCode::SERVICE_UNAVAILABLE, &format!("Setup failed for {run}"), &format!("Installing dependencies did not finish, so it was not started. Fix the cause (see the setup log), then run `setu retry-setup {run}`."), false);
            }
            _ => {}
        }
    }
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        &format!("{run} did not start"),
        "Timed out waiting for the app to come up.",
        false,
    )
}

const HOP_BY_HOP: [&str; 7] = [
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn connection_tokens(h: &hyper::HeaderMap) -> Vec<String> {
    h.get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

fn strip_hop_by_hop(h: &mut hyper::HeaderMap, keep_upgrade: bool) {
    for t in connection_tokens(h) {
        if keep_upgrade && t == "upgrade" {
            continue;
        }
        if let Ok(n) = HeaderName::from_bytes(t.as_bytes()) {
            h.remove(n);
        }
    }
    for n in HOP_BY_HOP {
        if keep_upgrade && (n == "connection" || n == "upgrade") {
            continue;
        }
        h.remove(n);
    }
}

async fn forward(
    st: &State,
    mut req: Request<Incoming>,
    peer: SocketAddr,
    local_port: u16,
    run: &RunId,
    port: u16,
    guard: ActivityGuard,
) -> Response<Body> {
    let hops = req
        .headers()
        .get(HOPS_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let orig_host = req
        .headers()
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.to_string()))
        .unwrap_or_default();
    let is_upgrade = req.headers().contains_key(UPGRADE)
        && connection_tokens(req.headers())
            .iter()
            .any(|t| t == "upgrade");

    let pq = req
        .uri()
        .path_and_query()
        .map_or("/", |p| p.as_str())
        .to_string();
    *req.version_mut() = Version::HTTP_11;

    let h = req.headers_mut();
    strip_hop_by_hop(h, is_upgrade);
    let spoofed: Vec<HeaderName> = h
        .keys()
        .filter(|k| k.as_str().starts_with("x-forwarded-") || k.as_str() == "forwarded")
        .cloned()
        .collect();
    for k in spoofed {
        h.remove(k);
    }
    if !orig_host.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&orig_host) {
            h.insert(HOST, v.clone());
            h.insert("x-forwarded-host", v);
        }
    }
    h.insert(
        "x-forwarded-for",
        HeaderValue::from_str(&peer.ip().to_string()).unwrap(),
    );
    h.insert("x-forwarded-proto", HeaderValue::from_static("http"));
    h.insert(
        "x-forwarded-port",
        HeaderValue::from_str(&local_port.to_string()).unwrap(),
    );
    h.insert(
        HOPS_HEADER,
        HeaderValue::from_str(&(hops + 1).to_string()).unwrap(),
    );

    let client_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut req));

    // The server may still be binding: wait for the port before sending the (unreplayable) request.
    let Some(fam) = wait_for_port(run, port).await else {
        return page(
            StatusCode::BAD_GATEWAY,
            "Bad gateway",
            &format!("{run} is not answering on port {port}"),
            false,
        );
    };
    let Ok(uri) = format!("http://{}:{port}{pq}", fam.authority_host()).parse() else {
        return page(
            StatusCode::BAD_REQUEST,
            "Bad request",
            "Invalid request target.",
            false,
        );
    };
    *req.uri_mut() = uri;
    let mut resp = match st.client.request(req).await {
        Ok(r) => r,
        Err(e) => {
            let detail = format!("{e:?}");
            eprintln!("setu: proxy to {run} on port {port} failed: {detail}");
            return page(
                StatusCode::BAD_GATEWAY,
                "Bad gateway",
                &format!("{run} did not answer on port {port} ({detail})"),
                false,
            );
        }
    };

    if resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_up) = client_upgrade {
            let upstream_up = hyper::upgrade::on(&mut resp);
            tokio::spawn(async move {
                let _guard = guard;
                if let (Ok(c), Ok(u)) = (client_up.await, upstream_up.await) {
                    let (mut c, mut u) = (TokioIo::new(c), TokioIo::new(u));
                    let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
                }
            });
            return resp.map(|_| Empty::<Bytes>::new().map_err(|n| match n {}).boxed_unsync());
        }
    }
    let (mut parts, body) = resp.into_parts();
    strip_hop_by_hop(&mut parts.headers, false);
    Response::from_parts(parts, boxed(GuardedBody::new(body, guard)))
}

/// Wait for the upstream to accept a connection on either loopback family (IPv4 first); the
/// family that answered decides the request's target.
async fn wait_for_port(run: &RunId, port: u16) -> Option<crate::upstream::Family> {
    crate::upstream::wait(run, port, CONNECT_RETRY, Duration::from_millis(250), RETRY_STEP).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    struct Mock {
        map: Mutex<HashMap<String, Lookup>>,
        start: Mutex<Result<(), String>>,
        starts: AtomicUsize,
    }
    impl Mock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                map: Mutex::new(HashMap::new()),
                start: Mutex::new(Ok(())),
                starts: AtomicUsize::new(0),
            })
        }
        fn set(&self, host: &str, l: Lookup) {
            self.map.lock().unwrap().insert(host.into(), l);
        }
    }
    impl Routes for Mock {
        fn lookup(&self, host: &str) -> Lookup {
            self.map
                .lock()
                .unwrap()
                .get(host)
                .cloned()
                .unwrap_or(Lookup::Unknown)
        }
        fn request_start(&self, _run: &RunId) -> Result<(), String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.start.lock().unwrap().clone()
        }
    }

    fn rid(n: &str) -> RunId {
        RunId {
            project: "p".into(),
            run: n.into(),
        }
    }

    async fn proxy(mock: &Arc<Mock>) -> (u16, Arc<ActivityTracker>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let act = ActivityTracker::new();
        tokio::spawn(serve(l, mock.clone(), act.clone()));
        (port, act)
    }

    /// Upstream: handler maps the request to a response.
    async fn upstream<F>(f: F) -> u16
    where
        F: Fn(Request<Incoming>) -> Response<Body> + Send + Sync + Clone + 'static,
    {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (s, _) = l.accept().await.unwrap();
                let f = f.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |r| {
                        let f = f.clone();
                        async move { Ok::<_, Infallible>(f(r)) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(s), svc)
                        .await;
                });
            }
        });
        port
    }

    fn text(s: impl Into<String>) -> Response<Body> {
        Response::new(full(s.into()))
    }

    async fn raw(port: u16, head: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(head.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn get(host: &str, extra: &str) -> String {
        format!("GET /a?b=1 HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n{extra}\r\n")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_routing() {
        let a = upstream(|_| text("from-a")).await;
        let b = upstream(|_| text("from-b")).await;
        let m = Mock::new();
        m.set(
            "a.test",
            Lookup::Up {
                run: rid("a"),
                port: a,
            },
        );
        m.set(
            "b.test",
            Lookup::Up {
                run: rid("b"),
                port: b,
            },
        );
        let (p, _) = proxy(&m).await;
        assert!(raw(p, &get("a.test", "")).await.ends_with("from-a"));
        assert!(raw(p, &get("B.TEST:7777", "")).await.ends_with("from-b"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forwarded_headers() {
        let u = upstream(|r| {
            let mut s = format!("{} ", r.uri());
            for (k, v) in r.headers() {
                s += &format!("{}={};", k, v.to_str().unwrap());
            }
            text(s)
        })
        .await;
        let m = Mock::new();
        m.set(
            "a.test",
            Lookup::Up {
                run: rid("a"),
                port: u,
            },
        );
        let (p, _) = proxy(&m).await;
        let r = raw(
            p,
            &get(
                "a.test:7777",
                "X-Forwarded-For: 9.9.9.9\r\nForwarded: for=1\r\n",
            ),
        )
        .await;
        assert!(r.contains("/a?b=1 "), "{r}");
        assert!(r.contains("host=a.test:7777;"), "{r}");
        assert!(r.contains("x-forwarded-host=a.test:7777;"), "{r}");
        assert!(r.contains("x-forwarded-for=127.0.0.1;"), "{r}");
        assert!(
            !r.contains("9.9.9.9") && !r.contains("forwarded=for"),
            "{r}"
        );
        assert!(r.contains("x-forwarded-proto=http;"), "{r}");
        assert!(r.contains(&format!("x-forwarded-port={p};")), "{r}");
        assert!(r.contains("x-setu-hops=1;"), "{r}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn loop_guard() {
        let m = Mock::new();
        let (p, _) = proxy(&m).await;
        let r = raw(p, &get("a.test", "x-setu-hops: 3\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 508"), "{r}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streaming() {
        let u = upstream(|_| {
            let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(4);
            tokio::spawn(async move {
                let _ = tx.send(Bytes::from("first-chunk")).await;
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let _ = tx.send(Bytes::from("last-chunk")).await;
            });
            Response::new(ChanBody(rx).boxed_unsync())
        })
        .await;
        let m = Mock::new();
        m.set(
            "a.test",
            Lookup::Up {
                run: rid("a"),
                port: u,
            },
        );
        let (p, act) = proxy(&m).await;
        let mut s = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
        s.write_all(get("a.test", "").as_bytes()).await.unwrap();
        let t0 = std::time::Instant::now();
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        while !String::from_utf8_lossy(&buf).contains("first-chunk") {
            let n = s.read(&mut tmp).await.unwrap();
            assert!(n > 0);
            buf.extend_from_slice(&tmp[..n]);
        }
        assert!(t0.elapsed() < Duration::from_millis(1000));
        assert!(!String::from_utf8_lossy(&buf).contains("last-chunk"));
        assert_eq!(act.snapshot(&rid("a")).in_flight, 1);
        s.read_to_end(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf).contains("last-chunk"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(act.snapshot(&rid("a")).in_flight, 0);
    }

    struct ChanBody(tokio::sync::mpsc::Receiver<Bytes>);
    impl hyper::body::Body for ChanBody {
        type Data = Bytes;
        type Error = hyper::Error;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, hyper::Error>>> {
            self.0
                .poll_recv(cx)
                .map(|o| o.map(|b| Ok(hyper::body::Frame::data(b))))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn upgrade_roundtrip() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return; // port probe
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    assert!(String::from_utf8_lossy(&buf).contains("/_next/webpack-hmr"));
                    s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
                    loop {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        s.write_all(&tmp[..n]).await.unwrap();
                    }
                });
            }
        });
        let m = Mock::new();
        m.set(
            "a.test",
            Lookup::Up {
                run: rid("a"),
                port: up,
            },
        );
        let (p, act) = proxy(&m).await;
        let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
        c.write_all(b"GET /_next/webpack-hmr HTTP/1.1\r\nHost: a.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = c.read(&mut tmp).await.unwrap();
            assert!(n > 0);
            buf.extend_from_slice(&tmp[..n]);
        }
        assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 101"));
        c.write_all(b"hello").await.unwrap();
        let mut echo = [0u8; 5];
        c.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"hello");
        assert_eq!(act.snapshot(&rid("a")).in_flight, 1);
        drop(c);
        for _ in 0..40 {
            if act.snapshot(&rid("a")).in_flight == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("in_flight never returned to 0");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_and_start_errors() {
        let m = Mock::new();
        m.set("d.test", Lookup::Down { run: rid("d") });
        let (p, _) = proxy(&m).await;
        assert!(raw(p, &get("nope.test", ""))
            .await
            .starts_with("HTTP/1.1 404"));
        *m.start.lock().unwrap() = Err("max running reached".into());
        let r = raw(p, &get("d.test", "")).await;
        assert!(
            r.starts_with("HTTP/1.1 503") && r.contains("max running reached"),
            "{r}"
        );
        *m.start.lock().unwrap() = Ok(());
        let r = raw(p, &get("d.test", "Accept: text/html\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 503"), "{r}");
        assert!(
            r.contains("http-equiv=\"refresh\"") && r.to_lowercase().contains("retry-after: 2"),
            "{r}"
        );
        assert_eq!(m.starts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b10_a_preparing_run_shows_a_page_and_is_never_started_on_demand() {
        let m = Mock::new();
        m.set("n.test", Lookup::Preparing { run: rid("n"), installing: false });
        m.set("f.test", Lookup::SetupFailed { run: rid("f") });
        let (p, _) = proxy(&m).await;
        for accept in ["Accept: text/html\r\n", "Accept: */*\r\n"] {
            let r = raw(p, &get("n.test", accept)).await;
            assert!(r.starts_with("HTTP/1.1 503") && r.contains("Setting up p/n") && r.contains("Setting up the new worktree") && !r.contains("Installing"), "{r}");
        }
        let r = raw(p, &get("n.test", "Accept: text/html\r\n")).await;
        assert!(r.contains("http-equiv=\"refresh\""), "a preparing page refreshes: {r}");
        let r = raw(p, &get("f.test", "Accept: text/html\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 503") && r.contains("retry-setup p/f") && !r.contains("http-equiv=\"refresh\""), "{r}");
        assert_eq!(m.starts.load(Ordering::SeqCst), 0, "no on-demand start while preparing or after a failed setup");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn d_the_preparing_page_says_installing_for_an_install_and_setting_up_for_a_new_worktree() {
        let m = Mock::new();
        m.set("i.test", Lookup::Preparing { run: rid("i"), installing: true });
        let (p, _) = proxy(&m).await;
        let r = raw(p, &get("i.test", "Accept: text/html\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 503") && r.contains("Installing dependencies for p/i") && !r.contains("new worktree"), "{r}");
        assert!(r.contains("http-equiv=\"refresh\""), "{r}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn c_a_wildcard_bind_answers_over_ipv6_loopback_and_ipv4() {
        let m = Mock::new();
        let up = upstream(|_| text("hello-from-up")).await;
        m.set("w.test", Lookup::Up { run: rid("w"), port: up });
        let ls = bind_wildcard(0).expect("wildcard bind");
        assert_eq!(ls.len(), 2, "0.0.0.0 and [::]");
        let port = ls[0].local_addr().unwrap().port();
        tokio::spawn(serve_all(ls, m.clone(), ActivityTracker::new()));
        let get_over = |addr: std::net::SocketAddr| async move {
            let mut s = TcpStream::connect(addr).await.unwrap();
            s.write_all(get("w.test", "").as_bytes()).await.unwrap();
            let mut out = Vec::new();
            s.read_to_end(&mut out).await.unwrap();
            String::from_utf8_lossy(&out).into_owned()
        };
        let v6 = get_over(SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))).await;
        assert!(v6.starts_with("HTTP/1.1 200") && v6.ends_with("hello-from-up"), "over ::1: {v6}");
        let v4 = get_over(SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port))).await;
        assert!(v4.ends_with("hello-from-up"), "over 127.0.0.1: {v4}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn c_a_loopback_bind_listens_on_both_families_and_a_wildcard_bind_reports_a_taken_port() {
        let m = Mock::new();
        let up = upstream(|_| text("hello-from-up")).await;
        m.set("w.test", Lookup::Up { run: rid("w"), port: up });
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ls = bind_loopback(free).expect("loopback bind");
        assert_eq!(ls.len(), 2, "127.0.0.1 and ::1");
        tokio::spawn(serve_all(ls, m.clone(), ActivityTracker::new()));
        for addr in [SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, free)), SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, free))] {
            let mut s = TcpStream::connect(addr).await.unwrap();
            s.write_all(get("w.test", "").as_bytes()).await.unwrap();
            let mut out = Vec::new();
            s.read_to_end(&mut out).await.unwrap();
            assert!(String::from_utf8_lossy(&out).ends_with("hello-from-up"), "{addr}");
        }
        // A port held on 0.0.0.0 (as Caddy held :80) is an error, so the daemon can fall back to :7777.
        let held = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        assert!(bind_wildcard(held.local_addr().unwrap().port()).is_err(), "must not share a taken port");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn down_then_up_forwards() {
        let u = upstream(|_| text("alive")).await;
        let m = Mock::new();
        m.set("d.test", Lookup::Down { run: rid("d") });
        let (p, _) = proxy(&m).await;
        let m2 = m.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            m2.set(
                "d.test",
                Lookup::Up {
                    run: rid("d"),
                    port: u,
                },
            );
        });
        let r = raw(p, &get("d.test", "Accept: */*\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 200") && r.ends_with("alive"), "{r}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn activity_during_slow_request() {
        let u = upstream(|_| text("x")).await;
        // Slow upstream via raw socket.
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut tmp = [0u8; 2048];
                    if s.read(&mut tmp).await.unwrap_or(0) == 0 {
                        return; // port probe
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let _ = s
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await;
                });
            }
        });
        let _ = u;
        let m = Mock::new();
        m.set(
            "s.test",
            Lookup::Up {
                run: rid("s"),
                port: slow,
            },
        );
        let (p, act) = proxy(&m).await;
        let h = tokio::spawn(async move { raw(p, &get("s.test", "")).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(act.snapshot(&rid("s")).in_flight, 1);
        assert!(!act.claim_idle_stop(&rid("s"), Duration::ZERO));
        assert!(h.await.unwrap().ends_with("ok"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(act.claim_idle_stop(&rid("s"), Duration::from_millis(10)));
        assert!(act.begin(&rid("s")).is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn upstream_down_502() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = l.local_addr().unwrap().port();
        drop(l);
        let m = Mock::new();
        m.set(
            "a.test",
            Lookup::Up {
                run: rid("a"),
                port: dead,
            },
        );
        let (p, act) = proxy(&m).await;
        let t0 = std::time::Instant::now();
        let r = raw(p, &get("a.test", "")).await;
        assert!(
            r.starts_with("HTTP/1.1 502") && r.contains(&format!("on port {dead}")),
            "{r}"
        );
        assert!(t0.elapsed() >= CONNECT_RETRY);
        assert_eq!(act.snapshot(&rid("a")).in_flight, 0);
    }

    /// A dev server that listens only on `[::1]` (like `mintlify dev`): plain HTTP, and a
    /// websocket-style upgrade that echoes. Returns the child and its port.
    fn v6_only_server() -> (std::process::Child, u16) {
        let script = r#"
import socket, http.server, sys
class S(http.server.HTTPServer):
    address_family = socket.AF_INET6
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.end_headers()
            self.wfile.flush()
            while True:
                d = self.connection.recv(1024)
                if not d: break
                self.connection.sendall(d)
            self.close_connection = True
            return
        b = b"hello-from-v6"
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
s = S(("::1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
"#;
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.as_mut().unwrap()), &mut line).unwrap();
        (child, line.trim().parse().expect("python printed its port"))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn b20_an_upstream_listening_only_on_ipv6_is_reached_for_http_and_upgrade_and_readiness_agrees() {
        let (mut child, port) = v6_only_server();
        let run = rid("v6only");
        // Readiness (the daemon's probe) and the proxy must agree that it is up.
        assert!(crate::supervisor::wait_port(&run, port, Duration::from_secs(3)).await, "readiness");
        assert_eq!(crate::upstream::remembered(&run, port), Some(crate::upstream::Family::V6));
        let m = Mock::new();
        m.set("a.test", Lookup::Up { run: run.clone(), port });
        let (p, _) = proxy(&m).await;
        let r = raw(p, &get("a.test", "")).await;
        assert!(r.starts_with("HTTP/1.1 200") && r.ends_with("hello-from-v6"), "{r}");
        let mut c = TcpStream::connect(("127.0.0.1", p)).await.unwrap();
        c.write_all(b"GET /ws HTTP/1.1\r\nHost: a.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = c.read(&mut tmp).await.unwrap();
            assert!(n > 0, "closed before 101: {}", String::from_utf8_lossy(&buf));
            buf.extend_from_slice(&tmp[..n]);
        }
        assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 101"), "{}", String::from_utf8_lossy(&buf));
        c.write_all(b"hello").await.unwrap();
        let mut echo = [0u8; 5];
        c.read_exact(&mut echo).await.unwrap();
        assert_eq!(&echo, b"hello");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_run_with_no_dev_server_or_no_http_gets_a_plain_page_not_starting_forever() {
        let m = Mock::new();
        m.set("n.test", Lookup::NoServer { run: rid("n") });
        m.set("h.test", Lookup::NoHttp { run: rid("h") });
        let (p, _) = proxy(&m).await;
        let r = raw(p, &get("n.test", "Accept: text/html\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 503") && !r.contains("refresh"), "{r}");
        assert!(r.contains("p/n has no dev server configured. Add a [procs.web] to ~/.config/setu/projects/p.toml"), "{r}");
        assert!(!r.contains("Starting"), "{r}");
        let r = raw(p, &get("h.test", "Accept: text/html\r\n")).await;
        assert!(r.contains("p/h serves no HTTP") && !r.contains("refresh") && !r.contains("Starting"), "{r}");
        assert_eq!(m.starts.load(Ordering::SeqCst), 0);
    }
}
