import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNoEnabledLegacyPiterSalesTab,
  assertPiterAtomicTopology,
  PITER_ATOMIC_ERROR_SOURCE,
  PITER_ATOMIC_TOPOLOGY_IDS,
  rejectTopologyDependentPiterSource,
} from "../lib/piterAtomicTopologyContract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = path.join(REPO_ROOT, "scripts/prepare_tournament_subscription_sales_candidate.mjs");
const ATOMIC_BUILDER = path.join(REPO_ROOT, "scripts/prepare_piter_atomic_sales_candidate.mjs");
const LEGACY_GENERATOR = path.join(REPO_ROOT, "scripts/patch_nodered_games_flow.mjs");
const MODULAR_SYNC = path.join(REPO_ROOT, "scripts/patch_nodered_games_modular_flow.mjs");
const FUNCTION_DIR = path.join(REPO_ROOT, "scripts/nodered_games_nodes");
const TARGETS = [
  ["519b6a6ca208e281", "Prepare tournament subscription counter refresh", "fn_tournament_subscription_counter_refresh_prepare.js"],
  ["d4901c31b37eab6b", "Build tournament subscription counters", "fn_tournament_subscription_counter_refresh_response.js"],
  ["8fdc7076a0c436a2", "Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["c165e43eba668c25", "Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["91dded2dc8cfebe4", "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["f8679e53edadc39b", "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["566ae4b886c37ae5", "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
  ["ab1e202650000002", "Prepare tournament subscription reconciliation", "fn_tournament_subscription_reconcile_query.js"],
];
const LEGACY_TARGETS = [
  ["945c1f1c113a56b6", "Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["ef90184a8c79cfc1", "Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["d1ab6ebf91540479", "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["4ff8867d897b1315", "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["af0b35cce2883ebd", "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
];
const roots = [];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function atomicTopologyNodes() {
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  const atomicRouterSource = fs.readFileSync(
    path.join(FUNCTION_DIR, "fn_tournament_subscription_piter_atomic_router.js"),
    "utf8",
  );
  return [
    { id: ids.atomicRouter, type: "function", z: ids.tab, name: "Route atomic Piter subscription sale", func: atomicRouterSource, outputs: 5, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 2750, y: 2240, wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]] },
    { id: ids.ledgerFind, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "find", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "Find Piter atomic inventory ledger", x: 3140, y: 2180, wires: [[ids.atomicRouter]] },
    { id: ids.ledgerUpdate, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "CAS Piter atomic inventory ledger", x: 3140, y: 2220, wires: [[ids.atomicRouter]] },
    { id: ids.saleUpdate, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "Persist Piter atomic sale", x: 3140, y: 2260, wires: [[ids.atomicRouter]] },
    { id: ids.mongoCatch, type: "catch", z: ids.tab, name: "Catch Piter atomic Mongo errors", scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate], uncaught: false, x: 2780, y: 2320, wires: [[ids.mongoError]] },
    { id: ids.mongoError, type: "function", z: ids.tab, name: "Redact Piter atomic Mongo error", func: PITER_ATOMIC_ERROR_SOURCE, outputs: 2, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 3150, y: 2320, wires: [[ids.response], [ids.debug]] },
    { id: ids.mongoClient, type: "mongodb4-client", name: "Mongo" },
    { id: ids.viva, type: "http request", z: ids.tab, name: "Viva" },
    { id: ids.response, type: "http response", z: ids.tab, name: "Response" },
    { id: ids.debug, type: "debug", z: ids.tab, name: "tournament subscription payment debug", active: false },
  ];
}

function validAtomicTopologyFlow() {
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  return [
    { id: ids.purchaseRouter, type: "function", z: ids.tab, name: "Route tournament subscription payment", outputs: 5, wires: [[], [], [], [], [ids.atomicRouter]] },
    ...atomicTopologyNodes(),
  ];
}

function createWorkspace({ approvedNodeDrift = false, duplicateLegacy = false, missingAtomicTopology = false, staleRouter = false, unknownDuplicate = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subscription-sales-candidate-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);

  const flow = [
    { id: "f9575c8726e29196", type: "tab", label: "LK Tournaments", disabled: false },
    ...TARGETS.map(([id, name, fileName]) => {
      const candidateSource = fs.readFileSync(path.join(FUNCTION_DIR, fileName), "utf8");
      const func = staleRouter && name === "Route tournament subscription payment"
        ? execFileSync("git", [
          "show",
          `d54144ea715516c00da9adcd229ec42ff8553881:${path.posix.join("scripts/nodered_games_nodes", fileName)}`,
        ], { cwd: REPO_ROOT, encoding: "utf8" })
        : approvedNodeDrift && name === "Prepare tournament subscription reconciliation"
          ? candidateSource.replace("network_friendship_12m_2026_v1", "unreviewed-drift")
        : candidateSource;
      return {
        id,
        type: "function",
        z: "f9575c8726e29196",
        name,
        func,
        outputs: name === "Route tournament subscription payment" && !missingAtomicTopology ? 5 : 4,
        wires: name === "Route tournament subscription payment" && !missingAtomicTopology
          ? [[], [], [], [], [PITER_ATOMIC_TOPOLOGY_IDS.atomicRouter]]
          : [[], [], [], []],
      };
    }),
    ...(missingAtomicTopology ? [] : atomicTopologyNodes()),
    { id: "8ccb70ac6befff79", type: "tab", label: "Media2", disabled: !duplicateLegacy },
    ...LEGACY_TARGETS.map(([id, name, fileName]) => ({
        id,
        type: "function",
        z: "8ccb70ac6befff79",
        name,
        func: fs.readFileSync(path.join(FUNCTION_DIR, fileName), "utf8"),
        outputs: name === "Route tournament subscription payment" ? 4 : (name.includes("status") ? 2 : 3),
        wires: [],
      })),
    ...(unknownDuplicate ? [
      { id: "tab-other", type: "tab", label: "Other", disabled: false },
      { id: "unknown-target", type: "function", z: "tab-other", name: TARGETS[0][1], func: "return msg;", wires: [] },
    ] : []),
    { id: "unrelated", type: "function", z: "f9575c8726e29196", name: "Unrelated", func: "return msg;", wires: [] },
  ];
  const sourcePath = path.join(input, "source.flow.json");
  const metaPath = path.join(input, "source.flow.meta.json");
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: "live-147",
    sourceHost: "lk-primary-147",
    sourceUser: "root",
    sourcePort: "22",
    remoteFlowPath: "/root/.node-red/flows.json",
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    nodeCount: flow.length,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { workspace, flow };
}

function runBuilder(workspace) {
  return spawnSync(process.execPath, [BUILDER, "--workspace", workspace], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function createAtomicBuilderWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piter-atomic-candidate-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  const targets = [
    ["c165e43eba668c25", "Build tournament subscription status", "fn_tournament_subscription_status_response.js", 2, "e320c39^"],
    ["91dded2dc8cfebe4", "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js", 3, "e320c39^"],
    ["f8679e53edadc39b", "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js", 3, "e320c39^"],
    ["ca022fd14027a5b0", "Resolve tournament subscription confirm", "fn_tournament_subscription_confirm_resolve.js", 3, "d54144ea715516c00da9adcd229ec42ff8553881"],
    [ids.purchaseRouter, "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js", 4, "e320c39^"],
  ];
  const flow = [
    { id: ids.tab, type: "tab", label: "LK Tournaments", disabled: false },
    ...targets.map(([id, name, fileName, outputs, revision]) => ({
      id,
      type: "function",
      z: ids.tab,
      name,
      func: execFileSync("git", ["show", `${revision}:${path.posix.join("scripts/nodered_games_nodes", fileName)}`], { cwd: REPO_ROOT, encoding: "utf8" }),
      outputs,
      wires: Array.from({ length: outputs }, () => []),
    })),
    { id: ids.mongoClient, type: "mongodb4-client", name: "Mongo" },
    { id: ids.viva, type: "http request", z: ids.tab, name: "Viva" },
    { id: ids.response, type: "http response", z: ids.tab, name: "Response" },
    { id: ids.debug, type: "debug", z: ids.tab, name: "tournament subscription payment debug", active: false },
  ];
  const sourcePath = path.join(input, "source.flow.json");
  const metaPath = path.join(input, "source.flow.meta.json");
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: "live-147",
    sourceHost: "lk-primary-147",
    sourceUser: "root",
    sourcePort: "22",
    remoteFlowPath: "/root/.node-red/flows.json",
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    nodeCount: flow.length,
  }, null, 2)}\n`, { mode: 0o600 });
  return workspace;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("builder accepts a partially synchronized flow and changes only the stale router", () => {
  const { workspace, flow } = createWorkspace({ staleRouter: true });
  const result = runBuilder(workspace);
  assert.equal(result.status, 0, result.stderr);

  const build = path.join(workspace, "build");
  const candidate = JSON.parse(fs.readFileSync(
    path.join(build, "tournament-subscription-sales.candidate.json"),
    "utf8",
  ));
  const report = JSON.parse(fs.readFileSync(
    path.join(build, "tournament-subscription-sales.report.json"),
    "utf8",
  ));
  assert.equal(report.targetNodeCount, 8);
  assert.equal(report.changedNodeCount, 1);
  assert.deepEqual(report.changedNodes.map(({ name }) => name), ["Route tournament subscription payment"]);

  const changed = candidate.flatMap((node, index) => (
    JSON.stringify(node) === JSON.stringify(flow[index]) ? [] : [{ id: node.id, fields: Object.keys(node).filter(
      (field) => JSON.stringify(node[field]) !== JSON.stringify(flow[index]?.[field]),
    ) }]
  ));
  assert.deepEqual(changed, [{ id: "566ae4b886c37ae5", fields: ["func"] }]);
  assert.match(candidate.find(({ id }) => id === "566ae4b886c37ae5").func, /REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE/);
  assert.equal(candidate.find(({ id }) => id === "unrelated").func, "return msg;");
});

test("builder fails closed on source drift inside an approved identity", () => {
  const { workspace } = createWorkspace({ approvedNodeDrift: true });
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tournament subscription target preimage mismatch: ab1e202650000002/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("builder rejects an enabled legacy sales tab without its own exact Piter topology", () => {
  const { workspace } = createWorkspace({ duplicateLegacy: true, staleRouter: true });
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enabled legacy Media2 requires a separate exact atomic topology contract/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("legacy and modular sync paths reject topology-dependent Piter function-only composition", () => {
  const currentRouter = fs.readFileSync(
    path.join(FUNCTION_DIR, "fn_tournament_subscription_purchase_router.js"),
    "utf8",
  );
  const previousRouter = execFileSync("git", [
    "show",
    "e320c39^:scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js",
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.throws(
    () => rejectTopologyDependentPiterSource(currentRouter, "fixture"),
    /cannot compose the topology-dependent Piter purchase router/,
  );
  assert.doesNotThrow(() => rejectTopologyDependentPiterSource(previousRouter, "fixture"));

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-piter-generator-")));
  roots.push(root);
  const result = spawnSync(process.execPath, [
    LEGACY_GENERATOR,
    path.join(root, "unused-source.json"),
    path.join(root, "must-not-exist.json"),
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot compose the topology-dependent Piter purchase router/);
  assert.equal(fs.existsSync(path.join(root, "must-not-exist.json")), false);

  const modularSource = fs.readFileSync(MODULAR_SYNC, "utf8");
  const topologyGate = modularSource.indexOf("assertPiterAtomicTopology(flow);");
  const legacyGate = modularSource.indexOf("assertNoEnabledLegacyPiterSalesTab(flow);");
  const routerReplacement = modularSource.indexOf('replaceAllFunctions(\n  "Route tournament subscription payment"');
  assert.ok(topologyGate > 0 && topologyGate < routerReplacement);
  assert.ok(legacyGate > topologyGate && legacyGate < routerReplacement);

  const enabledLegacy = [
    { id: "8ccb70ac6befff79", type: "tab", label: "Media2", disabled: false },
  ];
  assert.throws(
    () => assertNoEnabledLegacyPiterSalesTab(enabledLegacy),
    /enabled legacy Media2 requires a separate exact atomic topology contract/,
  );
});

test("builder rejects the atomic Piter functions when output five and ledger topology are absent", () => {
  const { workspace } = createWorkspace({ missingAtomicTopology: true, staleRouter: true });
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Piter atomic topology precondition failed/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("atomic topology contract rejects output, wire, ledger, catch, and error-route drift", () => {
  assert.doesNotThrow(() => assertPiterAtomicTopology(validAtomicTopologyFlow()));
  for (const mutate of [
    (flow) => { flow[0].outputs = 4; },
    (flow) => { flow[0].wires[4] = ["wrong"]; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.atomicRouter).wires[0] = []; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.atomicRouter).func = "return null;"; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.ledgerFind).collection = "wrong"; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.ledgerFind).clientNode = "wrong-db"; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoCatch).scope = []; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoError).wires = [[], []]; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoError).func = "return null;"; },
    (flow) => { flow.splice(flow.findIndex(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.viva), 1); },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.response).type = "debug"; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.debug).active = true; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoClient).type = "http request"; },
  ]) {
    const flow = validAtomicTopologyFlow();
    mutate(flow);
    assert.throws(() => assertPiterAtomicTopology(flow), /Piter atomic topology precondition failed/);
  }
});

test("builder fails closed on an unknown enabled same-name target", () => {
  const { workspace } = createWorkspace({ staleRouter: true, unknownDuplicate: true });
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected enabled tournament subscription target ids: unknown-target/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("builder fails closed when every target already matches", () => {
  const { workspace } = createWorkspace();
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /All tournament subscription sales functions already match/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("exact atomic builder emits a candidate that satisfies the shared topology contract", () => {
  const workspace = createAtomicBuilderWorkspace();
  const result = spawnSync(process.execPath, [ATOMIC_BUILDER, "--workspace", workspace], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(fs.readFileSync(
    path.join(workspace, "build-piter-atomic/candidate.flow.json"),
    "utf8",
  ));
  assert.doesNotThrow(() => assertPiterAtomicTopology(candidate));
  const report = JSON.parse(fs.readFileSync(
    path.join(workspace, "build-piter-atomic/report.json"),
    "utf8",
  ));
  assert.equal(report.ledgerActivationRequired, true);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.activationPerformed, false);
});
