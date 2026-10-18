//! The `setu-links/1` operation protocol: one JSON request in, one JSON reply out.

use crate::{
    args::{Args, Fail},
    mailbox, sharing,
    store::{SCHEMA_VERSION, Store},
};
use serde_json::{Value, json};
use std::path::Path;

pub const PROTOCOL: &str = "setu-links/1";
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

fn reply(id: &Value, outcome: Result<Value, Fail>) -> Value {
    match outcome {
        Ok(result) => json!({ "protocol": PROTOCOL, "id": id, "ok": true, "result": result }),
        Err(fail) => {
            let mut error = json!({ "code": fail.code, "message": fail.message, "retryable": fail.retryable });
            if let Some(details) = fail.details {
                error["details"] = details;
            }
            json!({ "protocol": PROTOCOL, "id": id, "ok": false, "error": error })
        }
    }
}

pub fn handle(data_dir: &Path, request: &str) -> Value {
    if request.len() > MAX_REQUEST_BYTES {
        return reply(&Value::Null, Err(Fail::new("REQUEST_TOO_LARGE", "the request is too large")));
    }
    let parsed: Value = match serde_json::from_str(request) {
        Ok(value) => value,
        Err(_) => return reply(&Value::Null, Err(Fail::new("REQUEST_INVALID", "the request is not valid JSON"))),
    };
    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    reply(&id, dispatch(data_dir, parsed))
}

/// A read opens the store only if one exists; it never creates one.
fn reader(data_dir: &Path) -> Result<Option<Store>, Fail> {
    match Store::open_existing(data_dir) {
        Ok(store) => Ok(Some(store)),
        Err(fail) if fail.code == "STORE_ABSENT" => Ok(None),
        Err(fail) => Err(fail),
    }
}

fn dispatch(data_dir: &Path, request: Value) -> Result<Value, Fail> {
    let mut envelope = Args::new(request)?;
    let protocol = envelope.string("protocol", 32)?;
    if protocol != PROTOCOL {
        return Err(Fail::new("PROTOCOL_INCOMPATIBLE", "unsupported protocol")
            .with(json!({ "supported": [PROTOCOL], "engine_version": env!("CARGO_PKG_VERSION"), "schema_version": SCHEMA_VERSION })));
    }
    let _ = envelope.optional_string("id", 128)?;
    let op = envelope.string("op", 32)?;
    let args = envelope.object("args")?;
    envelope.finish()?;
    match op.as_str() {
        "send" => {
            let request = mailbox::parse_send(args)?;
            // A principal other than the local user needs a readable policy that admits its project. A
            // refusal is decided on a read (with no store there is no policy), so it creates, migrates and
            // writes nothing; the write checks again inside its own transaction.
            if request.needs_policy() {
                match reader(data_dir)? {
                    Some(store) => mailbox::admit(&store.db, store.version, request.project())?,
                    None => return Err(sharing::not_shared(request.project())),
                }
            }
            mailbox::send(&mut Store::open_or_create(data_dir)?, request)
        }
        "claim" => {
            let request = mailbox::parse_claim(args)?;
            // With no store there is no mail, and a claim must not be what creates one.
            if reader(data_dir)?.is_none() {
                return Ok(json!({ "attempt_id": null, "messages": [], "text": "" }));
            }
            mailbox::claim(&mut Store::open_or_create(data_dir)?, request)
        }
        "confirm" => {
            let request = mailbox::parse_confirm(args)?;
            mailbox::confirm(&mut Store::open_or_create(data_dir)?, request)
        }
        "acknowledge" => {
            let request = mailbox::parse_acknowledge(args)?;
            mailbox::acknowledge(&mut Store::open_or_create(data_dir)?, request)
        }
        "redeliver" => {
            let request = mailbox::parse_redeliver(args)?;
            mailbox::redeliver(&mut Store::open_or_create(data_dir)?, request)
        }
        "reconcile" => {
            let current = mailbox::parse_reconcile(args)?;
            // With no store there is nothing to hold or restore, and a report must not create one.
            if reader(data_dir)?.is_none() {
                return Ok(json!({ "held": [], "released": [] }));
            }
            mailbox::reconcile(&mut Store::open_or_create(data_dir)?, current)
        }
        "cancel" => {
            let request = mailbox::parse_cancel(args)?;
            mailbox::cancel(&mut Store::open_or_create(data_dir)?, request)
        }
        "sweep" => mailbox::sweep(&mut Store::open_or_create(data_dir)?, args),
        "share_enable" => {
            let request = sharing::parse_enable(args)?;
            sharing::enable(&mut Store::open_or_create(data_dir)?, request)
        }
        "share_disable" => {
            let project = sharing::parse_disable(args)?;
            // With no policy to withdraw there is nothing to change, and a withdrawal must not be what
            // creates or migrates a store.
            match reader(data_dir)? {
                Some(store) if sharing::has_row(&store, &project)? => {}
                _ => return Ok(json!({ "project": project, "removed": false, "held": [] })),
            }
            sharing::disable(&mut Store::open_or_create(data_dir)?, project)
        }
        "presence_publish" => {
            let request = sharing::parse_publish(args)?;
            // Presence exists only for a shared project, so with no store there is nothing to publish into.
            if reader(data_dir)?.is_none() {
                return Err(sharing::not_shared(request.project()));
            }
            sharing::publish(&mut Store::open_or_create(data_dir)?, request)
        }
        "directory" => sharing::directory(reader(data_dir)?.as_ref(), args),
        "share_status" => sharing::status(reader(data_dir)?.as_ref(), args),
        "status" => mailbox::status(reader(data_dir)?.as_ref(), args),
        "show" => mailbox::show(reader(data_dir)?.as_ref(), args),
        "list" => mailbox::list(reader(data_dir)?.as_ref(), args),
        "health" => {
            args.finish()?;
            Ok(json!({
                "protocol": PROTOCOL,
                "engine_version": env!("CARGO_PKG_VERSION"),
                "schema_version": SCHEMA_VERSION,
                "store": if reader(data_dir)?.is_some() { "ready" } else { "absent" },
            }))
        }
        _ => Err(Fail::new("UNKNOWN_OP", "unknown operation")),
    }
}
