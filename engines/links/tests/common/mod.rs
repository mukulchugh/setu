// Drives the real `setu-links` binary: one process per operation, JSON in and out, as production does.
#![allow(dead_code)]

use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU32, Ordering},
};

static NEXT: AtomicU32 = AtomicU32::new(0);

pub struct Engine {
    pub dir: PathBuf,
    owned: bool,
}

pub fn recipient(native_id: &str) -> Value {
    json!({
        "provider": "claude-code",
        "native_id": native_id,
        "checkout": "{\"path\":\"/work/repo\",\"incarnation\":\"c1\"}",
        "session_hint": "session-1",
    })
}

pub fn send_args(key: &str, body: &str, native_id: &str) -> Value {
    json!({
        "idempotency_key": key,
        "sender": { "kind": "user" },
        "recipient": recipient(native_id),
        "body": body,
    })
}

impl Engine {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "setu-links-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        Engine { dir, owned: true }
    }

    /// The data directory is the persistent state; a second `Engine` over it is a restarted engine.
    pub fn at(dir: &Path) -> Self {
        Engine { dir: dir.to_path_buf(), owned: false }
    }

    pub fn raw(&self, input: &str, env: &[(&str, &str)]) -> (Value, std::process::ExitStatus, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_setu-links"));
        cmd.arg("--data-dir").arg(&self.dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn engine");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
        (value, out.status, String::from_utf8_lossy(&out.stderr).to_string())
    }

    pub fn call_env(&self, op: &str, args: Value, env: &[(&str, &str)]) -> Value {
        let request = json!({ "protocol": "setu-links/1", "id": "t", "op": op, "args": args });
        self.raw(&request.to_string(), env).0
    }

    pub fn call(&self, op: &str, args: Value) -> Value {
        self.call_env(op, args, &[])
    }

    pub fn ok(&self, op: &str, args: Value) -> Value {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], true, "{op} failed: {reply}");
        reply["result"].clone()
    }

    pub fn err(&self, op: &str, args: Value) -> String {
        let reply = self.call(op, args);
        assert_eq!(reply["ok"], false, "{op} unexpectedly succeeded: {reply}");
        reply["error"]["code"].as_str().unwrap().to_string()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}
