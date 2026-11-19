# GET route verification scenarios (Hermes)

Source: PR #452 head `81da12551154bfca1f71444bdbfb6df3fdded595`.
Scope: the three read-only residency GET routes and the activation guard they feed.
Synthetic/isolated only: disposable Mongo, fixture Viva/CUP/Keycloak, no real payment,
no 147 change. This document is the handoff script; it does not authorize a live call.

## Preconditions

- Use the packet `residency-pilot-install-20261119`, exact head above.
- Fresh disposable database; apply the five indexes with `apply-indexes.js`.
- `LK_RESIDENCY_LIFECYCLE_ENABLED=true`; keep `CREATE_ENABLED` as the scenario needs.
- A verified pilot bearer whose `tenantId:userId` is in the server allowlist.
- Fixture counters for: Mongo writes, provider POSTs, provider reads, CUP
  `residency-booking-refresh` calls, and CUP `residency-booking-context` reads.
- Snapshot the durable order row before and after every GET: `state`, `revision`,
  `activeSlot`, `payment.status`, `updatedAt`.

## Routes under test

| Route | Handler contract | Forbidden side effects |
| --- | --- | --- |
| `GET /lk/residency/orders/{orderId}` | durable projection | no expire, no transition, no provider read/write, no activation |
| `GET /lk/residency/orders?state=unresolved` | projection plus `externalCheck` | no expire, no transition, no activation; the external read is GET-only |
| `GET /lk/residency/orders/{orderId}/payment` | payment projection | no provider read, no new link, no write, no activation |

All three need only `Authorization: Bearer <pilot JWT>`; no `Idempotency-Key` and no body.

## Scenarios

### G1. Order read after the local payment window

1. Create an order and let `payment.expiresAt` pass (fixture clock; do not call reconcile).
2. `GET /lk/residency/orders/{orderId}`.

Expected: `200`; the same `revision`, `state`, `activeSlot` and `payment.status` as
the stored row; `recovery.state=AWAITING_CONFIRMATION` when the stored payment is still
`PENDING`; `writes=0`, `activationCalls=0`, `providerReads=0`, `refreshCalls=0`.
The read must not turn the order into `EXPIRED`.

### G2. Unresolved list with `externalCheck`

1. Keep one unresolved order and, separately, a fixture external operation that is
   `OPEN`, then `UNKNOWN`, then `PAID` after the order.
2. `GET /lk/residency/orders?state=unresolved` (optionally `&limit=20`; any other
   `state` or `limit` is `400 RESIDENCY_REQUEST_INVALID`).

Expected: `200`; `count` counts only non-terminal own orders; `externalCheck` exposes
`state`, `openCount`, `paidAfterOrderCount`, `requiresReview`, `retryable`.
`writes=0`, `activationCalls=0`, `refreshCalls=0`; the external list is read with GET
only. An unavailable list yields `externalCheck.state=UNAVAILABLE` (or the documented
fail-closed equivalent), not "no other purchase".

### G3. Payment projection after the local window

1. Same expired-window order as G1.
2. `GET /lk/residency/orders/{orderId}/payment`.

Expected: `200` with the persisted `paymentUrl`, `paymentStatus`, `expiresAt`,
`overdue=true`, `terminal=false`; no provider read, no new payment link, no write.
`providerReads=0`, `writes=0`, `activationCalls=0`, `refreshCalls=0`.

### G4. External conflict at reconcile

1. Create and confirm the order locally; make the fixture external list return one
   `OPEN`, `UNKNOWN` or `PAID` operation not owned by this order (run each variant).
2. `POST /lk/residency/orders/{orderId}/reconcile` with one `Idempotency-Key` and
   `{"eventId":"<stable synthetic id>"}`.

Expected: `200`; order `state=PAID_REQUIRES_REVIEW`, `reviewRequired=true`,
activation `lastErrorCode=EXTERNAL_PAYMENT_DETECTED`, `activationCalls=0`,
`refreshCalls=0`, no provider POST. Return the same body with
`idempotentReplay=true` on a repeat, still `activationCalls=0`.

### G5. Conflict at an immediate PAID create

1. Fixture returns `PAID` on the create path with a conflicting external operation.
2. `POST /lk/residency/orders` with `Idempotency-Key`, `expectedTotalMinor` and
   `expectedProductId`.

Expected: the order exists, `state=PAID_REQUIRES_REVIEW`,
`EXTERNAL_PAYMENT_DETECTED`, `activationCalls=0`, `refreshCalls=0`.

### G6. One confirmed payment, repeat and restart

1. One confirmed provider payment; call reconcile once.
2. Call reconcile again with the same key/event, then restart Node-RED and call it again.

Expected: exactly `1` activation total; `firstReconcileActivations=1`,
`afterRepeatActivations=1`, `afterRestartActivations=1`; one `ACTIVE` order, one
residency window from `activeFrom`/`activeTo`, no second payment link, no second
provider POST.

### G7. Stale `IN_FLIGHT` after a crash with CUP context

1. Leave a bounded `PAID_ACTIVATION_PENDING`/in-flight claim from a crashed worker.
2. Fixture CUP `residency-booking-context` returns `ACTIVE`; reconcile.

Expected: order finalized `ACTIVE` from the context; `contextReads=1`,
`refreshCalls=0`; a second reconcile does not repeat the refresh.

### G8. Stale in-flight with unreadable CUP context

1. Same stale claim; CUP context is unavailable.
2. Reconcile.

Expected: order stays `PAID_ACTIVATION_PENDING`, `retryable=true`,
`lastErrorCode=ACTIVATION_CONTEXT_UNAVAILABLE`; `refreshCalls=0`. Retry after the
context is readable, not by sending a second activation.

### G9. `ACTIVE` order and a later external PAID

1. Activate one order, then add an external `PAID` operation created after it.
2. `GET /lk/residency/orders?state=unresolved`.

Expected: the active order itself is not listed (`count=0` if it is the only own order);
`externalCheck.paidAfterOrderCount=1`, `requiresReview=true`; no activation, no write.

## Evidence to attach

- Per-scenario request/response with bearer, phone, client ids and payment URLs redacted.
- Counter snapshot from `counters.json` plus the durable-row before/after.
- For G4/G5 pointer to the error code and `activationCalls=0`.
- For G6 the restart marker and `afterRestartActivations=1`.
- Failures must name the first broken step, the exact route/operation and the missing
  access or fixture, not a generic "pilot failed".

Reference run: `docs/evidence/residency-pilot/activation-guard-20261119/README.md` and
`counters.json` (137 lifecycle tests, 0 skipped, disposable `mongo:8.0.5`).
