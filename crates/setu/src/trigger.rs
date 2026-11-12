//! `setu x trigger-dev`: run the Trigger.dev dev worker for the worktree you are standing in.
//!
//! The Trigger.dev CLI refuses to start when its version differs from the worktree's pinned
//! `@trigger.dev/sdk`, and `--branch` is only valid when the installed `@trigger.dev/core` reads
//! `TRIGGER_DEV_BRANCH`. Both depend on the worktree, so this runs `bunx trigger.dev@<pinned> dev`
//! with the right flags (what v1's portal did when it started the worker).

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Where `@trigger.dev/core` mentions `TRIGGER_DEV_BRANCH` once it supports dev branches.
const PROBES: [&str; 2] = [
    "node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js",
    "node_modules/@trigger.dev/core/dist/commonjs/v3/apiClientManager/index.js",
];

#[derive(Debug, Default, PartialEq)]
pub struct Opts {
    pub max_concurrent_runs: Option<String>,
    pub env_file: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Plan {
    pub version: String,
    /// Arguments for `bunx`.
    pub args: Vec<String>,
    /// Said on stderr before the exec, when the worker shares the default dev environment.
    pub note: Option<String>,
}

/// The pinned version with range markers stripped (`^4.4.6` and `~4.4.6` give `4.4.6`).
pub fn pinned_version(root: &Path) -> Result<String> {
    let file = root.join("package.json");
    let text = std::fs::read_to_string(&file).with_context(|| format!("no package.json in {}: run this from the worktree root", root.display()))?;
    let pkg: Value = serde_json::from_str(&text).with_context(|| format!("{} is not valid JSON", file.display()))?;
    let spec = ["dependencies", "devDependencies"].iter().find_map(|k| pkg.get(k)?.get("@trigger.dev/sdk")?.as_str());
    let Some(spec) = spec else {
        bail!("no @trigger.dev/sdk version pinned in {}: the Trigger.dev CLI must match the worktree's SDK, so there is nothing to run", file.display());
    };
    let v = spec.trim().trim_start_matches(['^', '~', '=', 'v', ' ']);
    if !v.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        bail!("@trigger.dev/sdk is pinned as {spec:?} in {}, which is not a version number; pin an exact version (for example 4.4.6)", file.display());
    }
    Ok(v.to_string())
}

fn supports_branches(root: &Path) -> bool {
    PROBES.iter().any(|p| std::fs::read_to_string(root.join(p)).is_ok_and(|t| t.contains("TRIGGER_DEV_BRANCH")))
}

/// What to run for the worktree at `root`. `env` is the process environment (the branch comes
/// from `TRIGGER_DEV_BRANCH`, then `TRIGGER_PREVIEW_BRANCH`, then `SETU_RUN`).
pub fn plan(root: &Path, env: &dyn Fn(&str) -> Option<String>, opts: &Opts) -> Result<Plan> {
    let version = pinned_version(root)?;
    let mut args = vec![format!("trigger.dev@{version}"), "dev".to_string()];
    if let Some(n) = &opts.max_concurrent_runs {
        args.extend(["--max-concurrent-runs".to_string(), n.clone()]);
    }
    let branch = ["TRIGGER_DEV_BRANCH", "TRIGGER_PREVIEW_BRANCH", "SETU_RUN"].iter().find_map(|k| env(k).filter(|v| !v.trim().is_empty()));
    let mut note = None;
    if !supports_branches(root) {
        note = Some(format!("[setu] @trigger.dev/sdk {version} has no dev-branch support; sharing the default dev environment"));
    } else if let Some(b) = branch {
        args.extend(["--branch".to_string(), b]);
    } else {
        note = Some("[setu] no run name in TRIGGER_DEV_BRANCH or SETU_RUN; sharing the default dev environment".to_string());
    }
    if let Some(f) = &opts.env_file {
        args.extend(["--env-file".to_string(), f.clone()]);
    }
    Ok(Plan { version, args, note })
}

pub fn parse_opts(args: &[String]) -> Result<Opts> {
    let mut o = Opts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--max-concurrent-runs" => {
                let n = it.next().with_context(|| "--max-concurrent-runs needs a number")?;
                if n.parse::<u32>().is_err() {
                    bail!("--max-concurrent-runs needs a number, got {n:?}");
                }
                o.max_concurrent_runs = Some(n.clone());
            }
            "--env-file" => o.env_file = Some(it.next().with_context(|| "--env-file needs a path")?.clone()),
            other => bail!("unknown argument {other}; usage: setu x trigger-dev [--max-concurrent-runs N] [--env-file PATH]"),
        }
    }
    Ok(o)
}

/// `setu x <tool> ...`
pub fn x_main(args: &[String]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    match args.first().map(String::as_str) {
        Some("trigger-dev") => {
            let opts = parse_opts(&args[1..])?;
            let root: PathBuf = std::env::current_dir()?;
            let plan = plan(&root, &|k| std::env::var(k).ok(), &opts)?;
            if let Some(n) = &plan.note {
                eprintln!("{n}");
            }
            let err = std::process::Command::new("bunx").args(&plan.args).exec();
            bail!("could not run bunx ({err}); install Bun, or put bunx on PATH");
        }
        _ => bail!("usage: setu x trigger-dev [--max-concurrent-runs N] [--env-file PATH]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-trigger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }
    fn probe(d: &Path, content: &str) {
        let p = d.join(PROBES[0]);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn version_follows_package_json_with_range_markers_stripped() {
        for (spec, want) in [("^4.4.6", "4.4.6"), ("~4.8.3", "4.8.3"), ("4.8.3", "4.8.3")] {
            let d = tmp("ver");
            std::fs::write(d.join("package.json"), format!(r#"{{"dependencies":{{"@trigger.dev/sdk":"{spec}"}}}}"#)).unwrap();
            assert_eq!(pinned_version(&d).unwrap(), want);
        }
        let d = tmp("dev");
        std::fs::write(d.join("package.json"), r#"{"devDependencies":{"@trigger.dev/sdk":"^4.0.0"}}"#).unwrap();
        assert_eq!(pinned_version(&d).unwrap(), "4.0.0");
    }

    #[test]
    fn branch_is_passed_only_when_the_installed_core_supports_it() {
        let d = tmp("branch");
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"@trigger.dev/sdk":"^4.4.6"}}"#).unwrap();
        let e = env_of(&[("TRIGGER_DEV_BRANCH", "feat-x")]);
        let o = Opts { max_concurrent_runs: Some("2".into()), env_file: Some("apps/a/.env.local".into()) };
        let none = plan(&d, &e, &o).unwrap();
        assert_eq!(none.args, ["trigger.dev@4.4.6", "dev", "--max-concurrent-runs", "2", "--env-file", "apps/a/.env.local"]);
        assert!(none.note.unwrap().contains("no dev-branch support"));
        probe(&d, "const x = process.env.OTHER;");
        assert!(!plan(&d, &e, &o).unwrap().args.contains(&"--branch".to_string()), "a probe without the string means no branch");
        probe(&d, "x = process.env.TRIGGER_DEV_BRANCH;");
        let yes = plan(&d, &e, &o).unwrap();
        assert_eq!(yes.args, ["trigger.dev@4.4.6", "dev", "--max-concurrent-runs", "2", "--branch", "feat-x", "--env-file", "apps/a/.env.local"]);
        assert!(yes.note.is_none());
    }

    #[test]
    fn branch_falls_back_to_the_run_name_and_the_commonjs_probe_counts() {
        let d = tmp("run");
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"@trigger.dev/sdk":"4.8.3"}}"#).unwrap();
        let p = d.join(PROBES[1]);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "TRIGGER_DEV_BRANCH").unwrap();
        let got = plan(&d, &env_of(&[("SETU_RUN", "feat-y")]), &Opts::default()).unwrap();
        assert_eq!(got.args, ["trigger.dev@4.8.3", "dev", "--branch", "feat-y"]);
    }

    #[test]
    fn no_pinned_sdk_is_a_clear_error() {
        let d = tmp("none");
        let e = plan(&d, &env_of(&[]), &Opts::default()).unwrap_err().to_string();
        assert!(e.contains("no package.json"), "{e}");
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"react":"^19"}}"#).unwrap();
        let e = plan(&d, &env_of(&[]), &Opts::default()).unwrap_err().to_string();
        assert!(e.contains("no @trigger.dev/sdk version pinned"), "{e}");
        std::fs::write(d.join("package.json"), r#"{"dependencies":{"@trigger.dev/sdk":"workspace:*"}}"#).unwrap();
        assert!(plan(&d, &env_of(&[]), &Opts::default()).unwrap_err().to_string().contains("not a version number"));
    }

    #[test]
    fn options_parse() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_opts(&a(&["--max-concurrent-runs", "3", "--env-file", "f"])).unwrap(), Opts { max_concurrent_runs: Some("3".into()), env_file: Some("f".into()) });
        assert!(parse_opts(&a(&["--max-concurrent-runs", "x"])).is_err());
        assert!(parse_opts(&a(&["--nope"])).is_err());
    }
}
