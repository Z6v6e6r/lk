#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const TAB_ID = "4b91e2a2413688db";
const EXPECTED_SOURCE_SHA256 = "424d94bb6d7ef2ba9284de7d056c769b5bf73b8e948231d3794b6018e0bc232b";
const EXPECTED_NODE_COUNT = 4756;
const EXPECTED_HTTP_INPUT_COUNT = 215;

export const SUBSCRIPTION_RETURN_TARGETS = Object.freeze([
  ["7c280001a0c1e015", "Authorize split leave booking targets", "fn_split_leave_authorize.js", 5, "37ca0d9a981232f1cd5d2cce6259ec666168e372bd4dd1b8bd707e7c17ffe33d", "fc094bb87e77f41f2a8e4b02eaaf93430074e99ba7a3bfbe556f12c651a3e00b"],
  ["9878400d518ebcbd", "Route split leave booking cancel", "fn_split_leave_router.js", 5, "6d270142b759205835f67d14a3e7a21a6c4112b6418d60df4474834e928dd7fd", "fcf80d9a7b44ff6850013991f4bc6ae0541d6d4a00b2557c1d5a978e212fec1d"],
  ["lk_split_leave_operation_start_build_20260801", "Build durable split leave operation", "fn_split_leave_operation_start.js", 2, "25d73d9cac26469ff4e5bdc73b922e2d469db8939ea2114f1e60346cb0da21c0", "c7b8b2be039439417898e8217787c8aa9cdb15407204102b54acb4a9c9434359"],
  ["lk_split_leave_operation_route_20260801", "Route durable split leave operation", "fn_split_leave_operation_route.js", 4, "f62dd41ee4ffdeaa39ab61e1a413629d9ddb72b91945d6550f3859883ac03790", "d5649238cb4cbcd22cd72edafcea0b57691ac7d7a981e8b83d15a2218706326d"],
  ["lk_split_leave_operation_viva_build_20260801", "Persist Viva-confirmed split leave", "fn_split_leave_operation_viva_confirmed.js", 2, "e1c8af75fefa2f825d8bf859e493628b8bba21e28f6271c75acb669460960d50", "3306759ab7ecac3e434b1dd88fcb7a70c01f267f009060277237fff0a3f21b0d"],
  ["lk_split_leave_operation_viva_ack_20260801", "Acknowledge Viva-confirmed state", "fn_split_leave_operation_viva_ack.js", 3, "b7d649b24426f52213bb5b9a08bd633162156a379e21ea55591bec8c628ca21e", "43a5d0b6a3371c34419ef972d871be0e5f4f4bd4d8f1ecde54ef21f986284181"],
  ["lk_split_leave_game_update_build_20260801", "Build split leave game CAS", "fn_split_leave_game_update.js", 3, "f78d98c33ceab669f0db9844036c8ecb402d064f05506e55a5dd6aea5ca25203", "fa40192d2fd5373c06c0a7c47350994ab55235e39279f0f41347856b20c7d040"],
  ["lk_split_leave_operation_done_build_20260801", "Persist split leave LK applied and done", "fn_split_leave_operation_done.js", 2, "86c8292c3d9c511e8484950e067e3eb4ca8f42a70cf53f72a293c020c6d42e7b", "1da535b7e4edfdf50568d9d8a713cd58a60c8ace010e5037d3eb4a00302e402c"],
  ["lk_split_leave_operation_done_readback_20260801", "Verify split leave done readback", "fn_split_leave_operation_done_readback.js", 2, "e10a730fdbd0fad271287c2c46cd3383e2d6ebe08ae2d3d1c5a1ddcdf5c1488f", "1a5c2f084b5e12aaac081aa69fa5c1f1372adfda7cf10a4b631405818b50a62c"],
  ["lk_split_leave_finalize_20260801", "Finalize split leave consistency", "fn_split_leave_finalize.js", 2, "d245ae72f5b72319cdbe798a74a78216dd5c6a2c93391bf48a85fd47dc190719", "5af1a19c125c1094b911da0a62458237c0c50473351f197b611935c20bed8b19"],
  ["lk_split_leave_retry_query_20260801", "Build Viva-confirmed retry query", "fn_split_leave_retry_query.js", 1, "0ddc4ef15327b079874be277875f51a4cd831807a6451be566e8b2c1863c1c41", "e044fcc3512c87c14347e85d007d152a0ec58ae093abb26e53302aa783c35df7"],
  ["lk_split_leave_retry_select_20260801", "Claim Viva-confirmed split leave retry", "fn_split_leave_retry_select.js", 2, "3b41205b4f3dce04e59d8757de6ccc1423a36e6f78c95f654e54448021b7d991", "01cbc9a774dff77e86deb3a5dd6f85d8e237d865be4e13c94805b09476fa82ab"],
  ["lk_split_leave_retry_hydrate_20260801", "Hydrate split leave background retry", "fn_split_leave_retry_hydrate.js", 4, "a5ddd5f07bdf7773901901f532578550036cf2308e67d1b93e6f4d8f5888bc25", "dee3c8838ecda2d78418b6383d03365b387be7f02696187d2abb4101d9d34cbf"],
  ["lk_staff_player_leave_authorize_20260812", "Bind CUP staff leave to active membership", "fn_staff_player_leave_authorize.js", 2, "928f60aaa50bc1e25493ce4dd77429c8d9bc6e8a333115fbad530bae89cd090d", "faed3e292041d954c43939ac0c0f14a78fb45ddf8bf0a84cd931c15bb0db3751"],
].map(([id, name, fileName, outputs, liveSha256, candidateSha256]) => Object.freeze({
  id, name, fileName, outputs, liveSha256, candidateSha256,
})));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => !isDeepStrictEqual(before[key], after[key]));
const httpInputs = (nodes) => nodes.filter((node) => node.type === "http in")
  .map((node) => `${node.id}\u0000${node.method || ""}\u0000${node.url || ""}`).sort();

export function buildFocusedSubscriptionReturnCandidate(source, targets = SUBSCRIPTION_RETURN_TARGETS) {
  if (!Array.isArray(source)) fail("Node-RED source must be an array");
  const flow = structuredClone(source);
  const beforeById = new Map(source.map((node) => [node.id, node]));
  const flowById = new Map(flow.map((node) => [node.id, node]));
  if (beforeById.size !== source.length || flowById.size !== flow.length) fail("Duplicate node ids");

  for (const target of targets) {
    const before = beforeById.get(target.id);
    const node = flowById.get(target.id);
    if (!before || !node || before.type !== "function" || before.z !== TAB_ID
      || before.name !== target.name || before.outputs !== target.outputs
      || !Array.isArray(before.wires) || before.wires.length !== target.outputs) {
      fail(`Target node contract mismatch: ${target.id}`);
    }
    if (sha256(String(before.func || "")) !== target.liveSha256) {
      fail(`Live function preimage changed: ${target.id}`);
    }
    const candidateSource = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    if (sha256(candidateSource) !== target.candidateSha256) {
      fail(`Candidate source changed: ${target.fileName}`);
    }
    new Function("msg", "flow", "global", "node", "env", candidateSource);
    node.func = candidateSource;
  }

  const changes = flow.flatMap((node) => {
    const before = beforeById.get(node.id);
    if (isDeepStrictEqual(before, node)) return [];
    return [{ id: node.id, name: node.name, changedFields: changedFields(before, node) }];
  });
  const targetIds = new Set(targets.map((target) => target.id));
  if (changes.length !== targets.length
    || changes.some((change) => !targetIds.has(change.id)
      || !isDeepStrictEqual(change.changedFields, ["func"]))) {
    fail("Focused change budget mismatch");
  }
  if (!isDeepStrictEqual(httpInputs(source), httpInputs(flow))) fail("HTTP inputs changed");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!flowById.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) if (!flowById.has(targetId)) fail(`Broken link ${node.id} -> ${targetId}`);
    }
  }
  return { flow, importNodes: targets.map((target) => structuredClone(flowById.get(target.id))), changes };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values[key]) fail("Invalid arguments");
    values[key] = value;
  }
  const allowed = new Set(["--workspace", "--output", "--import", "--report"]);
  if (Object.keys(values).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !values[key])) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --import <nodes.json> --report <report.json>");
  }
  return values;
}

function prepareTargets(workspace, paths) {
  const resolved = paths.map((value) => path.resolve(value));
  if (new Set(resolved).size !== resolved.length) fail("Output paths must be distinct");
  for (const target of resolved) {
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Outputs must stay inside the live workspace");
    if (fs.existsSync(target) || fs.lstatSync(path.dirname(target), { throwIfNoEntry: false })?.isSymbolicLink()) {
      fail(`Refusing unsafe or existing output: ${target}`);
    }
  }
  const outputDirectory = path.dirname(resolved[0]);
  if (!resolved.every((target) => path.dirname(target) === outputDirectory)) fail("Outputs must share one directory");
  if (path.dirname(outputDirectory) !== workspace || path.basename(outputDirectory) !== "candidate-return") {
    fail("Outputs must use the workspace candidate-return directory");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  if (fs.realpathSync(outputDirectory) !== outputDirectory) fail("Candidate output directory must be canonical");
  return resolved;
}

function main(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256 || verified.nodeCount !== EXPECTED_NODE_COUNT) {
    fail("Fresh live source baseline changed");
  }
  if (verified.source.filter((node) => node.type === "http in").length !== EXPECTED_HTTP_INPUT_COUNT) {
    fail("Fresh live HTTP input count changed");
  }
  const tab = verified.source.filter((node) => node.id === TAB_ID && node.type === "tab");
  if (tab.length !== 1 || tab[0].label !== "LK Games" || tab[0].disabled === true) fail("LK Games tab contract mismatch");

  const built = buildFocusedSubscriptionReturnCandidate(verified.source);
  const [outputPath, importPath, reportPath] = prepareTargets(verified.workspace, [
    args["--output"], args["--import"], args["--report"],
  ]);
  const outputText = `${JSON.stringify(built.flow, null, 2)}\n`;
  const importText = `${JSON.stringify(built.importNodes, null, 2)}\n`;
  const report = {
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    importSha256: sha256(importText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    httpInputCount: EXPECTED_HTTP_INPUT_COUNT,
    changedNodeCount: built.changes.length,
    changes: built.changes,
    topologyChanged: false,
    routesChanged: false,
    deploymentPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(importPath, importText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
