#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));

export const SPLIT_CLEANUP_READBACK_CONTRACT = Object.freeze({
  wholeFlowSha256: "4a5f3af35c5cb3f7b6e89e43b83437c8f8e1474060bfc07ff2502487e3417d9e",
  nodeCount: 4734,
  httpRouteCount: 211,
  targets: [
    {
      id: "bcc3dccf8d64f9bb",
      name: "Route split cleanup action",
      source: "fn_split_cleanup_router.js",
      nodeSha256: "fb37fdba59dce4af804facf3f99d6097a8214fb80716aafb35e99d13e5dd3cec",
      funcSha256: "73830d7576f59733c9cc5d194759db32d67b55192aee689cd5648c18a9d461f1",
      postFuncSha256: "ef80ddb8930e7e9e9146b799ab8a986a40efd2f7af79e16c5e4124d05b359e26",
    },
  ],
});

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function exactNode(flow, target) {
  const matches = flow.filter((node) => node?.id === target.id);
  if (matches.length !== 1) fail(`${target.name} must exist exactly once`);
  const node = matches[0];
  if (node.type !== "function" || node.name !== target.name) {
    fail(`${target.name} identity mismatch`);
  }
  if (sha256Json(node) !== target.nodeSha256) {
    fail(`${target.name} node preimage mismatch`);
  }
  if (sha256(String(node.func ?? "")) !== target.funcSha256) {
    fail(`${target.name} function preimage mismatch`);
  }
  return node;
}

function snapshot(flow) {
  return {
    ids: flow.map((node) => node.id),
    routes: flow
      .filter((node) => node.type === "http in")
      .map((node) => ({
        id: node.id,
        z: node.z ?? "",
        method: node.method ?? "",
        url: node.url ?? "",
        wires: node.wires ?? [],
      })),
    topology: flow.map((node) => ({
      id: node.id,
      z: node.z ?? "",
      wires: node.wires ?? [],
      links: Object.hasOwn(node, "links") ? node.links : null,
    })),
  };
}

function countBrokenReferences(flow) {
  const ids = new Set(flow.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const targetId of output ?? []) {
        if (!ids.has(targetId)) brokenWires += 1;
      }
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) {
        if (!ids.has(targetId)) brokenLinks += 1;
      }
    }
  }
  return { brokenWires, brokenLinks };
}

function readSource(target) {
  const sourcePath = path.join(SCRIPT_DIR, "nodered_games_nodes", target.source);
  return fs.readFileSync(sourcePath, "utf8");
}

export function buildSplitCleanupReadbackCandidate(
  flow,
  sourceSha256,
  contract = SPLIT_CLEANUP_READBACK_CONTRACT,
  sourcesById = null,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail("Whole-flow preimage SHA mismatch");
  if (!Array.isArray(flow) || flow.length !== contract.nodeCount) fail("Flow node count mismatch");
  if (new Set(flow.map((node) => node.id)).size !== flow.length) fail("Flow contains duplicate node IDs");

  const before = structuredClone(flow);
  const beforeSnapshot = snapshot(before);
  if (beforeSnapshot.routes.length !== contract.httpRouteCount) fail("HTTP route count mismatch");

  const changedNodes = [];
  for (const target of contract.targets) {
    const node = exactNode(flow, target);
    const source = sourcesById?.[target.id] ?? readSource(target);
    if (sha256(source) !== target.postFuncSha256) {
      fail(`${target.name} source postimage mismatch`);
    }
    if (source === node.func) fail(`${target.name} source does not contain a change`);
    node.func = source;
    changedNodes.push({
      id: target.id,
      name: target.name,
      changedFields: ["func"],
      sourceSha256: sha256(source),
    });
  }

  const afterSnapshot = snapshot(flow);
  if (!isDeepStrictEqual(beforeSnapshot.ids, afterSnapshot.ids)) fail("Candidate changed node IDs or order");
  if (!isDeepStrictEqual(beforeSnapshot.routes, afterSnapshot.routes)) fail("Candidate changed HTTP routes");
  if (!isDeepStrictEqual(beforeSnapshot.topology, afterSnapshot.topology)) fail("Candidate changed topology");
  const actualChanges = flow.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, fields }];
  });
  const expectedChanges = contract.targets.map((target) => ({ id: target.id, fields: ["func"] }));
  if (!isDeepStrictEqual(actualChanges, expectedChanges)) fail("Candidate changed unexpected nodes or fields");
  const broken = countBrokenReferences(flow);
  if (broken.brokenWires !== 0 || broken.brokenLinks !== 0) fail("Candidate contains broken references");

  return {
    candidate: flow,
    report: {
      formatVersion: 1,
      ok: true,
      sourceSha256,
      nodeCount: flow.length,
      httpRouteCount: afterSnapshot.routes.length,
      changedNodes,
      ...broken,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function writePrivate(filePath, value) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function publishSplitCleanupReadbackCandidate({ workspace, outputDirectory }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const directory = path.resolve(outputDirectory);
  if (!path.isAbsolute(outputDirectory)) fail("Output directory must be absolute");
  if (fs.existsSync(directory)) fail("Output directory must not already exist");
  if (isWithin(REPO_ROOT, directory)) fail("Output directory must be outside the repository");
  const parent = fs.realpathSync(path.dirname(directory));
  if (path.join(parent, path.basename(directory)) !== directory) fail("Output path must be canonical");

  const result = buildSplitCleanupReadbackCandidate(
    structuredClone(verified.source),
    verified.sourceSha256,
  );
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const report = {
    ...result.report,
    candidateSha256: sha256(candidateBytes),
  };
  const stage = path.join(
    parent,
    `.${path.basename(directory)}.split-cleanup-stage-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, "candidate.flow.json"), candidateBytes);
    writePrivate(path.join(stage, "report.json"), Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    fs.renameSync(stage, directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  console.log(`sourceSha256=${report.sourceSha256}`);
  console.log(`candidateSha256=${report.candidateSha256}`);
  console.log(`nodeCount=${report.nodeCount}`);
  console.log(`httpRouteCount=${report.httpRouteCount}`);
  console.log(`changedNodeCount=${report.changedNodes.length}`);
  return report;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) fail(`Invalid argument: ${key ?? ""}`);
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (!values["--workspace"] || !values["--output-directory"]) {
    fail("Usage: node scripts/patch_live_split_cleanup_readback.mjs --workspace PATH --output-directory PATH");
  }
  return {
    workspace: values["--workspace"],
    outputDirectory: values["--output-directory"],
  };
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishSplitCleanupReadbackCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
