#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTION_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const TARGET_TAB_LABEL = "LK Tournaments";
const TARGETS = [
  ["519b6a6ca208e281", "f9575c8726e29196", "LK Tournaments", "Prepare tournament subscription counter refresh", "fn_tournament_subscription_counter_refresh_prepare.js"],
  ["d4901c31b37eab6b", "f9575c8726e29196", "LK Tournaments", "Build tournament subscription counters", "fn_tournament_subscription_counter_refresh_response.js"],
  ["8fdc7076a0c436a2", "f9575c8726e29196", "LK Tournaments", "Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["c165e43eba668c25", "f9575c8726e29196", "LK Tournaments", "Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["91dded2dc8cfebe4", "f9575c8726e29196", "LK Tournaments", "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["f8679e53edadc39b", "f9575c8726e29196", "LK Tournaments", "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["566ae4b886c37ae5", "f9575c8726e29196", "LK Tournaments", "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
  ["ab1e202650000002", "f9575c8726e29196", "LK Tournaments", "Prepare tournament subscription reconciliation", "fn_tournament_subscription_reconcile_query.js"],
  ["945c1f1c113a56b6", "8ccb70ac6befff79", "Media2", "Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["ef90184a8c79cfc1", "8ccb70ac6befff79", "Media2", "Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["d1ab6ebf91540479", "8ccb70ac6befff79", "Media2", "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["4ff8867d897b1315", "8ccb70ac6befff79", "Media2", "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["af0b35cce2883ebd", "8ccb70ac6befff79", "Media2", "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
];
const CANDIDATE_SHA256_BY_SOURCE_FILE = Object.freeze({
  "fn_tournament_subscription_counter_refresh_prepare.js": "82cc3b69c2030f852c564e2e0028fcd88e9e1c5496e51be74a29ece6aa89c0b0",
  "fn_tournament_subscription_counter_refresh_response.js": "5fed0cdad40cb0cc41daf766e23f1fb938b9ccbc65de11d0d90484de9dcef262",
  "fn_tournament_subscription_status_prepare.js": "46d5bf043e960a044e622ae9929bf865f2a5c8e7ad10f6729f7edf7649aff3e7",
  "fn_tournament_subscription_status_response.js": "e81699c4c490b9883cacf104c751990c0b2922ce86d1f607889fb66991fedb53",
  "fn_tournament_subscription_purchase_prepare.js": "cdaa2b512d6e0f1bc1fd79eb264d1d05816e63d391e6bbf9390eaf29694e0851",
  "fn_tournament_subscription_purchase_limit.js": "d7adcfb697bf06428f7e0c3de2dafb111e88d59c480640574d6d2760e4b9b549",
  "fn_tournament_subscription_purchase_router.js": "9c4f062ab1105480f97a0ca5cc869c68cf8bd1310a846e7eab63600c37b61d9c",
  "fn_tournament_subscription_reconcile_query.js": "35d8a910979922a632e4334606e018b6116f24b0de87b105dc5dd50b87210856",
});
const FROZEN_PREIMAGE_SHA256_BY_ID = Object.freeze({
  "519b6a6ca208e281": "224b72932a7964bde0957f995c0bfcf3bbe33e7376b8f6570f2268a3831b9487",
  "d4901c31b37eab6b": "fad9d71df5e4917411eec5bd3208c2859b854bc7b4b1a43e4c76ae3384298985",
  "8fdc7076a0c436a2": "c7f35faf288eb937bf618e342a45ab1ef8626785291c151d3c5c60f91bea6569",
  "c165e43eba668c25": "2111a260dd0401fee02addb7ea8bdf18ffddd36560d4c09eb1c55ef5ca225fae",
  "91dded2dc8cfebe4": "f92e441ecac89048f525369c0eddfee7cbfa44610f5df1fdf9ff3df55d36be74",
  "f8679e53edadc39b": "870c6ba85ff0a26f34edd5bea9bd48623f49333ecec2355fa17dd90824068fb2",
  "566ae4b886c37ae5": "09cb16cc46aa50ac232fc8982d55214f43e157b51f7ec43854cbfaf25b25a0f5",
  "ab1e202650000002": "5845eb107a18f4e51b69192ee83af3f37642605ccb8a7a48423f83f3803f509d",
  "945c1f1c113a56b6": "b41239d08da4b9fc8c7949705117c95d264e6e34a0d311d03423e0d6b735bdfa",
  "ef90184a8c79cfc1": "f2235daf139588dc82ae1a97033c41bb1d5cb90f09adc64eb46721568f490060",
  "d1ab6ebf91540479": "dd93b6248a9a9283b4a549eeb5272891155366c44e86613c4963f1e043d16425",
  "4ff8867d897b1315": "4b4e34057ebcfa336b96457cb78090e90fdeb94d2526c6410c5626aff262eb5e",
  "af0b35cce2883ebd": "67124b9eb677fcd24e4f4883869e9782286cc9950dcbdd712474cf48a1c11e62",
});

const fail = (message) => {
  throw new Error(message);
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const parseWorkspace = (argv) => {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    fail("Usage: node scripts/prepare_tournament_subscription_sales_candidate.mjs --workspace /absolute/external/workspace");
  }
  return argv[1];
};

const verified = verifyWorkspace(parseWorkspace(process.argv.slice(2)), { quiet: true });
const candidate = structuredClone(verified.source);
const tabs = candidate.filter((node) => node?.type === "tab" && node?.label === TARGET_TAB_LABEL);
if (tabs.length !== 1 || tabs[0].disabled === true) {
  fail(`Expected one enabled ${TARGET_TAB_LABEL} tab, found ${tabs.length}`);
}
const enabledTabIds = new Set(candidate
  .filter((node) => node?.type === "tab" && node?.disabled !== true)
  .map((node) => node.id));
const targetIds = new Set(TARGETS.map(([id]) => id));
const targetNames = new Set(TARGETS.map(([, , , name]) => name));
const unexpectedTargets = candidate.filter((node) => (
  node?.type === "function"
  && enabledTabIds.has(node?.z)
  && targetNames.has(node?.name)
  && !targetIds.has(node?.id)
));
if (unexpectedTargets.length > 0) {
  fail(`Unexpected enabled tournament subscription target ids: ${unexpectedTargets.map((node) => node.id).join(",")}`);
}

const changedNodes = [];
let targetNodeCount = 0;
for (const [nodeId, tabId, tabLabel, nodeName, sourceFile] of TARGETS) {
  const matches = candidate.filter((node) => node?.id === nodeId);
  if (matches.length !== 1) {
    fail(`Expected exactly one approved tournament subscription target ${nodeId}, found ${matches.length}`);
  }
  const match = matches[0];
  const tab = candidate.find((node) => node?.id === tabId && node?.type === "tab");
  if (match.type !== "function" || match.z !== tabId || match.name !== nodeName || tab?.label !== tabLabel) {
    fail(`Tournament subscription target identity mismatch: ${nodeId}`);
  }
  if (!enabledTabIds.has(tabId)) continue;
  targetNodeCount += 1;
  const nextSource = fs.readFileSync(path.join(FUNCTION_DIR, sourceFile), "utf8");
  const previousSource = String(match.func || "");
  const candidateSha256 = CANDIDATE_SHA256_BY_SOURCE_FILE[sourceFile];
  if (sha256(nextSource) !== candidateSha256) {
    fail(`Tracked tournament subscription source mismatch: ${sourceFile}`);
  }
  const allowedCurrentSha256 = new Set([
    FROZEN_PREIMAGE_SHA256_BY_ID[nodeId],
    candidateSha256,
  ]);
  if (!allowedCurrentSha256.has(sha256(previousSource))) {
    fail(`Tournament subscription target preimage mismatch: ${nodeId}`);
  }
  if (nextSource === previousSource) continue;
  match.func = nextSource;
  changedNodes.push({
    id: match.id,
    name: nodeName,
    tabId: match.z,
    previousSha256: sha256(previousSource),
    candidateSha256,
  });
}

const sourceById = new Map(verified.source.map((node) => [node.id, node]));
const actualChanged = candidate.filter((node) => JSON.stringify(node) !== JSON.stringify(sourceById.get(node.id)));
if (changedNodes.length === 0) {
  fail("All tournament subscription sales functions already match the candidate source");
}
if (actualChanged.length !== changedNodes.length) {
  fail(`Unexpected changed node count: ${actualChanged.length}`);
}
if (!actualChanged.every((node) => changedNodes.some((entry) => entry.id === node.id))) {
  fail("Candidate changes nodes outside the approved tournament subscription target set");
}

const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
const markerSource = TARGETS
  .flatMap(([nodeId, tabId]) => (
    enabledTabIds.has(tabId) ? [candidate.find((node) => node.id === nodeId)?.func || ""] : []
  ))
  .join("\n");
for (const marker of [
  "ab_leto_2026_150_v2",
  "NETWORK_FRIENDSHIP_DAILY_LIMIT = 10",
  "dailyCapEnabled: true",
  "summer_subscription_ab_leto_20260903_release_enabled",
  "resolvePendingDeadlineTs",
  "8bf334ba-3050-4017-b40a-7eef2db1eb16",
  "db7a5250-7369-4f43-8ac5-9111be24bc74",
  'launchEnabled: false',
  'discount: discountMinor',
  'Viva вернула неверную сумму к оплате',
  'REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE',
  'REGIONAL_FRIENDSHIP_INVENTORIES',
]) {
  if (!markerSource.includes(marker)) fail(`Candidate marker is missing: ${marker}`);
}

const buildDirectory = path.join(verified.workspace, "build");
if (fs.existsSync(buildDirectory)) fail("Node-RED candidate build directory already exists");
fs.mkdirSync(buildDirectory, { mode: 0o700 });
const candidatePath = path.join(buildDirectory, "tournament-subscription-sales.candidate.json");
const reportPath = path.join(buildDirectory, "tournament-subscription-sales.report.json");
fs.writeFileSync(candidatePath, candidateText, { mode: 0o600, flag: "wx" });
const report = {
  formatVersion: 1,
  ok: true,
  sourceKind: "live-147",
  sourceSha256: verified.sourceSha256,
  candidateSha256: sha256(candidateText),
  sourceNodeCount: verified.nodeCount,
  candidateNodeCount: candidate.length,
  targetNodeCount,
  changedNodeCount: changedNodes.length,
  targetTab: { id: tabs[0].id, label: tabs[0].label },
  changedNodes,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });

console.log(`sourceSha256=${report.sourceSha256}`);
console.log(`candidateSha256=${report.candidateSha256}`);
console.log(`changedNodeCount=${report.changedNodeCount}`);
console.log(`candidatePath=${candidatePath}`);
console.log(`reportPath=${reportPath}`);
