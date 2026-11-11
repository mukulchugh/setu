# Slice 6: Setu.app, the menu-bar app (Rust, AppKit via objc2)

Research:
- `06-mac-app-research.md` (summary below)
- the UI spike (`~/workspace/setu-v2-spike/REPORT.md`): AppKit used 9.8 MB idle in the menu bar
- `05-install-research.md` (the cask)

## What you get
- **Menu-bar item.** A "setu" status item whose dot is green when any run is up and grey otherwise.
  - Clicking it opens a real NSPopover with one row per run: status dot, project/run, RAM, Open (URL), and Start/Stop.
  - The footer has "Open Setu…" and "Quit".
  - If the daemon is down, the popover says so and offers a "Start daemon" button.
- **Window**, with a segmented control across the top for four views:
  - **Runs:** a table of runs with URL, status, RAM, ports and note, and a Start/Stop/Restart/Open action per row. Selecting a row shows its logs, last 2,000 lines, polled once a second while visible. Logs come from the daemon, so they are already redacted of secrets.
  - **Env:** a scope picker (Global, a project, or a worktree), a table of names with a source chip, and values masked for secrets.
    - Buttons: Add, Edit, Remove, Import (file picker; the daemon parses it and returns names only), and Reveal. Reveal copies the value to the clipboard, marked "concealed" so clipboard managers skip it, and clears it after 30 s. Each reveal is audited.
    - Secrets are entered in an NSAlert sheet with an NSSecureTextField.
    - An "Effective" toggle shows the merged env for a selected run.
  - **Disk:** a "Refresh" button runs `disk.report` (it is expensive, so it never runs automatically). The view lists items per worktree with their real size, whether each is cleanable, and why, plus a "Clean now" button that applies.
  - **Settings:** the setup status, which runs `setu-rs doctor` and shows the result, and a version line.
- **Low memory.** The window is released on close, so its GPU surfaces go. Polling is idle-aware: `ls` every 2 s while the popover or window is visible, every 10 s otherwise. Logs and env are fetched only while their view is visible.
- **Packaging.** `scripts/bundle.sh` builds `Setu.app`:
  - `Contents/MacOS/setu-mac` and `Contents/Resources/bin/setu-rs`;
  - `LSUIElement=true`;
  - ad-hoc signed for local use. Developer ID signing and notarization come at publish time.

## Not in this slice
- The cask itself, and publishing (waiting on the repo decision).
- An "Open Setu at login" toggle (`SMAppService.mainApp`). It needs a signed bundle in `/Applications`.
- A daemon event stream. Polling is enough for now.

## Code
- `crates/setu-proto`: serde types for the replies the app reads, and a `Secret` newtype whose `Debug` prints `***`. It has no tokio and no objc2.
- `apps/setu-mac`:
  - pinned `objc2 =0.6.5`, `objc2-foundation =0.3.2`, `objc2-app-kit =0.3.2`, `dispatch2`, `block2`, `serde_json`;
  - a std-thread socket client, with results posted to the main queue;
  - a `thread_local` model;
  - one `define_class!` controller per view;
  - all `unsafe` kept inside `ui/` helpers.
- No change to the daemon's protocol.

## Verification
1. `cargo build --release -p setu-mac` with no warnings, and unit tests for `setu-proto`: parsing the real daemon replies, and the `Secret` debug mask.
2. `scripts/bundle.sh` produces a signed `Setu.app`; `codesign -v` passes.
3. **Driven live against a sandbox daemon** (`SETU_HOME` sandbox with a demo project), using System Events accessibility queries. No screenshots. Checks:
   - the status item exists;
   - the popover lists the run;
   - Start and Stop change the daemon state (checked with `setu-rs ls`);
   - the Env view lists names with masked secrets;
   - adding a plain var through the UI shows up in `setu-rs env ls`.
4. **Memory**, measured with `footprint`, against the spike's numbers:
   - menu bar only, idle 60 s;
   - window open on Runs with logs;
   - after the window is closed (did the GPU surfaces come back?).
5. **Leak check.** A canary secret set through the CLI never appears in the app's stdout or stderr, or in any accessibility value apart from the masked preview.
