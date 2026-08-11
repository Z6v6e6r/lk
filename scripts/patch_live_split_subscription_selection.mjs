#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const EXPECTED_SOURCE_SHA256 = "28a9a7da126452fda54642ce9e1fdf73dccdf09f00674dec559040f279cda08d";
const EXPECTED_NODE_COUNT = 4696;
const EXPECTED_HTTP_ROUTE_COUNT = 207;
const TAB_ID = "4b91e2a2413688db";

export const SPLIT_SUBSCRIPTION_SELECTION_TARGETS = Object.freeze([
  {
    id: "f3f9a60354d394da",
    name: "Prepare split game payment",
    fileName: "fn_split_create_prepare.js",
    outputs: 3,
    liveSha256: "d76e532d8f9d3cba655a4fabadf21635c85ed360a4bfac18534e10fef5661bfa",
    candidateSha256: "a62d72cdaec7bf50f023bf1fcebfb71453df5b02d638cf9793c63a98b112ea8e",
  },
  {
    id: "e92e68bf3f08a70c",
    name: "Prepare split join payment",
    fileName: "fn_split_join_prepare.js",
    outputs: 3,
    liveSha256: "707fdde66c340769a0c68e6e693bda22eb040b715ef33ad109e39c4709cea950",
    candidateSha256: "bf241c1197090e52a01e5414a81675cc19279fcb26f9231bb15914561401cc17",
  },
  {
    id: "8f7bd5b482fe9763",
    name: "Route Viva split payment",
    fileName: "fn_split_router.js",
    outputs: 4,
    liveSha256: "aba5f45ce45208997b188d5292194c49d357452673eee7b937650ec998348a04",
    candidateSha256: "a311b8ddc6e7752ee87deb278b25ac2ddc8fb9af8b273deea66b07702ac571c8",
  },
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

function exactNode(flow, id) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`Expected exact Node-RED node ${id}`);
  return matches[0];
}

function ensurePrivateParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
}

function writePrivateJson(filePath, value) {
  if (fs.existsSync(filePath)) fail(`Refusing to overwrite ${filePath}`);
  ensurePrivateParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export function buildSplitSubscriptionSelectionCandidate(source) {
  if (!Array.isArray(source)) fail("Node-RED source must be an array");
  if (source.length !== EXPECTED_NODE_COUNT) fail("Live Node-RED node count mismatch");
  if (source.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Live Node-RED HTTP route count mismatch");
  }

  const flow = structuredClone(source);
  const tab = exactNode(flow, TAB_ID);
  if (tab.type !== "tab" || tab.label !== "LK Games" || tab.disabled !== false) {
    fail("LK Games tab contract mismatch");
  }

  const importNodes = [];
  const changes = [];
  for (const target of SPLIT_SUBSCRIPTION_SELECTION_TARGETS) {
    const node = exactNode(flow, target.id);
    if (
      node.type !== "function"
      || node.z !== TAB_ID
      || node.name !== target.name
      || node.outputs !== target.outputs
      || !Array.isArray(node.wires)
      || node.wires.length !== target.outputs
    ) {
      fail(`Split subscription node contract mismatch: ${target.id}`);
    }
    if (sha256(String(node.func || "")) !== target.liveSha256) {
      fail(`Split subscription live preimage changed: ${target.id}`);
    }

    const candidateSource = fs.readFileSync(path.join(SOURCE_DIR, target.fileName), "utf8");
    if (sha256(candidateSource) !== target.candidateSha256) {
      fail(`Tracked split subscription source changed: ${target.fileName}`);
    }
    node.func = candidateSource;
    importNodes.push(structuredClone(node));
    changes.push({ id: target.id, name: target.name, changedFields: ["func"] });
  }

  const beforeById = new Map(source.map((node) => [node.id, node]));
  const changedNodes = flow.filter((node) => !isDeepStrictEqual(beforeById.get(node.id), node));
  if (changedNodes.length !== SPLIT_SUBSCRIPTION_SELECTION_TARGETS.length) {
    fail("Focused Node-RED change budget mismatch");
  }
  for (const node of changedNodes) {
    if (!SPLIT_SUBSCRIPTION_SELECTION_TARGETS.some((target) => target.id === node.id)) {
      fail(`Unexpected Node-RED node changed: ${node.id}`);
    }
    const before = beforeById.get(node.id);
    const changedFields = [...new Set([...Object.keys(before), ...Object.keys(node)])]
      .filter((key) => !isDeepStrictEqual(before[key], node[key]));
    if (!isDeepStrictEqual(changedFields, ["func"])) {
      fail(`Unexpected fields changed for ${node.id}: ${changedFields.join(",")}`);
    }
  }

  const byId = new Map(flow.map((node) => [node.id, node]));
  if (byId.size !== flow.length) fail("Candidate contains duplicate node ids");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!byId.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
  }
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Focused candidate changed HTTP routes");
  }

  return { flow, importNodes, changes };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  for (const required of ["--workspace", "--output", "--import", "--report"]) {
    if (!result[required]) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --import <nodes.import.json> --report <report.json>");
    }
  }
  return result;
}

export function runSplitSubscriptionSelectionBuild(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    fail("Live Node-RED source SHA changed; refresh and review before rebuilding");
  }
  const { flow, importNodes, changes } = buildSplitSubscriptionSelectionCandidate(verified.source);
  const outputPath = path.resolve(args["--output"]);
  const importPath = path.resolve(args["--import"]);
  const reportPath = path.resolve(args["--report"]);
  writePrivateJson(outputPath, flow);
  writePrivateJson(importPath, importNodes);
  const outputText = fs.readFileSync(outputPath);
  const importText = fs.readFileSync(importPath);
  const report = {
    caseId: "split-subscription-explicit-selection",
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    importSha256: sha256(importText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: flow.length,
    httpRouteCount: EXPECTED_HTTP_ROUTE_COUNT,
    changes,
    deploymentPerformed: false,
  };
  writePrivateJson(reportPath, report);
  return report;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runSplitSubscriptionSelectionBuild(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
