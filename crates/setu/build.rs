// Embeds every `recipes/*.toml` in the binary: dropping a file there is all it takes to ship a recipe.
use std::fmt::Write as _;

fn main() {
    let dir = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("recipes");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "toml")).collect();
    files.sort();
    let mut out = String::from("const SHIPPED: &[(&str, &str)] = &[\n");
    for f in files {
        let stem = f.file_stem().unwrap().to_string_lossy().into_owned();
        writeln!(out, "    ({stem:?}, include_str!({:?})),", f.display().to_string()).unwrap();
    }
    out.push_str("];\n");
    std::fs::write(std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("shipped_recipes.rs"), out).unwrap();
}
