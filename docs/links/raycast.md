# Setu Links in Raycast

The local **Links** Raycast command is a front door to the running Setu portal. It calls only the existing `/api/links/*` routes and `/api/agent-sessions`; the portal's Links service and engine remain the authority for every message, policy and status.

## What it provides

- An exact managed-session selector, inbox and message detail. Detail shows the message body, effective and stored status, attempts, reply-to, recipient session, provider and an optional run hint/reference. A run hint is not a linked run claim. Local Setu Links is the source.
- Queue, acknowledge and cancel actions. A send is accepted only when the service re-verifies the selected owned, running Claude binding and checkout. The Raycast row is only a selector, never a binding proof.
- Reviewed redelivery for `handoff-unknown`. The review displays the exact message, unknown attempt and recipient. A malformed or mismatched review cannot enable confirmation.
- Shared-project directory and settings. Sharing and attention opt-in display the service's complete review fields before confirmation. Disabling sharing or attention uses the same service policy.
- The service capability view. When `wake.available` is false, Raycast labels Send now unavailable and shows the stable service code. It does not try to wake, paste into, or start a session.

Attention stays in the existing Setu portal worktree attention view. Each managed-session row links to that exact worktree instead of creating a second human inbox or adding a notification route.

## Recovery and freshness

Raycast never opens SQLite or invokes the Links engine. A failed or malformed Links mutation response is `LINKS_OUTCOME_UNKNOWN`; it is not replayed. Raycast keeps the exact uncertain draft, including its idempotency key, in its local command cache so it remains available after navigation. It is retried only by the explicit same-key retry action. Editing its body or reply-to creates a separate intent with a new key, without replacing the uncertain original. A late result cannot clear a newer draft, and one target has only one submission in flight.

Directory presence is informational. A stale row displays as unknown, and an unreachable or unverified Codex row is never shown as delivery-ready. An unavailable or malformed inbox, directory or policy response is shown as unavailable rather than empty or disabled; a previously successful detail or inbox remains visibly stale until refreshed. Inbox reads say when the service could only show stored status rather than compare the current binding. The service always performs the final current-target checks.

Routine failure UI shows a stable code and recovery direction, not the message body, idempotency key, native conversation ID or an arbitrary service error. Message bodies appear only in the explicit message detail view.

## Validation boundary

`bun run test:links-raycast` covers the local client/controller contract: unknown sends, changed intents, review mismatch, unavailable permissions, stale directory rows, Send now unavailability and routine failure redaction. It uses injected fetch only. It is not native Raycast acceptance and does not exercise a provider, portal, engine or wake mechanism.
