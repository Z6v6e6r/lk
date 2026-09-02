#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const TAB_ID = "4b91e2a2413688db";
const EXPECTED_SOURCE_SHA256 = "14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350";
const EXPECTED_NODE_COUNT = 4762;
const EXPECTED_HTTP_ROUTE_COUNT = 215;

export const SPLIT_PRICING_RECOVERY_TARGETS = Object.freeze([
  Object.freeze({
    id: "e92e68bf3f08a70c",
    name: "Prepare split join payment",
    fileName: "fn_split_join_prepare.js",
    outputs: 4,
    wires: Object.freeze([
      Object.freeze(["ee7ba8cdd68bdf74"]),
      Object.freeze(["802af8a1810db60f"]),
      Object.freeze(["ef42932e1ba864b8"]),
      Object.freeze(["8f7bd5b482fe9763"]),
    ]),
    liveSha256: "70ec2bdfad08c71a1a1ef2d851c07918906573a3802ce9f41765837494c6f462",
    candidateSha256: "c05c7af19d3014ca48546871ea742ee347760bdd537cab5e6a67b428ee3d1b3e",
  }),
  Object.freeze({
    id: "8f7bd5b482fe9763",
    name: "Route Viva split payment",
    fileName: "fn_split_router.js",
    outputs: 5,
    wires: Object.freeze([
      Object.freeze(["ee7ba8cdd68bdf74"]),
      Object.freeze(["802af8a1810db60f"]),
      Object.freeze(["ef42932e1ba864b8"]),
      Object.freeze(["lk_subscription_booking_http_20260804"]),
      Object.freeze(["legacy_payment_confirm_canonical_prepare_20260816"]),
    ]),
    liveSha256: "cf913ca9201506bd1e84da974b6a3b604f76ac885de4202753c891f9460ecd3a",
    candidateSha256: "8b1829d1fb85b9644c29e48282d168ddf60f5552deaad04271107d1c357caad9",
  }),
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

const exactNode = (flow, id) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`Expected exact Node-RED node ${id}`);
  return matches[0];
};

const candidateSource = (target) => {
  const source = fs.readFileSync(path.join(SOURCE_DIR, target.fileName), "utf8");
  if (sha256(source) !== target.candidateSha256) {
    fail(`Tracked split pricing source changed: ${target.fileName}`);
  }
  return source;
};

export function applySplitPricingRecovery(source, targets = SPLIT_PRICING_RECOVERY_TARGETS) {
  if (!Array.isArray(source)) fail("Node-RED source must be an array");
  const flow = structuredClone(source);
  const beforeById = new Map(source.map((node) => [node.id, node]));
  const importNodes = [];
  const changes = [];

  for (const target of targets) {
    const node = exactNode(flow, target.id);
    if (
      node.type !== "function"
      || node.z !== TAB_ID
      || node.name !== target.name
      || node.outputs !== target.outputs
      || !isDeepStrictEqual(node.wires, target.wires)
    ) {
      fail(`Split pricing node contract mismatch: ${target.id}`);
    }
    if (sha256(String(node.func || "")) !== target.liveSha256) {
      fail(`Split pricing live preimage changed: ${target.id}`);
    }
    node.func = candidateSource(target);
    importNodes.push(structuredClone(node));
    changes.push({ id: target.id, name: target.name, changedFields: ["func"] });
  }

  const changedNodes = flow.filter((node) => !isDeepStrictEqual(beforeById.get(node.id), node));
  if (changedNodes.length !== targets.length) fail("Focused Node-RED change budget mismatch");
  for (const node of changedNodes) {
    if (!targets.some((target) => target.id === node.id)) {
      fail(`Unexpected Node-RED node changed: ${node.id}`);
    }
    const before = beforeById.get(node.id);
    const changedFields = [...new Set([...Object.keys(before), ...Object.keys(node)])]
      .filter((key) => !isDeepStrictEqual(before[key], node[key]));
    if (!isDeepStrictEqual(changedFields, ["func"])) {
      fail(`Unexpected fields changed for ${node.id}: ${changedFields.join(",")}`);
    }
  }

  return { flow, importNodes, changes };
}

const validateCandidate = (flow) => {
  if (flow.length !== EXPECTED_NODE_COUNT) fail("Live Node-RED node count mismatch");
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Live Node-RED HTTP route count mismatch");
  }
  const tab = exactNode(flow, TAB_ID);
  if (tab.type !== "tab" || tab.label !== "LK Games" || tab.disabled !== false) {
    fail("LK Games tab contract mismatch");
  }
  const ids = new Set(flow.map((node) => node.id));
  if (ids.size !== flow.length) fail("Candidate contains duplicate node ids");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!ids.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
  }
};

const writePrivateJson = (filePath, value) => {
  if (fs.existsSync(filePath)) fail(`Refusing to overwrite ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
};

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  for (const required of ["--workspace", "--output", "--import", "--report"]) {
    if (!result[required]) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --import <nodes.import.json> --report <report.json>");
    }
  }
  return result;
};

export function runSplitPricingRecoveryBuild(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    fail("Live Node-RED source SHA changed; refresh and review before rebuilding");
  }
  const { flow, importNodes, changes } = applySplitPricingRecovery(verified.source);
  validateCandidate(flow);
  const outputPath = path.resolve(args["--output"]);
  const importPath = path.resolve(args["--import"]);
  const reportPath = path.resolve(args["--report"]);
  if (new Set([outputPath, importPath, reportPath]).size !== 3) {
    fail("Candidate, import and report paths must be distinct");
  }
  writePrivateJson(outputPath, flow);
  writePrivateJson(importPath, importNodes);
  const report = {
    caseId: "split-pricing-direct-one-time-recovery",
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(fs.readFileSync(outputPath)),
    importSha256: sha256(fs.readFileSync(importPath)),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: flow.length,
    httpRouteCount: EXPECTED_HTTP_ROUTE_COUNT,
    changes,
    liveMutationPerformed: false,
    deploymentPerformed: false,
  };
  writePrivateJson(reportPath, report);
  return report;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runSplitPricingRecoveryBuild(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
