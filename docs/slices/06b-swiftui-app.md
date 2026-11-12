# Slice 6b: Setu.app in SwiftUI (Apple's own kit), replacing the hand-wired objc2 app

**Why:** the owner asked for the best UI library to be ranked and used, with no reinvented wheel. SwiftUI ships Liquid Glass (`.glassEffect`, `GlassEffectContainer`, `.buttonStyle(.glass)`), `NavigationSplitView`, `Table`, `MenuBarExtra(.window)`, `.searchable` and `.inspector` as standard components. The Rust daemon, CLI and MCP stay unchanged.

**Contract:** the same NDJSON socket and the same `actor:"app"`. `PRODUCT.md` and `DESIGN.md` in `apps/setu-mac/` stay the brief: symbolic, not verbose.

**Decision (owner, 2026-11-11):** SwiftUI ships. The owner's words: AppKit is legacy and Setu should be cutting edge. Memory is still measured and tuned, but it no longer decides between the two. Once SwiftUI has feature parity, the objc2 app (`apps/setu-mac`) is removed; it stays in git history.

**Build:**
- `apps/setu-swift`: a Swift package (`swift build -c release`), no Xcode project.
- `scripts/bundle-swift.sh` produces `Setu.app`, with `setu-rs` in `Contents/Resources/bin`.
