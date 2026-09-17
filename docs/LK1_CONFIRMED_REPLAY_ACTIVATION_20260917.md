# Activation runbook: confirmed subscription replay guard (2026-09-17)

Scope: turn the code in PR #104 (`codex/phantom-subscription-claim-20260916`) into a live fix
for orphaned `CONFIRMED` subscription claims and for the replay contract they broke.

Order matters: the reconciler class (step 2) and the Node-RED candidate (step 3) are
independent, but the client-visible recovery (step 4) needs the frontend rejoin release.

Every step needs its own owner approval. Nothing in this runbook is executed automatically,
and none of it was executed while authoring it.

## Step 0 — prerequisites

- PR #104 reviewed (CRITICAL route: payment/booking state machine) and merged into `main`,
  or a deploy worktree on the exact reviewed commit.
- A fresh Node-RED preimage pulled from `lk-primary-147` (max age 30 min at composition).
- For the reconciler: a Viva admin token file and the Mongo URI of `games`.
- No release/deploy wrapper runs from a dirty tree; `main` must equal `origin/main` for the
  guarded install wrappers.

## Step 1 — provider-verified dry run (read-only, no writes)

```sh
npm run subscriptions:reconcile-hung-claims -- \
  --mongo-url-file <uri> --token-file <viva-admin-token> \
  --include-confirmed --ttl-minutes 30 --limit 200 \
  --report /root/.node-red/.padlhub-hung-claims/confirmed-dry.json
```

Read the report:

| field | expected |
| --- | --- |
| `providerVerification` | `PERFORMED` (a missing token makes every confirmed decision `TOKEN_MISSING`) |
| `byReason` | mostly `BOUND_BOOKING_ABSENT` for payment-timeout leftovers; `EXACT_CANCELLED_BOOKING` where Viva kept a cancelled row |
| `byReason.PROVIDER_EVIDENCE_*` | must stay 0 for the batch you intend to apply; anything else means "cannot verify" |
| `byReason.PROVIDER_BOOKING_ACTIVE` | live bookings the reconciler correctly refuses to touch |
| `releasable` | the claims that would be released |

Stop signal: any `PROVIDER_EVIDENCE_INCOMPLETE` on a claim whose booking you know is gone,
or a `releasable` claim that still shows an active booking in Viva — do not apply, open an
investigation instead.

## Step 2 — enable the confirmed class

Apply the reviewed batch first, then add the flag to the schedule:

```sh
npm run subscriptions:reconcile-hung-claims -- \
  --mongo-url-file <uri> --token-file <viva-admin-token> \
  --include-confirmed --ttl-minutes 30 --limit 200 --apply \
  --backup-dir /root/.node-red/.padlhub-hung-claims/batch-$(date -u +%Y%m%dT%H%M%SZ) \
  --report /root/.node-red/.padlhub-hung-claims/confirmed-apply.json
```

Postcheck:

- `released` non-empty, `compareAndSwapFailures` 0, `freshReadFailures` 0;
- every released document is `state: RELEASED` with `releaseReason: RECONCILE_HUNG_DAILY_CLAIM`
  and keeps `lk1` (the stored `checkout`/`transactionId` must still be there);
- one player-facing check: the affected subscription can price/book that day again.

Then add `--include-confirmed` to the 15-minute schedule and to the daily deep sweep
(the same cursor/backup arguments the existing timer uses).

Recovery: the backup file holds the exact pre-images; a release is a local seat reservation
only, and the runtime still counts real provider bookings, so a wrongly released claim cannot
create capacity.

## Step 3 — install the Node-RED candidate

```sh
npm run nodered:modular:pull-147 -- /private/tmp/lk1-confirmed-live
npm run nodered:modular:verify -- --workspace /private/tmp/lk1-confirmed-live
node scripts/patch_live_lk1_confirmed_replay_guard_hotfix.mjs \
  --workspace /private/tmp/lk1-confirmed-live \
  --output /private/tmp/lk1-confirmed-out/candidate.flow.json \
  --report /private/tmp/lk1-confirmed-out/report.json
```

Compare with the reviewed candidate: `sourceSha256` must equal the flow the patcher pins,
`changedNodeCount` 2, `addedNodeCount` 0, `topologyChanged`/`routesChanged` false, and

| node | before | after |
| --- | --- | --- |
| `lk_subscription_booking_router_20260804` | `2c8bfbe7…` | `55f748d0…` |
| `lk_subscription_booking_finalize_20260804` | `72f575fc…` | `2b115412…` |

Then the guarded install with the exact-graph contract prepared from
`live == the pulled preimage` and `candidate == the reviewed candidate`, using
`scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs` with the
15-minute soak lease, exactly as `docs/README_DEPLOY.md` describes. No manual JSON edits.

Postcheck after the restart:

- `POST /lk/games/{game}/split/join` for a live unpaid subscription join returns 200 with
  `mode`, `paymentRef`, `gameId`, `toPayMinor`/`toPay`, `transactionId`, `paymentUrl`;
- the same request for a claim whose Viva booking is gone returns 409
  `SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED` and the claim becomes `RELEASED`;
- an unreadable provider page returns 202 with `LK1_CONFIRMED_BOOKING_EVIDENCE_UNAVAILABLE`
  and the claim is untouched.

Stop signal / recovery: any of the three contracts differs, or node-red fails to come back —
run the guarded rollback with the same contract, then re-pull and re-review.

## Step 4 — frontend rejoin release

Without it the widget still cannot start a new attempt after a release (the deployed bundle
has no rejoin support). Publish the standard frontend release that contains
`src/utils/subscriptionRejoin.ts` and the `SUBSCRIPTION_BOOKING_RELEASED` handling, then
verify on a device that "Присоединиться снова" produces `…:rejoin:1` and a new booking.

## Step 5 — verify the reported client

Read-only, against production:

```sh
node tmp/incident-20260916/probe4.mjs      # claim state, booking, game, audit tail
```

Expected: `lk-split-join-15a9jcs1x7jvc0` is `RELEASED` (or absent from the ledger), the game
`pay_66a6b649…` no longer holds a dead participant booking, and a fresh join by the client
creates a new claim with a live Viva booking. The free hour for 2026-09-22 must be usable
again; if it is not, the visit-job side needs the same treatment.

## Residual work after activation

- Remove the cause instead of sweeping it: release the claim from the split
  payment-timeout cleanup itself (seconds instead of the 15-minute window).
- Extend the rejoin identity to `lk-split-create-*` so a released organizer create can be
  retried on the same game.
- Watch the `byReason` counts of the scheduled dry run for regressions.
