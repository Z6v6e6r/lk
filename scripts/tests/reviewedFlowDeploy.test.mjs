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
        processStatus = "errored";
        processPid = 0;
        throw new Error("synthetic restart failure");
      }
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
  const resumed = prepared.runtime.finalizeLegacyCandidate(options);
  assert.equal(resumed.alreadyFinalized, true);
  assert.equal(resumed.deploymentLeaseReleased, true);
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
  assert.match(wrapper, /--allow-change 8f7bd5b482fe9763:func/);
  assert.match(wrapper, /--allow-add lk_subscription_managed_policy_20260820/);
  assert.match(wrapper, /value\.changedNodeCount !== 3/);
  assert.match(wrapper, /value\.addedNodeCount !== 2/);
  assert.match(wrapper, /subscriptionOptionsStatus/);
  assert.match(rollback, /NODE_RED_MANAGED_SUBSCRIPTION_RULES_ROLLBACK=CONFIRM_147/);
  assert.match(rollback, /rollback --deployment-id/);
  assert.doesNotMatch(wrapper + rollback, /rm\s+-rf|--update-env/);
});
