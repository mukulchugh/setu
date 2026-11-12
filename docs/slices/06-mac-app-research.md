# Mac app research (objc2 0.6.5 / objc2-app-kit 0.3.2 / dispatch2 0.3.1), 2026-11-11
Source: one research lane, which checked the API names and feature gates against the local crate sources. Points marked "verify" still need confirming.

## Structure
- One `define_class!` type per view, plus an `AppDelegate`.
- Views switch through an `NSSegmentedControl`, building each view's subviews lazily and dropping hidden ones.
- Tables are view-based: `tableView:viewForTableColumn:row:` and `makeViewWithIdentifier:owner:`. Row buttons find their row with `rowForView:`, not tags.
- The status dot is a text "●" in a colour. That avoids an extra layer.

## Pitfalls
- **"method not found" means a missing cargo feature.** The `#[cfg(feature)]` line above each method in `objc2-app-kit-0.3.2/src/generated/*.rs` names the one it needs.
- **`NSVariableStatusItemLength` exists** as a static behind the `objc2-core-foundation` feature.
- **Never hold a `RefCell` borrow across a call into AppKit**, such as `reloadData`. The spike has a latent double-borrow of this kind.

## Daemon IO
- A std thread with a blocking `UnixStream` and NDJSON, with no tokio in the app.
- Results reach the main thread through `dispatch2::DispatchQueue::main().exec_async(closure)`. The closure must be `Send`, so it carries plain data and updates a `thread_local` model.
- `MainThreadMarker::run_on_main` does not exist in 0.6.5.

## Secrets
- Entry: an `NSSecureTextField` in an `NSAlert` accessory view, shown as a sheet, which needs the `block2` feature.
- Copy: `NSPasteboard` with `org.nspasteboard.ConcealedType`, cleared after 30 s if `changeCount` is unchanged.
- A `Secret` newtype whose `Debug` prints `***`.
- No values in the model; the model holds only `{name, secret, preview}`.

## Packaging
- A shell script builds the `.app`: `Info.plist` with `LSUIElement`, `LSMinimumSystemVersion` 13.0, `NSHighResolutionCapable`, and the icon via `iconutil`.
- Ad-hoc `codesign -s -` for local use.
- Developer ID later: sign inside-out, then `notarytool`, then `stapler`.
- The cask exposes `Contents/Resources/bin/setu-rs` through `binary`.

## Memory
- Release the window on close: drop the `Retained` handles in `windowWillClose:`, deferred by one turn of the run loop.
- `NSTextView`: non-contiguous layout, no rich text, no undo, capped lines.
- Measure the footprint after a close (verify).
