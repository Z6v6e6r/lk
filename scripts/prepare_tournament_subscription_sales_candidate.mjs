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
  ["Prepare tournament subscription counter refresh", "fn_tournament_subscription_counter_refresh_prepare.js"],
  ["Build tournament subscription counters", "fn_tournament_subscription_counter_refresh_response.js"],
  ["Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
  ["Prepare tournament subscription reconciliation", "fn_tournament_subscription_reconcile_query.js"],
];

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

const changedNodes = [];
let targetNodeCount = 0;
for (const [nodeName, sourceFile] of TARGETS) {
  const matches = candidate.filter((node) => (
    node?.type === "function"
    && enabledTabIds.has(node?.z)
    && node?.name === nodeName
  ));
  if (matches.length < 1) {
    fail(`Expected at least one enabled ${nodeName} function, found ${matches.length}`);
  }
  targetNodeCount += matches.length;
  const nextSource = fs.readFileSync(path.join(FUNCTION_DIR, sourceFile), "utf8");
  for (const match of matches) {
    const previousSource = String(match.func || "");
    if (nextSource === previousSource) continue;
    match.func = nextSource;
    changedNodes.push({
      id: match.id,
      name: nodeName,
      tabId: match.z,
      previousSha256: sha256(previousSource),
      candidateSha256: sha256(nextSource),
    });
  }
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
  .flatMap(([nodeName]) => candidate.filter((node) => (
    node?.type === "function"
    && enabledTabIds.has(node?.z)
    && node?.name === nodeName
  )).map((node) => node.func || ""))
  .join("\n");
for (const marker of [
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
