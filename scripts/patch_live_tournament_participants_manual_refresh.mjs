#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_tournament_participants_nodes");

export const TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT = Object.freeze({
  wholeFlowSha256: "cb109f305bf48ff5f6026b5ff0ef944a3cfd49e81da247c757a90f1a880f43a2",
  nodeCount: 4_673,
  httpRouteCount: 203,
  tab: {
    id: "f9575c8726e29196",
    type: "tab",
    label: "LK Tournaments",
    disabled: false,
  },
  ids: {
    getRoute: "e0836350a9474a78",
    validate: "4970937254c10761",
    adminBookings: "fbbb248557014e63",
    normalize: "efa2b09c651dac1f",
    split: "517cb87b7425ef66",
    clientRequest: "21d3e90986ed5b82",
    clientQueue: "lk_tournament_participants_client_queue_20260719",
    clientHttp: "8f038c84aa896ec2",
    attachRating: "0c63087697cb16c0",
    clientRelease: "lk_tournament_participants_client_release_20260719",
    join: "22d45839d507e03b",
    upstreamError: "lk_tournament_participants_upstream_error_20260719",
    cacheGate: "lk_tournament_participants_cache_gate_20260719",
    terminal: "lk_tournament_participants_terminal_20260719",
    response: "afef710ac9f58b69",
    refreshPost: "lk_tournament_participants_refresh_post_20260804",
    refreshPrepare: "lk_tournament_participants_refresh_prepare_20260804",
    refreshProfile: "lk_tournament_participants_refresh_profile_20260804",
    refreshAuthorize: "lk_tournament_participants_refresh_authorize_20260804",
    refreshOptions: "lk_tournament_participants_refresh_options_20260804",
    refreshOptionsFunction: "lk_tournament_participants_refresh_options_fn_20260804",
    refreshOptionsResponse: "lk_tournament_participants_refresh_options_response_20260804",
  },
  functionPreimages: {
    validate: "2c898a82fa3ec2f11bbefbd1b853000ee5d9292bb828bcc42d45117d835d0a42",
    normalize: "d36e997c64327784a208a268c9a67e5f4acf365662d15f160016bccb3f01ff88",
    clientRequest: "a41546b34fe8a1a3044a62faad11f6686377c5c911569fdc194afe06f4608365",
    clientQueue: "0cf99e35fa19a3158b158ae973d530218bd413edf8ac11c1f09c49936622a1b6",
    attachRating: "370fbebb6b687ce47b4c2c5625dd7623a02167ea24df147e66eb61fa994ed5b1",
    clientRelease: "3903297d9628969ec8a9aaf740505008bf98e7a6cc068cb21faca07594aab26d",
    upstreamError: "60210823825b6c089437ba93bfe160df80612a5321f54f1fe66fe8c58b1f5e0a",
    cacheGate: "b4ee19c47bdbacfcea79b3aa91977b30c02e14bedf85f67a7ed0fb5478c85c78",
    terminal: "2772af0a50c4ff0475179020417222d27e7aa296bf48ec2d0cc4e52139019429",
  },
  sources: {
    cacheGate: {
      file: "fn_cache_gate_v2.js",
      sha256: "9a32c0dffe5cf82b2298ec1ac5de5d8e695a44d732fe330c30a08745ad793785",
    },
    terminal: {
      file: "fn_terminal_v2.js",
      sha256: "66d3089bdf319be05dc3b45e41a64512b50b9126217732c7590ae6e6a0dbb43b",
    },
    refreshPrepare: {
      file: "fn_manual_refresh_prepare_v1.js",
      sha256: "6ca0f5a704d645b40c148914b45938858d6eeac8b531b7e89a9703d140c49be7",
    },
    refreshAuthorize: {
      file: "fn_manual_refresh_authorize_v1.js",
      sha256: "b1cb4f5dc09f0813e644c2be3500dc455305988572a817db57923aef3b715a14",
    },
    refreshOptions: {
      file: "fn_manual_refresh_options_v1.js",
      sha256: "f857f117d69555a1c6589c51dfdfe78d0202ae45e096c8e45f54412155f85ee5",
    },
  },
});

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactNode(flow, id, description) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`${description} ${id} must exist exactly once`);
  return matches[0];
}

function assertNode(node, expected, fields, description) {
  for (const field of fields) {
    if (!isDeepStrictEqual(node?.[field], expected[field])) {
      fail(`${description} ${node?.id || "unknown"} contract mismatch for ${field}`);
    }
  }
}

function assertFunctionHash(node, expectedHash, description) {
  if (sha256(String(node?.func || "")) !== expectedHash) {
    fail(`${description} ${node?.id || "unknown"} function preimage mismatch`);
  }
}

function readSources(contract) {
  return Object.fromEntries(Object.entries(contract.sources).map(([name, sourceContract]) => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, sourceContract.file), "utf8");
    if (sha256(source) !== sourceContract.sha256) {
      fail(`Source contract mismatch for ${sourceContract.file}`);
    }
    return [name, source];
  }));
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

function changedExistingNodes(before, after) {
  const afterById = new Map(after.map((node) => [node.id, node]));
  return before.flatMap((previous) => {
    const node = afterById.get(previous.id);
    if (!node || isDeepStrictEqual(previous, node)) return [];
    const fields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: previous.id, changedFields: fields }];
  });
}

export function buildTournamentParticipantRefreshCandidate(
  flow,
  sourceSha256,
  contract = TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT,
  providedSources = null,
) {
  if (!Array.isArray(flow)) fail("Node-RED flow must be an array");
  if (sourceSha256 !== contract.wholeFlowSha256) fail("Whole-flow preimage SHA mismatch");
  if (flow.length !== contract.nodeCount) fail("Flow node count mismatch");
  if (new Set(flow.map((node) => node.id)).size !== flow.length) fail("Flow contains duplicate node IDs");
  const routeCount = flow.filter((node) => node.type === "http in").length;
  if (routeCount !== contract.httpRouteCount) fail("HTTP route count mismatch");

  const ids = contract.ids;
  const tab = exactNode(flow, contract.tab.id, "LK Tournaments tab");
  assertNode(tab, contract.tab, ["id", "type", "label", "disabled"], "LK Tournaments tab");

  const expectedGraph = [
    [ids.getRoute, "http in", { method: "get", url: "/lk/tournaments/participants", wires: [[ids.cacheGate, "07131f07eb86f115"]] }],
    [ids.validate, "function", { outputs: 2, wires: [[ids.adminBookings, "91c4abd8f70de99a"], [ids.terminal]] }],
    [ids.adminBookings, "http request", { method: "use", wires: [[ids.normalize, "1f4650948e4789f3"]] }],
    [ids.normalize, "function", { outputs: 3, wires: [[ids.split], [ids.upstreamError], [ids.terminal]] }],
    [ids.split, "split", { wires: [[ids.clientRequest]] }],
    [ids.clientRequest, "function", { outputs: 2, wires: [[ids.join], [ids.clientQueue]] }],
    [ids.clientQueue, "function", { outputs: 2, wires: [[ids.clientHttp], [ids.join]] }],
    [ids.clientHttp, "http request", { method: "use", wires: [[ids.attachRating]] }],
    [ids.attachRating, "function", { outputs: 1, wires: [[ids.clientRelease, "0172ee848e9f2364"]] }],
    [ids.clientRelease, "function", { outputs: 2, wires: [[ids.clientHttp], [ids.join]] }],
    [ids.join, "join", { wires: [[ids.terminal, "07de41d59cc86a90"]] }],
    [ids.upstreamError, "function", { outputs: 1, wires: [[ids.terminal]] }],
    [ids.cacheGate, "function", { outputs: 2, wires: [[ids.validate], [ids.terminal]] }],
    [ids.terminal, "function", { outputs: 1, wires: [[ids.response]] }],
    [ids.response, "http response", { wires: [] }],
  ];
  for (const [id, type, fields] of expectedGraph) {
    const node = exactNode(flow, id, "Participants graph node");
    assertNode(node, { id, type, z: contract.tab.id, ...fields }, [
      "id",
      "type",
      "z",
      ...Object.keys(fields),
    ], "Participants graph node");
  }
  for (const [name, expectedHash] of Object.entries(contract.functionPreimages)) {
    assertFunctionHash(exactNode(flow, ids[name], "Participants function"), expectedHash, name);
  }

  const refreshUrl = "/lk/tournaments/participants/refresh";
  if (flow.some((node) => node.type === "http in" && node.url === refreshUrl)) {
    fail("Manual participant refresh route already exists");
  }
  for (const id of [
    ids.refreshPost,
    ids.refreshPrepare,
    ids.refreshProfile,
    ids.refreshAuthorize,
    ids.refreshOptions,
    ids.refreshOptionsFunction,
    ids.refreshOptionsResponse,
  ]) {
    if (flow.some((node) => node.id === id)) fail(`New node ID already exists: ${id}`);
  }

  const sources = providedSources || readSources(contract);
  for (const [name, sourceContract] of Object.entries(contract.sources)) {
    if (typeof sources[name] !== "string" || sha256(sources[name]) !== sourceContract.sha256) {
      fail(`Approved source missing or drifted: ${name}`);
    }
  }

  const before = structuredClone(flow);
  exactNode(flow, ids.cacheGate, "Participants cache gate").func = sources.cacheGate;
  exactNode(flow, ids.terminal, "Participants terminal").func = sources.terminal;
  flow.push(
    {
      id: ids.refreshPost,
      type: "http in",
      z: contract.tab.id,
      name: "Refresh one tournament participant roster",
      url: refreshUrl,
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 220,
      y: 1320,
      wires: [[ids.refreshPrepare]],
    },
    {
      id: ids.refreshPrepare,
      type: "function",
      z: contract.tab.id,
      name: "Validate refresh + build Viva profile request",
      func: sources.refreshPrepare,
      outputs: 2,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 570,
      y: 1320,
      wires: [[ids.refreshProfile], [ids.response]],
    },
    {
      id: ids.refreshProfile,
      type: "http request",
      z: contract.tab.id,
      name: "Verify tournament organizer via Viva profile",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      tls: "",
      persist: false,
      proxy: "",
      insecureHTTPParser: false,
      authType: "",
      senderr: true,
      headers: [],
      x: 930,
      y: 1320,
      wires: [[ids.refreshAuthorize]],
    },
    {
      id: ids.refreshAuthorize,
      type: "function",
      z: contract.tab.id,
      name: "Authorize tournament participant refresh",
      func: sources.refreshAuthorize,
      outputs: 2,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1_280,
      y: 1320,
      wires: [[ids.cacheGate], [ids.response]],
    },
    {
      id: ids.refreshOptions,
      type: "http in",
      z: contract.tab.id,
      name: "Tournament participant refresh CORS",
      url: refreshUrl,
      method: "options",
      upload: false,
      swaggerDoc: "",
      x: 240,
      y: 1380,
      wires: [[ids.refreshOptionsFunction]],
    },
    {
      id: ids.refreshOptionsFunction,
      type: "function",
      z: contract.tab.id,
      name: "Tournament participant refresh OPTIONS",
      func: sources.refreshOptions,
      outputs: 1,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 610,
      y: 1380,
      wires: [[ids.refreshOptionsResponse]],
    },
    {
      id: ids.refreshOptionsResponse,
      type: "http response",
      z: contract.tab.id,
      name: "Tournament participant refresh OPTIONS response",
      x: 980,
      y: 1380,
      wires: [],
    },
  );

  const existingChanges = changedExistingNodes(before, flow);
  const expectedExistingChanges = [
    { id: ids.cacheGate, changedFields: ["func"] },
    { id: ids.terminal, changedFields: ["func"] },
  ];
  if (!isDeepStrictEqual(existingChanges, expectedExistingChanges)) {
    fail("Candidate changed existing nodes or fields outside the approved functions");
  }
  const addedNodes = flow.slice(before.length);
  const expectedAddedIds = [
    ids.refreshPost,
    ids.refreshPrepare,
    ids.refreshProfile,
    ids.refreshAuthorize,
    ids.refreshOptions,
    ids.refreshOptionsFunction,
    ids.refreshOptionsResponse,
  ];
  if (!isDeepStrictEqual(addedNodes.map((node) => node.id), expectedAddedIds)) {
    fail("Candidate appended unexpected nodes");
  }
  if (new Set(flow.map((node) => node.id)).size !== flow.length) fail("Candidate contains duplicate node IDs");
  const refreshRoutes = flow.filter((node) => node.type === "http in" && node.url === refreshUrl);
  if (
    refreshRoutes.length !== 2
    || refreshRoutes.filter((node) => node.method === "post").length !== 1
    || refreshRoutes.filter((node) => node.method === "options").length !== 1
  ) {
    fail("Candidate manual refresh route contract mismatch");
  }
  const afterRouteCount = flow.filter((node) => node.type === "http in").length;
  if (afterRouteCount !== contract.httpRouteCount + 2) fail("Candidate HTTP route count mismatch");
  const broken = countBrokenReferences(flow);
  if (broken.brokenWires !== 0 || broken.brokenLinks !== 0) {
    fail("Candidate contains broken Node-RED references");
  }

  return {
    candidate: flow,
    report: {
      formatVersion: 1,
      ok: true,
      sourceSha256,
      nodeCount: flow.length,
      httpRouteCount: afterRouteCount,
      existingChanges,
      addedNodes: addedNodes.map((node) => ({ id: node.id, type: node.type })),
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

function readVerifiedSourceBytes(verified) {
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) {
    fail("Verified Node-RED source changed after verification");
  }
  return sourceBytes;
}

export function publishTournamentParticipantRefreshCandidate({ workspace, outputDirectory }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  readVerifiedSourceBytes(verified);
  if (!path.isAbsolute(outputDirectory)) fail("Output directory must be absolute");
  const directory = path.resolve(outputDirectory);
  if (fs.existsSync(directory)) fail("Output directory must not already exist");
  if (isWithin(REPO_ROOT, directory)) fail("Output directory must be outside the repository");
  if (isWithin(path.join(verified.workspace, "input"), directory)) {
    fail("Output directory must not alias the verified input");
  }
  const parent = fs.realpathSync(path.dirname(directory));
  if (path.join(parent, path.basename(directory)) !== directory) fail("Output path must be canonical");

  const result = buildTournamentParticipantRefreshCandidate(
    structuredClone(verified.source),
    verified.sourceSha256,
  );
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, "utf8");
  const report = {
    ...result.report,
    sourceFreshnessSeconds: verified.freshnessSeconds,
    candidateSha256: sha256(candidateBytes),
  };
  const stage = path.join(
    parent,
    `.${path.basename(directory)}.participant-refresh-stage-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, "candidate.flow.json"), candidateBytes);
    writePrivate(path.join(stage, "report.json"), Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
    fs.renameSync(stage, directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  console.log(`sourceSha256=${report.sourceSha256}`);
  console.log(`candidateSha256=${report.candidateSha256}`);
  console.log(`sourceFreshnessSeconds=${report.sourceFreshnessSeconds}`);
  console.log(`nodeCount=${report.nodeCount}`);
  console.log(`httpRouteCount=${report.httpRouteCount}`);
  console.log(`changedNodeCount=${report.existingChanges.length + report.addedNodes.length}`);
  return report;
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
  const allowed = new Set(["--workspace", "--output-directory"]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  }
  if (!values["--workspace"] || !values["--output-directory"]) {
    fail(
      "Usage: node scripts/patch_live_tournament_participants_manual_refresh.mjs "
      + "--workspace /absolute/external/live-workspace "
      + "--output-directory /absolute/new-publication-directory",
    );
  }
  return {
    workspace: values["--workspace"],
    outputDirectory: values["--output-directory"],
  };
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishTournamentParticipantRefreshCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
