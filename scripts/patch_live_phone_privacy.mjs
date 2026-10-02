#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertFlowArray, verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  responsePrivacySource, tournamentExportPrivacySource, tournamentRestorePrivacySource,
  communityRestorePrivacySource, resultRestorePrivacySource,
} from "./lib/publicPhonePrivacy.mjs";

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
export const PHONE_PRIVACY_CONTRACT = JSON.parse(fs.readFileSync(new URL("./phone_privacy_contract.json", import.meta.url), "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const exact = (nodes, id, type) => {
  const matches = nodes.filter((node) => node.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Unexpected privacy preimage node ${id}`);
  return matches[0];
};

export function buildPhonePrivacyCandidate(source, sourceSha256, contract = PHONE_PRIVACY_CONTRACT) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail("Privacy flow preimage SHA mismatch");
  assertFlowArray(source);
  if (source.length !== contract.nodeCount) fail("Privacy flow node count mismatch");
  const before = structuredClone(source);
  const flow = structuredClone(source);
  const originalRoutes = before.filter((node) => node.type === "http in");
  if (originalRoutes.length !== contract.httpRouteCount) fail("Privacy HTTP route count mismatch");
  const added = [];
  const changedWireIds = new Set();
  const privacyId = (responseId) => `phone_privacy_response_${responseId}`;
  function addFunction(id, anchor, name, func, wires, useCrypto = true) {
    if (flow.some((node) => node.id === id)) fail(`Privacy node already exists: ${id}`);
    const node = { id, type: "function", z: anchor.z, name, func, outputs: wires.length,
      timeout: "", noerr: 0, initialize: "", finalize: "",
      libs: useCrypto ? [{ var: "crypto", module: "crypto" }] : [],
      x: Number(anchor.x || 0) - 160, y: Number(anchor.y || 0) + 60, wires };
    flow.push(node); added.push(id); return node;
  }
  function replaceTarget(node, from, to) {
    let found = false;
    node.wires = (node.wires || []).map((output) => output.map((target) => {
      if (target !== from) return target;
      found = true; return to;
    }));
    if (!found) fail(`Missing reviewed edge ${node.id} -> ${from}`);
    changedWireIds.add(node.id);
  }
  // Egress is after cache hits and all existing success/error branches. Storage,
  // provider requests and authorization functions keep their original payloads.
  for (const id of contract.responseIds) {
    const response = exact(flow, id, "http response");
    const incoming = flow.filter((node) => (node.wires || []).some((output) => output.includes(id)));
    if (!incoming.length) fail(`Privacy response ${id} has no predecessor`);
    for (const node of incoming) replaceTarget(node, id, privacyId(id));
    addFunction(privacyId(id), response, "Project phone-free client response", responsePrivacySource(), [[id]]);
  }
  const tournament = contract.tournament;
  const saveRoute = exact(flow, tournament.saveRouteId, "http in");
  if (saveRoute.method !== "post" || saveRoute.url !== "/lk/tournaments/americano") fail("Unexpected tournament save route");
  const saveTarget = exact(flow, tournament.saveTargetId, "function");
  const findTemplate = exact(flow, tournament.findTemplateId, "mongodb4");
  if (findTemplate.collection !== "tournaments" || findTemplate.operation !== "find") fail("Unexpected tournament lookup");
  const prepareId = "phone_privacy_tournament_save_prepare";
  const findId = "phone_privacy_tournament_save_find";
  const restoreId = "phone_privacy_tournament_save_restore";
  replaceTarget(saveRoute, saveTarget.id, prepareId);
  addFunction(prepareId, saveTarget, "Read private tournament identity before resave", `
const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const id = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
  msg.statusCode = 400; msg.payload = { error: "tournamentId is invalid", code: "TOURNAMENT_ID_INVALID" };
  return [null, msg];
}
msg._phonePrivacyCommand = body;
msg.payload = { tournamentId: id };
return [msg, null];
`, [[findId], [privacyId(tournament.saveResponseId)]], false);
  if (flow.some((node) => node.id === findId)) fail("Privacy lookup node already exists");
  flow.push({ ...structuredClone(findTemplate), id: findId, name: "Read stored tournament private identity",
    maxTimeMS: "5000", wires: [[restoreId]], x: Number(saveTarget.x || 0), y: Number(saveTarget.y || 0) + 120 });
  added.push(findId);
  const lookupErrorId = "phone_privacy_tournament_lookup_error";
  const lookupCatchId = "phone_privacy_tournament_lookup_catch";
  if (flow.some((node) => node.id === lookupCatchId)) fail("Privacy lookup catch already exists");
  flow.push({ id: lookupCatchId, type: "catch", z: saveTarget.z, name: "Catch privacy identity lookup failure",
    scope: [findId], uncaught: false, x: Number(saveTarget.x || 0), y: Number(saveTarget.y || 0) + 180,
    wires: [[lookupErrorId]] });
  added.push(lookupCatchId);
  addFunction(lookupErrorId, saveTarget, "Fail closed before tournament write", `
delete msg._phonePrivacyCommand;
msg.statusCode = 503;
msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = { error: "Данные временно недоступны", code: "PUBLIC_IDENTITY_UNAVAILABLE" };
return msg;
`, [[privacyId(tournament.saveResponseId)]], false);
  addFunction(restoreId, saveTarget, "Resolve tournament public identities for resave", tournamentRestorePrivacySource("save"),
    [[saveTarget.id], [privacyId(tournament.saveResponseId)]]);
  const resultsTarget = exact(flow, tournament.resultsTargetId, "function");
  const resultsRestoreId = "phone_privacy_tournament_results_restore";
  replaceTarget(findTemplate, resultsTarget.id, resultsRestoreId);
  addFunction(resultsRestoreId, resultsTarget, "Resolve tournament public result identities", tournamentRestorePrivacySource("results"),
    [[resultsTarget.id], [privacyId(tournament.resultsResponseId)]]);
  const exportTarget = exact(flow, tournament.exportTargetId, "function");
  const exportMongo = exact(flow, tournament.exportMongoId, "mongodb4");
  const exportId = "phone_privacy_tournament_export";
  replaceTarget(exportMongo, exportTarget.id, exportId);
  addFunction(exportId, exportTarget, "Project private tournament before CSV or XLSX", tournamentExportPrivacySource(),
    [[exportTarget.id], [privacyId(tournament.exportResponseId)]]);
  for (const binding of contract.communityReads) {
    const mongo = exact(flow, binding.mongoId, "mongodb4");
    const target = exact(flow, binding.targetId, "function");
    if (mongo.collection !== "lk_communities" || mongo.operation !== "find") fail("Unexpected community lookup");
    const id = `phone_privacy_community_restore_${mongo.id}`;
    replaceTarget(mongo, target.id, id);
    addFunction(id, target, "Resolve community public member reference", communityRestorePrivacySource(binding.mode),
      [[target.id], [privacyId(binding.responseId)]]);
  }
  for (const binding of contract.resultReads) {
    const mongo = exact(flow, binding.mongoId, "mongodb4");
    const target = exact(flow, binding.targetId, "function");
    if (mongo.collection !== binding.collection || mongo.operation !== "find") fail("Unexpected result identity lookup");
    const id = `phone_privacy_result_restore_${binding.mode}`;
    replaceTarget(mongo, target.id, id);
    addFunction(id, target, "Resolve public lineup references without touching actor", resultRestorePrivacySource(binding.mode),
      [[target.id], [privacyId(binding.responseId)]]);
  }
  assertFlowArray(flow);
  const ids = new Set(flow.map((node) => node.id));
  for (const node of flow) for (const output of node.wires || []) for (const id of output) {
    if (!ids.has(id)) fail(`Broken privacy wire at ${node.id}`);
  }
  // Existing code, DB settings, providers, auth, routes and all foreign fields
  // are byte-for-byte unchanged; only the reviewed edges can move.
  for (const original of before) {
    const current = flow.find((node) => node.id === original.id);
    if (!current) fail("Privacy candidate deleted a node");
    if (!isDeepStrictEqual({ ...original, wires: null }, { ...current, wires: null })) fail(`Foreign field change at ${original.id}`);
    if (!changedWireIds.has(original.id) && !isDeepStrictEqual(current, original)) fail(`Foreign wire change at ${original.id}`);
  }
  const routes = flow.filter((node) => node.type === "http in");
  if (!isDeepStrictEqual(routes.map((route) => ({ ...route, wires: null })), originalRoutes.map((route) => ({ ...route, wires: null })))) fail("Privacy candidate changed HTTP contracts");
  for (const id of contract.responseIds) {
    const incoming = flow.filter((node) => (node.wires || []).some((output) => output.includes(id))).map((node) => node.id);
    if (!isDeepStrictEqual(incoming, [privacyId(id)])) fail(`Unfiltered response path remains: ${id}`);
  }
  return { candidate: flow, addedNodeIds: added, changedWireNodeIds: [...changedWireIds].sort() };
}

export function publishPhonePrivacyCandidate({ workspace, output, report }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) fail("Verified privacy preimage changed");
  if (!path.isAbsolute(output) || !path.isAbsolute(report) || output === report) fail("Distinct absolute output/report required");
  const directory = path.dirname(output);
  const parent = path.dirname(directory);
  if (directory !== path.dirname(report) || fs.existsSync(directory)) fail("Use one new external output directory");
  if (fs.realpathSync(parent) !== parent || directory.startsWith(root + path.sep) || directory === root
    || directory.startsWith(path.join(verified.workspace, "input") + path.sep)) fail("Outputs must be canonical and outside repository/input");
  const result = buildPhonePrivacyCandidate(verified.source, verified.sourceSha256);
  const candidateBytes = Buffer.from(JSON.stringify(result.candidate, null, 2) + "\n");
  const summary = { version: 1, sourceSha256: verified.sourceSha256, candidateSha256: sha256(candidateBytes),
    addedNodeIds: result.addedNodeIds, changedWireNodeIds: result.changedWireNodeIds,
    httpRoutesUnchanged: true, authCodeUnchanged: true, deploymentPerformed: false };
  const stage = fs.mkdtempSync(path.join(parent, ".phone-privacy-"));
  fs.chmodSync(stage, 0o700);
  try {
    fs.writeFileSync(path.join(stage, path.basename(output)), candidateBytes, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(stage, path.basename(report)), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(stage, directory);
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
  if (args.length !== 6 || !options["--workspace"] || !options["--output"] || !options["--report"]) {
    fail("Usage: patch_live_phone_privacy.mjs --workspace <private-live-workspace> --output <new-dir/candidate.json> --report <new-dir/report.json>");
  }
  process.stdout.write(JSON.stringify(publishPhonePrivacyCandidate({ workspace: options["--workspace"], output: options["--output"], report: options["--report"] })) + "\n");
}
