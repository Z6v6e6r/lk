import assert from "node:assert/strict";
import test from "node:test";

import {
  checkedPartnerProductionControls,
  validatePartnerProductionControls,
} from "../validate_partner_game_membership_production_controls.mjs";

const clone = () => structuredClone(checkedPartnerProductionControls);

test("checked-in Partner production controls are fail-closed and valid", () => {
  assert.equal(validatePartnerProductionControls(clone()), true);
});

test("production controls reject schema widening", () => {
  const contract = clone();
  contract.ingress.routing.regexFallback = true;
  assert.throws(() => validatePartnerProductionControls(contract), /fields do not match/);
});

test("production controls reject route, upstream, CORS, and admin-surface widening", () => {
  for (const mutate of [
    (contract) => contract.ingress.routing.routes.push({ method: "GET", path: "/admin" }),
    (contract) => { contract.ingress.routing.upstream = "http://10.0.0.5:1880"; },
    (contract) => { contract.ingress.routing.corsAllowed = true; },
    (contract) => { contract.ingress.routing.editorAdminSurfaceAllowed = true; },
    (contract) => { contract.ingress.routing.proxyRetries = 1; },
    (contract) => { contract.ingress.routing.directNodeRedAccessAllowed = true; },
    (contract) => { contract.ingress.transport.cidrOnlyFallbackAllowed = true; },
  ]) {
    const contract = clone();
    mutate(contract);
    assert.throws(() => validatePartnerProductionControls(contract));
  }
});

test("production controls reject relaxed request limits and duplicate-header handling", () => {
  for (const [field, value] of [
    ["maxBodyBytes", 65536],
    ["maxRequestLineBytes", 8192],
    ["maxHeaderBytes", 65536],
    ["maxConcurrentPerClient", 20],
    ["maxConcurrentPerSource", 20],
    ["requestsPerSecondPerClient", 50],
    ["burstPerClient", 100],
    ["requestsPerSecondPerSource", 50],
    ["burstPerSource", 100],
    ["duplicateCriticalHeadersRejected", false],
    ["duplicateJsonKeysRejected", false],
    ["preserveRawPath", false],
    ["preserveCanonicalJsonSemantics", false],
  ]) {
    const contract = clone();
    contract.ingress.requestPolicy[field] = value;
    assert.throws(() => validatePartnerProductionControls(contract));
  }
});

test("production controls reject an unreviewed Node-RED floor or unresolved audit waiver", () => {
  const downgraded = clone();
  downgraded.runtime.minimumRehearsedNodeRedVersion = "4.0.9";
  assert.throws(() => validatePartnerProductionControls(downgraded), /rehearsed floor/);

  const waived = clone();
  waived.runtime.auditPolicy.unresolvedAuditAllowed = true;
  assert.throws(() => validatePartnerProductionControls(waived), /audit policy/);
});

test("production controls reject false remediation claims", () => {
  const contract = clone();
  contract.runtime.latestIsolatedRehearsal.auditAffectedPackages.high = 0;
  contract.runtime.latestIsolatedRehearsal.auditAffectedPackages.total = 10;
  contract.runtime.latestIsolatedRehearsal.auditDecision = "PASS";
  assert.throws(() => validatePartnerProductionControls(contract), /overclaims remediation/);
});

test("production controls pin the exact isolated evidence identities", () => {
  for (const [field, value] of [
    ["sourceCommit", "a".repeat(40)],
    ["nodeImageSha256", "b".repeat(64)],
    ["customNodeReleaseSha256", "c".repeat(64)],
  ]) {
    const contract = clone();
    contract.runtime.latestIsolatedRehearsal[field] = value;
    assert.throws(() => validatePartnerProductionControls(contract), /evidence is incomplete/);
  }
});

test("production controls reject immutable runtime closure drift", () => {
  for (const [field, value] of [
    ["runtimeManifestSha256", "a".repeat(64)],
    ["packageLockSha256", "b".repeat(64)],
    ["auditCapturedAt", "2026-09-02T00:00:00.000Z"],
    ["npmLsInvalidPackageCount", 1],
    ["productionInstallCommand", "npm install"],
  ]) {
    const contract = clone();
    contract.runtime.immutableClosure[field] = value;
    assert.throws(() => validatePartnerProductionControls(contract), /closure identity changed/);
  }
});

test("production controls reject binding ingress or custody inside the source template", () => {
  const ingress = clone();
  ingress.ingress.binding.configPath = "/etc/nginx/conf.d/partner.conf";
  assert.throws(() => validatePartnerProductionControls(ingress), /binding must remain empty/);

  const custody = clone();
  custody.custody.allowedPacketRecipients = [["root", "example.invalid"].join("@")];
  assert.throws(() => validatePartnerProductionControls(custody), /custody is bound/);
});

test("production controls reject credential handling and secret-shaped values", () => {
  const handling = clone();
  handling.custody.credentialValidationAllowed = true;
  assert.throws(() => validatePartnerProductionControls(handling), /credential handling/);

  for (const field of [
    "testProductionClientIdReuseAllowed",
    "testProductionHmacKeyReuseAllowed",
    "testProductionCertificateReuseAllowed",
    "testProductionAudienceReuseAllowed",
  ]) {
    const reused = clone();
    reused.custody[field] = true;
    assert.throws(() => validatePartnerProductionControls(reused), /credential handling/);
  }

  const secret = clone();
  secret.activation.requiredExternalEvidence[0] = "Bearer exposed-token-value";
  assert.throws(() => validatePartnerProductionControls(secret), /boundary was widened|credential-shaped/);
});

test("production controls reject deploy or activation authorization", () => {
  for (const field of [
    "deployAuthorized", "ingressMutationAuthorized", "secretProvisioningAuthorized",
    "flowImportAuthorized", "nodeRedRestartAuthorized", "globalApiEnabled", "vivaMutationsEnabled",
  ]) {
    const contract = clone();
    contract.activation[field] = true;
    assert.throws(() => validatePartnerProductionControls(contract), /boundary was widened/);
  }
});

test("production controls reject mutation of required external evidence", () => {
  const contract = clone();
  contract.activation.requiredExternalEvidence[0] = "skip provider contract";
  assert.throws(() => validatePartnerProductionControls(contract), /boundary was widened/);
});
