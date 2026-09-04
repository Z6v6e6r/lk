#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  BASE_GAME_CREATE_FUNC_SHA256,
  LIVE_GAME_CREATE_FUNC_SHA256,
  patchVivaGameCreateTenantRevisionBase,
} from "./lib/vivaGameCreateTenantRevisionContract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const TAB = Object.freeze({ id: "4b91e2a2413688db", type: "tab", label: "LK Games" });
const MONGO_ANCHOR = Object.freeze({
  id: "8b64bb43086a39e1",
  type: "mongodb4",
  z: TAB.id,
  name: "Find lk game by id",
  mode: "collection",
  collection: "lk_games",
  operation: "find",
  output: "toArray",
});
const GAME_CREATE_CONTRACT = Object.freeze({
  id: "e656cff36a8cd210",
  type: "function",
  z: TAB.id,
  name: "Prepare game upsert",
  outputs: 4,
  liveFuncSha256: LIVE_GAME_CREATE_FUNC_SHA256,
  baseFuncSha256: BASE_GAME_CREATE_FUNC_SHA256,
});

export const VIVA_GAME_PROJECTION_SYNC_IDS = Object.freeze({
  comment: "lk_viva_projection_sync_comment_20260903",
  inject: "lk_viva_projection_sync_inject_20260903",
  token: "lk_viva_projection_sync_token_20260903",
  tokenHttp: "lk_viva_projection_sync_token_http_20260903",
  storeToken: "lk_viva_projection_sync_store_token_20260903",
  query: "lk_viva_projection_sync_query_20260903",
  find: "lk_viva_projection_sync_find_20260903",
  group: "lk_viva_projection_sync_group_20260903",
  delay: "lk_viva_projection_sync_delay_20260903",
  providerHttp: "lk_viva_projection_sync_provider_http_20260903",
  resolve: "lk_viva_projection_sync_resolve_20260903",
  update: "lk_viva_projection_sync_update_20260903",
  ack: "lk_viva_projection_sync_ack_20260903",
  catch: "lk_viva_projection_sync_catch_20260903",
  error: "lk_viva_projection_sync_error_20260903",
  finalize: "lk_viva_projection_sync_finalize_20260903",
  diagnostic: "lk_viva_projection_sync_diagnostic_20260903",
});

export const VIVA_GAME_PROJECTION_SYNC_SOURCES = Object.freeze({
  token: "fn_viva_game_projection_sync_token.js",
  storeToken: "fn_viva_game_projection_sync_store_token.js",
  query: "fn_viva_game_projection_sync_query.js",
  group: "fn_viva_game_projection_sync_group.js",
  resolve: "fn_viva_game_projection_sync_resolve.js",
  ack: "fn_viva_game_projection_sync_write_ack.js",
  error: "fn_viva_game_projection_sync_error.js",
  finalize: "fn_viva_game_projection_sync_finalize.js",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), "utf8"));
const fail = (message) => { throw new Error(message); };
const readSource = (key) => fs.readFileSync(path.join(FN_DIR, VIVA_GAME_PROJECTION_SYNC_SOURCES[key]), "utf8");
export function patchVivaGameProjectionCreateContract(source) {
  return patchVivaGameCreateTenantRevisionBase(source);
}
const PRIVATE_KEY_MARKER = ["BEGIN", "PRIVATE", "KEY"].join(" ");
const MONGODB_CREDENTIAL_URI = /mongodb(?:\+srv)?:\/\/[^\s]+:[^\s]+@/i;

export const containsForbiddenInlineCredential = (source) => {
  const value = String(source || "");
  return /default_inline/i.test(value)
    || value.toUpperCase().includes(PRIVATE_KEY_MARKER)
    || MONGODB_CREDENTIAL_URI.test(value);
};

const exactNode = (flow, id, description) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`${description} ${id} must exist exactly once`);
  return matches[0];
};

const assertFields = (node, contract, description) => {
  for (const [field, expected] of Object.entries(contract)) {
    if (!isDeepStrictEqual(node?.[field], expected)) fail(`${description} contract mismatch for ${field}`);
  }
};

const functionNode = (id, name, sourceKey, outputs, wires, x, y) => ({
  id,
  type: "function",
  z: TAB.id,
  name,
  func: readSource(sourceKey),
  outputs,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});

const httpNode = (id, name, wires, x, y) => ({
  id,
  type: "http request",
  z: TAB.id,
  name,
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
  x,
  y,
  wires,
});

const snapshotExisting = (flow) => ({
  nodeCount: flow.length,
  nodeHashes: flow.map((node) => [node.id, sha256Json(node)]),
  routes: flow.filter((node) => node.type === "http in").map((node) => sha256Json(node)),
});

export function buildVivaGameProjectionSyncCandidate(source, sourceSha256) {
  if (!Array.isArray(source)) fail("Flow must be a JSON array");
  if (!/^[a-f0-9]{64}$/.test(String(sourceSha256 || ""))) fail("Source SHA-256 is required");
  const ids = source.map((node) => node?.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) fail("Source flow has missing or duplicate node IDs");
  const tab = exactNode(source, TAB.id, "LK Games tab");
  assertFields(tab, TAB, "LK Games tab");
  if (tab.disabled === true) fail("LK Games tab is disabled");
  const mongoAnchor = exactNode(source, MONGO_ANCHOR.id, "LK Games Mongo anchor");
  assertFields(mongoAnchor, MONGO_ANCHOR, "LK Games Mongo anchor");
  const clientNode = String(mongoAnchor.clientNode || "").trim();
  if (!clientNode) fail("LK Games Mongo anchor has no clientNode");
  const mongoClient = exactNode(source, clientNode, "LK Games Mongo client");
  if (mongoClient.type !== "mongodb4-client") fail("LK Games Mongo client type mismatch");
  const gameCreate = exactNode(source, GAME_CREATE_CONTRACT.id, "Game create function");
  assertFields(gameCreate, {
    id: GAME_CREATE_CONTRACT.id,
    type: GAME_CREATE_CONTRACT.type,
    z: GAME_CREATE_CONTRACT.z,
    name: GAME_CREATE_CONTRACT.name,
    outputs: GAME_CREATE_CONTRACT.outputs,
  }, "Game create function");
  for (const id of Object.values(VIVA_GAME_PROJECTION_SYNC_IDS)) {
    if (source.some((node) => node.id === id)) fail(`Candidate node ID already exists: ${id}`);
  }

  const before = structuredClone(source);
  const existing = snapshotExisting(before);
  const I = VIVA_GAME_PROJECTION_SYNC_IDS;
  const nodes = [
    {
      id: I.comment,
      type: "comment",
      z: TAB.id,
      name: "Viva -> LK game court projection reconciliation",
      info: "Reads future Viva exercises by date and CAS-updates only booking.roomId/roomName for exact linked LK games. Disabled unless VIVA_GAME_PROJECTION_SYNC_MODE is SHADOW or ENFORCE.",
      x: 360,
      y: 1840,
      wires: [],
    },
    {
      id: I.inject,
      type: "inject",
      z: TAB.id,
      name: "Reconcile Viva game court projections",
      props: [{ p: "payload" }, { p: "topic", vt: "str" }],
      repeat: "300",
      crontab: "",
      once: true,
      onceDelay: 45,
      topic: "",
      payload: "",
      payloadType: "date",
      x: 350,
      y: 1880,
      wires: [[I.token]],
    },
    functionNode(I.token, "Get Viva projection sync token", "token", 3, [[I.query], [I.tokenHttp], [I.diagnostic]], 680, 1880),
    httpNode(I.tokenHttp, "Viva projection sync token request", [[I.storeToken]], 990, 1920),
    functionNode(I.storeToken, "Store Viva projection sync token", "storeToken", 2, [[I.query], [I.diagnostic]], 1280, 1920),
    functionNode(I.query, "Build Viva game projection query", "query", 2, [[I.find], [I.diagnostic]], 990, 1840),
    {
      id: I.find,
      type: "mongodb4",
      z: TAB.id,
      clientNode,
      mode: "collection",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      maxTimeMS: "15000",
      limit: "1000",
      handleDocId: false,
      name: "Find games for Viva court reconciliation",
      x: 1320,
      y: 1840,
      wires: [[I.group]],
    },
    functionNode(I.group, "Group Viva game projections by date", "group", 2, [[I.delay], [I.diagnostic]], 1650, 1840),
    {
      id: I.delay,
      type: "delay",
      z: TAB.id,
      name: "Rate limit Viva game projection reads",
      pauseType: "rate",
      timeout: "1",
      timeoutUnits: "seconds",
      rate: "2",
      nbRateUnits: "1",
      rateUnits: "second",
      randomFirst: "1",
      randomLast: "5",
      randomUnits: "seconds",
      drop: false,
      allowrate: false,
      outputs: 1,
      x: 1970,
      y: 1840,
      wires: [[I.providerHttp]],
    },
    httpNode(I.providerHttp, "Read Viva exercises for game projection", [[I.resolve]], 2290, 1840),
    functionNode(I.resolve, "Resolve Viva game court projection", "resolve", 3, [[I.update], [I.delay], [I.finalize]], 2600, 1840),
    {
      id: I.update,
      type: "mongodb4",
      z: TAB.id,
      clientNode,
      mode: "collection",
      collection: "lk_games",
      operation: "updateOne",
      output: "toArray",
      maxTimeMS: "15000",
      handleDocId: false,
      name: "CAS update Viva game court projection",
      x: 2930,
      y: 1800,
      wires: [[I.ack]],
    },
    functionNode(I.ack, "Acknowledge Viva game court projection", "ack", 1, [[I.finalize]], 3260, 1800),
    {
      id: I.catch,
      type: "catch",
      z: TAB.id,
      name: "Catch Viva game projection sync errors",
      scope: [I.tokenHttp, I.find, I.providerHttp, I.update],
      uncaught: false,
      x: 2600,
      y: 1920,
      wires: [[I.error]],
    },
    functionNode(I.error, "Sanitize Viva game projection sync error", "error", 1, [[I.finalize]], 2930, 1920),
    functionNode(I.finalize, "Finalize Viva game projection sync run", "finalize", 1, [[I.diagnostic]], 3590, 1840),
    {
      id: I.diagnostic,
      type: "debug",
      z: TAB.id,
      name: "Viva game projection sync diagnostics",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 3930,
      y: 1880,
      wires: [],
    },
  ];

  const candidate = structuredClone(source);
  const candidateGameCreate = exactNode(candidate, GAME_CREATE_CONTRACT.id, "Candidate game create function");
  const gameCreateBeforeSha256 = sha256(String(candidateGameCreate.func || ""));
  candidateGameCreate.func = patchVivaGameProjectionCreateContract(String(candidateGameCreate.func || ""));
  const gameCreateAfterSha256 = sha256(candidateGameCreate.func);
  candidate.push(...nodes);
  const candidateById = new Map(candidate.map((node) => [node.id, node]));
  if (candidateById.size !== candidate.length) fail("Candidate contains duplicate node IDs");
  for (const node of candidate) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!candidateById.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
    if (node.type === "function" && node.wires.length !== Number(node.outputs)) {
      fail(`Function output/wire count mismatch for ${node.id}`);
    }
  }
  const afterExisting = snapshotExisting(candidate.slice(0, before.length));
  if (afterExisting.nodeCount !== existing.nodeCount) fail("Existing Node-RED node count changed");
  const beforeById = new Map(before.map((node) => [node.id, node]));
  for (const node of candidate.slice(0, before.length)) {
    const prior = beforeById.get(node.id);
    if (!prior) fail(`Unexpected existing node ${node.id}`);
    if (node.id === GAME_CREATE_CONTRACT.id) {
      const expected = { ...prior, func: candidateGameCreate.func };
      if (!isDeepStrictEqual(node, expected)) fail("Game create node changed outside func");
    } else if (!isDeepStrictEqual(node, prior)) {
      fail(`Undeclared existing node change: ${node.id}`);
    }
  }
  if (!isDeepStrictEqual(
    candidate.filter((node) => node.type === "http in"),
    before.filter((node) => node.type === "http in"),
  )) fail("HTTP routes changed");
  for (const node of [candidateGameCreate, ...nodes.filter((item) => item.type === "function")]) {
    if (containsForbiddenInlineCredential(node.func)) {
      fail(`Candidate function contains forbidden inline credential material: ${node.name}`);
    }
  }

  return {
    candidate,
    report: {
      ok: true,
      sourceSha256,
      sourceNodeCount: before.length,
      candidateNodeCount: candidate.length,
      httpRouteCount: before.filter((node) => node.type === "http in").length,
      changedNodes: gameCreateBeforeSha256 === gameCreateAfterSha256 ? [] : [{
        id: GAME_CREATE_CONTRACT.id,
        type: GAME_CREATE_CONTRACT.type,
        name: GAME_CREATE_CONTRACT.name,
        changedFields: ["func"],
        beforeFuncSha256: gameCreateBeforeSha256,
        afterFuncSha256: gameCreateAfterSha256,
      }],
      addedNodes: nodes.map((node) => ({ id: node.id, type: node.type, name: node.name })),
      sourceFunctions: Object.entries(VIVA_GAME_PROJECTION_SYNC_SOURCES).map(([key, file]) => ({
        key,
        file: path.posix.join("scripts/nodered_games_nodes", file),
        sha256: sha256(readSource(key)),
      })),
      invariants: {
        onlyDeclaredExistingNodeChanged: true,
        gameCreateTenantIsServerOwned: true,
        gameCreateRevisionIsNumeric: true,
        httpRoutesUnchanged: true,
        mongoClientReused: clientNode,
        defaultMode: "OFF",
        deploymentPerformed: false,
      },
    },
  };
}

const writePrivate = (filePath, value) => {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

export function publishVivaGameProjectionSyncCandidate({ workspace, outputDirectory }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (typeof outputDirectory !== "string" || !path.isAbsolute(outputDirectory)) {
    fail("Output directory must be absolute");
  }
  const requestedDirectory = path.resolve(outputDirectory);
  const requestedParent = path.dirname(requestedDirectory);
  const parentStat = fs.lstatSync(requestedParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("Output parent must be a real directory");
  }
  const parent = fs.realpathSync(requestedParent);
  if (parent !== requestedParent) fail("Output parent path must be canonical");
  const directory = path.join(parent, path.basename(requestedDirectory));
  const relativeToRepo = path.relative(REPO_ROOT, directory);
  if (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo)) {
    fail("Output directory must be outside the repository");
  }
  if (fs.existsSync(directory)) fail("Output directory must not already exist");
  const stage = path.join(parent, `.${path.basename(directory)}.viva-projection-stage-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    const result = buildVivaGameProjectionSyncCandidate(structuredClone(verified.source), verified.sourceSha256);
    const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
    const report = { ...result.report, candidateSha256: sha256(candidateBytes) };
    writePrivate(path.join(stage, "candidate.flow.json"), candidateBytes);
    writePrivate(path.join(stage, "report.json"), Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    fs.renameSync(stage, directory);
    console.log(`sourceSha256=${report.sourceSha256}`);
    console.log(`candidateSha256=${report.candidateSha256}`);
    console.log(`addedNodeCount=${report.addedNodes.length}`);
    return report;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

const parseArgs = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) fail(`Invalid argument: ${key || ""}`);
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  if (!values["--workspace"] || !values["--output-directory"]) {
    fail("Usage: node scripts/prepare_viva_game_projection_sync_candidate.mjs --workspace PATH --output-directory PATH");
  }
  return { workspace: values["--workspace"], outputDirectory: values["--output-directory"] };
};

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishVivaGameProjectionSyncCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
