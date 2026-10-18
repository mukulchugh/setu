# Provenance and notices

Parts of the engine are adapted from a reviewed, permissively licensed Rust program. This directory is the
only place that program is named. The notices below are kept verbatim and travel with every distributed
copy of the engine. Do not edit them.

- Source: https://github.com/reason-machines/reason-network, version 0.10.5
- Pinned revision: `61218a264dc091d14a798e0296291e1fe90f4018` (tree `381260bde81d44f42323ec39e0fa4cdad120cc99`)
- License: MIT OR Apache-2.0, at the user's option. Texts: `LICENSE-MIT`, `LICENSE-APACHE`. Chain of
  origin and attribution: `NOTICE`.

## What was adapted

Machine-readable record, with git blob ids and SHA-256 checksums of each source file at the pinned
revision: `provenance.json`. A test checks the record is complete and that the notices still match their
recorded checksums.

| Source file | Adapted into | What carried over |
| --- | --- | --- |
| `src/store.rs` | `src/store.rs` | The SQLite open and write-ahead-logging skeleton. The schema and every operation are new. |
| `src/util.rs` | `src/util.rs` | `now_ms`, `one_line`, `printable`. |
| `src/net.rs` | `src/transport.rs` | The shape of the connection manager: one connection per pair of machines, a dial loop with backoff, both sides keeping the connection the smaller key dialed, length-prefixed JSON frames with a size cap. Rewritten for the Setu wire, with no roster, join, presence, relay or lookup code and no wake flag. |
| `src/render.rs` | `src/frame.rs` | The framing approach, attribute escaping and delimiter neutralising. |

`src/proto.rs`, `src/daemon/mail.rs`, `src/daemon/mod.rs`, the lock helper in `src/util.rs` and `src/ipc.rs` were read for the request shape, body limit and
validation approach. No code was copied from them.

## What was left behind

The installer, self-update, login and agent-configuration writers, the menu-bar and notification
surfaces, the session scanner and transcript-derived "what it is doing" feature, the team roster,
invitations, presence, relay selection and address lookup, and the Windows support. The engine is a Setu-managed local process.

## Other obligations

`THIRD-PARTY-LICENSES.md` lists the crates in the build and the license each declares. A distributed
binary also needs each crate's own license text; that belongs to the packaging work.
