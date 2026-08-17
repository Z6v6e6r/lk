#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const TARGETS = new Map([
  ["b274fa471d4654a3", { name: "Build community logo asset response", errorReturns: 4 }],
  ["9fa15a3c8d86528a", { name: "Build community logo thumb response", errorReturns: 4 }],
  ["75cd8607d472a975", { name: "Build legacy community logo response", errorReturns: 3 }],
  ["ea4db740fdcd920c", { name: "Build legacy community logo thumb response", errorReturns: 3 }],
  ["4573edfe3e109f3a", { name: "Build community logo asset response", errorReturns: 4 }],
  ["87fc796ba5710287", { name: "Build community logo thumb response", errorReturns: 4 }],
  ["335e7e97639670f2", { name: "Build legacy community logo response", errorReturns: 3 }],
  ["4ec662e1ded03673", { name: "Build legacy community logo thumb response", errorReturns: 3 }],
]);

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedFlowSha256 = String(getArg("--expected-flow-sha256") || "").toLowerCase();
if (!inputPath || !outputPath || !reportPath || !/^[a-f0-9]{64}$/.test(expectedFlowSha256)) {
  throw new Error(
    "Usage: node scripts/patch_live_community_media_responses.mjs --input <flow.json> "
    + "--output <candidate.json> --report <report.json> --expected-flow-sha256 <sha256>",
  );
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalizePath = (filePath) => {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) return fs.realpathSync(absolutePath);
  return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
};
const sameInode = (leftPath, rightPath) => {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
};
const input = canonicalizePath(inputPath);
const output = canonicalizePath(outputPath);
const reportFile = canonicalizePath(reportPath);
if (
  input === output || input === reportFile || output === reportFile
  || sameInode(input, output) || sameInode(input, reportFile) || sameInode(output, reportFile)
) throw new Error("Input, output, and report paths must be distinct");
if (fs.existsSync(output) || fs.existsSync(reportFile)) {
  throw new Error("Output and report destinations must not already exist");
}

const inputBytes = fs.readFileSync(input);
const flowSha256 = sha256(inputBytes);
if (flowSha256 !== expectedFlowSha256) {
  throw new Error(`Flow preimage mismatch: expected ${expectedFlowSha256}, got ${flowSha256}`);
}
const flow = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(flow)) throw new Error("Flow must be a JSON array");
const before = structuredClone(flow);
const byId = new Map(flow.map((node) => [node?.id, node]));

for (const [id, contract] of TARGETS) {
  const node = byId.get(id);
  if (!node || node.type !== "function" || node.name !== contract.name) {
    throw new Error(`Node identity mismatch for ${id}`);
  }
  if (node.outputs !== 2 || !Array.isArray(node.wires) || node.wires.length !== 2) {
    throw new Error(`Two-output media response contract mismatch for ${id}`);
  }
  const httpTargetIds = node.wires[0];
  const debugTargetIds = node.wires[1];
  if (httpTargetIds.length !== 1 || debugTargetIds.length !== 1) {
    throw new Error(`Media response wiring cardinality mismatch for ${id}`);
  }
  const httpTarget = byId.get(httpTargetIds[0]);
  const debugTarget = byId.get(debugTargetIds[0]);
  if (
    httpTarget?.type !== "http response" || debugTarget?.type !== "debug"
    || httpTarget.z !== node.z || debugTarget.z !== node.z
  ) throw new Error(`Media response wiring target mismatch for ${id}`);
  if (typeof node.func !== "string" || !node.func.includes("return [msg, msg];")) {
    throw new Error(`Media success response preimage mismatch for ${id}`);
  }
  const matches = node.func.match(/return \[null, errorMsg, errorMsg\];/g) || [];
  if (matches.length !== contract.errorReturns) {
    throw new Error(
      `Media error response preimage mismatch for ${id}: expected ${contract.errorReturns}, got ${matches.length}`,
    );
  }
  node.func = node.func.replaceAll(
    "return [null, errorMsg, errorMsg];",
    "return [errorMsg, errorMsg];",
  );
}

const ids = flow.map((node) => String(node?.id || ""));
if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
  throw new Error("Candidate contains missing or duplicate node IDs");
}
const knownIds = new Set(ids);
const brokenWires = [];
for (const node of flow) {
  for (const row of Array.isArray(node?.wires) ? node.wires : []) {
    for (const targetId of Array.isArray(row) ? row : []) {
      if (!knownIds.has(targetId)) brokenWires.push(`${node.id}->${targetId}`);
    }
  }
}
if (brokenWires.length > 0) throw new Error(`Candidate contains broken wires: ${brokenWires.join(", ")}`);
if (!isDeepStrictEqual(
  before.filter((node) => node?.type === "http in"),
  flow.filter((node) => node?.type === "http in"),
)) throw new Error("HTTP input routes changed");
for (let index = 0; index < before.length; index += 1) {
  if (TARGETS.has(before[index]?.id)) continue;
  if (!isDeepStrictEqual(before[index], flow[index])) {
    throw new Error(`Non-target preimage node changed: ${String(before[index]?.id)}`);
  }
}

const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
const candidateSha256 = sha256(Buffer.from(candidateText, "utf8"));
const report = {
  ok: true,
  flowSha256,
  candidateSha256,
  expectedFlowSha256,
  changedNodeIds: [...TARGETS.keys()],
  invariants: {
    sourceNodeCount: before.length,
    candidateNodeCount: flow.length,
    changedNodeCount: TARGETS.size,
    httpInputRoutesUnchanged: true,
    brokenWireCount: 0,
  },
};
const tempPath = (destination) => path.join(
  path.dirname(destination),
  `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
);
const outputTemp = tempPath(output);
const reportTemp = tempPath(reportFile);
const removeIfPresent = (filePath) => {
  try { fs.unlinkSync(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
};
let outputPublished = false;
let reportPublished = false;
try {
  fs.writeFileSync(outputTemp, candidateText, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportTemp, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.linkSync(reportTemp, reportFile);
  reportPublished = true;
  fs.linkSync(outputTemp, output);
  outputPublished = true;
} catch (error) {
  if (outputPublished) removeIfPresent(output);
  if (reportPublished) removeIfPresent(reportFile);
  throw error;
} finally {
  removeIfPresent(outputTemp);
  removeIfPresent(reportTemp);
}
console.log(JSON.stringify(report, null, 2));
