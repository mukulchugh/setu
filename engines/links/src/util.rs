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

/// Words that stand where text was removed; a label that carries only these has nothing left to hide.
const MARKERS: [&str; 3] = ["[REDACTED]", "[path]", "[env]"];

fn is_secret_like(core: &str) -> bool {
    let lower = core.to_ascii_lowercase();
    lower.starts_with("-----begin")
        || (lower.starts_with("sk-") && core.len() >= 15)
        || (["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].iter().any(|p| lower.starts_with(p)) && core.len() >= 24)
        || (lower.starts_with("github_pat_") && core.len() >= 31)
        || (core.len() == 20 && core.starts_with("AKIA") && core.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
}

fn is_env_like(core: &str) -> bool {
    let bytes = core.as_bytes();
    let reference = bytes.windows(2).any(|pair| pair[0] == b'$' && (pair[1].is_ascii_alphabetic() || matches!(pair[1], b'_' | b'{' | b'(')));
    let windows_variable = core.find('%').is_some_and(|start| {
        core[start + 1..].find('%').is_some_and(|len| {
            let name = &core[start + 1..start + 1 + len];
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
    });
    let assignment = core.split_once('=').is_some_and(|(name, value)| {
        !value.is_empty() && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    });
    reference || windows_variable || assignment
}

fn is_path_like(core: &str) -> bool {
    let bytes = core.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\');
    let separators = core.matches('/').count();
    let extension = core.rsplit('/').next().is_some_and(|last| {
        last.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && (1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()))
    });
    core.starts_with('/')
        || core.starts_with('~')
        || core.starts_with("./")
        || core.starts_with("../")
        || drive
        || core.contains('\\')
        || separators >= 2
        || (separators == 1 && extension)
}

/// Whether a short public label (an owner, a task) carries a file path, an environment reference or a
/// secret. The check is conservative and word-based: it looks for the shapes, never for particular values,
/// and reads nothing but the label. Text a caller already replaced with `[path]`, `[env]` or `[REDACTED]`
/// passes.
pub fn unsafe_label(label: &str) -> bool {
    let mut text = label.to_string();
    for marker in MARKERS {
        text = text.replace(marker, " ");
    }
    let words: Vec<&str> = text
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '"' | '\'' | '`' | ',' | ';' | '!' | '?')))
        .filter(|word| !word.is_empty())
        .collect();
    words.iter().enumerate().any(|(index, word)| {
        let core = word.trim_end_matches(['.', ':']);
        is_path_like(core)
            || is_env_like(core)
            || is_secret_like(core)
            || (core.eq_ignore_ascii_case("bearer") && words.get(index + 1).is_some())
    })
}
