//! Strict request arguments. Errors name only the field, never the value: a message body must not
//! reach an error string.

use serde_json::{Map, Value};

#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl Fail {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Fail { code, message: message.into(), retryable: false, details: None }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(error: rusqlite::Error) -> Self {
        // SQLite messages can quote row values; report only the failure class.
        let busy = matches!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        );
        if busy {
            Fail::new("STORE_BUSY", "the store is busy; retry").retryable()
        } else {
            Fail::new("STORE_FAILURE", "the store could not complete the operation")
        }
    }
}

pub struct Args(Map<String, Value>);

fn invalid(key: &str) -> Fail {
    Fail::new("REQUEST_INVALID", format!("field `{key}` is missing or invalid"))
}

impl Args {
    pub fn new(value: Value) -> Result<Self, Fail> {
        match value {
            Value::Object(map) => Ok(Args(map)),
            _ => Err(Fail::new("REQUEST_INVALID", "arguments must be an object")),
        }
    }

    pub fn string(&mut self, key: &str, max: usize) -> Result<String, Fail> {
        self.bounded(key, max, "FIELD_TOO_LARGE")
    }

    /// A non-empty string of at most `max` bytes; anything longer fails with `too_large`.
    pub fn bounded(&mut self, key: &str, max: usize, too_large: &'static str) -> Result<String, Fail> {
        match self.0.remove(key) {
            Some(Value::String(s)) if !s.is_empty() && s.len() <= max => Ok(s),
            Some(Value::String(s)) if s.len() > max => Err(Fail::new(too_large, format!("field `{key}` is too large"))),
            _ => Err(invalid(key)),
        }
    }

    pub fn optional_string(&mut self, key: &str, max: usize) -> Result<Option<String>, Fail> {
        match self.0.get(key) {
            None | Some(Value::Null) => {
                self.0.remove(key);
                Ok(None)
            }
            Some(_) => self.string(key, max).map(Some),
        }
    }

    pub fn optional_object(&mut self, key: &str) -> Result<Option<Args>, Fail> {
        match self.0.get(key) {
            None | Some(Value::Null) => {
                self.0.remove(key);
                Ok(None)
            }
            Some(_) => self.object(key).map(Some),
        }
    }

    pub fn object(&mut self, key: &str) -> Result<Args, Fail> {
        match self.0.remove(key) {
            Some(value @ Value::Object(_)) => Args::new(value),
            _ => Err(invalid(key)),
        }
    }

    /// Any field nobody asked for is refused, so a caller cannot smuggle in behaviour (such as a wake flag).
    pub fn finish(self) -> Result<(), Fail> {
        match self.0.keys().next() {
            None => Ok(()),
            Some(key) => Err(Fail::new("FIELD_UNSUPPORTED", format!("field `{}` is not supported", crate::util::one_line(key, 40)))),
        }
    }
}
