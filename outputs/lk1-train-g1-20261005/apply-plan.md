# LK1 train 147 — G1/G2 ordered apply, rollback and postcheck plan (prepared, NOT applied)

Nothing in this plan has been executed. 147 was only read (`ssh -o BatchMode=yes
root@lk-primary-147 'cat /root/.node-red/flows.json'`, `sha256sum`). No deploy, no flow import, no
Node-RED restart, no global write, no push.

| | |
| --- | --- |
| Snapshot preimage | `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1` (4815 nodes) |
| G1 candidate | `fc4a46a6d1cbda022e8d3ce503d019bc4d0d1e366ff44ba53612a0809256efc5` |
| G1 revert candidate (ordered rollback step 1) | `a5a3149f351e509e5534a7993f7ebb21991290f64d1159288fe813ba8ff5c2c4` |
| G2 candidate | `24d263fd4b92b72251c2f1b636fa3c0e4b7636efed3aa802acd7df3ce944ce05` |
| Plan-rules global | `subscriptions_lk1_plan_rules`: 9 rules → 10 rules (G1), 10 → 9 (G1 revert) |

## Preconditions (fail closed)

1. A fresh read-only pull of `/root/.node-red/flows.json` whose sha is exactly
   `7e8a9570…`; any other sha stops the train (the generation refuses it anyway).
2. A clean checkout whose tree equals `origin/main`; the deploy wrapper must refuse a dirty tree.
3. `NODE_RED_LK1_TRAIN_G1_DEPLOY=CONFIRM_147` (G1) and `NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147`
   (G2). G1 and G2 are separate confirmations: G2 must never run unless G1's readback passed.
4. Remote backups of `flows.json` under `/root/.node-red/backups/` before each import, plus the
   plan-rules global value captured before G1.

**Blocker (must be resolved before any live apply):** the guarded wrappers and their npm scripts are
**not authored in this preparation task**. To be authored and reviewed separately:

- `scripts/deploy_nodered_lk1_train_g1_147.sh` → `nodered:lk1-train-g1:deploy-147`
- `scripts/rollback_nodered_lk1_train_g1_147.sh` → `nodered:lk1-train-g1:rollback-147`
- `scripts/deploy_nodered_lk1_train_g2_147.sh` → `nodered:lk1-train-g2:deploy-147`
- `scripts/rollback_nodered_lk1_train_g2_147.sh` → `nodered:lk1-train-g2:rollback-147`

The commands below name the exact contract those wrappers must implement (model:
`scripts/deploy_nodered_lk1_topokraty_copay_147.sh` /
`scripts/rollback_nodered_lk1_topokraty_copay_147.sh`). Until they exist and are reviewed, the
train has no executable apply path; do not improvise the apply from this document.

## Step 1 — apply G1 (gateway `func` + `initialize`)

```
NODE_RED_LK1_TRAIN_G1_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g1:deploy-147
```

The wrapper must, in order: verify the clean tree and the exact preimage sha; compose the candidate
with `node scripts/patch_live_lk1_train_g1_20261005.mjs --mode generation --workspace <fresh> …`;
require candidate sha `fc4a46a6…` and node sha `6d16a8ef…`; run the exact-graph contract
(`scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs`, gateway node only, fields
`func`,`initialize`); back up the installed flow; import; restart Node-RED; then read back.

| | sha before | sha after |
| --- | --- | --- |
| `flows.json` | `7e8a9570…` | `fc4a46a6…` |
| gateway `func` | `21c50a8d…` | `b39de6aa…` |
| gateway `initialize` | `d7aec140…` | `283f9e8a…` |
| allowance block | `a3fc39f0…` | `2916f13c…` |

Postcheck (all must hold, else roll back immediately):

1. installed `flows.json` sha256 == `fc4a46a6…`;
2. installed gateway contains `lk1CourtMasterServices`, `lk1CourtWindowNeeded`,
   `hourlyCourtPriceMinor`, `["group_training", "open_game"]`, `patriotsMoneyOnlyIdentity`,
   `operation.lk1.decision.courtMinutes`;
3. installed `initialize` contains `"planKey":"patriots"` exactly once and still contains
   `"planKey":"topocraty"` and `"planKey":"friendship_two_hours"`;
4. `grep -hE 'plan rules prior mismatch|plan rules readback mismatch' /root/.pm2/logs/*node-red*.log | wc -l`
   must not increase across the restart;
5. smoke `https://padlhub.su/lk/advertising/split-payment-promo` → HTTP 200, `currency == "RUB"`,
   `pricingMode` is a string.

**Stop signal:** any of 1–5 failing, any log line matching `plan rules prior mismatch`,
`plan rules readback mismatch`, `LK1_COURT_PRICE_UNRESOLVED` on a non-club request, or a
`flows.json` sha other than `fc4a46a6…`. Stop and run Step R1/R2; do not continue to Step 2.

## Step 2 — apply G2 (evaluator + preview evaluate + preview router)

```
NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g2:deploy-147
```

The wrapper must first re-verify the installed sha is exactly G1's postimage `fc4a46a6…`, compose
with `node scripts/patch_live_lk1_train_g2_20261005.mjs`, require candidate sha `24d263fd…`, run the
exact-graph contract for the three content nodes, back up, import, restart, read back.

| | sha before | sha after |
| --- | --- | --- |
| `flows.json` | `fc4a46a6…` | `24d263fd…` |
| `lk_subscription_managed_policy_20260820.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_evaluate.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_router.func` | `43c21f70…` | `0f2e528d…` |

Postcheck:

1. installed sha == `24d263fd…`;
2. the evaluator and the preview evaluate carry `COURT_HOURLY_COPAY` and
   `LK1_COURT_PRICE_UNRESOLVED`; both carry `PATRIOTS_FRIENDSHIP_PRODUCT_ID`;
3. the preview router carries `COURT_HOURLY_COPAY`, the court-window step
   (`if (ctx.step === 'courtWindow') {`), `isTopokratyExercise`, `isTopokratyClubPack` usage,
   `canonical.isProTrainingExercise` and `canonical.resolveLk1Rule`;
4. the plan-rules error-count check of Step 1 still shows no increase.

**Stop signal:** any of 1–4 failing, any new `plan rules …` error, any preview quote outside the
acceptance set below. Roll back G2 (Step R3) and then decide whether to keep G1.

## Read-only acceptance quotes (after Step 2, no writes)

Run the advisory preview for a Skolkovo event (station `0d5504f6-ea6f-44bb-a9e4-947faf0273ab`) with
the club product `14692232-12be-4218-9fa1-2d5b79b62035`:

| Case | Expected |
| --- | --- |
| direction 6233, 2 h | `amountMinor = 150000` (1 500 ₽), `hourlyCourtPriceMinor = 600000`, `chargeableHours = 1`, `freeMinutes + paidMinutes == durationMinutes`, `discountPercent = 0`, `subscriptionVisitCount = 1` |
| direction 6233, 3 h | `amountMinor = 300000` (3 000 ₽), `chargeableHours = 2`, `perHourMinor = 150000` |
| club game 6180, one paid hour | `amountMinor = 150000` (1 500 ₽) |
| station outside `lk1CourtMasterServices` | `LK1_COURT_PRICE_UNRESOLVED` — never the event tariff |
| non-club subscription on 6233/6180 | `TOPOKRATY_SUBSCRIPTION_UNAVAILABLE` |
| smoke | `https://padlhub.su/lk/advertising/split-payment-promo` → HTTP 200, `currency == "RUB"`, string `pricingMode` |

## Rollback (ordered; plan-rules global first, then generations in reverse)

| Step | Command | Effect | Readback |
| --- | --- | --- | --- |
| R1 | `NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g1:rollback-147 -- <stamp>` | imports G1's revert candidate `a5a3149f…` (G1 bodies, plan-rules writer reverted) and restarts, so the global goes back to the installed 9-rule payload **before** any flow is restored | installed sha == `a5a3149f…`; `grep … 'plan rules' /root/.pm2/logs/*node-red*.log` shows no `prior mismatch`; global rule count == 9 |
| R2 | same wrapper, restore stage | restores the snapshot preimage `7e8a9570…` and restarts | installed sha == `7e8a9570…`, node count 4815, gateway `func == 21c50a8d…`, `initialize == d7aec140…` |
| R3 (G2 first, if G2 was applied) | `NODE_RED_LK1_TRAIN_G2_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g2:rollback-147 -- <stamp>` | restores G1's postimage `fc4a46a6…` and restarts | installed sha == `fc4a46a6…`; the three content nodes back at `2d3f5b50…`/`43c21f70…` |

Order is mandatory: **G1's plan-rules revert runs before the preimage restore** (restoring the flow
alone would leave the global naming the Patriots product while the restored gateway has no Patriots
guard), and **G2 is rolled back before G1** because G2's postimage stacks on G1's.

Stop signals for rollback: any readback sha mismatch, any `plan rules` error line, or a
`flows.json` that is neither the expected candidate nor the expected preimage — stop and escalate;
do not import a second time.

## Not covered by this plan

- The wrapper scripts themselves (see the blocker above).
- Any write to the plan-rules global outside the generation's `initialize` (none is authorised).
- Live Viva schema confirmation for the court-window price route (residual risk R1 of the report).
