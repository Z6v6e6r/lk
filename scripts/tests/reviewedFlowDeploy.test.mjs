import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExactGraphContract,
  buildFunctionOnlyContract,
  atomicWrite,
  recoverAtomicExclusivePublication,
  sha256,
  validateExactGraphContract,
  validateFunctionOnlyContract,
  validateReviewedFlowContract,
  writeFileExclusiveAtomicDurable,
  writeFileExclusiveDurable,
} from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
import {
  createPm2Adapter,
  createReviewedFlowRuntime,
} from "../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs";

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

const exactGraphCandidateFixture = (activationNotBefore = null) => {
  const flow = structuredClone(fixture());
  const functionNode = flow.find((node) => node.id === "fn-a");
  functionNode.func = activationNotBefore
    ? `const FUTURE_GAME_WRITES_NOT_BEFORE = "${activationNotBefore}";\nmsg.policy = true; return msg;`
    : "msg.policy = true; return msg;";
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

  const reorderedLiveNodes = exactGraphCandidateFixture();
  const firstIndex = reorderedLiveNodes.findIndex((node) => node.id === "fn-a");
  const secondIndex = reorderedLiveNodes.findIndex((node) => node.id === "fn-b");
  [reorderedLiveNodes[firstIndex], reorderedLiveNodes[secondIndex]] = [
    reorderedLiveNodes[secondIndex],
    reorderedLiveNodes[firstIndex],
  ];
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(reorderedLiveNodes),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /reordered live nodes/);

  const interleavedAddition = exactGraphCandidateFixture();
  const addition = interleavedAddition.pop();
  interleavedAddition.splice(2, 0, addition);
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(interleavedAddition),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /appended suffix/);

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
  const addedRouteContract = buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(addedRoute),
    deploymentId: "managed-subscription-rules",
    allowedChanges,
    allowedAdditionIds: ["policy", "new-route"],
  });
  assert.equal(addedRouteContract.httpInputCount, 2);
  assert.deepEqual(addedRouteContract.allowedAdditions.map(({ id }) => id), ["new-route", "policy"]);

  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(addedRoute),
    deploymentId: "managed-subscription-rules",
    allowedChanges,
    allowedAdditionIds: ["policy"],
  }), /added-node contract mismatch/);

  const removedRoute = candidate.filter((node) => node.id !== "route");
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(removedRoute),
    deploymentId: "managed-subscription-rules",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
  }), /removed live node/);
});

test("exact-graph activation boundary pins the candidate function and canonical UTC literal", () => {
  const notBefore = "2026-08-20T09:30:00.000Z";
  const liveBytes = bytes(fixture());
  const candidateBytes = bytes(exactGraphCandidateFixture(notBefore));
  const contract = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: "future-writer-foundation",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
    activationBoundary: { nodeId: "fn-a", notBefore },
  });
  assert.deepEqual(contract.activationBoundary, {
    formatVersion: 1,
    nodeId: "fn-a",
    notBefore,
    rollbackPolicy: "forbid-source-before-runtime-cutover",
  });
  assert.deepEqual(validateExactGraphContract({ liveBytes, candidateBytes, contract }), contract);

  const tampered = structuredClone(contract);
  tampered.activationBoundary.notBefore = "2026-08-20T09:31:00.000Z";
  assert.throws(
    () => validateExactGraphContract({ liveBytes, candidateBytes, contract: tampered }),
    /literal is not pinned/,
  );
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(exactGraphCandidateFixture()),
    deploymentId: "future-writer-foundation",
    allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
    allowedAdditionIds: ["policy"],
    activationBoundary: { nodeId: "fn-a", notBefore },
  }), /literal is not pinned/);

  const unchangedBoundary = exactGraphCandidateFixture();
  unchangedBoundary.find((node) => node.id === "fn-b").func = `const FUTURE_GAME_WRITES_NOT_BEFORE = "${notBefore}"; return msg;`;
  assert.throws(() => buildExactGraphContract({
    liveBytes,
    candidateBytes: bytes(unchangedBoundary),
    deploymentId: "future-writer-foundation",
    allowedChanges: [
      { id: "fn-a", fields: ["func", "outputs", "wires"] },
      { id: "fn-b", fields: ["func"] },
    ],
    allowedAdditionIds: ["policy"],
    activationBoundary: { nodeId: "route", notBefore },
  }), /part of the exact reviewed change|must be a function/);
});

test("PM2 adapter applies the hard timeout to inspect, restart, and restart readback", () => {
  const calls = [];
  let restartCount = 10;
  const spawnCommand = (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout });
    if (args[0] === "restart") restartCount += 1;
    return args[0] === "jlist"
      ? {
        status: 0,
        stdout: JSON.stringify([{
          name: "node-red",
          pid: 1234,
          pm2_env: { status: "online", restart_time: restartCount },
        }]),
      }
      : { status: 0, stdout: "" };
  };
  const pm2 = createPm2Adapter({ commandTimeoutMs: 60_000, spawnCommand });
  assert.equal(pm2.inspect().restartCount, 10);
  assert.equal(pm2.restart(10).restartCount, 11);
  assert.deepEqual(calls.map(({ args, timeout }) => [args.join(" "), timeout]), [
    ["jlist", 60_000],
    ["restart node-red", 60_000],
    ["jlist", 60_000],
  ]);
});

const prepareRuntime = (
  t,
  {
    failFirstRestart = false,
    restartFailures = failFirstRestart ? 1 : 0,
    exactGraph = false,
    liveMode = 0o600,
    deploymentLeaseMs = 15 * 60 * 1000,
    sourceRollbackBudgetMs = 4 * 60 * 1000,
    activationNotBefore = null,
    advanceOnFailedRestartMs = 0,
    advanceOnSuccessfulRestartMs = 0,
    restoreSourceOnFailedRestart = false,
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
  const candidateBytes = bytes(exactGraph ? exactGraphCandidateFixture(activationNotBefore) : candidateFixture());
  const contract = exactGraph
    ? buildExactGraphContract({
      liveBytes,
      candidateBytes,
      deploymentId: "managed-subscription-rules",
      allowedChanges: [{ id: "fn-a", fields: ["func", "outputs", "wires"] }],
      allowedAdditionIds: ["policy"],
      activationBoundary: activationNotBefore ? { nodeId: "fn-a", notBefore: activationNotBefore } : null,
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
  let processStatus = "online";
  let processPid = 1234;
  const restartPreviousValues = [];
  let failRemaining = restartFailures;
  let nowMs = Date.parse("2026-08-20T09:00:00.000Z");
  let leaseSequence = 0;
  const pm2 = {
    inspect: () => ({ pid: processPid, status: processStatus, restartCount }),
    assertOnline() {
      const result = this.inspect();
      if (result.status !== "online" || result.pid <= 0) throw new Error("synthetic node-red offline");
      return result;
    },
    restart(previous) {
      assert.equal(previous, restartCount);
      restartPreviousValues.push(previous);
      restartCount += 1;
      if (failRemaining > 0) {
        failRemaining -= 1;
        nowMs += advanceOnFailedRestartMs;
        if (restoreSourceOnFailedRestart) fs.writeFileSync(liveFlowPath, liveBytes, { mode: liveMode });
        processStatus = "errored";
        processPid = 0;
        throw new Error("synthetic restart failure");
      }
      nowMs += advanceOnSuccessfulRestartMs;
      processStatus = "online";
      processPid = 1235;
      return { pid: processPid, status: processStatus, restartCount };
    },
  };
  const runtime = createReviewedFlowRuntime({
    liveFlowPath,
    stageParent: root,
    backupDirectory,
    deploymentLeasePath,
    deploymentLeaseMs,
    sourceRollbackBudgetMs,
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
    backupDirectory,
    deploymentLeasePath,
    restartPreviousValues,
    advanceTime(milliseconds) {
      nowMs += milliseconds;
    },
    setRestartFailures(count) {
      failRemaining = count;
    },
    setProcessState({ status, pid = status === "online" ? 1235 : 0 }) {
      processStatus = status;
      processPid = pid;
    },
  };
};

test("apply rechecks full soak and source rollback lead after a slow successful restart", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:20:30.000Z",
    advanceOnSuccessfulRestartMs: 2 * 60 * 1000,
  });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  }), /rollback completed: Candidate soak lease refresh is too close/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
});

const seedSourceLeaseRecovery = (prepared, { phase = "applying", formatVersion = 2 } = {}) => {
  fs.mkdirSync(prepared.backupDirectory, { mode: 0o700, recursive: true });
  fs.chmodSync(prepared.backupDirectory, 0o700);
  const stamp = "20260820T120000+0300";
  const flowBackup = path.join(
    prepared.backupDirectory,
    `flows-pre-${prepared.contract.deploymentId}-${stamp}.json`,
  );
  const contractBackup = path.join(
    prepared.backupDirectory,
    `contract-${prepared.contract.deploymentId}-${stamp}.json`,
  );
  fs.writeFileSync(flowBackup, prepared.liveBytes, { mode: 0o600 });
  fs.writeFileSync(contractBackup, Buffer.from(`${JSON.stringify(prepared.contract, null, 2)}\n`), { mode: 0o600 });
  fs.chmodSync(flowBackup, 0o600);
  fs.chmodSync(contractBackup, 0o600);
  const lease = {
    formatVersion,
    deploymentId: prepared.contract.deploymentId,
    token: `seed-${formatVersion}-${phase}`,
    ...(formatVersion === 2 ? { phase } : {}),
    acquiredAtMs: Date.parse("2026-08-20T09:00:00.000Z"),
    expiresAtMs: Date.parse("2026-08-20T09:15:00.000Z"),
    sourceSha256: prepared.contract.sourceSha256,
    candidateSha256: prepared.contract.candidateSha256,
  };
  const leaseBytes = Buffer.from(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
  fs.writeFileSync(prepared.deploymentLeasePath, leaseBytes, { mode: 0o600 });
  fs.chmodSync(prepared.deploymentLeasePath, 0o600);
  return { flowBackup, contractBackup, lease, leaseBytes, leaseSha256: sha256(leaseBytes) };
};

const prepareLegacyCandidateFinalization = (t, { formatVersion = 1 } = {}) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { formatVersion });
  fs.writeFileSync(prepared.liveFlowPath, prepared.candidateBytes, { mode: 0o600 });
  fs.chmodSync(prepared.liveFlowPath, 0o600);
  const options = {
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T121600+0300",
    flowBackup: artifacts.flowBackup,
    contractBackup: artifacts.contractBackup,
    expectedLeaseSha256: artifacts.leaseSha256,
    expectedActiveSha256: prepared.contract.candidateSha256,
    expectedFlowBackupSha256: prepared.contract.sourceSha256,
    expectedContractBackupSha256: sha256(fs.readFileSync(artifacts.contractBackup)),
  };
  return { prepared, artifacts, options };
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
  assert.equal(JSON.parse(fs.readFileSync(prepared.deploymentLeasePath, "utf8")).phase, "soaking");
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.deepEqual(fs.readFileSync(applied.flowBackup), prepared.liveBytes);

  const rolledBack = prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(rolledBack.restoredFlowSha256, prepared.contract.sourceSha256);
  assert.equal(rolledBack.rollbackMode, "restore-and-restart");
  assert.equal(rolledBack.resumedIncompleteRollback, false);
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
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
});

test("activation boundary requires a full soak and rollback budget before publication", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
  });
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
  };
  const preflight = prepared.runtime.preflight(common);
  assert.equal(preflight.activationNotBefore, "2026-08-20T09:30:00.000Z");
  assert.equal(preflight.activationLeadSeconds, 30 * 60);
  assert.equal(preflight.sourceRollbackBudgetSeconds, 4 * 60);

  prepared.advanceTime(13 * 60 * 1000);
  assert.throws(() => prepared.runtime.apply({
    ...common,
    stamp: "20260820T121300+0300",
  }), /too close to the reviewed activation boundary/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(prepared.restartPreviousValues, []);
});

test("failed restart near activation keeps candidate bytes and the lease for runtime verification", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
  });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  }), /runtime_unverified/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.equal(
    JSON.parse(fs.readFileSync(prepared.deploymentLeasePath, "utf8")).phase,
    "rollback-restart-required",
  );
  assert.deepEqual(prepared.restartPreviousValues, [10]);
});

test("automatic source restart is refused when its PM2 budget crosses activation", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
    restoreSourceOnFailedRestart: true,
  });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  }), /runtime_unverified/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.deepEqual(prepared.restartPreviousValues, [10]);
});

test("incomplete candidate restart can be reconciled after activation without restoring source", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
  });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /runtime_unverified/);
  prepared.advanceTime(3 * 60 * 1000);
  prepared.setRestartFailures(0);
  const result = prepared.runtime.reconcileCurrent({
    deploymentId,
    stamp: "20260820T123100+0300",
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  });
  assert.equal(result.action, "reconcile-current");
  assert.equal(result.activeFlowSha256, prepared.contract.candidateSha256);
  assert.equal(result.deploymentLeaseReleased, true);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.equal(JSON.parse(fs.readFileSync(result.intentPath, "utf8")).state, "VERIFICATION_PENDING");
  assert.equal(JSON.parse(fs.readFileSync(result.verifiedPath, "utf8")).state, "VERIFIED_PENDING_RELEASE");
  assert.equal(JSON.parse(fs.readFileSync(result.receiptPath, "utf8")).state, "SUCCESS");
  const replay = prepared.runtime.reconcileCurrent({
    deploymentId,
    stamp: "20260820T123100+0300",
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  });
  assert.equal(replay.resumedSuccess, true);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
});

test("verified reconciliation resumes lease release without another Node-RED restart", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
  });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /runtime_unverified/);
  prepared.advanceTime(3 * 60 * 1000);
  prepared.setRestartFailures(0);
  const reconcileStamp = "20260820T123100+0300";
  const options = {
    deploymentId,
    stamp: reconcileStamp,
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  };
  const originalUnlinkSync = fs.unlinkSync;
  let refusedOnce = false;
  fs.unlinkSync = (filePath, ...args) => {
    if (!refusedOnce && path.resolve(filePath) === path.resolve(prepared.deploymentLeasePath)) {
      refusedOnce = true;
      throw new Error("synthetic lease release failure");
    }
    return originalUnlinkSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(() => prepared.runtime.reconcileCurrent(options), /synthetic lease release failure/);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  const verifiedPath = path.join(
    prepared.backupDirectory,
    `reconcile-current-verified-${deploymentId}-${reconcileStamp}.json`,
  );
  assert.equal(JSON.parse(fs.readFileSync(verifiedPath, "utf8")).state, "VERIFIED_PENDING_RELEASE");
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  const resumed = prepared.runtime.reconcileCurrent(options);
  assert.equal(resumed.resumedVerified, true);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
});

test("verified reconciliation resumes success publication after lease release", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
  });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /runtime_unverified/);
  prepared.advanceTime(3 * 60 * 1000);
  prepared.setRestartFailures(0);
  const reconcileStamp = "20260820T123100+0300";
  const options = {
    deploymentId,
    stamp: reconcileStamp,
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  };
  const successPath = path.join(
    prepared.backupDirectory,
    `reconcile-current-success-${deploymentId}-${reconcileStamp}.json`,
  );
  const originalOpenSync = fs.openSync;
  let refusedOnce = false;
  fs.openSync = (filePath, ...args) => {
    if (!refusedOnce && path.resolve(filePath) === path.resolve(successPath)) {
      refusedOnce = true;
      throw new Error("synthetic success receipt failure");
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(() => prepared.runtime.reconcileCurrent(options), /synthetic success receipt failure/);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.equal(fs.existsSync(successPath), false);
  const resumed = prepared.runtime.reconcileCurrent(options);
  assert.equal(resumed.resumedVerified, true);
  assert.equal(JSON.parse(fs.readFileSync(successPath, "utf8")).state, "SUCCESS");
  assert.deepEqual(prepared.restartPreviousValues, [10, 11]);
});

test("failed current reconciliation leaves only a pending intent and the matching lease", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    failFirstRestart: true,
    advanceOnFailedRestartMs: 28 * 60 * 1000,
  });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /runtime_unverified/);
  prepared.setRestartFailures(1);
  const reconcileStamp = "20260820T123000+0300";
  assert.throws(() => prepared.runtime.reconcileCurrent({
    deploymentId,
    stamp: reconcileStamp,
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  }), /synthetic restart failure/);
  const intentPath = path.join(prepared.backupDirectory, `reconcile-current-intent-${deploymentId}-${reconcileStamp}.json`);
  const verifiedPath = path.join(prepared.backupDirectory, `reconcile-current-verified-${deploymentId}-${reconcileStamp}.json`);
  const successPath = path.join(prepared.backupDirectory, `reconcile-current-success-${deploymentId}-${reconcileStamp}.json`);
  assert.equal(JSON.parse(fs.readFileSync(intentPath, "utf8")).state, "VERIFICATION_PENDING");
  assert.equal(fs.existsSync(verifiedPath), false);
  assert.equal(fs.existsSync(successPath), false);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
});

test("current candidate reconciliation refuses unknown active bytes under an incomplete lease", (t) => {
  const prepared = prepareRuntime(t, { failFirstRestart: true, advanceOnFailedRestartMs: 0 });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /rollback completed/);
  seedSourceLeaseRecovery(prepared, { phase: "rollback-restart-required" });
  fs.writeFileSync(prepared.liveFlowPath, "unknown active bytes", { mode: 0o600 });
  assert.throws(() => prepared.runtime.reconcileCurrent({
    deploymentId,
    stamp: "20260820T121000+0300",
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  }), /exact reviewed source or candidate on disk/);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
});

test("forward reconciliation republishes the durable candidate after source rollback restart fails", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
    restartFailures: 2,
    advanceOnFailedRestartMs: 5 * 60 * 1000,
  });
  const deploymentId = prepared.contract.deploymentId;
  const artifactStamp = "20260820T120000+0300";
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId,
    stamp: artifactStamp,
  }), /rollback is incomplete/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  prepared.advanceTime(21 * 60 * 1000);
  prepared.setRestartFailures(0);
  const result = prepared.runtime.reconcileCurrent({
    deploymentId,
    stamp: "20260820T124100+0300",
    flowBackup: path.join(prepared.backupDirectory, `flows-pre-${deploymentId}-${artifactStamp}.json`),
    contractBackup: path.join(prepared.backupDirectory, `contract-${deploymentId}-${artifactStamp}.json`),
    candidateBackup: path.join(prepared.backupDirectory, `candidate-${deploymentId}-${artifactStamp}.flow.json`),
  });
  assert.equal(result.activeFlowSha256, prepared.contract.candidateSha256);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11, 12]);
});

test("explicit source rollback is refused before its worst-case runtime budget crosses activation", (t) => {
  const prepared = prepareRuntime(t, {
    exactGraph: true,
    activationNotBefore: "2026-08-20T09:30:00.000Z",
  });
  const applied = prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  });
  prepared.advanceTime(28 * 60 * 1000);
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  }), /runtime_unverified/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.candidateBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.deepEqual(prepared.restartPreviousValues, [10]);
});

const failAfterLiveRename = (t, prepared, { failRestore = false, drift = null } = {}) => {
  const rename = fs.renameSync;
  const fsync = fs.fsyncSync;
  let pending = false;
  let publications = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (to === prepared.liveFlowPath) {
      pending = true;
      publications += 1;
    }
  });
  t.mock.method(fs, "fsyncSync", (descriptor) => {
    if (pending && fs.fstatSync(descriptor).isDirectory()) {
      pending = false;
      if (publications === 1 || (publications === 2 && failRestore)) {
        if (drift === "unknown") fs.writeFileSync(prepared.liveFlowPath, "unknown flow bytes");
        if (drift === "missing") fs.unlinkSync(prepared.liveFlowPath);
        throw new Error("synthetic directory fsync failure after live rename");
      }
    }
    return fsync(descriptor);
  });
};

for (const offline of [false, true]) {
  test(`pre-rename failure ${offline ? "retains protection when offline" : "keeps the healthy source without restart"}`, (t) => {
    const prepared = prepareRuntime(t, { liveMode: 0o644 });
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === prepared.liveFlowPath) {
        if (offline) prepared.setProcessState({ status: "errored" });
        throw new Error("synthetic pre-rename failure");
      }
      return rename(from, to);
    });
    assert.throws(() => prepared.runtime.apply({
      candidatePath: prepared.candidatePath,
      contractPath: prepared.contractPath,
      deploymentId: prepared.contract.deploymentId,
      stamp: "20260820T120000+0300",
    }), offline ? /rollback is incomplete and deployment lease remains active/ : /rollback completed/);
    assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
    assert.deepEqual(prepared.restartPreviousValues, []);
    assert.equal(fs.existsSync(prepared.deploymentLeasePath), offline);
  });
}

test("apply restores a candidate published before a directory fsync failure", (t) => {
  const prepared = prepareRuntime(t);
  failAfterLiveRename(t, prepared);
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  }), /rollback completed: synthetic directory fsync failure/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.deepEqual(prepared.restartPreviousValues, [10]);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("restore fsync failure retains the lease for exact rollback resume", (t) => {
  const prepared = prepareRuntime(t);
  failAfterLiveRename(t, prepared, { failRestore: true });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: prepared.contract.deploymentId,
    stamp: "20260820T120000+0300",
  }), /rollback is incomplete and deployment lease remains active/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.deepEqual(prepared.restartPreviousValues, []);
  assert.equal(JSON.parse(fs.readFileSync(prepared.deploymentLeasePath)).phase, "rollback-restart-required");
  const result = prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    flowBackup: path.join(prepared.backupDirectory, "flows-pre-subscription-binding-20260820T120000+0300.json"),
    contractBackup: path.join(prepared.backupDirectory, "contract-subscription-binding-20260820T120000+0300.json"),
  });
  assert.equal(result.rollbackMode, "resume-restart");
  assert.deepEqual(prepared.restartPreviousValues, [10]);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

for (const drift of ["unknown", "missing"]) {
  test(`apply preserves protection for ${drift} live state after publication failure`, (t) => {
    const prepared = prepareRuntime(t);
    failAfterLiveRename(t, prepared, { drift });
    assert.throws(() => prepared.runtime.apply({
      candidatePath: prepared.candidatePath,
      contractPath: prepared.contractPath,
      deploymentId: prepared.contract.deploymentId,
      stamp: "20260820T120000+0300",
    }), /rollback is incomplete and deployment lease remains active/);
    assert.deepEqual(prepared.restartPreviousValues, []);
    assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
    if (drift === "unknown") assert.equal(fs.readFileSync(prepared.liveFlowPath, "utf8"), "unknown flow bytes");
    else assert.equal(fs.existsSync(prepared.liveFlowPath), false);
    prepared.advanceTime(15 * 60 * 1000 + 1);
    assert.throws(() => prepared.runtime.preflight({
      candidatePath: prepared.candidatePath,
      contractPath: prepared.contractPath,
      deploymentId: prepared.contract.deploymentId,
    }), /deployment lease is active/);
  });
}

test("remote runtime resumes an incomplete automatic rollback under the matching lease", (t) => {
  const prepared = prepareRuntime(t, { restartFailures: 2 });
  assert.throws(() => prepared.runtime.apply({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
    stamp: "20260820T120000+0300",
  }), /rollback is incomplete and deployment lease remains active/);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
  assert.equal(
    JSON.parse(fs.readFileSync(prepared.deploymentLeasePath, "utf8")).phase,
    "rollback-restart-required",
  );
  prepared.advanceTime(15 * 60 * 1000 + 1);
  assert.throws(() => prepared.runtime.preflight({
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  }), /deployment lease is active/);

  const flowBackup = path.join(
    prepared.backupDirectory,
    "flows-pre-subscription-binding-20260820T120000+0300.json",
  );
  const contractBackup = path.join(
    prepared.backupDirectory,
    "contract-subscription-binding-20260820T120000+0300.json",
  );
  prepared.setRestartFailures(0);
  const rolledBack = prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup,
    contractBackup,
  });
  assert.equal(rolledBack.rollbackMode, "resume-restart");
  assert.equal(rolledBack.resumedIncompleteRollback, true);
  assert.equal(rolledBack.restartCountBefore, 12);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11, 12]);
});

test("source plus applying lease releases a pre-publication crash without restarting Node-RED", (t) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { phase: "applying" });
  const rolledBack = prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    ...artifacts,
  });
  assert.equal(rolledBack.rollbackMode, "no-publication-release");
  assert.equal(rolledBack.rolledBackFromSha256, null);
  assert.equal(rolledBack.deploymentLeaseReleased, true);
  assert.deepEqual(prepared.restartPreviousValues, []);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("source plus applying lease remains fail-closed when Node-RED is offline", (t) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { phase: "applying" });
  prepared.setProcessState({ status: "errored" });
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    ...artifacts,
  }), /synthetic node-red offline/);
  assert.deepEqual(prepared.restartPreviousValues, []);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
});

test("source under a soaking lease is ambiguous and cannot trigger a restart", (t) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { phase: "soaking" });
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    ...artifacts,
  }), /soaking lease; rollback state is ambiguous/);
  assert.deepEqual(prepared.restartPreviousValues, []);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), true);
});

test("legacy v1 source lease migrates only through an exact guarded restart rollback", (t) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { formatVersion: 1 });
  const rolledBack = prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    ...artifacts,
  });
  assert.equal(rolledBack.rollbackMode, "resume-restart");
  assert.equal(rolledBack.resumedIncompleteRollback, true);
  assert.deepEqual(prepared.restartPreviousValues, [10]);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("legacy v1 candidate lease migrates through exact restore-and-restart rollback", (t) => {
  const prepared = prepareRuntime(t);
  const artifacts = seedSourceLeaseRecovery(prepared, { formatVersion: 1 });
  fs.writeFileSync(prepared.liveFlowPath, prepared.candidateBytes, { mode: 0o600 });
  fs.chmodSync(prepared.liveFlowPath, 0o600);
  const rolledBack = prepared.runtime.rollback({
    deploymentId: prepared.contract.deploymentId,
    ...artifacts,
  });
  assert.equal(rolledBack.rollbackMode, "restore-and-restart");
  assert.deepEqual(prepared.restartPreviousValues, [10]);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), prepared.liveBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("expired legacy v1 candidate can be finalized without changing flow or restarting Node-RED", (t) => {
  const { prepared, artifacts, options } = prepareLegacyCandidateFinalization(t);
  prepared.advanceTime(15 * 60 * 1000 + 1);
  const beforeFlow = fs.readFileSync(prepared.liveFlowPath);
  const finalized = prepared.runtime.finalizeLegacyCandidate(options);
  assert.equal(finalized.action, "finalize-legacy-v1-candidate");
  assert.equal(finalized.activeCandidateAdopted, true);
  assert.equal(finalized.flowChanged, false);
  assert.equal(finalized.nodeRedRestarted, false);
  assert.equal(finalized.deploymentLeaseReleased, true);
  assert.equal(finalized.alreadyFinalized, false);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), beforeFlow);
  assert.deepEqual(prepared.restartPreviousValues, []);
  assert.equal(fs.statSync(finalized.receiptPath).mode & 0o777, 0o600);
  const receiptBytes = fs.readFileSync(finalized.receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(receipt.legacyLeaseSha256, artifacts.leaseSha256);
  assert.equal(receipt.activeFlowSha256, prepared.contract.candidateSha256);
  assert.equal(receipt.flowBackupSha256, prepared.contract.sourceSha256);
  assert.equal(receipt.activeCandidateAdopted, true);
  assert.equal(Object.hasOwn(receipt, "token"), false);

  fs.writeFileSync(prepared.deploymentLeasePath, artifacts.leaseBytes, { mode: 0o600 });
  fs.chmodSync(prepared.deploymentLeasePath, 0o600);
  prepared.setProcessState({ status: "online", pid: 4321 });
  const resumed = prepared.runtime.finalizeLegacyCandidate(options);
  assert.equal(resumed.alreadyFinalized, true);
  assert.equal(resumed.deploymentLeaseReleased, true);
  assert.equal(resumed.nodeRedPid, 4321);
  assert.deepEqual(fs.readFileSync(resumed.receiptPath), receiptBytes);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);

  const idempotent = prepared.runtime.finalizeLegacyCandidate(options);
  assert.equal(idempotent.alreadyFinalized, true);
  assert.equal(idempotent.deploymentLeaseReleased, false);
  assert.deepEqual(fs.readFileSync(prepared.liveFlowPath), beforeFlow);
  assert.deepEqual(prepared.restartPreviousValues, []);
});

test("legacy candidate finalization refuses a live lease, v2 lease, or frozen digest mismatch", (t) => {
  const nonExpired = prepareLegacyCandidateFinalization(t);
  assert.throws(
    () => nonExpired.prepared.runtime.finalizeLegacyCandidate(nonExpired.options),
    /requires an expired deployment lease/,
  );
  assert.equal(fs.existsSync(nonExpired.prepared.deploymentLeasePath), true);
  assert.deepEqual(nonExpired.prepared.restartPreviousValues, []);

  const v2 = prepareLegacyCandidateFinalization(t, { formatVersion: 2 });
  v2.prepared.advanceTime(15 * 60 * 1000 + 1);
  assert.throws(
    () => v2.prepared.runtime.finalizeLegacyCandidate(v2.options),
    /requires a formatVersion 1 deployment lease/,
  );
  assert.equal(fs.existsSync(v2.prepared.deploymentLeasePath), true);

  const digestMismatch = prepareLegacyCandidateFinalization(t);
  digestMismatch.prepared.advanceTime(15 * 60 * 1000 + 1);
  assert.throws(
    () => digestMismatch.prepared.runtime.finalizeLegacyCandidate({
      ...digestMismatch.options,
      expectedLeaseSha256: "0".repeat(64),
    }),
    /Deployment lease differs from the frozen legacy finalization digest/,
  );
  assert.equal(fs.existsSync(digestMismatch.prepared.deploymentLeasePath), true);
});

test("legacy candidate finalization refuses source-active, artifact drift, and a different lease", (t) => {
  const sourceActive = prepareLegacyCandidateFinalization(t);
  sourceActive.prepared.advanceTime(15 * 60 * 1000 + 1);
  fs.writeFileSync(sourceActive.prepared.liveFlowPath, sourceActive.prepared.liveBytes, { mode: 0o600 });
  assert.throws(
    () => sourceActive.prepared.runtime.finalizeLegacyCandidate(sourceActive.options),
    /Active flow differs from the frozen legacy finalization digest/,
  );
  assert.equal(fs.existsSync(sourceActive.prepared.deploymentLeasePath), true);

  const artifactDrift = prepareLegacyCandidateFinalization(t);
  artifactDrift.prepared.advanceTime(15 * 60 * 1000 + 1);
  fs.appendFileSync(artifactDrift.artifacts.contractBackup, " ");
  assert.throws(
    () => artifactDrift.prepared.runtime.finalizeLegacyCandidate(artifactDrift.options),
    /Contract backup differs from the frozen legacy finalization digest/,
  );
  assert.equal(fs.existsSync(artifactDrift.prepared.deploymentLeasePath), true);

  const differentLease = prepareLegacyCandidateFinalization(t);
  differentLease.prepared.advanceTime(15 * 60 * 1000 + 1);
  differentLease.prepared.runtime.finalizeLegacyCandidate(differentLease.options);
  const conflictingLease = {
    ...differentLease.artifacts.lease,
    deploymentId: "other-deployment",
  };
  fs.writeFileSync(
    differentLease.prepared.deploymentLeasePath,
    `${JSON.stringify(conflictingLease, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(differentLease.prepared.deploymentLeasePath, 0o600);
  assert.throws(
    () => differentLease.prepared.runtime.finalizeLegacyCandidate(differentLease.options),
    /deployment lease belongs to other-deployment/,
  );
  assert.equal(fs.existsSync(differentLease.prepared.deploymentLeasePath), true);
  assert.deepEqual(differentLease.prepared.restartPreviousValues, []);
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
  assert.equal(lease.phase, "soaking");
  assert.equal(lease.expiresAtMs - lease.acquiredAtMs, 15 * 60 * 1000);
  assert.throws(() => prepared.runtime.preflight(common), /deployment lease is active/);

  prepared.advanceTime(15 * 60 * 1000 + 1);
  assert.throws(() => prepared.runtime.preflight(common), /Live flow digest differs/);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
});

test("rollback after lease expiry refreshes protection and remains re-entrant after restart failure", (t) => {
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

  prepared.setRestartFailures(0);
  const resumed = prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  });
  assert.equal(resumed.rollbackMode, "resume-restart");
  assert.equal(resumed.resumedIncompleteRollback, true);
  assert.equal(resumed.restartCountBefore, 12);
  assert.equal(fs.existsSync(prepared.deploymentLeasePath), false);
  assert.deepEqual(prepared.restartPreviousValues, [10, 11, 12]);
});

test("rollback refuses source-on-disk recovery without a matching deployment lease", (t) => {
  const prepared = prepareRuntime(t);
  const common = {
    candidatePath: prepared.candidatePath,
    contractPath: prepared.contractPath,
    deploymentId: "subscription-binding",
  };
  const applied = prepared.runtime.apply({ ...common, stamp: "20260820T120000+0300" });
  fs.unlinkSync(prepared.deploymentLeasePath);
  fs.writeFileSync(prepared.liveFlowPath, prepared.liveBytes, { mode: 0o600 });
  fs.chmodSync(prepared.liveFlowPath, 0o600);
  assert.throws(() => prepared.runtime.rollback({
    deploymentId: "subscription-binding",
    flowBackup: applied.flowBackup,
    contractBackup: applied.contractBackup,
  }), /source is active without a matching deployment lease/);
  assert.deepEqual(prepared.restartPreviousValues, [10]);
});

test("durable reviewed-flow writers preserve exact bytes, mode, and exclusive creation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-flow-durable-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const gid = process.getgid();
  const destination = path.join(root, "artifact.json");
  const first = Buffer.from("first\n", "utf8");
  const second = Buffer.from("second\n", "utf8");

  writeFileExclusiveDurable(destination, first, { uid, gid, mode: 0o600 });
  assert.deepEqual(fs.readFileSync(destination), first);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.throws(
    () => writeFileExclusiveDurable(destination, second, { uid, gid, mode: 0o600 }),
    /EEXIST/,
  );

  atomicWrite(destination, second, { uid, gid });
  assert.deepEqual(fs.readFileSync(destination), second);
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});

test("atomic exclusive lease publication recovers from process crashes without a partial final file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-flow-atomic-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uid = process.getuid();
  const gid = process.getgid();
  const moduleUrl = new URL(
    "../nodered_reviewed_flow_deploy/runtime_contract.mjs",
    import.meta.url,
  ).href;
  const childProgram = `
    const [moduleUrl, destination, uid, gid, crashPhase] = process.argv.slice(1);
    const { writeFileExclusiveAtomicDurable } = await import(moduleUrl);
    writeFileExclusiveAtomicDurable(destination, Buffer.from("crash-safe\\n", "utf8"), {
      uid: Number(uid),
      gid: Number(gid),
      mode: 0o600,
      onTransition: (phase) => {
        if (phase === crashPhase) process.kill(process.pid, "SIGKILL");
      },
    });
  `;
  const crashAt = (destination, phase) => spawnSync(
    process.execPath,
    ["--input-type=module", "-e", childProgram, moduleUrl, destination, String(uid), String(gid), phase],
    { encoding: "utf8" },
  );

  const beforeLink = path.join(root, "before-link.lease.json");
  const beforeLinkResult = crashAt(beforeLink, "temporary-synced");
  assert.equal(beforeLinkResult.signal, "SIGKILL");
  assert.equal(fs.existsSync(beforeLink), false);
  writeFileExclusiveAtomicDurable(beforeLink, Buffer.from("retry\n"), { uid, gid });
  assert.equal(fs.readFileSync(beforeLink, "utf8"), "retry\n");

  const afterLink = path.join(root, "after-link.lease.json");
  const afterLinkResult = crashAt(afterLink, "destination-linked");
  assert.equal(afterLinkResult.signal, "SIGKILL");
  assert.equal(fs.readFileSync(afterLink, "utf8"), "crash-safe\n");
  assert.equal(fs.statSync(afterLink).nlink, 2);
  assert.equal(recoverAtomicExclusivePublication(afterLink, { uid, gid }), true);
  assert.equal(fs.statSync(afterLink).nlink, 1);
  assert.equal(fs.readFileSync(afterLink, "utf8"), "crash-safe\n");
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
  const changedAfterDeploy = fixture();
  changedAfterDeploy.find((node) => node.id === "response").name = "unexpected drift";
  fs.writeFileSync(prepared.liveFlowPath, bytes(changedAfterDeploy), { mode: 0o600 });
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
  assert.match(remoteHelper, /finalize-legacy-v1-candidate/);
  assert.match(remoteHelper, /expected-lease-sha256/);
  const flowBackupIndex = remoteHelper.indexOf("writeFileExclusiveDurable(flowBackup");
  const contractBackupIndex = remoteHelper.indexOf("writeFileExclusiveDurable(contractBackup");
  const leaseIndex = remoteHelper.indexOf("let deploymentLease = acquireDeploymentLease");
  assert.equal(flowBackupIndex >= 0, true);
  assert.equal(contractBackupIndex > flowBackupIndex, true);
  assert.equal(leaseIndex > contractBackupIndex, true);
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
  assert.doesNotMatch(wrapper, /--allow-change 8f7bd5b482fe9763:func/);
  assert.match(wrapper, /--allow-change lk_subscription_booking_prepare_20260804:func/);
  assert.match(wrapper, /--allow-change lk_subscription_booking_http_20260804:requestTimeout/);
  assert.doesNotMatch(wrapper, /lk_subscription_booking_http_20260804:headers/);
  assert.match(wrapper, /--allow-change lk_subscription_booking_router_20260804:func(?:\s|\\)/);
  assert.doesNotMatch(wrapper, /lk_subscription_booking_router_20260804:func,outputs,wires/);
  assert.match(wrapper, /--allow-change lk_subscription_managed_policy_20260820:func/);
  assert.match(wrapper, /--allow-change lk_subscription_booking_finalize_20260804:func/);
  assert.match(wrapper, /--allow-change lk_subscription_booking_mongo_error_20260804:func/);
  assert.doesNotMatch(wrapper, /--allow-add lk_subscription_managed_policy_20260820/);
  assert.match(wrapper, /value\.changedNodeCount !== 6/);
  assert.match(wrapper, /value\.addedNodeCount !== 0/);
  assert.match(wrapper, /subscriptionOptionsStatus/);
  assert.match(rollback, /NODE_RED_MANAGED_SUBSCRIPTION_RULES_ROLLBACK=CONFIRM_147/);
  assert.match(rollback, /rollback --deployment-id/);
  assert.doesNotMatch(wrapper + rollback, /rm\s+-rf|--update-env/);
});

test("managed subscription patcher output satisfies the wrapper exact-graph contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-subscription-wrapper-contract-"));
  const sourcePath = path.join(root, "source.flow.json");
  const candidateOnePath = path.join(root, "candidate-one.json");
  const candidateTwoPath = path.join(root, "candidate-two.json");
  const contractPath = path.join(root, "contract.json");
  const splitRouterSource = fs.readFileSync(
    "scripts/nodered_games_nodes/fn_split_router.js", "utf8",
  )
    .replace("  ctx.operationId = operationId;\n", "")
    .replace("  const settlementState = toPayMinor > 0 ? \"PAYMENT_REQUIRED\" : \"CONFIRMED\";\n", "")
    .replace("    gameId: toStr(ctx.gameId) || null,\n", "")
    .replace("    operationId: toStr(ctx.operationId) || toStr(ctx.paymentRef),\n", "")
    .replace("    settlementState,\n", "");
  assert.equal(
    sha256(splitRouterSource),
    "a480563d9b0ea98fa0917e5535f22c5528481d33052e3971517b110ae573cae4",
    "fixture must remain the exact reviewed live preimage",
  );
  const splitWires = [
    ["ee7ba8cdd68bdf74"],
    ["802af8a1810db60f"],
    ["ef42932e1ba864b8"],
    ["lk_subscription_booking_http_20260804"],
    ["legacy_payment_confirm_canonical_prepare_20260816"],
  ];
  const writeSource = (flow) => {
    const sourceBytes = bytes(flow);
    fs.writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "source.flow.meta.json"), JSON.stringify({
      sourceKind: "live-147",
      sourceHost: "lk-primary-147",
      sourceUser: "root",
      sourcePort: 22,
      remoteFlowPath: "/root/.node-red/flows.json",
      pulledAt: new Date().toISOString(),
      sourceSha256: sha256(sourceBytes),
    }), { mode: 0o600 });
  };
  const runPatcher = (candidatePath, importName) => spawnSync(process.execPath, [
    "scripts/patch_nodered_subscription_booking_flow.mjs",
    sourcePath,
    candidatePath,
    path.join(root, importName),
  ], { encoding: "utf8" });
  try {
    writeSource([
      { id: "tab", type: "tab", label: "LK Games", disabled: false },
      { id: "8f7bd5b482fe9763", type: "function", z: "tab", name: "Route Viva split payment", outputs: 5, func: splitRouterSource, wires: splitWires },
      { id: "ee7ba8cdd68bdf74", type: "http request", z: "tab", wires: [["8f7bd5b482fe9763"]] },
      { id: "802af8a1810db60f", type: "function", z: "tab", func: "return null;", wires: [] },
      { id: "ef42932e1ba864b8", type: "function", z: "tab", func: "return null;", wires: [] },
      { id: "legacy_payment_confirm_canonical_prepare_20260816", type: "function", z: "tab", func: "return null;", wires: [] },
      { id: "game-mongo", type: "mongodb4", z: "tab", collection: "lk_games", clientNode: "mongo-client", wires: [] },
      { id: "mongo-client", type: "mongodb4-client", uri: "mongodb://127.0.0.1:27030/lk1_dev" },
    ]);
    const first = runPatcher(candidateOnePath, "import-one.json");
    assert.equal(first.status, 0, first.stderr);

    const live = JSON.parse(fs.readFileSync(candidateOnePath, "utf8"));
    const interleavedNodeIndex = live.findIndex((node) => node.id === "802af8a1810db60f");
    const [interleavedNode] = live.splice(interleavedNodeIndex, 1);
    const managedPrepareIndex = live.findIndex((node) => (
      node.id === "lk_subscription_booking_prepare_20260804"
    ));
    live.splice(managedPrepareIndex + 1, 0, interleavedNode);
    live.find((node) => node.id === "lk_subscription_booking_prepare_20260804").func = "return msg;";
    const http = live.find((node) => node.id === "lk_subscription_booking_http_20260804");
    http.requestTimeout = "1000";
    const router = live.find((node) => node.id === "lk_subscription_booking_router_20260804");
    router.func = "return msg;";
    live.find((node) => node.id === "lk_subscription_managed_policy_20260820").func = "return msg;";
    live.find((node) => node.id === "lk_subscription_booking_finalize_20260804").func = "return msg;";
    live.find((node) => node.id === "lk_subscription_booking_mongo_error_20260804").func = "return msg;";
    writeSource(live);

    const second = runPatcher(candidateTwoPath, "import-two.json");
    assert.equal(second.status, 0, second.stderr);
    const candidateTwo = JSON.parse(fs.readFileSync(candidateTwoPath, "utf8"));
    assert.deepEqual(candidateTwo.map(({ id }) => id), live.map(({ id }) => id),
      "patcher must preserve the exact order of every existing live node");
    const contract = spawnSync(process.execPath, [
      "scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs",
      "--live", sourcePath,
      "--candidate", candidateTwoPath,
      "--output", contractPath,
      "--deployment-id", "managed-subscription-rules",
      "--allow-change", "lk_subscription_booking_prepare_20260804:func",
      "--allow-change", "lk_subscription_booking_http_20260804:requestTimeout",
      "--allow-change", "lk_subscription_booking_router_20260804:func",
      "--allow-change", "lk_subscription_managed_policy_20260820:func",
      "--allow-change", "lk_subscription_booking_finalize_20260804:func",
      "--allow-change", "lk_subscription_booking_mongo_error_20260804:func",
    ], { encoding: "utf8" });
    assert.equal(contract.status, 0, contract.stderr);
    const contractJson = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    assert.equal(contractJson.allowedChanges.length, 6);
    assert.equal(contractJson.allowedAdditions.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
