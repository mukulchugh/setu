//! The built engine carries Setu-native names only. Required notices live in `legal/`, outside the binary.
use std::fs;

/// Names of the program the store was adapted from, assembled so this file does not contain them whole.
fn inherited_names() -> Vec<String> {
    vec![
        ["reason", "network"].join("-"),
        ["reason", "network"].join("_"),
        ["reason", "network"].join(" "),
        ["reason", "machines"].join("-"),
        ["tin", "can"].concat(),
    ]
}

#[test]
fn the_built_binary_contains_no_inherited_product_names() {
    let binary = fs::read(env!("CARGO_BIN_EXE_setu-links")).unwrap();
    let text = String::from_utf8_lossy(&binary).to_ascii_lowercase();
    for name in inherited_names() {
        assert!(!text.contains(&name), "the binary mentions {name:?}");
    }
}
