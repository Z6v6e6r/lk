// Guarded apply/rollback wrappers for the 2026-10-05 LK1 train (server 147).
//
// The hermetic half proves the confirmation, pin, allow-list and exact-graph refusal contract
// without any transport; the snapshot half drives the documented `--dry-run` path against the
// pinned read-only 147 snapshot (skipped when that private snapshot is absent). No test contacts
// 147: the wrappers' dry-run exits before any ssh/scp/curl call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LK1_TRAIN_G1_POSTIMAGE_SHA256,
  LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256,
  LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256,
  LK1_TRAIN_G1_TARGET,
  LK1_TRAIN_G1_UPSTREAM_SHA256,
  composeLk1TrainG1Artifacts,
  sha256,
} from "../patch_live_lk1_train_g1_20261005.mjs";
import {
  LK1_TRAIN_G2_POSTIMAGE_SHA256,
  composeLk1TrainG2Artifacts,
} from "../patch_live_lk1_train_g2_20261005.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const raw = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

const DEPLOY_G1 = "scripts/deploy_nodered_lk1_train_g1_147.sh";
const ROLLBACK_G1 = "scripts/rollback_nodered_lk1_train_g1_147.sh";
const DEPLOY_G2 = "scripts/deploy_nodered_lk1_train_g2_147.sh";
const ROLLBACK_G2 = "scripts/rollback_nodered_lk1_train_g2_147.sh";
const WRAPPERS = [DEPLOY_G1, ROLLBACK_G1, DEPLOY_G2, ROLLBACK_G2];
const TOKENS = {
  [DEPLOY_G1]: "NODE_RED_LK1_TRAIN_G1_DEPLOY",
  [ROLLBACK_G1]: "NODE_RED_LK1_TRAIN_G1_ROLLBACK",
  [DEPLOY_G2]: "NODE_RED_LK1_TRAIN_G2_DEPLOY",
  [ROLLBACK_G2]: "NODE_RED_LK1_TRAIN_G2_ROLLBACK",
};

const UPSTREAM_FLOW = process.env.LK1_TRAIN_147_UPSTREAM_FLOW
  ?? "/private/tmp/lk1-train-147-prep/input/source.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `live 147 snapshot is absent: ${UPSTREAM_FLOW} (pull it read-only with `
    + "npm run nodered:modular:pull-147, or set LK1_TRAIN_147_UPSTREAM_FLOW)";

const BASE_ENV = { ...process.env };
for (const token of Object.values(TOKENS)) delete BASE_ENV[token];

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const temporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-train-wrappers-"));
  temporaryDirectories.push(directory);
  return directory;
};

const temporaryFile = (name, bytes) => {
  const directory = temporaryDirectory();
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
};

const runWrapper = (relative, { env = {}, args = [] } = {}) => spawnSync(
  "bash",
  [relative, ...args],
  { cwd: repoRoot, env: { ...BASE_ENV, ...env }, encoding: "utf8" },
);

test("all four train wrappers are shell-syntax clean and expose the documented modes", () => {
  for (const relative of WRAPPERS) {
    const result = spawnSync("bash", ["-n", relative], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${relative}: ${result.stderr}`);
  }
  for (const relative of [DEPLOY_G1, DEPLOY_G2]) {
    const script = raw(relative);
    assert.match(script, /--dry-run/);
    assert.match(script, /--snapshot/);
    assert.match(script, /CONFIRM_147/);
    assert.match(script, /prepare_exact_graph_contract\.mjs/);
    assert.match(script, /deploy_reviewed_flow_147_remote\.mjs/);
  }
  for (const relative of [ROLLBACK_G1, ROLLBACK_G2]) {
    const script = raw(relative);
    assert.match(script, /--dry-run/);
    assert.match(script, /--applied/);
    assert.match(script, /--preimage/);
    assert.match(script, /--restore-out/);
    assert.match(script, /CONFIRM_147/);
  }
});

test("missing or wrong CONFIRM_147 tokens refuse before any transport", () => {
  const stampByWrapper = {
    [ROLLBACK_G1]: ["20261005T120000+0300"],
    [ROLLBACK_G2]: ["20261005T120000+0300"],
  };
  for (const relative of WRAPPERS) {
    const args = stampByWrapper[relative] ?? [];
    const missing = runWrapper(relative, { args });
    assert.equal(missing.status, 2, `${relative} must refuse a missing token: ${missing.stderr}`);
    assert.match(missing.stderr, /Usage:/);
    const wrong = runWrapper(relative, { env: { [TOKENS[relative]]: "CONFIRM_146" }, args });
    assert.equal(wrong.status, 2, `${relative} must refuse a wrong token: ${wrong.stderr}`);
    assert.match(wrong.stderr, /Usage:/);
    const dryRun = runWrapper(relative, { args: ["--dry-run"] });
    assert.equal(dryRun.status, 2, `${relative} must refuse a dry-run without the token`);
  }
});

test("the wrappers declare exactly the reviewed node/field allow-list and frozen pins", () => {
  const deployG1 = raw(DEPLOY_G1);
  assert.match(deployG1, /allow_nodes=\(lk_subscription_booking_router_20260804\)/);
  assert.match(deployG1, /allow_changes=\("lk_subscription_booking_router_20260804:func,initialize"\)/);
  assert.match(deployG1, /expected_node_fields='\{"lk_subscription_booking_router_20260804":\["func","initialize"\]\}'/);
  assert.match(deployG1, new RegExp(LK1_TRAIN_G1_POSTIMAGE_SHA256));
  assert.match(deployG1, new RegExp(LK1_TRAIN_G1_TARGET.patchedFuncSha256));
  assert.match(deployG1, new RegExp(LK1_TRAIN_G1_TARGET.patchedInitializeSha256));
  assert.match(deployG1, /NODE_RED_LK1_TRAIN_G1_DEPLOY/);

  const deployG2 = raw(DEPLOY_G2);
  for (const node of [
    "lk_subscription_managed_policy_20260820",
    "lk_subscription_price_preview_20260908_evaluate",
    "lk_subscription_price_preview_20260908_router",
  ]) {
    assert.ok(deployG2.includes(node), node);
  }
  assert.match(deployG2, /allow_changes=\(/);
  assert.match(deployG2, new RegExp(LK1_TRAIN_G2_POSTIMAGE_SHA256));
  assert.match(deployG2, /e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1/);
  assert.match(deployG2, /0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221/);
  assert.match(deployG2, /preimage_flow_sha="fc4a46a6d1cbda022e8d3ce503d019bc4d0d1e366ff44ba53612a0809256efc5"/);
  assert.match(deployG2, /wait_for_soak_lease "lk1-train-g1"/);

  const rollbackG1 = raw(ROLLBACK_G1);
  assert.match(rollbackG1, new RegExp(LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256));
  assert.match(rollbackG1, new RegExp(LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256));
  assert.match(rollbackG1, /expectedPriorRuleCount!==10/);
  assert.match(rollbackG1, /desiredRuleCount!==9/);
  assert.match(rollbackG1, /orderedRollbackStep!==1/);
  assert.match(rollbackG1, /wait_for_soak_lease "\$deployment_id"/);
  assert.match(rollbackG1, /wait_for_soak_lease "\$revert_deployment_id"/);
  // The plan-rules revert must be composed and applied before the preimage is read back.
  const revertIndex = rollbackG1.indexOf("--mode revert");
  const restoreIndex = rollbackG1.indexOf("cat '$remote_flow_backup'");
  assert.ok(revertIndex > 0, "the rollback must compose the plan-rules revert candidate");
  assert.ok(restoreIndex > revertIndex, "the plan-rules revert must run before the preimage restore");

  const rollbackG2 = raw(ROLLBACK_G2);
  assert.match(rollbackG2, new RegExp(LK1_TRAIN_G2_POSTIMAGE_SHA256));
  assert.match(rollbackG2, /preimage_flow_sha="fc4a46a6d1cbda022e8d3ce503d019bc4d0d1e366ff44ba53612a0809256efc5"/);
  assert.match(rollbackG2, /wait_for_soak_lease "\$deployment_id"/);

  // Every wait is bounded and refuses a lease that cannot auto-expire.
  for (const relative of [DEPLOY_G2, ROLLBACK_G1, ROLLBACK_G2]) {
    const script = raw(relative);
    assert.match(script, /soak_wait_budget="\$\{NODE_RED_LK1_TRAIN_SOAK_WAIT_SECONDS:-1800\}"/);
    assert.match(script, /phase.*does not auto-expire/);
  }

  const pkg = JSON.parse(raw("package.json"));
  assert.equal(pkg.scripts["nodered:lk1-train-g1:deploy-147"],
    "bash scripts/deploy_nodered_lk1_train_g1_147.sh");
  assert.equal(pkg.scripts["nodered:lk1-train-g1:rollback-147"],
    "bash scripts/rollback_nodered_lk1_train_g1_147.sh");
  assert.equal(pkg.scripts["nodered:lk1-train-g2:deploy-147"],
    "bash scripts/deploy_nodered_lk1_train_g2_147.sh");
  assert.equal(pkg.scripts["nodered:lk1-train-g2:rollback-147"],
    "bash scripts/rollback_nodered_lk1_train_g2_147.sh");
  assert.equal(pkg.scripts["test:lk1-train-g1-wrappers"],
    "node --experimental-strip-types --test scripts/tests/lk1TrainG1Wrappers.test.mjs");
  assert.equal(pkg.scripts["nodered:modular:pull-147"],
    "bash ./scripts/pull_nodered_source_from_147.sh");

  // The wrappers are registered in the established LK1 CI group.
  const workflow = raw(".github/workflows/lk1-subscription-enforcement.yml");
  assert.match(workflow, /scripts\/tests\/lk1TrainG1Wrappers\.test\.mjs/);
});

test("a wrong preimage sha refuses before composing", () => {
  const wrong = temporaryFile("wrong.flow.json", "not the reviewed flow\n");
  const g1 = runWrapper(DEPLOY_G1, {
    env: { NODE_RED_LK1_TRAIN_G1_DEPLOY: "CONFIRM_147" },
    args: ["--dry-run", "--snapshot", wrong],
  });
  assert.notEqual(g1.status, 0);
  assert.match(g1.stderr, /not the reviewed G1 preimage/);

  const g2 = runWrapper(DEPLOY_G2, {
    env: { NODE_RED_LK1_TRAIN_G2_DEPLOY: "CONFIRM_147" },
    args: ["--dry-run", "--snapshot", wrong],
  });
  assert.notEqual(g2.status, 0);
  assert.match(g2.stderr, /not G1's reviewed postimage/);
});

test("the exact-graph contract stage refuses a candidate outside the declared allow-list", () => {
  const directory = temporaryDirectory();
  const live = [
    { id: "a", type: "function", outputs: 1, wires: [[]], func: "a", initialize: "" },
    { id: "b", type: "function", outputs: 1, wires: [[]], func: "b", initialize: "" },
  ];
  const candidate = [{ ...live[0], func: "a2" }, { ...live[1], func: "b2" }];
  const livePath = path.join(directory, "live.json");
  const candidatePath = path.join(directory, "candidate.json");
  fs.writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    "scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs",
    "--live", livePath,
    "--candidate", candidatePath,
    "--output", path.join(directory, "contract.json"),
    "--deployment-id", "lk1-train-g1",
    "--allow-change", "a:func",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Exact-graph changed-node contract mismatch/);
});

test("a wrong rollback input refuses before extracting bytes", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  const g1Path = temporaryFile("g1.flow.json", composeLk1TrainG1Artifacts(bytes).candidateBytes);
  const wrong = temporaryFile("wrong.flow.json", "not the reviewed flow\n");
  const restoreOut = path.join(temporaryDirectory(), "restored.flow.json");

  const wrongApplied = runWrapper(ROLLBACK_G1, {
    env: { NODE_RED_LK1_TRAIN_G1_ROLLBACK: "CONFIRM_147" },
    args: ["--dry-run", "--applied", wrong, "--preimage", UPSTREAM_FLOW, "--restore-out", restoreOut],
  });
  assert.notEqual(wrongApplied.status, 0);
  assert.match(wrongApplied.stderr, /not the applied G1 generation/);

  const wrongPreimage = runWrapper(ROLLBACK_G1, {
    env: { NODE_RED_LK1_TRAIN_G1_ROLLBACK: "CONFIRM_147" },
    args: ["--dry-run", "--applied", g1Path, "--preimage", wrong, "--restore-out", restoreOut],
  });
  assert.notEqual(wrongPreimage.status, 0);
  assert.match(wrongPreimage.stderr, /not the reviewed G1 preimage/);
  assert.equal(fs.existsSync(restoreOut), false);
});

test("the G1 dry-runs reproduce the frozen candidates and restore the pre-candidate bytes",
  { skip: snapshotSkip }, () => {
    const bytes = fs.readFileSync(UPSTREAM_FLOW);
    assert.equal(sha256(bytes), LK1_TRAIN_G1_UPSTREAM_SHA256);
    const built = composeLk1TrainG1Artifacts(bytes);
    assert.equal(built.candidateSha256, LK1_TRAIN_G1_POSTIMAGE_SHA256);
    const g1Path = temporaryFile("g1.flow.json", built.candidateBytes);

    const apply = runWrapper(DEPLOY_G1, {
      env: { NODE_RED_LK1_TRAIN_G1_DEPLOY: "CONFIRM_147" },
      args: ["--dry-run", "--snapshot", UPSTREAM_FLOW],
    });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /dryRun=1/);
    assert.match(apply.stdout, new RegExp(`candidateFlowSha256=${LK1_TRAIN_G1_POSTIMAGE_SHA256}`));
    assert.match(apply.stdout, /changedNodeCount=1/);
    assert.match(apply.stdout, /changedNodes=lk_subscription_booking_router_20260804:func,initialize/);

    const restoreOut = path.join(temporaryDirectory(), "restored.flow.json");
    const rollback = runWrapper(ROLLBACK_G1, {
      env: { NODE_RED_LK1_TRAIN_G1_ROLLBACK: "CONFIRM_147" },
      args: ["--dry-run", "--applied", g1Path, "--preimage", UPSTREAM_FLOW,
        "--restore-out", restoreOut, "--stamp", "20261005T120000+0300"],
    });
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.match(rollback.stdout, new RegExp(`revertFlowSha256=${LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256}`));
    assert.match(rollback.stdout, new RegExp(`revertInitializeSha256=${LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256}`));
    assert.match(rollback.stdout, new RegExp(`restoredPreimageSha256=${LK1_TRAIN_G1_UPSTREAM_SHA256}`));
    const restorePath = /restoreFlowPath=(.+)/.exec(rollback.stdout)?.[1]?.trim();
    assert.ok(restorePath, rollback.stdout);
    assert.equal(restorePath, restoreOut);
    const restored = fs.readFileSync(restorePath);
    assert.equal(sha256(restored), LK1_TRAIN_G1_UPSTREAM_SHA256);
    assert.ok(restored.equals(bytes), "the rollback must extract exactly the pre-candidate bytes");
  });

test("the G2 dry-runs stack on G1 and restore G1's postimage bytes", { skip: snapshotSkip }, () => {
  const preimage = fs.readFileSync(UPSTREAM_FLOW);
  const g1Bytes = composeLk1TrainG1Artifacts(preimage).candidateBytes;
  const g2Bytes = composeLk1TrainG2Artifacts(g1Bytes).candidateBytes;
  assert.equal(sha256(g2Bytes), LK1_TRAIN_G2_POSTIMAGE_SHA256);
  const g1Path = temporaryFile("g1.flow.json", g1Bytes);
  const g2Path = temporaryFile("g2.flow.json", g2Bytes);

  const apply = runWrapper(DEPLOY_G2, {
    env: { NODE_RED_LK1_TRAIN_G2_DEPLOY: "CONFIRM_147" },
    args: ["--dry-run", "--snapshot", g1Path],
  });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, new RegExp(`candidateFlowSha256=${LK1_TRAIN_G2_POSTIMAGE_SHA256}`));
  assert.match(apply.stdout, /changedNodeCount=3/);
  assert.match(apply.stdout, /changedNodes=lk_subscription_managed_policy_20260820:func/);

  // G2 must refuse the raw preimage: it stacks on G1's postimage only.
  const refuse = runWrapper(DEPLOY_G2, {
    env: { NODE_RED_LK1_TRAIN_G2_DEPLOY: "CONFIRM_147" },
    args: ["--dry-run", "--snapshot", UPSTREAM_FLOW],
  });
  assert.notEqual(refuse.status, 0);
  assert.match(refuse.stderr, /not G1's reviewed postimage/);

  const restoreOut = path.join(temporaryDirectory(), "restored.flow.json");
  const rollback = runWrapper(ROLLBACK_G2, {
    env: { NODE_RED_LK1_TRAIN_G2_ROLLBACK: "CONFIRM_147" },
    args: ["--dry-run", "--applied", g2Path, "--preimage", g1Path,
      "--restore-out", restoreOut, "--stamp", "20261005T120000+0300"],
  });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, new RegExp(`restoredPreimageSha256=${LK1_TRAIN_G1_POSTIMAGE_SHA256}`));
  assert.match(rollback.stdout, new RegExp(`appliedFlowSha256=${LK1_TRAIN_G2_POSTIMAGE_SHA256}`));
  const restorePath = /restoreFlowPath=(.+)/.exec(rollback.stdout)?.[1]?.trim();
  assert.ok(restorePath, rollback.stdout);
  const restored = fs.readFileSync(restorePath);
  assert.equal(sha256(restored), sha256(g1Bytes));
  assert.ok(restored.equals(g1Bytes), "the G2 rollback must extract exactly G1's postimage bytes");
});
