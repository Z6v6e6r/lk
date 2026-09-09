# Subscription paid JOIN correction — local stage

Base: `origin/main` = `be2e395eebae6b6fee7e405fbfa87ef3e3e703bf`.
Branch: `codex/subscription-join-payment-20260909`.

HAR shows a selected subscription quote with base 1125 RUB, duration 90 minutes,
60 free minutes, 30 paid minutes and final amount 262.50 RUB. The JOIN response
is HTTP 202 / PENDING_CONFIRMATION / LK1_BOOKING_OUTCOME_UNRESOLVED.
No HAR, credentials or customer exports are included in Git.

Read-only nginx inspection shows the reserve DEV URL forwards this request and
price preview to primary. Fresh primary flow has 4798 nodes and SHA256
`325839a66e235caa9e56bde36afdb89286aab8e26e963f2612dea03bf7a7cb75`.
Its gateway chose SUBSCRIPTION solely from subscriptionVisitCount=1, including
mixed free/paid JOINs. The exact historical confirmation mismatch remains
unproven: the narrow Mongo query returned Unauthorized and the Viva user GET
could not complete. Do not retry/recreate the saved operation to investigate it.

## Change

For JOIN_GAME with a positive authoritative final price, create one ON_PLACE
booking without clientSubscriptionId/count, then reuse the existing SERVICE
serializer, discount, transaction CAS and exact transaction readback. The HAR
fixture generates a SERVICE discount of 973750 minor units against the existing
1000000-minor-unit carrier: checkout amount 26250 minor units (262.50 RUB).

Fully free JOINs still use SUBSCRIPTION/count=1 with no transaction. CREATE
behavior is preserved. Confirmation requires exact booking, actor, exercise,
active state and expected payment mode. Ambiguous writes/replays remain pending;
no automatic compensation, second booking or duplicate checkout is introduced.

The local LK1 operation retains the subscription benefit and free-minute usage;
ON_PLACE does not physically debit a Viva subscription visit. Gateway and preview
include active paid bookings bound by existing LK1 operations, across dates, in
the selected subscription's active-booking limit. Daily minutes remain date-scoped.

The local candidate changes only `func` on:
- `lk_subscription_booking_router_20260804`
- `lk_subscription_price_preview_20260908_router`

No route, wire, policy setting, collection or stored operation changes.
Candidate SHA256: `ee594cb00982341303d828beceb109d9e3d2ea20652031d217d3a5a51c203ec1`.
Exact preimage checks reject drift/reapplication. Reverse exact-graph contract
was tested locally; applying it would require separate authorization.

## Files

- `scripts/nodered_lk1_hub_nodes/gateway_hooks.js`: JOIN booking/confirmation and all-date operation lookup.
- `scripts/nodered_lk1_hub_nodes/gateway.js`: active paid-benefit accounting; same-day minutes.
- `scripts/nodered_subscription_price_preview_nodes/router.js`: aligned operation lookup.
- `scripts/patch_live_lk1_hub.mjs`: omit count for paid bookings.
- `scripts/patch_nodered_subscription_price_preview.mjs`: shared updated usage and date helper.
- `scripts/patch_nodered_subscription_paid_join.mjs`: local exact-live gateway/preview candidate builder.
- `scripts/tests/lk1HubLiveComposition.test.ts`: paid JOIN, exact amount, replay/CAS and negative readback scenarios.
- `scripts/tests/subscriptionInstanceLimits.test.mjs`: date-helper and invalid-date fixture contract.
- `scripts/tests/subscriptionPaidJoin.nodered.test.mjs`: graph/rollback, source alignment and preview accounting.
- This report and `docs/WORKLOG.md`.

## Validation

Run from the isolated worktree:

```sh
LK1_PAID_JOIN_LIVE_FIXTURE=/private/tmp/lk-subscription-join-primary-20260909/input/source.flow.json node --experimental-strip-types --test scripts/tests/lk1HubLiveComposition.test.ts scripts/tests/subscriptionPaidJoin.nodered.test.mjs
```

The fixture is private, outside Git. Tests execute actual patched function bodies
with local provider/Mongo responses; they are not live provider acceptance.
Original HUB CREATE/identity installation cases require the older original fixture
and are explicitly skipped in this paid-JOIN fixture mode.

Paid-JOIN function/graph regression: 14 PASS, 15 original-ingress cases explicitly skipped.
Broad subscription gateway/preview/instance/shared-limit regression: 135 PASS,
30 opt-in fixture/runtime tests skipped. Full lint: 0 errors, 387 warnings.
TypeScript `tsc -b`: PASS. Modified JS/test scoped ESLint: PASS.
`npm run build`: blocked by missing ignored VITE environment variables before compilation.

Fresh source modular build/validate: 345 LK Games nodes, 42 HTTP inputs,
0 broken wires and 0 broken links. This validates the source snapshot, while the
separate exact-graph/compiled-function tests validate the changed candidate.
No generated deployment JSON was added to the repository.

Payment-safety specialist read-only review: no blocking finding.

## Remaining gates and limitations

- The existing PENDING_CONFIRMATION operation is unchanged and may still return
  202. Its provider booking/transaction state needs authorized, working read access
  before any narrowly approved recovery.
- Existing baseline: an ambiguous operation with upstreamBookingId but no confirmed
  bookingId is not included in the active paid-booking union.
- All-date actor/product operation lookup can read more rows; timeout remains fail-closed.
- No physical Viva visit debit is claimed for the ON_PLACE leg.
- No browser/live payment, receipt/fiscalization or end-to-end acceptance performed.
- Local checkpoint only; no push, Draft PR, merge, deploy, database/provider write
  or payment execution. User verification is the next stage under the supplied AGENTS rules.
