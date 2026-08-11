# Durable player leave for LK Games

## Scope

The authenticated route remains:

```text
POST /lk/games/:gameId/split/leave
```

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

## Required rollout checks

- Build the candidate from a fresh read-only live pull and retain source and
  candidate SHA256 values.
- Import only after separate deployment approval and a fresh preimage check.
- Test a synthetic subscription player and a synthetic card player.
- For the subscription case, verify in order: Viva history cancelled, daily
  operation `RELEASED`, game participant removed, slot visible as free.
- Test page closure after `STARTED`; confirm the background worker completes
  the same operation without a duplicate cancellation.
