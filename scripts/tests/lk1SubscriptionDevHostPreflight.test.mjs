import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureCurrentHostPreflightEvidence,
  checkedHostPreflightEvidence,
  INGRESS_TARGET_REFERENCE_PATTERN,
  validateFreshHostPreflightEvidence,
  validateHostPreflightEvidence,
  writeFreshHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const NOW = new Date("2026-09-04T09:40:00Z");
const REPOSITORY_IDENTITY = Object.freeze({
  headSha: "1".repeat(40), treeSha: "2".repeat(40), clean: true,
});
const UNIT_FRAGMENT_SHA256 = Object.freeze({
  "lk1-subscription-dev-mongo.service": "370f07b518f14d87ba78d2cdc3e3cd15714349cf664d2bf53ac95ec2125a9980",
  "lk1-subscription-dev-cup.service": "745333370a304d2d1e70add583930d73f704002c634e9eba4343dda7dca45b90",
  "lk1-subscription-dev-provider-fixture.service": "dbf8a46a002b7f478b011b2afeb2a09837d8f44ecd5873a5225a6da6a895bca5",
  "lk1-subscription-dev-identity-fixture.service": "673fa03feb87aa886d408684ca947609263929ef178d395d93480fe096488179",
  "lk1-subscription-dev-nodered.service": "75fafcae24c5aefdca545786967bed12d509d12d2555a37d94e23571732f764a",
});
const clone = (value) => structuredClone(value);
const transcriptFrom = (evidence = checkedHostPreflightEvidence) => [
  `HOSTNAME\t${evidence.target.hostname}`,
  `MACHINE_ID_SHA256\t${evidence.target.machineIdSha256}`,
  `SYSTEMD_VERSION\t${evidence.hostCapabilities.systemdVersion}`,
  ...Object.entries(evidence.dedicatedUnits).map(([unit, state]) => (
    `UNIT\t${unit}\t${state.loadState}\t${state.activeState}\t${state.unitFileState}`
  )),
  ...Object.keys(evidence.dedicatedUnits).map((unit) => (
    `UNIT_ISOLATION\t${unit}\t${UNIT_FRAGMENT_SHA256[unit]}\ttrue\ttrue\ttrue`
  )),
  `LISTENER\t1880\t${evidence.listeners.sharedNodeRed1880Present ? "PRESENT" : "ABSENT"}`,
  `LISTENER\t3036\t${evidence.listeners.forbiddenSharedCup3036Present ? "PRESENT" : "ABSENT"}`,
  `LISTENER\t1882\t${evidence.listeners.reserved1882Absent ? "ABSENT" : "PRESENT"}`,
  `LISTENER\t27030\t${evidence.listeners.reserved27030Absent ? "ABSENT" : "PRESENT"}`,
  `LISTENER\t3037\t${evidence.listeners.reserved3037Absent ? "ABSENT" : "PRESENT"}`,
  `LISTENER\t3038\t${evidence.listeners.reserved3038Absent ? "ABSENT" : "PRESENT"}`,
  `LISTENER\t3039\t${evidence.listeners.reserved3039Absent ? "ABSENT" : "PRESENT"}`,
  ...Object.entries(evidence.inputs)
    .filter(([key]) => key !== "productionMarkersAbsent")
    .map(([key, value]) => `INPUT\t${key}\t${value}`),
  "INGRESS_ISOLATION\ttrue\ttrue",
  `PRODUCTION_MARKERS_ABSENT\t${evidence.inputs.productionMarkersAbsent}`,
  `SHARED_FLOW_SHA256\t${evidence.sharedResources.flowSha256}`,
  "END",
].join("\n");

const capture = (overrides = {}) => captureCurrentHostPreflightEvidence({
  runSsh: (script) => {
    execFileSync("/bin/bash", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] });
    return transcriptFrom();
  },
  now: NOW,
  readRepositoryIdentity: () => REPOSITORY_IDENTITY,
  ...overrides,
});

test("ingress target scan rejects every reserved-port route representation", () => {
  const pattern = new RegExp(INGRESS_TARGET_REFERENCE_PATTERN, "i");
  for (const value of [
    "proxy_pass http://127.0.0.1:1882;",
    "proxy_pass http://localhost:1882;",
    "server [::1]:1882;",
    "upstream dev_backend { server localhost:1882; }",
    "set $dev_port 1882; proxy_pass http://dev_backend:$dev_port;",
    "lk1-subscription-dev-nodered.service",
    "/srv/lk1-subscription-dev/node-red",
  ]) assert.equal(pattern.test(value), true, value);
  assert.equal(pattern.test("proxy_pass http://127.0.0.1:1880;"), false);
  assert.equal(pattern.test("set $unrelated 11882;"), false);
});

test("historical host preflight proves its archived stopped isolated state", () => {
  assert.equal(validateHostPreflightEvidence(checkedHostPreflightEvidence), true);
  assert.equal(checkedHostPreflightEvidence.hostCapabilities.systemdVersion, 245);
  assert.equal(checkedHostPreflightEvidence.listeners.reserved3037Absent, true);
  assert.equal(checkedHostPreflightEvidence.sharedResources.unchanged, true);
  assert.equal(checkedHostPreflightEvidence.authority.externalWrites, false);
});

test("host preflight rejects wrong host, active resources, drift, or write authority", () => {
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.target.hostAlias = "lk-primary-147"; },
    (value) => { value.hostCapabilities.compatible = false; },
    (value) => { value.dedicatedUnits["lk1-subscription-dev-cup.service"].activeState = "active"; },
    (value) => { value.listeners.reserved3037Absent = false; },
    (value) => { value.inputs.serviceStartAuthorizationAbsent = false; },
    (value) => {
      value.sharedResources.flowSha256 = "a".repeat(64);
      value.sharedResources.expectedFlowSha256 = "a".repeat(64);
    },
    (value) => { value.authority.hostInstall = true; },
  ]) {
    const changed = clone(checkedHostPreflightEvidence);
    mutate(changed);
    assert.throws(() => validateHostPreflightEvidence(changed));
  }
});

test("direct SSH capture binds freshness, repository, release, tooling, and trusted shared flow", () => {
  const evidence = capture();
  assert.equal(validateFreshHostPreflightEvidence(evidence, NOW, {
    expectedRepositoryIdentity: REPOSITORY_IDENTITY,
  }), true);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.capture.transport, "SSH_BATCH_ROOT_READ_ONLY");
  assert.equal(evidence.runtimeIsolation.ingress.targetRouteAbsent, true);
  assert.equal(evidence.sharedResources.expectedFlowSha256, checkedHostPreflightEvidence.sharedResources.flowSha256);

  assert.equal(validateFreshHostPreflightEvidence(evidence, new Date("2026-09-04T10:40:00Z"), {
    expectedRepositoryIdentity: REPOSITORY_IDENTITY,
  }), true);
  assert.throws(() => validateFreshHostPreflightEvidence(
    evidence, new Date("2026-09-04T10:40:00.001Z"),
    { expectedRepositoryIdentity: REPOSITORY_IDENTITY },
  ), /stale/);
  assert.throws(() => validateFreshHostPreflightEvidence(
    evidence, new Date("2026-09-04T09:39:59.999Z"),
    { expectedRepositoryIdentity: REPOSITORY_IDENTITY },
  ), /stale/);

  for (const mutate of [
    (value) => { value.repositoryIdentity.headSha = "3".repeat(40); },
    (value) => { value.releaseBinding.candidateSha256 = "a".repeat(64); },
    (value) => { value.capture.validatorSha256 = "b".repeat(64); },
    (value) => { value.runtimeIsolation.systemdUnits["lk1-subscription-dev-cup.service"].dropInsAbsent = false; },
    (value) => { value.runtimeIsolation.ingress.targetRouteAbsent = false; },
    (value) => {
      value.sharedResources.flowSha256 = "c".repeat(64);
      value.sharedResources.expectedFlowSha256 = "c".repeat(64);
    },
  ]) {
    const changed = clone(evidence);
    mutate(changed);
    assert.throws(() => validateFreshHostPreflightEvidence(changed, NOW, {
      expectedRepositoryIdentity: REPOSITORY_IDENTITY,
    }));
  }
});

test("capture rejects incomplete transcripts and repository drift without a real host", () => {
  assert.throws(() => capture({ runSsh: () => "END\n" }), /incomplete/);
  assert.throws(() => capture({ runSsh: () => `${transcriptFrom()}\nEND` }), /schema mismatch/);
  let reads = 0;
  assert.throws(() => capture({
    readRepositoryIdentity: () => ({
      ...REPOSITORY_IDENTITY,
      treeSha: (++reads === 1 ? "2" : "3").repeat(40),
    }),
  }), /during capture/);
});

test("fresh evidence writer creates a private single-link artifact", () => {
  const evidence = capture();
  const outputPath = writeFreshHostPreflightEvidence(evidence);
  const directory = path.dirname(outputPath);
  try {
    const directoryStat = fs.statSync(directory);
    const fileStat = fs.statSync(outputPath);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(fileStat.nlink, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), evidence);
    assert.throws(() => writeFreshHostPreflightEvidence(evidence, { temporaryRoot: directory }), /approved/);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("host preflight CLI requires direct authenticated capture mode", () => {
  const script = fileURLToPath(new URL(
    "../validate_lk1_subscription_dev_host_preflight.mjs", import.meta.url,
  ));
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: "pipe" }), /Usage/);
  assert.throws(() => execFileSync(process.execPath, [script, "--evidence", "/tmp/fake.json"], {
    stdio: "pipe",
  }), /Usage/);
});
