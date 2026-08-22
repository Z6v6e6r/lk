import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = path.join(REPO_ROOT, "scripts/prepare_tournament_subscription_sales_candidate.mjs");
const FUNCTION_DIR = path.join(REPO_ROOT, "scripts/nodered_games_nodes");
const TARGETS = [
  ["Prepare tournament subscription counter refresh", "fn_tournament_subscription_counter_refresh_prepare.js"],
  ["Build tournament subscription counters", "fn_tournament_subscription_counter_refresh_response.js"],
  ["Prepare tournament subscription status", "fn_tournament_subscription_status_prepare.js"],
  ["Build tournament subscription status", "fn_tournament_subscription_status_response.js"],
  ["Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js"],
  ["Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js"],
  ["Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js"],
  ["Prepare tournament subscription reconciliation", "fn_tournament_subscription_reconcile_query.js"],
];
const roots = [];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function createWorkspace({ staleReconcile = false, staleRouter = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subscription-sales-candidate-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);

  const flow = [
    { id: "tab-tournaments", type: "tab", label: "LK Tournaments", disabled: false },
    ...TARGETS.map(([name, fileName], index) => {
      const candidateSource = fs.readFileSync(path.join(FUNCTION_DIR, fileName), "utf8");
      const func = staleRouter && name === "Route tournament subscription payment"
        ? candidateSource.replace(
          "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE",
          "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_LEGACY",
        )
        : staleReconcile && name === "Prepare tournament subscription reconciliation"
          ? candidateSource.replace(
            "network_friendship_12m_2026_v1",
            "network_friendship_12m_legacy_v1",
          )
        : candidateSource;
      return {
        id: `target-${index}`,
        type: "function",
        z: "tab-tournaments",
        name,
        func,
        outputs: 4,
        wires: [[], [], [], []],
      };
    }),
    { id: "unrelated", type: "function", z: "tab-tournaments", name: "Unrelated", func: "return msg;", wires: [] },
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
  assert.deepEqual(changed, [{ id: "target-6", fields: ["func"] }]);
  assert.match(candidate.find(({ id }) => id === "target-6").func, /REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE/);
  assert.equal(candidate.find(({ id }) => id === "unrelated").func, "return msg;");
});

test("builder changes only a stale regional subscription reconciliation query", () => {
  const { workspace, flow } = createWorkspace({ staleReconcile: true });
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
  assert.deepEqual(report.changedNodes.map(({ name }) => name), [
    "Prepare tournament subscription reconciliation",
  ]);

  const changed = candidate.flatMap((node, index) => (
    JSON.stringify(node) === JSON.stringify(flow[index]) ? [] : [{ id: node.id, fields: Object.keys(node).filter(
      (field) => JSON.stringify(node[field]) !== JSON.stringify(flow[index]?.[field]),
    ) }]
  ));
  assert.deepEqual(changed, [{ id: "target-7", fields: ["func"] }]);
  assert.match(candidate.find(({ id }) => id === "target-7").func, /REGIONAL_FRIENDSHIP_INVENTORIES/);
  assert.match(candidate.find(({ id }) => id === "target-7").func, /network_friendship_12m_2026_v1/);
  assert.equal(candidate.find(({ id }) => id === "unrelated").func, "return msg;");
});

test("builder fails closed when every target already matches", () => {
  const { workspace } = createWorkspace();
  const result = runBuilder(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /All tournament subscription sales functions already match/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});
