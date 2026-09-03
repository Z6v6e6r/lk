import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPiterAtomicTopology,
  PITER_ATOMIC_TOPOLOGY_IDS,
} from "../lib/piterAtomicTopologyContract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = path.join(REPO_ROOT, "scripts/prepare_tournament_subscription_sales_candidate.mjs");
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
  return [
    { id: ids.atomicRouter, type: "function", z: ids.tab, name: "Route atomic Piter subscription sale", func: "return msg;", outputs: 5, wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]] },
    { id: ids.ledgerFind, type: "mongodb4", z: ids.tab, name: "Find Piter atomic inventory ledger", collection: "lk_tournament_subscription_sales", operation: "find", wires: [[ids.atomicRouter]] },
    { id: ids.ledgerUpdate, type: "mongodb4", z: ids.tab, name: "CAS Piter atomic inventory ledger", collection: "lk_tournament_subscription_sales", operation: "updateOne", wires: [[ids.atomicRouter]] },
    { id: ids.saleUpdate, type: "mongodb4", z: ids.tab, name: "Persist Piter atomic sale", collection: "lk_tournament_subscription_sales", operation: "updateOne", wires: [[ids.atomicRouter]] },
    { id: ids.mongoCatch, type: "catch", z: ids.tab, name: "Catch Piter atomic Mongo errors", scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate], uncaught: false, wires: [[ids.mongoError]] },
    { id: ids.mongoError, type: "function", z: ids.tab, name: "Redact Piter atomic Mongo error", func: "return msg;", outputs: 2, wires: [[ids.response], [ids.debug]] },
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
  assert.match(result.stderr, /Enabled legacy sales tab requires a separate exact-graph Piter topology contract/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
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
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.ledgerFind).collection = "wrong"; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoCatch).scope = []; },
    (flow) => { flow.find(({ id }) => id === PITER_ATOMIC_TOPOLOGY_IDS.mongoError).wires = [[], []]; },
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
