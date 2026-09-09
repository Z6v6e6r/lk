# HAB annual price: 98,000 RUB

## Scope and observed state

Existing Viva product `db7a5250-7369-4f43-8ac5-9111be24bc74` (Падел.Дружба.ХАБ — годовая) already displayed 98,000 RUB after a fresh catalog reload on 2026-09-09. The public network_friendship status still returned 56,800 RUB, provider base 5,680,000 minor units and `HUB_ATOMIC_LEDGER_NOT_READY`. No provider write is needed for this price correction.

The independent strict boolean global `summer_subscription_network_friendship_price_98000_enabled === true` selects 9,800,000 minor units for new HAB tier prices and the default provider base. It does not change quotas, opening dates, readiness, or admission. It defaults off. The existing shared sales flag retains its behavior; do not enable that shared flag merely to correct the price.

## Changed sources

- `fn_tournament_subscription_status_prepare.js`
- `fn_tournament_subscription_status_response.js`
- `fn_tournament_subscription_purchase_prepare.js`
- `fn_tournament_subscription_counter_refresh_prepare.js`

All four are under `scripts/nodered_games_nodes/`. Candidate source hashes are updated in `scripts/subscription_sale_opening_binding.json` and the two UNBOUND source amendment pins in `scripts/prepare_lk1_subscription_enforcement_candidate.mjs`. Regression coverage is in `scripts/tests/tournamentSubscription.summer.nodered.test.ts`.

Previously accepted PAID and PAYMENT_PENDING amounts remain frozen, including the existing payment URL and receipt. An old CLAIMED reservation with a different provider base remains blocked by `PITER_CLAIMED_TIER_DRIFT`; it is not repriced or dispatched automatically.

## Verification

- 150 targeted Node-RED and candidate tests passed, including archived source composition and reverse/topology checks.
- 90 subscription critical matrix tests passed.
- Eight focused HAB tests passed after adding the CLAIMED drift regression.
- Full lint passed with zero errors and 387 existing warnings.
- Full bundle build passed with inert CI endpoints; these outputs are verification artifacts, not deployment artifacts.
- Independent read-only payment/release review found no material blocker.

## Deployment boundary

This checkpoint does not change live state. Before a separately approved deployment, fetch the current production flow and overlay exactly the four reviewed functions using the existing guarded deployment path. Do not deploy the archived candidate wholesale. Its full-candidate digest is offline compatibility evidence only.

Freshly inspect `summer_subscription_network_friendship_product_cost_minor`: an explicit old base overrides the default and correctly blocks the new sale. Any necessary base correction must be scoped alongside the price flag. Verify provider product cost, status, counter refresh, unchanged quota/admission flags, and local/remote function hashes. Do not create a real payment for smoke testing.

Rollback of this price flag alone restores the previous server price but would diverge from the currently observed Viva price; assess that mismatch before any separately authorized rollback. Existing ledger readiness and historical reservation recovery remain separate work.
