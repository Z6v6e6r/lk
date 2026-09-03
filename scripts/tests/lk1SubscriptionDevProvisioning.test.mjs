import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import {
  checkedProvisioningContract,
  validateDevProvisioningContract,
} from "../validate_lk1_subscription_dev_provisioning_contract.mjs";

const clone = () => structuredClone(checkedProvisioningContract);
const TEMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp";

test("checked DEV provisioning contract authorizes only stopped bootstrap", () => {
  assert.equal(validateDevProvisioningContract(clone()), true);
  assert.equal(checkedProvisioningContract.executionAuthorized, false);
  assert.equal(checkedProvisioningContract.bootstrapInstallAllowed, true);
  assert.equal(checkedProvisioningContract.candidateBuildAllowed, false);
  assert.equal(checkedProvisioningContract.installAllowed, false);
  assert.equal(checkedProvisioningContract.serviceStartAllowed, false);
  assert.equal(checkedProvisioningContract.ingressAllowed, false);
  assert.equal(checkedProvisioningContract.activationAllowed, false);
  assert.deepEqual(Object.values(checkedProvisioningContract.releaseIdentity), [null, null, null, null]);
  assert.equal(checkedProvisioningContract.bootstrapAuthorization.scope,
    "CREATE_IDENTITY_AND_INSTALL_STOPPED_DEPENDENCIES");
  assert.ok(Object.entries(checkedProvisioningContract.bootstrapAuthorization)
    .filter(([key]) => key.endsWith("Allowed"))
    .every(([, value]) => value === false));
});

test("planned target cannot reuse shared Node-RED identity", () => {
  for (const mutate of [
    (value) => { value.plannedTarget.unixUser = "root"; },
    (value) => { value.plannedTarget.userDir = "/root/.node-red"; },
    (value) => { value.plannedTarget.flowPath = "/root/.node-red/flows.json"; },
    (value) => { value.plannedTarget.listener.host = "0.0.0.0"; value.plannedTarget.listener.port = 1880; },
  ]) {
    const value = clone();
    mutate(value);
    assert.throws(() => validateDevProvisioningContract(value));
  }
  const productionHost = clone();
  productionHost.plannedTarget.sourceHost = "lk-primary-147";
  assert.throws(() => validateDevProvisioningContract(productionHost), /exact dedicated loopback identity/);
  const hiddenTarget = clone();
  hiddenTarget.plannedTarget.targetHost = "lk-primary-147";
  assert.throws(() => validateDevProvisioningContract(hiddenTarget), /fields do not match/);
});

test("planned dependencies cannot reuse existing shadow or production access", () => {
  const sharedMongo = clone();
  sharedMongo.fixtureDependencies.mongo.port = 27029;
  assert.throws(() => validateDevProvisioningContract(sharedMongo), /not isolated|existing or duplicate listener/);
  const sharedCup = clone();
  sharedCup.fixtureDependencies.cup.listener = "127.0.0.1:3036";
  assert.throws(() => validateDevProvisioningContract(sharedCup), /not isolated|existing or duplicate listener/);
  const network = clone();
  network.networkPolicy.nonLoopbackEgressAllowed = true;
  assert.throws(() => validateDevProvisioningContract(network), /deny every non-loopback/);
  const sharedService = clone();
  sharedService.fixtureDependencies.mongo.serviceName = "nodered.service";
  assert.throws(() => validateDevProvisioningContract(sharedService), /not isolated/);
  const sharedDbPath = clone();
  sharedDbPath.fixtureDependencies.mongo.dbPath = "/root/.node-red";
  assert.throws(() => validateDevProvisioningContract(sharedDbPath), /not isolated/);
});

test("ingress, flags, release SHA and execution remain unbound until separately reviewed", () => {
  const ingress = clone();
  ingress.plannedTarget.ingress = {
    state: "BOUND",
    origin: "https://subscriptions-dev.example.test",
    configPath: "/etc/nginx/example.conf",
    sharedListenerAllowed: true,
  };
  assert.throws(() => validateDevProvisioningContract(ingress), /ingress must remain unbound/);
  const enabled = clone();
  enabled.runtimeFlags.canaryClientSubscriptionIds = ["00000000-0000-4000-8000-000000000001"];
  assert.throws(() => validateDevProvisioningContract(enabled), /default-off/);
  const identified = clone();
  identified.releaseIdentity.sourceSha256 = "a".repeat(64);
  assert.throws(() => validateDevProvisioningContract(identified), /remain unbound/);
  const missingIdentity = clone();
  missingIdentity.releaseIdentity = {};
  assert.throws(() => validateDevProvisioningContract(missingIdentity), /fields do not match/);
  const malformedFlags = clone();
  malformedFlags.runtimeFlags.managedProductIds = "";
  malformedFlags.runtimeFlags.canaryClientSubscriptionIds = "";
  assert.throws(() => validateDevProvisioningContract(malformedFlags), /default-off/);
  const executable = clone();
  executable.executionAuthorized = true;
  assert.throws(() => validateDevProvisioningContract(executable), /only the stopped bootstrap/);
  const buildable = clone();
  buildable.candidateBuildAllowed = true;
  assert.throws(() => validateDevProvisioningContract(buildable), /only the stopped bootstrap/);
  const rollback = clone();
  rollback.rollback.serviceStopOrder = [];
  assert.throws(() => validateDevProvisioningContract(rollback), /not fail-safe/);
  const ingressAuthorized = clone();
  ingressAuthorized.ingressAllowed = true;
  ingressAuthorized.ingressAuthorization.approved = true;
  assert.throws(() => validateDevProvisioningContract(ingressAuthorized), /only the stopped bootstrap/);
  const ingressTuple = clone();
  ingressTuple.ingressAuthorization.origin = "https://subscriptions-dev.example.test";
  assert.throws(() => validateDevProvisioningContract(ingressTuple), /separately unauthorized/);
  const overBroadBootstrap = clone();
  overBroadBootstrap.bootstrapAuthorization.serviceStartAllowed = true;
  assert.throws(() => validateDevProvisioningContract(overBroadBootstrap), /over-broad/);
  const missingBootstrapAuthority = clone();
  missingBootstrapAuthority.bootstrapInstallAllowed = false;
  assert.throws(() => validateDevProvisioningContract(missingBootstrapAuthority), /only the stopped bootstrap/);
});

test("shared-flow evidence has an exact timestamp and non-negative count schema", () => {
  const timestamp = clone();
  timestamp.evidence.capturedAt = "not-a-time";
  assert.throws(() => validateDevProvisioningContract(timestamp), /absence evidence is incomplete/);
  for (const impossible of ["2026-99-99T99:99:99Z", "2026-02-31T12:00:00Z"]) {
    const invalidCalendar = clone();
    invalidCalendar.evidence.capturedAt = impossible;
    assert.throws(() => validateDevProvisioningContract(invalidCalendar), /absence evidence is incomplete/);
  }
  const counts = clone();
  counts.evidence.sharedFlowNodeCount = -1;
  assert.throws(() => validateDevProvisioningContract(counts), /absence evidence is incomplete/);
  const hiddenEvidence = clone();
  hiddenEvidence.evidence.unreviewed = true;
  assert.throws(() => validateDevProvisioningContract(hiddenEvidence), /fields do not match/);
});

test("read-only pull rejects a lexical temp path that canonicalizes outside temp", () => {
  const lexicalEscape = `${TEMP_ROOT}/../lk1-dev-provisioning-path-escape`;
  assert.match(lexicalEscape, /\/\.\.\//);
  const result = spawnSync("bash", [
    "scripts/pull_nodered_dev_source_readonly.sh",
    lexicalEscape,
  ], { encoding: "utf8" });
  assert.equal(result.status, 65);
  assert.match(result.stderr, /must be under \/private\/tmp or \/tmp/);
  assert.doesNotMatch(result.stderr, /ssh|connection/i);
});
