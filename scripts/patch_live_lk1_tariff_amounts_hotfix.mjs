#!/usr/bin/env node

// Focused Node-RED generation: the event tariff amount rule and the preview evaluator.
//
// Two reviewed defects, both visible in the live diagnostics of 2026-09-15 22:50+:
//
//   1. The event tariff refuses with `stage: "product_amount"` on every exercise whose
//      trial price differs from the paid price: the Viva one-times DTO carries `cost`
//      and `trialCost` with two distinct non-zero integers, while the rule required all
//      amount fields to be equal. The paid price (`cost`/`price`/`amount`, which are
//      aliases of one number) keeps its equality rule; `trialCost` only has to be a
//      non-negative integer, and the proof amount stays the paid price. The rule lives
//      in one reviewed place (`scripts/nodered_lk1_hub_nodes/gateway.js`) and is applied
//      to `lk_subscription_booking_router_20260804` with literal deltas; the preview
//      router carries the same rule.
//
//   2. `lk_subscription_price_preview_20260908_evaluate` still ran the superseded
//      embedded evaluator (`6f4e7aa5…`): it compares the rule product with the hardcoded
//      HUB id, so every plan product answered `LK1_PRODUCT_BINDING_INVALID`, and it still
//      emitted the removed cap blocker `ACTIVE_SERVICES_LIMIT_REACHED` — exactly the
//      blocker pair the live diagnostics report. The plan-rules release composed the
//      reviewed evaluator body but never wrote it into this node. It now carries the body
//      of `lk_subscription_managed_policy_20260820` (`d410acdb…`), so the advisory preview
//      and the write path resolve one identical decision.
//
// The generation is exactly three nodes and three `func` fields; no node is added and the
// plan-rules activation and the split/join bodies stay untouched.
//
// This is preparation only, and it fails closed unless the supplied preimage is exactly
// the reviewed live flow (whole-flow sha256 plus every node body it rewrites or reads).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewSources, assertCanonicalExports } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const TARIFF_AMOUNTS_DEPLOYMENT_ID = "lk1-event-tariff-amounts";
export const TARIFF_AMOUNTS_KIND = "FOCUSED_LK1_EVENT_TARIFF_AMOUNTS_HOTFIX_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-15 after
// `lk1-event-diagnostics` (4804 nodes, sha256 0e0d6053…).
export const TARIFF_AMOUNTS_SOURCE_SHA256 =
  "0e0d6053f7ca1ee9d98dc312f928689a732a6bae6f8d49515bc5649a8135f13b";
export const TARIFF_AMOUNTS_SOURCE_NODE_COUNT = 4804;

export const TARIFF_AMOUNTS_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
export const TARIFF_AMOUNTS_EVALUATE_ID = "lk_subscription_price_preview_20260908_evaluate";
export const TARIFF_AMOUNTS_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const TARIFF_AMOUNTS_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

export const TARIFF_AMOUNTS_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "44073942212be41c0726aa0e073181b9796d6f41da022db893557df5174eacc9",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "98229c7224fe81c3856071523307514b8df914440c8bf03a159a2e9a5c72fd8b",
});

export const TARIFF_AMOUNTS_TARGETS = Object.freeze({
  previewRouter: {
    id: TARIFF_AMOUNTS_ROUTER_ID,
    liveFuncSha256: "ad67484dfc09c1620455fc810cc624344a2e07ed8a6d3561f345b63a8c382ac7",
    // Re-pinned 2026-09-17: the generation `lk1-target-diagnostics` changed the reviewed
    // router source (additive refusal details), so the same preimage composes to this body.
    patchedFuncSha256: "31ae708039f22dc38b02ca1817d7447a38498b6586cd6302f707cf5fb69561d6",
  },
  previewEvaluate: {
    id: TARIFF_AMOUNTS_EVALUATE_ID,
    liveFuncSha256: "6f4e7aa5506d7da4123fc0f8c86c5a310f6fc2dc86c9cc23b56ef1deaa001a72",
    // The reviewed body is the installed managed evaluator of the same generation.
    patchedFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  },
  booking: {
    id: TARIFF_AMOUNTS_BOOKING_ID,
    liveFuncSha256: "44073942212be41c0726aa0e073181b9796d6f41da022db893557df5174eacc9",
    // The installed copy wraps the proof literal differently from the reviewed source
    // (pre-existing formatting divergence), so the delta result — not the source splice —
    // is the reviewed postimage of this generation.
    patchedFuncSha256: "9462ef12802add1e189fed6a6e51e8e35ccbd7bb49e634e122c7316110445e62",
  },
});

// The three literal deltas that carry the reviewed rule into the installed booking
// gateway body. Each must occur exactly once; the node-level preimage sha above proves
// the body they were derived from.
export const TARIFF_AMOUNTS_BOOKING_DELTAS = Object.freeze([
  {
    id: "amount-fields-split",
    before: `  const amounts = [product.cost, product.price, product.amount, product.trialCost].filter((amount) => amount !== undefined);
  const types = [product.productType, product.type].filter((type) => type !== undefined);`,
    after: `  const paidAmounts = [product.cost, product.price, product.amount].filter((amount) => amount !== undefined);
  // The DTO carries two kinds of money: the paid price (\`cost\`/\`price\`/\`amount\` are
  // aliases of one number and must agree) and the trial price (\`trialCost\`), which
  // describes a different offer and only has to be a non-negative integer. Requiring the
  // trial price to equal the paid one refused every exercise whose trial tariff differs
  // (live evidence 2026-09-15: both fields present, two distinct non-zero integers).
  const trialAmountPresent = product.trialCost !== undefined;
  const trialAmount = trialAmountPresent ? product.trialCost : null;
  const types = [product.productType, product.type].filter((type) => type !== undefined);`,
  },
  {
    id: "paid-price-equality-with-trial-guard",
    before: `    || !amounts.length || amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(amounts).size !== 1) return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNVERIFIED");`,
    after: `    || !paidAmounts.length || paidAmounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(paidAmounts).size !== 1
    || (trialAmountPresent && (!Number.isSafeInteger(trialAmount) || trialAmount < 0))) return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNVERIFIED");`,
  },
  {
    id: "proof-amount-is-the-paid-price",
    before: "    productId: productIds[0], amountMinor: amounts[0], stationId: toStr(exercise.studio?.id || exercise.studioId),",
    after: "    productId: productIds[0], amountMinor: paidAmounts[0], stationId: toStr(exercise.studio?.id || exercise.studioId),",
  },
]);

const ROUTER_MARKERS = Object.freeze([
  "const paidFields = ['cost', 'price', 'amount'].filter",
  "tariffRefusal('product_amount'",
  "tariffRefusal('product_trial_amount'",
  "ctx.errorDetails = { stage: 'decision_blockers',",
]);
const ROUTER_ABSENT_MARKERS = Object.freeze([
  "const amountFields = ['cost', 'price', 'amount', 'trialCost'].filter",
]);
const EVALUATOR_MARKERS = Object.freeze(["aboveActiveLimit"]);
// The superseded preview evaluator hardcodes the HUB product id; the reviewed one takes
// the product from the resolved rule.
const EVALUATOR_ABSENT_MARKERS = Object.freeze(["db7a5250-7369-4f43-8ac5-9111be24bc74"]);
const BOOKING_MARKERS = Object.freeze(["const paidAmounts = [product.cost, product.price, product.amount]",
  "const trialAmountPresent = product.trialCost !== undefined;", "amountMinor: paidAmounts[0]"]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  "const amounts = [product.cost, product.price, product.amount, product.trialCost].filter",
  "amountMinor: amounts[0]",
]);

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

function assertMarkers(body, present, absent, label) {
  for (const marker of present) {
    if ((body.split(marker).length - 1) !== 1) {
      throw new Error(`${label} is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of absent) {
    if (body.includes(marker)) throw new Error(`${label} still carries the superseded body: ${marker}`);
  }
}

// The reviewed evaluator body mentions its verdicts several times, so these markers are
// presence checks: the reviewed body carries the cap verdict and never the HUB constant.
function assertEvaluatorBody(body, label) {
  for (const marker of EVALUATOR_MARKERS) {
    if (!body.includes(marker)) throw new Error(`${label} is missing the reviewed marker: ${marker}`);
  }
  for (const marker of EVALUATOR_ABSENT_MARKERS) {
    if (body.includes(marker)) throw new Error(`${label} still carries the superseded body: ${marker}`);
  }
  assertFunctionBody(body, label);
}

export function patchTariffAmountsBookingBody(source, target = TARIFF_AMOUNTS_TARGETS.booking) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of TARIFF_AMOUNTS_BOOKING_DELTAS) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Booking gateway anchor drift for ${delta.id}: ${occurrences} occurrences`);
    }
    patched = patched.replace(delta.before, () => delta.after);
  }
  assertMarkers(patched, BOOKING_MARKERS, BOOKING_ABSENT_MARKERS, "Patched booking gateway");
  assertFunctionBody(patched, "Patched booking gateway body");
  if (sha256(patched) !== target.patchedFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${sha256(patched)} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function composeTariffAmountsRouter(flow, target = TARIFF_AMOUNTS_TARGETS.previewRouter) {
  const generation = TARIFF_AMOUNTS_INSTALLED_GENERATION;
  const router = flow.find((node) => node.id === target.id);
  const booking = flow.find((node) => node.id === TARIFF_AMOUNTS_BOOKING_ID);
  const evaluator = flow.find((node) => node.id === TARIFF_AMOUNTS_EVALUATOR_ID);
  assertFunctionNode(router, target.id);
  assertFunctionNode(booking, TARIFF_AMOUNTS_BOOKING_ID);
  assertFunctionNode(evaluator, TARIFF_AMOUNTS_EVALUATOR_ID);
  if (sha256(router.func) !== target.liveFuncSha256) {
    throw new Error(`Preview router installed preimage drift: ${sha256(router.func)} != ${target.liveFuncSha256}`);
  }
  if (sha256(booking.func) !== generation.bookingFuncSha256) {
    throw new Error(`Preview booking pin mismatch: ${sha256(booking.func)} != ${generation.bookingFuncSha256}`);
  }
  if (sha256(evaluator.func) !== TARIFF_AMOUNTS_TARGETS.previewEvaluate.patchedFuncSha256) {
    throw new Error(`Preview evaluator pin mismatch: ${sha256(evaluator.func)}`);
  }
  const composed = previewSources(flow, {
    pins: {
      booking: generation.bookingFuncSha256,
      evaluator: TARIFF_AMOUNTS_TARGETS.previewEvaluate.patchedFuncSha256,
      pricing: generation.splitFuncSha256,
      join: generation.joinFuncSha256,
    },
    installedUsageSha256: generation.allowanceBlockSha256,
  });
  assertCanonicalExports(composed.router, composed.exportedNames);
  assertMarkers(composed.router, ROUTER_MARKERS, ROUTER_ABSENT_MARKERS, "Composed preview router");
  assertFunctionBody(composed.router, "Composed preview router body");
  const digest = sha256(composed.router);
  if (digest !== target.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  return composed;
}

export function composeTariffAmountsArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? TARIFF_AMOUNTS_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== TARIFF_AMOUNTS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${TARIFF_AMOUNTS_SOURCE_NODE_COUNT}`);
  }
  const router = assertFunctionNode(flow.find((node) => node.id === TARIFF_AMOUNTS_ROUTER_ID), TARIFF_AMOUNTS_ROUTER_ID);
  const evaluate = assertFunctionNode(flow.find((node) => node.id === TARIFF_AMOUNTS_EVALUATE_ID), TARIFF_AMOUNTS_EVALUATE_ID);
  const booking = assertFunctionNode(flow.find((node) => node.id === TARIFF_AMOUNTS_BOOKING_ID), TARIFF_AMOUNTS_BOOKING_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === TARIFF_AMOUNTS_EVALUATOR_ID),
    TARIFF_AMOUNTS_EVALUATOR_ID);
  const unchanged = (node) => JSON.parse(JSON.stringify({ ...node, func: null }));
  const routerBefore = unchanged(router);
  const evaluateBefore = unchanged(evaluate);
  const bookingBefore = unchanged(booking);
  const before = { router: sha256(router.func), evaluate: sha256(evaluate.func), booking: sha256(booking.func) };

  // The preview evaluator must run the reviewed body, and that body must be the one the
  // write path already runs: the node swap is a copy, not a re-composition.
  assertEvaluatorBody(evaluator.func, "Installed managed evaluator");
  if (sha256(evaluator.func) !== TARIFF_AMOUNTS_TARGETS.previewEvaluate.patchedFuncSha256) {
    throw new Error("Installed managed evaluator does not match the reviewed body");
  }

  const composed = composeTariffAmountsRouter(flow);
  router.func = composed.router;
  evaluate.func = evaluator.func;
  booking.func = patchTariffAmountsBookingBody(booking.func);

  for (const [node, beforeShape, target, label] of [
    [router, routerBefore, TARIFF_AMOUNTS_TARGETS.previewRouter, "preview router"],
    [evaluate, evaluateBefore, TARIFF_AMOUNTS_TARGETS.previewEvaluate, "preview evaluate"],
  ]) {
    if (JSON.stringify({ ...node, func: null }) !== JSON.stringify(beforeShape)) {
      throw new Error(`Preview ${label} changed a field other than func`);
    }
    if (sha256(node.func) !== target.patchedFuncSha256) {
      throw new Error(`Preview ${label} postimage drift`);
    }
  }
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(bookingBefore)) {
    throw new Error("Booking gateway changed a field other than func");
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [
    { id: TARIFF_AMOUNTS_ROUTER_ID, fields: ["func"],
      func: { beforeSha256: before.router, afterSha256: sha256(router.func) } },
    { id: TARIFF_AMOUNTS_EVALUATE_ID, fields: ["func"],
      func: { beforeSha256: before.evaluate, afterSha256: sha256(evaluate.func) } },
    { id: TARIFF_AMOUNTS_BOOKING_ID, fields: ["func"],
      func: { beforeSha256: before.booking, afterSha256: sha256(booking.func) } },
  ];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: changes.map((change) => ({ id: change.id, fields: change.fields })),
    allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    preview: {
      routerId: TARIFF_AMOUNTS_ROUTER_ID,
      evaluateId: TARIFF_AMOUNTS_EVALUATE_ID,
      exportedNameCount: composed.exportedNames.length,
      eventHelpersPublished: ["identityMoneyOwned", "lk1LifecycleInstant", "managedExternalEventTypeId"]
        .every((name) => composed.exportedNames.includes(name)),
      evaluatorMatchesWritePath: sha256(evaluate.func) === sha256(evaluator.func),
      otherFieldsUnchanged: true,
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
  const built = composeTariffAmountsArtifacts(liveBytes, TARIFF_AMOUNTS_DEPLOYMENT_ID, {
    expectedSourceSha256: TARIFF_AMOUNTS_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: TARIFF_AMOUNTS_KIND,
    deploymentId: TARIFF_AMOUNTS_DEPLOYMENT_ID,
    targets: {
      previewRouter: { id: TARIFF_AMOUNTS_ROUTER_ID,
        func: { beforeSha256: TARIFF_AMOUNTS_TARGETS.previewRouter.liveFuncSha256,
          afterSha256: TARIFF_AMOUNTS_TARGETS.previewRouter.patchedFuncSha256 } },
      previewEvaluate: { id: TARIFF_AMOUNTS_EVALUATE_ID,
        func: { beforeSha256: TARIFF_AMOUNTS_TARGETS.previewEvaluate.liveFuncSha256,
          afterSha256: TARIFF_AMOUNTS_TARGETS.previewEvaluate.patchedFuncSha256 } },
      booking: { id: TARIFF_AMOUNTS_BOOKING_ID,
        func: { beforeSha256: TARIFF_AMOUNTS_TARGETS.booking.liveFuncSha256,
          afterSha256: TARIFF_AMOUNTS_TARGETS.booking.patchedFuncSha256 } },
    },
    installedGeneration: { ...TARIFF_AMOUNTS_INSTALLED_GENERATION },
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 3,
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
    fail(error.message);
  }
}
