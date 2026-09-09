# Subscription sale opening — 9 September 2026

This task prepares the next release in the existing
`codex/subscription-sale-quotas-20260909` worktree, based on `7342973`.
It does not authorize integration, deployment, ledger writes or opening the flags.

## Approved offer

| Product | New availability | Price | New activation |
| --- | --- | --- | --- |
| РА | 10 new daily seats; previous payments remain separate | unchanged | unchanged |
| Дружба | 10 daily seats less payments in that daily allocation | unchanged | unchanged |
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
/ 50% group / 50% tournament discount**, with the existing `ALL_BOOKINGS` semantics.
It is not CUP readiness or a claim about the newer selected-subscription implementation.
The existing broad counting may overrestrict a customer's remaining benefits; it is
retained as baseline debt, not silently changed in this sales release.

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
4,797 nodes and 219 HTTP inputs; no nodes are added or removed.

The pinned source is the installed snapshot
`e743fa0da4db1645e5403aadb868091620a888f9c2944c8acd0c9750961ae67d`.
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

Final local verification (suites overlap; counts must not be added):

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
  local candidate: `932be7a8193b5bfad79c62d546ebf7a122cc5a1d4b25682744d7ab944fa15af6`.
