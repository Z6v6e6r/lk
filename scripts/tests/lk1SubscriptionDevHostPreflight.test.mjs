import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedHostPreflightEvidence,
  validateHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const NOW = new Date("2026-09-04T12:20:00Z");
const clone = (value) => structuredClone(value);

test("fresh host preflight proves stopped isolated resources without write authority", () => {
  assert.equal(validateHostPreflightEvidence(checkedHostPreflightEvidence, {
    now: NOW,
    requireFresh: true,
  }), true);
  assert.equal(checkedHostPreflightEvidence.hostCapabilities.systemdVersion, 245);
  assert.equal(checkedHostPreflightEvidence.listeners.reserved3037Absent, true);
  assert.equal(checkedHostPreflightEvidence.inputs.tlsKeyAbsent, true);
  assert.equal(checkedHostPreflightEvidence.inputs.tlsCertificateAbsent, true);
  assert.equal(checkedHostPreflightEvidence.sharedResources.unchanged, true);
  assert.equal(checkedHostPreflightEvidence.authority.externalWrites, false);
});

test("host preflight rejects stale, wrong-host, active, listening, mutated, or authorized evidence", () => {
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.target.hostAlias = "lk-primary-147"; },
    (value) => { value.hostCapabilities.authorizationTransportCompatible = false; },
    (value) => { value.hostCapabilities.networkIsolationRuntimeVerified = true; },
    (value) => { value.hostCapabilities.serviceStartBlocked = false; },
    (value) => { value.dedicatedUnits["lk1-subscription-dev-cup.service"].activeState = "active"; },
    (value) => { value.listeners.reserved3037Absent = false; },
    (value) => { value.inputs.serviceStartAuthorizationAbsent = false; },
    (value) => { value.inputs.tlsKeyAbsent = false; },
    (value) => { value.inputs.tlsCertificateAbsent = false; },
    (value) => { value.sharedResources.flowSha256 = "a".repeat(64); },
    (value) => { value.authority.hostInstall = true; },
  ]) {
    const changed = clone(checkedHostPreflightEvidence);
    mutate(changed);
    assert.throws(() => validateHostPreflightEvidence(changed, {
      now: NOW,
      requireFresh: true,
    }));
  }
  assert.throws(() => validateHostPreflightEvidence(
    checkedHostPreflightEvidence,
    { now: new Date("2026-09-04T13:18:16Z"), requireFresh: true },
  ), /stale/);
  assert.equal(validateHostPreflightEvidence(checkedHostPreflightEvidence), true);
});
