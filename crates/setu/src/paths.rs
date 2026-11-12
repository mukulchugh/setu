//! Where Setu keeps things. `SETU_HOME` puts everything under one root (tests, sandboxes).

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn root_override() -> Option<PathBuf> {
    std::env::var_os("SETU_HOME").map(PathBuf::from)
}

/// `~/.config/setu`
pub fn config_dir() -> PathBuf {
    root_override().map(|r| r.join("config")).unwrap_or_else(|| home().join(".config/setu"))
}

/// `~/.config/setu/projects/<project>.toml`
pub fn projects_dir() -> PathBuf {
    config_dir().join("projects")
}

/// `~/.config/setu/env/global.toml` and `~/.config/setu/env/<project>/<run>.toml`
pub fn env_dir() -> PathBuf {
    config_dir().join("env")
}

/// `~/Library/Application Support/Setu`: `setu.db` and the socket.
pub fn state_dir() -> PathBuf {
    root_override().map(|r| r.join("state")).unwrap_or_else(|| home().join("Library/Application Support/Setu"))
}

/// `~/.local/share/setu/archive/<project>/<run>/<ts>.tar`
pub fn archive_dir() -> PathBuf {
    root_override().map(|r| r.join("archive")).unwrap_or_else(|| home().join(".local/share/setu/archive"))
}

/// Unix socket. macOS sun_path is 104 bytes including NUL; `api` checks the length.
pub fn socket_path() -> PathBuf {
    state_dir().join("d.sock")
}

/// `~/Library/Logs/Setu/<project>/<run>/<proc>.log`
pub fn logs_dir() -> PathBuf {
    root_override().map(|r| r.join("logs")).unwrap_or_else(|| home().join("Library/Logs/Setu"))
}

/// Expand a leading `~/`.
pub fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None if p == "~" => home(),
        None => PathBuf::from(p),
    }
}
