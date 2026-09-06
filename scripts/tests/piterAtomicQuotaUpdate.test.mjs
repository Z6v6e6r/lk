import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPiterQuotaUpdate, preparePiterQuotaUpdate } from "../prepare_piter_atomic_quota_update.mjs";
import { PITER_QUOTA_UPDATE } from "../lib/piterAtomicQuotaUpdateContract.mjs";
import { PITER_ATOMIC_TOPOLOGY_IDS as ids, PITER_ATOMIC_BINDING_INITIALIZER_SOURCE,
  PITER_ATOMIC_ERROR_SOURCE } from "../lib/piterAtomicTopologyContract.mjs";
import { sha256, validateExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const sourceTexts = Object.fromEntries(PITER_QUOTA_UPDATE.targets.map(({ file }) =>
  [file, fs.readFileSync(new URL(`../nodered_games_nodes/${file}`, import.meta.url), "utf8")]));
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function fixture() {
  const live = [
    { id: ids.tab, type: "tab", label: "LK Tournaments", disabled: false },
    { id: "8ccb70ac6befff79", type: "tab", label: "Media2", disabled: true },
    { id: "c165e43eba668c25", type: "function", z: ids.tab, name: "Build tournament subscription status", outputs: 2, wires: [[], []], func: "return msg; // previous status" },
    { id: ids.purchaseRouter, type: "function", z: ids.tab, name: "Route tournament subscription payment", outputs: 5, wires: [[], [], [], [], [ids.atomicRouter]], func: "return msg;" },
    { id: ids.confirmResolve, type: "function", z: ids.tab, name: "Resolve tournament subscription confirm", outputs: 4, wires: [[], [], [], [ids.atomicRouter]], func: "return msg;" },
    { id: ids.atomicRouter, type: "function", z: ids.tab, name: "Route atomic Piter subscription sale", func: "return msg; // previous atomic", outputs: 5, timeout: "", noerr: 0, initialize: PITER_ATOMIC_BINDING_INITIALIZER_SOURCE, finalize: "", libs: [], x: 2750, y: 2240, wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]] },
    ...[[ids.ledgerFind, "Find Piter atomic inventory ledger", "find", 2180], [ids.ledgerUpdate, "CAS Piter atomic inventory ledger", "updateOne", 2220], [ids.saleUpdate, "Persist Piter atomic sale", "updateOne", 2260]].map(([id, name, operation, y]) =>
      ({ id, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", name, collection: "lk_tournament_subscription_sales", operation, output: "toArray", maxTimeMS: "5000", handleDocId: false, x: 3140, y, wires: [[ids.atomicRouter]] })),
    { id: ids.mongoCatch, type: "catch", z: ids.tab, name: "Catch Piter atomic Mongo errors", scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate], uncaught: false, x: 2780, y: 2320, wires: [[ids.mongoError]] },
    { id: ids.mongoError, type: "function", z: ids.tab, name: "Redact Piter atomic Mongo error", func: PITER_ATOMIC_ERROR_SOURCE, outputs: 2, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 3150, y: 2320, wires: [[ids.response], [ids.debug]] },
    { id: ids.mongoClient, type: "mongodb4-client", name: "Mongo", config: "fixture-owned-only" },
    { id: ids.viva, type: "http request", z: ids.tab },
    { id: ids.response, type: "http response", z: ids.tab },
    { id: ids.debug, type: "debug", z: ids.tab, name: "tournament subscription payment debug", active: false },
    { id: "unrelated-other-owner", type: "function", func: "return msg; // preserve me", wires: [[]] },
    { id: "fixture-http", type: "http in", url: "/fixture", method: "get", wires: [["unrelated-other-owner"]] },
  ];
  const candidate = structuredClone(live);
  for (const target of PITER_QUOTA_UPDATE.targets) candidate.find(n => n.id === target.id).func = sourceTexts[target.file];
  const expected = { ...PITER_QUOTA_UPDATE, sourceSha256: sha256(bytes(live)), candidateSha256: sha256(bytes(candidate)),
    sourceNodeCount: live.length, candidateNodeCount: live.length, httpInputCount: 1,
    targets: PITER_QUOTA_UPDATE.targets.map(target => ({ ...target,
      candidateSha256: sha256(sourceTexts[target.file]),
      sourceSha256: sha256(live.find(n => n.id === target.id).func) })) };
  return { live, expected, sourceTexts, liveBytes: bytes(live) };
}

test("existing atomic update changes only two function bodies and proves exact structural reverse", () => {
  const input = fixture(); const before = bytes(input.live);
  const built = buildPiterQuotaUpdate(input);
  assert.deepEqual(bytes(input.live), before);
  const candidate = JSON.parse(built.candidateBytes);
  const targets = new Set(input.expected.targets.map(t => t.id));
  for (const [index, node] of candidate.entries()) {
    if (!targets.has(node.id)) assert.deepEqual(node, input.live[index]);
    else assert.deepEqual({ ...node, func: input.live[index].func }, input.live[index]);
  }
  assert.deepEqual(built.contract.allowedAdditions, []);
  assert.equal(built.report.sourceNodeCount, built.report.candidateNodeCount);
  assert.equal(built.report.structuralReverseCheckPassed, true);
  assert.equal(built.report.rollbackAuthorized, false);
  assert.equal(built.report.deploymentPerformed, false);
  assert.equal(built.report.launchQuotaSchemaVersion, 2);
  assert.equal(built.report.contractSha256, sha256(bytes(built.contract)));
  assert.doesNotThrow(() => validateExactGraphContract({ liveBytes: input.liveBytes, candidateBytes: built.candidateBytes, contract: built.contract }));
});

test("source drift, partial installation, reapply, and changed local replacements fail closed", () => {
  const input = fixture(); const built = buildPiterQuotaUpdate(input);
  for (const mutate of [
    flow => { flow.at(-2).func += " // another owner"; },
    flow => { flow.splice(flow.findIndex(n => n.id === ids.ledgerFind), 1); },
    flow => { flow.find(n => n.id === ids.atomicRouter).outputs = 4; },
    flow => { flow.push({ ...flow[0] }); },
  ]) {
    const changed = structuredClone(input.live); mutate(changed);
    assert.throws(() => buildPiterQuotaUpdate({ ...input, liveBytes: bytes(changed) }), /source digest drift/);
  }
  assert.throws(() => buildPiterQuotaUpdate({ ...input, liveBytes: built.candidateBytes }), /source digest drift/);
  assert.throws(() => buildPiterQuotaUpdate({ ...input, sourceTexts: { ...sourceTexts,
    [input.expected.targets[0].file]: "return msg;" } }), /replacement digest drift/);
  assert.throws(() => buildPiterQuotaUpdate({ ...input, expected: { ...input.expected, candidateSha256: "0".repeat(64) } }), /candidate digest/);
});

test("integrated regional sources cannot use the historical two-function production updater pins", () => {
  const input = fixture();
  // Freeze fixture whole-flow identity, but retain the real production replacement
  // pins: the integrated sources MUST be refused rather than silently rebound.
  assert.throws(() => buildPiterQuotaUpdate({ ...input,
    expected: { ...input.expected, targets: input.expected.targets.map((target, index) => ({
      ...target, candidateSha256: PITER_QUOTA_UPDATE.targets[index].candidateSha256,
    })) } }), /replacement digest drift/);
});

test("topology and legacy guards remain mandatory even after fixture source digest rebinding", () => {
  for (const mutate of [
    flow => { flow.find(n => n.id === ids.ledgerUpdate).collection = "wrong"; },
    flow => { flow.find(n => n.id === "8ccb70ac6befff79").disabled = false; },
    flow => { flow.find(n => n.id === ids.debug).active = true; },
  ]) {
    const input = fixture(); mutate(input.live); input.liveBytes = bytes(input.live);
    input.expected.sourceSha256 = sha256(input.liveBytes);
    assert.throws(() => buildPiterQuotaUpdate(input), /Piter atomic topology precondition/);
  }
});

test("production CLI accepts no target/hash overrides and creates no output for invalid origin or stale evidence", () => {
  assert.throws(() => preparePiterQuotaUpdate(["--workspace", "/private/tmp", "--expected-sha", "fake"]), /Usage/);
  for (const stale of [false, true]) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "piter-quota-origin-"));
    fs.chmodSync(root, 0o700); fs.mkdirSync(path.join(root, "input"), { mode: 0o700 });
    const input = fixture(); const sourcePath = path.join(root, "input/source.flow.json");
    fs.writeFileSync(sourcePath, input.liveBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "input/source.flow.meta.json"), JSON.stringify({
      formatVersion: 1, sourceKind: stale ? "live-147" : "synthetic", sourceHost: "lk-primary-147",
      sourceUser: "root", sourcePort: "22", remoteFlowPath: "/root/.node-red/flows.json",
      localSourcePath: sourcePath, pulledAt: "2020-01-01T00:00:00.000Z",
      sourceSha256: input.expected.sourceSha256, nodeCount: input.live.length,
    }), { mode: 0o600 });
    assert.throws(() => preparePiterQuotaUpdate(["--workspace", root]), stale ? /stale/ : /metadata mismatch/);
    assert.equal(fs.existsSync(path.join(root, "build-piter-quota-update")), false);
  }
});
