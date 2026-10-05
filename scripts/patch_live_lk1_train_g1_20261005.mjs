#!/usr/bin/env node

// Focused generation G1 of the 2026-10-05 LK1 train for server 147.
//
// The live 147 flow pulled read-only on 2026-10-05
// (`7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1`, 4815 nodes) already carries
// the focused lineage: the club contour of «Дружба Топократы», the club money mandate, the
// rejection/reclaim generation, the nine-rule plan-rules writer (seven base rules + `topocraty` +
// `friendship_two_hours`) and the PRO-training discount. None of the existing focused generations
// composes on it (see `outputs/lk1-train-147-prep-20261005/composition-attempts.json`), so this
// generation re-anchors the missing reviewed deltas on the live bodies instead of re-pinning a
// patcher whose postimage no longer exists.
//
// G1 changes exactly two fields of one node (`lk_subscription_booking_router_20260804`):
//   1. `func` — the reviewed court-window proof of the 2026-10-05 co-pay decision (the
//      station→master-service table, the master-service price request, the whole-window proof and
//      `target.hourlyCourtPriceMinor`, with `LK1_COURT_PRICE_UNRESOLVED` as the only refusal), the
//      #174 club gate widened to `open_game` with the reviewed refusal text, the Patriots
//      money-only identity guard and the two allowance deltas the reviewed evaluator needs (the
//      club-game 90-minute free visit ceiling and the club-training `courtMinutes` accumulator);
//   2. `initialize` — the plan-rules writer is replaced by the guarded
//      `friendship_two_hours → patriots` transition (`"planKey":"patriots"`).
//
// Control-flow insert points (chosen here, documented for review; see
// `outputs/lk1-train-g1-20261005/REPORT.md`):
//   * court helpers + court steps: inserted before the unique `if (ctx.step === "lk1_operation_find") {`;
//   * court dispatch: inserted inside the `exercise` step right after the unique `ctx.lk1 = quote;`,
//     because that is the only point where the *raw* Viva exercise (local `timeFrom`/`timeTo`) is in
//     scope together with a resolved quote and `ctx.lk1TariffProof`; `ctx.lk1CourtExercise` is the
//     documented input of the reviewed `startLk1CourtWindowFetch`, and without it the reviewed
//     `lk1CourtWindowEndTime(proof)` derivation yields a null `timeTo` and the fetch would refuse
//     every club event. The suggested `if (ctx.step === "lk1_profile_continue") {` anchor is
//     reachable only before the quote exists, so it cannot carry the request.
//   * the reviewed steps fragment is embedded byte-identical; its `return lk1CourtWindowStoreProof(...)`
//     call site receives one explicit continuation delta (the reviewed writer asks for the HUB
//     `profile` re-entry, which this lineage does not have): the same invocation re-runs the
//     `exercise` step, which re-prices the club event from the completed window proof.
//
// Preparation only: nothing is deployed, imported, restarted or written to a global here, and the
// generation fails closed unless the preimage is exactly the reviewed 2026-10-05 snapshot.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import {
  LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS,
  LK1_PLAN_RULES_WITH_PATRIOTS,
  buildPatriotsPlanRulesRevert,
  buildPatriotsPlanRulesTransition,
} from "./lib/lk1PlanRulesTransition.mjs";
import {
  TOPOKRATY_COURT_DISPATCH_SHA256,
  TOPOKRATY_COURT_HELPERS_SHA256,
  TOPOKRATY_COURT_STEPS_SHA256,
  reviewedCourtFragments,
} from "./patch_live_lk1_topokraty_friendship_hotfix.mjs";
import { clubMoneyFragment } from "./patch_live_lk1_topokraty_copay_hotfix.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const LK1_TRAIN_G1_DEPLOYMENT_ID = "lk1-train-g1";
export const LK1_TRAIN_G1_KIND = "FOCUSED_LK1_TRAIN_G1_V1";

// The read-only 2026-10-05 preimage of lk-primary-147.
export const LK1_TRAIN_G1_UPSTREAM_SHA256 =
  "7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1";
export const LK1_TRAIN_G1_SOURCE_NODE_COUNT = 4815;

export const LK1_TRAIN_G1_GATEWAY_ID = "lk_subscription_booking_router_20260804";

export const LK1_TRAIN_G1_TARGET = Object.freeze({
  gatewayId: LK1_TRAIN_G1_GATEWAY_ID,
  liveFuncSha256: "21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2",
  liveInitializeSha256: "d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5",
  patchedFuncSha256: "7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4",
  patchedInitializeSha256: "283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3",
});

// The exact-graph node pins: the gateway node before and after G1 (the deploy wrapper's
// `prepare_exact_graph_contract.mjs` step compares them).
export const LK1_TRAIN_G1_PREIMAGE_NODE_SHA256 =
  "f3e1b807a13b1d404a8ecf5119c9cb03c63217f64986201c4e52440d4a0f107b";
export const LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256 =
  "d4d84655a24c6dd79c64501ff7359c4a56f86f88d28d80f60d9ccf61d022aea0";

// The composed postimage of G1; G2 stacks on it and the G1 rollback refuses any other applied flow.
export const LK1_TRAIN_G1_POSTIMAGE_SHA256 =
  "99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3";
// The ordered G1 rollback composes on that postimage and writes the installed nine-rule payload back.
export const LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256 =
  "0e74cd1179163db2d73d7a1726b96b41cdfb867d34434ba9a73260f398cd423f";
// The reverted initialize body and the installed nine-rule payload it writes back.
export const LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256 =
  "2c2c0c89e3562fff985c388d7bbd0f55f9deaf5cc002ae86974ce59f43c6caf1";

// Reviewed-source pins (working tree, not the live flow): every fragment G1 embeds is verified
// against the bytes this repository reviewed.
export const LK1_TRAIN_G1_REVIEWED_GATEWAY_SHA256 =
  "430dbb09b3df1379c1100a0af784720abfdb9687b89662999d982db4aedeef8a";
export const LK1_TRAIN_G1_REVIEWED_HOOKS_SHA256 =
  "2225ca5234313613e1e5ede2d767dcbfacddc03bb0976a45ae4a970c7bf9dfef";
export const LK1_TRAIN_G1_REVIEWED_COURT_HELPERS_SHA256 = TOPOKRATY_COURT_HELPERS_SHA256;
export const LK1_TRAIN_G1_REVIEWED_COURT_DISPATCH_SHA256 = TOPOKRATY_COURT_DISPATCH_SHA256;
export const LK1_TRAIN_G1_REVIEWED_COURT_STEPS_SHA256 = TOPOKRATY_COURT_STEPS_SHA256;
// The reviewed fragments of `gateway.js` / `gateway_hooks.js` this generation composes in.
export const LK1_TRAIN_G1_COURT_QUOTE_BLOCK_SHA256 =
  "bb0959709507c07d5a77123a4cbb18f9140b5f11ae200f3c7bee656854101ec9";
export const LK1_TRAIN_G1_USAGE_COURT_MINUTES_SHA256 =
  "5b179145ca50cd9e2f19422fe7e9e898027b9a419d88bf5a2efdba3008e9ed3a";
export const LK1_TRAIN_G1_USAGE_CLUB_FREE_SHA256 =
  "e363c97b76ec48d955673fb8bcba303bc7563b578d0e9e4f9674f1ab0de9387a";
export const LK1_TRAIN_G1_REVIEWED_CLUB_GATE_SHA256 =
  "520e3486922e735ff0d82cf5503ae39a18ad00068b6806069b26c9f5e30c5e1c";
export const LK1_TRAIN_G1_REVIEWED_PATRIOTS_GUARD_SHA256 =
  "9a417b05213e1fe3e891f2063aa69a14699854790016a1196ae18f97fafda8e2";
// The focused continuation block that replaces the reviewed writer's HUB `profile` re-entry.
export const LK1_TRAIN_G1_CONTINUATION_SHA256 =
  "b3342f91b20d64c7bdf6e9fc53e27ba8f40b5011088bf68364b6517cb3c02f9e";
// The reviewed club money mandate (the `COURT_HOURLY_COPAY` branch). The installed 2026-10-05 body
// already carries the rest of `lk1ClubEventPaymentBinding`, the quote resolver and the five call
// sites, so this branch is the only money-mandate delta the reviewed club contour was missing.
export const LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256 =
  "d239076989eca25526f0c51865c36e976baf6ed533add7485f6d782976a76d50";

export const LK1_TRAIN_G1_PATRIOTS_PRODUCT_ID = "37ab3713-4431-4815-96ba-d7ece76a9241";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// --- reviewed fragments -----------------------------------------------------

// The installed club money mandate shape and the reviewed `COURT_HOURLY_COPAY` branch inside it.
// Both are read out of the reviewed payment source through `clubMoneyFragment()`, so the G1 splice
// can only ever embed bytes this repository reviewed.
const CLUB_BINDING_START = "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {";
const CLUB_BINDING_END = "\n};\n";
const CLUB_COPAY_ANCHOR = "  const percent = decision.eventDiscountPercent;\n";
const CLUB_COPAY_NEXT =
  '  const share = decision.benefit?.kind === "PARTIAL_PRICE_PERCENT_DISCOUNT"\n';
const QUOTE_RESOLVER_START = "const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>";

function reviewedSource(relative, pin, label) {
  const source = fs.readFileSync(path.join(HERE, relative), "utf8");
  if (sha256(source) !== pin) {
    throw new Error(`Reviewed ${label} drift: ${sha256(source)} != ${pin}`);
  }
  return source;
}

function reviewedSlice(source, startMarker, endMarker, pin, label) {
  if (source.split(startMarker).length !== 2) {
    throw new Error(`Reviewed ${label} start anchor drift`);
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Reviewed ${label} end anchor drift`);
  const fragment = source.slice(start, end + endMarker.length);
  if (sha256(fragment) !== pin) {
    throw new Error(`Reviewed ${label} drift: ${sha256(fragment)} != ${pin}`);
  }
  return fragment;
}

const indent = (fragment, spaces) => fragment.split("\n")
  .map((line) => (line.trim() === "" ? line : `${" ".repeat(spaces)}${line}`)).join("\n");

/** The reviewed `lk1ClubEventPaymentBinding` definition, extracted verbatim from the money mandate. */
export function reviewedClubBinding() {
  const fragment = clubMoneyFragment();
  const start = fragment.indexOf(CLUB_BINDING_START);
  if (start < 0) throw new Error("Reviewed club money binding is absent");
  const end = fragment.indexOf(CLUB_BINDING_END, start + CLUB_BINDING_START.length);
  if (end < 0) throw new Error("Reviewed club money binding end is absent");
  return fragment.slice(start, end + CLUB_BINDING_END.length);
}

/**
 * The reviewed `COURT_HOURLY_COPAY` branch of the club money mandate. The installed 147 body
 * already carries the rest of the binding (and the quote resolver with its five call sites), so
 * this branch — and nothing else — is the missing money-mandate delta.
 */
export function reviewedClubCoPayBlock() {
  const binding = reviewedClubBinding();
  const start = binding.indexOf(CLUB_COPAY_ANCHOR);
  if (start < 0) throw new Error("Reviewed club co-pay anchor is absent");
  const end = binding.indexOf(CLUB_COPAY_NEXT, start + CLUB_COPAY_ANCHOR.length);
  if (end < 0) throw new Error("Reviewed club co-pay end anchor is absent");
  const block = binding.slice(start + CLUB_COPAY_ANCHOR.length, end);
  if (sha256(block) !== LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256) {
    throw new Error(`Reviewed club co-pay block drift: ${sha256(block)}`);
  }
  return block;
}

/** The reviewed fragments of `gateway.js` / `gateway_hooks.js` this generation composes in. */
export function reviewedTrainFragments() {
  const gateway = reviewedSource("nodered_lk1_hub_nodes/gateway.js",
    LK1_TRAIN_G1_REVIEWED_GATEWAY_SHA256, "gateway");
  const hooks = reviewedSource("nodered_lk1_hub_nodes/gateway_hooks.js",
    LK1_TRAIN_G1_REVIEWED_HOOKS_SHA256, "gateway hooks");
  const court = reviewedCourtFragments();
  return {
    courtHelpers: court.helpers,
    courtDispatch: court.dispatch,
    courtSteps: court.steps,
    courtQuoteBlock: reviewedSlice(gateway,
      "  // The club co-pay of «Дружба Топократы» is charged against the HOUR of court, never against",
      "\n  }\n", LK1_TRAIN_G1_COURT_QUOTE_BLOCK_SHA256, "court quote block"),
    usageCourtMinutes: reviewedSlice(gateway,
      "    // The club training records its free hour in its own reviewed field: the shared day bucket",
      "      used += courtMinutes.freeMinutes;\n    }\n", LK1_TRAIN_G1_USAGE_COURT_MINUTES_SHA256,
      "usage courtMinutes"),
    usageClubFree: reviewedSlice(gateway,
      "          // The club game of «Дружба Топократы» carries a game of up to 90 minutes with one",
      "free > freeCeiling\n", LK1_TRAIN_G1_USAGE_CLUB_FREE_SHA256, "usage club free visit"),
    clubGate: reviewedSlice(hooks,
      "// A Topokraty event is outside every non-club subscription. Viva scopes a sold plan to its",
      'code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",\n    });\n}',
      LK1_TRAIN_G1_REVIEWED_CLUB_GATE_SHA256, "club gate"),
    patriotsGuard: reviewedSlice(hooks,
      "// The product identity was confirmed by the server before this exercise read.",
      "&& identityBound(ctx);\n", LK1_TRAIN_G1_REVIEWED_PATRIOTS_GUARD_SHA256, "Patriots guard"),
  };
}

// --- live-body anchors and deltas -------------------------------------------

// The installed Topokraty gate (#174 expands it to `open_game` with the reviewed refusal text).
const LIVE_CLUB_GATE = `  // A Topokraty event is outside every non-club subscription. Viva scopes a sold plan to its
  // own directions and exercise types, so carrying «РА», «Академия» or «Дружба» to direction
  // 6180/6233 is refused by the provider with 400 BAD_REQUEST after the contour has already
  // promised the benefit. The club product «Дружба Топократы» keeps its own plan rule (the
  // quarter-of-court co-pay) and is therefore the only owned row allowed here; every other
  // attempt is refused before the write and the event stays bookable as a one-off.
  if (resolveCategory(exercise) === "group_training"
    && isTopokratyExercise(exercise)
    && !(selectedOwned.length === 1 && isTopokratyClubPack(selectedOwned[0]))) {
    return finishError(ctx, 409,
      "На тренировки Топократов общие подписки не действуют: доступна разовая оплата или клубная подписка «Дружба Топократы»", {
        code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
      });
  }
`;

const PATRIOTS_EARLY_GUARD_ANCHOR =
  "  const enforcedRule = selectedRule.matched && !selectedRule.legacy;\n";
const PATRIOTS_DETOUR_OLD =
  '    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"\n'
  + "    && (selectedOwned.length === 0 || enforcedRule)) {";
const PATRIOTS_DETOUR_NEW =
  '    && (patriotsMoneyOnlyIdentity || ruleConfigured) && ctx.lk1MoneyReadbackPhase !== "exercise"\n'
  + "    && (patriotsMoneyOnlyIdentity || selectedOwned.length === 0 || enforcedRule)) {";

const COURT_QUOTE_ANCHOR =
  '  target.basePriceMinor = proof.amountMinor;\n  if (proof.kind === "EVENT_ONE_TIME") target.priceProductId = proof.productId;\n';

const USAGE_GAME_MINUTES_BLOCK = `    const minutes = operation.lk1.decision.gameMinutes;
    if (minutes) {
      if (minutes.localDate !== ctx.serviceDate || !Number.isSafeInteger(minutes.freeMinutes)
        || minutes.freeMinutes < 0) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      used += minutes.freeMinutes;
    }
`;

const USAGE_CLUB_FREE_ANCHOR =
  "          if (!Number.isSafeInteger(free) || free !== duration || free > ctx.lk1.rule.freeGameMinutesPerDay\n";

const COURT_STEPS_ANCHOR = 'if (ctx.step === "lk1_operation_find") {';
// The court dispatch runs after the target's station AND room are assigned: the reviewed
// `startLk1CourtWindowFetch` binds both into the master-service URL and into the stored proof
// (`gateway_hooks.js:259-296`), and the http ingress sends neither, so dispatching right after
// `ctx.lk1 = quote;` would write a null station/room proof and refuse every club request with
// `LK1_COURT_PRICE_UNRESOLVED`. `ctx.roomId` is written nowhere else in this body, so the added
// assignment is additive.
const COURT_DISPATCH_ANCHOR = "      ctx.studioId = quote.target.stationId;\n";
// The room the reviewed proof binds, assigned from the same server-resolved target as the station.
export const LK1_TRAIN_G1_ROOM_ASSIGNMENT = "      ctx.roomId = quote.target.roomId;\n";
const COURT_DISPATCH_GUARD = "      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;\n";

// The single continuation delta of the reviewed court-window writer. The reviewed fragment asks for
// the HUB `profile` re-entry, which this focused lineage does not have: the profile handler would
// treat the price payload as a profile response and stop the request with a 502. The same invocation
// therefore continues into the `exercise` step, which re-prices the club event from the completed
// `lk1TariffProof.windowTotalMinor`.
const COURT_CONTINUATION_OLD = "  return lk1CourtWindowStoreProof(ctx, exercise, total);\n";
const COURT_CONTINUATION_NEW = `  const stored = lk1CourtWindowStoreProof(ctx, exercise, total);
  if (stored) return stored;
  // Focused-lineage continuation (G1 of the 2026-10-05 train): the reviewed writer records the
  // window and asks for the HUB \`profile\` re-entry, which this body does not have. Continue in the
  // same invocation into the \`exercise\` step, which re-prices the club event from the completed
  // window proof; \`lk1CourtWindowStoreProof\`'s own \`ctx.step = "profile"\` is overwritten here.
  ctx.step = "exercise";
  msg.payload = exercise;
`;

const PLAN_RULES_BLOCK_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_RULES_BLOCK_END = "const lk1StationExclusionsKey";
const PLAN_RULES_DESIRED_LITERAL = "const lk1DesiredPlanRules = ";

export const LK1_TRAIN_G1_PATCH_MARKERS = Object.freeze({
  courtHelpers: "const lk1CourtMasterServices = Object.freeze({",
  courtDispatch: "return startLk1CourtWindowFetch(ctx);",
  courtSteps: 'if (ctx.step === "lk1_court_window") {',
  courtQuote: "target.hourlyCourtPriceMinor = hourlyCourtPriceMinor;",
  clubGate: '["group_training", "open_game"].includes(resolveCategory(exercise))',
  patriotsGuard: "patriotsMoneyOnlyIdentity",
  courtMinutes: "operation.lk1.decision.courtMinutes",
  clubFreeCeiling: "const freeCeiling = clubFreeVisit ? duration : ctx.lk1.rule.freeGameMinutesPerDay;",
  clubMoneyMandate: "COURT_HOURLY_COPAY",
});

// --- helpers ----------------------------------------------------------------

function assertFunctionNode(node, id) {
  if (!node) throw new Error(`Node contract mismatch: ${id} is absent`);
  if (node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1
    || node.wires?.length !== node.outputs || typeof node.func !== "string"
    || typeof node.initialize !== "string") {
    throw new Error(`Node contract mismatch: ${id}`);
  }
  return node;
}

function assertFunctionBody(body, label) {
  try {
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    if (process.env.LK1_TRAIN_G1_DEBUG_BODY) {
      fs.writeFileSync(process.env.LK1_TRAIN_G1_DEBUG_BODY, body);
    }
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

function assertInitializeBody(body, label) {
  try {
    new Function("global", "env", "node", "flow", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED initialize body: ${error.message}`);
  }
}

function applyDeltas(source, deltas, label) {
  let patched = source;
  for (const delta of deltas) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  return patched;
}

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin === "PENDING_COMPOSITION") return;
  if (sha256(body) !== pin) throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
}

/** The shared allowance block of a booking gateway body: the price preview embeds a copy of it. */
export function usageBlockSha(body) {
  const start = body.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const end = body.indexOf('if (ctx.step === "lk1_policy_decision") {');
  if (start < 0 || end <= start) throw new Error("Usage block is absent from the gateway body");
  return sha256(body.slice(start, end));
}

/** The composed G1 gateway body: every reviewed delta re-anchored on the live 2026-10-05 body. */
export function patchLk1TrainG1GatewayBody(source, target = LK1_TRAIN_G1_TARGET) {
  const fragments = reviewedTrainFragments();
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  for (const [label, marker] of Object.entries(LK1_TRAIN_G1_PATCH_MARKERS)) {
    if (source.includes(marker)) throw new Error(`Booking gateway already carries the ${label} delta`);
  }
  // The reviewed court-window writer is embedded byte-identical; only its call site receives the
  // documented continuation delta.
  const courtSteps = applyDeltas(fragments.courtSteps,
    [{ id: "court-continuation", before: COURT_CONTINUATION_OLD, after: COURT_CONTINUATION_NEW }],
    "Court window continuation");
  if (sha256(COURT_CONTINUATION_NEW) !== LK1_TRAIN_G1_CONTINUATION_SHA256) {
    throw new Error(`Continuation block drift: ${sha256(COURT_CONTINUATION_NEW)}`);
  }
  const withCourt = applyDeltas(source, [
    { id: "court-steps", before: COURT_STEPS_ANCHOR,
      after: `${fragments.courtHelpers}\n${courtSteps}\n${COURT_STEPS_ANCHOR}` },
    { id: "court-dispatch",
      before: COURT_DISPATCH_ANCHOR,
      after: `      ctx.studioId = quote.target.stationId;
      // The club court-hourly co-pay proves its own hour of court for the raw event window: only the
      // exercise read carries the Viva-local \`timeFrom\`/\`timeTo\` the price request binds, and the
      // quote is already resolved here. The proof binds the target's station and room, so both are
      // assigned before the dispatch: a null station or room makes the fetch refuse with the
      // court-price code. \`lk1CourtWindowNeeded\` still gates every other event.
      ctx.roomId = quote.target.roomId;
      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;
${indent(fragments.courtDispatch, 6)}
      delete ctx.lk1CourtExercise;
` },
  ], "LK1 train G1 court window");
  const withQuote = applyDeltas(withCourt,
    [{ id: "court-quote", before: COURT_QUOTE_ANCHOR,
      after: COURT_QUOTE_ANCHOR + fragments.courtQuoteBlock }], "LK1 train G1 court quote");
  const withGate = applyDeltas(withQuote,
    [{ id: "club-gate", before: LIVE_CLUB_GATE, after: `${indent(fragments.clubGate, 2)}\n` }],
    "LK1 train G1 club gate");
  const withPatriots = applyDeltas(withGate, [
    { id: "patriots-guard", before: PATRIOTS_EARLY_GUARD_ANCHOR,
      after: PATRIOTS_EARLY_GUARD_ANCHOR + indent(fragments.patriotsGuard, 2) },
    { id: "patriots-detour", before: PATRIOTS_DETOUR_OLD, after: PATRIOTS_DETOUR_NEW },
  ], "LK1 train G1 Patriots guard");
  const withMoney = applyDeltas(withPatriots, [
    // The reviewed club money mandate: the installed body carries `lk1ClubEventPaymentBinding`
    // without the `COURT_HOURLY_COPAY` branch, so the branch (and only the branch) is spliced in
    // here. The binding then matches the reviewed definition byte-for-byte (asserted below).
    { id: "club-copay", before: CLUB_COPAY_ANCHOR,
      after: CLUB_COPAY_ANCHOR + reviewedClubCoPayBlock() },
  ], "LK1 train G1 club money mandate");
  const patched = applyDeltas(withMoney, [
    { id: "usage-court-minutes", before: USAGE_GAME_MINUTES_BLOCK,
      after: USAGE_GAME_MINUTES_BLOCK + fragments.usageCourtMinutes },
    { id: "usage-club-free", before: USAGE_CLUB_FREE_ANCHOR,
      after: fragments.usageClubFree },
  ], "LK1 train G1 allowance");
  // Shape checks: every embedded fragment must enter the body exactly once.
  for (const [label, marker, expected] of [
    ["court helpers", "const lk1CourtWindowNeeded = (ctx) => {", 2],
    ["court request", "function startLk1CourtWindowFetch(ctx) {", 2],
    ["court response", 'if (ctx.step === "lk1_court_window") {', 2],
    ["court dispatch", "return startLk1CourtWindowFetch(ctx);", 2],
    ["court quote", "target.hourlyCourtPriceMinor = hourlyCourtPriceMinor;", 2],
    ["club gate", '["group_training", "open_game"].includes(resolveCategory(exercise))', 2],
    ["Patriots guard", "const patriotsMoneyOnlyIdentity = ctx.caller === \"http\"", 2],
    ["court minutes", "operation.lk1.decision.courtMinutes", 2],
    ["club free ceiling", "const freeCeiling = clubFreeVisit ? duration : ctx.lk1.rule.freeGameMinutesPerDay;", 2],
    ["club money mandate", "COURT_HOURLY_COPAY", 2],
  ]) {
    if (patched.split(marker).length !== expected) {
      throw new Error(`The ${label} delta must enter the body exactly once`);
    }
  }
  if (patched.split(QUOTE_RESOLVER_START).length !== 2) {
    throw new Error("The installed quote resolver must stay declared exactly once");
  }
  if (patched.split(CLUB_BINDING_START).length !== 2) {
    throw new Error("The installed club money mandate must stay declared exactly once");
  }
  // The composed club binding must be the reviewed one byte-for-byte: the delivered money mandate
  // is the branch this generation splices, never a locally rewritten variant.
  const patchedClub = patched.slice(patched.indexOf(CLUB_BINDING_START));
  const patchedClubEnd = patchedClub.indexOf(CLUB_BINDING_END);
  if (patchedClubEnd < 0
    || patchedClub.slice(0, patchedClubEnd + CLUB_BINDING_END.length) !== reviewedClubBinding()) {
    throw new Error("The G1 club money mandate is not the reviewed binding");
  }
  // F2: the court dispatch must run after the target's station AND room are assigned, otherwise the
  // pinned proof writer stores a null station/room and `startLk1CourtWindowFetch` refuses every
  // club request with `LK1_COURT_PRICE_UNRESOLVED`.
  const targetIdentityAt = patched.indexOf(COURT_DISPATCH_ANCHOR);
  const roomAssignedAt = patched.indexOf(LK1_TRAIN_G1_ROOM_ASSIGNMENT);
  const dispatchGuardAt = patched.indexOf(COURT_DISPATCH_GUARD);
  if (!(targetIdentityAt >= 0 && targetIdentityAt < roomAssignedAt && roomAssignedAt < dispatchGuardAt)) {
    throw new Error("The court dispatch must run after the target station and room are assigned");
  }
  assertFunctionBody(patched, "Patched G1 booking gateway body");
  assertPostimage(patched, target.patchedFuncSha256, "G1 booking gateway");
  return patched;
}

/** The composed G1 initialize: the plan-rules writer becomes the guarded patriots transition. */
export function patchLk1TrainG1GatewayInitialize(source, target = LK1_TRAIN_G1_TARGET) {
  if (sha256(source) !== target.liveInitializeSha256) {
    throw new Error(`Gateway initialize installed preimage drift: ${sha256(source)} != ${target.liveInitializeSha256}`);
  }
  if (source.includes('"planKey":"patriots"')) {
    throw new Error("Gateway initialize already carries the Patriots plan rule");
  }
  const start = source.indexOf(PLAN_RULES_BLOCK_START);
  const end = source.indexOf(PLAN_RULES_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) throw new Error("Gateway initialize plan-rules block drift");
  const block = source.slice(start, end);
  if (block.split(PLAN_RULES_BLOCK_START).length !== 2) {
    throw new Error("Gateway initialize plan-rules block is not unique");
  }
  const desiredIndex = block.indexOf(PLAN_RULES_DESIRED_LITERAL);
  if (desiredIndex < 0) throw new Error("Gateway initialize plan-rules payload anchor is absent");
  const installedDesired = JSON.parse(block.slice(desiredIndex + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(installedDesired) !== JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS)) {
    throw new Error("Gateway initialize installed plan-rules payload is not the reviewed nine-rule prior");
  }
  const transition = buildPatriotsPlanRulesTransition();
  const patched = `${source.slice(0, start)}${transition.initialize}${source.slice(end)}`;
  if (patched.split('"planKey":"patriots"').length !== 2) {
    throw new Error("The Patriots plan rule must enter the initialize exactly once");
  }
  if (patched.split(PLAN_RULES_BLOCK_START).length !== 2) {
    throw new Error("The plan-rules writer must be replaced exactly once");
  }
  assertInitializeBody(patched, "Patched G1 gateway initialize body");
  assertPostimage(patched, target.patchedInitializeSha256, "G1 gateway initialize");
  return patched;
}

/** Composes the G1 candidate; fails closed on any preimage, shape, parse, postimage or graph drift. */
export function composeLk1TrainG1Artifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? LK1_TRAIN_G1_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow is not a node array");
  if (flow.length !== LK1_TRAIN_G1_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${LK1_TRAIN_G1_SOURCE_NODE_COUNT}`);
  }
  const gateway = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G1_GATEWAY_ID),
    LK1_TRAIN_G1_GATEWAY_ID);
  const gatewayShape = JSON.parse(JSON.stringify({ ...gateway, func: null, initialize: null }));
  const beforeFunc = sha256(gateway.func);
  const beforeInitialize = sha256(gateway.initialize);
  const usageBlockBeforeSha256 = usageBlockSha(gateway.func);
  const target = options.assertPostimages === false
    ? { ...LK1_TRAIN_G1_TARGET, patchedFuncSha256: "PENDING_COMPOSITION",
      patchedInitializeSha256: "PENDING_COMPOSITION" }
    : LK1_TRAIN_G1_TARGET;
  gateway.func = patchLk1TrainG1GatewayBody(gateway.func, target);
  gateway.initialize = patchLk1TrainG1GatewayInitialize(gateway.initialize, target);
  if (JSON.stringify({ ...gateway, func: null, initialize: null }) !== JSON.stringify(gatewayShape)) {
    throw new Error("The G1 gateway changed a field other than func/initialize");
  }
  const changes = [
    { id: LK1_TRAIN_G1_GATEWAY_ID, fields: ["func", "initialize"],
      func: { beforeSha256: beforeFunc, afterSha256: sha256(gateway.func) },
      initialize: { beforeSha256: beforeInitialize, afterSha256: sha256(gateway.initialize) } },
  ];
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: LK1_TRAIN_G1_DEPLOYMENT_ID,
    allowedChanges: changes.map((row) => ({ id: row.id, fields: [...row.fields] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    gateway: {
      id: LK1_TRAIN_G1_GATEWAY_ID,
      courtHelpersBound: gateway.func.split("const lk1CourtMasterServices = Object.freeze({").length === 2,
      courtDispatchBound: gateway.func.split("return startLk1CourtWindowFetch(ctx);").length === 2,
      courtResponseBound: gateway.func.split('if (ctx.step === "lk1_court_window") {').length === 2,
      courtQuoteBound: gateway.func.includes(LK1_TRAIN_G1_PATCH_MARKERS.courtQuote),
      clubGateOpenGame: gateway.func.includes(LK1_TRAIN_G1_PATCH_MARKERS.clubGate)
        && gateway.func.includes("На занятия Топократов общие подписки не действуют"),
      patriotsMoneyOnlyIdentity: gateway.func.includes("patriotsMoneyOnlyIdentity"),
      patriotsPlanRule: gateway.initialize.includes('"planKey":"patriots"')
        && gateway.initialize.split('"planKey":"patriots"').length === 2,
      courtMinutesAccumulated: gateway.func.includes("operation.lk1.decision.courtMinutes"),
      clubFreeCeiling: gateway.func.includes(LK1_TRAIN_G1_PATCH_MARKERS.clubFreeCeiling),
      // F1: the composed club binding carries the reviewed `COURT_HOURLY_COPAY` branch inside
      // `lk1ClubEventPaymentBinding`, and the delivered definition is the reviewed one.
      clubMoneyMandateBound: gateway.func.split("COURT_HOURLY_COPAY").length === 2
        && reviewedClubBinding() !== ""
        && gateway.func.slice(gateway.func.indexOf(CLUB_BINDING_START))
          .startsWith(reviewedClubBinding()),
      clubDispatchAfterTargetIdentity:
        gateway.func.split(`${COURT_DISPATCH_ANCHOR}      // The club court-hourly co-pay`).length === 2
        && gateway.func.split(`${LK1_TRAIN_G1_ROOM_ASSIGNMENT}${COURT_DISPATCH_GUARD}`).length === 2,
      usageBlockSha256: usageBlockSha(gateway.func),
      usageBlockBeforeSha256,
    },
  };
}

// --- ordered rollback -------------------------------------------------------

/**
 * The ordered rollback of G1: the plan-rules global goes back to the installed nine-rule payload
 * FIRST, and only then is the preimage flow restored. The reverse order would leave the writer
 * naming the Patriots product while the restored gateway has no Patriots money guard.
 *
 * The revert candidate keeps the G1 bodies and replaces only the plan-rules writer with the guarded
 * `patriots -> friendship_two_hours` block.
 */
export function patchLk1TrainG1InitializeRevert(source) {
  if (sha256(source) !== LK1_TRAIN_G1_TARGET.patchedInitializeSha256) {
    throw new Error(`G1 initialize revert preimage drift: ${sha256(source)}`);
  }
  const start = source.indexOf(PLAN_RULES_BLOCK_START);
  const end = source.indexOf(PLAN_RULES_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) throw new Error("G1 initialize plan-rules block drift");
  const block = source.slice(start, end);
  const desiredIndex = block.indexOf(PLAN_RULES_DESIRED_LITERAL);
  if (desiredIndex < 0) throw new Error("G1 initialize plan-rules payload anchor is absent");
  const installedDesired = JSON.parse(block.slice(desiredIndex + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(installedDesired) !== JSON.stringify(LK1_PLAN_RULES_WITH_PATRIOTS)) {
    throw new Error("G1 initialize does not carry the Patriots plan-rules payload");
  }
  const revert = buildPatriotsPlanRulesRevert();
  const patched = `${source.slice(0, start)}${revert.initialize}${source.slice(end)}`;
  const patchedStart = patched.indexOf(PLAN_RULES_BLOCK_START);
  const patchedEnd = patched.indexOf(PLAN_RULES_BLOCK_END);
  const patchedBlock = patched.slice(patchedStart, patchedEnd);
  const revertDesired = JSON.parse(patchedBlock
    .slice(patchedBlock.indexOf(PLAN_RULES_DESIRED_LITERAL) + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(revertDesired) !== JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS)) {
    throw new Error("The revert writer must restore the installed nine-rule payload");
  }
  assertInitializeBody(patched, "Reverted G1 gateway initialize body");
  return patched;
}

/** Composes the G1 revert candidate: the G1 postimage with only the plan-rules writer reverted. */
export function composeLk1TrainG1RevertArtifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== LK1_TRAIN_G1_POSTIMAGE_SHA256) {
    throw new Error(`G1 applied flow preimage drift: ${sourceSha256} != ${LK1_TRAIN_G1_POSTIMAGE_SHA256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  const gateway = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G1_GATEWAY_ID),
    LK1_TRAIN_G1_GATEWAY_ID);
  const before = sha256(gateway.initialize);
  gateway.initialize = patchLk1TrainG1InitializeRevert(gateway.initialize);
  const changes = [
    { id: LK1_TRAIN_G1_GATEWAY_ID, fields: ["initialize"],
      initialize: { beforeSha256: before, afterSha256: sha256(gateway.initialize) } },
  ];
  if (sha256(gateway.initialize) !== LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256) {
    throw new Error(`G1 reverted initialize drift: ${sha256(gateway.initialize)}`);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: `${LK1_TRAIN_G1_DEPLOYMENT_ID}-revert`,
    allowedChanges: changes.map((row) => ({ id: row.id, fields: [...row.fields] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  const candidateSha256 = sha256(candidateBytes);
  if (options.assertPostimages !== false && candidateSha256 !== LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256) {
    throw new Error(`G1 revert candidate drift: ${candidateSha256} != ${LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256}`);
  }
  return { flow, candidateBytes, contract, changes, sourceSha256, candidateSha256 };
}

// --- reports ----------------------------------------------------------------

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildLk1TrainG1Report({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: LK1_TRAIN_G1_KIND, deploymentId: LK1_TRAIN_G1_DEPLOYMENT_ID,
    targets: { gateway: { id: LK1_TRAIN_G1_GATEWAY_ID,
      func: { beforeSha256: LK1_TRAIN_G1_TARGET.liveFuncSha256,
        afterSha256: built.changes[0].func.afterSha256 },
      initialize: { beforeSha256: LK1_TRAIN_G1_TARGET.liveInitializeSha256,
        afterSha256: built.changes[0].initialize.afterSha256 } } },
    upstreamFlowSha256: LK1_TRAIN_G1_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 1, addedNodeCount: 0,
    changes: built.changes, gateway: built.gateway,
    planRulesActivation: { key: "subscriptions_lk1_plan_rules",
      expectedPriorRuleCount: LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.length,
      desiredRuleCount: LK1_PLAN_RULES_WITH_PATRIOTS.rules.length,
      patriotsProductId: LK1_TRAIN_G1_PATRIOTS_PRODUCT_ID, writerReplaced: true },
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
}

/** The ordered-rollback report the guarded wrapper validates. */
export function buildLk1TrainG1RevertReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: LK1_TRAIN_G1_KIND, deploymentId: LK1_TRAIN_G1_DEPLOYMENT_ID,
    mode: "revert",
    targets: { gateway: { id: LK1_TRAIN_G1_GATEWAY_ID,
      initialize: { beforeSha256: built.changes[0].initialize.beforeSha256,
        afterSha256: built.changes[0].initialize.afterSha256 } } },
    upstreamFlowSha256: LK1_TRAIN_G1_POSTIMAGE_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 1, addedNodeCount: 0,
    changes: built.changes,
    planRulesActivation: { key: "subscriptions_lk1_plan_rules",
      expectedPriorRuleCount: LK1_PLAN_RULES_WITH_PATRIOTS.rules.length,
      desiredRuleCount: LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.length,
      patriotsProductId: LK1_TRAIN_G1_PATRIOTS_PRODUCT_ID, writerReplaced: true, orderedRollbackStep: 1 },
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
}

// --- CLI --------------------------------------------------------------------

function fail(message) { console.error(message); process.exitCode = 1; }

function prepareTargets(workspace, requested) {
  const canonical = (value) => {
    if (!path.isAbsolute(value)) throw new Error("Output paths must be absolute");
    if (path.resolve(value) !== value) throw new Error("Output paths must be canonical");
    if (fs.existsSync(value)) throw new Error(`Refusing to overwrite output: ${value}`);
    if (value === workspace || value.startsWith(`${workspace}${path.sep}`)) {
      throw new Error("Outputs must stay outside the live workspace");
    }
    return value;
  };
  return requested.map(canonical);
}

function main(args) {
  const usage = "Usage: --mode <generation|revert> --workspace <fresh-live-workspace> "
    + "--output <candidate.json> --report <report.json>";
  const values = {};
  let mode = "generation";
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--mode") {
      mode = String(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail(usage); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
    index += 1;
  }
  if (Object.keys(values).length !== 3 || !["generation", "revert"].includes(mode)) { fail(usage); return; }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = mode === "revert"
    ? composeLk1TrainG1RevertArtifacts(liveBytes)
    : composeLk1TrainG1Artifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = mode === "revert"
    ? buildLk1TrainG1RevertReport({ sourceSha256: verified.sourceSha256,
      sourceNodeCount: verified.nodeCount, built })
    : buildLk1TrainG1Report({ sourceSha256: verified.sourceSha256,
      sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`LK1 train G1 generation failed: ${error.message}`);
  }
}
