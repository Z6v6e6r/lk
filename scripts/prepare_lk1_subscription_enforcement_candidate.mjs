#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

export const LK1_ENFORCEMENT_CONTRACT = Object.freeze({
  sourceSha256: "0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e",
  nodeCount: 4762,
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
      candidateSha256: "79e5209546b290ad86205032cb7b5db7c332ffd4b1092f261cd59260ccf056d9",
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
  const result = buildLk1EnforcementCandidate(
    structuredClone(verified.source),
    verified.sourceSha256,
  );
  const candidateText = `${JSON.stringify(result.candidate, null, 2)}\n`;
  const report = {
    formatVersion: 1,
    ok: true,
    sourceKind: "live-147",
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(candidateText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: result.candidate.length,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
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
