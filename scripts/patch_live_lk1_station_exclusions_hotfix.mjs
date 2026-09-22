#!/usr/bin/env node

// Focused Node-RED generation: the Sirius club keeps the pre-rollout subscription path
// for the product it sells.
//
// Incident (2026-09-18): a client of the Sirius club («Сочи», studio
// 233c1405-1eac-40de-8ec6-1cf7e24c9276) could not book a tournament with the
// «Лето.Падел.Дружба» subscription without a 50 % co-pay. The club's page sells the same
// Viva product as the base friendship plan (`readSiriusFriendshipConfig` falls back to the
// friendship product id), and that product carries a plan rule with
// `enforceFrom = 2026-09-01` and `tournamentDiscountPercent = 50`, so every September sale
// from the club fell into the managed contour, while rule 7 of the rollout contract and the
// club's own plan card («участие в турнирах ПадлхАБ» — включено) keep it on the pre-rollout
// path, where the tournament is carried by a consumed visit and costs nothing.
//
// Owner decision (2026-09-18): exclude the pair «Sirius studio × friendship product» from
// the contour. The exclusion only ever DOWNGRADES a product a rule already covers: a
// product without a rule, another station, another product and the annual HUB are untouched
// (the HUB stays out on purpose — its legacy category list is empty, so excluding it would
// block its tournaments instead of making them free).
//
// This generation is applied to the *installed* flow (2026-09-18 pull, `a948f18b…`,
// 4804 nodes) and changes exactly three fields of two nodes:
//   1. `lk_subscription_booking_router_20260804.func` — the reviewed resolver module (the
//      station-exclusions normalizer, reader and verdict) plus the reviewed `lk1Config`
//      fragment, and the booking target's station at every contour decision the body makes:
//      the quote, the money-ownership gate, the checkout re-resolution, both ingress gates,
//      and the product-identity projection (which receives the readback exercise);
//   2. `lk_subscription_booking_router_20260804.initialize` — the reviewed
//      `subscriptions_lk1_station_exclusions` writer appended after the untouched HUB-policy
//      and plan-rules writers;
//   3. `lk_subscription_price_preview_20260908_router.func` — recomposed from the patched
//      generation so the preview and the write path resolve the same verdict.
//
// Preparation only: nothing is deployed, imported or restarted here, and the patcher fails
// closed unless the preimage is exactly the reviewed installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import {
  PLAN_RULES_GATEWAY_NODE_ID,
  PLAN_RULES_PREVIEW_NODE_ID,
  reviewedConfigFragment,
  reviewedPlanRulesModule,
} from "./patch_live_lk1_plan_rules.mjs";
import {
  LK1_STATION_EXCLUSIONS_DESIRED,
  buildStationExclusionsTransition,
} from "./lib/lk1StationExclusionsTransition.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const STATION_EXCLUSIONS_DEPLOYMENT_ID = "lk1-station-exclusions";
export const STATION_EXCLUSIONS_KIND = "FOCUSED_LK1_STATION_EXCLUSIONS_V1";

// Reviewed live flow: the read-only 2026-09-18 pull from lk-primary-147
// (`/root/.node-red/flows.json`, 4804 nodes, sha256 a948f18b…). The booking body is the
// post-`lk1-confirmed-replay-guard` generation (`3920bb21…`). A live change must never be
// absorbed silently: it requires a conscious re-review of every pin below.
export const STATION_EXCLUSIONS_SOURCE_SHA256 =
  "a948f18b8e85c4931d44cf4ecfe52354a19d0c003e8fa8526e9126abb4a2d1ca";
export const STATION_EXCLUSIONS_SOURCE_NODE_COUNT = 4804;
export const STATION_EXCLUSIONS_BOOKING_ID = PLAN_RULES_GATEWAY_NODE_ID;
export const STATION_EXCLUSIONS_PREVIEW_ID = PLAN_RULES_PREVIEW_NODE_ID;

export const STATION_EXCLUSIONS_TARGET = Object.freeze({
  bookingId: STATION_EXCLUSIONS_BOOKING_ID,
  liveBookingFuncSha256: "3920bb21323fd5023cd427b5e8a183f6a70909dafa88a6e39bfe02caf9076fe0",
  patchedBookingFuncSha256: "fc1ca544d6471e44306bf9451e5827b49aeee5c1e048855eaaf54432a49ba81d",
  liveBookingInitializeSha256: "40ead051782bf8409fe9423ad783ec4cb7a1c6ba78fe4aff6231d5d3e5690395",
  patchedBookingInitializeSha256: "f373346fc14ba52988c59269b803bb2297a39db24c81ae6d570ecaf6f5d7728a",
  previewId: STATION_EXCLUSIONS_PREVIEW_ID,
  livePreviewFuncSha256: "1bd8d443e483512c4817f8c6c4850ebd50fb314482c072a5d18db7ae11d66de4",
  patchedPreviewFuncSha256: "8785e231893961dd73fedbacac46dfaae138bc99ebbdd43511fc1bb31c30be10",
});

// The installed preview composition pins of this generation: the split/join bodies and the
// allowance block are the installed ones, never line C's reviewed preimage defaults.
export const STATION_EXCLUSIONS_PREVIEW_INSTALLED = Object.freeze({
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// The station the owner decision names, and the product the club sells. They travel in the
// writer payload, not as loose constants, so the resolver and the activation stay in step.
export const STATION_EXCLUSIONS_PAIR = Object.freeze(
  LK1_STATION_EXCLUSIONS_DESIRED.exclusions[0]);

// Every contour decision of the installed body, in source order. The `before` anchors exist
// exactly once in the reviewed installed body (`3920bb21…`), which is what `assertPreimage`
// proves before any of them is applied.
export const STATION_EXCLUSIONS_CALL_SITE_DELTAS = Object.freeze([
  { id: "quote-station",
    before: "  const configured = lk1Config(owned);\n",
    after: "  const configured = lk1Config(owned, exercise?.studio?.id || exercise?.studioId || null);\n" },
  { id: "money-gate-station",
    before: "  const configured = lk1Config(selected);\n",
    after: "  const configured = lk1Config(selected, exercise?.studio?.id || exercise?.studioId || null);\n" },
  { id: "checkout-station",
    before: "  const configured = lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }]);\n",
    after: "  const configured = lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }],\n"
      + "    ctx.lk1.target?.stationId || ctx.studioId || null);\n" },
  { id: "hooks-selected-station",
    before: "const selectedRule = lk1Config(selectedOwned);\n",
    after: "const selectedRule = lk1Config(selectedOwned, exercise?.studio?.id || exercise?.studioId || null);\n" },
  { id: "hooks-product-station",
    before: "const productRule = lk1Config(ownedSubscriptions);\n",
    after: "const productRule = lk1Config(ownedSubscriptions, exercise?.studio?.id || exercise?.studioId || null);\n" },
  { id: "projection-station",
    before: "  const configured = lk1Config(projected);\n",
    after: "  const configured = lk1Config(projected, exercise?.studio?.id || exercise?.studioId || null);\n" },
  { id: "projection-exercise",
    before: "const identityMoneyOwned = (ctx, rows) => {\n",
    after: "const identityMoneyOwned = (ctx, rows, exercise) => {\n" },
  { id: "projection-caller-exercise",
    before: "resolveCategory(exercise) === 'group_training') return identityMoneyOwned(ctx, rows);\n",
    after: "resolveCategory(exercise) === 'group_training') return identityMoneyOwned(ctx, rows, exercise);\n" },
]);

// The reviewed resolver module and the reviewed config fragment are spliced in wholesale: the
// embedded module is the single reviewed truth for the contour, and the fragment is the only
// place that hands the resolver the two readers.
const MODULE_ANCHOR = "// LK1 plan-rules resolver: the single source of truth";
const CONFIG_ANCHOR = "const lk1Config = (";
const STOP_ANCHOR = "\nconst lk1Stop";
const STATION_PATCH_MARKER = "function lk1ReadStationExclusions(";
const STATION_INITIALIZE_MARKER = 'const lk1StationExclusionsKey = "subscriptions_lk1_station_exclusions";';

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

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
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin.startsWith("__")) {
    throw new Error(`${label} postimage pin is not set`);
  }
  if (sha256(body) !== pin) {
    throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
  }
}

function replaceRegion(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0 || source.indexOf(startAnchor, start + 1) >= 0) {
    throw new Error(`${label} anchor drift: ${startAnchor.slice(0, 60)}`);
  }
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`${label} end anchor drift: ${endAnchor.slice(0, 40)}`);
  return source.slice(0, start) + replacement + source.slice(end);
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

// The reviewed booking body: the resolver module and the config fragment of this checkout,
// the station at every contour decision, and the readback exercise in the projection.
export function patchStationExclusionsBookingBody(source, target = STATION_EXCLUSIONS_TARGET) {
  if (source.includes(STATION_PATCH_MARKER)) {
    throw new Error("Booking gateway already carries the station-exclusions reader");
  }
  if (sha256(source) !== target.liveBookingFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveBookingFuncSha256}`);
  }
  let patched = replaceRegion(source, MODULE_ANCHOR, `\n${CONFIG_ANCHOR}`, reviewedPlanRulesModule(),
    "Embedded resolver module");
  patched = replaceRegion(patched, CONFIG_ANCHOR, STOP_ANCHOR, reviewedConfigFragment(),
    "Resolver config fragment");
  patched = applyDeltas(patched, STATION_EXCLUSIONS_CALL_SITE_DELTAS, "Booking gateway");
  for (const delta of STATION_EXCLUSIONS_CALL_SITE_DELTAS) {
    if (!patched.includes(delta.after)) throw new Error(`Patched booking gateway is missing: ${delta.id}`);
    if (patched.includes(delta.before)) throw new Error(`Patched booking gateway still carries: ${delta.id}`);
  }
  for (const marker of [STATION_PATCH_MARKER, "stationExclusions: lk1ReadStationExclusions() });",
    "const LK1_STATION_EXCLUSIONS_GLOBAL = "]) {
    if (!patched.includes(marker)) throw new Error(`Patched booking gateway is missing: ${marker}`);
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  assertPostimage(patched, target.patchedBookingFuncSha256, "Booking gateway");
  return patched;
}

// The reviewed gateway `initialize`: the untouched HUB-policy and plan-rules writers plus the
// reviewed station-exclusions writer.
export function patchStationExclusionsBookingInitialize(source, target = STATION_EXCLUSIONS_TARGET) {
  if (source.includes(STATION_INITIALIZE_MARKER)) {
    throw new Error("Booking gateway initialize already carries the station-exclusions writer");
  }
  if (sha256(source) !== target.liveBookingInitializeSha256) {
    throw new Error(`Booking gateway initialize preimage drift: ${sha256(source)} != ${target.liveBookingInitializeSha256}`);
  }
  const anchors = ['const lk1PolicyKey = "subscriptions_lk1_product_policy";',
    'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";',
    "global.set(lk1PlanRulesKey, lk1DesiredPlanRules);",
    "plan rules readback mismatch"];
  for (const anchor of anchors) {
    if (!source.includes(anchor)) throw new Error(`Live initialize is missing the reviewed writer anchor: ${anchor}`);
  }
  const transition = buildStationExclusionsTransition({
    expectedPrior: null,
    desired: LK1_STATION_EXCLUSIONS_DESIRED,
  });
  const patched = `${source}${source.endsWith("\n") ? "" : "\n"}${transition.initialize}`;
  for (const anchor of [...anchors, STATION_INITIALIZE_MARKER,
    "global.set(lk1StationExclusionsKey, lk1DesiredStationExclusions);",
    "station exclusions prior mismatch; no overwrite",
    "station exclusions readback mismatch"]) {
    if (!patched.includes(anchor)) throw new Error(`Patched initialize is missing: ${anchor}`);
  }
  assertPostimage(patched, target.patchedBookingInitializeSha256, "Booking gateway initialize");
  return patched;
}

export function composeStationExclusionsArtifacts(liveBytes, deploymentId,
  options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? STATION_EXCLUSIONS_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== STATION_EXCLUSIONS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${STATION_EXCLUSIONS_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === STATION_EXCLUSIONS_BOOKING_ID),
    STATION_EXCLUSIONS_BOOKING_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === STATION_EXCLUSIONS_PREVIEW_ID),
    STATION_EXCLUSIONS_PREVIEW_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === "lk_subscription_managed_policy_20260820"),
    "lk_subscription_managed_policy_20260820");
  const beforeBookingFunc = sha256(booking.func);
  const beforeBookingInitialize = sha256(booking.initialize);
  const beforePreviewFunc = sha256(preview.func);
  const previewShape = JSON.parse(JSON.stringify({ ...preview, func: null }));
  booking.func = patchStationExclusionsBookingBody(booking.func);
  booking.initialize = patchStationExclusionsBookingInitialize(booking.initialize);
  // The preview composes on the already patched generation: its booking pin is the patched
  // body, and the split/join/allowance pins are the installed ones.
  const composed = previewSources(flow, {
    pins: {
      booking: sha256(booking.func),
      evaluator: sha256(evaluator.func),
      pricing: options.pricingSha256 ?? STATION_EXCLUSIONS_PREVIEW_INSTALLED.splitFuncSha256,
      join: options.joinSha256 ?? STATION_EXCLUSIONS_PREVIEW_INSTALLED.joinFuncSha256,
    },
    installedUsageSha256: options.installedUsageSha256
      ?? STATION_EXCLUSIONS_PREVIEW_INSTALLED.allowanceBlockSha256,
  });
  preview.func = composed.router;
  if (JSON.stringify({ ...preview, func: null }) !== JSON.stringify(previewShape)) {
    throw new Error("Preview node changed a field other than func");
  }
  assertFunctionBody(booking.func, "Patched booking gateway body");
  assertFunctionBody(preview.func, "Composed preview body");
  assertPostimage(preview.func, STATION_EXCLUSIONS_TARGET.patchedPreviewFuncSha256, "Preview");

  const changes = [
    { id: STATION_EXCLUSIONS_BOOKING_ID, fields: ["func", "initialize"],
      func: { beforeSha256: beforeBookingFunc, afterSha256: sha256(booking.func) },
      initialize: { beforeSha256: beforeBookingInitialize, afterSha256: sha256(booking.initialize) } },
    { id: STATION_EXCLUSIONS_PREVIEW_ID, fields: ["func"],
      func: { beforeSha256: beforePreviewFunc, afterSha256: sha256(preview.func) } },
  ];
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: [...row.fields] }));
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  const stationCallSites = STATION_EXCLUSIONS_CALL_SITE_DELTAS
    .every((delta) => booking.func.includes(delta.after)
      && !booking.func.includes(`lk1Config(owned);`) && !booking.func.includes(`lk1Config(selected);`)
      && !booking.func.includes(`lk1Config(projected);`));
  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: {
      id: STATION_EXCLUSIONS_BOOKING_ID,
      stationCallSites,
      stationExclusionsBound: booking.func.includes(STATION_PATCH_MARKER)
        && booking.func.includes("stationExclusions: lk1ReadStationExclusions() });"),
      stationWriterBound: booking.initialize.includes(STATION_INITIALIZE_MARKER)
        && booking.initialize.includes(JSON.stringify(STATION_EXCLUSIONS_PAIR.stationId))
        && booking.initialize.includes(JSON.stringify(STATION_EXCLUSIONS_PAIR.productIds[0])),
      planRulesWriterKept: booking.initialize.includes("global.set(lk1PlanRulesKey, lk1DesiredPlanRules);"),
      hubPolicyWriterKept: booking.initialize.includes("global.set(lk1PolicyKey, lk1DesiredPolicy);"),
    },
    preview: {
      id: STATION_EXCLUSIONS_PREVIEW_ID,
      initializeUnchanged: preview.initialize === "",
      stationAware: preview.func.includes("previewRule(owned, ctx.target.stationId)")
        && preview.func.includes("canonical.lk1ReadStationExclusions"),
      helperCount: composed.helperNames.length,
    },
  };
}

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
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeStationExclusionsArtifacts(liveBytes, STATION_EXCLUSIONS_DEPLOYMENT_ID,
    { expectedSourceSha256: STATION_EXCLUSIONS_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: STATION_EXCLUSIONS_KIND, deploymentId: STATION_EXCLUSIONS_DEPLOYMENT_ID,
    targets: {
      booking: { id: STATION_EXCLUSIONS_BOOKING_ID,
        func: { beforeSha256: STATION_EXCLUSIONS_TARGET.liveBookingFuncSha256,
          afterSha256: STATION_EXCLUSIONS_TARGET.patchedBookingFuncSha256 },
        initialize: { beforeSha256: STATION_EXCLUSIONS_TARGET.liveBookingInitializeSha256,
          afterSha256: STATION_EXCLUSIONS_TARGET.patchedBookingInitializeSha256 } },
      preview: { id: STATION_EXCLUSIONS_PREVIEW_ID,
        func: { beforeSha256: STATION_EXCLUSIONS_TARGET.livePreviewFuncSha256,
          afterSha256: STATION_EXCLUSIONS_TARGET.patchedPreviewFuncSha256 } },
    },
    exclusionPair: STATION_EXCLUSIONS_PAIR,
    sourceSha256: verified.sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 2, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, preview: built.preview,
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { fail(error.message); }
}
