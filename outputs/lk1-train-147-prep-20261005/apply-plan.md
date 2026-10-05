# LK1 train 147 — ordered apply plan, rollback and postcheck (prepared, not applied)

Preimage: `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1`, 4815 nodes.
Nothing in this plan has been executed. 147 was only read.

## What is already installed on 147 (verified from the snapshot bytes)

| Feature | Installed? | Evidence |
| --- | --- | --- |
| Club contour / money mandate (`lk1ClubEventPaymentBinding`, `lk1EventPaymentQuoteBinding` ×5 call sites) | yes | gateway func contains both, 5 quote call sites |
| Rejection/reclaim generation (`lk1ReclaimableAttempt`) | yes | 2 occurrences |
| Plan-rules writer with `"planKey":"topocraty"` (9 rules) | yes | gateway `initialize` |
| PRO-training 50 % discount (`isProTrainingDiscountRule`) | yes | gateway func, 3 occurrences |
| Club gate extension to `open_game` (#174) | **no** | gate is still `resolveCategory(exercise) === "group_training"`, old refusal text |
| Court-window proof (`lk1CourtMasterServices`) | **no** | 0 occurrences in gateway |
| `hourlyCourtPriceMinor` / `windowTotalMinor` in the gateway | **no** | 0 occurrences |
| Evaluator `COURT_HOURLY_COPAY` branch | **no** | 0 occurrences in evaluator |
| Preview `COURT_HOURLY_COPAY` quote / court-window step | **no** | 0 occurrences in preview router |
| Patriots money-validity guard (`patriotsMoneyOnlyIdentity`) | **no** | 0 occurrences; no `"planKey":"patriots"` |
| `..._final` / `..._error` preview nodes | at the **current reviewed** source | live `final` = `e7c174ea…` = reviewed `final.js`; live `error` = `b29321c7…` = reviewed `error.js` |
| `HUB_*` composition markers (`// HUB_STEPS`) | **no** | 0 occurrences — 147 is not a HUB-composed body |

## Composition result for every generation named by the task

All eight focused generations refuse on the snapshot. Full text and exact errors:
`composition-attempts.json`.

| Generation | Result | First refusal |
| --- | --- | --- |
| `lk1-topokraty-friendship` | refused | `Booking gateway already carries the club decision percent` |
| `lk1-topokraty-rejection-reclaim` | refused | `Booking gateway already carries this generation` |
| `lk1-topokraty-copay` | refused | `Booking gateway already carries the club money mandate` |
| `lk1-plan-rules` | refused | `LK1 plan-rules gateway body is already patched` |
| `lk1-hub` (overlay composition) | refused | `HUB exact source anchor drift: ([1, 2, 3].includes(index) …)` |
| `lk1-patriots-friendship` | refused | `Installed preview game target drifted` |
| `subscription-calculation-repair` | refused | `Subscription calculation node identity drift` (4815 ≠ 4804) |
| `lk1-event-quotes` | refused | `Preview booking pin mismatch: 21c50a8d… != ed59d29e…` |

Consequence: **on this snapshot no existing generation can be re-pinned into an applicable
candidate.** Re-pinning the live constants without re-authoring the generation would leave a
patcher that passes its flow-hash guard and is then refused by the next guard — a fail-closed but
misleading state — so the pin edits were deliberately **not** committed (see the report).

## The one candidate that could be composed now

`tools/compose-content-candidate.mjs` composed the *content* part of the train from the snapshot
using only reviewed bodies:

| Field | Before | After |
| --- | --- | --- |
| `lk_subscription_managed_policy_20260820.func` | `2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602` | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` |
| `lk_subscription_price_preview_20260908_evaluate.func` | `2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602` | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` |
| `lk_subscription_price_preview_20260908_router.func` | `43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70` | `f83f4a988d4874f10c39ed5092616e87938288b0c4c0c91021da7ec3abf32fd6` |

- candidate sha256 `0da79aa8355666dd7d35d93c751ec1f827e2d59f584bd5dff3fba1d21d3b6673`
- changed nodes: 3, added nodes: 0
- exact-graph contract built **and validated** (`buildExactGraphContract` +
  `validateReviewedFlowContract` both passed) — see `content-candidate.json`
- candidate bytes are kept **external**: `/private/tmp/lk1-train-147-prep/candidate-content/`
  (never imported, never written outside the private workspace)
- markers: evaluator `COURT_HOURLY_COPAY` + `LK1_COURT_PRICE_UNRESOLVED` present; preview
  `COURT_HOURLY_COPAY`, the Topokraty exclusion, PRO-training and `canonical.resolveLk1Rule` present
- **incomplete on its own**: the gateway still lacks the court-window proof, so this candidate
  quotes and evaluates the court hour but the write path fails closed with
  `LK1_COURT_PRICE_UNRESOLVED`. It must ship together with the gateway generation below.

## Ordered plan (recommended route A — focused-lineage continuation)

Two generations, applied in this order. G1 is **not yet authored** — it is the blocker below.

### Step 0 — preparation (this branch)

1. Re-pin every live/preimage value in `pin-table.md` (values derived, not committed as patcher
   edits until G1/G2 are authored and their postimages composed).
2. Author **G1** = one focused gateway generation on the snapshot that carries exactly the missing
   reviewed deltas, re-anchored:
   - `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` court fragments
     (`TOPOKRATY_COURT_HELPERS_SHA256` `dea0323f…`, `TOPOKRATY_COURT_DISPATCH_SHA256` `bd02267f…`,
     `TOPOKRATY_COURT_STEPS_SHA256` `1e8684b4…`) — described as "pinpoint deltas into today's
     bodies";
   - the open_game club gate (`["group_training", "open_game"]` + the explicit refusal text);
   - the Patriots money-validity guard + `"planKey":"patriots"` transition in `initialize`;
   - `hourlyCourtPriceMinor` derivation in the gateway `lk1Quote` and the `courtMinutes` day-bucket
     read from the reviewed `gateway.js`.
   Fails closed on: flow sha, node count, gateway func + initialize shas, every anchor occurrence
   count, and the reviewed-fragment pins.
3. Author **G2** = the composed content generation above (evaluator, preview evaluate, preview
   router), stacked on G1's postimage; its `pins.booking`/`installedUsageSha256` must be G1's
   gateway func and usage block.

### Step 1 — apply G1 (gateway + initialize)

- wrapper shape: copy the guarded order of `scripts/deploy_nodered_lk1_topokraty_copay_147.sh`
  (CONFIRM_147 variable, clean `main` == `origin/main`, private staged workspace, exact upstream
  preimage, exact-graph contract with `--allow-change`, remote preflight, backups, apply, sha
  readback, installed-marker postcheck, plan-rules error-count delta, smoke, ordered rollback hint).
- postcheck reads:
  1. installed `flows.json` sha256 == G1 candidate sha (must equal `activeFlowSha256`);
  2. installed gateway contains `lk1CourtMasterServices`, `windowTotalMinor`, `hourlyCourtPriceMinor`,
     `["group_training", "open_game"]`, `patriotsMoneyOnlyIdentity`, and `initialize` contains
     `"planKey":"patriots"`;
  3. `grep -hE 'plan rules prior mismatch|plan rules readback mismatch' /root/.pm2/logs/*node-red*.log | wc -l`
     must not increase across the restart;
  4. smoke `https://padlhub.su/lk/advertising/split-payment-promo` → HTTP 200 with
     `currency == "RUB"` and a string `pricingMode`.

### Step 2 — apply G2 (evaluator + preview content)

- stacked preimage = G1 postimage; same wrapper shape, 3 changed nodes.
- postcheck reads:
  1. installed sha == G2 candidate sha;
  2. evaluator and preview evaluate carry `COURT_HOURLY_COPAY` + `LK1_COURT_PRICE_UNRESOLVED`;
     preview router carries `COURT_HOURLY_COPAY`, `isTopokratyExercise`, `canonical.isProTrainingExercise`
     and `canonical.resolveLk1Rule`;
  3. read-only preview of a Skolkovo direction-6233 event: 2 h → `amountMinor = 150000`, 3 h →
     `300000`, per-hour `hourlyCourtPriceMinor = 600000`, `freeMinutes + paidMinutes == durationMinutes`,
     `discountPercent == 0`, `subscriptionVisitCount == 1`;
  4. read-only preview of a club game 6180 over the free minutes → `150000` per started paid hour;
  5. a station outside the reviewed court table → `LK1_COURT_PRICE_UNRESOLVED`, never the event tariff;
  6. a non-club subscription on 6233/6180 → `TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`.

### Rollback

The train is a stack, so rollback runs in the reverse order **and** the plan-rules global is a
separate first step exactly as the copay generation already documents
(`rollbackOrder=1-plan-rules-global 2-preimage-generation`):

1. if G1 replaced the plan-rules writer: run the guarded ordered rollback that writes the installed
   payload back first (`npm run nodered:lk1-topokraty-copay:rollback-147 -- <stamp>` is the existing
   precedent; its `preimage_flow_sha` must be re-pinned from `9d2487a4…` to the G1 candidate sha,
   and its expected prior rule count from 8 to the installed 9);
2. restore G1's preimage flow (the snapshot `7e8a9570…`), verified by sha readback;
3. G2 first, then G1: G2's rollback restores the snapshot bodies for evaluator/preview evaluate/
   preview router; only then is G1 reverted.

Existing rollback scripts and the pins they need re-derived:

| Script | Pin | Old | New |
| --- | --- | --- | --- |
| `rollback_nodered_lk1_topokraty_copay_147.sh` | `preimage_flow_sha` | `9d2487a4…` | G1 candidate sha (NOT DERIVABLE yet) |
| `rollback_nodered_lk1_topokraty_reclaim_147.sh` | `applied_flow_sha` | `9d2487a4…` | not applicable to this train |
| `rollback_nodered_lk1_topokraty_friendship_147.sh` | applied sha | friendship candidate | not applicable to this train |
| `TOPOKRATY_COPAY_APPLIED_SHA256` | applied candidate | `70b9350f…` | G1+G2 applied sha (NOT DERIVABLE yet) |

## Alternative route B — HUB overlay migration

Per `AGENTS.md` ("Unified subscription enforcement is one graph; never substitute a sequence of
partial wrappers") and `docs/LK1_FRIENDSHIP_TWO_HOURS_RELEASE_GATES.md` ("an overlay migration is
needed: changes are made as pinpoint deltas into today's bodies"), route B would restore the HUB
lineage in one graph (`composeHubReleaseArtifacts`, install safe-off → enable). It needs three
decisions beyond pin re-derivation, all proven from the snapshot:

1. `composeHubFlow` refuses the live gateway body at its first anchor
   (`([1, 2, 3].includes(index) || (index === 0 && !preflightReadOnlyHttp(value)))`) — the live body
   is not the HUB body, so the anchors must be re-derived or the body migrated;
2. `composeHubFlow` requires `gateway.initialize === ''`; the live initialize is 11 438 bytes;
3. `preimages.json.incoming` gained one route
   (`lk_subscription_product_finish_20260907 → lk_subscription_booking_router_20260804`, output 0).

Route B is the architecturally preferred path but is a larger, higher-risk change to a payment
gateway and needs the CRITICAL review of its re-anchored deltas.
