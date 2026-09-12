# Stale annual HUB claim reconciliation (2026-09-12)

## Symptom

The annual subscription storefront shows `0 из 1` for the HUB product
(`network_friendship`, 98 000 ₽) for a long time even though no purchase was
completed, so the single daily seat looks taken by nobody.

## Mechanism

The HUB annual inventory is a bounded daily seat: one new seat per Moscow day,
tracked by a `reservations` entry inside the atomic ledger
(`_id = inventory:<inventoryId>`, `documentType = HUB_ATOMIC_INVENTORY_LEDGER`,
`counterKey = network_friendship`, `schemaVersion = 3`).

- A checkout attempt writes a reservation (`CLAIMED → DISPATCHING →
  PAYMENT_PENDING / PROVIDER_UNKNOWN`) and increments `reservedCount` /
  `dailyReservedCount` through `scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js`.
- The reservation carries the provider's checkout deadline (`expiresAt`, the
  ~20-minute payment-link window) and is released to `FAILED`/`PAID` only when
  the confirmation path observes an explicit terminal Viva state.
- The periodic reconcile deliberately keeps polling a non-terminal transaction:
  `scripts/nodered_games_nodes/fn_tournament_subscription_reconcile_query.js`
  ("Provider state, not the local checkout deadline, is authoritative for
  releasing bounded inventory").

So when the payment link dies without Viva ever reporting a terminal state, the
reservation stays active, `dailyReservedCount` stays 1 and the storefront keeps
showing `0 из 1`. The reviewed manual escape hatch for exactly this case is
`scripts/repair_release_annual_claim.mjs` (`975bfa36`); it is one-off and needs
an operator.

## Tool

```sh
# audit only, no writes
npm run subscriptions:reconcile-stale-annual-claims -- --flows <flows.json> --now <iso> --quiet

# release the stale claims of every scanned HUB ledger
npm run subscriptions:reconcile-stale-annual-claims -- --mongo-url-file <uri> \
  --apply --backup-dir /root/.node-red/.padlhub-stale-annual-claims \
  --report /root/.node-red/.padlhub-stale-annual-claims/report.json
```

Offline rehearsal against a captured ledger document:

```sh
npm run subscriptions:reconcile-stale-annual-claims -- --fixture <ledger.json> --now <iso>
```

The scan selects `counterKey = network_friendship`, `documentType =
HUB_ATOMIC_INVENTORY_LEDGER`, `schemaVersion = 3`, `ready = true`. It releases
through the reviewed `releaseAllAnnualClaims` transformation, so the local
checkout deadline — not the provider state — is authoritative once it passes.

Guards (each has its own reason code in the report):

| reason | meaning |
| --- | --- |
| `STATE_TERMINAL` | already `PAID`/`FAILED` |
| `DEADLINE_MISSING` | no parseable `expiresAt`/`paymentExpiresAt`; never released automatically |
| `DEADLINE_NOT_REACHED` | still inside the checkout window |
| `NOT_CURRENT_DAILY_SEAT` | the reservation belongs to a previous Moscow daily seat |
| `RELEASABLE` | expired, active and on today's daily seat |
| `COUNTER_NOT_ANNUAL_HUB` | ledger is not the HUB annual counter (ledger-level refusal) |
| `LEDGER_NOT_READY_V3` | ledger is not a ready schemaVersion 3 document |
| `LEDGER_INVALID` | ledger fails its own validation before the repair |
| `CLAIM_NOT_UNIQUE` | a payment ref does not resolve to exactly one reservation |

- The write is a compare-and-swap on `_id + revision`; a concurrent runtime
  settlement wins and the reconciler reports it in `compareAndSwapFailures`
  instead of overwriting it.
- `--apply` requires `--backup-dir`: the exact preimage of every ledger that is
  actually changed is written there first (mode 0600). A tick that finds nothing
  to release writes no backup and reports `NOTHING_TO_RELEASE`.
- Reports contain only 12-character hash labels — never the inventory id,
  payment ref or a client identifier.

Tests: `npm run test:stale-annual-claim-release`.

## Scheduled run on `147` (every 5 minutes)

Installed on 2026-09-12 from the confirmed pushed SHA `2009e76f` (owner-approved),
matching the reviewed mechanism above. Host layout
`/root/.node-red/stale-annual-claims/`:

| path | role |
| --- | --- |
| `scripts/reconcile_stale_annual_claims.mjs`, `scripts/lib/{annualClaimRelease,annualSubscriptionHistory,vivaHistoricalEvidence}.mjs` | host copy of the reviewed files; sha256 in `MANIFEST.json` |
| `run-release.sh` | wrapper: `flock` (no overlapping ticks), one `--apply` tick, one JSON line per tick, 30-day backup pruning |
| `state/run.log` | one JSON line per tick, trimmed to the last 4000 |
| `state/report.json` | report of the last tick, mode 0600 |
| `backups/` | preimage of any releasing tick, mode 0600, kept 30 days |

Units: `padlhub-stale-annual-claims.service` (`Type=oneshot`,
`ExecStart=/root/.node-red/stale-annual-claims/run-release.sh`) and
`padlhub-stale-annual-claims.timer` (`OnCalendar=*:0/5`, `RandomizedDelaySec=30`).
The reconciler never calls the provider, so the wrapper needs no service token.

Live result on 2026-09-12 (the HUB daily seat held by a checkout whose link died
at `04:31:34Z`):

| step | result |
| --- | --- |
| dry-run scan | 1 HUB ledger, 5 reservations, 1 releasable (today's seat) |
| apply | released 1; `reservedCount 2 -> 1`, `dailyReservedCount 1 -> 0`, revision `53 -> 54`, 0 compare-and-swap failures |
| postcheck dry-run | `releasableClaims 0`, `NOTHING_TO_RELEASE` |
| storefront status | `totalLimit 1, reservedCount 0, remainingCount 1, canPurchase true` |
| scheduled ticks | manual and autonomous ticks both `NOTHING_TO_RELEASE`, 0 compare-and-swap failures |

Stop signals: any `compareAndSwapFailures` in a tick, a `FAILED` tick line, or an
implausible release count (the HUB daily seat is one, so a tick normally releases
0-1). Stop method: `systemctl disable --now padlhub-stale-annual-claims.timer`
(released documents stay in `backups/`). Recovery: restore the ledger preimage from
`backups/` through the same compare-and-swap on `revision`.

## Residual work (not in this change)

- The runtime still keeps a non-terminal reservation while the provider is
  non-terminal, by design; this reconciler only closes the *stale* window after
  the local deadline, it does not shorten the live checkout.
- Only the *current* Moscow daily seat is released. A non-terminal reservation from
  a previous day stays active (it no longer blocks the daily seat) and keeps
  counting in `reservedCount`; broadening the release to past seats needs a
  separate review.
