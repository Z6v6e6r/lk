import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  validateCheckedPartnerRuntimeEvidence,
  validatePartnerRuntimeEvidence,
} from "../validate_partner_game_membership_runtime.mjs";

const runtimeRoot = new URL("../partner_game_membership_runtime/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, runtimeRoot));

function evidence() {
  const checked = validateCheckedPartnerRuntimeEvidence();
  return {
    manifestBytes: read("runtime-manifest.json"),
    packageJsonBytes: read("package.json"),
    packageLockBytes: read("package-lock.json"),
    dependencyTreeBytes: read("dependency-tree.json"),
    auditReportBytes: read("audit-report.json"),
    functionalRehearsalBytes: read("functional-rehearsal.json"),
    customReleaseSha256: checked.manifest.closure.customNodeReleaseSha256,
  };
}

const mutateJson = (bytes, mutate) => {
  const value = JSON.parse(bytes.toString("utf8"));
  mutate(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("checked runtime pins exact Node-RED, custom node, npm ci, npm ls, and audit evidence", () => {
  const result = validateCheckedPartnerRuntimeEvidence();
  assert.equal(result.manifest.state, "SECURITY_AUDIT_PASS");
  assert.equal(result.manifest.runtime.nodeRedVersion, "5.0.6");
  assert.equal(result.manifest.runtime.architecture, "x64");
  assert.equal(result.manifest.audit.affectedPackages.high, 0);
  assert.equal(result.functionalRehearsal.defaultOff.httpStatus, 503);
  assert.equal(result.functionalRehearsal.packageRollback.httpStatus, 404);
});

test("shared production palette risk observation forces the dedicated sidecar boundary", () => {
  const observation = JSON.parse(read("shared-runtime-isolation-observation.json").toString("utf8"));
  assert.equal(observation.evidenceScope, "LOCAL_REHEARSAL_WITH_EXACT_READ_ONLY_PRODUCTION_PALETTE_VERSIONS");
  assert.equal(observation.productionReadback.nodeRedVersion, "4.0.9");
  assert.equal(observation.productionReadback.flowNodeCount, 4762);
  assert.equal(Object.keys(observation.rehearsal.directPaletteDependencies).length, 16);
  assert.equal(observation.rehearsal.directPaletteDependencies["crypto-wz"], "1.0.2");
  assert.deepEqual(observation.rehearsal.affectedPackages, {
    critical: 5, high: 12, moderate: 23, low: 0, total: 40,
  });
  assert.deepEqual(observation.rehearsal.criticalPackages, [
    "crypto-js", "crypto-wz", "form-data", "jsonata", "request",
  ]);
  assert.equal(observation.decision, "DEDICATED_MINIMAL_SIDECAR_REQUIRED_SHARED_RUNTIME_FORBIDDEN");
  assert.equal(observation.sharedNodeRedFlowMutationAllowed, false);
  assert.equal(observation.productionTouched, false);
});

test("runtime evidence rejects functional rehearsal drift or production overclaim", () => {
  const releaseDrift = evidence();
  releaseDrift.functionalRehearsalBytes = mutateJson(releaseDrift.functionalRehearsalBytes, (value) => {
    value.customNodeReleaseSha256 = "0".repeat(64);
  });
  assert.throws(() => validatePartnerRuntimeEvidence(releaseDrift), /closure hash mismatch/);

  const productionOverclaim = evidence();
  productionOverclaim.functionalRehearsalBytes = mutateJson(productionOverclaim.functionalRehearsalBytes, (value) => {
    value.productionTouched = true;
  });
  assert.throws(() => validatePartnerRuntimeEvidence(productionOverclaim), /closure hash mismatch/);
});

test("runtime evidence returns an immutable-by-copy byte snapshot for packet assembly", () => {
  const input = evidence();
  const originalPackageLock = Buffer.from(input.packageLockBytes);
  const result = validatePartnerRuntimeEvidence(input);
  input.packageLockBytes.fill(0);
  assert.equal(result.artifactBytes["package-lock.json"].equals(originalPackageLock), true);
  assert.notEqual(result.artifactBytes["package-lock.json"], input.packageLockBytes);
});

test("runtime evidence rejects lockfile or custom-node drift", () => {
  const lockDrift = evidence();
  lockDrift.packageLockBytes = mutateJson(lockDrift.packageLockBytes, (value) => {
    value.packages["node_modules/node-red"].version = "5.0.5";
  });
  assert.throws(() => validatePartnerRuntimeEvidence(lockDrift), /closure hash mismatch/);

  const releaseDrift = evidence();
  releaseDrift.customReleaseSha256 = "0".repeat(64);
  assert.throws(() => validatePartnerRuntimeEvidence(releaseDrift), /closure hash mismatch/);
});

test("runtime evidence rejects a false audit PASS or incomplete npm ls", () => {
  const falsePass = evidence();
  falsePass.auditReportBytes = mutateJson(falsePass.auditReportBytes, (value) => {
    value.decision = "PASS";
  });
  assert.throws(() => validatePartnerRuntimeEvidence(falsePass), /closure hash mismatch/);

  const incomplete = evidence();
  incomplete.dependencyTreeBytes = mutateJson(incomplete.dependencyTreeBytes, (value) => {
    value.invalidPackageCount = 1;
  });
  assert.throws(() => validatePartnerRuntimeEvidence(incomplete), /closure hash mismatch/);
});
