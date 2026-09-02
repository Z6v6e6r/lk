#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { auditLegacyGameRevisionWriters } from "./audit_legacy_game_revision_writers.mjs";
import {
  buildCandidate as buildPaymentCandidate,
  PAYMENT_NODE_IDS,
} from "./patch_live_game_payment_confirmation.mjs";
import {
  buildLegacyGameCommandPrerequisiteCandidate,
} from "./patch_live_games_command_prerequisites.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const candidateBinding = JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_enforcement_candidate_binding.json", import.meta.url),
  "utf8",
));

export const LK1_ENFORCEMENT_CONTRACT = Object.freeze({
  sourceSha256: "9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263",
  candidateBindingState: candidateBinding.candidateBindingState,
  candidateSha256: candidateBinding.candidateSha256,
  previousCandidateSha256: candidateBinding.previousCandidateSha256,
  nodeCount: 4762,
  candidateNodeCount: 4812,
  httpRouteCount: 215,
  tabCount: 55,
  changedNodeCount: 104,
  changedExistingNodeCount: 54,
  addedNodeCount: 50,
  writerCount: 7,
  composedSources: Object.freeze([
    Object.freeze({
      id: "e656cff36a8cd210",
      sourceFile: "scripts/nodered_games_nodes/fn_create.js",
      candidateSha256: "cb2a3219b289d29c9b00bb90aff2582bfea229040690f51890ba55569cfa65a1",
    }),
    Object.freeze({
      id: "9508f8e0ae8d282a",
      sourceFile: "scripts/nodered_games_nodes/fn_split_cleanup_prepare.js",
      candidateSha256: "0a4f899dea75e5807106f1fc19befc9a028b7aa5014e1eab2f7b8e85e67ee6b3",
    }),
    Object.freeze({
      id: "bcc3dccf8d64f9bb",
      sourceFile: "scripts/nodered_games_nodes/fn_split_cleanup_router.js",
      candidateSha256: "cea42b3252af1fd060d4a268f7e46878660dd6337a50b5da10d1479ae5840038",
    }),
    Object.freeze({
      id: "79307f9bcbc28b6c",
      sourceFile: "scripts/nodered_games_nodes/fn_game_upsert_args.js",
      candidateSha256: "3d90b6590e989d3babbae0246f63bbb2e63c71f1f941f71fbf7652ad090f01ea",
    }),
    Object.freeze({
      id: "lk_game_payment_confirm_lookup_20260826",
      sourceFile: "scripts/nodered_games_nodes/fn_game_payment_confirm_lookup.js",
      candidateSha256: "ac9b30d2bef21ae0a4dcde840cb254139a8856d6a72ed77f02345a3b9693a548",
    }),
    Object.freeze({
      id: "lk_game_payment_confirm_router_20260826",
      sourceFile: "scripts/nodered_games_nodes/fn_game_payment_confirm_router.js",
      candidateSha256: "a956766184f16afb4b6185fd5956776ba7a98c00140a44f207e4b470ebccf324",
    }),
    Object.freeze({
      id: "lk_game_payment_confirm_write_ack_20260826",
      sourceFile: "scripts/nodered_games_nodes/fn_game_confirm_write_ack.js",
      candidateSha256: "3f08577e6f0014eae059d8a117e51eca5fbd7c52eba6105f1ba7bd9b07e10735",
    }),
    Object.freeze({
      id: "lk_split_cleanup_write_ack_20260826",
      sourceFile: "scripts/nodered_games_nodes/fn_split_cleanup_write_ack.js",
      candidateSha256: "429ea002f312a23cf79d169de29e12ea0fcd0b1300b2229db9c169d17872456c",
    }),
  ]),
  targets: Object.freeze([
    Object.freeze({
      id: "e0d7883bc1a9fa8c",
      tabLabel: "LK Games",
      name: "Prepare game patch",
      sourceFile: "scripts/nodered_games_nodes/fn_patch.js",
      preimageSha256: "4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931",
      candidateSha256: "9c6aaf4578c69fa30daa2326506900a5ee0a265f2299f1f0e3ab20b11e01a130",
    }),
    Object.freeze({
      id: "lk_subscription_booking_router_20260804",
      tabLabel: "LK Games",
      name: "Route atomic subscription booking",
      sourceFile: "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js",
      preimageSha256: "11c4b80c2624ad97fc83f634139d0db7d36aebb8df8a525bdc7baae3e9bae0fd",
      candidateSha256: "5af6fbc1ffcd9c3ab480e8c69390b581e8e7cc2498f994ba36fd9e7164806216",
    }),
    Object.freeze({
      id: "c165e43eba668c25",
      tabLabel: "LK Tournaments",
      name: "Build tournament subscription status",
      sourceFile: "scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js",
      preimageSha256: "2111a260dd0401fee02addb7ea8bdf18ffddd36560d4c09eb1c55ef5ca225fae",
      candidateSha256: "33f3927a159af5a615d39d7fb859a26f8aa39beeee1f1df9147c0991ae978b06",
    }),
    Object.freeze({
      id: "91dded2dc8cfebe4",
      tabLabel: "LK Tournaments",
      name: "Prepare tournament subscription purchase",
      sourceFile: "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
      preimageSha256: "f92e441ecac89048f525369c0eddfee7cbfa44610f5df1fdf9ff3df55d36be74",
      candidateSha256: "6059fd74de59cc488098a9e8d97158497ef9890a8850fb5adac89bd34bec2b44",
    }),
    Object.freeze({
      id: "f8679e53edadc39b",
      tabLabel: "LK Tournaments",
      name: "Check tournament subscription limit",
      sourceFile: "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js",
      preimageSha256: "870c6ba85ff0a26f34edd5bea9bd48623f49333ecec2355fa17dd90824068fb2",
      candidateSha256: "8a6d10a04b4e12a751db6e75ad4d4e1c90df15318ed71df405cacb5d737c77c2",
    }),
  ]),
});

const UNIFIED_IDS = Object.freeze({
  create: "e656cff36a8cd210",
  createMongo: "5eaf4c087c0cc668",
  createRevisionAck: "lk_game_create_revision_ack_20260826",
  cleanupPrepare: "9508f8e0ae8d282a",
  cleanupRouter: "bcc3dccf8d64f9bb",
  cleanupMongo: "11079a30bf3cc6ad",
  cleanupRevisionAck: "lk_split_cleanup_revision_ack_20260826",
  cleanupReadbackCatch: "lk_split_cleanup_payment_readback_catch_20260827",
  confirmReadbackCatch: "lk_game_payment_confirm_readback_catch_20260827",
  upsertArgs: "79307f9bcbc28b6c",
});
const REGISTRY_PATH = path.join(SCRIPT_DIR, "legacy_game_revision_writers.json");

const exactNode = (flow, id) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`Unified candidate requires exact node ${id}`);
  return matches[0];
};
const assertEnabledSemanticTargetUniqueness = (flow, targets, label) => {
  const tabs = new Map(flow.filter((node) => node?.type === "tab").map((node) => [node.id, node]));
  for (const target of targets) {
    const matches = flow.filter((candidate) => {
      const candidateTab = tabs.get(candidate?.z);
      return candidate?.type === "function"
        && candidate.name === target.name
        && candidateTab?.label === target.tabLabel
        && candidateTab.disabled !== true;
    });
    if (matches.length !== 1 || matches[0].id !== target.id) {
      fail(`${label} target ${target.id} enabled semantic identity must exist exactly once`);
    }
  }
};
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => !isDeepStrictEqual(before[key], after[key]))
  .sort();
const graphHealth = (flow) => {
  const ids = new Set(flow.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!ids.has(targetId)) brokenWires += 1;
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) if (!ids.has(targetId)) brokenLinks += 1;
    }
    if (node.type === "function" && Number.isInteger(node.outputs)
      && Array.isArray(node.wires) && node.outputs !== node.wires.length) {
      fail(`Unified function output count mismatch for ${node.id}`);
    }
  }
  return { brokenWires, brokenLinks };
};

function replaceCandidateHash(registry, writerId, sourceNodeId, candidateSha256) {
  const writer = registry.writers.find((item) => item.nodeId === writerId);
  const source = writer?.sourceNodes?.find((item) => item.nodeId === sourceNodeId);
  if (!source) fail(`Unified writer provenance missing ${writerId}/${sourceNodeId}`);
  source.candidateSha256 = candidateSha256;
}

export function validateUnifiedCandidateSummary(summary, contract = LK1_ENFORCEMENT_CONTRACT) {
  if (contract.candidateBindingState !== "BOUND"
    || !/^[a-f0-9]{64}$/.test(contract.candidateSha256 || "")
    || !/^[a-f0-9]{64}$/.test(contract.previousCandidateSha256 || "")
    || contract.candidateSha256 === contract.previousCandidateSha256) {
    fail("Unified LK1 candidate contract is unbound after router amendment");
  }
  const exact = (
    summary.sourceSha256 === contract.sourceSha256
    && summary.candidateSha256 === contract.candidateSha256
    && summary.candidateNodeCount === contract.candidateNodeCount
    && summary.httpRouteCount === contract.httpRouteCount
    && summary.tabCount === contract.tabCount
    && summary.changedNodeCount === contract.changedNodeCount
    && summary.changedExistingNodeCount === contract.changedExistingNodeCount
    && summary.addedNodeCount === contract.addedNodeCount
    && summary.writerCount === contract.writerCount
    && summary.brokenWires === 0
    && summary.brokenLinks === 0
    && summary.splitPricingMutationCount === 0
    && isDeepStrictEqual(summary.createAckOrder, [
      UNIFIED_IDS.createRevisionAck,
      PAYMENT_NODE_IDS.confirmWriteAck,
      PAYMENT_NODE_IDS.confirmWriteReadback,
    ])
    && isDeepStrictEqual(summary.cleanupAckOrder, [
      UNIFIED_IDS.cleanupRevisionAck,
      PAYMENT_NODE_IDS.cleanupWriteAck,
      PAYMENT_NODE_IDS.cleanupWriteReadback,
    ])
    && summary.cleanupRecoveryNode === "lk_split_cleanup_revision_recovery_write_20260826"
  );
  if (!exact) fail(`Unified LK1 reviewed candidate contract mismatch (${summary.candidateSha256 || "missing-digest"})`);
  return true;
}

export function buildUnifiedLk1EnforcementCandidate(source, sourceSha256, options = {}) {
  const contract = options.contract ?? LK1_ENFORCEMENT_CONTRACT;
  const buildPayment = options.buildPaymentCandidate ?? buildPaymentCandidate;
  const buildLegacy = options.buildLegacyCandidate ?? buildLegacyGameCommandPrerequisiteCandidate;
  const readSource = options.readSource ?? ((sourceFile) => fs.readFileSync(path.join(REPO_ROOT, sourceFile), "utf8"));
  const auditWriters = options.auditWriters ?? auditLegacyGameRevisionWriters;
  if (!Array.isArray(source) || source.length !== contract.nodeCount) {
    fail("Unified LK1 flow node count mismatch");
  }
  if (sourceSha256 !== contract.sourceSha256) {
    fail("Unified LK1 live source SHA mismatch");
  }
  if (source.filter((node) => node.type === "http in").length !== contract.httpRouteCount) {
    fail("Unified LK1 HTTP route count mismatch");
  }
  assertEnabledSemanticTargetUniqueness(source, contract.targets, "Unified LK1");

  const before = structuredClone(source);
  const payment = buildPayment(structuredClone(source), sourceSha256);
  const legacy = buildLegacy(structuredClone(source));
  const flow = legacy.flow;
  const paymentById = new Map(payment.candidate.map((node) => [node.id, node]));
  const sourceIds = new Set(source.map((node) => node.id));

  for (const node of payment.candidate) {
    if (!sourceIds.has(node.id)) flow.push(structuredClone(node));
  }

  for (const source of contract.composedSources) {
    const sourceText = readSource(source.sourceFile);
    if (sha256(sourceText) !== source.candidateSha256) {
      fail(`Unified composed source drift: ${source.id}`);
    }
    exactNode(flow, source.id).func = sourceText;
  }
  for (const route of contract.targets.filter((item) => item.id !== "e0d7883bc1a9fa8c")) {
    const liveNode = exactNode(before, route.id);
    if (sha256(String(liveNode.func || "")) !== route.preimageSha256) {
      fail(`Unified LK1 target ${route.id} preimage mismatch`);
    }
    const sourceText = readSource(route.sourceFile);
    if (sha256(sourceText) !== route.candidateSha256) fail(`Unified LK1 target ${route.id} source mismatch`);
    exactNode(flow, route.id).func = sourceText;
  }
  const patchTarget = contract.targets[0];
  if (sha256(exactNode(flow, patchTarget.id).func || "") !== patchTarget.candidateSha256) {
    fail("Unified LK1 PATCH source was not composed by the legacy prerequisite graph");
  }

  for (const route of payment.report.changedNodeIds.filter((id) => {
    const node = paymentById.get(id);
    return node?.type === "http in";
  })) {
    exactNode(flow, route).wires = structuredClone(paymentById.get(route).wires);
  }

  const createRevisionAck = exactNode(flow, UNIFIED_IDS.createRevisionAck);
  createRevisionAck.outputs = 4;
  createRevisionAck.wires = [
    ["ae5ee70de15fe66e"],
    ["60a3353902ae9973"],
    ["9756d9125563753f"],
    [PAYMENT_NODE_IDS.confirmWriteAck],
  ];
  exactNode(flow, UNIFIED_IDS.createMongo).wires = [[UNIFIED_IDS.createRevisionAck]];

  const cleanupRevisionAck = exactNode(flow, UNIFIED_IDS.cleanupRevisionAck);
  cleanupRevisionAck.outputs = 3;
  cleanupRevisionAck.wires = [
    ["lk_split_cleanup_revision_recovery_write_20260826"],
    ["e71d73fb91b0c3f0", "ba322f367a4d4fcd"],
    [PAYMENT_NODE_IDS.cleanupWriteAck],
  ];
  exactNode(flow, UNIFIED_IDS.cleanupMongo).wires = [[UNIFIED_IDS.cleanupRevisionAck]];
  const cleanupPaymentAck = exactNode(flow, PAYMENT_NODE_IDS.cleanupWriteAck);
  cleanupPaymentAck.outputs = 4;
  cleanupPaymentAck.wires = [
    [PAYMENT_NODE_IDS.cleanupWriteReadback],
    ["e71d73fb91b0c3f0"],
    ["ba322f367a4d4fcd"],
    [UNIFIED_IDS.cleanupRevisionAck],
  ];
  flow.push(
    {
      id: UNIFIED_IDS.confirmReadbackCatch,
      type: "catch",
      z: "4b91e2a2413688db",
      name: "Catch confirmed game readback errors",
      scope: [PAYMENT_NODE_IDS.confirmWriteReadback],
      uncaught: false,
      x: 1880,
      y: 2960,
      wires: [[PAYMENT_NODE_IDS.confirmWriteAck]],
    },
    {
      id: UNIFIED_IDS.cleanupReadbackCatch,
      type: "catch",
      z: "4b91e2a2413688db",
      name: "Catch split cleanup readback errors",
      scope: [PAYMENT_NODE_IDS.cleanupWriteReadback],
      uncaught: false,
      x: 2100,
      y: 2320,
      wires: [[PAYMENT_NODE_IDS.cleanupWriteAck]],
    },
  );

  const health = graphHealth(flow);
  if (health.brokenWires || health.brokenLinks) fail("Unified LK1 candidate contains broken references");
  if (flow.filter((node) => node.type === "http in").length !== contract.httpRouteCount) {
    fail("Unified LK1 candidate changed HTTP route inventory");
  }

  const registry = structuredClone(options.registry ?? JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")));
  const composedHash = (nodeId) => contract.composedSources
    .find((item) => item.id === nodeId)?.candidateSha256 || fail(`Unified composed source contract missing: ${nodeId}`);
  replaceCandidateHash(registry, UNIFIED_IDS.createMongo, UNIFIED_IDS.create, composedHash(UNIFIED_IDS.create));
  replaceCandidateHash(registry, UNIFIED_IDS.cleanupMongo, UNIFIED_IDS.cleanupPrepare, composedHash(UNIFIED_IDS.cleanupPrepare));
  replaceCandidateHash(registry, UNIFIED_IDS.cleanupMongo, UNIFIED_IDS.cleanupRouter, composedHash(UNIFIED_IDS.cleanupRouter));
  const writerAudit = auditWriters(flow, registry, { stage: "candidate" });
  const changes = flow.flatMap((node) => {
    const prior = before.find((item) => item.id === node.id);
    if (!prior) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
    if (isDeepStrictEqual(prior, node)) return [];
    return [{ id: node.id, kind: "changed", changedFields: changedFields(prior, node) }];
  });
  const addedNodeCount = changes.filter((item) => item.kind === "added").length;
  const changedExistingNodeCount = changes.filter((item) => item.kind === "changed").length;
  const candidateSha256 = sha256(`${JSON.stringify(flow, null, 2)}\n`);
  const composition = {
    subscriptionFunctionCount: contract.targets.length,
    legacyPrerequisiteChanges: legacy.changes.length,
    paymentAddedNodeCount: Object.keys(PAYMENT_NODE_IDS).length,
    splitPricingMutationCount: 0,
    createAckOrder: [UNIFIED_IDS.createRevisionAck, PAYMENT_NODE_IDS.confirmWriteAck, PAYMENT_NODE_IDS.confirmWriteReadback],
    cleanupAckOrder: [UNIFIED_IDS.cleanupRevisionAck, PAYMENT_NODE_IDS.cleanupWriteAck, PAYMENT_NODE_IDS.cleanupWriteReadback],
    cleanupRecoveryNode: "lk_split_cleanup_revision_recovery_write_20260826",
  };
  validateUnifiedCandidateSummary({
    sourceSha256,
    candidateSha256,
    candidateNodeCount: flow.length,
    httpRouteCount: flow.filter((node) => node.type === "http in").length,
    tabCount: flow.filter((node) => node.type === "tab").length,
    changedNodeCount: changes.length,
    changedExistingNodeCount,
    addedNodeCount,
    writerCount: writerAudit.writerCount,
    brokenWires: health.brokenWires,
    brokenLinks: health.brokenLinks,
    ...composition,
  }, contract);
  return {
    candidate: flow,
    candidateSha256,
    changedNodes: changes,
    writerAudit,
    graphHealth: health,
    composition,
  };
}

const topology = (flow) => flow.map((node) => ({
  id: node.id,
  z: node.z ?? null,
  wires: Object.hasOwn(node, "wires") ? node.wires : null,
  links: Object.hasOwn(node, "links") ? node.links : null,
}));

export function buildLk1EnforcementCandidate(
  flow,
  sourceSha256,
  contract = LK1_ENFORCEMENT_CONTRACT,
  readSource = (sourceFile) => fs.readFileSync(path.join(REPO_ROOT, sourceFile), "utf8"),
) {
  if (!Array.isArray(flow) || flow.length !== contract.nodeCount) fail("LK1 flow node count mismatch");
  if (sourceSha256 !== contract.sourceSha256) fail("LK1 live source SHA mismatch");
  const before = structuredClone(flow);
  const beforeTopology = topology(before);
  const tabs = new Map(flow.filter((node) => node?.type === "tab").map((node) => [node.id, node]));
  const changedNodes = [];

  for (const target of contract.targets) {
    const matches = flow.filter((node) => node?.id === target.id);
    if (matches.length !== 1) fail(`LK1 target ${target.id} must exist exactly once`);
    const node = matches[0];
    const tab = tabs.get(node.z);
    if (node.type !== "function" || node.name !== target.name
      || tab?.label !== target.tabLabel || tab.disabled === true) {
      fail(`LK1 target ${target.id} identity or enabled-tab mismatch`);
    }
    assertEnabledSemanticTargetUniqueness(flow, [target], "LK1");
    const previousSource = String(node.func || "");
    if (sha256(previousSource) !== target.preimageSha256) {
      fail(`LK1 target ${target.id} preimage mismatch`);
    }
    const nextSource = readSource(target.sourceFile);
    if (sha256(nextSource) !== target.candidateSha256) {
      fail(`LK1 target ${target.id} tracked source mismatch`);
    }
    node.func = nextSource;
    changedNodes.push({
      id: target.id,
      name: target.name,
      tabId: node.z,
      previousSha256: target.preimageSha256,
      candidateSha256: target.candidateSha256,
      changedFields: ["func"],
    });
  }

  const actualChanged = flow.flatMap((node, index) => (
    isDeepStrictEqual(node, before[index]) ? [] : [{
      id: node.id,
      changedFields: Object.keys(node).filter((key) => !isDeepStrictEqual(node[key], before[index][key])).sort(),
    }]
  ));
  actualChanged.sort((left, right) => left.id.localeCompare(right.id));
  const expectedChanged = changedNodes
    .map(({ id, changedFields }) => ({ id, changedFields }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!isDeepStrictEqual(actualChanged, expectedChanged)) fail("LK1 candidate changed unexpected nodes or fields");
  if (!isDeepStrictEqual(beforeTopology, topology(flow))) fail("LK1 candidate changed graph topology");
  return { candidate: flow, changedNodes };
}

export function publishLk1EnforcementCandidate(workspace) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const result = buildUnifiedLk1EnforcementCandidate(verified.source, verified.sourceSha256);
  const candidateText = `${JSON.stringify(result.candidate, null, 2)}\n`;
  const report = {
    formatVersion: 2,
    ok: true,
    sourceKind: "live-147",
    sourceSha256: verified.sourceSha256,
    candidateSha256: result.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: result.candidate.length,
    httpRouteCount: result.candidate.filter((node) => node.type === "http in").length,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    writerAudit: result.writerAudit,
    graphHealth: result.graphHealth,
    composition: result.composition,
    productionCustodyState: "UNBOUND",
    liveMutationAuthorized: false,
    deploymentPerformed: false,
  };
  const buildDirectory = path.join(verified.workspace, "build");
  fs.mkdirSync(buildDirectory, { recursive: true, mode: 0o700 });
  const candidatePath = path.join(buildDirectory, "lk1-subscription-enforcement.candidate.json");
  const reportPath = path.join(buildDirectory, "lk1-subscription-enforcement.report.json");
  fs.writeFileSync(candidatePath, candidateText, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { report, candidatePath, reportPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--workspace") {
    fail("Usage: node scripts/prepare_lk1_subscription_enforcement_candidate.mjs --workspace <external-workspace>");
  }
  const result = publishLk1EnforcementCandidate(process.argv[3]);
  process.stdout.write(`sourceSha256=${result.report.sourceSha256}\n`);
  process.stdout.write(`candidateSha256=${result.report.candidateSha256}\n`);
  process.stdout.write(`changedNodeCount=${result.report.changedNodeCount}\n`);
  process.stdout.write(`candidatePath=${result.candidatePath}\n`);
  process.stdout.write(`reportPath=${result.reportPath}\n`);
}
