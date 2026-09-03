#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFixtureConfig, validateFixtureCli } from "./lk1_subscription_dev_runtime/fixture_runtime.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MINIMAL_DEV_FLOW_SHA256 = "fd9cff20a5b5adbf47fafce068e9e9cc357f676c08f2f5c41cd5420ed211ab95";
const EXPECTED_FILES = Object.freeze([
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs",
  "payload/lk1_subscription_dev_runtime/minimal.flow.json",
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json",
  "payload/verify_lk1_subscription_dev_runtime_source.mjs",
]);

const fail = (message) => { throw new Error(message); };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateRuntimeSourceContract(contract) {
  exactKeys(contract, [
    "formatVersion", "stage", "environment", "purpose", "sourceCommit", "target",
    "listeners", "implementedContract", "authority",
  ], "runtime source contract");
  if (contract.formatVersion !== 1 || contract.stage !== "LOCAL_RUNTIME_SOURCE"
    || contract.environment !== "DEV" || contract.purpose !== "READ_ONLY_UAT_EVIDENCE"
    || contract.sourceCommit !== null) fail("runtime source identity mismatch");
  exactKeys(contract.target, [
    "fixtureRuntimePath", "nodeRedFlowPath", "nodeRedReleaseReceiptPath",
    "fixtureConfigEnvironmentVariable", "serviceStartAuthorizationMarker",
    "serviceStartAuthorizationTransport", "serviceStartCredentialName",
    "serviceStartCredentialDirectories", "installedIdentityEnvironmentFile",
  ], "runtime target");
  if (contract.target.fixtureRuntimePath !== "/srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs"
    || contract.target.nodeRedFlowPath !== "/srv/lk1-subscription-dev/node-red/flows.json"
    || contract.target.nodeRedReleaseReceiptPath !== "/srv/lk1-subscription-dev/node-red/release-identity.json"
    || contract.target.fixtureConfigEnvironmentVariable !== "LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE"
    || contract.target.serviceStartAuthorizationMarker
      !== "/srv/lk1-subscription-dev/authorization/service-start.approved"
    || contract.target.serviceStartAuthorizationTransport !== "SYSTEMD_LOAD_CREDENTIAL"
    || contract.target.serviceStartCredentialName !== "service-start.approved"
    || JSON.stringify(contract.target.serviceStartCredentialDirectories) !== JSON.stringify({
      cup: "/run/credentials/lk1-subscription-dev-cup.service",
      provider: "/run/credentials/lk1-subscription-dev-provider-fixture.service",
      identity: "/run/credentials/lk1-subscription-dev-identity-fixture.service",
      nodered: "/run/credentials/lk1-subscription-dev-nodered.service",
    })
    || contract.target.installedIdentityEnvironmentFile
      !== "/srv/lk1-subscription-dev/runtime/install-identity.env") {
    fail("runtime target is not the dedicated stopped identity");
  }
  exactKeys(contract.listeners, ["nodeRed", "cup", "provider", "identity"], "runtime listeners");
  if (JSON.stringify(contract.listeners) !== JSON.stringify({
    nodeRed: "127.0.0.1:1882",
    cup: "127.0.0.1:3037",
    provider: "127.0.0.1:3038",
    identity: "127.0.0.1:3039",
  })) fail("runtime listener inventory mismatch");
  exactKeys(contract.implementedContract, [
    "lkReleaseReceipt", "cupRelease", "systemEvidence", "runtimeContext", "observability",
    "provider", "identity", "managedEntitlement", "activation", "createJoin",
  ], "implemented contract");
  if (contract.implementedContract.lkReleaseReceipt !== "FAIL_CLOSED_UNTIL_HOST_READBACK"
    || contract.implementedContract.cupRelease !== "READ_ONLY"
    || contract.implementedContract.systemEvidence !== "READ_ONLY_FIXTURE_NON_AUTHORIZING"
    || contract.implementedContract.runtimeContext !== "READ_ONLY_SYNTHETIC"
    || contract.implementedContract.observability !== "READ_ONLY_SCHEMA_FIXTURE_NON_AUTHORIZING"
    || contract.implementedContract.provider !== "HEALTH_ONLY_LOCKED"
    || contract.implementedContract.identity !== "HEALTH_ONLY_LOCKED"
    || ["managedEntitlement", "activation", "createJoin"]
      .some((key) => contract.implementedContract[key] !== "NOT_IMPLEMENTED")) {
    fail("runtime capability statement is inaccurate");
  }
  exactKeys(contract.authority, [
    "bundleBuildAllowed", "hostInstallAllowed", "serviceStartAllowed", "enableUnitsAllowed",
    "ingressAllowed", "activationAllowed", "canaryIdsAllowed", "secretsAllowed",
    "providerWritesAllowed", "paymentWritesAllowed", "entitlementMutationsAllowed",
  ], "runtime authority");
  if (contract.authority.bundleBuildAllowed !== true
    || Object.entries(contract.authority)
      .some(([key, value]) => key !== "bundleBuildAllowed" && value !== false)) {
    fail("runtime source exceeds local build authority");
  }
  return true;
}

export function validateMinimalDevFlow(flow) {
  if (!Array.isArray(flow) || flow.length !== 7) fail("minimal DEV flow node count mismatch");
  if (sha256(Buffer.from(JSON.stringify(flow))) !== MINIMAL_DEV_FLOW_SHA256) {
    fail("minimal DEV flow canonical digest mismatch");
  }
  const ids = new Set(flow.map((node) => node?.id));
  if (ids.size !== flow.length) fail("minimal DEV flow IDs are ambiguous");
  for (const node of flow) {
    if (!node || typeof node !== "object" || !node.id || !node.type) fail("minimal DEV flow node invalid");
    for (const targets of Array.isArray(node.wires) ? node.wires : []) {
      for (const target of Array.isArray(targets) ? targets : []) {
        if (!ids.has(target)) fail("minimal DEV flow contains a broken wire");
      }
    }
  }
  const routes = flow.filter((node) => node.type === "http in");
  const responses = flow.filter((node) => node.type === "http response");
  const files = flow.filter((node) => node.type === "file in");
  const networkNodes = flow.filter((node) => ["http request", "websocket-client", "tcp out", "udp out"].includes(node.type));
  const persistenceNodes = flow.filter((node) => /^(?:mongo|mongodb|mongodb4|file)$/.test(node.type));
  if (routes.length !== 1 || routes[0].method !== "get" || routes[0].url !== "/lk/release-dev.json"
    || responses.length !== 1 || files.length !== 1
    || files[0].filename !== "/srv/lk1-subscription-dev/node-red/release-identity.json"
    || networkNodes.length !== 0 || persistenceNodes.length !== 0) {
    fail("minimal DEV flow exposes more than the read-only release route");
  }
  const byId = Object.fromEntries(flow.map((node) => [node.id, node]));
  const exactWires = (id, expected) => JSON.stringify(byId[id]?.wires) === JSON.stringify(expected);
  if (JSON.stringify(flow.map((node) => node.type).sort()) !== JSON.stringify([
    "catch", "file in", "function", "function", "http in", "http response", "tab",
  ])
    || !exactWires("lk1-subscription-dev-release-in", [["lk1-subscription-dev-release-file"]])
    || !exactWires("lk1-subscription-dev-release-file", [["lk1-subscription-dev-release-validate"]])
    || !exactWires("lk1-subscription-dev-release-validate", [["lk1-subscription-dev-release-out"]])
    || !exactWires("lk1-subscription-dev-release-error", [["lk1-subscription-dev-release-error-response"]])
    || !exactWires("lk1-subscription-dev-release-error-response", [["lk1-subscription-dev-release-out"]])
    || !exactWires("lk1-subscription-dev-release-out", [])
    || JSON.stringify(byId["lk1-subscription-dev-release-error"]?.scope)
      !== JSON.stringify(["lk1-subscription-dev-release-file"])) {
    fail("minimal DEV flow graph is not the exact fail-closed release path");
  }
  const serialized = JSON.stringify(flow);
  for (const forbidden of [
    "https://", "padlhub", "vivacrm", "/root/.node-red", "clientSubscriptionId",
    "entitlement", "payment", "booking", "systemctl", "process.env", "require(",
    "global.", "flow.", "context.", "env.get", "node.send", "child_process", "fetch(",
  ]) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase())) {
      fail(`minimal DEV flow contains forbidden capability (${forbidden})`);
    }
  }
  return true;
}

export function verifyRuntimeSourceBundle(bundleDirectory, expectedManifestSha256) {
  const root = fs.realpathSync(bundleDirectory);
  if (!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) {
    fail("runtime source bundle must stay in a temporary workspace");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
    fail("runtime source bundle root custody mismatch");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || (manifestStat.mode & 0o777) !== 0o600) fail("runtime source manifest custody mismatch");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (!SHA256.test(expectedManifestSha256 || "") || manifestSha256 !== expectedManifestSha256) {
    fail("runtime source manifest SHA mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "formatVersion", "stage", "environment", "sourceCommit", "createdAt", "files", "authority",
  ], "runtime source manifest");
  if (manifest.formatVersion !== 1 || manifest.stage !== "LOCAL_RUNTIME_SOURCE"
    || manifest.environment !== "DEV" || !COMMIT.test(manifest.sourceCommit || "")
    || !Number.isFinite(Date.parse(manifest.createdAt || ""))) fail("runtime source manifest identity mismatch");
  if (JSON.stringify(manifest.authority) !== JSON.stringify({
    hostInstall: false,
    serviceStart: false,
    enableUnits: false,
    ingress: false,
    activation: false,
    canaryIds: false,
    secrets: false,
    externalWrites: false,
  })) fail("runtime source manifest authority mismatch");
  if (!Array.isArray(manifest.files)
    || JSON.stringify(manifest.files.map((row) => row.path).sort())
      !== JSON.stringify([...EXPECTED_FILES].sort())) fail("runtime source bundle inventory mismatch");
  const discoveredFiles = [];
  const inspectDirectory = (directory) => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || (directoryStat.mode & 0o077) !== 0) fail("runtime source bundle directory custody mismatch");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      if (entry.isSymbolicLink()) fail("runtime source bundle contains a symlink");
      if (entry.isDirectory()) inspectDirectory(target);
      else if (entry.isFile()) discoveredFiles.push(relative);
      else fail("runtime source bundle contains a special file");
    }
  };
  inspectDirectory(root);
  if (JSON.stringify(discoveredFiles.sort())
    !== JSON.stringify(["manifest.json", ...EXPECTED_FILES].sort())) {
    fail("runtime source bundle contains an unexpected file");
  }
  for (const row of manifest.files) {
    exactKeys(row, ["path", "mode", "sha256", "size"], `runtime source file ${row.path}`);
    if (!EXPECTED_FILES.includes(row.path) || !["0550", "0600", "0644"].includes(row.mode)
      || !SHA256.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 1) {
      fail("runtime source file metadata invalid");
    }
    const target = path.resolve(root, row.path);
    if (!target.startsWith(`${root}${path.sep}`)) fail("runtime source bundle path escaped");
    const stat = fs.lstatSync(target);
    const bytes = fs.readFileSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== Number.parseInt(row.mode, 8)
      || bytes.length !== row.size || sha256(bytes) !== row.sha256) fail(`runtime source file drift (${row.path})`);
  }
  const contract = JSON.parse(fs.readFileSync(
    path.join(root, "payload/lk1_subscription_dev_runtime/runtime_source_contract.json"),
  ));
  const flow = JSON.parse(fs.readFileSync(
    path.join(root, "payload/lk1_subscription_dev_runtime/minimal.flow.json"),
  ));
  validateRuntimeSourceContract(contract);
  validateMinimalDevFlow(flow);
  return { manifest, contract, flow, manifestSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--bundle") {
    fail("Usage: LK1_RUNTIME_SOURCE_MANIFEST_SHA256=<sha> verify_lk1_subscription_dev_runtime_source.mjs --bundle <directory>");
  }
  const result = verifyRuntimeSourceBundle(process.argv[3], process.env.LK1_RUNTIME_SOURCE_MANIFEST_SHA256);
  process.stdout.write(`LK1_DEV_RUNTIME_SOURCE_BUNDLE=VERIFIED\nmanifestSha256=${result.manifestSha256}\n`);
}

export { EXPECTED_FILES, validateFixtureConfig, validateFixtureCli };
