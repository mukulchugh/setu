# Setu

Setu means **bridge** in Hindi and Sanskrit. Its mark is **Confluence**: three parallel lanes rise into one span. Each lane represents an independent worktree; the shared span represents the calm, reachable surface Setu provides. The mark is a connection metaphor. Worktrees and their URLs remain distinct.

## The pick

Three open lanes express parallel work without a literal bridge illustration.  
The rising silhouette carries its meaning in a single colour, even in the menu bar.  
A charcoal tile gives the final violet glass clearer separation at small sizes and on light or dark desktops.

See [the three concepts](concepts/README.md) and [the local visual proof](preview.html).

## App icon

[setu-icon-1024.png](icon/setu-icon-1024.png) is the primary 1024 × 1024 master. Its three violet glass lanes have broad highlights and shaded depth, set on a charcoal rounded-square tile. The exterior is transparent. The icon has no text, letters or embedded status indicators.

Use this same charcoal master in light and dark appearances. A separate tint is unnecessary for this kit: the enclosed tile maintains the mark's contrast independently of the desktop. This is flattened PNG artwork for traditional icon packaging, not an editable layered Icon Composer document.

- Keep the three incoming lanes, two open channels, upward sweep and single elevated end.
- Scale uniformly. Preserve the master canvas, tile proportions and transparent corners.
- Use the full app icon for the Dock, Finder, app switcher and app listings.
- Use the template glyph in the menu bar and other monochrome controls.
- Do not add a word, initials, code punctuation, bridge cables, extra lanes or state badges to the app icon.
- Do not stretch, rotate, mirror, add another shadow or place another rounded-square tile behind it.
- Do not recolour individual lanes or add extra accent hues.
- Glass depth belongs in the app icon. Application content keeps native opaque system surfaces; use system Liquid Glass for navigation and controls as described in `lane/DESIGN.md`.

## Clear space and minimum size

For an isolated mark, reserve one incoming lane's thickness on every side of its visible bounds. For an app-icon placement in a brand layout, keep at least one eighth of the tile's width between the tile and unrelated artwork. These layout margins are external; do not add padding to the packaged icon canvas.

The app icon's minimum is **16 × 16 physical pixels**. Its silhouette carries recognition at that size; glass detail is secondary. Prefer 32 pixels or larger in documents. The menu-bar glyph is designed on an **18 × 18 pt** canvas and can be used at **16 to 18 pt**. Preserve the viewBox and internal padding. Render at the display's backing scale; do not enlarge a 1× raster on a Retina display.

## Palette

The identity uses one hue, **Iris**, with appearance-specific values. Neutrals support it. Semantic status colours describe state and never become alternate brand accents.

| Token | Light appearance | Dark appearance | Use |
|---|---|---|---|
| Iris | `#6550C7` | `#B3A0FF` | Primary action, selection and brand mark |
| Porcelain | `#F5F4F7` | `#F5F4F7` | Light brand surface; light ink on charcoal |
| Charcoal | `#19171F` | `#19171F` | Icon tile; dark brand surface or ink |
| Running | `#34C759` | `#30D158` | Static fallback for native `systemGreen` |
| Starting | `#FF9500` | `#FF9F0A` | Static fallback for native `systemOrange` |
| Stopped | `#8E8E93` | `#98989D` | Static fallback; app uses `secondaryLabelColor` |
| Crashed | `#FF3B30` | `#FF453A` | Static fallback for native `systemRed` |

In the app, retain dynamic system backgrounds, label colours and semantic status colours. The brand brief supersedes the earlier system-accent and stock status-item suggestions in `lane/DESIGN.md` for Setu's accent and identity glyph only. All other interface symbols remain SF Symbols. This kit does not modify the application or those reference documents.

Use semantic text styles over selected controls. Do not assume white text works on the pale dark-appearance accent. On a solid `#B3A0FF` button, charcoal text has the approved reverse-pair contrast below. Status colours are small symbols accompanied by shape and accessible names, never the sole carrier of meaning or body-text colours.

### Measured accent contrast

WCAG relative luminance, linearized sRGB, opaque colours. Normal-text AA requires 4.5:1. Ratios do not certify the glass artwork or translucent controls.

| Accent | On white `#FFFFFF` | On near-black `#19171F` |
|---|---|---|
| Light Iris `#6550C7` | **5.96:1**, approved | 2.98:1, switch to dark Iris |
| Dark Iris `#B3A0FF` | 2.24:1, switch to light Iris | **7.93:1**, approved |

Machine-readable values and calculation details are in [palette.json](palette.json).

## Type and wordmark

Use **SF Pro through the system font APIs**. Keep the product's existing 13 pt semibold run names, 11 pt secondary text, monospaced digits for resource values, and the system monospaced font for logs. Do not ship or embed font files.

When a typographic signature is needed, write **Setu** in system SF Pro, semibold, title case, with default tracking. Use the same Iris or neutral ink as surrounding content. Keep the word separate from the mark with at least one lane's thickness of clear space. No custom letter shapes, stretched spacing or wordmark raster is part of this kit.

## Menu-bar glyph and states

[setu-glyph.svg](glyph/setu-glyph.svg) contains one path element with three open subpaths, round caps and a 1.5-unit monochrome stroke. [setu-glyph-fill.svg](glyph/setu-glyph-fill.svg) contains one closed filled path with open channels. Both use `viewBox="0 0 18 18"`, one black ink and transparent surroundings. Neither contains text, gradients, masks or embedded images. Their shared rising three-lane silhouette echoes the app icon; the template deliberately omits its tile and glass.

Load the vector artwork into the app's asset pipeline, mark the resulting `NSImage` as a **template** (`isTemplate = true`) and let macOS supply the appropriate foreground. Black in the SVG is an alpha mask, not a command to show black ink in dark mode. These are custom Setu assets, not registered SF Symbols.

| Aggregate state | Setu glyph | Native accessory and accessible meaning |
|---|---|---|
| Running | Filled variant | No accessory; label includes the number of running worktrees |
| Starting | Regular variant | Static `circle.dotted` beside the mark; label includes starting count |
| Stopped | Regular variant | No accessory; label says no worktrees are running |
| Crashed | Regular variant | `exclamationmark.circle.fill` beside the mark; label includes crashed count |

For mixed states, show **Crashed → Starting → Running → Stopped** in that priority order, while the tooltip and accessibility label report all counts. Treat unknown runtime status as unknown in text rather than claiming it is stopped. Accessories are separate monochrome template symbols; widen the status item instead of squeezing or covering the mark. No colour or custom animation is required in the menu bar. In run lists, retain the native symbols from `lane/DESIGN.md` and the semantic colours above.

## Packaging and review

- [Setu.iconset](icon/Setu.iconset/) contains 16, 32, 128, 256 and 512 pt images at both 1× and 2×, ten PNGs total. Every image is resized directly from the master using `sips`.
- Recreate the iconset with `sh scripts/package-icons.sh` from this directory. No server, GUI or network is needed.
- [preview.html](preview.html) is an offline proof showing concepts, the master, true-size app icons, and both glyphs on light and dark surfaces.
- [glyph/proof.png](glyph/proof.png) shows headless native rasterization of the actual SVG paths at 16 pixels (top) and 18 pixels (bottom), magnified 8× with nearest-neighbour sampling. Each appearance shows regular then filled. Recreate it with `swift -module-cache-path .cache/swift scripts/render-glyph-proof.swift`.

Verified PNG dimensions and sRGB profiles, all ten iconset filenames and sizes, both SVGs' single-path structure and 18-unit viewBox, the proof's matching path data, all four contrast calculations and local preview links. Inspected the 16, 32 and 128 pixel app icons and the 16 and 18 pixel glyph rasters. Review ran locally without a GUI application or screenshots.

The files are supplied as a brand kit. Native menu-bar template behaviour, actual accessibility settings and an installed app's Dock appearance still require application integration review.
