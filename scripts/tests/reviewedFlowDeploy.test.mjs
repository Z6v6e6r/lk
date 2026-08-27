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

  const tamperedNodeHash = structuredClone(contract);
  tamperedNodeHash.allowedChanges[0].candidateNodeSha256 = "0".repeat(64);
  assert.throws(() => validateExactGraphContract({
    liveBytes,
    candidateBytes,
    contract: tamperedNodeHash,
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

test("exact-graph contract permits only an explicitly pinned HTTP input wire change", () => {
  const liveBytes = bytes(fixture());
  const candidate = exactGraphCandidateFixture();
  candidate.find((node) => node.id === "route").wires = [["policy"]];
  const candidateBytes = bytes(candidate);
  const allowedChanges = [
    { id: "fn-a", fields: ["func", "outputs", "wires"] },
    { id: "route", fields: ["wires"] },
  ];
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: "managed-subscription-rules",
    allowedChanges,
    allowedAdditionIds: ["policy"],
  });
  assert.equal(contract.httpInputCount, 1);
  assert.deepEqual(
    contract.allowedChanges.find(({ id }) => id === "route").fields,
    ["wires"],
  );
  assert.deepEqual(validateExactGraphContract({ liveBytes, candidateBytes, contract }), contract);

  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: "managed-subscription-rules",
    allowedChanges: allowedChanges.filter(({ id }) => id !== "route"),
    allowedAdditionIds: ["policy"],
  }), /changed-node contract mismatch/);

  const routeConfigurationDrift = structuredClone(candidate);
  routeConfigurationDrift.find((node) => node.id === "route").method = "post";
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(routeConfigurationDrift),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [
      { id: "fn-a", fields: ["func", "outputs", "wires"] },
      { id: "route", fields: ["method", "wires"] },
    ],
    allowedAdditionIds: ["policy"],
  }), /changed HTTP route identity or configuration/);

  const addedRoute = structuredClone(candidate);
  addedRoute.push({
    id: "new-route",
    type: "http in",
    z: "tab",
    method: "get",
    url: "/lk/new",
    wires: [["policy"]],
  });
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(addedRoute),
    deploymentId: "managed-subscription-rules",
    allowedChanges,
    allowedAdditionIds: ["policy", "new-route"],
  }), /changed HTTP routes/);

  const removedRoute = candidate.filter((node) => node.id !== "route");
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(removedRoute),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /removed live node/);
});

const prepareRuntime = (
  t,
  {
    failFirstRestart = false,
    restartFailures = failFirstRestart ? 1 : 0,
    exactGraph = false,
    liveMode = 0o600,
    deploymentLeaseMs = 15 * 60 * 1000,
  } = {},
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-flow-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const gid = process.getgid();
  const stage = path.join(root, ".padlhub-reviewed-flow-stage-20260820T120000+0300-123");
  const backupDirectory = path.join(root, ".padlhub-reviewed-flow-backups");
  const deploymentLeasePath = path.join(root, ".padlhub-reviewed-flow-deploy.lease.json");
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
    fs.chmodSync(filePath, filePath === liveFlowPath ? liveMode : 0o600);
  }
  let restartCount = 10;
  let failRemaining = restartFailures;
  let nowMs = Date.parse("2026-08-20T09:00:00.000Z");
  let leaseSequence = 0;
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
    deploymentLeasePath,
    deploymentLeaseMs,
    uid,
    gid,
    getUid: () => uid,
    now: () => nowMs,
    randomUUID: () => `reviewed-flow-lease-${++leaseSequence}`,
    pm2,
  });
  return {
    runtime,
    liveFlowPath,
    candidatePath,
    contractPath,
    contract,
    liveBytes,
    candidateBytes,
    deploymentLeasePath,
    advanceTime(milliseconds) {
      nowMs += milliseconds;
    },
    setRestartFailures(count) {
      failRemaining = count;
    },
  };
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
  assert.equal(applied.deploymentLeaseSeconds, 15 * 60);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.deepEqual(fs.readFileSync(applied.flowBackup), prepared.liveBytes);

  const rolledBack = prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(rolledBack.restoredFlowSha256, prepared.contract.sourceSha256);
  assert.equal(rolledBack.deploymentLeaseReleased, true);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
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
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("remote runtime keeps the lease when automatic rollback restart is incomplete", (t) => {
  const prepared = prepareRuntime(t, { restartFailures: 2 });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
    stamp: "20260820T120000+0300",
  }), /rollback is incomplete and deployment lease remains active/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.throws(() => prepared.runtime.preflight({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  }), /deployment lease is active/);
});

test("successful apply blocks another reviewed deployment for the soak lease", (t) => {
  const prepared = prepareRuntime(t);
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  };
  prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  const lease = JSON.parse(fs.readFileSync(prepared.deploymentLeasePath, "utf8"));
  assert.equal(lease.deploymentId, "subscription-binding");
  assert.equal(lease.expiresAtMs - lease.acquiredAtMs, 15 * 60 * 1000);
  assert.throws(() => prepared.runtime.preflight(common), /deployment lease is active/);

  prepared.advanceTime(15 * 60 * 1000 + 1);
  assert.throws(() => prepared.runtime.preflight(common), /Live flow digest differs/);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("rollback after lease expiry reacquires protection and retains it on restart failure", (t) => {
  const prepared = prepareRuntime(t);
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  };
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  prepared.advanceTime(15 * 60 * 1000 + 1);
  prepared.setRestartFailures(1);
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  }), /synthetic restart failure/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.throws(() => prepared.runtime.preflight(common), /deployment lease is active/);
});

test("remote preflight fails closed on a malformed protected lease", (t) => {
  const prepared = prepareRuntime(t);
  fs.writeFileSync(prepared.deploymentLeasePath, "{not-json}\n", { mode: 0o600 });
  fs.chmodSync(prepared.deploymentLeasePath, 0o600);
  assert.throws(() => prepared.runtime.preflight({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  }), /deployment lease is invalid/);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
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

test("remote runtime accepts historical 0644 live mode and normalizes publication to 0600", (t) => {
  const prepared = prepareRuntime(t, { exactGraph: true, liveMode: 0o644 });
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "managed-subscription-rules",
  };
  assert.equal(prepared.runtime.preflight(common).sourceSha256, prepared.contract.sourceSha256);
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  assert.equal(fs.statSync(prepared.liveFlowPath).mode & 0o777, 0o600);
  prepared.runtime.rollback({
    deploymentId: "managed-subscription-rules",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(fs.statSync(prepared.liveFlowPath).mode & 0o777, 0o600);
});

test("remote preflight rejects every live mode outside exact 0600 or 0644", (t) => {
  const prepared = prepareRuntime(t, { liveMode: 0o640 });
  assert.throws(() => prepared.runtime.preflight({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  }), /Protected file mode mismatch/);
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

test("reviewed-flow remote CLI serializes every action with one fail-fast flock", () => {
  const remoteHelper = fs.readFileSync(
    "scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs",
    "utf8",
  );
  assert.match(remoteHelper, /\.padlhub-reviewed-flow-deploy\.lock/);
  assert.match(remoteHelper, /\.padlhub-reviewed-flow-deploy\.lease\.json/);
  assert.match(remoteHelper, /DEFAULT_DEPLOYMENT_LEASE_MS = 15 \* 60 \* 1000/);
  assert.match(remoteHelper, /spawnSync\(\s*"flock"/);
  assert.match(remoteHelper, /"-E",\s*String\(DEPLOYMENT_LOCK_CONFLICT_EXIT\),\s*"-n"/);
  assert.match(remoteHelper, /PADLHUB_REVIEWED_FLOW_LOCK_HELD/);
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
