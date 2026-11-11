# LK1 native free-visit cancellation

`POST /lk/subscription-bookings?action` accepts body `{ action: "cancel-free", bookingId }`
and an idempotency key in the existing operationId query/header. The existing profile GET
binds the actor; the request cannot supply a subscription, refund proof or client identity.
Only a proven other payment contour returns `NOT_MANAGED`, permitting legacy cancellation.
Unknown ownership, provider errors and native cancellation failures never authorize fallback.

The native path covers a server-owned zero-money LK1 operation with exactly one visit.
The server reads cancellation options and the exact subscription consumption baseline,
queues an immutable explicit-request job, takes a per-subscription CAS lock, and excludes
other pending visit writes before one durable `CANCEL_INTENT` winner may dispatch SERVICE.
Accepted background work requires a majority+j durable readback barrier. An unknown dispatch
outcome is reconciled by GET; neither another cancellation nor a direct balance write is issued.
A declined request is terminal. A later explicit request uses a fresh request ID.

The provider currently supplies no native refund receipt ID. Return verification therefore
requires conservation: the exact cancelled booking disappears from consumption, visitsLeft
increases by exactly one, visitsTotal is unchanged, and every other consumption binding is
unchanged. Incomplete pagination, unrelated balance/consumption changes, money, CUP operations
and uncertain evidence keep the reservation. Full frozen-operation CAS adds the return proof
and marks the operation RELEASED without rewriting its original decision or deleting a guard.
A fresh daily-guard takeover and same-event successor require that proof and re-run normal
instance, target, pricing and allowance validation. NONE cancellation cannot mint a return.

The inline Node-RED adapter and background worker execute the same pure protocol. The worker
processes only explicit pending jobs, independent of the unpaid cohort cutoff, within its
existing bounded cycle. Schema-1 unpaid cursors retain their positions. Session-bound client
polling reports success only after RELEASED, and accepted timeouts explain background recovery.

## Source and release boundaries

`scripts/patch_live_lk1_free_cancellation.mjs` applies exact deltas to the live prepare,
router and finalizer functions, with no graph/wire additions. Frozen historical canonical
prepare/router files remain unchanged; `lk1FreeCancellationSourceDeltas.json` carries reviewed
anchors. Historical patchers explicitly restore their generation's original source.
Fresh live origin and exact graph contract verification remain required for publication.
The worker's flow/gateway pins must match the candidate as a pair.

Before paired deployment, audit unpaid INTENT/REVIEW and native free job
QUEUED/CANCEL_INTENT/RETURN_PENDING; do not stop over unresolved provider work. Preserve
cohort, cursor, service-token custody and permanent flow-read authorization. Hold the shared
reviewed-flow lock through stop, flow publication, runtime verification and worker rebind.
Once a new native intent exists, an old worker/flow rollback is unsafe: retain the compatible
GET reconciliation path and resolve pending work before considering rollback. Frontend
publication preserves every installed artifact lineage and checks public hashes separately.

Validation includes fixture provider faults and real compiled Node-RED functions. This is
separate from a production SERVICE mutation canary; synthetic tests must not create or cancel
an actual customer's booking. A production cancellation is complete only with the provider
readback and the persisted return proof, not merely an HTTP success or green build.
