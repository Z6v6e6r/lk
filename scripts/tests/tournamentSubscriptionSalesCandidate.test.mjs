import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LK1_ENFORCEMENT_CONTRACT } from "../prepare_lk1_subscription_enforcement_candidate.mjs";

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

function createWorkspace({ approvedNodeDrift = false, duplicateLegacy = false, staleRouter = false, unknownDuplicate = false } = {}) {
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
        outputs: 4,
        wires: [[], [], [], []],
      };
    }),
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

test("legacy sales builder stays independently quarantined for every input", () => {
  assert.equal(LK1_ENFORCEMENT_CONTRACT.candidateBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(LK1_ENFORCEMENT_CONTRACT.candidateSha256, null);
  const builderSource = fs.readFileSync(BUILDER, "utf8");
  assert.match(builderSource, /QUARANTINED_PITER_ATOMIC_TOPOLOGY_NOT_COMPOSED/);
  assert.doesNotMatch(builderSource, /lk1_subscription_enforcement_candidate_binding\.json/);
  for (const options of [
    {},
    { staleRouter: true },
    { approvedNodeDrift: true },
    { duplicateLegacy: true, staleRouter: true },
    { staleRouter: true, unknownDuplicate: true },
  ]) {
    const { workspace } = createWorkspace(options);
    const result = runBuilder(workspace);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Tournament subscription sales candidate builder is QUARANTINED_PITER_ATOMIC_TOPOLOGY_NOT_COMPOSED/,
    );
    assert.equal(fs.existsSync(path.join(workspace, "build")), false);
  }
});

test("legacy sales quarantine records exact Piter amendments without advancing frozen candidate pins", () => {
  const amendments = new Map(LK1_ENFORCEMENT_CONTRACT.unboundSourceAmendments.map(
    (amendment) => [amendment.id, amendment],
  ));
  const frozenCandidateSha256ById = new Map([
    ["c165e43eba668c25", "f7e9d81975e63a090ad47abe54c07ed9db265fccf114ab7758f3b102ed0007e0"],
    ["91dded2dc8cfebe4", "2f15053bdf2c8abd770b7bc65cd59d6fdcfc2c08f26c2ee78a95bc309dfe5ca3"],
    ["f8679e53edadc39b", "75d070b427ca9097cd258a84daca7b2c3998f545415b69ef4968ccdce2aaeef8"],
  ]);
  for (const [id, frozenCandidateSha256] of frozenCandidateSha256ById) {
    const target = LK1_ENFORCEMENT_CONTRACT.targets.find((item) => item.id === id);
    const amendment = amendments.get(id);
    assert.ok(target);
    assert.ok(amendment);
    assert.equal(target.candidateSha256, frozenCandidateSha256);
    assert.equal(amendment.reason, "PITER_ATOMIC_SALES_NOT_COMPOSED");
    assert.equal(sha256(fs.readFileSync(target.sourceFile)), amendment.sourceSha256);
    assert.notEqual(amendment.sourceSha256, frozenCandidateSha256);
  }
});
