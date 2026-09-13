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

## Cancellation reconciliation update (source change, 2026-09-13)

The following behavior supersedes the original blanket `PROVIDER_BOOKING_BOUND`
rule and scheduled scan description above. Deploying this version and applying it
are separate operational actions; this source change does not alter the live timer.

A `PREPARED`/`PENDING_CONFIRMATION` claim with `bookingId` or `upstreamBookingId` may
be released only after its deadline and a complete read of that exercise proves:

- both binding aliases agree, and exactly one row has that booking ID;
- client and subscription aliases match exactly, with no conflicting exercise ID;
- the booking is explicitly cancelled, with no contradictory flags/statuses;
- no other active or potentially relevant unidentified booking remains.

Absence of a bound row, payment failure/refund, expiry, and exercise archival are
not evidence that this booking was cancelled. Unknown active clients and conflicting
aliases fail closed, including for unbound claims.

CREATE attempts (including `lk1.createAttemptedAt`, `lk1.bookingAttemptedAt` and
`createPayload`) remain manual. Managed entitlements, visit jobs, transactions,
checkout and pending activation also remain manual: this reconciler only changes
its claim, so it cannot prove those other actions closed. The observed incident has
both a cancelled upstream booking and CREATE attempt markers; its expected dry-run
result is `CREATE_ATTEMPT_REQUIRES_MANUAL_RECONCILIATION`, not automatic release.
No production identifiers or provider exports belong in fixtures or this document.

Before each write the CLI re-reads the matching Mongo preimage and performs a new
Viva GET (not the scan cache). CAS includes identity, both binding IDs, `lk1`, related
operation fields, and deadline fields, with explicit absence predicates. This catches
runtime writers that change `lk1` without changing `updatedAt`. A fresh-read failure
or CAS mismatch prevents that write and returns a nonzero exit code. Exact scanned
preimages are still backed up first. Money/visits/provider data are never written.

### Bounded traversal

Apply uses a persistent operation-key cursor by default at
`<backup-dir>/.scan-cursor.json`; `--cursor-file` overrides the location. Each tick
reads at most `--limit` candidates ordered by string `_id`, resumes after the prior
key, and wraps when it reaches the end. Skipped records therefore cannot permanently
occupy the first batch. Query filters are part of the cursor scope. Non-string keys
are rejected rather than silently skipped. Every active candidate is visible even
without `updatedAt`; the pure guard checks explicit deadlines or `createdAt` fallback.
The latest valid explicit deadline wins if several are supplied.

`--sort oldest|newest` remains available for one-shot audits **without a cursor**.
In apply mode the cursor order takes precedence, including for an existing wrapper's
nightly larger batch. Keep the wrapper's `flock`: concurrent cursor writers are not
supported. Cursor files are atomic and private (`0600`). Dry-run may read a cursor
but never advances it. Failed writes/fresh reads keep its position for retry.

When packaging this version include all three source files:
`reconcile_hung_subscription_claims.mjs`, `lib/hungClaimRelease.mjs`, and
`lib/hungClaimScan.mjs`. The live copy previously had CREATE guards absent from main;
this change retains those protections rather than replacing them with the older copy.

### Verification and limits

- `node --test scripts/tests/hungClaimRelease.test.mjs`: pure guards and CLI offline
  rehearsal. The Mongo test explicitly skips without its isolated fixture URI.
- `HUNG_CLAIM_TEST_MONGO_URI=mongodb://127.0.0.1:<fixture-port> node --test scripts/tests/hungClaimRelease.test.mjs`:
  real MongoDB 7, loopback-only fake Viva; dry-run/no writes, exact cancellation,
  fresh provider failure/active state, concurrent `lk1` change without `updatedAt`,
  repeat apply, and traversal to a legacy claim. The test creates and drops only its
  uniquely named `hung_claim_verify_*` database. No production endpoints are used.

Residual runtime boundary: generic confirm/fail continuations currently match
`_id + operationId` without a state predicate and may overwrite a released claim
**after** reconciliation. CAS protects the write preimage, not those future writers.
Fencing those runtime paths is a separate Node-RED change; do not claim this script
fixes all delayed continuations or completes CREATE/payment/visit reconciliation.
