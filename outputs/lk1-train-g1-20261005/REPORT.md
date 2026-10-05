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
| `lk_subscription_booking_router_20260804` | `func` | `21c50a8d…` | `7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4` |
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
3. **court dispatch** (`bd02267f…`) — inserted inside the `exercise` step **after**
   `ctx.studioId = quote.target.stationId;`, with `ctx.roomId = quote.target.roomId;` assigned
   before it (see §3 and the F2 fix in §7);
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
   shared day bucket would grant the club free hour twice;
8. **club money mandate** (`d2390769…`, F1 fix in §7) — the reviewed
   `if (decision.benefit?.kind === "COURT_HOURLY_COPAY") { … }` branch spliced into the installed
   `lk1ClubEventPaymentBinding`. The installed 147 body already carried the rest of the binding, the
   quote resolver and the five call sites, so only the branch is added and the delivered binding is
   asserted byte-identical to the reviewed definition.

`initialize` delta: the plan-rules writer is **replaced** (not appended) by
`buildPatriotsPlanRulesTransition()` — the exact installed 9-rule payload
(`LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS`, accepted prior `[null, WITH_TOPOKRATY]`) becomes the
10-rule `LK1_PLAN_RULES_WITH_PATRIOTS` row `37ab3713-4431-4815-96ba-d7ece76a9241`
(`"planKey":"patriots"`). The resulting initialize is **byte-identical to
`PATRIOTS_POSTIMAGE.gatewayInitialize`** — an independent cross-check that the transition is the
reviewed one.

G1 rollback counterpart: `composeLk1TrainG1RevertArtifacts` composes on G1's postimage only
(`99b5d5b5…`) and replaces the writer with `buildPatriotsPlanRulesRevert()` →
`0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f`, reverted initialize
`2c2c0c89…`. It keeps G1's `func` and replaces only `initialize` (see the corrected rollback order
in `apply-plan.md`): pre-G1 body bytes come only from the snapshot restore.

### G2 — `scripts/patch_live_lk1_train_g2_20261005.mjs`

Three nodes changed, one field each, zero added, stacked on G1's postimage:

| Node | Before | After |
| --- | --- | --- |
| `lk_subscription_managed_policy_20260820.func` | `2d3f5b50…` | `e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1` |
| `lk_subscription_price_preview_20260908_evaluate.func` | `2d3f5b50…` | `e876ba07…` |
| `lk_subscription_price_preview_20260908_router.func` | `43c21f70…` | `0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221` |

G2 candidate `0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192`, 4815 nodes.

Difference from the preparation candidate `0da79aa8…`: G1 changes the shared allowance block
(`a3fc39f0…` → `2916f13c…`), which the price preview embeds byte-for-byte, so the recomposed
router moves (`f83f4a98…` → `0f2e528d…`) and the candidate sha moves. The preparation composer
prepended the Topokraty module; the reviewed preview closure already carries it, so G2 uses the
composed router verbatim (module present exactly once, refusal exactly once). After the F1/F2
correction the preview router is re-derived again over the corrected G1 body and stays
`0f2e528d…`: the corrected club-binding/dispatch code does not enter the preview helper closure;
only the (unchanged) allowance block does.

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
| court dispatch (+ `ctx.roomId = quote.target.roomId;` / `ctx.lk1CourtExercise = exercise;` / `delete …`) | inside the `exercise` step, after `ctx.studioId = quote.target.stationId;` (F2 fix, §7) |
| `lk1Quote` court block | after `target.basePriceMinor = proof.amountMinor;` / `if (proof.kind === "EVENT_ONE_TIME") …` |
| club gate | replaces the installed `group_training`-only gate |
| club money mandate (`COURT_HOURLY_COPAY`) | spliced after `const percent = decision.eventDiscountPercent;` inside `lk1ClubEventPaymentBinding` (F1 fix, §7) |
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

Re-run after the F1/F2 correction (all commands from the worktree root, snapshot
`/private/tmp/lk1-train-147-prep/input/source.flow.json`, sha `7e8a9570…`, 4815 nodes):

```
node outputs/lk1-train-g1-20261005/tools/compose-g1.mjs <snapshot> /tmp/lk1-final
  → candidate 99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3
    gateway func 21c50a8d… → 7f1539bf…, initialize d7aec140… → 283f9e8a…, usage a3fc39f0… → 2916f13c…
    markers: clubMoneyMandateBound true, clubDispatchAfterTargetIdentity true, all previous true
node outputs/lk1-train-g1-20261005/tools/compose-g1-revert.mjs <g1 candidate> /tmp/lk1-final
  → candidate 0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f
    (keeps G1 func 7f1539bf…; only initialize 283f9e8a… → 2c2c0c89…)
node outputs/lk1-train-g1-20261005/tools/compose-g2.mjs <g1 candidate> /tmp/lk1-final
  → candidate 0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192
    3 changed nodes; evaluator/preview evaluate e876ba07…; preview router 0f2e528d… (re-derived, unchanged); helperCount 94
node outputs/lk1-train-g1-20261005/tools/derive-all-pins.mjs <snapshot>
  → pin-derivation.json rewritten; g1 99b5d5b5…, g2 0f95fbd3…
node outputs/lk1-train-g1-20261005/tools/record-evidence.mjs <snapshot>
  → candidate-evidence.json rewritten; g1 99b5d5b5…, revert 0e74cd11…, g2 0f95fbd3…

npm run test:lk1-train-g1  → tests 7, pass 7, fail 0, skipped 0
  (the new test "the composed G1 club mandate resolves the co-pay and the dispatch proves a
   non-null station/room" executes the composed fragments: the F1 club binding resolves
   chargeMinor 150000 for the reviewed COURT_HOURLY_COPAY decision and refuses finalPriceMinor
   50000; the F2 dispatch prepares the master-service URL from the resolved station/room, the proof
   stores both, the second pass reaches `exercise` without a stop, and the pre-fix null-identity
   order still refuses LK1_COURT_PRICE_UNRESOLVED)
npm run test:lk1-train-g2  → tests 5, pass 5, fail 0, skipped 0
node --experimental-strip-types --test <every scripts/tests file whose name contains
  lk1|topokraty|patriots|subscription|planRules|proTraining|groupEventPayment|groupSubscriptionDiscount|
  tournamentSubscriptionDiscount|stationCourt>   (147 files)
  → tests 1685, pass 1470, fail 4, skipped 211
  → the 4 failures are exactly the known baseline: subscriptionBindingPatch (2),
    subscriptionReturnVerificationPatch (2); no new failure
git diff --check  → exit 0
npx eslint scripts/patch_live_lk1_train_g1_20261005.mjs
  scripts/patch_live_lk1_train_g2_20261005.mjs scripts/tests/lk1TrainG1Hotfix.test.mjs
  scripts/tests/lk1TrainG2Hotfix.test.mjs outputs/lk1-train-g1-20261005/tools/compose-g1-revert.mjs
  → exit 0
```

Raw broad-suite output saved to `outputs/lk1-train-g1-20261005/evidence/lk1-suite-run.txt`.

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
- **Stop method:** `nodered:lk1-train-g2:rollback-147` (G2 revert `0f95fbd3…` → `99b5d5b5…`), then
  `nodered:lk1-train-g1:rollback-147` (G1 plan-rules revert to `0e74cd11…`, global 10 → 9) and its
  snapshot-restore stage (`7e8a9570…`); no flag exists and none is needed — the generation is the
  control. Corrected order and rationale in `apply-plan.md`.

## 6. Residual risks and blockers

1. **BLOCKER — no executable apply path.** The four guarded wrapper scripts (G1 deploy/rollback, G2
   deploy/rollback) are not authored. `apply-plan.md` specifies their exact contract; they must be
   written and reviewed before a live apply.
2. **Review status.** The independent payment-safety review's two blocking findings (F1 money, F2
   control flow) and the F3/F5 plan gaps are fixed in §7. The remaining specialist-review item is the
   single **continuation deviation** of §3 (the `storeProof` call site re-anchors the reviewed writer
   from the HUB `profile` re-entry to this lineage's `exercise` re-entry); the reviewed fragment
   itself stays byte-identical (`1e8684b4…`, call site `b3342f91…`).
3. **Court-window write path is proven in-process, not in production.** The reviewed fragments have
   never run on 147 (the live body has no `lk1CourtMasterServices`). The new G1 test now executes the
   composed fragments end-to-end in-process (F1/F2, §7) instead of relying only on static markers and
   read-only previews, but no live 147 request has exercised the path; the plan's acceptance quotes
   remain read-only.
4. **Live Viva schema unconfirmed.** The event-path master-service price route
   (`studios/{stationId}/rooms/{roomId}/sub-services/{subServiceId}/price`) is taken from the split
   path; the response shape (`from`/`total`) has no fresh event-path pull.
5. **Allowance arithmetic** — the `courtMinutes` accumulator and the club-game 90-minute ceiling are
   `gateway.js` fragments from the HUB lineage applied to the focused usage block. The
   `AUDIT_BINDING` sub-branch differs from the reviewed ordering, so the day-bucket review is a
   distinct risk from §3.
6. **Ordering window (reviewer F4 — owner decision needed before a live apply).** Between G1 and G2
   the flow is restarted and the plan-rules global names `patriots` while the installed evaluator is
   still the pre-Patriots one, so out-of-scope Patriots events can be booked at 50 % instead of being
   refused during the window. G1/G2 are deliberately **not** changed for it. The apply plan records
   the two options — (a) quiesce the booking ingress for the two applies, or (b) reverse the order so
   the evaluator lands first — and marks it an owner decision.
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

## 7. Review-fix revision (2026-10-05): F1, F2, F3, F5, and F4 recorded

An independent payment-safety review reproduced G1 `fc4a46a6…` / G2 `24d263fd…` byte-for-byte and
found two blocking defects and two plan gaps. All four are fixed here; F4 is recorded, not changed.

### F1 (BLOCKING, money) — G1 now ships the reviewed club money mandate

*Defect:* `patchLk1TrainG1GatewayBody` only asserted that `lk1ClubEventPaymentBinding` was declared
once; it never replaced the installed body, which had no `COURT_HOURLY_COPAY` branch (0
occurrences). A `COURT_HOURLY_COPAY` decision (eligible, `subscriptionVisitCount` 1,
`finalPriceMinor` 150000) therefore resolved to `null` through
`lk1ClubEventPaymentBinding`/`lk1EventPaymentBinding`/`lk1EventPaymentQuoteBinding`; after
`booking_create → prepareConfirmedUpdate → operation_confirm → lk1Checkout`, the checkout stopped
`LK1_GROUP_PAYMENT_BINDING_INVALID`, the co-pay leg was never opened, the operation stayed CONFIRMED
with no checkout, and the co-pay was never collected (under-collection).

*Fix, `scripts/patch_live_lk1_train_g1_20261005.mjs`:*

| Line | Change |
| --- | --- |
| 59 | import `clubMoneyFragment` from `patch_live_lk1_topokraty_copay_hotfix.mjs` |
| 125 | new pin `LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256 = d2390769…` |
| 137–140 | anchors `CLUB_BINDING_START`, `CLUB_BINDING_END`, `CLUB_COPAY_ANCHOR`, `CLUB_COPAY_NEXT`, `QUOTE_RESOLVER_START` |
| 170–196 | `reviewedClubBinding()` / `reviewedClubCoPayBlock()` — the reviewed binding and branch, sha-verified against the reviewed payment source |
| 311 | `LK1_TRAIN_G1_PATCH_MARKERS.clubMoneyMandate = "COURT_HOURLY_COPAY"` (a body that already has the branch is refused, never double-spliced) |
| 418–419 | delta `club-copay`: insert the reviewed branch after `const percent = decision.eventDiscountPercent;` |
| 438–456 | shape check `COURT_HOURLY_COPAY` exactly once; quote resolver declared exactly once; the composed `lk1ClubEventPaymentBinding` must equal `reviewedClubBinding()` byte-for-byte |
| 563–566 | report marker `clubMoneyMandateBound` |

The resolver and the five call sites were already the reviewed ones in the installed body and are
**not** duplicated; only the missing branch is added. `patchLk1TrainG1GatewayBody` still refuses a
source that already contains `COURT_HOURLY_COPAY`.

### F2 (BLOCKING, control flow) — dispatch moved after the target identity

*Defect:* the court dispatch was inserted immediately after `ctx.lk1 = quote;`, before
`ctx.studioId = quote.target.stationId;`, and `ctx.roomId` was never assigned on this lineage (the
http ingress `lk_subscription_booking_prepare_20260804` sends neither). The pinned proof writer
(`gateway_hooks.js:259-296`) then stored a null station/room, so `startLk1CourtWindowFetch` always
refused `LK1_COURT_PRICE_UNRESOLVED` and the club training write path never reached pricing, while
the read-only preview quoted correctly.

*Fix, `scripts/patch_live_lk1_train_g1_20261005.mjs`:*

| Line | Change |
| --- | --- |
| 277 | `COURT_DISPATCH_ANCHOR` moved to `      ctx.studioId = quote.target.stationId;\n` |
| 279 | `LK1_TRAIN_G1_ROOM_ASSIGNMENT = "      ctx.roomId = quote.target.roomId;\n"` |
| 389–400 | the delta re-anchors after the station assignment and inserts `ctx.roomId = quote.target.roomId;` before `if (lk1CourtWindowNeeded(ctx))`; the reviewed dispatch fragment stays byte-identical (`bd02267f…`) |
| 458–466 | assertion that the target identity is assigned before the room, and the room before the dispatch guard |
| 567–569 | report marker `clubDispatchAfterTargetIdentity` |

`ctx.roomId` is written nowhere else in the body, so the assignment is additive. The composed body
diff vs the previous candidate is exactly the co-pay branch plus the moved dispatch block; no other
behaviour changes.

### F3 (plan defect) — corrected rollback order in `apply-plan.md`

The rollback section now states the only workable order when G2 was applied:
**G2-revert (`0f95fbd3…` → `99b5d5b5…`) → G1 plan-rules revert (candidate `0e74cd11…`, global
10 → 9) → preimage restore (`7e8a9570…`)**, and states explicitly that the G1-revert candidate keeps
G1's `func` and replaces only `initialize` (contract node sha `d4d84655…` → `ac01f156…`, field
`initialize`), so pre-G1 body bytes come only from the snapshot restore. Step references were
renumbered (Step 1 stop → R2/R3; Step 2 stop → R1).

### F5 (verification gap) — write-path and binding-level postchecks

`apply-plan.md` Step 1 postcheck now requires (3) `COURT_HOURLY_COPAY` present exactly once **inside
the extracted `lk1ClubEventPaymentBinding` body** — a whole-function grep is explicitly not
sufficient — with the resolver and its five call sites still exactly once, and (4) the dispatch order
plus the new execution test. Step 2 postcheck adds (4): the gateway `func` is still G1's postimage
`7f1539bf…` and still carries the Step 1 mandate/dispatch properties.

The new test lives in `scripts/tests/lk1TrainG1Hotfix.test.mjs` (last test): it composes G1 from the
read-only snapshot, extracts the composed court helpers/steps and the exactly-shipped dispatch
region, and executes them in-process. It proves: `startLk1CourtWindowFetch` builds the
master-service URL from the resolved station/room; `lk1CourtWindowStoreProof` stores non-null
`stationId`/`roomId`; the second pass reaches `exercise` with no stop; the pre-fix order (no resolved
identity) still refuses `LK1_COURT_PRICE_UNRESOLVED`; and the F1 club binding resolves
`chargeMinor = perHour × hours = 150000` for the reviewed shape while refusing a `finalPriceMinor`
the decision's own numbers cannot reproduce.

### F4 (recorded only, by instruction) — Patriots window

Between the two applies the plan-rules global names `patriots` while the evaluator is still the
pre-Patriots one, so out-of-scope Patriots events can be booked at 50 % instead of being refused.
G1/G2 are unchanged. `apply-plan.md` Step 1 records the two options — **(a)** quiesce the booking
ingress during the two applies, **(b)** reverse the order so the evaluator lands first — and marks it
an owner decision needed before a live apply.

### Pins old → new (F1/F2 re-derivation)

| Pin | Old | New |
| --- | --- | --- |
| `LK1_TRAIN_G1_TARGET.patchedFuncSha256` | `b39de6aa…` | `7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4` |
| `LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256` | `6d16a8ef…` | `d4d84655a24c6dd79c64501ff7359c4a56f86f88d28d80f60d9ccf61d022aea0` |
| `LK1_TRAIN_G1_POSTIMAGE_SHA256` (candidate) | `fc4a46a6…` | `99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3` |
| `LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256` | `a5a3149f…` | `0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f` |
| `LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256` | `2c2c0c89…` | `2c2c0c89…` (unchanged) |
| gateway `initialize` | `283f9e8a…` | `283f9e8a…` (unchanged) |
| allowance block | `2916f13c…` | `2916f13c…` (unchanged) |
| `LK1_TRAIN_G2_UPSTREAM_SHA256` | `fc4a46a6…` | `99b5d5b5…` |
| `LK1_TRAIN_G2_TARGET.gatewayFuncSha256` | `b39de6aa…` | `7f1539bf…` |
| `LK1_TRAIN_G2_TARGET.patchedPreviewRouterFuncSha256` | `0f2e528d…` | `0f2e528d…` (re-derived, unchanged) |
| `LK1_TRAIN_G2_POSTIMAGE_SHA256` (candidate) | `24d263fd…` | `0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192` |
| `LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256` | — (new) | `d239076989eca25526f0c51865c36e976baf6ed533add7485f6d782976a76d50` |

`LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256` and the G1/G2 candidate shas changed as a consequence of the
F1/F2 body fix; the reverted initialize and the G2 content-node postimages did not. Contract results
are in `evidence/{g1,g1-revert,g2}-contract.json`: all three candidates pass
`buildExactGraphContract` **and** `validateReviewedFlowContract`, `addedNodes = 0`,
`httpInputCount` 221, and the allow-lists are exactly the declared nodes/fields.
