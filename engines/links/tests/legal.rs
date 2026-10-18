//! Licenses and provenance travel with the engine as separate metadata, and the dependency set is reviewed.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn provenance() -> Value {
    serde_json::from_str(&fs::read_to_string(root().join("legal/provenance.json")).expect("legal/provenance.json")).unwrap()
}

#[test]
fn provenance_records_a_full_pinned_revision_and_checksums_for_what_was_adapted() {
    let record = provenance();
    let revision = record["source"]["revision"].as_str().unwrap();
    assert_eq!(revision.len(), 40, "pin a full revision");
    assert!(revision.chars().all(|c| c.is_ascii_hexdigit()));
    let files = record["source"]["files"].as_array().unwrap();
    assert!(!files.is_empty());
    for file in files {
        assert_eq!(file["sha256"].as_str().unwrap().len(), 64);
        assert!(root().join(file["adaptedInto"].as_str().unwrap()).exists(), "{file}");
    }
}

#[test]
fn the_required_notices_are_kept_verbatim_beside_the_provenance() {
    for notice in provenance()["notices"].as_array().unwrap() {
        let bytes = fs::read(root().join("legal").join(notice["file"].as_str().unwrap())).unwrap();
        assert_eq!(sha256(&bytes), notice["sha256"].as_str().unwrap(), "{notice}");
    }
}

const ALLOWED: &[&str] = &["MIT", "Apache-2.0", "Unlicense", "Zlib", "Unicode-3.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"];

/// Every `AND` clause needs one allowed alternative among its `OR` choices.
fn permitted(expression: &str) -> bool {
    expression.replace(['(', ')'], "").replace('/', " OR ").split(" AND ").all(|clause| {
        clause.split(" OR ").any(|choice| ALLOWED.contains(&choice.split(" WITH ").next().unwrap().trim()))
    })
}

#[test]
fn every_dependency_in_the_lock_file_is_reviewed_and_permissively_licensed() {
    let lock: lock_file::Lock = lock_file::parse(&fs::read_to_string(root().join("Cargo.lock")).unwrap());
    let reviewed = fs::read_to_string(root().join("legal/THIRD-PARTY-LICENSES.md")).unwrap();
    let mut listed = BTreeSet::new();
    for row in reviewed.lines().filter(|l| l.starts_with("| ") && !l.starts_with("| Crate") && !l.starts_with("| ---")) {
        let cells: Vec<&str> = row.trim_matches('|').split('|').map(str::trim).collect();
        assert!(permitted(cells[2]), "{} declares {}", cells[0], cells[2]);
        listed.insert(format!("{} {}", cells[0], cells[1]));
    }
    // The engine itself is not a third party.
    let locked: BTreeSet<String> = lock.packages.into_iter().filter(|p| p != "setu-links 0.1.0").collect();
    assert_eq!(locked, listed, "Cargo.lock and legal/THIRD-PARTY-LICENSES.md disagree");
}

/// Just enough of Cargo.lock to list `name version`; the format is stable and this avoids another dependency.
mod lock_file {
    pub struct Lock {
        pub packages: Vec<String>,
    }

    pub fn parse(text: &str) -> Lock {
        let mut packages = Vec::new();
        let mut name = None;
        for line in text.lines() {
            if let Some(n) = line.strip_prefix("name = ") {
                name = Some(n.trim_matches('"').to_string());
            } else if let (Some(v), Some(n)) = (line.strip_prefix("version = "), name.take()) {
                packages.push(format!("{n} {}", v.trim_matches('"')));
            }
        }
        Lock { packages }
    }
}
