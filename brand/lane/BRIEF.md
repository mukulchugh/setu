# Brief: Setu brand kit (Codex, image generation)

Work only inside this directory (`brand/`). Read `PRODUCT.md` and `DESIGN.md` in `lane/` for the product.

## The product
Setu is a macOS menu-bar app and CLI for developers. It runs every git worktree of every project side by side, each with its own local URL, keeps RAM and disk low, and manages env secrets so AI agents never see the values. In Hindi and Sanskrit, *setu* means **bridge**: Setu bridges many parallel worktrees to clean, reachable URLs. The UI is native macOS 26 (Tahoe) Liquid Glass, symbolic rather than wordy, and calm.

## Direction
- **Original identity.** Don't imitate Apple's icons or any existing developer tool's logo.
- **Concept seeds (pick or combine; better ideas are welcome):**
  - parallel lanes or strands converging into one span, like a bridge;
  - stacked translucent planes (worktrees) joined by a single arc;
  - an abstract "S" formed by two connected paths.
- **Restraint:** one strong accent colour plus neutrals. The icon must read at 16 px and 1024 px.
- **App icon:** a macOS 26 rounded-square app icon with layered translucent glass depth (the Liquid Glass icon language). No text in any generated image.
- **Menu-bar glyph:** a monochrome *template* glyph. It must work as a single colour at 16 to 18 pt, so draw it as a simple vector, in the style of an SF Symbol.

## Deliverables (all in `brand/`)
1. **Concepts.** Use your image generation tool to create 3 distinct app-icon concepts at 1024×1024 PNG: `concepts/icon-a.png`, `concepts/icon-b.png`, `concepts/icon-c.png`. Each needs a one-line rationale in `concepts/README.md`. No text or letters inside the images.
2. **The pick.** Choose the strongest, explain why in 3 lines, and refine it to the final `icon/setu-icon-1024.png`, with light and dark (tinted) variants if useful.
3. **Menu-bar glyph** as SVG by hand: `glyph/setu-glyph.svg`, a single path, viewBox `0 0 18 18`, monochrome, plus a "running" variant `glyph/setu-glyph-fill.svg`. It must echo the icon's idea.
4. **Palette.** `palette.json`: the accent in light and dark, two neutrals, and the semantic status colours (running, starting, stopped, crashed). The status colours stay close to the macOS system colours; the accent is ours. Check the accent's contrast on white and on near-black, and record the ratios.
5. **Type.** SF Pro (system) for the UI. Optionally pick a wordmark treatment, but render no wordmark image; describe it in `BRAND.md`.
6. **`BRAND.md`.** The concept, the meaning of the mark, the palette with hex values and usage, the icon do's and don'ts, clear space, the minimum size, and how the menu-bar glyph maps to states.
7. **Sizes for packaging.** Use `sips` to make an `icon/Setu.iconset/` with all macOS sizes (16, 32, 128, 256 and 512, at @1x and @2x) from the final 1024 PNG.

## Rules
- Don't launch any GUI app. Don't take screenshots.
- No network beyond your image tool.
- End your final message with `BRAND KIT DONE`.
