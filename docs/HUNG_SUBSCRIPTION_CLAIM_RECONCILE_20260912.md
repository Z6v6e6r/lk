# Hung subscription claim reconciliation (2026-09-12)

## Symptom

A player sees `Лимит по подписке исчерпан` (price preview state `LIMIT_USED`) for a
subscription instance they have not used on that date, for example on the annual
`Падел.Дружба.ХАБ — годовая` product.

## Mechanism

One daily subscription seat is held by one claim document in
`lk_subscription_daily_booking_ops` (`_id = tenantKey + clientSubscriptionId + YYYY-MM-DD`
for the daily policy, `lk1-product:[tenantKey, actorClientId, operationId]` for the HUB
policy). The usage reader in the price preview and in the HUB gateway counts every claim
that is not `FAILED`/`RELEASED`:

- its `lk1.decision.gameMinutes.freeMinutes` reduce `usedOrReservedFreeMinutesToday` for
  the same `serviceDate`, which is the whole free-minute allowance of that day;
- a claim that carries `bookingId` marks its provider booking as a benefit booking, so it
  occupies an `activeServices` slot against `maxActiveBookings`.

The runtime releases a claim on the request path: an explicit cancellation, or an expired
`PENDING_CONFIRMATION` claim that a Viva readback cannot match to an active booking. Both
paths need a *new request for that same subscription instance*. A claim written before the
playback ended, or written without a deadline, therefore keeps consuming the limit with no
automatic way out.

Production scan on `147` (`games.lk_subscription_daily_booking_ops`, 2026-09-12T07:37Z):

| state | count | oldest | newest |
| --- | --- | --- | --- |
| CONFIRMED | 11576 | 2026-08-08T19:11Z | 2026-09-12T07:35Z |
| PENDING_CONFIRMATION | 698 | 2026-08-08T19:34Z | 2026-09-12T07:12Z |
| RELEASED | 1118 | 2026-08-09T06:10Z | 2026-09-12T07:36Z |
| FAILED | 69 | 2026-08-12T21:37Z | 2026-09-12T06:37Z |

Most stuck claims carry `pendingUntil` long in the past and no `bookingId` (for example
`2026-09-11T15:47Z` at scan time). HUB claims written by `gateway_hooks.js`
(`// HUB_PREACCEPT`) move `PREPARED` to `PENDING_CONFIRMATION` and `$unset` `leaseUntil`
**without writing `pendingUntil`**, so those records have no deadline at all: the
reconciler falls back to `updatedAt + ttl`.

## Tool

```sh
# audit only, no writes, no provider call without a token
npm run subscriptions:reconcile-hung-claims -- --flows <flows.json> --ttl-minutes 30 --quiet

# provider-verified release of the scanned batch
npm run subscriptions:reconcile-hung-claims -- --mongo-url-file <uri> \
  --token-file <viva-admin-token> --apply --backup-dir /root/.node-red/.padlhub-hung-claims --report /root/.node-red/.padlhub-hung-claims/report.json
```

Guards (each has its own reason code in the report):

| reason | meaning |
| --- | --- |
| `STATE_TERMINAL` | already `CONFIRMED`/`FAILED`/`RELEASED` |
| `STATE_REQUIRES_MANUAL_RECONCILIATION` | `PRECREATE_*` state: an accepted CREATE may already have created the game, so only a game-side manual reconciliation may release it (the scan reports it, never writes) |
| `STATE_NOT_HUNG` | state outside both lists |
| `PROVIDER_BOOKING_BOUND` | claim carries `bookingId`/`upstreamBookingId`; the provider owns it |
| `IDENTITY_UNRESOLVED` | no actor or no subscription on the record |
| `DEADLINE_MISSING` | no `pendingUntil`/`leaseUntil` and no `createdAt`/`updatedAt` |
| `DEADLINE_NOT_REACHED` | still inside the claim window |
| `PROVIDER_EVIDENCE_MISSING` | no complete Viva readback for that exercise |
| `PROVIDER_SUBSCRIPTION_ID_UNRESOLVED` | the provider shows a live booking of this actor without a resolvable subscription |
| `PROVIDER_BOOKING_ACTIVE` | provider still shows an active booking for actor + subscription |

- Release is a compare-and-swap on `_id + operationId + state + updatedAt`; a concurrent
  request path wins and the reconciler reports `compareAndSwapFailures` instead of
  overwriting it.
- `--apply` requires both `--backup-dir` (exact scanned documents, mode 0600) and a
  provider token; a missing token fails loudly before any write.
- Reports contain a 12-character hash label per claim, never the raw claim id, actor or
  subscription. Nothing is printed about credentials.
- Recommended schedule: every 15 minutes after the 30-minute TTL, with `--limit` bounded
  to the batch an operator wants to review.

Tests: `npm run test:hung-claim-release`.

## Live result (2026-09-12, `147`, owner-approved)

Provider-verified run against `games.lk_subscription_daily_booking_ops`:

| step | result |
| --- | --- |
| verified dry-run (698 scanned) | `RELEASABLE 223`, `PROVIDER_BOOKING_ACTIVE 452`, `PROVIDER_BOOKING_BOUND 21`, `PROVIDER_SUBSCRIPTION_ID_UNRESOLVED 2`, 33 s |
| apply | `released 223`, `compareAndSwapFailures 0` |
| postcheck | `PENDING_CONFIRMATION 698 -> 475`, `RELEASED 1118 -> 1340` |
| postcheck dry-run (475 scanned) | `RELEASABLE 0`; the rest all hold a live provider booking, a `bookingId`, or an ambiguous provider row |
| claims open on today-or-future dates | `51 -> 32` (19 released); the remaining 32 (16 `PROVIDER_BOOKING_ACTIVE`, 16 `PROVIDER_BOOKING_BOUND`) correspond to a real provider booking |

Custody on the host: `/root/.node-red/.padlhub-hung-claims-20260912/` (`hung-claims-…json` backup,
`apply-…json`, `postcheck-dry.json`, all mode 0600). The service token was minted in a temporary
0600 file from the running node-red process environment, never printed, and deleted after the run.

Reproduce with the same command and a fresh token; nothing in the run depends on stored state.

## Residual work (not in this change)

- `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` (`// HUB_PREACCEPT`) should write
  `pendingUntil` when it moves a HUB claim to `PENDING_CONFIRMATION`, so the reconciler has
  a declared deadline instead of the TTL fallback. This is a reviewed HUB flow packet
  (`patch_live_lk1_hub.mjs`, composition contract, live preimage), so it ships separately.
- The price preview and HUB usage readers still count an *unexpired* claim; that is
  intended (double-spend protection).
