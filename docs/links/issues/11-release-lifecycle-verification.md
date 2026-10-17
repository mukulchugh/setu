# 11 — Clean install to uninstall works, with recoverable upgrades

**GitHub:** [#18](https://github.com/mukulchugh/setu/issues/18) · **Parent:** [Setu Links specification](../spec.md) ([#7](https://github.com/mukulchugh/setu/issues/7)) · **Increment:** 7 · **Release scope:** first public release gate · **Status:** published, ready-for-agent

## What to build

A user on a clean machine installs Setu with Links, opts in, communicates, updates, disables and uninstalls, with recoverable errors and an explicit choice about retained data at each step. This ticket is the release gate for the first public release.

- **Adapter lifecycle.** Installing or removing the provider hook and tool registration for Links shows a safe preview, preserves unrelated configuration, and verifies that a fresh client activates the intended version. No global adapter is configured automatically.
- **Packaging.** Setu's installer and update transaction ship the engine artifact, its checksum and the required legal notices. Add the engine to the packaged-file list. The long-running mode runs as one Setu-managed user service whose setup is an explicit step; health reads are passive.
- **Compatibility.** Archive and engine schema compatibility is checked; an interrupted upgrade, a rollback and a downgrade never corrupt the engine database; binary rollback respects database compatibility. Retained private state, backup and restore, and uninstall choices (keep or remove mail and policy) are explicit.
- **Verification.** Rust tests, changed Bun contract tests, full `bun run verify`, artifact naming and package checks, and an isolated end-to-end CI run. Live acceptance is recorded for every provider and OS combination the release claims; anything unrun is listed as unverified in the release notes. The cmux adapter stays optional until its real effect boundary is verified; Ghostty focus stays exact-target only.

## Acceptance criteria

- [ ] On a clean machine or isolated profile: install, enable Links, enable a shared project, exchange a message between two managed sessions, view it in Spans history, disconnect and restart, update, disable, uninstall. Each step succeeds or fails with a recoverable error.
- [ ] Adapter install/remove preview shows exactly what changes; unrelated provider configuration is byte-identical afterwards; removal restores it.
- [ ] Interrupt an update at each stage: the previous version still works and the engine database is intact. Roll back across a schema change: refused or safely handled, never corrupting.
- [ ] Backup and restore of Links state to a fresh install preserves messages and policy; uninstall offers keep or remove and honors the choice.
- [ ] The packaged artifact contains the engine, its checksum and the required notices from the separate legal metadata; a naming and package check passes with narrow exceptions only for that metadata.
- [ ] CI runs Rust tests, Bun tests, typecheck, naming scan and the isolated end-to-end flow.
- [ ] A live acceptance matrix (provider, version, OS, session type, result) is recorded in [TEST-BOUNDARIES.md](../TEST-BOUNDARIES.md); every unverified combination is named as unverified in release notes. No claim exceeds the matrix.
- [ ] Release notes state the real limits: Claude-only natural-turn delivery unless more evidence exists, whether Send now is available, direct-only connectivity if no relay exists.

## Blocked by

- [#14](https://github.com/mukulchugh/setu/issues/14) (07) — A run-linked exchange appears once in Spans history
- [#16](https://github.com/mukulchugh/setu/issues/16) (09) — Teammates on separate machines exchange messages
- [#17](https://github.com/mukulchugh/setu/issues/17) (10) — Every front door agrees, and uncertain operations are recoverable

## Gates

None external beyond what earlier tickets record. Required licenses and provenance are kept in separate legal metadata; the artifact check above confirms they ship, and they are not a gate.
