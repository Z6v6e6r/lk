import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkedHostPreflightEvidence,
  readFreshHostPreflightEvidence,
  validateFreshHostPreflightEvidence,
  validateHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const NOW = new Date("2026-09-04T09:40:00Z");
const clone = (value) => structuredClone(value);

test("fresh host preflight proves stopped isolated resources without write authority", () => {
  assert.equal(validateHostPreflightEvidence(checkedHostPreflightEvidence), true);
  assert.equal(validateFreshHostPreflightEvidence(checkedHostPreflightEvidence, NOW), true);
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
    assert.throws(() => validateHostPreflightEvidence(changed));
  }
  assert.equal(validateFreshHostPreflightEvidence(
    checkedHostPreflightEvidence,
    new Date("2026-09-04T10:35:19Z"),
  ), true);
  assert.throws(() => validateFreshHostPreflightEvidence(
    checkedHostPreflightEvidence,
    new Date("2026-09-04T10:35:19.001Z"),
  ), /stale/);
  assert.throws(() => validateFreshHostPreflightEvidence(
    checkedHostPreflightEvidence,
    new Date("2026-09-04T09:35:18.999Z"),
  ), /stale/);
  assert.throws(() => validateFreshHostPreflightEvidence(
    checkedHostPreflightEvidence,
    undefined,
  ), /freshness clock/);
});

test("host preflight CLI requires an explicit fresh temporary evidence file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-dev-host-preflight-test-"));
  try {
    const evidencePath = path.join(directory, "evidence.json");
    const evidence = clone(checkedHostPreflightEvidence);
    evidence.capturedAt = new Date().toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });

    assert.deepEqual(readFreshHostPreflightEvidence(evidencePath), evidence);
    const script = fileURLToPath(new URL(
      "../validate_lk1_subscription_dev_host_preflight.mjs",
      import.meta.url,
    ));
    assert.equal(execFileSync(process.execPath, [script, "--evidence", evidencePath], {
      encoding: "utf8",
    }), "LK1_DEV_HOST_PREFLIGHT=PASS_CURRENT\n");
    assert.throws(() => execFileSync(process.execPath, [script], { stdio: "pipe" }), /Usage/);

    const symlinkPath = path.join(directory, "evidence-link.json");
    fs.symlinkSync(evidencePath, symlinkPath);
    assert.throws(() => readFreshHostPreflightEvidence(symlinkPath), /ELOOP|non-symlink/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
