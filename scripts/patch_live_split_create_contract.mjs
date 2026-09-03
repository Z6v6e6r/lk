#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const SOURCE_PATHS = Object.freeze({
  create: path.join(SCRIPT_DIR, "nodered_games_nodes", "fn_split_create_prepare.js"),
  join: path.join(SCRIPT_DIR, "nodered_games_nodes", "fn_split_join_prepare.js"),
  router: path.join(SCRIPT_DIR, "nodered_games_nodes", "fn_split_router.js"),
});

export const LIVE_SPLIT_CREATE_CONTRACT = Object.freeze({
  sourceFlowSha256: "0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e",
  targets: Object.freeze([
    Object.freeze({
      sourceKey: "create",
      id: "f3f9a60354d394da",
      name: "Prepare split game payment",
      type: "function",
      tabId: "4b91e2a2413688db",
      outputs: 4,
      wires: Object.freeze([
        Object.freeze(["ee7ba8cdd68bdf74"]),
        Object.freeze(["802af8a1810db60f"]),
        Object.freeze(["ef42932e1ba864b8"]),
        Object.freeze(["8f7bd5b482fe9763"]),
      ]),
      liveFuncSha256: "19a61024273a478f11bff3ff60c4601603c2af5bd7ec8ec08e4b83394ee7bd41",
      candidateFuncSha256: "9457e347545348447aa2f83d0fb1e774b41f712769de5eafb66e82989d7ee4cc",
    }),
  ]),
  restorations: Object.freeze([]),
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

function snapshotInvariants(flow) {
  const ids = flow.map((node) => node?.id);
  if (ids.some((id) => typeof id !== "string" || !id.trim())) {
    fail("Flow contains a node without a valid id");
  }
  if (new Set(ids).size !== ids.length) fail("Flow contains duplicate node ids");
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

function assertTargetNode(node, contract) {
  if (
    node.type !== contract.type
    || node.name !== contract.name
    || node.z !== contract.tabId
    || node.outputs !== contract.outputs
    || !isDeepStrictEqual(node.wires, contract.wires)
  ) {
    fail("Split create target node contract mismatch");
  }
  const liveFuncSha256 = sha256(String(node.func ?? ""));
  if (liveFuncSha256 !== contract.liveFuncSha256) {
    fail("Split create target function preimage mismatch");
  }
}

function assertRestorationNode(node, contract) {
  if (
    node.type !== contract.type
    || node.name !== contract.name
    || node.z !== contract.tabId
    || Object.hasOwn(node, contract.field)
    || sha256Json(node) !== contract.liveNodeSha256
  ) {
    fail(`Restoration target node contract mismatch: ${contract.id}`);
  }
}

export function applySplitCreateContract(
  inputFlow,
  candidateSources,
  contracts = LIVE_SPLIT_CREATE_CONTRACT.targets,
  restorations,
) {
  if (!Array.isArray(inputFlow)) fail("Node-RED flow must be an array");
  const targetContracts = Array.isArray(contracts) ? contracts : [contracts];
  const restorationContracts = restorations === undefined
    ? (contracts === LIVE_SPLIT_CREATE_CONTRACT.targets
      ? LIVE_SPLIT_CREATE_CONTRACT.restorations
      : [])
    : (Array.isArray(restorations) ? restorations : [restorations]);
  const sourceByKey = typeof candidateSources === "string"
    ? { [targetContracts[0]?.sourceKey || targetContracts[0]?.id]: candidateSources }
    : candidateSources;
  if (!sourceByKey || typeof sourceByKey !== "object") {
    fail("Split candidate sources must be provided");
  }

  const before = structuredClone(inputFlow);
  const candidate = structuredClone(inputFlow);
  const beforeInvariants = snapshotInvariants(before);
  const targetResults = targetContracts.map((contract) => {
    const sourceKey = contract.sourceKey || contract.id;
    const candidateSource = sourceByKey[sourceKey];
    if (typeof candidateSource !== "string" || !candidateSource.trim()) {
      fail(`Split candidate source is missing for ${sourceKey}`);
    }
    const candidateFuncSha256 = sha256(candidateSource);
    if (candidateFuncSha256 !== contract.candidateFuncSha256) {
      fail(`Tracked split candidate source mismatch for ${sourceKey}`);
    }
    const matches = candidate.filter((node) => node.id === contract.id);
    if (matches.length !== 1) {
      fail(`Split target node must exist exactly once: ${contract.id}`);
    }
    assertTargetNode(matches[0], contract);
    matches[0].func = candidateSource;
    return {
      id: contract.id,
      name: contract.name,
      fromFuncSha256: contract.liveFuncSha256,
      toFuncSha256: candidateFuncSha256,
    };
  });

  const restorationResults = restorationContracts.map((contract) => {
    const matches = candidate.filter((node) => node.id === contract.id);
    if (matches.length !== 1) {
      fail(`Restoration target node must exist exactly once: ${contract.id}`);
    }
    assertRestorationNode(matches[0], contract);
    matches[0][contract.field] = contract.candidateValue;
    const candidateNodeSha256 = sha256Json(matches[0]);
    if (candidateNodeSha256 !== contract.candidateNodeSha256) {
      fail(`Restoration candidate node mismatch: ${contract.id}`);
    }
    return {
      id: contract.id,
      name: contract.name,
      field: contract.field,
      value: contract.candidateValue,
      fromNodeSha256: contract.liveNodeSha256,
      toNodeSha256: candidateNodeSha256,
    };
  });

  const changedNodes = candidate.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  const expectedFieldsById = new Map([
    ...targetContracts.map((contract) => [contract.id, ["func"]]),
    ...restorationContracts.map((contract) => [contract.id, [contract.field]]),
  ]);
  const expectedChangedNodes = candidate.flatMap((node) => (
    expectedFieldsById.has(node.id)
      ? [{ id: node.id, changedFields: expectedFieldsById.get(node.id) }]
      : []
  ));
  if (!isDeepStrictEqual(changedNodes, expectedChangedNodes)) {
    fail("Candidate changed fields outside the reviewed split and restoration contract");
  }

  const afterInvariants = snapshotInvariants(candidate);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(beforeInvariants.wires, afterInvariants.wires)
    || !isDeepStrictEqual(beforeInvariants.links, afterInvariants.links)
    || !isDeepStrictEqual(beforeInvariants.routes, afterInvariants.routes)
  ) {
    fail("Candidate changed Node-RED topology or HTTP routes");
  }

  return {
    candidate,
    changedNodes,
    target: targetResults.length === 1 ? targetResults[0] : null,
    targets: targetResults,
    restorations: restorationResults,
    invariants: {
      nodeCount: candidate.length,
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
  if (path.resolve(outputArg) === path.resolve(reportArg)) {
    fail("Output and report must be distinct");
  }
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
  if (isWithin(REPO_ROOT, directory)) {
    fail("Publication directory must stay outside the repository");
  }
  if (isWithin(path.join(workspace, "input"), directory)) {
    fail("Publication directory must not alias verified input");
  }
  const stagePrefix = `.${path.basename(directory)}.split-create-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail("Partial split create publication exists");
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

export function publishSplitCreateContractCandidate({ workspace, output, report }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== LIVE_SPLIT_CREATE_CONTRACT.sourceFlowSha256) {
    fail("Live flow SHA does not match the reviewed split create preimage");
  }
  readVerifiedFlowBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const candidateSources = Object.fromEntries(
    Object.entries(SOURCE_PATHS).map(([key, sourcePath]) => [key, fs.readFileSync(sourcePath, "utf8")]),
  );
  const result = applySplitCreateContract(verified.source, candidateSources);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  const candidateSha256 = sha256(candidateBytes);
  const redactedReport = {
    formatVersion: 1,
    ok: true,
    mutationPerformed: false,
    sourceSha256: verified.sourceSha256,
    candidateSha256,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    targets: result.targets,
    restorations: result.restorations,
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
  console.log(`changedNodeCount=${result.changedNodes.length}`);
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
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  }
  if (!values["--workspace"] || !values["--output"] || !values["--report"]) {
    fail(
      "Usage: node scripts/patch_live_split_create_contract.mjs "
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
    publishSplitCreateContractCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
