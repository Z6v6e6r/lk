#!/usr/bin/env node

// Focused Node-RED generation: the «Дружба 2 часа» plan of the club.
//
// One subscription product (`6b98e7e3-5bd3-4e94-9dc3-7723ea52513e`, 19 800 ₽ / 30 дней)
// carries one event a day — a game of 60/90/120 minutes or a «Время на друзей» session —
// six active bookings before the free minutes stop, and a 50 % discount on «игра + тренер»,
// group trainings, «Время на друзей» and ПадлхАБ tournaments without consuming a visit.
//
// The installed generation already writes the plan-rules global from the booking gateway's
// `initialize` with eight rules (including «Топократы»), so this release extends that exact
// block to nine and patches the five bodies of the same graph that must agree with it:
//
//   * `lk_subscription_booking_router_20260804.func` — the plan is recognised by its product
//     id and its name markers, shares the plan's single daily seat with «Дружба», and its
//     free first event of the day is scoped to direction 5278 («Время на друзей») so a
//     ПадлхАБ tournament of the same category never becomes a free day event.
//   * `lk_subscription_price_preview_20260908_router.func` — the preview carries its own copy
//     of the same tables; without the same patch the quote would not match the booking.
//   * `lk_subscription_managed_policy_20260820.func` — past the active-bookings cap the
//     covered day event stays a discount instead of a free event.
//   * `8fdc7076a0c436a2.func` / `c165e43eba668c25.func` — the status pair gains the plan's own
//     counter, whose readiness proves the installed rule instead of a price.
//
// The composer is deliberately NOT reused: its pins predate the installed bodies, so
// re-composing from the sources would inject the overlay a second time. This patcher instead
// splices reviewed deltas into the exact live bodies it pins, and every delta is paired with
// its inverse so the generation can be withdrawn without touching the provider.
//
// Nothing is deployed, imported or restarted here. The patcher fails closed unless the
// supplied preimage is exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  LK1_PLAN_RULES_WITH_TOPOKRATY,
  buildFriendshipTwoHoursPlanRulesTransition,
} from "./lib/lk1PlanRulesTransition.mjs";

export const FRIENDSHIP_TWO_HOURS_DEPLOYMENT_ID = "lk1-friendship-two-hours";
export const FRIENDSHIP_TWO_HOURS_KIND = "FOCUSED_LK1_FRIENDSHIP_TWO_HOURS_V1";
export const FRIENDSHIP_TWO_HOURS_PRODUCT_ID = "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e";
export const FRIENDSHIP_TWO_HOURS_FRIENDS_TIME_DIRECTION_ID = 5278;

// Reviewed live flow pulled from lk-primary-147 on 2026-09-30 (4804 nodes,
// sha256 845e0369…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const FRIENDSHIP_TWO_HOURS_SOURCE_SHA256 =
  "845e03694c10a14b966a47179ee01afd20d42e85bef61239b43550afaa550acd";
export const FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT = 4804;

export const FRIENDSHIP_TWO_HOURS_TARGETS = Object.freeze({
  gateway: Object.freeze({
    id: "lk_subscription_booking_router_20260804",
    liveFuncSha256: "e3b46e691517118cabbe259bb3831b99896b3f8a32202b437fa452d8349f17ee",
    liveInitializeSha256: "08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602",
  }),
  preview: Object.freeze({
    id: "lk_subscription_price_preview_20260908_router",
    liveFuncSha256: "7605df8c0f89c68cbf865b490e5437260c5b2cc8495cd2a5127ad04e09d30dab",
  }),
  evaluator: Object.freeze({
    id: "lk_subscription_managed_policy_20260820",
    liveFuncSha256: "443f2633e92f1aa4ce2f2df85b6e100a216a9cebcbc136a30c4c7a2ec8284a63",
  }),
  statusPrepare: Object.freeze({
    id: "8fdc7076a0c436a2",
    liveFuncSha256: "752ebf525a267ab86b9a9aa0c63dd8f5c7de6e023d34e21f0c2641d52cb5fcd2",
  }),
  statusResponse: Object.freeze({
    id: "c165e43eba668c25",
    liveFuncSha256: "cf4beffffedcd2fb8efaa2efff6564cdbf2d8417c9d71d9305d8533448c69d3d",
  }),
});

/** The status sources are installed bodies of the same repo files, so a swap is exact. */
const STATUS_SOURCE_PATHS = Object.freeze({
  statusPrepare: "nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
  statusResponse: "nodered_games_nodes/fn_tournament_subscription_status_response.js",
});

/** Deltas shared by the booking gateway and the price preview (identical table copies). */
export const PLAN_STORE_DELTAS = Object.freeze([
  { id: "plan-product-ids",
    before: `const PLAN_PRODUCT_IDS = {
  friendship: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",`,
    after: `const PLAN_PRODUCT_IDS = {
  // «Дружба 2 часа» is a separate Viva product with a rule of its own.
  friendship_two_hours: "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e",
  friendship: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",` },
  { id: "plan-name-markers",
    before: `  if (normalized.some((marker) => marker.includes("friendship") || marker.includes("дружба") || marker.includes("druzhba"))) return "friendship";`,
    after: `  if (normalized.some((marker) => marker.includes("friendshiptwohours") || marker.includes("дружба2часа"))) return "friendship_two_hours";
  if (normalized.some((marker) => marker.includes("friendship") || marker.includes("дружба") || marker.includes("druzhba"))) return "friendship";` },
  { id: "plan-categories",
    before: `const PLAN_CATEGORIES = {
  friendship: ["open_game", "tournament"],`,
    after: `const PLAN_CATEGORIES = {
  friendship: ["open_game", "tournament"],
  // One event a day, exactly like «Дружба»: a game of 60/90/120 minutes or a «Время на
  // друзей» event, so both categories consume that single daily seat.
  friendship_two_hours: ["open_game", "tournament"],` },
  { id: "free-first-event-cohort",
    before: `  "6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),
});`,
    after: `  "6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),
  // «Дружба 2 часа» (owner decision 2026-09-30): the day's covered event may also be a
  // «Время на друзей» session. Only that direction is covered, so the direction scope below
  // keeps a ПадлхАБ tournament of the same category on its plain discount.
  "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze(["tournament"]),
});
// A product listed here covers only the named directions of its categories; a product absent
// from this table keeps the whole category covered.
const LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES = Object.freeze({
  // «Время на друзей» of the club.
  "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze([5278]),
});
// The free-first-event verdict of one product: the category must be in the cohort table and,
// when the product also carries a direction scope, the event must be one of those directions.
// A harness without the tables simply has no covered cohort.
const lk1FreeFirstEventCovers = (productId, category, directionId) => {
  const products = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === "object" && LK1_FREE_FIRST_EVENT_PRODUCTS
    ? LK1_FREE_FIRST_EVENT_PRODUCTS : null;
  const scopes = typeof LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES === "object" && LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES
    ? LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES : null;
  if (!products || !category) return false;
  const categories = products[normalizeId(productId)] || null;
  if (!categories || !categories.includes(category)) return false;
  const scope = scopes ? scopes[normalizeId(productId)] || null : null;
  if (!Array.isArray(scope) || scope.length === 0) return true;
  return scope.includes(Number(directionId));
};` },
  { id: "free-first-event-coverage",
    before: `  const freeFirstProducts = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === "object" && LK1_FREE_FIRST_EVENT_PRODUCTS
    ? LK1_FREE_FIRST_EVENT_PRODUCTS : null;
  const freeFirstCategories = freeFirstProducts
    ? freeFirstProducts[normalizeId(ctx.lk1.rule.productId)] || null : null;
  const freeFirstCovered = Boolean(freeFirstCategories && freeFirstCategories.includes(ctx.category));`,
    after: `  // The target's own direction decides coverage for a direction-scoped product.
  const freeFirstCovered = lk1FreeFirstEventCovers(ctx.lk1.rule.productId, ctx.category,
    ctx.lk1.target?.directionId);` },
  { id: "free-first-event-reserved-operation",
    before: `    if (freeFirstCovered && freeFirstCategories.includes(lk1OperationCategory(operation))) {
      freeFirstEventsToday += 1;
    }`,
    after: `    if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId,
      lk1OperationCategory(operation), operation.lk1?.target?.directionId)) freeFirstEventsToday += 1;` },
  { id: "free-first-event-provider-booking",
    before: `    if (freeFirstCovered && freeFirstCategories.includes(category)) freeFirstEventsToday += 1;`,
    after: `    if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, category,
      exerciseDirectionId(booking.exercise || booking))) freeFirstEventsToday += 1;` },
]);

/** The evaluator keeps the discount past the cap instead of granting a free day event. */
export const EVALUATOR_DELTAS = Object.freeze([
  { id: "free-first-event-active-cap",
    before: `        freeFirstCovered = freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;`,
    after: `        freeFirstCovered = !aboveActiveLimit && freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;` },
]);

/** The reviewed plan-rules writer block of the installed generation. */
const PLAN_RULES_BLOCK_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_RULES_BLOCK_END = "const lk1StationExclusionsKey";
const PLAN_RULES_DESIRED_LITERAL = "const lk1DesiredPlanRules = ";

export const FRIENDSHIP_TWO_HOURS_MARKERS = Object.freeze({
  gateway: ["friendship_two_hours: \"6b98e7e3-5bd3-4e94-9dc3-7723ea52513e\"",
    "friendship_two_hours: [\"open_game\", \"tournament\"]",
    "const LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES = Object.freeze({",
    "const freeFirstCovered = lk1FreeFirstEventCovers("],
  evaluator: ["freeFirstCovered = !aboveActiveLimit && freeFirst.usedEventsToday === 0"],
  statusPrepare: ["friendship_two_hours"],
  statusResponse: ["friendship_two_hours"],
  initialize: ['"planKey":"friendship_two_hours"'],
});

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const snippet = (relativePath) => fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), relativePath), "utf8");

export function applyDeltas(source, deltas, label) {
  let out = source;
  for (const delta of deltas) {
    const occurrences = out.split(delta.before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences} occurrence(s)`);
    }
    if (out.includes(delta.after)) throw new Error(`${label} already carries ${delta.id}`);
    out = out.replace(delta.before, () => delta.after);
  }
  return out;
}

export function revertDeltas(source, deltas, label) {
  let out = source;
  for (const delta of [...deltas].reverse()) {
    const occurrences = out.split(delta.after).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${label} revert drift for ${delta.id}: ${occurrences} occurrence(s)`);
    }
    out = out.replace(delta.after, () => delta.before);
  }
  return out;
}

export function patchFriendshipTwoHoursPlanStoreBody(source, deltas = PLAN_STORE_DELTAS) {
  return applyDeltas(source, deltas, "Plan store body");
}

export function revertFriendshipTwoHoursPlanStoreBody(source, deltas = PLAN_STORE_DELTAS) {
  return revertDeltas(source, deltas, "Plan store body");
}

export function patchFriendshipTwoHoursEvaluatorBody(source, deltas = EVALUATOR_DELTAS) {
  return applyDeltas(source, deltas, "Evaluator body");
}

export function revertFriendshipTwoHoursEvaluatorBody(source, deltas = EVALUATOR_DELTAS) {
  return revertDeltas(source, deltas, "Evaluator body");
}

/** Replaces the installed plan-rules writer with the reviewed nine-rule generation. */
export function patchFriendshipTwoHoursInitialize(source, target = FRIENDSHIP_TWO_HOURS_TARGETS.gateway) {
  if (hash(source) !== target.liveInitializeSha256) {
    throw new Error(`Gateway initialize installed preimage drift: ${hash(source)} != ${target.liveInitializeSha256}`);
  }
  if (source.includes('"planKey":"friendship_two_hours"')) {
    throw new Error("Gateway initialize already carries the two-hour plan rule");
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
  const installedDesired = JSON.parse(block.slice(desiredIndex + PLAN_RULES_DESIRED_LITERAL.length).split(";\n")[0]);
  if (JSON.stringify(installedDesired) !== JSON.stringify(LK1_PLAN_RULES_WITH_TOPOKRATY)) {
    throw new Error("Gateway initialize installed plan-rules payload is not the reviewed prior");
  }
  const transition = buildFriendshipTwoHoursPlanRulesTransition();
  const patched = `${source.slice(0, start)}${transition.initialize}${source.slice(end)}`;
  if (patched.split('"planKey":"friendship_two_hours"').length !== 2) {
    throw new Error("The two-hour plan rule must enter the initialize exactly once");
  }
  if (patched.split(PLAN_RULES_BLOCK_START).length !== 2) {
    throw new Error("The plan-rules writer must be replaced exactly once");
  }
  return patched;
}

function assertFunctionNode(node, id, { initialize = false } = {}) {
  if (!node) throw new Error(`Node contract mismatch: ${id} is absent`);
  if (node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1
    || node.wires?.length !== node.outputs || typeof node.func !== "string"
    || (initialize && typeof node.initialize !== "string")) {
    throw new Error(`Node contract mismatch: ${id}`);
  }
  return node;
}

export function composeFriendshipTwoHoursArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? FRIENDSHIP_TWO_HOURS_SOURCE_SHA256;
  const sourceSha256 = hash(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT}`);
  }
  const targets = FRIENDSHIP_TWO_HOURS_TARGETS;
  const nodes = {
    gateway: assertFunctionNode(flow.find((node) => node.id === targets.gateway.id), targets.gateway.id,
      { initialize: true }),
    preview: assertFunctionNode(flow.find((node) => node.id === targets.preview.id), targets.preview.id),
    evaluator: assertFunctionNode(flow.find((node) => node.id === targets.evaluator.id), targets.evaluator.id),
    statusPrepare: assertFunctionNode(flow.find((node) => node.id === targets.statusPrepare.id), targets.statusPrepare.id),
    statusResponse: assertFunctionNode(flow.find((node) => node.id === targets.statusResponse.id), targets.statusResponse.id),
  };
  for (const key of Object.keys(nodes)) {
    if (hash(nodes[key].func) !== targets[key].liveFuncSha256) {
      throw new Error(`${key} installed preimage drift: ${hash(nodes[key].func)} != ${targets[key].liveFuncSha256}`);
    }
  }
  const before = Object.fromEntries(Object.entries(nodes)
    .map(([key, node]) => [key, JSON.parse(JSON.stringify({ ...node, func: null, initialize: null }))]));
  // The installed bodies, kept for the revert round-trip after the nodes are mutated.
  const installed = Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, node.func]));

  const patched = {
    gatewayFunc: patchFriendshipTwoHoursPlanStoreBody(nodes.gateway.func),
    gatewayInitialize: patchFriendshipTwoHoursInitialize(nodes.gateway.initialize),
    previewFunc: patchFriendshipTwoHoursPlanStoreBody(nodes.preview.func),
    evaluatorFunc: patchFriendshipTwoHoursEvaluatorBody(nodes.evaluator.func),
    statusPrepareFunc: snippet(STATUS_SOURCE_PATHS.statusPrepare),
    statusResponseFunc: snippet(STATUS_SOURCE_PATHS.statusResponse),
  };
  nodes.gateway.func = patched.gatewayFunc;
  nodes.gateway.initialize = patched.gatewayInitialize;
  nodes.preview.func = patched.previewFunc;
  nodes.evaluator.func = patched.evaluatorFunc;
  nodes.statusPrepare.func = patched.statusPrepareFunc;
  nodes.statusResponse.func = patched.statusResponseFunc;

  for (const [key, node] of Object.entries(nodes)) {
    if (JSON.stringify({ ...node, func: null, initialize: null }) !== JSON.stringify(before[key])) {
      throw new Error(`${key} changed a field other than func/initialize`);
    }
  }
  // The reviewed deltas must be reversible byte-for-byte on the exact bodies they patched.
  for (const [key, deltas, revert] of [
    ["gateway", PLAN_STORE_DELTAS, revertFriendshipTwoHoursPlanStoreBody],
    ["preview", PLAN_STORE_DELTAS, revertFriendshipTwoHoursPlanStoreBody],
    ["evaluator", EVALUATOR_DELTAS, revertFriendshipTwoHoursEvaluatorBody],
  ]) {
    const source = installed[key];
    const roundTrip = revert(applyDeltas(source, deltas, key));
    if (roundTrip !== source) throw new Error(`${key} revert is not an exact inverse`);
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [
    { id: targets.gateway.id, fields: ["func", "initialize"],
      func: { beforeSha256: targets.gateway.liveFuncSha256, afterSha256: hash(patched.gatewayFunc) },
      initialize: { beforeSha256: targets.gateway.liveInitializeSha256, afterSha256: hash(patched.gatewayInitialize) } },
    { id: targets.preview.id, fields: ["func"],
      func: { beforeSha256: targets.preview.liveFuncSha256, afterSha256: hash(patched.previewFunc) } },
    { id: targets.evaluator.id, fields: ["func"],
      func: { beforeSha256: targets.evaluator.liveFuncSha256, afterSha256: hash(patched.evaluatorFunc) } },
    { id: targets.statusPrepare.id, fields: ["func"],
      func: { beforeSha256: targets.statusPrepare.liveFuncSha256, afterSha256: hash(patched.statusPrepareFunc) } },
    { id: targets.statusResponse.id, fields: ["func"],
      func: { beforeSha256: targets.statusResponse.liveFuncSha256, afterSha256: hash(patched.statusResponseFunc) } },
  ];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: changes.map((change) => ({ id: change.id, fields: change.fields })),
    allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: hash(candidateBytes),
    preview: {
      gatewayPlanStore: FRIENDSHIP_TWO_HOURS_MARKERS.gateway.every((marker) => patched.gatewayFunc.includes(marker)),
      evaluatorCap: FRIENDSHIP_TWO_HOURS_MARKERS.evaluator.every((marker) => patched.evaluatorFunc.includes(marker)),
      planRulesWritten: FRIENDSHIP_TWO_HOURS_MARKERS.initialize
        .every((marker) => patched.gatewayInitialize.includes(marker)),
      statusCounter: FRIENDSHIP_TWO_HOURS_MARKERS.statusPrepare.every((marker) => patched.statusPrepareFunc.includes(marker))
        && FRIENDSHIP_TWO_HOURS_MARKERS.statusResponse.every((marker) => patched.statusResponseFunc.includes(marker)),
      otherFieldsUnchanged: true,
      revertible: true,
    },
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

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
    const key = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
      return;
    }
    if (values[key] !== undefined) {
      fail(`Duplicate argument: ${key}`);
      return;
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
    return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeFriendshipTwoHoursArtifacts(liveBytes, FRIENDSHIP_TWO_HOURS_DEPLOYMENT_ID, {
    expectedSourceSha256: FRIENDSHIP_TWO_HOURS_SOURCE_SHA256,
  });
  if (hash(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: FRIENDSHIP_TWO_HOURS_KIND,
    deploymentId: FRIENDSHIP_TWO_HOURS_DEPLOYMENT_ID,
    targets: Object.fromEntries(Object.entries(FRIENDSHIP_TWO_HOURS_TARGETS)
      .map(([key, target]) => [key, { id: target.id, func: { beforeSha256: target.liveFuncSha256 } }])),
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 5,
    addedNodeCount: built.addedNodeCount,
    changes: built.changes,
    preview: built.preview,
    topologyChanged: false, routesChanged: false, policyChanged: false,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
