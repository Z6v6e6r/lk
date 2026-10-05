# LK1 train 147 — G1/G2 preparation report (2026-10-05)

Status: **prepared, not applied.** 147 was read only (`ssh -o BatchMode=yes root@lk-primary-147
'sha256sum /root/.node-red/flows.json'` → `7e8a9570…`, 9 872 180 bytes, 4815 nodes; `scp` is refused
in this environment, per the preparation branch). No deploy, no flow import, no Node-RED restart, no
global write, no push.

Branch: `codex/lk1-train-g1-20261005`, worktree `.worktrees/lk1-train-g1-20261005`, created from the
tip of `codex/lk1-train-147-prep-20261005` (`daf678ea`, current main `6f2f6c80` plus the prep
commits).

## 1. What G1 and G2 are

Route: focused-lineage continuation (owner decision). G2 stacks on G1's postimage.

### G1 — `scripts/patch_live_lk1_train_g1_20261005.mjs`

One node changed, two fields, zero added:

| Node | Fields | Before | After |
| --- | --- | --- | --- |
| `lk_subscription_booking_router_20260804` | `func` | `21c50a8d…` | `b39de6aa00d9eeea3f29e9bbe5280ca7644e2f883d279b69c5096e263d83a514` |
| `lk_subscription_booking_router_20260804` | `initialize` | `d7aec140…` | `283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3` |

`func` deltas (each embedded verbatim from the reviewed source and sha-verified, each anchor
asserted exactly once before use):

1. **court helpers** — `lk1CourtMasterServices` station→master-service/sub-service table, the
   `global` cache reader, the window/URL derivation and `lk1CourtWindowNeeded`
   (`dea0323f…`), inserted before `if (ctx.step === "lk1_operation_find") {`;
2. **court steps** — `lk1CourtWindowEndTime` / `startLk1CourtWindowFetch` /
   `if (ctx.step === "lk1_court_window")` / `lk1CourtWindowStoreProof` (`1e8684b4…`), inserted at the
   same anchor, **byte-identical**, with one documented continuation delta at the `storeProof`
   call site (below);
3. **court dispatch** (`bd02267f…`) — inserted inside the `exercise` step immediately after
   `ctx.lk1 = quote;`, guarded by `ctx.lk1CourtExercise = exercise;` (see §3);
4. **`lk1Quote` court block** (`bb095970…`) — `target.hourlyCourtPriceMinor =
   round(windowTotalMinor × 60 / durationMinutes)`, so the stored fingerprint and the charge
   describe the same window;
5. **club gate #174** (`520e3486…`) — `["group_training", "open_game"].includes(resolveCategory(exercise))`
   with the reviewed refusal text «На занятия Топократов общие подписки не действуют…»
   (`TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`);
6. **Patriots money-only identity guard** (`9a417b05…`) plus the readback-detour widening
   (`(patriotsMoneyOnlyIdentity || ruleConfigured)` / `(patriotsMoneyOnlyIdentity || selectedOwned.length === 0 || enforcedRule)`);
7. **allowance deltas** — the club-game 90-minute free-visit ceiling (`e363c97b…`) and the club
   training `decision.courtMinutes` accumulator (`5b179145…`), both from the reviewed `gateway.js`.
   They are in G1 because G2 installs the evaluator that publishes those fields; without them the
   shared day bucket would grant the club free hour twice.

`initialize` delta: the plan-rules writer is **replaced** (not appended) by
`buildPatriotsPlanRulesTransition()` — the exact installed 9-rule payload
(`LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS`, accepted prior `[null, WITH_TOPOKRATY]`) becomes the
10-rule `LK1_PLAN_RULES_WITH_PATRIOTS` row `37ab3713-4431-4815-96ba-d7ece76a9241`
(`"planKey":"patriots"`). The resulting initialize is **byte-identical to
`PATRIOTS_POSTIMAGE.gatewayInitialize`** — an independent cross-check that the transition is the
reviewed one.

G1 rollback counterpart: `composeLk1TrainG1RevertArtifacts` composes on G1's postimage only
(`fc4a46a6…`) and replaces the writer with `buildPatriotsPlanRulesRevert()` →
`a5a3149f351e509e5534a7993f7ebb21991290f64d1159288fe813ba8ff5c2c4`, reverted initialize
`2c2c0c89…`.

### G2 — `scripts/patch_live_lk1_train_g2_20261005.mjs`

Three nodes changed, one field each, zero added, stacked on G1's postimage:

| Node | Before | After |
| --- | --- | --- |
| `lk_subscription_managed_policy_20260820.func` | `2d3f5b50…` | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` |
| `lk_subscription_price_preview_20260908_evaluate.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_router.func` | `43c21f70…` | `0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221` |

G2 candidate `24d263fd4b92b72251c2f1b636fa3c0e4b7636efed3aa802acd7df3ce944ce05`, 4815 nodes.

Difference from the preparation candidate `0da79aa8…`: G1 changes the shared allowance block
(`a3fc39f0…` → `2916f13c…`), which the price preview embeds byte-for-byte, so the recomposed
router moves (`f83f4a98…` → `0f2e528d…`) and the candidate sha moves. The preparation composer
prepended the Topokraty module; the reviewed preview closure already carries it, so G2 uses the
composed router verbatim (module present exactly once, refusal exactly once).

## 2. Contract validation and evidence

All three candidates (G1, G1 revert, G2) pass `buildExactGraphContract` **and**
`validateReviewedFlowContract`; the allow-lists are exactly the declared nodes/fields, `addedNodes = 0`,
`httpInputCount` unchanged (221). Every generation fails closed on: wrong flow sha, wrong node count,
wrong field sha, missing/duplicated anchor, wrong usage block (G2), wrong postimage, unparseable
body.

| Evidence | Path |
| --- | --- |
| Pin derivation (machine-readable, all old → new) | `outputs/lk1-train-g1-20261005/pin-derivation.json` |
| Pin table (review form) | `outputs/lk1-train-g1-20261005/pin-table.md` |
| Candidate evidence (shas, changed nodes/fields, contracts, markers) | `outputs/lk1-train-g1-20261005/candidate-evidence.json` |
| Exact-graph contracts | `outputs/lk1-train-g1-20261005/evidence/{g1,g1-revert,g2}-contract.json` |
| Ordered apply/rollback plan | `outputs/lk1-train-g1-20261005/apply-plan.md` |
| Broad LK1 suite raw output | `outputs/lk1-train-g1-20261005/evidence/lk1-suite-run.txt` |
| Reproduction tools | `outputs/lk1-train-g1-20261005/tools/{derive-all-pins,record-evidence,compose-g1,compose-g1-revert,compose-g2}.mjs` |

Candidate bytes are deliberately **not** committed (≈10 MB each, reproducible from the scripts plus
the read-only snapshot with `node outputs/lk1-train-g1-20261005/tools/compose-g1.mjs <snapshot> <dir>`).

## 3. Control-flow decision (needs human review)

The task suggested the unique dispatch anchor `if (ctx.step === "lk1_profile_continue") {` (the four
bare `ctx.step = "lk1_profile_continue";` assignments are not unique). I did **not** use it, because
on this lineage it cannot carry the request:

- `lk1_profile_continue` runs in the same invocation that follows the `profile` step, where
  `ctx.lk1` does not exist yet (`lk1CourtWindowNeeded` requires it) — the fresh http and the split
  path only produce the quote later, inside the `exercise` step;
- the reviewed `startLk1CourtWindowFetch` derives the window end through
  `lk1CourtWindowEndTime(proof)`, but `proof` (`lk1TariffProof`) carries `startsAt`, not
  `timeFrom`: `lk1CourtWindowTime(proof, "from")` returns `null`, so `toTime` is `null`, the URL is
  `null`, and every club request would stop with `LK1_COURT_PRICE_UNRESOLVED`. The fragment's own
  contract is that the caller passes the raw exercise (`ctx.lk1CourtExercise`), which its unit test
  does and which is the only source of the Viva-local `timeFrom`/`timeTo`.

Chosen insert points (all unique, all asserted):

| Piece | Insert point |
| --- | --- |
| court helpers + court steps | immediately before `if (ctx.step === "lk1_operation_find") {` |
| court dispatch (+ `ctx.lk1CourtExercise = exercise;` / `delete …`) | inside the `exercise` step, immediately after `ctx.lk1 = quote;` |
| `lk1Quote` court block | after `target.basePriceMinor = proof.amountMinor;` / `if (proof.kind === "EVENT_ONE_TIME") …` |
| club gate | replaces the installed `group_training`-only gate |
| Patriots guard / detour | after `const enforcedRule = …` / replaces the installed detour condition |
| allowance deltas | after the `gameMinutes` accumulator / replaces the `free > ctx.lk1.rule.freeGameMinutesPerDay` line |

Second deviation: the reviewed writer ends the court-window step with `ctx.step = "profile";
return false;`. `false` is dropped by Node-RED's `sendResults`, so the invocation emits nothing and
the booking would hang, and this focused lineage has no HUB `profile` re-entry. G1 therefore applies
one pinned continuation delta at the `lk1CourtWindowStoreProof` call site: forward a refusal if the
writer returns one, otherwise set `ctx.step = "exercise"` / `msg.payload = exercise` and let the same
invocation fall through to the `exercise` block, which re-prices the club event from the completed
`windowTotalMinor`. The reviewed steps fragment stays byte-identical (`1e8684b4…`); only the call
site is re-anchored (`b3342f91…`). **A specialist reviewer must approve these two insert/control-flow
decisions before a live apply.**

## 4. Commands run (raw results)

```
node outputs/lk1-train-g1-20261005/tools/compose-g1.mjs <snapshot> outputs/…/evidence
  → candidate fc4a46a6…, gateway func b39de6aa…, initialize 283f9e8a…, usage 2916f13c…, all markers true
node outputs/lk1-train-g1-20261005/tools/compose-g1-revert.mjs <g1 candidate> …
  → candidate a5a3149f…, initialize 283f9e8a… → 2c2c0c89…
node outputs/lk1-train-g1-20261005/tools/compose-g2.mjs <g1 candidate> …
  → candidate 24d263fd…, 3 changed nodes, evaluator/preview markers true, helperCount 94

npm run test:lk1-train-g1  → tests 6, pass 6, fail 0, skipped 0
npm run test:lk1-train-g2  → tests 5, pass 5, fail 0, skipped 0
node --experimental-strip-types --test <lk1|topokraty|patriots|subscription|planRules|proTraining|
  groupEventPayment|groupSubscriptionDiscount|tournamentSubscriptionDiscount|stationCourt suites>
  → tests 1684, pass 1469, fail 4, skipped 211
  → the 4 failures are exactly the known baseline: subscriptionBindingPatch (2),
    subscriptionReturnVerificationPatch (2); no new failure
node --experimental-strip-types --test scripts/tests/lk1PatriotsFriendship.test.mjs <new tests>
  → tests 19, pass 18, fail 0, skipped 1 (the Patriots private-snapshot test, absent preimage)
```

Registered in the established LK1 CI group (`check_10` of
`.github/workflows/lk1-subscription-enforcement.yml`, next to `lk1TopokratyCopayHotfix.test.mjs`) and
in `package.json` (`test:lk1-train-g1`, `test:lk1-train-g2`).

Owner decision implemented: `scripts/patch_live_lk1_patriots_friendship.mjs` `reviewedGatewaySource`
→ `430dbb09…`, `reviewedGatewayHooksSource` → `2225ca52…`, `reviewedEvaluatorSource` → `ac05d7cd…`.
`patchPatriotsGatewayInitialize` now **passes** on the live initialize (it expects exactly the
9-rule prior the live body carries and produces `283f9e8a…`); `patchPatriotsGatewayBody` still fails
closed on the stale `cfce248c…` gateway preimage, as before.

## 5. Feature state (owner / audience / result / stop)

- **Owner:** the LK1 club contour owner; audience: «Дружба Топократы» subscribers on Skolkovo.
- **Observed result after apply:** the preview quotes the court hour (2 h → 1 500 ₽, 3 h → 3 000 ₽,
  club game hour → 1 500 ₽) and the write path charges `chargeableHours × floor(hourly / 4)`.
- **Stop signal:** any `plan rules prior mismatch` / `readback mismatch` line, an installed sha
  other than the candidate, `LK1_COURT_PRICE_UNRESOLVED` on a table station, or a smoke failure.
- **Stop method:** `nodered:lk1-train-g2:rollback-147`, then `nodered:lk1-train-g1:rollback-147`
  (plan-rules revert first, then the snapshot restore); no flag exists and none is needed — the
  generation is the control.

## 6. Residual risks and blockers

1. **BLOCKER — no executable apply path.** The four guarded wrapper scripts (G1 deploy/rollback, G2
   deploy/rollback) are not authored. `apply-plan.md` specifies their exact contract; they must be
   written and reviewed before a live apply.
2. **BLOCKER (review) — two control-flow deviations** (§3) re-anchor reviewed code at the call site
   and redirect the court-window continuation. Specialist (payment-safety) review required.
3. **Court-window write path is unproven in production.** The reviewed fragments have never run on
   147 (the live body has no `lk1CourtMasterServices`); only the fragment-level unit test exists. The
   acceptance in `apply-plan.md` is deliberately read-only (preview quotes).
4. **Live Viva schema unconfirmed.** The event-path master-service price route
   (`studios/{stationId}/rooms/{roomId}/sub-services/{subServiceId}/price`) is taken from the split
   path; the response shape (`from`/`total`) has no fresh event-path pull.
5. **Allowance arithmetic** — the `courtMinutes` accumulator and the club-game 90-minute ceiling are
   `gateway.js` fragments from the HUB lineage applied to the focused usage block. The
   `AUDIT_BINDING` sub-branch differs from the reviewed ordering, so the day-bucket review is a
   distinct risk from §3.
6. **Ordering window.** Between G1 and G2 the plan-rules global names `patriots` while the installed
   evaluator is still the pre-Patriots one; a Patriots event quoted in that window takes the generic
   50 % path (the gateway guard still forces the money readback). Apply G2 immediately after G1, or
   re-decide the order.
7. **Station cache never written.** `subscriptions_lk1_court_service:<stationId>` has no producer in
   the repository, so any station outside `lk1CourtMasterServices` refuses with
   `LK1_COURT_PRICE_UNRESOLVED` (intended fail-closed, but a coverage limit).
8. **Stale cross-generation pins stay stale on purpose.** The co-pay, plan-rules, event-quotes,
   calculation-repair and HUB generations still refuse on this snapshot; their live preimages are
   gone. Re-pinning them without re-authoring would produce the misleading fail-closed state the
   preparation branch already rejected. See `pin-table.md` section C.
9. **Patriots generation is only partially re-pinned** (reviewed sources + the proven initialize);
   its gateway body still refuses on its own stale preimage. Re-authoring the Patriots generation on
   this body is a separate decision — G1 carries only the money-only guard and the plan rule.
10. **`preimages.json.incoming`** gained one route
    (`lk_subscription_product_finish_20260907 → lk_subscription_booking_router_20260804`) relative to
    the pinned set; any future HUB composition must account for it.
