//! Ecosystem presets as embedded TOML data: detection, merge with project config, and path expansion.
#![allow(dead_code)]

use crate::config::{convert_disk, RawDisk};
use crate::model::{DiskItem, DiskStore};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// A disk item as written in config: the item plus the `disabled` flag.
#[derive(Debug, Clone, PartialEq)]
pub struct RawItem {
    pub item: DiskItem,
    /// Removes the same-named item contributed by a preset.
    pub disabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresetFile {
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    detect: Detect,
    #[serde(default)]
    disk: RawDisk,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Detect {
    #[serde(default)]
    any_of: Vec<String>,
    #[serde(default)]
    none_of: Vec<String>,
}

struct Preset {
    name: &'static str,
    priority: i32,
    any_of: Vec<String>,
    none_of: Vec<String>,
    items: Vec<RawItem>,
    stores: Vec<DiskStore>,
}

const SOURCES: &[(&str, &str)] = &[
    ("node-bun", include_str!("../presets/node-bun.toml")),
    ("node-pnpm", include_str!("../presets/node-pnpm.toml")),
    ("node-npm", include_str!("../presets/node-npm.toml")),
    ("next", include_str!("../presets/next.toml")),
    ("vite", include_str!("../presets/vite.toml")),
    ("python-uv", include_str!("../presets/python-uv.toml")),
    ("rust-cargo", include_str!("../presets/rust-cargo.toml")),
    ("go", include_str!("../presets/go.toml")),
    ("ruby-bundler", include_str!("../presets/ruby-bundler.toml")),
    ("elixir-mix", include_str!("../presets/elixir-mix.toml")),
];

fn parse_preset(name: &'static str, text: &str) -> Result<Preset> {
    let f: PresetFile = toml::from_str(text).with_context(|| format!("preset {name}"))?;
    let (items, stores) = convert_disk(f.disk).with_context(|| format!("preset {name}"))?;
    Ok(Preset { name, priority: f.priority, any_of: f.detect.any_of, none_of: f.detect.none_of, items, stores })
}

fn all() -> &'static [Preset] {
    static CELL: OnceLock<Vec<Preset>> = OnceLock::new();
    CELL.get_or_init(|| {
        // Presets are compiled in; a malformed one is a build bug caught by the `shipped_presets_parse` test.
        SOURCES.iter().map(|(n, t)| parse_preset(n, t).unwrap_or_else(|e| panic!("{e:#}"))).collect()
    })
}

/// Names of all shipped presets.
pub fn names() -> Vec<&'static str> {
    SOURCES.iter().map(|(n, _)| *n).collect()
}

/// Does `name` match one path segment of `pat`, where `*` matches any run of characters?
fn seg_match(pat: &str, name: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni, mut star, mut mark) = (0, 0, None, 0);
    while ni < n.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if pi < p.len() && p[pi] == n[ni] {
            pi += 1;
            ni += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// Expand `pattern` (relative, `/`-separated, `*` wildcards within a segment) under `root`.
/// Never follows symlinks: a symlinked directory is not descended into, but a symlink that
/// is the final match is returned so callers can refuse it. Wildcard segments never match
/// `node_modules` or `.git`. Only existing paths are returned, sorted.
pub fn expand_paths(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let segs: Vec<&str> = pattern.split('/').collect();
    let mut cur = vec![root.to_path_buf()];
    for (i, seg) in segs.iter().enumerate() {
        let last = i + 1 == segs.len();
        let mut next = Vec::new();
        for dir in &cur {
            if seg.contains('*') {
                let Ok(rd) = std::fs::read_dir(dir) else { continue };
                for e in rd.flatten() {
                    let name = e.file_name();
                    let Some(name) = name.to_str() else { continue };
                    if name == "node_modules" || name == ".git" || !seg_match(seg, name) {
                        continue;
                    }
                    let p = dir.join(name);
                    if last || is_real_dir(&p) {
                        next.push(p);
                    }
                }
            } else {
                let p = dir.join(seg);
                // Literal segments: the final one need only exist (even as a symlink).
                if last {
                    if std::fs::symlink_metadata(&p).is_ok() {
                        next.push(p);
                    }
                } else if is_real_dir(&p) {
                    next.push(p);
                }
            }
        }
        cur = next;
        if cur.is_empty() {
            break;
        }
    }
    cur.sort();
    cur.dedup();
    cur
}

fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
}

fn matches(root: &Path, marker: &str) -> bool {
    !expand_paths(root, marker).is_empty()
}

/// Presets whose markers match `checkout`, highest priority first, then by name.
pub fn detect(checkout: &Path) -> Vec<&'static str> {
    let mut hits: Vec<&Preset> = all()
        .iter()
        .filter(|p| p.any_of.iter().any(|m| matches(checkout, m)) && !p.none_of.iter().any(|m| matches(checkout, m)))
        .collect();
    hits.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.name.cmp(b.name)));
    hits.into_iter().map(|p| p.name).collect()
}

/// Resolve the requested presets ("auto" detects from `checkout`) and merge their items and
/// stores with the project's own. Project items replace preset items by name; a project item
/// with `disabled` removes it. Stores dedupe by name, project wins.
pub fn resolve(
    requested: &[String],
    checkout: Option<&Path>,
    project_items: &[RawItem],
    project_stores: &[DiskStore],
) -> Result<(Vec<String>, Vec<DiskItem>, Vec<DiskStore>)> {
    let mut names: Vec<&str> = Vec::new();
    for r in requested {
        if r == "auto" {
            if let Some(c) = checkout {
                names.extend(detect(c));
            }
        } else if all().iter().any(|p| p.name == r) {
            names.push(r);
        } else {
            let known = SOURCES.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", ");
            bail!("unknown preset {r:?} (known: {known})");
        }
    }
    let mut seen = Vec::new();
    names.retain(|n| {
        let fresh = !seen.contains(n);
        seen.push(*n);
        fresh
    });

    let mut items: Vec<DiskItem> = Vec::new();
    let mut stores: Vec<DiskStore> = Vec::new();
    let put_item = |items: &mut Vec<DiskItem>, it: &DiskItem| match items.iter_mut().find(|x| x.name == it.name) {
        Some(x) => *x = it.clone(),
        None => items.push(it.clone()),
    };
    let put_store = |stores: &mut Vec<DiskStore>, s: &DiskStore| match stores.iter_mut().find(|x| x.name == s.name) {
        Some(x) => *x = s.clone(),
        None => stores.push(s.clone()),
    };
    for n in &names {
        let p = all().iter().find(|p| p.name == *n).ok_or_else(|| anyhow!("preset {n} vanished"))?;
        p.items.iter().filter(|i| !i.disabled).for_each(|i| put_item(&mut items, &i.item));
        p.stores.iter().for_each(|s| put_store(&mut stores, s));
    }
    for ri in project_items {
        if ri.disabled {
            items.retain(|x| x.name != ri.item.name);
        } else {
            put_item(&mut items, &ri.item);
        }
    }
    project_stores.iter().for_each(|s| put_store(&mut stores, s));
    Ok((names.into_iter().map(String::from).collect(), items, stores))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DiskKind;
    use std::time::Duration;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("setu-presets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    fn item(name: &str, paths: &[&str], disabled: bool) -> RawItem {
        let item = DiskItem {
            name: name.into(),
            kind: DiskKind::Cache,
            paths: paths.iter().map(|s| s.to_string()).collect(),
            clean_after: Some(Duration::from_secs(60)),
            install: None,
        };
        RawItem { item, disabled }
    }

    #[test]
    fn shipped_presets_parse() {
        assert_eq!(all().len(), SOURCES.len());
        let next = all().iter().find(|p| p.name == "next").unwrap();
        assert_eq!(next.items.len(), 3);
        assert_eq!(next.items[2].item.clean_after, Some(Duration::from_secs(7 * 86400)));
    }

    #[test]
    fn segment_matching() {
        assert!(seg_match("next.config.*", "next.config.ts"));
        assert!(seg_match("*", "anything"));
        assert!(seg_match("a*c", "abbc"));
        assert!(!seg_match("next.config.*", "next.config"));
        assert!(!seg_match("a*c", "abd"));
        assert!(seg_match("*.*", "a.b"));
    }

    #[test]
    fn detects_bun_and_nested_next() {
        let d = tmp("detect");
        touch(&d, "bun.lock");
        touch(&d, "apps/web/next.config.mjs");
        touch(&d, "Cargo.toml");
        assert_eq!(detect(&d), ["next", "node-bun", "rust-cargo"]);
        let e = tmp("detect-empty");
        assert!(detect(&e).is_empty());
        // Markers inside node_modules do not count.
        touch(&e, "node_modules/x/next.config.js");
        assert!(detect(&e).is_empty());
    }

    #[test]
    fn resolve_auto_merge_override_disable() {
        let d = tmp("resolve");
        touch(&d, "bun.lock");
        touch(&d, "next.config.js");
        let req = vec!["auto".to_string()];
        let (names, items, stores) = resolve(&req, Some(&d), &[], &[]).unwrap();
        assert_eq!(names, ["next", "node-bun"]);
        let n: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(n, ["next-dev-cache", "next-build-cache", "next-dev-output", "node_modules"]);
        assert_eq!(stores.len(), 1);
        assert_eq!(stores[0].warn_below, Some(1 << 30));

        let store = DiskStore { name: "bun-cache".into(), path: "/x".into(), warn_below: None };
        let proj = [item("next-dev-cache", &["custom"], false), item("next-build-cache", &[], true), item("extra", &["e"], false)];
        let (_, items, stores) = resolve(&req, Some(&d), &proj, &[store.clone()]).unwrap();
        let n: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(n, ["next-dev-cache", "next-dev-output", "node_modules", "extra"]);
        assert_eq!(items[0].paths, ["custom"]);
        assert_eq!(stores, vec![store]);
    }

    #[test]
    fn resolve_explicit_and_errors() {
        let (names, items, _) = resolve(&["go".into(), "go".into()], None, &[], &[]).unwrap();
        assert_eq!(names, ["go"]);
        assert!(items.is_empty());
        let e = resolve(&["nope".into()], None, &[], &[]).unwrap_err();
        assert!(e.to_string().contains("unknown preset"));
        let (names, ..) = resolve(&["auto".into()], None, &[], &[]).unwrap();
        assert!(names.is_empty());
        let (names, items, _) = resolve(&[], None, &[item("a", &["a"], false)], &[]).unwrap();
        assert!(names.is_empty() && items.len() == 1);
    }

    #[test]
    fn expands_star_segments() {
        let d = tmp("expand");
        std::fs::create_dir_all(d.join(".next/cache")).unwrap();
        std::fs::create_dir_all(d.join("apps/web/.next/cache")).unwrap();
        std::fs::create_dir_all(d.join("apps/api/.next/cache")).unwrap();
        std::fs::create_dir_all(d.join("a/b/c/.next/cache")).unwrap();
        let r = |p: &str| expand_paths(&d, p);
        assert_eq!(r(".next/cache"), [d.join(".next/cache")]);
        assert_eq!(r("*/*/.next/cache"), [d.join("apps/api/.next/cache"), d.join("apps/web/.next/cache")]);
        assert!(r("*/.next/cache").is_empty());
        assert!(r("missing/x").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_not_followed_and_node_modules_skipped() {
        use std::os::unix::fs::symlink;
        let d = tmp("symlink");
        let outside = tmp("symlink-outside");
        std::fs::create_dir_all(outside.join(".next/cache")).unwrap();
        symlink(&outside, d.join("link")).unwrap();
        std::fs::create_dir_all(d.join("real/.next/cache")).unwrap();
        // A symlinked directory is not descended into.
        assert_eq!(expand_paths(&d, "*/.next/cache"), [d.join("real/.next/cache")]);
        assert!(expand_paths(&d, "link/.next/cache").is_empty());
        // A symlink at the final segment is returned for the safety layer to refuse.
        symlink(&outside, d.join("real/.next/dev")).unwrap();
        assert_eq!(expand_paths(&d, "real/.next/dev"), [d.join("real/.next/dev")]);
        assert_eq!(expand_paths(&d, "*/.next/dev"), [d.join("real/.next/dev")]);
        // `*` never walks node_modules or .git; literal segments may.
        std::fs::create_dir_all(d.join("node_modules/pkg/.next/cache")).unwrap();
        std::fs::create_dir_all(d.join(".git/x/.next/cache")).unwrap();
        std::fs::create_dir_all(d.join("real/node_modules/.vite")).unwrap();
        assert_eq!(expand_paths(&d, "*/.next/cache"), [d.join("real/.next/cache")]);
        assert_eq!(expand_paths(&d, "*/node_modules/.vite"), [d.join("real/node_modules/.vite")]);
        assert_eq!(expand_paths(&d, "node_modules/pkg/.next/cache").len(), 1);
    }
}
