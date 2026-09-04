import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkedDeployPostcheckGate,
  validateDeployPostcheckGate,
} from "../validate_lk1_subscription_dev_deploy_postcheck_gate.mjs";

const clone = (value) => structuredClone(value);
const NOW = new Date("2026-09-04T09:30:00Z");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8",
));

test("source-only deploy/post-check gate binds the isolated DEV target without live claims", () => {
  assert.equal(validateDeployPostcheckGate(checkedDeployPostcheckGate, { now: NOW }), true);
  assert.equal(checkedDeployPostcheckGate.state, "PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW");
  assert.equal(checkedDeployPostcheckGate.productionBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(checkedDeployPostcheckGate.productionIsolation.crossEnvironmentWriteBudget, 0);
  assert.equal(checkedDeployPostcheckGate.predeploy.state, "PASS_AT_CAPTURE");
  assert.equal(checkedDeployPostcheckGate.postcheck.state, "NOT_RUN");
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.cupMatchesDedicatedListener, true);
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.mongoMatchesProvisionedDatabase, true);
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.hostRuntimeExposed, false);
  assert.equal(checkedDeployPostcheckGate.blockers.length, 0);
  assert.equal(Object.values(checkedDeployPostcheckGate.authority).every((value) => value === false), true);
  assert.equal(Object.values(checkedDeployPostcheckGate.claims).every((value) => value === false), true);
});

test("gate rejects release, target, production-isolation, evidence, canary, and authority drift", () => {
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.releaseBinding.candidateSha256 = "a".repeat(64); },
    (value) => { value.target.hostAlias = "lk-primary-147"; },
    (value) => { value.target.listener = "0.0.0.0:1880"; },
    (value) => { value.target.fixtureListeners[0] = "127.0.0.1:27029"; },
    (value) => { value.runtimeBinding.candidateCupApiBase = "http://127.0.0.1:3036/api"; },
    (value) => { value.runtimeBinding.cupMatchesDedicatedListener = false; },
    (value) => { value.runtimeBinding.candidateMongo.database = "dev-lk1-subscription-canary"; },
    (value) => { value.runtimeBinding.mongoMatchesProvisionedDatabase = false; },
    (value) => { value.runtimeBinding.completeManagedContractSourceImplemented = false; },
    (value) => { value.runtimeBinding.localPhysicalVerified = false; },
    (value) => { value.runtimeBinding.hostRuntimeExposed = true; },
    (value) => { value.runtimeBinding.completeManagedContractExposed = true; },
    (value) => { value.productionIsolation.productionOriginPolicy = "ALLOW"; },
    (value) => { value.productionIsolation.nonLoopbackEgressAllowed = true; },
    (value) => { value.productionIsolation.crossEnvironmentWriteBudget = 1; },
    (value) => { value.predeploy.state = "NOT_RUN"; },
    (value) => { value.predeploy.checks.pop(); },
    (value) => { value.postcheck.state = "PASS"; },
    (value) => { value.postcheck.observationWindowSeconds.minimum = 599; },
    (value) => { value.postcheck.phases[0].state = "PASS"; },
    (value) => { value.postcheck.requiredZeroCounters.pop(); },
    (value) => { value.canaryActivation.exactCount = 3; },
    (value) => { value.canaryActivation.valuesIncluded = true; },
    (value) => { value.rollback.state = "PASS"; },
    (value) => { value.rollback.serviceStopOrder.reverse(); },
    (value) => { value.rollback.deleteData = true; },
    (value) => { value.blockers.push("STALE_PREFLIGHT"); },
    (value) => { value.authority.hostRead = true; },
    (value) => { value.authority.hostInstall = true; },
    (value) => { value.claims.deploymentPerformed = true; },
    (value) => { value.claims.devActive = true; },
  ]) {
    const changed = clone(checkedDeployPostcheckGate);
    mutate(changed);
    assert.throws(() => validateDeployPostcheckGate(changed, { now: NOW }));
  }
});

test("gate rejects drift in the linked release receipt", () => {
  const badReceipt = {
    schemaVersion: 2,
    environment: "DEV",
    state: "SOURCE_ONLY",
    sourceCommit: checkedDeployPostcheckGate.releaseBinding.sourceCommit,
    sourceFlowSha256: checkedDeployPostcheckGate.releaseBinding.sourceFlowSha256,
    candidateSha256: checkedDeployPostcheckGate.releaseBinding.candidateSha256,
    manifestSha256: "b".repeat(64),
    hostReadbackSha256: null,
    servedSha256: null,
    hostPreimage: { state: "ABSENT", sha256: null },
    rollback: {
      mode: "RETURN_TO_ABSENT",
      restoreSha256: null,
      preserveEvidence: true,
      deleteData: false,
      requiresSeparateAuthorization: true,
    },
    target: {
      hostAlias: "lk-reserve-89",
      serviceName: "lk1-subscription-dev-nodered.service",
      flowPath: "/srv/lk1-subscription-dev/node-red/flows.json",
    },
    authority: { hostInstall: false, serviceStart: false, ingress: false, activation: false },
  };
  assert.throws(
    () => validateDeployPostcheckGate(checkedDeployPostcheckGate, { releaseReceipt: badReceipt, now: NOW }),
    /candidate identity diverges|release binding drift/,
  );
});

test("gate rejects coordinated gate and receipt digest drift against source authorization", () => {
  const changedGate = clone(checkedDeployPostcheckGate);
  changedGate.releaseBinding.candidateSha256 = "c".repeat(64);
  const changedReceipt = readJson("../lk1_subscription_dev_release_receipt_v2_contract.json");
  changedReceipt.candidateSha256 = changedGate.releaseBinding.candidateSha256;
  assert.throws(
    () => validateDeployPostcheckGate(changedGate, { releaseReceipt: changedReceipt, now: NOW }),
    /candidate identity diverges|authorization contract mismatch|authorized candidate source identity/,
  );
});

test("gate detects linked candidate CUP and Mongo identity drift", () => {
  const runtimeEnvironmentBindings = readJson("../lk1_subscription_runtime_environment_bindings.json");
  runtimeEnvironmentBindings.DEV_ENDPOINTS.cupApiBase = "http://127.0.0.1:3037/api";
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    runtimeEnvironmentBindings,
    now: NOW,
  }), /bindings diverge|runtime identity/);

  const candidateBinding = readJson("../lk1_subscription_dev_candidate_binding.json");
  candidateBinding.dependencies.managedMongoClient.effectiveIdentity.database
    = "lk1_subscription_dev_fixture";
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    candidateBinding,
    now: NOW,
  }), /Mongo|runtime identity/);
});

test("CLI is local validation only and never claims deployed or active state", () => {
  const script = fileURLToPath(new URL(
    "../validate_lk1_subscription_dev_deploy_postcheck_gate.mjs",
    import.meta.url,
  ));
  const output = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(output, [
    "LK1_DEV_DEPLOY_POSTCHECK_GATE=PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW",
    "DEV_DEPLOYED=NOT_CLAIMED",
    "DEV_ACTIVE=NOT_CLAIMED",
    "",
  ].join("\n"));
});
