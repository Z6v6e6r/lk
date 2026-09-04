import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkedDeployPostcheckGate,
  validateDeployPostcheckGate,
} from "../validate_lk1_subscription_dev_deploy_postcheck_gate.mjs";
import {
  captureCurrentHostPreflightEvidence,
  checkedHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const clone = (value) => structuredClone(value);
const NOW = new Date("2026-09-04T09:40:00Z");
const readJson = (relativePath) => JSON.parse(fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8",
));
const currentRepositoryIdentity = () => ({
  headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  treeSha: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  clean: true,
});
const unitFragmentSha256 = {
  "lk1-subscription-dev-mongo.service": "370f07b518f14d87ba78d2cdc3e3cd15714349cf664d2bf53ac95ec2125a9980",
  "lk1-subscription-dev-cup.service": "745333370a304d2d1e70add583930d73f704002c634e9eba4343dda7dca45b90",
  "lk1-subscription-dev-provider-fixture.service": "dbf8a46a002b7f478b011b2afeb2a09837d8f44ecd5873a5225a6da6a895bca5",
  "lk1-subscription-dev-identity-fixture.service": "673fa03feb87aa886d408684ca947609263929ef178d395d93480fe096488179",
  "lk1-subscription-dev-nodered.service": "75fafcae24c5aefdca545786967bed12d509d12d2555a37d94e23571732f764a",
};
const hostTranscript = [
  `HOSTNAME\t${checkedHostPreflightEvidence.target.hostname}`,
  `MACHINE_ID_SHA256\t${checkedHostPreflightEvidence.target.machineIdSha256}`,
  `SYSTEMD_VERSION\t${checkedHostPreflightEvidence.hostCapabilities.systemdVersion}`,
  ...Object.entries(checkedHostPreflightEvidence.dedicatedUnits).map(([unit, state]) => (
    `UNIT\t${unit}\t${state.loadState}\t${state.activeState}\t${state.unitFileState}`
  )),
  ...Object.keys(checkedHostPreflightEvidence.dedicatedUnits).map((unit) => (
    `UNIT_ISOLATION\t${unit}\t${unitFragmentSha256[unit]}\ttrue\ttrue\ttrue`
  )),
  "LISTENER\t1880\tPRESENT", "LISTENER\t3036\tPRESENT", "LISTENER\t1882\tABSENT",
  "LISTENER\t27030\tABSENT", "LISTENER\t3037\tABSENT", "LISTENER\t3038\tABSENT",
  "LISTENER\t3039\tABSENT", "INPUT\ttargetFlowAbsent\ttrue",
  "INPUT\tfixtureConfigAbsent\ttrue", "INPUT\treleaseReceiptAbsent\ttrue",
  "INPUT\tserviceStartAuthorizationAbsent\ttrue", "INPUT\tinstallIdentityEnvironmentAbsent\ttrue",
  "INGRESS_ISOLATION\ttrue\ttrue",
  "PRODUCTION_MARKERS_ABSENT\ttrue",
  `SHARED_FLOW_SHA256\t${checkedHostPreflightEvidence.sharedResources.flowSha256}`,
  "END",
].join("\n");

test("source-only deploy/post-check gate binds the isolated DEV target without live claims", () => {
  assert.equal(validateDeployPostcheckGate(checkedDeployPostcheckGate), true);
  assert.equal(checkedDeployPostcheckGate.state, "PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW");
  assert.equal(checkedDeployPostcheckGate.productionBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(checkedDeployPostcheckGate.productionIsolation.crossEnvironmentWriteBudget, 0);
  assert.equal(checkedDeployPostcheckGate.predeploy.state, "HISTORICAL_PASS_REQUIRES_REFRESH");
  assert.equal(checkedDeployPostcheckGate.postcheck.state, "NOT_RUN");
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.cupMatchesDedicatedListener, true);
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.mongoMatchesProvisionedDatabase, true);
  assert.equal(checkedDeployPostcheckGate.runtimeBinding.hostRuntimeExposed, false);
  assert.equal(checkedDeployPostcheckGate.blockers.length, 0);
  assert.equal(Object.values(checkedDeployPostcheckGate.authority).every((value) => value === false), true);
  assert.equal(Object.values(checkedDeployPostcheckGate.claims).every((value) => value === false), true);
});

test("source-only gate archive is deterministic and cannot claim current evidence", () => {
  assert.equal(validateDeployPostcheckGate(checkedDeployPostcheckGate), true);
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    now: NOW,
  }), /fresh host evidence object is required/);
});

test("fresh preflight has a new timestamp while immutable archive metadata stays bound", () => {
  const repositoryIdentity = currentRepositoryIdentity();
  const freshHostPreflightEvidence = captureCurrentHostPreflightEvidence({
    runSsh: () => hostTranscript,
    now: NOW,
    readRepositoryIdentity: () => repositoryIdentity,
  });
  assert.notEqual(freshHostPreflightEvidence.capturedAt, checkedDeployPostcheckGate.predeploy.capturedAt);
  assert.equal(validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    freshHostPreflightEvidence,
    now: NOW,
  }), true);
  const changed = clone(freshHostPreflightEvidence);
  changed.releaseBinding.manifestSha256 = "a".repeat(64);
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    freshHostPreflightEvidence: changed,
    now: NOW,
  }), /release binding/);
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
    (value) => { value.predeploy.state = "PASS_AT_CAPTURE"; },
    (value) => { value.predeploy.freshEvidenceRequired = false; },
    (value) => { value.predeploy.mustRefreshImmediatelyBeforeInstall = false; },
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
    assert.throws(() => validateDeployPostcheckGate(changed));
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
    () => validateDeployPostcheckGate(checkedDeployPostcheckGate, { releaseReceipt: badReceipt }),
    /candidate identity diverges|release binding drift/,
  );
});

test("gate rejects coordinated gate and receipt digest drift against source authorization", () => {
  const changedGate = clone(checkedDeployPostcheckGate);
  changedGate.releaseBinding.candidateSha256 = "c".repeat(64);
  const changedReceipt = readJson("../lk1_subscription_dev_release_receipt_v2_contract.json");
  changedReceipt.candidateSha256 = changedGate.releaseBinding.candidateSha256;
  assert.throws(
    () => validateDeployPostcheckGate(changedGate, { releaseReceipt: changedReceipt }),
    /candidate identity diverges|authorization contract mismatch|authorized candidate source identity/,
  );
});

test("gate detects linked candidate CUP and Mongo identity drift", () => {
  const runtimeEnvironmentBindings = readJson("../lk1_subscription_runtime_environment_bindings.json");
  runtimeEnvironmentBindings.DEV_ENDPOINTS.cupApiBase = "http://127.0.0.1:3036/api";
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    runtimeEnvironmentBindings,
  }), /bindings diverge|runtime identity/);

  const candidateBinding = readJson("../lk1_subscription_dev_candidate_binding.json");
  candidateBinding.dependencies.managedMongoClient.effectiveIdentity.database
    = "dev-lk1-subscription-canary";
  assert.throws(() => validateDeployPostcheckGate(checkedDeployPostcheckGate, {
    candidateBinding,
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
    "HOST_PREFLIGHT_CURRENT=NOT_CLAIMED",
    "DEV_DEPLOYED=NOT_CLAIMED",
    "DEV_ACTIVE=NOT_CLAIMED",
    "",
  ].join("\n"));
});
