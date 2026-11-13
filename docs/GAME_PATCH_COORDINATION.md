# Game PATCH coordination and readback

Cabinet and the games overlay independently bundle `apiClient`. They share the
versioned, document-local `Symbol.for('padlhub.gamePatchCoordinator.v1')` registry.
The resource key includes backend, tenant and game. Auth scope, exact JSON payload
and repair intent are SHA-256 digests; raw tokens, payloads and results are not
retained after completion, logged or persisted by the coordinator.

Only explicit `roster_sync` and `related_phones` background repairs coalesce.
The request body is snapshotted before asynchronous admission. Equivalent pending
requests share one PATCH, logical operation ID and canonical readback. A different
background request skips while the resource is busy; no stale request is queued.
Manual actions and mandatory post-provider finalizers retain their original
admission and are observed until readback/publication completes. They are never
silently coalesced, dropped or automatically retried.

Completed repair intents leave digest tombstones, including after a 409 or an
ambiguous transport outcome. A changed base version or effect cleanup/remount
alone cannot replay that intent. A changed provider/input intent, auth scope or
document reload can start another repair. Retention is bounded to 16 intents per
resource; inactive resources may be evicted after 128 resources. Active admission
and pending readbacks cannot be evicted. No cross-tab serialization is attempted.
If crypto or the registry is unavailable, background repairs skip; manual writes
retain admission.

PATCH and post-PATCH GET have zero transport retries. The GET uses `no-store`.
A 409 remains a failed mutation even when its readback succeeds. An accepted PATCH
remains accepted when readback fails: callers receive `writeAccepted`,
`snapshotKind: partial_ack` and only fields actually present in the ACK. Unknown
ACK fields are never fabricated by normalization; version fields do not advance
the local snapshot. Unversioned ACKs carry only the game ID. The roster/metadata
edit handlers show that the write was saved and current state needs refreshing,
without encouraging replay of an external workflow.

A canonical snapshot requires the requested ID, raw participants and waitlist
arrays, and a known version before normalization. It replaces roster and business
metadata rather than unioning old players or reapplying submitted arrays. Local
non-enumerable markers distinguish snapshots from legacy partial updates. Version
comparison rejects older readbacks and ACKs; an incomparable ACK cannot overwrite
an existing record. A pending ACK retains a separate version lower bound, so a
late GET cannot install an older snapshot. Unknown canonical versions cannot
replace a record or pending ACK with a known version.

Publication is independent of the initiating effect's lifetime. Mounted games
views and Cabinet consume the result event within their auth session, update only
the existing active game, and merge partial ACK fields before identity filtering.
An ID-only ACK therefore does not hide a game or switch the active view.

## Server boundary and limitations

Node-RED precondition/CAS authorization and rejection behavior are unchanged.
Manual writes may start during an existing background PATCH, and different tabs
can still race: their 409 is intentional protection, not a reason to retry.
The existing metadata-only related-phones repair keeps its existing payload.
It does not enter the roster bridge CAS path; adding artificial roster arrays
would also rewrite phone indexes and result roster snapshots. A dedicated server
metadata CAS contract is separate work. This client coordination is not a claim
of atomic metadata writes across tabs or clients.

No server hooks, production data, live cancellations or refunds are changed by
this patch. Regression coverage uses synthetic transport/provider data and actual
API helpers, independent utility evaluations and extracted UI callbacks.
