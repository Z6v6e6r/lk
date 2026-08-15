#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_result_nodes");
const EXPECTED_SOURCE_SHA256 = "44f28ff517feffc871d6892f103e6b4d768c071158141e9171b80528089dd6bf";
const EXPECTED_NODE_COUNT = 4734;
const EXPECTED_ROUTE_COUNT = 211;
const TAB_ID = "4b91e2a2413688db";
const IDS = Object.freeze({
  authPrepare: "result_actor_auth_prepare_001",
  authRequest: "result_actor_auth_profile_request_001",
  authResolve: "result_actor_auth_profile_001",
});
const EXPECTED_PREIMAGE_HASHES = Object.freeze({
  [IDS.authPrepare]: "80cd10838aced3829abbe34e518d4c40e32205fc62c53b783433da2a9268530a",
  [IDS.authResolve]: "251b2922d85a12a30d667e7decde7cb527276598ada0746e707077457bf1145b",
});
const EXPECTED_CANDIDATE_HASHES = Object.freeze({
  "fn_result_auth_prepare.js": "5b484f63ecae43603da857c9142318c4893a646ce2095bf3f1c50f1d45b95dc0",
  "fn_result_auth_profile.js": "d4e1282def14cef2d61f099ab0b04ea2c89ebc65201c3611e3e0aff781dfbcc0",
});
const RESULT_ROUTES = Object.freeze([
  ["get", "/lk/games/:gameId/result/state"],
  ["post", "/lk/games/:gameId/result/submit"],
  ["post", "/lk/games/:gameId/result/confirm"],
  ["post", "/lk/games/:gameId/result/dispute"],
  ["post", "/lk/games/:gameId/result/revert"],
  ["post", "/lk/games/:gameId/result/accept-correction"],
  ["post", "/lk/games/:gameId/result/expire"],
  ["post", "/lk/games/:gameId/result/session/open"],
  ["patch", "/lk/games/:gameId/result/session/:sessionId"],
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const parseArgs = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]] = argv[index + 1];
  if (!values["--workspace"] || !values["--output"] || !values["--report"]) {
    fail("Usage: --workspace <verified-live-workspace> --output <candidate.json> --report <report.json>");
  }
  return values;
};
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1 || matches[0]?.type !== type) {
    fail(`Expected exact ${type} node ${id}`);
  }
  return matches[0];
};
const readCandidate = (fileName) => {
  const source = fs.readFileSync(path.join(FN_DIR, fileName), "utf8");
  if (sha256(source) !== EXPECTED_CANDIDATE_HASHES[fileName]) {
    fail(`Candidate source mismatch for ${fileName}`);
  }
  new Function("msg", "env", source);
  return source;
};
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((field) => !isDeepStrictEqual(before[field], after[field]))
  .sort();
const topologyIssues = (flow) => {
  const ids = new Set(flow.map((node) => node?.id).filter(Boolean));
  let brokenWires = 0;
  let brokenLinks = 0;
  flow.forEach((node) => {
    (Array.isArray(node?.wires) ? node.wires : []).flat().forEach((targetId) => {
      if (targetId && !ids.has(targetId)) brokenWires += 1;
    });
    for (const field of ["links", "scope"]) {
      (Array.isArray(node?.[field]) ? node[field] : []).forEach((targetId) => {
        if (targetId && !ids.has(targetId)) brokenLinks += 1;
      });
    }
  });
  return { brokenWires, brokenLinks };
};

const args = parseArgs(process.argv.slice(2));
const verified = verifyWorkspace(args["--workspace"], { quiet: true });
if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
if (verified.nodeCount !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
const flow = structuredClone(verified.source);
if (flow.filter((node) => node?.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
  fail("Live flow HTTP route count mismatch");
}
const tab = exactNode(flow, TAB_ID, "tab");
if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");
const before = structuredClone(flow);

const authPrepare = exactNode(flow, IDS.authPrepare, "function");
const authRequest = exactNode(flow, IDS.authRequest, "http request");
const authResolve = exactNode(flow, IDS.authResolve, "function");
if (authPrepare.outputs !== 2 || authResolve.outputs !== 6) fail("Result auth output contract mismatch");
if (!isDeepStrictEqual(authPrepare.wires, [[IDS.authRequest], ["da59c50f0f6e6908"]])) {
  fail("Result auth prepare wiring mismatch");
}
if (!isDeepStrictEqual(authRequest.wires, [[IDS.authResolve]])) {
  fail("Result auth request wiring mismatch");
}
for (const node of [authPrepare, authResolve]) {
  if (sha256(String(node.func ?? "")) !== EXPECTED_PREIMAGE_HASHES[node.id]) {
    fail(`Function preimage mismatch for ${node.id}`);
  }
}
for (const [method, url] of RESULT_ROUTES) {
  const route = flow.find((node) => (
    node?.z === TAB_ID && node?.type === "http in" && node?.method === method && node?.url === url
  ));
  if (!route || !isDeepStrictEqual(route.wires, [[IDS.authPrepare]])) {
    fail(`Result route auth wiring mismatch for ${method.toUpperCase()} ${url}`);
  }
}

authPrepare.func = readCandidate("fn_result_auth_prepare.js");
authResolve.func = readCandidate("fn_result_auth_profile.js");
authRequest.name = "Verify result actor via CUP JWT or Viva profile";

const changed = flow.flatMap((node, index) => {
  const fields = changedFields(before[index], node);
  return fields.length > 0 ? [{ id: node.id, type: node.type, name: node.name, fields }] : [];
});
const expectedChanges = [
  { id: IDS.authPrepare, fields: ["func"] },
  { id: IDS.authRequest, fields: ["name"] },
  { id: IDS.authResolve, fields: ["func"] },
];
for (const expected of expectedChanges) {
  const actual = changed.find((item) => item.id === expected.id);
  if (!actual || !isDeepStrictEqual(actual.fields, expected.fields)) {
    fail(`Unexpected candidate change for ${expected.id}`);
  }
}
if (changed.length !== expectedChanges.length) fail(`Unexpected changed node count: ${changed.length}`);
const topology = topologyIssues(flow);
if (topology.brokenWires !== 0 || topology.brokenLinks !== 0) {
  fail(`Broken candidate topology: ${JSON.stringify(topology)}`);
}

const serialized = `${JSON.stringify(flow, null, 2)}\n`;
const report = {
  sourceSha256: verified.sourceSha256,
  candidateSha256: sha256(serialized),
  nodeCount: flow.length,
  routeCount: flow.filter((node) => node?.type === "http in").length,
  ...topology,
  changed,
  rollout: {
    defaultTargets: "none",
    phaseOneTargets: "state",
    rollbackTargets: "none",
  },
};
fs.writeFileSync(path.resolve(args["--output"]), serialized, { mode: 0o600 });
fs.writeFileSync(path.resolve(args["--report"]), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
