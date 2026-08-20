import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExactGraphContract,
  buildFunctionOnlyContract,
  sha256,
  validateExactGraphContract,
  validateFunctionOnlyContract,
  validateReviewedFlowContract,
} from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { createReviewedFlowRuntime } from "../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs";

const bytes = (flow) => Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, "utf8");
const fixture = () => ([
  { id: "tab", type: "tab", label: "LK Games" },
  { id: "route", type: "http in", z: "tab", method: "get", url: "/lk/test", wires: [["fn-a"]] },
  { id: "fn-a", type: "function", z: "tab", name: "A", func: "return msg;", outputs: 1, wires: [["response"]] },
  { id: "fn-b", type: "function", z: "tab", name: "B", func: "return msg;", outputs: 1, wires: [["response"]] },
  { id: "response", type: "http response", z: "tab", wires: [] },
]);

const candidateFixture = () => {
  const flow = structuredClone(fixture());
  flow.find((node) => node.id === "fn-a").func = "msg.a = true; return msg;";
  flow.find((node) => node.id === "fn-b").func = "msg.b = true; return msg;";
  return flow;
};

const exactGraphCandidateFixture = () => {
  const flow = structuredClone(fixture());
  const functionNode = flow.find((node) => node.id === "fn-a");
  functionNode.func = "msg.policy = true; return msg;";
  functionNode.outputs = 2;
  functionNode.wires = [["response"], ["policy"]];
  flow.push({
    id: "policy",
    type: "function",
    z: "tab",
    name: "Policy blocker",
    func: "return msg;",
    outputs: 1,
    wires: [["response"]],
  });
  const routeIndex = flow.findIndex((node) => node.id === "route");
  flow.push(flow.splice(routeIndex, 1)[0]);
  return flow;
};

test("function-only contract pins exact digests, routes, IDs, and changed fields", () => {
  const liveBytes = bytes(fixture());
  const candidateBytes = bytes(candidateFixture());
  const contract = buildFunctionOnlyContract({
    liveBytes,
    candidateBytes,
    deploymentId: "subscription-binding",
    allowedNodeIds: ["fn-a", "fn-b"],
  });
  assert.equal(contract.sourceSha256, sha256(liveBytes));
  assert.equal(contract.candidateSha256, sha256(candidateBytes));
  assert.equal(contract.nodeCount, 5);
  assert.equal(contract.httpInputCount, 1);
  assert.deepEqual(contract.allowedChanges.map(({ id }) => id), ["fn-a", "fn-b"]);
  assert.deepEqual(validateFunctionOnlyContract({ liveBytes, candidateBytes, contract }), contract);

  const wireDrift = candidateFixture();
  wireDrift.find((node) => node.id === "fn-a").wires = [[]];
  assert.throws(() => buildFunctionOnlyContract({
    liveBytes,
    candidateBytes: bytes(wireDrift),
    deploymentId: "subscription-binding",
    allowedNodeIds: ["fn-a", "fn-b"],
  }), /forbidden fields/);

  const extraChange = candidateFixture();
  extraChange.find((node) => node.id === "response").name = "changed";
  assert.throws(() => buildFunctionOnlyContract({
    liveBytes,
    candidateBytes: bytes(extraChange),
    deploymentId: "subscription-binding",
    allowedNodeIds: ["fn-a", "fn-b"],
  }), /changed-node set mismatch/);
});

test("exact-graph contract pins exact changed fields and added nodes while preserving routes", () => {
  const liveBytes = bytes(fixture());
  const candidateBytes = bytes(exactGraphCandidateFixture());
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["wires", "func", "outputs"] }],
    allowedAdditionIds: ["policy"],
  });
  assert.equal(contract.sourceNodeCount, 5);
  assert.equal(contract.candidateNodeCount, 6);
  assert.equal(contract.httpInputCount, 1);
  assert.deepEqual(contract.allowedChanges.map(({ id }) => id), ["fn-a"]);
  assert.deepEqual(contract.allowedAdditions.map(({ id }) => id), ["policy"]);
  assert.deepEqual(validateExactGraphContract({ liveBytes, candidateBytes, contract }), contract);
  assert.deepEqual(validateReviewedFlowContract({ liveBytes, candidateBytes, contract }), contract);

  const tamperedContract = structuredClone(contract);
  tamperedContract.allowedAdditions[0].type = "debug";
  assert.throws(() => validateExactGraphContract({
    liveBytes,
    candidateBytes,
    contract: tamperedContract,
  }), /contract content mismatch/);

  const extraChange = exactGraphCandidateFixture();
  extraChange.find((node) => node.id === "response").name = "changed";
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(extraChange),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /changed-node contract mismatch/);

  const extraAddition = exactGraphCandidateFixture();
  extraAddition.push({ id: "unexpected", type: "debug", wires: [] });
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(extraAddition),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /added-node contract mismatch/);

  const routeDrift = exactGraphCandidateFixture();
  routeDrift.find((node) => node.id === "route").url = "/lk/changed";
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(routeDrift),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [
      { id: "fn-a", fields: ["func", "outputs", "wires"] },
      { id: "route", fields: ["url"] },
    ],
    allowedAdditionIds: ["policy"],
  }), /changed HTTP route/);
});

const prepareRuntime = (t, { failFirstRestart = false, exactGraph = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-flow-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const gid = process.getgid();
  const stage = path.join(root, ".padlhub-reviewed-flow-stage-20260820T120000+0300-123");
  const backupDirectory = path.join(root, ".padlhub-reviewed-flow-backups");
  const liveFlowPath = path.join(root, "flows.json");
  const candidatePath = path.join(stage, "candidate.flow.json");
  const contractPath = path.join(stage, "contract.json");
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.chmodSync(stage, 0o700);
  const liveBytes = bytes(fixture());
  const candidateBytes = bytes(exactGraph ? exactGraphCandidateFixture() : candidateFixture());
  const contract = exactGraph
    ? buildExactGraphContract({
      liveBytes,
      candidateBytes,
      deploymentId: "managed-subscription-rules",
      allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
      allowedAdditionIds: ["policy"],
    })
    : buildFunctionOnlyContract({
      liveBytes,
      candidateBytes,
      deploymentId: "subscription-binding",
      allowedNodeIds: ["fn-a", "fn-b"],
    });
  for (const [filePath, content] of [
    [liveFlowPath, liveBytes],
    [candidatePath, candidateBytes],
    [contractPath, Buffer.from(`${JSON.stringify(contract, null, 2)}\n`)],
  ]) {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }
  let restartCount = 10;
  let failRemaining = failFirstRestart ? 1 : 0;
  const pm2 = {
    assertOnline: () => ({ pid: 1234, restartCount }),
    restart(previous) {
      assert.equal(previous <= restartCount, true);
      restartCount += 1;
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error("synthetic restart failure");
      }
      return { pid: 1235, restartCount };
    },
  };
  const runtime = createReviewedFlowRuntime({
    liveFlowPath,
    stageParent: root,
    backupDirectory,
    uid,
    gid,
    getUid: () => uid,
    pm2,
  });
  return { runtime, liveFlowPath, candidatePath, contractPath, contract, liveBytes, candidateBytes };
};

test("remote runtime is backup-first and supports exact explicit rollback", (t) => {
  const prepared = prepareRuntime(t);
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  };
  const preflight = prepared.runtime.preflight(common);
  assert.equal(preflight.sourceSha256, prepared.contract.sourceSha256);
  assert.equal(preflight.changedNodeCount, 2);
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  assert.equal(applied.activeFlowSha256, prepared.contract.candidateSha256);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.deepEqual(fs.readFileSync(applied.flowBackup), prepared.liveBytes);

  const rolledBack = prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(rolledBack.restoredFlowSha256, prepared.contract.sourceSha256);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
});

test("remote runtime restores reviewed bytes when candidate restart fails", (t) => {
  const prepared = prepareRuntime(t, { failFirstRestart: true });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
    stamp: "20260820T120000+0300",
  }), /rollback completed/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
});

test("remote runtime applies and rolls back an exact-graph contract", (t) => {
  const prepared = prepareRuntime(t, { exactGraph: true });
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "managed-subscription-rules",
  };
  const preflight = prepared.runtime.preflight(common);
  assert.equal(preflight.nodeCount, 5);
  assert.equal(preflight.candidateNodeCount, 6);
  assert.equal(preflight.changedNodeCount, 1);
  assert.equal(preflight.addedNodeCount, 1);
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  assert.equal(applied.activeFlowSha256, prepared.contract.candidateSha256);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  const rolledBack = prepared.runtime.rollback({
    deploymentId: "managed-subscription-rules",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(rolledBack.restoredFlowSha256, prepared.contract.sourceSha256);
});

test("remote preflight rejects hard-linked staged artifacts", (t) => {
  const prepared = prepareRuntime(t);
  fs.linkSync(prepared.candidatePath, `${prepared.candidatePath}.alias`);
  assert.throws(() => prepared.runtime.preflight({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  }), /Protected file contract mismatch/);
});

test("explicit rollback refuses a flow changed after the reviewed deployment", (t) => {
  const prepared = prepareRuntime(t);
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  };
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  fs.writeFileSync(prepared.liveFlowPath, bytes(fixture()), { mode: 0o600 });
  fs.chmodSync(prepared.liveFlowPath, 0o600);
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  }), /Active flow no longer matches/);
});

test("subscription binding wrapper keeps deployment explicit and rollback guarded", () => {
  const wrapper = fs.readFileSync("scripts/deploy_nodered_subscription_binding_147.sh", "utf8");
  const rollback = fs.readFileSync("scripts/rollback_nodered_subscription_binding_147.sh", "utf8");
  assert.match(wrapper, /NODE_RED_SUBSCRIPTION_BINDING_DEPLOY=CONFIRM_147/);
  assert.match(wrapper, /git fetch --quiet origin main/);
  assert.match(wrapper, /prepare_nodered_live_workspace\.sh/);
  assert.match(wrapper, /patch_live_games_subscription_binding\.mjs/);
  assert.match(wrapper, /apply_started=1/);
  assert.match(wrapper, /rollback --deployment-id/);
  assert.match(wrapper, /publicGamesStatus/);
  assert.match(rollback, /NODE_RED_SUBSCRIPTION_BINDING_ROLLBACK=CONFIRM_147/);
  assert.match(rollback, /Active flow no longer matches|rollback --deployment-id/);
  assert.doesNotMatch(wrapper + rollback, /rm\s+-rf|--update-env/);
});

test("managed subscription rules wrapper pins exact graph budget and guarded rollback", () => {
  const wrapper = fs.readFileSync("scripts/deploy_nodered_managed_subscription_rules_147.sh", "utf8");
  const rollback = fs.readFileSync("scripts/rollback_nodered_managed_subscription_rules_147.sh", "utf8");
  assert.match(wrapper, /NODE_RED_MANAGED_SUBSCRIPTION_RULES_DEPLOY=CONFIRM_147/);
  assert.match(wrapper, /pull_nodered_source_from_147\.sh/);
  assert.match(wrapper, /patch_nodered_subscription_booking_flow\.mjs/);
  assert.match(wrapper, /prepare_exact_graph_contract\.mjs/);
  assert.match(wrapper, /--allow-change 8f7bd5b482fe9763:func/);
  assert.match(wrapper, /--allow-add lk_subscription_managed_policy_20260820/);
  assert.match(wrapper, /value\.changedNodeCount !== 3/);
  assert.match(wrapper, /value\.addedNodeCount !== 2/);
  assert.match(wrapper, /subscriptionOptionsStatus/);
  assert.match(rollback, /NODE_RED_MANAGED_SUBSCRIPTION_RULES_ROLLBACK=CONFIRM_147/);
  assert.match(rollback, /rollback --deployment-id/);
  assert.doesNotMatch(wrapper + rollback, /rm\s+-rf|--update-env/);
});
