# Subscription sale opening — 9 September 2026

This task prepares the next release in the existing
`codex/subscription-sale-quotas-20260909` worktree, based on `7342973`.
It does not authorize integration, deployment, ledger writes or opening the flags.

## Approved offer

| Product | New availability | Price | New activation |
| --- | --- | --- | --- |
| РА | 10 new daily seats; previous payments remain separate | unchanged | unchanged |
| Дружба | 7 daily seats less paid and actively reserved seats in that daily allocation | unchanged | unchanged |
| Годовая ХАБ | 1 daily seat, aggregate inventory 100 | 98,000 RUB | next day after purchase |
| Годовая Питер | start with 48 of the first 100 seats; aggregate inventory 400 | existing tier, currently 19,800 RUB | next day after purchase |

The user explicitly approved ten **additional** RA seats while retaining the previous
paid and pending operations. New RA uses `ab_leto_20260909_daily_v3_ra`; old V2 rows,
amounts and confirmations retain their original inventory. Both inventories remain in
scheduled reconciliation even with the opening flag OFF. Turning OFF is not a full
rollback after new payments. RA admission retains its existing non-atomic concurrency
limitation; this change does not claim a concurrency fix.

Piter retains every real paid row and payment identity. The commercial adjustment is
`52 - legacyPaidCount`, so a baseline of 42 paid has adjustment 10 and 48 available.
The adjustment is immutable CAS custody, not fabricated payments. More than 52 historic
paid rows, unresolved transactions, stale evidence or a changed baseline stop preparation.
The historical 50-seat candidate and deferred receipts cannot authorize this 48-seat launch.

## Friendship correction after provider/history preparation

The user confirmed that Friendship must retain the existing allocation and count its
paid and active pending operations within a **seven-seat** daily cap. It receives no
new inventory or seven additional seats. One payment plus two active reservations
therefore leaves four seats; expired unpaid reservations no longer occupy the cap.
RA remains ten additional seats in its separate V3 inventory.

This source correction has not been deployed. The binding still composes against
its archived pre-deploy source for offline verification; the installed `38d4dc8...`
flow is no longer this correction's candidate. A fresh, separately reviewed update
from the actual installed flow is required before release; do not replay the old
opening deployment packet. Annual history/reconciliation blockers remain unresolved.

## Provider changes actually performed

The user changed HAB price to 98,000 RUB. Following explicit product decisions, this
task saved `activationDays: 365 -> 1` on **both** exact Viva product cards through the
catalog UI. Independent API readbacks on 9 September confirmed:

- HAB `db7a5250-7369-4f43-8ac5-9111be24bc74`: cost 9,800,000 minor units,
  activationDays 1, validityDays 365, visits 365 (10:43:46 UTC).
- Piter `8bf334ba-3050-4017-b40a-7eef2db1eb16`: base cost 5,680,000 minor units,
  activationDays 1, validityDays 365, visits 365 (10:50:07 UTC).

Only the activation field was edited here. No payment, refund, client instance,
booking, notification, Node-RED flag or Mongo record was written. These product
readbacks are not evidence that a newly purchased instance has actually autoactivated.
Old accepted operations retain their stored contract; the current product card must
not reinterpret their lifecycle. Old pre-dispatch operations whose terms conflict
with the new card hold for reconciliation instead of submitting another transaction.

## Server changes and flags

`summer_subscription_sales_20260909_enabled` selects the approved quotas and HAB price.
Strict true is required; absent/string/numeric values do not enable it.

Piter additionally requires `summer_subscription_piter_next_day_sales_20260909_enabled`.
A ready 52-seat-baseline ledger must remain closed while this flag is OFF. New Piter
sales freeze `providerLifecycleMode=VIVA_NEXT_DAY_V1`. Only this mode accepts exact
integer provider activationDays 1, validityDays 365 and visits 365 without the old
October cutoff. Historical Piter/CUP contracts keep their original confirmation path.

HAB additionally requires `summer_subscription_hub_lk1_sales_enabled`, a matching
`subscriptions_lk1_product_policy`, a source-bound `subscriptions_lk1_hub_sale_runtime`
receipt, and a ready atomic ledger. The receipt identifies the installed direct LK1
booking implementation and policy **4 active bookings / 60 free minutes / 30% overage
/ 50% group / 50% tournament discount**, with the installed `SUBSCRIPTION_BENEFIT_ONLY` semantics.
The parallel release already installed instance-scoped booking and free-minute counting.
This candidate preserves that implementation; it does not replace booking logic or
claim CUP readiness. Historical `ALL_BOOKINGS` receipts remain readable without
changing their scope or digest.

The receipt digest is derived by `buildHubRuntimeEvidence`: normalized policy, exact
hashes of split/gateway/finalize/evaluator/product-router nodes, and incoming edges.
The candidate preserves these nodes, verifies their source-bound policy reader and
initializer, then adds the receipt to the existing atomic initializer. This installs
capability evidence; it does not turn on either sales flag.

New HAB sales freeze `LK1_VIVA_PRODUCT_NEXT_DAY_V1`, policy, source digest and usage
scope. A paid transaction still needs an exact owned provider subscription readback.
Confirmed `NEW` is recorded as pending activation, not ACTIVE. No CUP binding or manual
activation call is made for this mode. The actual provider purchase timestamp determines
the next-day forecast; the earlier checkout date is only a forecast. Confirmation works
with sales flags OFF. Replay cannot replace the saved mode, receipt, amount or lifecycle,
including a pre-POST `DISPATCHING` recovery.

## Reviewed local candidate

`prepare_subscription_sale_opening_candidate.mjs` uses
`subscription_sale_opening_binding.json`; no CLI hash or target overrides exist.
It replaces nine subscription functions, adds the missing fourth confirm output to
the existing atomic router, and adds the source-bound receipt initializer. It preserves
all other nodes, including the today's product identity fix. Existing topology remains
4,798 nodes and 219 HTTP inputs; no nodes are added or removed.

The pinned source is the installed snapshot
`de6a6b2206476de79564fbec9ad5d41ac8bd6088517c29452f4101d6ed3bb0aa`.
The current candidate digest is in the binding file; it changes when reviewed source
changes. Local private-snapshot composition and structural reverse are tested. This
is **not** a fresh production release packet: the CLI requires a fresh private
`--workspace` origin record and refuses source drift. Never redeploy the previous
six-function packet to apply this work.

Affected paths: status, purchase, confirmation, scheduled reconciliation and counter
refresh under `/lk/tournaments/summer-subscription/`. No broad modular exports are
regenerated. Three unbound generic LK1 source-amendment hashes are updated, without
binding or republishing the old generic candidate.

## Ordered production preparation and execution

1. Integrate/release only after the next stage is approved. Fresh-pull the current
   live flow, verify origin and preserve other owners' changes. Build this exact
   candidate, acquire the existing deployment lock, review source/target/backup,
   and verify all opening flags OFF. Install and postcheck the source-bound graph.
2. Collect fresh complete Piter Mongo/Viva/product/binding evidence. Use the existing
   guarded operator with an exact new 48-seat packet and its next-day product contract.
   Seed inactive, read back, then activate by exact CAS. Do not erase or reconcile
   financial records merely to obtain a display quota.
3. Read the complete HAB inventory under the same exclusive custody. The pure
   `buildHubAtomicOpeningPlan` supports only an empty inventory and the exact installed
   candidate plus current 98,000 RUB / 1 / 365 / 365 provider card. It produces an
   inactive insert and full-document activation CAS. It is an offline plan, not a live
   operator. Recheck the query, installed hash, flags and five-minute evidence window
   immediately before executing; any existing row requires separate reconciliation.
   An ambiguous insert/update requires readback, never blind retry or overwrite.
4. Verify ledgers, runtime policy/receipt, current provider prices and frozen pending
   operations. Then perform the separately authorized flag transition and read back
   all four public counters and purchase admission. Do not create a real test payment
   without explicit authority. No flags or ledger operations occurred in this checkpoint.

Recovery first closes **new** admission while keeping pending confirmation/reconciliation.
Do not delete sentinels or paid rows. Structural reverse alone is not a safe data rollback;
accepted new modes and RA V3 reconciliation must remain supported. Provider activation-day
changes are separate from backend rollback and must not silently be reverted.

## Verification boundaries

Regression coverage includes additional RA allocation and late old payment, Piter
48/47 arithmetic and immutable history, OFF/ON/OFF, frozen-mode repair, strict next-day
provider values, Moscow midnight, post-October sales, exact NEW-instance confirmation,
receipt mismatch, empty-only bootstrap and private whole-graph preservation.

The local build uses inert CI compile-time configuration; its artifacts are not deployable
production assets. Physical Mongo/Viva payment/autoactivation and browser purchase E2E
remain separate live evidence. Optional Linux flock and private/physical fixtures are
reported as skipped when their required environment is absent.

Initial checkpoint verification (suites overlap; counts must not be added):

- Final sales regressions: 134 passed, zero failed/skipped.
- CI affected business group: 474 passed, 5 existing out-of-scope skips;
  candidate/activation group: 64 passed, 2 environment-dependent skips.
- Piter suites after contract amendments: 90 passed, 14 private/physical/Linux skips.
- Subscription critical matrix: 90 passed; modular toolchain fixtures: 7 passed.
- Opening helpers/bootstrap/private installed-flow composition: 4 passed.
- Delivery suite: 68 passed and one loopback TLS fixture cancelled by sandbox;
  rerunning its four-test file with local listener permission passed all four.
- TypeScript: passed. ESLint: zero errors, 387 existing warnings. Production/dev
  bundle build: passed using the repository's inert CI environment. The first attempt
  correctly refused absent ignored environment files; no production configuration was copied.
- Final `git diff --check` passed. Narrow regex/manual review of all 26 changed
  paths found no high-confidence credential patterns; this was not a PII classifier.
- Both payment-safety and quota/release reviewers closed their findings. Current
  initial local candidate (superseded below): `932be7a8193b5bfad79c62d546ebf7a122cc5a1d4b25682744d7ab944fa15af6`.

## Re-preparation after the parallel booking release

The attempted deployment of main `da04bd7` stopped before remote staging, restart or
any data write: the fresh source no longer matched the earlier reviewed preimage.
The prior local candidate `932be7a8...` is superseded and must not be deployed.

The new source contains one additional price-preview Mongo node and six changed
nodes, including the gateway/evaluator pair. All are preserved byte-for-byte by
this focused nine-node sales patch. HTTP inputs remain 219. The new candidate is
`38d4dc877a4d63ff8dfdb9f6517ea0869a9ad9aa86031e22fbd30eacf0a95e1e`.

The runtime receipt now records `SUBSCRIPTION_BENEFIT_ONLY`. Its builder rejects
disagreement between the installed gateway and evaluator and continues to bind the
complete dependency hashes and incoming edges. Both exact historical and current
receipt scopes are accepted for saved operations, without converting old values.
A scope or digest mismatch still blocks CLAIMED/DISPATCHING redispatch before POST;
paid confirmation and pending-payment URL replay retain their frozen receipt.
The partial-composition guard includes the new purchase-router digest and retains
both earlier denied digests. The historical Piter 50-seat tuple is unchanged.

This is a local re-preparation. Fresh origin, source-drift, lock/lease, backup and
flags-OFF checks remain mandatory immediately before an authorized live apply.

Re-preparation checks (overlapping suites; do not add counts):

- Affected business matrix: 477 passed, 5 existing environment/out-of-scope skips.
- Final candidate/activation matrix: 66 passed, 1 optional private fixture skipped;
  the actual freshly pulled opening graph fixture was supplied and passed.
- Final sales and Piter matrix: 226 passed, 14 physical/private/Linux skips.
- Scoped ESLint passed. Exact graph preservation/reverse and source/helper bindings
  passed. The partial-composition regression caught a stale denylist hash; it was
  corrected and the affected matrix rerun successfully.
- Both independent payment compatibility and quota/release reviewers closed findings.
- Unchanged frontend/dependency/build inputs retain the previous successful main CI
  evidence (run 34346980749); no new production/frontend build is claimed here.

## Seven-seat correction verification

- Parent-owned R3 payment/subscription change in the existing worktree; base checkpoint
  `d46305896430626adb111d1077b1bcb54c80202f`. Refreshed `origin/main` remains
  `fa2a0c6e629fa517ccbeacd63c24942ab5066bec`; no integration performed.
- Four function files changed: status prepare/response, purchase prepare, counter
  refresh prepare. Also updated the opening binding, summer Node-RED regression
  tests and this document. No runtime schema, record repair or new inventory.
- Summer runtime + opening tests: 141 passed, one fixture skipped initially.
  Opening + Piter activation/reconciliation tests with the archived private flow:
  50 passed, one Linux-only flock test skipped on macOS. The opening composition
  and exact structural reverse passed with that fixture. These are local tests,
  not a fresh deploy rehearsal or provider write proof.
- `npm run lint`: zero errors, 387 existing warnings. Full `npm run build` with
  inert compile-time URLs: prod/dev and TypeScript passed. `git diff --check` passed.
- Independent read-only payment review found no P1/P2 issues. No live modular
  source pull/regeneration or remote CI was run for this local correction.
- No merge, push, deploy, activation or database/provider business mutation.
  A fresh installed-flow update remains necessary before deployment.

## Push and CI correction

The approved merge `653f6939477a77c6e325404f40ff7fd544f29cdb` was pushed to
`origin/main`; remote SHA was read back exactly. The repository-configured custody
scan passed before push. No deployment or sales activation occurred.

[CI run 34360226209](https://github.com/Z6v6e6r/lk/actions/runs/34360226209)
failed the critical regression matrix: 516 passed, one failed, five skipped.
`tournamentSubscriptionSalesCandidate.test.mjs` caught two stale unbound source
amendment hashes after the seven-seat correction. The test stopped at the first
mismatch; both status response and purchase prepare metadata required updating.

The local correction changes only those two hashes in
`scripts/prepare_lk1_subscription_enforcement_candidate.mjs` and this documentation.
Frozen target pins, `UNBOUND_AFTER_ROUTER_AMENDMENT`, null candidate binding and all
retirement/provenance rejection checks remain unchanged. No runtime behavior changed.

Replayed the exact current CI check_9 and check_10 commands locally: 517 passed /
five private-fixture skips, and 65 passed / one private-fixture plus one Linux-only
skip, respectively. Scoped ESLint and `git diff --check` passed. Independent
read-only release review found no issues. Full frontend build was not repeated
for these two metadata-only hash corrections. Remote CI remains failed until a
separately approved integration/push publishes the correction. No rerun of the
unchanged failed SHA was requested.
