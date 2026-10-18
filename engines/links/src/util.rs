use sha2::{Digest, Sha256};

/// Milliseconds since the Unix epoch. A `test-hooks` build can pin the clock; a shipped build cannot.
pub fn now_ms() -> i64 {
    #[cfg(feature = "test-hooks")]
    if let Some(ms) = std::env::var("SETU_LINKS_TEST_NOW_MS").ok().and_then(|v| v.parse().ok()) {
        return ms;
    }
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A random identifier such as `m_3f9c…`: the prefix says what it names, the rest is 128 random bits.
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    let mut id = format!("{prefix}_");
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    id
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Peer-supplied text as one printable line: no control characters, at most `max` characters.
pub fn one_line(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Peer-supplied text with control characters (escape sequences) removed, keeping newlines and tabs.
pub fn printable(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect()
}

/// A deterministic kill point for contract tests: a `test-hooks` build aborts here when asked to, like a
/// SIGKILL would. A shipped build has no such code.
pub fn fault(point: &str) {
    #[cfg(feature = "test-hooks")]
    if std::env::var("SETU_LINKS_TEST_KILL_AT").as_deref() == Ok(point) {
        std::process::abort();
    }
    let _ = point;
}
