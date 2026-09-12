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
| `PROVIDER_EVIDENCE_MISSING` | the exercise readback failed, timed out or returned nothing usable |
| `PROVIDER_EVIDENCE_INCOMPLETE` | the readback cannot be proven complete: no list, a page that declares more rows, `last: false`/`hasNext: true`, a later page, or a bare array that fills the requested `size=200` page |
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

## How a release proves that no booking exists

The decision never trusts the local record alone. In order, and each failing step keeps the claim:

1. **Local state.** Only `PREPARED` and `PENDING_CONFIRMATION` are candidates. `CONFIRMED`,
   `FAILED`, `RELEASED` stop at `STATE_TERMINAL`; `PRECREATE_*` stop at
   `STATE_REQUIRES_MANUAL_RECONCILIATION` because an accepted CREATE may already have created
   the game.
2. **Provider binding.** A claim that already carries `bookingId`/`upstreamBookingId` is the
   provider's to release (`PROVIDER_BOOKING_BOUND`).
3. **Identity.** Actor and subscription instance must both be present (`IDENTITY_UNRESOLVED`).
4. **Deadline.** `pendingUntil`, else `leaseUntil`, else `updatedAt`/`createdAt` + TTL. No
   timestamp evidence at all means `DEADLINE_MISSING` — such a claim is never released
   automatically. A deadline in the future means `DEADLINE_NOT_REACHED`.
5. **Provider readback.** `GET /api/v1/exercises/{exerciseId}/bookings?showCancelled=true&size=200`
   with the service token, 10 s timeout, no redirects, cached per run. A failed read, a payload
   without a list, or a page that cannot be proven complete gives `PROVIDER_EVIDENCE_MISSING` /
   `PROVIDER_EVIDENCE_INCOMPLETE` — "could not verify" always means "do not release".
6. **Ownership of the readback.** Any live row of this actor whose subscription cannot be
   resolved gives `PROVIDER_SUBSCRIPTION_ID_UNRESOLVED` (the same rule the runtime applies),
   and any live row matching actor + subscription gives `PROVIDER_BOOKING_ACTIVE`. Cancelled,
   archived, failed and refunded rows do not protect the claim.
7. **Compare-and-swap.** The write repeats `_id + operationId + state + updatedAt`; a request
   path that touched the claim in the meantime wins and the claim is left alone.

Even a wrong release cannot invent capacity: a claim is a local reservation, Viva stays the
authority, and the runtime's usage reader also counts provider bookings that no claim covers, so
a real booking keeps consuming the limit regardless of a released local claim. The bounded
residual case is a booking the readback genuinely cannot show (for example an exercise holding
more than the requested page of rows); that case is exactly what step 5 now refuses.

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

## Scheduled run on `147` (every 15 minutes)

Installed on 2026-09-12 with owner approval: `/root/.node-red/hung-claim-release/`

| path | role |
| --- | --- |
| `scripts/reconcile_hung_subscription_claims.mjs`, `scripts/lib/hungClaimRelease.mjs` | host copy of the two reviewed files, source commit recorded in `MANIFEST.json` with sha256 |
| `run-release.sh` | wrapper: `flock` (no overlapping ticks), token cache, reconciler `--apply`, log append, backup pruning |
| `state/viva.token` | cached service token, mode 0600, re-minted when older than 24 h |
| `state/run.log` | one JSON line per tick, mode 0600, trimmed to the last 2000 lines |
| `state/report.json` | report of the last tick, mode 0600 |
| `backups/` | exact scanned documents of every releasing tick, mode 0600, kept 30 days |

Units: `padlhub-hung-claim-release.service` (`Type=oneshot`, `ExecStart=run-release.sh`) and
`padlhub-hung-claim-release.timer` (`OnCalendar=*:0/15`). Every tick scans the freshest claims
(`--sort newest --limit 60`, `--ttl-minutes 30`) so a claim hung since the previous tick is
released within about half an hour; the 04:00 MSK tick is a deep sweep (`--sort oldest
--limit 2000`) that also re-checks claims which keep a provider booking. A tick that finds
nothing to release writes no backup.

Stop signals: any `compareAndSwapFailures` in a tick, a `WORKER`-level error line, or a tick that
releases an implausible batch (far above the one-off 223 baseline). Stop method: `systemctl disable --now padlhub-hung-claim-release.timer`
(the released documents stay in `backups/`). A release only writes claim documents — no provider
data, no booking, no ledger — and the runtime treats `RELEASED` exactly like a cancelled claim,
so the affected player can simply book again.

## Residual work (not in this change)

- `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` (`// HUB_PREACCEPT`) should write
  `pendingUntil` when it moves a HUB claim to `PENDING_CONFIRMATION`, so the reconciler has
  a declared deadline instead of the TTL fallback. This is a reviewed HUB flow packet
  (`patch_live_lk1_hub.mjs`, composition contract, live preimage), so it ships separately.
- The price preview and HUB usage readers still count an *unexpired* claim; that is
  intended (double-spend protection).
