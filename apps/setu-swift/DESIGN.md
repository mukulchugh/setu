# Setu.app: design system
Mode: **Operate**. World: **native macOS 26 (Tahoe), Liquid Glass**. This is pinned by the owner: "use the Liquid Glass UI, the latest from Apple".

## Material
- **Liquid Glass comes from the system, not as decoration.**
  - The app links against the macOS 26.5 SDK. NSToolbar, the sidebar `NSSplitViewItem`, NSPopover, segmented controls and buttons all adopt Liquid Glass on their own. Use them as-is.
  - Custom glass appears only where the system would put it: floating controls that sit over content. That means the popover's footer action bar (an `NSGlassEffectContainerView` holding `NSBezelStyle::Glass` buttons) and the floating "Free N GB" action on the Disk view.
  - Never put glass on table rows, cards or backgrounds.
- **Content surfaces stay opaque system backgrounds,** for legibility and memory. Liquid Glass is for the navigation and control layer, which floats above content.

## Structure
- **Window:** an `NSSplitViewController`.
  - The sidebar is a source list (`NSSplitViewItem` sidebar behaviour) with Runs, Environments, Disk and Config.
  - Each sidebar row has an SF Symbol and a count badge: runs up, cleanable GB, failing checks.
  - The content area has a unified `NSToolbar` holding the view's actions and a search field.
- **Popover:** the run list (6 visible rows, then scroll), then a glass footer with "Open Setu", "Add worktree…" and the overflow menu (Settings, Quit).

## Icons
- SF Symbols only, via `NSImage imageWithSystemSymbolName:accessibilityDescription:`, in one weight (regular, medium scale). No unicode glyphs.
- **Status item:** a template SF Symbol (`square.stack.3d.up` or similar), with a symbol variant or colour dot for state.
- **Run state symbols:**

  | State | Symbol | Colour |
  |---|---|---|
  | Running | `circle.fill` | systemGreen |
  | Starting | `circle.dotted` | systemOrange |
  | Stopped | `circle` | secondaryLabel |
  | Crashed | `exclamationmark.circle.fill` | systemRed |

## Type
- System font only. Title 13pt semibold for the run name.
- Secondary text is 11pt in `secondaryLabelColor`.
- Monospaced digits for RAM and sizes (`monospacedDigitSystemFont`). The log view uses `monospacedSystemFont`, since it is real log content.

## Colour
- Restrained: system semantic colours only.
- The accent is the system accent, used only for the primary action and selection.

## Behaviour
- **Row primary action:** the URL is clickable. Double-clicking a row opens it, and the trailing "Open" button does the same.
- **Secondary actions:** Start, Stop, Restart, Logs and Copy URL live in a per-row `…` menu and in the right-click context menu.
- **Keyboard:** ⌘O open, ⌘R restart, ⌘. stop, ⌘L logs, ⌘F search, ⌘1 to ⌘4 switch views, ⌘, settings.
- **Motion:** none authored. System animations only.
- **Empty states:** an SF Symbol, one sentence, and one button that performs the next action. For example: "No runs yet." with an "Add Worktree…" button that opens a folder picker and starts the worktree.
- **Errors** appear inline under the row or in a sheet, naming the problem and the fix.

## Owner direction (2026-11-11): symbolic, not verbose
- Standard actions are SF Symbols only, each with a tooltip and an accessibility label: start, stop, restart, open, copy, reveal, add, import, refresh.
- A run's status is shown by its coloured symbol alone. The status word goes in the tooltip and the accessibility label.
- Text appears only where a symbol can't carry the meaning: run names, URLs, sizes, env names.
- Empty states are a symbol, 2 to 4 words, and one button.
- Source chips are tiny symbols:

  | Symbol | Meaning |
  |---|---|
  | `globe` | All projects |
  | `folder` | This project |
  | `arrow.triangle.branch` | This worktree |
  | `gearshape` | Setu |
- Sheets have at most one line of helper text.

## Naming (owner, 2026-11-11)
The UI sections are called **Runs, Environments, Disk, Config**. The CLI commands keep their names (`setu-rs setup`, `setu-rs doctor`).

## Decisions (owner, 2026-11-12)
- Force Remove stays CLI-only (`setu-rs rm --force`, which backs up dirty work to `refs/setu-backup/<branch>`). The app never discards uncommitted work in one click.
