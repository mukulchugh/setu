//! The peer wire: length-prefixed JSON frames, one request and one reply per stream. Every shape is strict
//! (unknown fields are refused) and bounded, so a peer cannot smuggle in a field such as a wake flag, and
//! nothing a peer sends is trusted for anything but what it literally is.

use crate::{mailbox::Recipient, util};
use rusqlite::functions::FunctionFlags;
use iroh::endpoint::{RecvStream, SendStream};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::time::Duration;

/// The transport family. The version travels inside `Hello`, so an incompatible peer is told why.
pub const ALPN: &[u8] = b"setu-links/transport";
/// The one wire version. Version 2 addresses conversations by opaque address only (see `address`); version 1
/// carried the local canonical form and is refused by name.
pub const VERSIONS: [u32; 1] = [2];
pub const CAPABILITIES: [&str; 4] = ["cancel", "deposit", "published", "receipt"];
/// Large enough for a maximum body written entirely as JSON escapes, small enough to refuse a flood.
pub const MAX_FRAME: usize = 128 * 1024;
pub const IO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Locator {
    pub provider: String,
    pub native_id: String,
    pub checkout: String,
    pub session_hint: String,
}

impl From<&Recipient> for Locator {
    fn from(r: &Recipient) -> Self {
        Locator { provider: r.provider.clone(), native_id: r.native_id.clone(), checkout: r.checkout.clone(), session_hint: r.session_hint.clone() }
    }
}

impl From<Locator> for Recipient {
    fn from(l: Locator) -> Self {
        Recipient { provider: l.provider, native_id: l.native_id, checkout: l.checkout, session_hint: l.session_hint }
    }
}

const ADDRESS_PREFIX: &str = "w1:";

fn hashed(domain: &str, parts: &[&str]) -> String {
    let mut text = String::from(domain);
    for part in parts {
        text.push('\0');
        text.push_str(part);
    }
    format!("{ADDRESS_PREFIX}{}", util::sha256_hex(&text))
}

/// The wire address of a conversation: the native conversation id and the checkout, each as a one-way,
/// domain-separated SHA-256, so neither a provider id nor a path leaves the machine. They are stable pseudonyms,
/// not encryption and not authentication: a peer can tell that two addresses are equal, nothing more. The
/// receiver compares the address of its own trusted conversation with the one it was sent; it keeps no table of
/// addresses.
pub fn address(provider: &str, native_id: &str, checkout: &str) -> (String, String) {
    (hashed("setu-links/wire/native/1", &[provider, native_id]), hashed("setu-links/wire/checkout/1", &[checkout]))
}

/// Whether a field is shaped like an address component, and so cannot be a path or a provider id.
pub fn is_address_part(text: &str) -> bool {
    text.strip_prefix(ADDRESS_PREFIX).is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// A provider label: short, plain, not private.
pub fn valid_provider(provider: &str) -> bool {
    (1..=64).contains(&provider.len()) && provider.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// Makes the one address function available to SQL, so stored recipients can be matched against a trusted
/// conversation in the same statement without a second copy of the encoding.
pub fn register(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("setu_wire_native", 2, flags, |ctx| {
        let (provider, native_id): (String, String) = (ctx.get(0)?, ctx.get(1)?);
        Ok(address(&provider, &native_id, "").0)
    })?;
    db.create_scalar_function("setu_wire_checkout", 1, flags, |ctx| {
        let checkout: String = ctx.get(0)?;
        Ok(address("", "", &checkout).1)
    })
}

/// What a receipt must name to count: the exact recipient the message was addressed to.
pub fn recipient_digest(r: &Locator) -> String {
    util::sha256_hex(&serde_json::json!({ "checkout": r.checkout, "native_id": r.native_id, "provider": r.provider, "session_hint": r.session_hint }).to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Published {
    pub session_hint: String,
    pub provider: String,
    pub native_id: String,
    pub checkout: String,
    /// The receiver's opaque sharing scope, never its local project name.
    pub scope: String,
    /// How long the sender may rely on this entry, counted by the sender's own clock from receipt.
    pub ttl_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Is this connection still alive? Answered before `Hello`, carries and reveals nothing.
    Ping {},
    Hello { versions: Vec<u32>, capabilities: Vec<String>, engine_version: String, schema_version: i64 },
    Deposit { origin_id: String, recipient: Locator, body: String, reply_to: Option<String>, run_hint: Option<String>, span_hint: Option<String> },
    Cancel { origin_id: String },
    Receipt { origin_id: String, recipient_digest: String, state: String, reason: Option<String>, seq: i64 },
    Published { entries: Vec<Published> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    HelloOk { version: u32, capabilities: Vec<String> },
    Deposited { state: String, reason: Option<String>, seq: i64, replayed: bool },
    CancelResult { result: String, state: String, reason: Option<String> },
    Ok {},
    Rejected { code: String, retryable: bool, supported: Option<Vec<u32>> },
    Busy { retry_after_ms: u64 },
}

impl From<crate::args::Fail> for Reply {
    fn from(fail: crate::args::Fail) -> Reply {
        Reply::rejected(fail.code, fail.retryable)
    }
}

impl Reply {
    pub fn rejected(code: &str, retryable: bool) -> Reply {
        Reply::Rejected { code: code.to_string(), retryable, supported: None }
    }
}

/// The seven delivery states a recipient's engine can report. The only list: receipts, deposit answers and cancel
/// answers are all checked against it before anything a peer said is stored or shown.
pub const DELIVERY_STATES: [&str; 7] = ["queued", "held", "handoff-unknown", "handed-off", "acknowledged", "expired", "cancelled"];
/// Sequence numbers are whole numbers a JSON number carries exactly.
pub const MAX_SEQ: i64 = 1 << 53;

pub fn valid_state(state: &str) -> bool {
    DELIVERY_STATES.contains(&state)
}

/// A reason is one short printable line.
pub fn valid_reason(reason: &Option<String>) -> bool {
    reason.as_deref().is_none_or(|r| !r.is_empty() && r.chars().count() <= 128 && !r.chars().any(char::is_control))
}

pub fn valid_seq(seq: i64) -> bool {
    (0..=MAX_SEQ).contains(&seq)
}

/// A stable code: upper-case words joined by underscores.
pub fn valid_code(code: &str) -> bool {
    (1..=64).contains(&code.len()) && code.starts_with(|c: char| c.is_ascii_uppercase()) && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

impl Reply {
    /// A peer's reply, held to the vocabulary and bounds before anyone stores or shows it. One that is not is
    /// replaced by a retryable `PEER_REPLY_INVALID`, so the sender's message stays readable and is tried again.
    pub fn checked(self) -> Reply {
        let sound = match &self {
            Reply::Deposited { state, reason, seq, .. } => valid_state(state) && valid_reason(reason) && valid_seq(*seq),
            // A cancel answer must agree with itself: "cancelled" says the message is cancelled, "refused" says it is something else.
            Reply::CancelResult { result, state, reason } => {
                ((result == "cancelled" && state == "cancelled") || (result == "refused" && state != "cancelled")) && valid_state(state) && valid_reason(reason)
            }
            Reply::Rejected { code, supported, .. } => valid_code(code) && supported.as_ref().is_none_or(|v| v.len() <= 8),
            Reply::HelloOk { .. } | Reply::Ok {} | Reply::Busy { .. } => true,
        };
        if sound { self } else { Reply::rejected("PEER_REPLY_INVALID", true) }
    }
}

#[derive(Debug)]
pub enum WireError {
    Io,
    TooLarge,
    Malformed,
}

pub async fn write_frame<T: Serialize>(send: &mut SendStream, value: &T) -> Result<(), WireError> {
    let data = serde_json::to_vec(value).map_err(|_| WireError::Malformed)?;
    if data.len() > MAX_FRAME {
        return Err(WireError::TooLarge);
    }
    send.write_all(&(data.len() as u32).to_be_bytes()).await.map_err(|_| WireError::Io)?;
    send.write_all(&data).await.map_err(|_| WireError::Io)
}

pub async fn read_frame<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T, WireError> {
    let read = async {
        let mut len = [0u8; 4];
        recv.read_exact(&mut len).await.map_err(|_| WireError::Io)?;
        let length = u32::from_be_bytes(len) as usize;
        // The length is refused before any buffer of that size exists.
        if length > MAX_FRAME {
            return Err(WireError::TooLarge);
        }
        let mut buffer = vec![0; length];
        recv.read_exact(&mut buffer).await.map_err(|_| WireError::Io)?;
        serde_json::from_slice(&buffer).map_err(|_| WireError::Malformed)
    };
    tokio::time::timeout(IO_TIMEOUT, read).await.map_err(|_| WireError::Io)?
}
