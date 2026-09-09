# Group training subscription discount — local stage, 2026-09-09

Base: `0168a3e9e1cf9f491405642222cfe51ae280c54e` (freshly fetched origin/main).
Branch: `codex/group-subscription-discount-20260909`.
Worktree: `/private/tmp/lk-group-subscription-discount-20260909`.

## Behavior and supported rule

The group registration screen requests an authenticated quote when booking options
load. A matching one-time tariff shows the original price struck through, the
discounted amount and exact subscription name: 5,500 RUB → 2,750 RUB,
“Скидка 50% по подписке «Падел.Дружба.ХАБ»”. Loading, no-discount and error states
are separate. Changing event/account invalidates old results. Promos do not stack.

Eligibility uses the existing HAB rule: product
`db7a5250-7369-4f43-8ac5-9111be24bc74`, purchase on/after 2026-09-01, ACTIVE and
valid for the whole training, unfrozen, confirmed ownership and available policy
limits. Eligibility of other products was not established. No universal subscription
entitlement or new policy was introduced. Zero visits does not block an otherwise
eligible monetary discount. Preview does not consume a visit.

The server reads the owned subscription, actual training, exact one-time tariff and
policy usage. Unconfirmed identity, limits or tariff binding fail closed. Checkout
uses the existing idempotent subscription gateway. Before its first operation insert,
displayed product, base/final amount, start, duration and percentage must match the
fresh server decision; otherwise `GROUP_DISCOUNT_QUOTE_CHANGED` prevents the write.
Replay occurs earlier so an expired display quote cannot block recovery of an
already-started operation. Existing tournament/visit payment gates remain in place.

## Changed files

- `src/components/group-schedule/GroupSchedulePage.tsx`: quote loading, stale-response protection, discounted option and checkout binding.
- `src/components/group-schedule/GroupSchedulePage.css`: wrapping subscription label and old/new price layout.
- `src/utils/groupSubscriptionDiscount.ts`: versioned quote validation and exact tariff matching.
- `src/utils/tournamentSignupApi.ts`: group preview request, narrow discount dispatch and expected-price constraint.
- `scripts/nodered_subscription_price_preview_nodes/entry.js`: GROUP_TRAINING target validation.
- `scripts/nodered_subscription_price_preview_nodes/router.js`: authenticated group eligibility and tariff preview.
- `scripts/nodered_subscription_product_nodes/gateway.js`: group monetary ownership without visit-balance requirement.
- `scripts/nodered_lk1_hub_nodes/gateway.js`: actual category propagation and first-write quote comparison.
- `scripts/patch_nodered_subscription_price_preview.mjs`: guarded four-function composer preserving installed game behavior.
- `scripts/tests/groupSubscriptionDiscount.test.ts`: quote and checkout dispatch tests.
- `scripts/tests/groupSubscriptionDiscount.backend.test.mjs`: composed function tests, negative identity/lifecycle/limit/tariff cases and first-write protection.
- This document and `docs/WORKLOG.md`: scope and evidence.

## Node-RED boundary

Read-only source: server 147, `/root/.node-red/flows.json`, 4,798 nodes;
SHA-256 `325839a66e235caa9e56bde36afdb89286aab8e26e963f2612dea03bf7a7cb75`.
Raw source and candidate remain private outside Git under
`/private/tmp/lk-group-discount-live-20260909/`.

The exact-graph candidate changes four existing function bodies only: subscription
booking prepare, `lk_subscription_booking_router_20260804`, price preview entry and
router. No node/wire/config/policy changes. Installed game helpers are preserved;
actual booking and preview evaluator hashes must match. Known preimages are required.
Older preview composers fail closed with `GROUP_DISCOUNT_BACKEND_NOT_READY` for group
requests. Existing GAME behavior is retained.

Existing `/lk/subscriptions/game-price-preview` gains GROUP_TRAINING. The existing
subscription booking request gains optional `expectedGroupDiscount`; client values
constrain the amount and never authorize it. Release requires fresh live source,
matching gateway/preview/frontend versions and separately authorized deployment.

## Checks actually run

- Final focused suite: **25 PASS, 0 FAIL, 0 SKIP** (new frontend/backend tests plus
  group detail UI and subscription confirmation). Backend tests run composed actual
  functions with fixture-owned HTTP/Mongo reads, using `LK_GROUP_DISCOUNT_FLOW_FIXTURE`.
- Expanded related suite: **361 PASS, 4 FAIL, 92 SKIP**. Four unchanged pinned-preimage
  failures in `subscriptionBindingPatch.test.mjs` and
  `subscriptionReturnVerificationPatch.test.mjs` reproduced with base-commit scripts.
  Skipped cases require other private historical fixtures.
- `node node_modules/typescript/bin/tsc -b`: PASS.
- Final full `npm run build` (prod/dev): PASS with explicit inert localhost build
  environment. These are local verification artifacts, not release artifacts.
- Final full `npm run lint`: **0 errors, 387 warnings**.
- Exact graph contract/validation: PASS, four function bodies among 4,798 nodes.
- Standard `nodered:modular:validate` on the private workspace: BLOCKED by missing
  `input/source.flow.meta.json`. Initial SCP helper failed; SSH fallback retrieved
  the flow without that origin manifest. This validator is not reported as passing.
- Independent payment-safety/source review: no remaining blockers after corrections.
- Real component browser fixture: desktop/mobile discount, no-discount and error
  states. At 390px, scrollWidth equals viewport width; original price is line-through.
  No booking/payment button was invoked.
- `git diff --check`: PASS.

Logs: `/private/tmp/group-discount-focused.log`,
`/private/tmp/group-discount-regressions.log`, `/private/tmp/group-discount-baseline.log`,
`/private/tmp/group-discount-build-final.log`, `/private/tmp/group-discount-lint-final.log`.

## User verification and remaining evidence

Local fixture: `http://127.0.0.1:5186/group-discount-preview`.
Variants: `?state=none`, `?state=error`. Real component, fictitious data, API mutations
disabled, connections restricted to loopback. Temporary server:
`/private/tmp/group-discount-preview-server.mjs`.

Live authenticated provider tariff/eligibility and real payment/recovery have not
been exercised. Synthetic tests are not runtime/provider proof. Existing policy
quota concurrency limitations remain unchanged. Broader product eligibility, live
source drift or incompatible provider tariff DTOs require fresh investigation.
No merge, push, deployment, live booking, payment, database or provider mutation.

## Stage 3 — local main integration, 2026-09-09

User accepted the screen with a price-color correction (`6d5ac16`, new price now
matches the adjacent package price, `#1A1A1A`) and authorized local-main integration.
Fresh main/origin-main baseline: `96065cfcd0c552e9430015cbfa4939f35685ea8a`.
Task head: `6d5ac164dd9110b3921f5dcdecf6bcb606816228`.
The merge in `/private/tmp/lk-group-discount-main-integration-20260909` was automatic;
all runtime/test files are byte-identical to the reviewed task. The dirty primary
checkout and original task branch/worktree were preserved.

On the integrated candidate, group suites, subscription confirmation, price preview
API, shared session cache and join-loading tests passed **65/65, no skips** with the
same private Node-RED fixture. Full `npm run build` (including TypeScript, prod/dev)
passed using explicit inert localhost configuration; `npm run lint` had 0 errors
and 387 warnings. Staged diff check passed. The read-only specialist review found
no new incompatibility: preview remains uncached/authenticated, booking invalidates
the shared snapshot, and expected-price protection/replay stay intact.

Logs: `/private/tmp/group-discount-integration-focused.log`,
`/private/tmp/group-discount-integration-build.log`,
`/private/tmp/group-discount-integration-lint.log`.
Unchanged private historical fixture/modular metadata limitations above remain.
CI, push, deployment and live provider/payment operations are outside this stage.

## Stage 4 — push and CI correction

Published main `f9bdf65` retained parallel nginx fixture fix `c8a97a6`. CI run
34394102673 passed the credential scan and critical matrix, then rejected the
changed generic booking prepare source against the frozen offline DEV input hash.
The generic source was restored. The group-only composer still adds the identical
expected-price field under its exact live preimage guard, alongside the price guard.
No frozen source binding, eligibility rule or guard was loosened.

The corrected group candidate is identical to the previously reviewed 4,798-node
candidate (canonical JSON SHA-256
`9877a7c3f70ffebdb486ec17b2427c1fa281e409b12f51c92b48474d61617a37`).
Narrow specialist review found no blocker. Local group/DEV suite: 29 PASS, 1 FAIL;
the previously failing publisher now passes. The remaining local failure is the
unchanged temp-symlink custody test on macOS, which passed in the first Linux CI run.
The new Linux CI run remains the required result. Log:
`/private/tmp/group-discount-ci-fix-tests.log`.
