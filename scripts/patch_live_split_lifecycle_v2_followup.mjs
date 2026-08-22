#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");

export const CONTRACT = Object.freeze({
  flowSha256: "a86bb1bbb17cc4edc0e4842cafbfc9791af3cc7b03dfc99fd54df82b85c65427",
  nodeCount: 4762,
  httpRouteCount: 215,
  schedulerId: "lk_split_cleanup_scheduler_20260822",
  targets: [
    {
      id: "9508f8e0ae8d282a",
      name: "Prepare split cleanup tasks",
      source: "fn_split_cleanup_prepare.js",
      beforeFuncSha256: "2497fa430c26f392def7c4aec598deefda5db7c2a6ebbb57350731e1bd4673b5",
      afterFuncSha256: "3103198d1afee50199a11a84c90062706a06810146a59060ce982d6a1a306ad2",
    },
    {
      id: "bcc3dccf8d64f9bb",
      name: "Route split cleanup action",
      source: "fn_split_cleanup_router.js",
      beforeFuncSha256: "6b1eb915e6dd6da8977df8968a565946889b187ea9cdb1e15402c1caa3ec4381",
      afterFuncSha256: "b561ab102803cb5943fabb7b3ad2fcab8d83bbed9270552d22127dd8868ee9da",
    },
  ],
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

const topology = (flow) => flow.map((node) => ({
  id: node.id,
  z: node.z ?? "",
  wires: node.wires ?? [],
  links: Object.hasOwn(node, "links") ? node.links : null,
}));

const routes = (flow) => flow.filter((node) => node.type === "http in").map((node) => ({
  id: node.id,
  z: node.z ?? "",
  method: node.method ?? "",
  url: node.url ?? "",
  wires: node.wires ?? [],
}));

const brokenReferences = (flow) => {
  const ids = new Set(flow.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const targetId of output ?? []) if (!ids.has(targetId)) brokenWires += 1;
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) if (!ids.has(targetId)) brokenLinks += 1;
    }
  }
  return { brokenWires, brokenLinks };
};

export function buildCandidate(flow, sourceSha256, options = {}) {
  const contract = options.contract ?? CONTRACT;
  const sources = options.sources ?? Object.fromEntries(contract.targets.map((target) => [
    target.id,
    fs.readFileSync(path.join(SOURCE_DIR, target.source), "utf8"),
  ]));
  if (sourceSha256 !== contract.flowSha256) fail("Whole-flow preimage SHA mismatch");
  if (!Array.isArray(flow) || flow.length !== contract.nodeCount) fail("Flow node count mismatch");
  if (new Set(flow.map((node) => node.id)).size !== flow.length) fail("Flow contains duplicate node IDs");
  if (routes(flow).length !== contract.httpRouteCount) fail("HTTP route count mismatch");
  const schedulerMatches = flow.filter((node) => node.id === contract.schedulerId);
  if (schedulerMatches.length !== 1 || schedulerMatches[0].type !== "inject") {
    fail("Lifecycle scheduler contract mismatch");
  }

  const before = structuredClone(flow);
  const beforeTopology = topology(before);
  const beforeRoutes = routes(before);
  const changedNodes = [];
  for (const target of contract.targets) {
    const matches = flow.filter((node) => node.id === target.id);
    if (matches.length !== 1) fail(`${target.name} must exist exactly once`);
    const node = matches[0];
    if (node.type !== "function" || node.name !== target.name) fail(`${target.name} identity mismatch`);
    if (sha256(String(node.func ?? "")) !== target.beforeFuncSha256) {
      fail(`${target.name} function preimage mismatch`);
    }
    const source = sources[target.id];
    if (typeof source !== "string" || sha256(source) !== target.afterFuncSha256) {
      fail(`${target.name} source postimage mismatch`);
    }
    node.func = source;
    changedNodes.push({ id: target.id, name: target.name, changedFields: ["func"] });
  }

  if (!isDeepStrictEqual(topology(flow), beforeTopology)) fail("Candidate changed topology");
  if (!isDeepStrictEqual(routes(flow), beforeRoutes)) fail("Candidate changed HTTP routes");
  const actualChanges = flow.flatMap((node, index) => {
    if (isDeepStrictEqual(node, before[index])) return [];
    const fields = [...new Set([...Object.keys(node), ...Object.keys(before[index])])]
      .filter((field) => !isDeepStrictEqual(node[field], before[index][field]))
      .sort();
    return [{ id: node.id, fields }];
  });
  const expectedChanges = contract.targets.map((target) => ({ id: target.id, fields: ["func"] }));
  if (!isDeepStrictEqual(actualChanges, expectedChanges)) fail("Candidate changed unexpected nodes or fields");
  const broken = brokenReferences(flow);
  if (broken.brokenWires || broken.brokenLinks) fail("Candidate contains broken references");
  return {
    candidate: flow,
    report: {
      ok: true,
      sourceSha256,
      nodeCount: flow.length,
      httpRouteCount: beforeRoutes.length,
      changedNodes,
      ...broken,
    },
  };
}

function parseArgs(argv) {
  if (argv.length % 2 !== 0) fail("Every argument must have a value");
  const allowed = new Set(["--input", "--output", "--report"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--")) fail(`Invalid argument: ${key ?? ""}`);
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (!values["--input"] || !values["--output"] || !values["--report"]) {
    fail("Usage: node scripts/patch_live_split_lifecycle_v2_followup.mjs --input FLOW --output CANDIDATE --report REPORT");
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args["--input"]);
  const outputPath = path.resolve(args["--output"]);
  const reportPath = path.resolve(args["--report"]);
  if (new Set([inputPath, outputPath, reportPath]).size !== 3) fail("Input, output and report paths must be distinct");
  if (fs.existsSync(outputPath) || fs.existsSync(reportPath)) fail("Output files must not exist");
  const bytes = fs.readFileSync(inputPath);
  const result = buildCandidate(JSON.parse(bytes.toString("utf8")), sha256(bytes));
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const report = { ...result.report, candidateSha256: sha256(candidateBytes) };
  let outputWritten = false;
  let reportWritten = false;
  try {
    fs.writeFileSync(outputPath, candidateBytes, { flag: "wx", mode: 0o600 });
    outputWritten = true;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    reportWritten = true;
  } catch (error) {
    if (reportWritten) fs.unlinkSync(reportPath);
    if (outputWritten) fs.unlinkSync(outputPath);
    throw error;
  }
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
