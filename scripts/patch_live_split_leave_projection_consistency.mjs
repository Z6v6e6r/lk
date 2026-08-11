#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const EXPECTED_SOURCE_SHA256 = "08d7c2f96fd4a4f5ed917a0c157024708965d53c92f6389dce84e02e4b31427e";
const EXPECTED_NODE_COUNT = 4707;
const EXPECTED_HTTP_ROUTE_COUNT = 209;
const TAB_ID = "4b91e2a2413688db";

export const SPLIT_LEAVE_PROJECTION_TARGET = Object.freeze({
  id: "lk_split_leave_game_update_build_20260801",
  name: "Build split leave game CAS",
  fileName: "fn_split_leave_game_update.js",
  outputs: 3,
  liveSha256: "a2ad7eee05e157a2672bd73a54a315205c5a3e14ba8ee4e00c32db0866d8c82d",
  candidateSha256: "8111395a5e34319e122158ef347fa37a994346c19f7c00424817e2cb11366354",
});

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

export function buildSplitLeaveProjectionCandidate(source) {
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

  const target = SPLIT_LEAVE_PROJECTION_TARGET;
  const node = exactNode(flow, target.id);
  if (
    node.type !== "function"
    || node.z !== TAB_ID
    || node.name !== target.name
    || node.outputs !== target.outputs
    || !Array.isArray(node.wires)
    || node.wires.length !== target.outputs
  ) {
    fail("Split leave projection node contract mismatch");
  }
  if (sha256(String(node.func || "")) !== target.liveSha256) {
    fail("Split leave projection live preimage changed");
  }

  const candidateSource = fs.readFileSync(path.join(SOURCE_DIR, target.fileName), "utf8");
  if (sha256(candidateSource) !== target.candidateSha256) {
    fail("Tracked split leave projection source changed");
  }
  node.func = candidateSource;

  const beforeById = new Map(source.map((item) => [item.id, item]));
  const changedNodes = flow.filter((item) => !isDeepStrictEqual(beforeById.get(item.id), item));
  if (changedNodes.length !== 1 || changedNodes[0].id !== target.id) {
    fail("Focused split leave projection change budget mismatch");
  }
  const before = beforeById.get(target.id);
  const changedFields = [...new Set([...Object.keys(before), ...Object.keys(node)])]
    .filter((key) => !isDeepStrictEqual(before[key], node[key]));
  if (!isDeepStrictEqual(changedFields, ["func"])) {
    fail(`Unexpected fields changed for ${target.id}: ${changedFields.join(",")}`);
  }

  const byId = new Map(flow.map((item) => [item.id, item]));
  if (byId.size !== flow.length) fail("Candidate contains duplicate node ids");
  for (const item of flow) {
    for (const targetId of (Array.isArray(item.wires) ? item.wires : []).flat()) {
      if (!byId.has(targetId)) fail(`Broken wire ${item.id} -> ${targetId}`);
    }
  }
  if (flow.filter((item) => item.type === "http in").length !== EXPECTED_HTTP_ROUTE_COUNT) {
    fail("Focused candidate changed HTTP routes");
  }

  return {
    flow,
    importNodes: [structuredClone(node)],
    changes: [{ id: target.id, name: target.name, changedFields: ["func"] }],
  };
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

export function runSplitLeaveProjectionBuild(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    fail("Live Node-RED source SHA changed; refresh and review before rebuilding");
  }
  const { flow, importNodes, changes } = buildSplitLeaveProjectionCandidate(verified.source);
  const outputPath = path.resolve(args["--output"]);
  const importPath = path.resolve(args["--import"]);
  const reportPath = path.resolve(args["--report"]);
  writePrivateJson(outputPath, flow);
  writePrivateJson(importPath, importNodes);
  const outputText = fs.readFileSync(outputPath);
  const importText = fs.readFileSync(importPath);
  const report = {
    caseId: "split-leave-projection-consistency",
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
    process.stdout.write(`${JSON.stringify(runSplitLeaveProjectionBuild(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
