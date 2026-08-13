# Durable player leave for LK Games

## Scope

The authenticated route remains:

```text
POST /lk/games/:gameId/split/leave
```

The CUP backend has a separate service-to-service command and status contract:

```text
POST /lk/internal/staff/games/:gameId/player-leaves
GET  /lk/internal/staff/games/:gameId/player-leaves/:operationId
Authorization: Bearer ${CUP_LK_PLAYER_LEAVE_TOKEN}
Idempotency-Key: <8..128 safe characters>   # POST only
```

The POST body must contain an exact `target.clientId`, exact active
`target.bookingId`, `expectedMembershipVersion`, `staffActor.id`, reason
`CUP_STAFF_REMOVAL`, and `visitAction` (`RETURN_VISIT` or `NO_RETURN`). The
server maps those actions strictly to Viva Admin refund methods `SERVICE` and
`NONE`; it never uses an End User token for staff removal. A missing token
configuration fails closed with 503, while a missing or wrong bearer returns
401. Neither the bearer nor the raw idempotency key is persisted.

Staff removal is rejected when the target is the organizer, the booking is not
active for the exact client, the phone is linked to another strong client ID,
or the membership generation is stale. The deterministic operation ID is
`staff-leave:<game>:<client>:<membershipVersion>`. Reusing it with a different
visit action is a conflict. A new idempotency key after a page reload resolves
the same logical operation; the first key digest is retained for audit only.

The status endpoint exposes only the bounded states `IN_PROGRESS`,
`FINALIZING`, `DONE`, and `ATTENTION_REQUIRED`. The player remains in the LK
roster until Viva read-back, daily-limit release, and the roster CAS have all
completed. Daily-limit release applies to both visit actions; `NO_RETURN`
changes only the Viva visit-refund choice.

The browser sends only the game ID, reason, and an optional refund method for
self-leave. Player identity, Viva exercise, booking IDs, and the immutable
membership generation are resolved server-side from the verified Viva profile
and the game document.

## State and retry contract

1. Persist `STARTED` before the first Viva mutation.
2. While the LK page remains open, the same verified self actor may CAS-reclaim
   the same `STARTED` operation and perform another End User attempt. The UI
   makes five bounded attempts and displays `Покидает игру` with a spinner.
3. `STARTED` and `VIVA_CONFIRMED` claim leases are 90 seconds. The existing
   two-minute worker may then reclaim either Viva cancellation or local/daily
   synchronization on its next tick. Recovery remains bounded by 20 attempts.
4. Viva success requires both exact readbacks: the target booking is absent
   from active bookings and present as cancelled in history. Only then persist
   `VIVA_CONFIRMED`.
5. Before changing the game roster, find the exact daily subscription claim by
   trusted `tenantKey + actorClientId + exerciseId`. If one exists, atomically
   move it to `RELEASED` and record the cancelled booking IDs. Zero rows means
   the booking did not use the tracked subscription gateway. Multiple or
   mismatched rows fail closed and stay retryable.
6. Apply the game roster CAS only after Viva proof and daily-claim release.
   Persist `DONE` only after the local generation fence succeeds.

The frontend never releases the daily claim directly in this flow. Therefore
closing the page cannot lose the limit-release step, and the Admin fallback
uses the same backend state machine.

## Node-RED source functions

- `fn_split_leave_operation_start.js`
- `fn_split_leave_operation_route.js`
- `fn_split_leave_operation_claim.js`
- `fn_split_leave_retry_select.js`
- `fn_split_leave_daily_limit_find.js`
- `fn_split_leave_daily_limit_route.js`
- `fn_split_leave_daily_limit_ack.js`
- `fn_split_leave_operation_done.js`

The guarded candidate builder is
`scripts/patch_live_games_durable_leave_v2.mjs`. It accepts only the exact
verified live preimage, preserves all HTTP routes, changes eight existing
nodes, and adds six nodes inside the active `LK Games` tab. Building a
candidate does not import, restart, deploy, or mutate production data.

The staff API is added by the separate guarded builder
`scripts/patch_live_games_staff_player_leave.mjs`. It accepts only live SHA256
`157e92c2b02a950f95a7ae609dbba637ea0baa61fa4b0f4cde01bec32f492bf1`
(4724 nodes, 209 routes), changes seven existing durable function bodies, and
adds ten source-driven nodes including exactly two internal routes. It produces
a candidate and report only; it never imports or restarts Node-RED.

## Required rollout checks

- Build the candidate from a fresh read-only live pull and retain source and
  candidate SHA256 values.
- Import only after separate deployment approval and a fresh preimage check.
- Test a synthetic subscription player and a synthetic card player.
- For the subscription case, verify in order: Viva history cancelled, daily
  operation `RELEASED`, game participant removed, slot visible as free.
- Test page closure after `STARTED`; confirm the background worker completes
  the same operation without a duplicate cancellation.
