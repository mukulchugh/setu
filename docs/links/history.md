# Issue 14 contract: engine `events`, `list` and roster reads as the JS history now uses them

Status: schema 4 is implemented in the engine. Migration creates one backfill event for each ordinary pre-existing message, and every later visible delivery or outbox change is appended at the shared transaction commit seam. Reads remain passive; retry bookkeeping and attention requests do not enter the event log.

## `events` (passive; wire args)
`{after>=0, limit 1..=200 (default 100), origin?, run_hint?}`; `run_hint` requires `origin`; unknown fields `FIELD_UNSUPPORTED`; opens an existing store read-only, never creates one.
Result `{store_id: string|null, head, next, has_more, events:[...]}`; a missing store is `{store_id:null, head:0, next:0, has_more:false, events:[]}`.
- `store_id`: stable id minted with the database (not the peer key, which can survive a database replacement).
- `head`: highest seq of the unfiltered log. `next`: seq the scan reached; with `has_more` it is the last returned seq, otherwise at least the observed `head` even when nothing matched (a filtered cursor must not stick).
- A page is at most the client's 2 MiB serialized-reply limit, including its protocol envelope. It contains only whole events and may therefore contain fewer than `limit`; `has_more` and `next` remain the honest continuation. A legacy event body over 256 KiB is refused as recoverable `EVENT_TOO_LARGE`, rather than buffering an unbounded reply or truncating history.
- Event (all keys present, nullable ones as null): `seq, first, backfill, at, message_id, state, reason, attempts, redeliveries, attempt_id, expires_at, stage, remote_state, cancel, message`.
  - `first`: true only on the lowest-seq event of that message in the whole log, never "first on this filtered page".
  - `backfill`: true on the single synthesized event the migration writes per pre-existing message (its current state). History before it is unknown. `first` is also true for it, so the message row is still produced; `backfill` is what lets the display say earlier history is unknown. False otherwise. (Added because `first` alone cannot express the gap.)
  - `stage` outbox_state or null; `remote_state` or null; `cancel` none|requested|confirmed|refused (`none` for inbox rows).
  - one event per persisted user-visible change; none for retry heartbeats or `inbound.state_seq` updates; a `cancel_state` change is an event even if the displayed state did not move.
  - `message`: `{body, created_at, kind, origin, recipient:{provider, session_hint}, reply_to, run_hint, sender:{kind}, size, span_hint}`. `origin` is exactly `local` or `peer:<key>` (see "Canonical origin" below), computed from the immutable `messages.sender` (`peer:<key>`) / `inbound.peer_id`; no origin column. No checkout or native id on the wire. `kind` is carried, not assumed to be `message`.
- The client (`links-client.js`) accepts exactly these keys and refuses any other.

## `list` (extended; baseline reply still accepted)
Args: `session_hint?` plus `run_hint?+origin?`, `has_run_hint?`, `states?[]`, `limit<=200`, `after_id?`; at least one selector; bodies excluded.
Result: baseline `{messages}` or `{messages:[... + origin], has_more, next_after}`. Extended `states` filters the same projected state returned in each row, including expiry, observed-recipient and policy holds; its bounded cursor advances past inspected non-matches. An engine that predates this answers `REQUEST_INVALID`/`FIELD_UNSUPPORTED`; the service reports `LINKS_ENGINE_UPGRADE_REQUIRED`.

## `peer_list`
The client accepts only `{peers:[{addresses:string[], created_at:number, grants:[{capability:string, scope:{kind:string, id?:string}}], label:string, peer_id:string, published:[{recipient:{checkout:string, native_id:string, provider:string, session_hint:string}, scope:string, session_hint:string}]}]}`. Every object is exact: unknown, omitted, or wrongly typed fields make the roster unreadable, except `scope.id`, which is optional. A peer `origin` is accepted for an approval only if listed; an unreadable roster is `LINKS_ORIGIN_UNVERIFIABLE`.

## `show`
Implemented with `origin`: the engine projects it from the immutable sender, and the client validates it when present. The service treats a `user` sender as `local` and refuses anything else that cannot be verified as `LINKS_ORIGIN_UNVERIFIABLE`.

## Canonical origin (pinned)
On the engine wire — `events` (`message.origin` and the `origin` filter), `list` (`origin` per message and filter), `show` — and in every archive payload, an origin is **exactly** one of:
- `local`
- `peer:` followed by the 64 lowercase hexadecimal characters of the authenticated peer key (`peer:[0-9a-f]{64}`).

Nothing else is valid on the wire: not a bare key, not uppercase, not a label. The JS compares origins by exact string equality (a message's origin must equal the association's, and the `events` filter is exact), so a bare or differently-cased key from the engine would never match an approval. Only a typed *request* from a person (CLI/UI) is tolerated: a bare lowercase 64-hex key is read as that peer and canonicalized to `peer:<key>` before anything is stored or compared; `peer_list` ids are bare keys and are compared after the same canonicalization.
The engine emits and validates this exact spelling for `events`, extended `list` and `show`; schema-4 insertion rejects a message whose sender cannot be projected to it. The canonical peer-key spelling is checked by transport peer parsing and used in its authenticated inbound sender.
Before a projection commits, every event in its returned page must exactly match the approved association's `message.origin` and `message.run_hint`. A mismatched or mixed page is `LINKS_EVENT_INVALID`; it writes neither archive events nor a cursor advance.

## Identities and states
- Origin: see "Canonical origin" above. `local`, or `peer:<key>` where `<key>` is the authenticated transport peer key, as `try_deposit` writes `sender = peer:<key>` from the authenticated peer. The roster lists the bare key; the JS compares `peer:<key>` with it. Transport peer parsing accepts the canonical key spelling; inbound transport constructs the sender from the authenticated peer. The history engine tests must verify the same origin spelling after integration.
- `rejected` is a delivery state of its own (the sender's outbox could not hand the message over). It is carried as `state: rejected` with `stage` beside it, shown red, never folded into a delivered state. An unknown state is refused by the client.
- Engine refusal codes reach the service prefixed `LINKS_` (`FIELD_UNSUPPORTED`, `REQUEST_INVALID`, `UNKNOWN_OP` mark an engine too old for the extended `list`); covered by a test through the real client.

## Versioning of projected events
Event ids hash store, run, message (and seq for status). They do not include a payload version, so a payload for an existing id must never change. A change to what is projected uses a new event type or a version-qualified id and its own cursor key (`parserVersion` is already part of the cursor key). An id seen again with different content is `LINKS_PROJECTION_CONFLICT` (blocked, never skipped). No migration framework is planned.

## Archive side (this branch)
- `commitImport` takes optional `fence:{runId, generation, associationId}`, checked inside the same transaction; `SPANS_MODEL_FENCE_STALE` writes nothing.
- `commitFencedEvents({events, fence})`: the same fence, events only, no view write and no revision bump. Used by evidence.
- `listRuns` tolerates a run whose stored view is not valid JSON (it lists the id; `readRun` of it still refuses).
- Run view key `linksAssociations[associationId] = {origin, hint, generation, epoch, status}`.
- Derived lookup `spans_cache` key `links-assoc-index:<sha256(origin,hint)>` -> `{runs:[...], overflow}` (<=16 runs; `overflow` when more approved the pair or a run could not be read). Recovery reports `index-incomplete` when `overflow` is set and no listed run is currently approved. The run view is the authority; the index only lets Recovery name a run, and a missing entry reads as "no approval found".
