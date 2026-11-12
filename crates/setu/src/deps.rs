//! Missing-dependency detection for starts: a deps item whose path is gone (the old cleanup removed
//! `node_modules`, say) is restored with the item's frozen install command before the procs start.

use crate::model::{DiskKind, ProjectConfig, SetupStep};
use std::path::Path;

/// What a start has to do about dependencies.
#[derive(Debug, PartialEq)]
pub enum Need {
    /// Everything is there, the project opted out, or an explicit `[setup]` section owns installation.
    Nothing,
    /// Run these install steps first.
    Install(Vec<SetupStep>),
    /// Something is missing and cannot be restored safely; the string is the run's note.
    Blocked(String),
}

/// Cheap presence check: the directory exists (symlinks followed) and has at least one entry.
/// Reads one directory entry; never walks the tree. Call it off the async threads.
fn present(p: &Path) -> bool {
    std::fs::read_dir(p).is_ok_and(|mut rd| rd.next().is_some())
}

/// Install steps for every detected deps item whose own path is missing from `wt`.
pub fn plan(cfg: &ProjectConfig, wt: &Path) -> Need {
    if !cfg.auto_install || !cfg.setup_steps.is_empty() {
        return Need::Nothing;
    }
    let mut steps: Vec<SetupStep> = Vec::new();
    for item in cfg.disk_items.iter().filter(|i| i.kind == DiskKind::Deps) {
        let Some(install) = &item.install else { continue };
        // Wildcard patterns describe nested copies; only the literal paths say "the item is there".
        let literal: Vec<&String> = item.paths.iter().filter(|p| !p.contains('*')).collect();
        if literal.is_empty() || literal.iter().any(|p| present(&wt.join(p))) {
            continue;
        }
        if !install.lockfiles.is_empty() && !install.lockfiles.iter().any(|l| wt.join(l).exists()) {
            return Need::Blocked(format!(
                "{} is missing and there is no lockfile ({}) to install from; run `{}` by hand, or set auto_install = false",
                literal[0],
                install.lockfiles.join(" or "),
                install.run
            ));
        }
        if !steps.iter().any(|s| s.run == install.run) {
            steps.push(SetupStep { name: format!("install {}", item.name), run: install.run.clone(), inputs: vec![] });
        }
    }
    if steps.is_empty() {
        Need::Nothing
    } else {
        Need::Install(steps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DiskItem, Install};
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-deps-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfg(lockfiles: &[&str]) -> ProjectConfig {
        let mut c = crate::config::parse_project("project = \"p\"\nrepo = \"/nonexistent/p.git\"\ndomain = \"p.local\"\n", Path::new("p.toml")).unwrap();
        c.disk_items = vec![DiskItem {
            name: "node_modules".into(),
            kind: DiskKind::Deps,
            paths: vec!["node_modules".into(), "*/node_modules".into()],
            clean_after: None,
            install: Some(Install { run: "bun install --frozen-lockfile".into(), lockfiles: lockfiles.iter().map(|s| s.to_string()).collect() }),
        }];
        c
    }

    #[test]
    fn missing_or_empty_deps_with_a_lockfile_plan_one_frozen_install() {
        let d = tmp("plan");
        std::fs::write(d.join("bun.lock"), "").unwrap();
        let c = cfg(&["bun.lock", "bun.lockb"]);
        let Need::Install(steps) = plan(&c, &d) else { panic!("expected an install") };
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].run, "bun install --frozen-lockfile");
        // an empty directory counts as missing
        std::fs::create_dir_all(d.join("node_modules")).unwrap();
        assert!(matches!(plan(&c, &d), Need::Install(_)));
        // present and non-empty: nothing to do
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        assert_eq!(plan(&c, &d), Need::Nothing);
    }

    #[test]
    fn no_lockfile_is_a_clear_failure_never_an_unfrozen_install() {
        let d = tmp("nolock");
        let Need::Blocked(note) = plan(&cfg(&["bun.lock"]), &d) else { panic!("expected blocked") };
        assert!(note.contains("no lockfile") && note.contains("bun.lock") && note.contains("auto_install = false"), "{note}");
    }

    #[test]
    fn opt_out_and_explicit_setup_win() {
        let d = tmp("optout");
        std::fs::write(d.join("bun.lock"), "").unwrap();
        let mut c = cfg(&["bun.lock"]);
        c.auto_install = false;
        assert_eq!(plan(&c, &d), Need::Nothing);
        let mut c = cfg(&["bun.lock"]);
        c.setup_steps = vec![SetupStep { name: "s".into(), run: "true".into(), inputs: vec![] }];
        assert_eq!(plan(&c, &d), Need::Nothing);
    }

    #[test]
    fn a_dangling_symlink_counts_as_missing() {
        let d = tmp("dangling");
        std::fs::write(d.join("bun.lock"), "").unwrap();
        std::os::unix::fs::symlink(d.join("gone"), d.join("node_modules")).unwrap();
        assert!(matches!(plan(&cfg(&["bun.lock"]), &d), Need::Install(_)));
    }

    #[test]
    fn shipped_presets_carry_the_documented_install_commands() {
        let want = [
            ("node-bun", "bun install --frozen-lockfile"),
            ("node-pnpm", "pnpm install --frozen-lockfile"),
            ("node-npm", "npm ci"),
            ("python-uv", "uv sync --frozen"),
            ("elixir-mix", "mix deps.get"),
        ];
        for (preset, cmd) in want {
            let (_, items, _) = crate::presets::resolve(&[preset.to_string()], None, &[], &[]).unwrap();
            let deps: Vec<_> = items.iter().filter(|i| i.kind == DiskKind::Deps).collect();
            assert!(!deps.is_empty(), "{preset}");
            assert!(deps.iter().all(|i| i.install.as_ref().is_some_and(|x| x.run == cmd && !x.lockfiles.is_empty())), "{preset}: {deps:?}");
        }
        // Bundler usually keeps gems outside the project, so a missing vendor/bundle means nothing.
        for preset in ["go", "rust-cargo", "ruby-bundler"] {
            let (_, items, _) = crate::presets::resolve(&[preset.to_string()], None, &[], &[]).unwrap();
            assert!(items.iter().all(|i| i.install.is_none()), "{preset}");
        }
    }
}
