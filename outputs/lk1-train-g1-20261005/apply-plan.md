# LK1 train 147 — G1/G2 ordered apply, rollback and postcheck plan (prepared, NOT applied)

Nothing in this plan has been executed. 147 was only read (`ssh -o BatchMode=yes
root@lk-primary-147 'cat /root/.node-red/flows.json'`, `sha256sum`). No deploy, no flow import, no
Node-RED restart, no global write, no push.

| | |
| --- | --- |
| Snapshot preimage | `7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1` (4815 nodes) |
| G1 candidate | `99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3` |
| G1 revert candidate (ordered rollback step 2) | `0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f` |
| G2 candidate | `0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192` |
| Plan-rules global | `subscriptions_lk1_plan_rules`: 9 rules → 10 rules (G1), 10 → 9 (G1 revert) |

The G1-revert candidate keeps G1's `func` and replaces **only** `initialize` (its exact-graph
contract has one allowed change, node sha `d4d84655…` → `ac01f156…`, field `initialize`). It
therefore never restores pre-G1 body bytes: the pre-G1 `func`/`initialize` reach the server only
through the snapshot restore of Step R3.

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
require candidate sha `99b5d5b5…` and node sha `d4d84655…`; run the exact-graph contract
(`scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs`, gateway node only, fields
`func`,`initialize`); back up the installed flow; import; restart Node-RED; then read back.

| | sha before | sha after |
| --- | --- | --- |
| `flows.json` | `7e8a9570…` | `99b5d5b5…` |
| gateway `func` | `21c50a8d…` | `7f1539bf…` |
| gateway `initialize` | `d7aec140…` | `283f9e8a…` |
| allowance block | `a3fc39f0…` | `2916f13c…` |

Postcheck (all must hold, else roll back immediately):

1. installed `flows.json` sha256 == `99b5d5b5…`;
2. installed gateway contains `lk1CourtMasterServices`, `lk1CourtWindowNeeded`,
   `hourlyCourtPriceMinor`, `["group_training", "open_game"]`, `patriotsMoneyOnlyIdentity`,
   `operation.lk1.decision.courtMinutes`;
3. **club money mandate (F1/F5):** `COURT_HOURLY_COPAY` is present exactly once and inside the
   installed `lk1ClubEventPaymentBinding` definition — extract the body from
   `const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {` to its closing `};` and assert
   it contains `if (decision.benefit?.kind === "COURT_HOURLY_COPAY")` and
   `perHour === Math.floor(hourly / 4)`. A grep of the whole function is not sufficient (a marker
   anywhere else must not pass); the installed `func` must also still carry the quote resolver and
   its five call sites exactly once;
4. **write path (F2/F5):** the installed `func` is placed after `ctx.studioId =
   quote.target.stationId;`, assigns `ctx.roomId = quote.target.roomId;` before
   `if (lk1CourtWindowNeeded(ctx))`, and `node --experimental-strip-types --test
   scripts/tests/lk1TrainG1Hotfix.test.mjs` passes against the candidate — the execution test drives
   the installed fragments and proves the proof stores a non-null station/room and the second pass
   no longer refuses `LK1_COURT_PRICE_UNRESOLVED` (not only static markers/read-only previews);
5. installed `initialize` contains `"planKey":"patriots"` exactly once and still contains
   `"planKey":"topocraty"` and `"planKey":"friendship_two_hours"`;
6. `grep -hE 'plan rules prior mismatch|plan rules readback mismatch' /root/.pm2/logs/*node-red*.log | wc -l`
   must not increase across the restart;
7. smoke `https://padlhub.su/lk/advertising/split-payment-promo` → HTTP 200, `currency == "RUB"`,
   `pricingMode` is a string.

**Stop signal:** any of 1–7 failing, any log line matching `plan rules prior mismatch`,
`plan rules readback mismatch`, `LK1_COURT_PRICE_UNRESOLVED` on a non-club request, or a
`flows.json` sha other than `99b5d5b5…`. Stop and run Step R2/R3 (G1 was applied without G2); do
not continue to Step 2.

**Out-of-scope Patriots window (F4 — owner decision required before a live apply).** Between the
Step 1 and Step 2 applies the flow is restarted and the plan-rules global names `patriots` (10
rules) while the installed evaluator is still the pre-Patriots one. During that window an
out-of-scope Patriots event can be booked at the generic 50 % instead of being refused. Two
options, neither chosen here: **(a)** quiesce the booking ingress for the two applies (e.g. a
maintenance window / ingress gate), or **(b)** reverse the order so the evaluator lands before the
plan rule. Both change the reviewed apply sequence and need the owner's decision; this train's
default (apply G2 immediately after G1) does not close the window by itself.

## Step 2 — apply G2 (evaluator + preview evaluate + preview router)

```
NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g2:deploy-147
```

The wrapper must first re-verify the installed sha is exactly G1's postimage `99b5d5b5…`, compose
with `node scripts/patch_live_lk1_train_g2_20261005.mjs`, require candidate sha `0f95fbd3…`, run the
exact-graph contract for the three content nodes, back up, import, restart, read back.

| | sha before | sha after |
| --- | --- | --- |
| `flows.json` | `99b5d5b5…` | `0f95fbd3…` |
| `lk_subscription_managed_policy_20260820.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_evaluate.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_router.func` | `43c21f70…` | `0f2e528d…` |

Postcheck:

1. installed sha == `0f95fbd3…`;
2. the evaluator and the preview evaluate carry `COURT_HOURLY_COPAY` and
   `LK1_COURT_PRICE_UNRESOLVED`; both carry `PATRIOTS_FRIENDSHIP_PRODUCT_ID`;
3. the preview router carries `COURT_HOURLY_COPAY`, the court-window step
   (`if (ctx.step === 'courtWindow') {`), `isTopokratyExercise`, `isTopokratyClubPack` usage,
   `canonical.isProTrainingExercise` and `canonical.resolveLk1Rule`;
4. the gateway `func` is still G1's postimage `7f1539bf…` (G2 does not touch it) and still carries
   the club money mandate of Step 1 postcheck 3 and the dispatch order of postcheck 4;
5. the plan-rules error-count check of Step 1 still shows no increase.

**Stop signal:** any of 1–5 failing, any new `plan rules …` error, any preview quote outside the
acceptance set below. Roll back G2 (Step R1) and then decide whether to keep G1.

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

## Rollback (ordered: G2 first, then the G1 plan-rules revert, then the preimage restore)

The only workable order **when G2 was applied** is R1 → R2 → R3, in exactly that sequence. G2's
postimage stacks on G1's, so it must leave first; and the plan-rules global must go back to the
installed 9-rule payload **before** any flow is restored, because restoring the flow alone would
leave the global naming the Patriots product while the restored gateway has no Patriots guard.

| Step | Command | Effect | Readback |
| --- | --- | --- | --- |
| R1 (G2, if G2 was applied) | `NODE_RED_LK1_TRAIN_G2_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g2:rollback-147 -- <stamp>` | restores G1's postimage `99b5d5b5…` and restarts | installed sha == `99b5d5b5…`; the three content nodes back at `2d3f5b50…`/`43c21f70…`; gateway `func == 7f1539bf…`, `initialize == 283f9e8a…` |
| R2 | `NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g1:rollback-147 -- <stamp>` | imports G1's revert candidate `0e74cd11…` (G1's `func` kept, **only** `initialize` reverted to the installed nine-rule writer) and restarts, so the global goes back to the installed 9-rule payload before the flow is restored | installed sha == `0e74cd11…`; gateway `func == 7f1539bf…` (unchanged); `grep … 'plan rules' /root/.pm2/logs/*node-red*.log` shows no `prior mismatch`; global rule count == 9 |
| R3 | same wrapper, restore stage | restores the snapshot preimage `7e8a9570…` and restarts | installed sha == `7e8a9570…`, node count 4815, gateway `func == 21c50a8d…`, `initialize == d7aec140…` |

The G1-revert candidate deliberately keeps G1's `func` and replaces only `initialize`: it is a
plan-rules step, not a body restore. **Pre-G1 body bytes therefore come only from the R3 snapshot
restore** — do not expect `0e74cd11…` (or any G1-revert stage) to bring back the pre-G1 `func` or
the pre-G1 `initialize`. If G2 was never applied, start at R2.

Stop signals for rollback: any readback sha mismatch, any `plan rules` error line, or a
`flows.json` that is neither the expected candidate nor the expected preimage — stop and escalate;
do not import a second time.

## Not covered by this plan

- The wrapper scripts themselves (see the blocker above).
- Any write to the plan-rules global outside the generation's `initialize` (none is authorised).
- Live Viva schema confirmation for the court-window price route (residual risk R1 of the report).
- **F4 owner decision:** the G1→G2 Patriots window (two options in Step 1 above) is unresolved by
  design and must be decided before a live apply.
