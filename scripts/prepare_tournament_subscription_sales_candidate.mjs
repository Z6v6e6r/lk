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

const changedNodes = [];
for (const [nodeName, sourceFile] of TARGETS) {
  const matches = candidate.filter((node) => (
    node?.type === "function"
    && node?.z === tabs[0].id
    && node?.name === nodeName
  ));
  if (matches.length !== 1) {
    fail(`Expected one ${nodeName} function in ${TARGET_TAB_LABEL}, found ${matches.length}`);
  }
  const nextSource = fs.readFileSync(path.join(FUNCTION_DIR, sourceFile), "utf8");
  const previousSource = String(matches[0].func || "");
  if (nextSource === previousSource) {
    fail(`${nodeName} already matches the candidate source`);
  }
  matches[0].func = nextSource;
  changedNodes.push({
    id: matches[0].id,
    name: nodeName,
    previousSha256: sha256(previousSource),
    candidateSha256: sha256(nextSource),
  });
}

const sourceById = new Map(verified.source.map((node) => [node.id, node]));
const actualChanged = candidate.filter((node) => JSON.stringify(node) !== JSON.stringify(sourceById.get(node.id)));
if (actualChanged.length !== TARGETS.length) {
  fail(`Unexpected changed node count: ${actualChanged.length}`);
}
if (!actualChanged.every((node) => changedNodes.some((entry) => entry.id === node.id))) {
  fail("Candidate changes nodes outside the approved tournament subscription target set");
}

const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
const markerSource = changedNodes
  .map((entry) => candidate.find((node) => node.id === entry.id)?.func || "")
  .join("\n");
for (const marker of [
  "8bf334ba-3050-4017-b40a-7eef2db1eb16",
  "db7a5250-7369-4f43-8ac5-9111be24bc74",
  'launchEnabled: false',
  'discount: discountMinor',
  'Viva вернула неверную сумму к оплате',
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
