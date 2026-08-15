#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  PADLHUB_VIVA_USER_AGENT,
  isVivaHostname,
  validateVivaUserAgent,
} from "./lib/vivaUserAgent.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const MAX_UPSTREAM_DEPTH = 8;
const VIVA_HOST_LITERAL = /(^|[^a-z0-9.-])(?:[a-z0-9-]+\.)*vivacrm\.ru(?=$|[^a-z0-9.-])/i;

export const NODE_RED_USER_AGENT_HEADER = Object.freeze({
  keyType: "other",
  keyValue: "User-Agent",
  valueType: "other",
  valueValue: PADLHUB_VIVA_USER_AGENT,
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

function containsVivaHostLiteral(value) {
  return typeof value === "string" && VIVA_HOST_LITERAL.test(value);
}

function evidenceFields(node) {
  return [
    ["url", node?.url],
    ["func", node?.func],
    ["template", node?.template],
    ["payload", node?.payload],
    ["rules", Array.isArray(node?.rules) ? JSON.stringify(node.rules) : ""],
  ];
}

function nodeEvidence(node) {
  const fields = evidenceFields(node);
  const match = fields.find(([, value]) => containsVivaHostLiteral(value));
  return match ? { field: match[0] } : null;
}

function nodeHttpHostLiterals(node) {
  const hosts = new Set();
  for (const [, value] of evidenceFields(node)) {
    if (typeof value !== "string") continue;
    const matches = value.matchAll(/https?:\\?\/\\?\/([a-z0-9.-]+)(?=[:/\\?"'`]|$)/gi);
    for (const match of matches) hosts.add(match[1].toLowerCase().replace(/\.$/, ""));
  }
  return hosts;
}

function graphPredecessors(flow) {
  const predecessors = new Map();
  const add = (from, to) => {
    if (typeof from !== "string" || typeof to !== "string") return;
    if (!predecessors.has(to)) predecessors.set(to, new Set());
    predecessors.get(to).add(from);
  };
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const targetId of output ?? []) add(node.id, targetId);
    }
    if ((node.type === "link out" || node.type === "link call") && Array.isArray(node.links)) {
      for (const targetId of node.links) add(node.id, targetId);
    }
  }
  return predecessors;
}

export function discoverVivaHttpRequestNodes(flow, maxDepth = MAX_UPSTREAM_DEPTH) {
  if (!Array.isArray(flow)) fail("Node-RED flow must be an array");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 20) {
    fail("Viva discovery maxDepth must be an integer between 0 and 20");
  }
  const byId = new Map(flow.map((node) => [node.id, node]));
  const tabLabels = new Map(
    flow.filter((node) => node.type === "tab").map((node) => [node.id, node.label || node.id]),
  );
  const predecessors = graphPredecessors(flow);
  const targets = [];

  for (const requestNode of flow.filter((node) => node.type === "http request")) {
    const pending = [{ id: requestNode.id, depth: 0 }];
    const visited = new Set();
    const literalHosts = new Set();
    let evidence = null;

    while (pending.length > 0) {
      const current = pending.shift();
      if (visited.has(current.id) || current.depth > maxDepth) continue;
      visited.add(current.id);
      const node = byId.get(current.id);
      if (!node) continue;
      for (const hostname of nodeHttpHostLiterals(node)) literalHosts.add(hostname);
      const found = nodeEvidence(node);
      if (found && !evidence) {
        evidence = {
          nodeId: node.id,
          nodeType: node.type,
          field: found.field,
          depth: current.depth,
        };
      }
      if (current.depth === maxDepth) continue;
      for (const predecessorId of predecessors.get(current.id) ?? []) {
        const predecessor = byId.get(predecessorId);
        if (predecessor?.type === "http request" && predecessor.id !== requestNode.id) continue;
        pending.push({ id: predecessorId, depth: current.depth + 1 });
      }
    }

    if (evidence) {
      targets.push({
        id: requestNode.id,
        tabId: requestNode.z ?? "",
        tabLabel: tabLabels.get(requestNode.z) ?? requestNode.z ?? "",
        name: requestNode.name ?? "",
        evidence,
        nonVivaLiteralHosts: [...literalHosts]
          .filter((hostname) => !isVivaHostname(hostname))
          .sort(),
      });
    }
  }

  return targets.sort((left, right) => (
    left.tabLabel.localeCompare(right.tabLabel, "ru")
    || left.name.localeCompare(right.name, "ru")
    || left.id.localeCompare(right.id)
  ));
}

function discoverNameOnlyReviewNodes(flow, targetIds) {
  const tabLabels = new Map(
    flow.filter((node) => node.type === "tab").map((node) => [node.id, node.label || node.id]),
  );
  return flow
    .filter((node) => (
      node.type === "http request"
      && !targetIds.has(node.id)
      && /viva|crm/i.test(String(node.name ?? ""))
    ))
    .map((node) => ({
      id: node.id,
      tabId: node.z ?? "",
      tabLabel: tabLabels.get(node.z) ?? node.z ?? "",
      name: node.name ?? "",
    }))
    .sort((left, right) => (
      left.tabLabel.localeCompare(right.tabLabel, "ru")
      || left.name.localeCompare(right.name, "ru")
      || left.id.localeCompare(right.id)
    ));
}

function snapshotInvariants(flow) {
  const ids = flow.map((node) => node.id);
  if (new Set(ids).size !== ids.length) fail("Flow contains duplicate node IDs");
  const wires = flow.map((node) => ({
    id: node.id,
    wires: Object.hasOwn(node, "wires") ? node.wires : null,
  }));
  const links = flow.map((node) => ({
    id: node.id,
    links: Object.hasOwn(node, "links") ? node.links : null,
  }));
  const routes = flow
    .filter((node) => node.type === "http in")
    .map((node) => ({
      id: node.id,
      z: node.z ?? "",
      method: node.method ?? "",
      url: node.url ?? "",
      name: node.name ?? "",
      wires: node.wires ?? null,
    }));
  return {
    ids,
    wires,
    links,
    routes,
    hashes: {
      idsSha256: sha256Json(ids),
      wiresSha256: sha256Json(wires),
      linksSha256: sha256Json(links),
      httpRoutesSha256: sha256Json(routes),
    },
  };
}

function isUserAgentHeader(header) {
  return String(header?.keyValue ?? "").trim().toLowerCase() === "user-agent";
}

export function applyVivaUserAgent(flow, userAgent = PADLHUB_VIVA_USER_AGENT) {
  const validated = validateVivaUserAgent(userAgent);
  if (validated !== PADLHUB_VIVA_USER_AGENT) {
    fail(`Viva User-Agent must equal the project contract: ${PADLHUB_VIVA_USER_AGENT}`);
  }
  const before = structuredClone(flow);
  const beforeInvariants = snapshotInvariants(before);
  const targets = discoverVivaHttpRequestNodes(flow);
  if (targets.length === 0) fail("No Viva HTTP Request nodes were discovered");
  const targetIds = new Set(targets.map((target) => target.id));
  const nameOnlyReviewNodes = discoverNameOnlyReviewNodes(flow, targetIds);
  let alreadyCompliantNodeCount = 0;

  for (const target of targets) {
    const node = flow.find((candidate) => candidate.id === target.id);
    if (!node || node.type !== "http request") fail(`Viva target ${target.id} is not an HTTP Request node`);
    if (Object.hasOwn(node, "headers") && !Array.isArray(node.headers)) {
      fail(`Viva target ${target.id} has a non-array configured headers field`);
    }
    const headers = node.headers ?? [];
    const existing = headers.filter(isUserAgentHeader);
    if (existing.length > 1) fail(`Viva target ${target.id} has duplicate User-Agent headers`);
    if (existing.length === 1) {
      if (!isDeepStrictEqual(existing[0], NODE_RED_USER_AGENT_HEADER)) {
        fail(`Viva target ${target.id} has a conflicting User-Agent header`);
      }
      alreadyCompliantNodeCount += 1;
      continue;
    }
    node.headers = [...headers, { ...NODE_RED_USER_AGENT_HEADER }];
  }

  const changedNodes = flow.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  if (changedNodes.some((change) => (
    !targetIds.has(change.id) || !isDeepStrictEqual(change.changedFields, ["headers"])
  ))) {
    fail("Candidate changed nodes or fields outside discovered Viva request headers");
  }

  const afterInvariants = snapshotInvariants(flow);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(beforeInvariants.wires, afterInvariants.wires)
    || !isDeepStrictEqual(beforeInvariants.links, afterInvariants.links)
    || !isDeepStrictEqual(beforeInvariants.routes, afterInvariants.routes)
  ) {
    fail("Candidate changed Node-RED topology or HTTP routes");
  }

  return {
    candidate: flow,
    targets,
    nameOnlyReviewNodes,
    changedNodes,
    alreadyCompliantNodeCount,
    invariants: {
      nodeCount: flow.length,
      httpRouteCount: afterInvariants.routes.length,
      ...afterInvariants.hashes,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicationPaths(outputArg, reportArg, workspace) {
  if (!path.isAbsolute(outputArg) || !path.isAbsolute(reportArg)) {
    fail("Output and report paths must be absolute");
  }
  if (path.resolve(outputArg) === path.resolve(reportArg)) fail("Output and report must be distinct");
  const directory = path.dirname(path.resolve(outputArg));
  if (path.dirname(path.resolve(reportArg)) !== directory) {
    fail("Output and report must share one new publication directory");
  }
  const parentArg = path.dirname(directory);
  if (fs.existsSync(directory) || fs.lstatSync(parentArg).isSymbolicLink()) {
    fail("Publication directory must not already exist or use a symlink parent");
  }
  const parent = fs.realpathSync(parentArg);
  const canonicalDirectory = path.join(parent, path.basename(directory));
  const output = path.join(canonicalDirectory, path.basename(outputArg));
  const report = path.join(canonicalDirectory, path.basename(reportArg));
  if (canonicalDirectory !== directory || output !== outputArg || report !== reportArg) {
    fail("Output and report paths must be canonical");
  }
  if (isWithin(REPO_ROOT, directory)) fail("Publication directory must be outside the repository");
  if (isWithin(path.join(workspace, "input"), directory)) {
    fail("Publication directory must not alias the verified input");
  }
  const stagePrefix = `.${path.basename(directory)}.viva-user-agent-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail("Partial Viva User-Agent publication exists");
  }
  return { directory, parent, output, report, stagePrefix };
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

function readVerifiedFlowBytes(verified) {
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) {
    fail("Verified Node-RED source changed after verification");
  }
  return bytes;
}

export function publishVivaUserAgentCandidate({ workspace, output, report }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  readVerifiedFlowBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const result = applyVivaUserAgent(structuredClone(verified.source));
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  const candidateSha256 = sha256(candidateBytes);
  const redactedReport = {
    formatVersion: 1,
    ok: true,
    userAgent: PADLHUB_VIVA_USER_AGENT,
    sourceSha256: verified.sourceSha256,
    candidateSha256,
    discoveredNodeCount: result.targets.length,
    sharedDestinationNodeCount: result.targets.filter(
      (target) => target.nonVivaLiteralHosts.length > 0,
    ).length,
    nameOnlyReviewNodeCount: result.nameOnlyReviewNodes.length,
    nameOnlyReviewNodes: result.nameOnlyReviewNodes,
    changedNodeCount: result.changedNodes.length,
    alreadyCompliantNodeCount: result.alreadyCompliantNodeCount,
    changedNodes: result.changedNodes,
    targets: result.targets,
    invariants: result.invariants,
  };
  const stage = path.join(
    paths.parent,
    `${paths.stagePrefix}${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, path.basename(paths.output)), candidateBytes);
    writePrivate(
      path.join(stage, path.basename(paths.report)),
      Buffer.from(`${JSON.stringify(redactedReport, null, 2)}\n`, "utf8"),
    );
    fs.renameSync(stage, paths.directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  console.log(`sourceSha256=${verified.sourceSha256}`);
  console.log(`candidateSha256=${candidateSha256}`);
  console.log(`nodeCount=${result.invariants.nodeCount}`);
  console.log(`httpRouteCount=${result.invariants.httpRouteCount}`);
  console.log(`discoveredNodeCount=${result.targets.length}`);
  console.log(`sharedDestinationNodeCount=${redactedReport.sharedDestinationNodeCount}`);
  console.log(`nameOnlyReviewNodeCount=${redactedReport.nameOnlyReviewNodeCount}`);
  console.log(`changedNodeCount=${result.changedNodes.length}`);
  console.log(`alreadyCompliantNodeCount=${result.alreadyCompliantNodeCount}`);
  return redactedReport;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`Invalid argument: ${key ?? ""}`);
    }
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  const allowed = new Set(["--workspace", "--output", "--report"]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  if (!values["--workspace"] || !values["--output"] || !values["--report"]) {
    fail(
      "Usage: node scripts/patch_live_viva_user_agent.mjs "
      + "--workspace /absolute/external/workspace "
      + "--output /absolute/new-publication/candidate.json "
      + "--report /absolute/new-publication/report.json",
    );
  }
  return {
    workspace: values["--workspace"],
    output: values["--output"],
    report: values["--report"],
  };
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishVivaUserAgentCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
