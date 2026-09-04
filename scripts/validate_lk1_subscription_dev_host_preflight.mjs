#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_MACHINE_ID_SHA256 = "9f29889b29a55b2c7e1eeb65616d2049b16972589de1bc623a61d38d92dd7ad8";
const EXPECTED_UNITS = Object.freeze([
  "lk1-subscription-dev-mongo.service",
  "lk1-subscription-dev-cup.service",
  "lk1-subscription-dev-provider-fixture.service",
  "lk1-subscription-dev-identity-fixture.service",
  "lk1-subscription-dev-nodered.service",
]);
const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateHostPreflightEvidence(evidence, now = new Date()) {
  exactKeys(evidence, [
    "schemaVersion", "environment", "state", "capturedAt", "maximumAgeSeconds", "target",
    "hostCapabilities", "dedicatedUnits", "listeners", "inputs", "sharedResources", "authority",
  ], "host preflight evidence");
  const capturedAt = Date.parse(evidence.capturedAt);
  const nowMs = now.getTime();
  if (evidence.schemaVersion !== 1 || evidence.environment !== "DEV"
    || evidence.state !== "PASS_AT_CAPTURE" || !Number.isFinite(capturedAt)
    || !Number.isFinite(nowMs) || evidence.maximumAgeSeconds !== 3600
    || capturedAt > nowMs || nowMs - capturedAt > evidence.maximumAgeSeconds * 1000) {
    fail("host preflight evidence is stale or has invalid identity");
  }
  exactKeys(evidence.target, ["hostAlias", "hostname", "machineIdSha256"], "host target");
  if (evidence.target.hostAlias !== "lk-reserve-89"
    || evidence.target.hostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || !SHA256.test(evidence.target.machineIdSha256)
    || evidence.target.machineIdSha256 !== EXPECTED_MACHINE_ID_SHA256) {
    fail("host target identity mismatch");
  }
  exactKeys(evidence.hostCapabilities, [
    "systemdVersion", "minimumRequiredSystemdVersion", "authorizationTransport", "compatible",
  ], "host capabilities");
  if (evidence.hostCapabilities.systemdVersion !== 245
    || evidence.hostCapabilities.minimumRequiredSystemdVersion !== 245
    || evidence.hostCapabilities.authorizationTransport !== "ROOT_OWNED_GROUP_READ_ONLY_FILE"
    || evidence.hostCapabilities.compatible !== true) {
    fail("host capabilities do not support the candidate authorization transport");
  }
  if (JSON.stringify(Object.keys(evidence.dedicatedUnits)) !== JSON.stringify(EXPECTED_UNITS)) {
    fail("dedicated unit inventory mismatch");
  }
  for (const [name, state] of Object.entries(evidence.dedicatedUnits)) {
    exactKeys(state, ["loadState", "activeState", "unitFileState"], `unit ${name}`);
    if (state.loadState !== "loaded" || state.activeState !== "inactive"
      || state.unitFileState !== "disabled") fail(`unit ${name} is not stopped and disabled`);
  }
  exactKeys(evidence.listeners, [
    "sharedNodeRed1880Present", "forbiddenSharedCup3036Present", "reserved1882Absent",
    "reserved27030Absent", "reserved3037Absent", "reserved3038Absent", "reserved3039Absent",
  ], "listener evidence");
  if (Object.entries(evidence.listeners).some(([key, value]) => (
    key.endsWith("Absent") ? value !== true : value !== true
  ))) fail("listener isolation evidence mismatch");
  exactKeys(evidence.inputs, [
    "targetFlowAbsent", "fixtureConfigAbsent", "releaseReceiptAbsent",
    "serviceStartAuthorizationAbsent", "installIdentityEnvironmentAbsent", "productionMarkersAbsent",
  ], "authorization inputs");
  if (Object.values(evidence.inputs).some((value) => value !== true)) {
    fail("host authorization inputs are not absent");
  }
  exactKeys(evidence.sharedResources, ["flowSha256", "expectedFlowSha256", "unchanged"], "shared resources");
  if (!SHA256.test(evidence.sharedResources.flowSha256)
    || evidence.sharedResources.flowSha256 !== evidence.sharedResources.expectedFlowSha256
    || evidence.sharedResources.unchanged !== true) fail("shared resources drifted");
  exactKeys(evidence.authority, [
    "hostRead", "hostInstall", "daemonReload", "serviceStart", "externalWrites",
  ], "preflight authority");
  if (evidence.authority.hostRead !== true
    || Object.entries(evidence.authority).some(([key, value]) => key !== "hostRead" && value !== false)) {
    fail("preflight exceeded read-only authority");
  }
  return true;
}

export const checkedHostPreflightEvidence = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_host_preflight_evidence.json", import.meta.url),
  "utf8",
)));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("Usage: validate_lk1_subscription_dev_host_preflight.mjs");
  validateHostPreflightEvidence(checkedHostPreflightEvidence);
  process.stdout.write("LK1_DEV_HOST_PREFLIGHT=PASS_AT_CAPTURE\n");
}
