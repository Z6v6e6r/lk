# Group one-time tariff response compatibility

Base: `eb9a041aea7e0f3e13a242147585897d8f861c8b` (fresh origin/main).
Branch: `codex/group-discount-tariff-fix-20260910`.

The published preview returned HTTP 503, `LK1_EVENT_TARIFF_UNVERIFIED`.
The public Viva one-times GET for the selected 22 September, 08:00 Terekhovo
training returns a single SERVICE with cost=550000, trialCost=550000 and no
exerciseId echo. The previous guard incorrectly required that echo. Replaying
this DTO shape against the previous function reproduced the error (1 failing test).

For group training only, bind the tariff to the server-generated GET with the
exact Viva origin/path/exercise query. Require the same responseUrl if present.
An omitted echo is accepted; an explicit conflicting or null ID still fails.
Singleton, product type, integer amount and conflicting price checks remain.
Preview, initial booking quote and prewrite tariff recheck enforce this binding.
Other event categories retain their explicit-echo requirement. No subscription
policy, discount percentage, package price or UI change.

The existing group installer produces corrected source. The separate
composeGroupSubscriptionTariffFixArtifacts repairs an installed group graph
under exact function/evaluator preimage guards. The contract changes only the
func field of lk_subscription_booking_router_20260804 and
lk_subscription_price_preview_20260908_router. No additions, wire/config changes.

Fresh live source on 10 September matched the tested installed source:
`ee3f60079e7fbebeba6387d3d2f2f57d6fec17003e3e91ce7da5ff85061c63c7`.
Local full-flow candidate:
`5fce9a8d20138e0c28f2bb7d6e950fb1f71b31364af423085e4207e807d8e2d5`.
Original group install and installed-graph repair produce identical graphs.

## Changed files

- scripts/nodered_lk1_hub_nodes/gateway.js: group tariff request binding.
- scripts/nodered_subscription_price_preview_nodes/router.js: matching preview binding.
- scripts/patch_nodered_subscription_price_preview.mjs: original installation and exact two-function repair.
- scripts/tests/groupSubscriptionDiscount.backend.test.mjs: realistic DTO and negative/regression coverage.
- This document and docs/WORKLOG.md: scope and evidence.

## Checks

- Backend group suite: 15/15 pass for original installer and separately 15/15
  for repair using exact private flow fixtures. Includes full gateway initial
  and prewrite VM execution, malformed/foreign request metadata, conflicting
  echo/price/type, tournament isolation, source drift and changed-price blocking.
- CI critical subscription matrix plus preview, instance, frozen DEV candidate
  and group frontend suites: 581 pass, 0 fail, 32 optional private-fixture skips.
- npm run build: full PROD/DEV build and TypeScript pass with inert loopback config.
- npm run lint: 0 errors, 387 existing warnings; git diff --check: pass.
- Fresh official pull/verify and modular build/validate: pass, 345 selected nodes,
  42 HTTP inputs, no broken wires/links. The separate exact contract validates
  the two-function repair; modular validation checks the unchanged graph.
- Independent payment-safety review: no blocking findings.

Private evidence: /private/tmp/lk-group-tariff-evidence-20260910/.
Origin metadata: /private/tmp/lk-group-tariff-live-20260910/.

Owner: current task. Audience: eligible subscription owners choosing group
one-time payment. Observed local result: 5500 -> 2750 RUB. Stop signal: tariff,
request or final quote mismatch; stop method: existing error before booking.
Real HTTP-node metadata propagation and authenticated quote/booking remain
post-deployment evidence. This stage performs no merge, push, deploy, booking,
payment or provider/data mutation. Deployment must refresh preimages again and
use the existing reviewed-flow publication and guarded rollback protocol.

## Local main integration

User approved local main integration of 483c27f. Refreshed origin/main remains
eb9a041; clean local main 048bcbf already contains five commits for paid joins
and visit lifecycle. All those commits and their source changes are preserved.
Only the WORKLOG append conflicted; both entries were retained.

Integration adaptation: the exact installed-group repair now replaces only the
groupTariff block, retaining the installed daily operation query and usage
helpers. It must not copy the current paid-preview all-date query from main.
A byte-preservation regression covers all code outside both tariff blocks.
The final generated candidate is byte-identical to the previously reviewed
5fce9a8d candidate; original-install and repair paths also remain identical.
Independent payment-safety re-review: no blocking findings.

Integrated checks: 17/17 group tests per path; broad matrix 623 pass, 61 optional
skips, one sandbox-blocked loopback HTTP test, then that exact test passed with
loopback permission. Paid-JOIN exact fixture: 14 pass, 15 historical cases
explicitly skipped. Full lint: 0 errors, 387 warnings. No remaining failed test.
Prior full PROD/DEV build and TypeScript evidence is reused: frontend sources,
build inputs, dependencies and configuration are unchanged from 483c27f.

Logs: /private/tmp/lk-group-tariff-integration-evidence-20260910/.
Local main integration only; no push, PR, deploy or live data/payment mutation.
