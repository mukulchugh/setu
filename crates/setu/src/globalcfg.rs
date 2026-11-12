//! Global settings: `~/.config/setu/config.toml` (proxy port, captured login PATH, DNS port).

use crate::paths;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GlobalConfig {
    pub proxy_port: u16,
    /// Login-shell PATH captured by `setup`; the daemon spawns procs with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Unix seconds when `path` was captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_captured_at: Option<u64>,
    pub dns_port: u16,
    /// `[auto_remove]`: opt-in removal of merged or long-idle worktrees (slice 7, part 2).
    pub auto_remove: AutoRemoveCfg,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        GlobalConfig { proxy_port: 7777, path: None, path_captured_at: None, dns_port: 15353, auto_remove: AutoRemoveCfg::default() }
    }
}

/// `[auto_remove]` in `config.toml`. Durations are `90s`, `30m`, `24h`, `14d`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AutoRemoveCfg {
    pub enabled: bool,
    /// A merged worktree must be idle at least this long.
    pub merged_after: String,
    /// An unmerged worktree must be idle at least this long.
    pub idle_after: String,
    /// How long a candidate stays visible before removal.
    pub grace: String,
    /// At most this many removals per local day.
    pub daily_cap: u32,
}

impl Default for AutoRemoveCfg {
    fn default() -> Self {
        AutoRemoveCfg { enabled: false, merged_after: "24h".into(), idle_after: "14d".into(), grace: "24h".into(), daily_cap: 5 }
    }
}

pub fn config_path() -> PathBuf {
    paths::config_dir().join("config.toml")
}

impl GlobalConfig {
    pub fn load() -> Result<Self> {
        Self::load_from(&config_path())
    }

    #[allow(dead_code)] // used by the app's settings (slice 6)
    pub fn save(&self) -> Result<()> {
        self.save_to(&config_path())
    }

    /// Missing file gives defaults; a corrupt file is an error.
    pub fn load_from(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => toml::from_str(&s).with_context(|| format!("parsing {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(anyhow!(e).context(format!("reading {}", path.display()))),
        }
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        write_atomic_private(path, &toml::to_string_pretty(self)?)
    }
}

/// Write `contents` to `path` via a temp file and rename, mode 0600, creating parent dirs.
pub fn write_atomic_private(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp{}", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let res = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.with_context(|| format!("writing {}", path.display()))
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Run `$SHELL -lic 'printf %s "$PATH"'` (10 s timeout) and return the PATH.
pub fn capture_login_path() -> Result<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    capture_with(&shell, Duration::from_secs(10))
}

fn capture_with(shell: &str, timeout: Duration) -> Result<String> {
    let mut child = Command::new(shell)
        .args(["-lic", r#"printf %s "$PATH""#])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("starting {shell}"))?;
    let mut out = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    // The reader hands its bytes over a channel so the wait below can be bounded: a background
    // child that inherited the pipe must not outlive the timeout (review #19).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let start = Instant::now();
    loop {
        match child.try_wait()? {
            Some(_) => break,
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("{shell} did not print PATH within {}s", timeout.as_secs());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let left = timeout.saturating_sub(start.elapsed()).max(Duration::from_secs(1));
    let buf = rx.recv_timeout(left).map_err(|_| anyhow!("{shell} exited but its output pipe stayed open past the timeout"))?;
    parse_path_output(&String::from_utf8_lossy(&buf))
}

/// Interactive shells may print banners first; the PATH is the last line.
fn parse_path_output(stdout: &str) -> Result<String> {
    let last = stdout.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if !last.contains(':') || !last.contains('/') {
        bail!("login shell printed no usable PATH (got {:?})", last.chars().take(80).collect::<String>());
    }
    Ok(last.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-gcfg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_is_default() {
        let d = tmp("missing");
        let c = GlobalConfig::load_from(&d.join("config.toml")).unwrap();
        assert_eq!(c, GlobalConfig::default());
        assert_eq!((c.proxy_port, c.dns_port), (7777, 15353));
    }

    #[test]
    fn corrupt_is_error() {
        let d = tmp("corrupt");
        std::fs::write(d.join("config.toml"), "proxy_port = [").unwrap();
        assert!(GlobalConfig::load_from(&d.join("config.toml")).is_err());
    }

    #[test]
    fn partial_file_fills_defaults_and_roundtrips_0600() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("rt");
        let p = d.join("sub/config.toml");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "proxy_port = 80\n").unwrap();
        let mut c = GlobalConfig::load_from(&p).unwrap();
        assert_eq!((c.proxy_port, c.dns_port), (80, 15353));
        c.path = Some("/a:/b".into());
        c.path_captured_at = Some(42);
        c.save_to(&p).unwrap();
        assert_eq!(GlobalConfig::load_from(&p).unwrap(), c);
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn takes_last_line_and_validates() {
        assert_eq!(parse_path_output("Welcome!\n/usr/bin:/bin\n").unwrap(), "/usr/bin:/bin");
        assert!(parse_path_output("nothing\n").is_err());
        assert!(parse_path_output("").is_err());
        assert!(parse_path_output("a:b").is_err());
    }

    #[test]
    fn capture_with_real_shell_and_timeout() {
        let p = capture_with("/bin/sh", Duration::from_secs(10)).unwrap();
        assert!(p.contains(':') && p.contains('/'));
        // a shell that never exits times out
        let d = tmp("hang");
        let sh = d.join("hang.sh");
        std::fs::write(&sh, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(capture_with(sh.to_str().unwrap(), Duration::from_millis(300)).is_err());
    }
}

/// Proxy port for this process (read once). URLs omit the port when it is 80.
pub fn proxy_port() -> u16 {
    static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    *PORT.get_or_init(|| GlobalConfig::load().map(|c| c.proxy_port).unwrap_or(7777))
}

/// The login-shell PATH captured by `setu-rs setup`, read fresh so a re-run applies at the next spawn.
pub fn login_path() -> Option<String> {
    GlobalConfig::load().ok().and_then(|c| c.path)
}
