# Subscription sale quotas — 9 September 2026

Owner: the current subscription-sales task. Audience: storefront customers and the
production operator. Base: origin/main 9705dc1. This checkpoint prepares configuration;
it does not open HAB/Piter sales or claim a deployed Node-RED candidate.

## Approved targets

| Product | Counter | Daily availability | New purchase price |
| --- | --- | --- | --- |
| РА | ra | 10 of 10, less current payments/reservations | unchanged |
| Дружба | friendship | 10 of 10, less current payments/reservations | unchanged |
| Годовая ХАБ | network_friendship | 1 of 1, less current payments/reservations | 98,000 RUB / 9,800,000 minor units |
| Годовая Питер | piter_friendship | unchanged | unchanged |

The requested sales opening remains a separate uncompleted part of the operation.
Existing product IDs and inventory IDs are retained. No paid/reserved rows, amounts,
visits, or provider transactions are reset. The old reset_ab_leto_limits tool must not
be used: it resets unrelated historical counters and targets an older inventory.

## Prepared configuration

The strict boolean Node-RED global `summer_subscription_sales_20260909_enabled`
selects these new settings. Absent, false, strings, and numbers retain the prior
configuration. No live global was set by this source change.

For the already-enabled September 3 v2 RA/Friendship inventory, the new setting
resumes daily sales at 2026-09-09 10:00 Europe/Moscow. The original 150-seat launch
limit and its PAID history remain intact. Status, purchase admission, and materialized
counter refresh choose the earlier natural/explicit daily start and agree on counts.
Active legacy launch payments consume daily capacity until terminal/expired; therefore
10 of 10 is valid only with no current-window payments and no carried active payment.
An earlier natural daily start is not postponed. The old August inventory is unchanged.

HAB keeps its 100-seat aggregate inventory and Moscow-midnight daily window. The
new setting changes its daily cap to 1 and only its tier/base price to 9,800,000 minor
units. Existing server globals still override the configured provider base. An old
5,680,000-minor-unit base makes binding invalid, rather than creating a negative discount.
Confirmed/pending stored payments continue to use their saved amount/provider base.

Touched Node-RED source functions: status_prepare, status_response, purchase_prepare,
purchase_limit, counter_refresh_prepare, counter_refresh_response. Existing endpoints:
GET /lk/tournaments/summer-subscription/status; POST /lk/tournaments/summer-subscription/purchase;
background counter refresh. No flow export/import was generated or applied.
The three unbound source-amendment hashes are refreshed; frozen candidate hashes,
UNBOUND_AFTER_ROUTER_AMENDMENT status, and rejection of stale release packets stay intact.

## Observed production blockers

Read-only inspection on 9 September found the active LK Tournaments functions still
using the older source; HAB and Piter public status both returned canPurchase=false
and MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE. HAB reported 10 remaining at
56,800 RUB; Piter reported 358 of 400 overall, 42 paid, 0 reserved, price 19,800 RUB.
These are point-in-time readbacks, not activation evidence.

Current main contains an additional explicit HUB_NEW_SALES_RELEASE_DISABLED guard,
as well as CUP readiness and atomic-sentinel validation. This quota patch preserves
those checks. Opening HAB requires a separately reviewed admission change and a valid
CUP/ledger/provider configuration. Opening Piter requires the existing guarded Piter
operator after the matching atomic candidate is installed and legacy sales reconciled.
Do not replace that operator's counterKey or remove the HAB guard to bypass readiness.

## Required before live execution

1. Freeze the reviewed source and fresh active flow, then compose a compatible
   candidate through the existing guarded source-driven release path. The present
   source-amendment record is explicitly UNBOUND and is not a deployable packet.
2. Re-read exact RA/Friendship inventories and active payment counts. Keep the existing
   September 3 release enabled. Never fabricate 10/10 by deleting historical rows.
3. Verify exact HAB Viva product db7a5250-7369-4f43-8ac5-9111be24bc74, review the
   existing in-flight old-price operations, apply the approved provider price change
   using a verified product-update contract, and read back 9,800,000 minor units.
   The effective summer_subscription_network_friendship_product_cost_minor override,
   if set, must match. No provider update was performed in this checkpoint.
4. Re-read HAB ledger. Its stored dailyPaidCount + dailyReservedCount must be <=1
   (zero for 1/1), even if stored dailyDate is older: existing structural validation
   runs before rollover. If it is >1, stop and implement compatible historic-ledger
   handling; do not zero the counts. Confirm accepted old-price payments retain
   their frozen terms. The source configuration flag does not activate its sentinel.
5. Complete the separate HAB admission/readiness work and Piter guarded activation.
   Piter requires fresh complete Mongo/Viva/product/binding snapshots, no unresolved
   legacy payments, the exact installed candidate/lease, CAS and backup evidence.
6. Enable only the reviewed settings after these conditions, then read public status
   and storefront UI for all four counters. Verify actual price and purchase admission;
   no real test charge is authorized merely by this verification plan.

Stop signals: source/runtime drift, stale price, unresolved payment, incompatible
ledger, failed readiness, or inconsistent quota outputs. Stop before new sale admission.
Turning off the configuration flag restores the old configuration but does not undo
provider price changes or accepted payments; it is not a complete rollback plan.

## Local verification

- Subscription sales, frozen candidate/topology, activation-operator and security suites:
  175 passed, 1 Linux /proc/flock-only test skipped on macOS, no failures.
- Subscription critical matrix: 90 passed.
- npm run lint: exit 0, zero errors; existing warnings remain.
- npm run build: production/dev bundles and TypeScript passed with inert ci.invalid
  compile-time configuration. These artifacts are not production deploy artifacts.
- npm run nodered:modular:validate cannot run without a private --workspace. No live
  workspace/candidate was synthesized to bypass that requirement; deterministic
  toolchain fixture validation is reported separately.
- Payment-safety and quota/reliability read-only reviews found no blocking defect in
  this flag-off configuration patch. Historical HAB daily counts remain the explicit
  live preflight risk described above.
- Remaining affected business/compatibility suite: 323 passed, 4 pre-existing
  out-of-scope live-projection cases skipped. Modular toolchain fixtures: 7 passed.
- Total across the final disjoint suites: 595 passed, 5 skipped, zero failed.
