import assert from "node:assert/strict";
import test from "node:test";
import {
  checkedHostPreflightEvidence,
  validateHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const NOW = new Date("2026-09-04T09:30:00Z");
const clone = (value) => structuredClone(value);

test("fresh host preflight proves stopped isolated resources without write authority", () => {
  assert.equal(validateHostPreflightEvidence(checkedHostPreflightEvidence, NOW), true);
  assert.equal(checkedHostPreflightEvidence.hostCapabilities.systemdVersion, 245);
  assert.equal(checkedHostPreflightEvidence.listeners.reserved3037Absent, true);
  assert.equal(checkedHostPreflightEvidence.sharedResources.unchanged, true);
  assert.equal(checkedHostPreflightEvidence.authority.externalWrites, false);
});

test("host preflight rejects stale, wrong-host, active, listening, mutated, or authorized evidence", () => {
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.target.hostAlias = "lk-primary-147"; },
    (value) => { value.hostCapabilities.compatible = false; },
    (value) => { value.dedicatedUnits["lk1-subscription-dev-cup.service"].activeState = "active"; },
    (value) => { value.listeners.reserved3037Absent = false; },
    (value) => { value.inputs.serviceStartAuthorizationAbsent = false; },
    (value) => { value.sharedResources.flowSha256 = "a".repeat(64); },
    (value) => { value.authority.hostInstall = true; },
  ]) {
    const changed = clone(checkedHostPreflightEvidence);
    mutate(changed);
    assert.throws(() => validateHostPreflightEvidence(changed, NOW));
  }
  assert.throws(() => validateHostPreflightEvidence(
    checkedHostPreflightEvidence,
    new Date("2026-09-04T10:23:21Z"),
  ), /stale/);
});
