# LK1 train 147 prep — report (2026-10-05)

Preparation only. No deploy, no flow import, no Node-RED restart, no global write, no push.
147 was read only. Nothing was written outside this worktree except the private external
workspaces under `/private/tmp/lk1-train-147-prep/`.

## 1. Live preimage

| | |
| --- | --- |
| Host / path | `lk-primary-147`, `/root/.node-red/flows.json` |
| Transport | `ssh -o BatchMode=yes root@lk-primary-147 'cat /root/.node-red/flows.json'` |
| sha256 | `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1` |
| Node count | **4815** |
| Bytes | 9 872 180 |
| Verification | local sha256 == remote `sha256sum`; 0 duplicate ids; `JSON.parse` = array |
| External copy | `/private/tmp/lk1-train-147-prep/input/source.flow.json` |

`scp` to 147 is unavailable in this environment (TCP connect to 147.45.103.3:22 timed out for scp
while the same `ssh` exec channel worked). The shared pull script therefore received a read-only
`ssh … cat` fallback in a **separate** commit; its default `scp` path and every verification step
are byte-identical, and `scripts/tests/noderedModularToolchain.test.mjs` stays 7/7.

## 2. Every pin, old → new

Full table with complete hashes: `pin-table.md`. Machine-readable derivation:
`pin-derivation.json` (produced by `tools/derive-all-pins.mjs`).

Summary of the derived live values (old reviewed preimages were 4804 nodes):

| Value | Old | New |
| --- | --- | --- |
| live flow | `d6df38f3…` / `9d2487a4…` / `cc2d76f4…` / `0dacc3d0…` / `d8bbfe27…` | `7e8a9570…` |
| gateway `func` | `a230800d…` / `8af66369…` / `cfce248c…` / `abf46e8b…` | `21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2` |
| gateway `initialize` | `f373346f…` / `db38f71e…` | `d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5` |
| evaluator `func` | `c20f0e6d…` / `6f4e7aa5…` | `2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602` |
| evaluator embedded body | `f1f65a20…` / `cfd614a4…` | `ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3` |
| preview router `func` | `9d99004d…` / `7605df8c…` / `06819480…` / `0c51e589…` | `43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70` |
| preview evaluate `func` | `c20f0e6d…` | `2d3f5b50…` (same body as the evaluator) |
| preview final / error | `5312c424…` / `b9e9bb38…` | `e7c174ea631ff47060a92a660851b876963e9f1473a2e932562415239f27b339` / `b29321c7e1a9802f13839582c2aeae36018e7a70ed6886079f826c3887e915aa` |
| split / join | `c6ecc73d…` / `53c4f6ab…` (hub/default pins) | `d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b` / `8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074` |
| finalize `func` | `37b05b0a…` | `2b11541259acf223cbfa2fe8cc81ad268dc26213e4b171d1bd6726fa9515dc3d` |
| usage/allowance block | `3436bdd2…` / `98229c72…` / `5fce82de…` | `a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1` |
| plan-rules config fragment | `2a7cd4e3…` | `3865076a84cdb0b002e507c76f91778b0b863b66c2941c05f1f74ec84c8afb13` |
| Patriots reviewed gateway / hooks / evaluator | `9ca40575…` / `636e005f…` / `45b7ef57…` | `430dbb09…` / `2225ca52…` / `ac05d7cd…` |
| `preimages.json` | 13/20 node hashes match | 7 drifted, `incoming` +1 route (`lk_subscription_product_finish_20260907`) |

Pins that are **NOT DERIVABLE** (they are postimages of generations that the composer refuses on
this snapshot): `TOPOKRATY_TARGET.patchedFuncSha256/patchedInitializeSha256/patchedPreviewFuncSha256`,
the three `TOPOKRATY_REVERT_*` pins, `TOPOKRATY_COPAY_TARGET.patchedFuncSha256/patchedInitializeSha256/patchedPreviewFuncSha256`,
`TOPOKRATY_COPAY_APPLIED_SHA256`, `TOPOKRATY_RECLAIM_TARGET.patched*`, `PLAN_RULES_TARGETS.*.patched*`,
`PATRIOTS_POSTIMAGE.*`, and the four rollback scripts' applied-flow shas.

Reviewed pins that demonstrably did **not** change: `TOPOKRATY_DIRECTION_HELPER_SHA256`,
`TOPOKRATY_PERCENT_HELPER_SHA256`, all three `TOPOKRATY_COURT_*_SHA256`,
`TOPOKRATY_REVIEWED_EVALUATOR_SHA256`, `PLAN_RULES_MODULE_SHA256`,
`PLAN_RULES_REVIEWED_EVALUATOR_SHA256`, `TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256`,
`PATRIOTS_PREIMAGE.pricingFunc/joinFunc/reviewedBookingRouterSource/reviewedPreviewSource`.

Deliberate decision: the live constants were **not edited** in the patchers. A patcher whose flow
hash is re-pinned but whose postimage/anchor invariant still describes an older generation passes
the first guard and is refused by the next — a fail-closed but misleading state, and its local
fixture tests would have to be rewritten for a generation that cannot be composed. The values are
recorded here and in `pin-table.md` instead.

## 3. Candidate composition and contract validation

Every generation named by the task refuses on the snapshot. Exact errors in
`composition-attempts.json`:

| Generation | First refusal |
| --- | --- |
| `lk1-topokraty-friendship` | `Booking gateway already carries the club decision percent` |
| `lk1-topokraty-rejection-reclaim` | `Booking gateway already carries this generation` |
| `lk1-topokraty-copay` | `Booking gateway already carries the club money mandate` |
| `lk1-plan-rules` | `LK1 plan-rules gateway body is already patched` |
| `lk1-hub` | `HUB exact source anchor drift: ([1, 2, 3].includes(index) \|\| (index === 0 && !preflightReadOnlyHttp(value)))` |
| `lk1-patriots-friendship` | `Installed preview game target drifted` |
| `subscription-calculation-repair` | `Subscription calculation node identity drift` (4815 ≠ 4804) |
| `lk1-event-quotes` | `Preview booking pin mismatch: 21c50a8d… != ed59d29e…` |

The one candidate that composes from reviewed bodies only:

| | |
| --- | --- |
| candidate sha256 | `0da79aa8355666dd7d35d93c751ec1f827e2d59f584bd5dff3fba1d21d3b6673` |
| source sha256 | `7e8a9570…` (4815 nodes) |
| changed node ids / fields | `lk_subscription_managed_policy_20260820:func`, `lk_subscription_price_preview_20260908_evaluate:func`, `lk_subscription_price_preview_20260908_router:func` |
| before → after | evaluator/evaluate `2d3f5b50…` → `e876ba07…`; router `43c21f70…` → `f83f4a98…` |
| added nodes | 0 |
| contract | `buildExactGraphContract` + `validateReviewedFlowContract` passed (exact-graph) |
| candidate bytes | external: `/private/tmp/lk1-train-147-prep/candidate-content/` |

Markers after composition: evaluator `COURT_HOURLY_COPAY` + `LK1_COURT_PRICE_UNRESOLVED`; preview
router `COURT_HOURLY_COPAY`, `isTopokratyExercise`, `canonical.isProTrainingExercise`,
`canonical.resolveLk1Rule`. The gateway still has no `lk1CourtMasterServices`, so this candidate is
**not shippable alone** — the write path would fail closed with `LK1_COURT_PRICE_UNRESOLVED`.

## 4. Ordered apply plan, rollback, postcheck

See `apply-plan.md`. Short form:

1. **G1 (blocker: must be authored)** — one re-anchored focused gateway generation carrying the
   reviewed court-window fragments, `hourlyCourtPriceMinor`, the `open_game` club gate and the
   Patriots money-validity guard + `"planKey":"patriots"` initialize transition.
2. **G2** — the composed content candidate above, stacked on G1's postimage.

Rollback is the reverse order **and** the plan-rules global first (the copay generation's documented
`rollbackOrder=1-plan-rules-global 2-preimage-generation`); every existing rollback script's applied
sha must be re-pinned to the new generation shas.

Postcheck reads per generation are listed in `apply-plan.md`; the decisive ones are the installed
flow sha256 readback, the installed-node marker checks, the plan-rules writer error-count delta in
`/root/.pm2/logs/*node-red*.log`, the smoke `https://padlhub.su/lk/advertising/split-payment-promo`
(HTTP 200, `currency: RUB`), and read-only preview quotes (Skolkovo 6233: 2 h → 1 500 ₽, 3 h →
3 000 ₽; club game hour → 1 500 ₽; unproven station → `LK1_COURT_PRICE_UNRESOLVED`).

## 5. Checks actually run (raw)

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test scripts/tests/lk1*` | tests 478, pass 387, fail 0, skipped 91 |
| `node --experimental-strip-types --test scripts/tests/topokraty* scripts/tests/patriots* scripts/tests/proTraining*` | tests 76, pass 65, fail 0, skipped 11 |
| `node --experimental-strip-types --test scripts/tests/noderedModularToolchain.test.mjs` | 7/7 pass (covers the pull script change) |
| `bash -n scripts/pull_nodered_source_from_147.sh` | syntax OK |
| ssh-cat fallback exercised with a failing fake `scp` and a fake `ssh` | `sourceTransport=ssh-cat`, sha/nodeCount printed, stdout shape unchanged |
| `git diff --check` | clean |

The known non-regression baseline (4 failures in `subscriptionBindingPatch` ×2 and
`subscriptionReturnVerificationPatch` ×2) lies in the wider `subscription*` set, not in the
`lk1*`/`topokraty*`/`patriots*`/`proTraining*` sets run above; those are fully green and match the
documented baseline exactly.

## 6. Residual risks / blockers

1. **No existing generation composes on the live snapshot.** The train needs a re-authored
   generation (route A) or the HUB overlay migration (route B). This is the blocking decision.
2. **Gateway court-window anchors.** `// HUB_STEPS` is absent from the live body;
   `ctx.step = "lk1_profile_continue";` occurs 4× (HUB body: 1×); the unique
   `if (ctx.step === "lk1_profile_continue") {` is a different insertion point. Choosing the
   dispatch point inside a payment gateway is a control-flow decision and needs review.
3. **HUB route extra conditions.** `composeHubFlow` also refuses at the gateway-body anchor and at
   `gateway.initialize !== ''` (live initialize is 11 438 bytes), and `preimages.json.incoming`
   gained one route (`lk_subscription_product_finish_20260907`).
4. **Patriots reviewed pins.** Live-node pins are partly re-derivable, but the reviewed evaluator
   now contains the court-hourly branch the Patriots generation was never reviewed with; blind
   re-pinning would pull it in.
5. **Viva court-price schema on the event path** is still unconfirmed live
   (`products/master-services/{id}/price` vs `studios/{id}/rooms/{id}/sub-services/{id}/price`).
6. **6180 live acceptance** of the quarter-of-hour formula has not been observed.
7. `previewSources(flow, { pins })` overrides `PREVIEW_CANONICAL_SOURCE_SHA256` in every current
   caller, so re-pinning that constant's defaults only affects `PLAN_RULES_INSTALLED_GENERATION.reviewed*Pin`
   and default-pin callers.
