#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_FILES = Object.freeze([
  "payload/contract.json",
  "payload/provisioning-contract.json",
  "payload/fixtures/locked_fixture_runtime.mjs",
  "payload/install_lk1_subscription_dev_bootstrap.sh",
  "payload/node-red/settings.js",
  "payload/units/lk1-subscription-dev-cup.service",
  "payload/units/lk1-subscription-dev-identity-fixture.service",
  "payload/units/lk1-subscription-dev-mongo.service",
  "payload/units/lk1-subscription-dev-nodered.service",
  "payload/units/lk1-subscription-dev-provider-fixture.service",
  "payload/verify_lk1_subscription_dev_bootstrap.mjs",
]);
const EXPECTED_UNITS = Object.freeze([
  "lk1-subscription-dev-mongo.service",
  "lk1-subscription-dev-cup.service",
  "lk1-subscription-dev-provider-fixture.service",
  "lk1-subscription-dev-identity-fixture.service",
  "lk1-subscription-dev-nodered.service",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, expected, label) => {
  if (JSON.stringify(Object.keys(value || {}).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateBootstrapContract(contract) {
  exactKeys(contract, [
    "formatVersion", "stage", "environment", "authoritativeProvisioning", "target", "dependencies", "listeners",
    "units", "prohibitedPaths", "postconditions",
  ], "bootstrap contract");
  if (contract.formatVersion !== 1 || contract.stage !== "STOPPED_BOOTSTRAP" || contract.environment !== "DEV") {
    fail("bootstrap environment or stage mismatch");
  }
  const authoritative = contract.authoritativeProvisioning;
  exactKeys(authoritative, ["sourcePath", "sha256", "contractState", "authorizationId"],
    "authoritative provisioning binding");
  if (authoritative.sourcePath !== "scripts/lk1_subscription_dev_provisioning_contract.json"
    || authoritative.sha256 !== "223f3756056d153684cebd3bd0f69392ec947eacf45f69c2d107f9a8ee0231ff"
    || authoritative.contractState !== "STOPPED_BOOTSTRAP_AUTHORIZED"
    || authoritative.authorizationId !== "codex-thread-01a06288-94a5-7242-b899-c99031e82816-stopped-bootstrap-20260902") {
    fail("authoritative provisioning binding mismatch");
  }
  const target = contract.target;
  exactKeys(target, [
    "sourceHost", "sourceHostname", "unixUser", "unixGroup", "rootPath",
    "serviceStartAuthorizationMarker",
  ], "bootstrap target");
  if (target.sourceHost !== "lk-reserve-89"
    || target.sourceHostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || target.unixUser !== "lk1-subscription-dev"
    || target.unixGroup !== "lk1-subscription-dev"
    || target.rootPath !== "/srv/lk1-subscription-dev"
    || target.serviceStartAuthorizationMarker !== `${target.rootPath}/authorization/service-start.approved`) {
    fail("bootstrap target is not the exact dedicated identity");
  }
  exactKeys(contract.dependencies, ["node", "nodeRed", "mongo"], "bootstrap dependencies");
  const { node, nodeRed, mongo } = contract.dependencies;
  exactKeys(node, ["sourcePath", "destinationPath", "version", "sha256"], "Node dependency");
  exactKeys(nodeRed, [
    "sourcePath", "destinationPath", "version", "archiveSize", "archiveSha256", "packageJsonSha256",
  ], "Node-RED dependency");
  exactKeys(mongo, ["sourcePath", "destinationPath", "version", "size", "sha256"], "Mongo dependency");
  if (node.sourcePath !== "/usr/bin/node"
    || node.destinationPath !== `${target.rootPath}/runtime/node/bin/node`
    || node.version !== "v18.20.8"
    || node.sha256 !== "8f4e416b508c3c149ad62d13c37b83a61f24c40058ed3bb07fe298d9d228cd3a"
    || nodeRed.sourcePath !== "/tmp/lk1-node-red-4.0.9-bootstrap.tgz"
    || nodeRed.destinationPath !== `${target.rootPath}/runtime/node-red`
    || nodeRed.version !== "4.0.9"
    || nodeRed.archiveSize !== 19532194
    || nodeRed.archiveSha256 !== "3e36bf948f2e97b4988bdb55566957bce8992439759f4cd9785ed4523142490c"
    || nodeRed.packageJsonSha256 !== "d425a214f90741d4e9ef4b5dab3854d00d653520f6f9f32591ef39573546c302"
    || mongo.sourcePath !== "/opt/phab-subscriptions-dev/runtime/mongodb/bin/mongod"
    || mongo.destinationPath !== `${target.rootPath}/runtime/mongodb/bin/mongod`
    || mongo.version !== "7.0.24" || mongo.size !== 184369384
    || mongo.sha256 !== "14df921651e73e17384ec9436657a7774c6ca6ebc7a614e0536e4183ed99b825") {
    fail("bootstrap dependency pin mismatch");
  }
  const expectedListeners = [
    "127.0.0.1:1882", "127.0.0.1:27030", "127.0.0.1:3037",
    "127.0.0.1:3038", "127.0.0.1:3039",
  ];
  if (JSON.stringify(contract.listeners) !== JSON.stringify(expectedListeners)
    || JSON.stringify(contract.units) !== JSON.stringify(EXPECTED_UNITS)
    || JSON.stringify(contract.prohibitedPaths) !== JSON.stringify([
      "/root/.node-red", "/opt/phab-subscriptions-dev/mongo", "/etc/nginx",
    ])) {
    fail("bootstrap resource inventory mismatch");
  }
  exactKeys(contract.postconditions, [
    "servicesEnabled", "servicesActive", "listenersOpen", "ingressChanged",
    "activationChanged", "canaryIdsInstalled", "secretsInstalled",
  ], "bootstrap postconditions");
  if (Object.values(contract.postconditions).some((value) => value !== false)) {
    fail("bootstrap postconditions must remain fully stopped and secret-free");
  }
  return true;
}

function validateUnit(name, source, marker) {
  for (const required of [
    "User=lk1-subscription-dev",
    "Group=lk1-subscription-dev",
    `ConditionPathExists=${marker}`,
    "RefuseManualStart=yes",
    "Restart=no",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "IPAddressDeny=any",
    "IPAddressAllow=localhost",
  ]) {
    if (!source.includes(required)) fail(`${name} lacks ${required}`);
  }
  for (const forbidden of [
    "Environment=", "EnvironmentFile=", "ExecStartPre=/bin/sh", "ExecStartPost=",
    "https://", "padlhub", "/root/.node-red", "WantedBy=default.target",
  ]) {
    if (source.includes(forbidden)) fail(`${name} contains forbidden bootstrap content (${forbidden})`);
  }
  if (!/^ExecStart=\/srv\/lk1-subscription-dev\/runtime\/(?:node\/bin\/node|mongodb\/bin\/mongod) /m.test(source)) {
    fail(`${name} ExecStart is not pinned to an approved local dependency`);
  }
}

export function verifyBootstrapBundle(bundleDirectory, expectedManifestSha256) {
  const root = fs.realpathSync(bundleDirectory);
  if (!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) {
    fail("bootstrap bundle must be under /private/tmp or /tmp");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("bootstrap manifest is unsafe");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (!SHA256.test(expectedManifestSha256 || "") || manifestSha256 !== expectedManifestSha256) {
    fail("bootstrap manifest SHA mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "formatVersion", "stage", "environment", "sourceCommit", "createdAt",
    "contractSha256", "provisioningContractSha256", "files", "mutationAuthority",
  ], "bootstrap manifest");
  if (manifest.formatVersion !== 1 || manifest.stage !== "STOPPED_BOOTSTRAP"
    || manifest.environment !== "DEV" || !COMMIT.test(manifest.sourceCommit || "")
    || !SHA256.test(manifest.contractSha256 || "")
    || !SHA256.test(manifest.provisioningContractSha256 || "")
    || !Number.isFinite(Date.parse(manifest.createdAt || ""))) {
    fail("bootstrap manifest identity mismatch");
  }
  exactKeys(manifest.mutationAuthority, [
    "createIdentity", "installStoppedDependencies", "serviceStart", "enableUnits",
    "ingress", "activation", "canaryIds", "secrets",
  ], "bootstrap mutation authority");
  if (manifest.mutationAuthority.createIdentity !== true
    || manifest.mutationAuthority.installStoppedDependencies !== true
    || Object.entries(manifest.mutationAuthority)
      .some(([key, value]) => !["createIdentity", "installStoppedDependencies"].includes(key) && value !== false)) {
    fail("bootstrap manifest exceeds the approved stopped-install authority");
  }
  if (!Array.isArray(manifest.files)
    || JSON.stringify(manifest.files.map((item) => item.path).sort()) !== JSON.stringify([...EXPECTED_FILES].sort())) {
    fail("bootstrap manifest file inventory mismatch");
  }
  for (const item of manifest.files) {
    exactKeys(item, ["path", "mode", "sha256", "size"], `bootstrap file ${item.path}`);
    if (!/^payload\/[A-Za-z0-9._/-]+$/.test(item.path)
      || !["0550", "0600", "0640", "0644"].includes(item.mode)
      || !SHA256.test(item.sha256 || "") || !Number.isSafeInteger(item.size) || item.size < 1) {
      fail(`bootstrap file metadata invalid (${item.path})`);
    }
    const candidate = path.resolve(root, item.path);
    if (!candidate.startsWith(`${root}${path.sep}`)) fail("bootstrap file escaped bundle root");
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`bootstrap file is unsafe (${item.path})`);
    if ((stat.mode & 0o777) !== Number.parseInt(item.mode, 8)) {
      fail(`bootstrap file mode mismatch (${item.path})`);
    }
    const bytes = fs.readFileSync(candidate);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) {
      fail(`bootstrap file digest mismatch (${item.path})`);
    }
  }
  const contractBytes = fs.readFileSync(path.join(root, "payload/contract.json"));
  if (sha256(contractBytes) !== manifest.contractSha256) fail("bootstrap contract digest mismatch");
  const contract = JSON.parse(contractBytes);
  validateBootstrapContract(contract);
  const provisioningBytes = fs.readFileSync(path.join(root, "payload/provisioning-contract.json"));
  if (sha256(provisioningBytes) !== manifest.provisioningContractSha256
    || manifest.provisioningContractSha256 !== contract.authoritativeProvisioning.sha256) {
    fail("authoritative provisioning contract digest mismatch");
  }
  const provisioning = JSON.parse(provisioningBytes);
  if (provisioning.contractState !== contract.authoritativeProvisioning.contractState
    || provisioning.bootstrapInstallAllowed !== true
    || provisioning.executionAuthorized !== false
    || provisioning.candidateBuildAllowed !== false
    || provisioning.installAllowed !== false
    || provisioning.serviceStartAllowed !== false
    || provisioning.ingressAllowed !== false
    || provisioning.activationAllowed !== false
    || provisioning.bootstrapAuthorization?.authorizationId !== contract.authoritativeProvisioning.authorizationId
    || provisioning.bootstrapAuthorization?.scope !== "CREATE_IDENTITY_AND_INSTALL_STOPPED_DEPENDENCIES"
    || Object.entries(provisioning.bootstrapAuthorization || {}).some(([key, value]) => (
      !["authorizationId", "approvedAt", "scope", "targetHost"].includes(key) && value !== false
    ))) {
    fail("authoritative provisioning contract does not authorize only stopped bootstrap");
  }
  for (const unit of EXPECTED_UNITS) {
    validateUnit(unit, fs.readFileSync(path.join(root, "payload/units", unit), "utf8"),
      contract.target.serviceStartAuthorizationMarker);
  }
  return { manifest, contract, provisioning, manifestSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--bundle") {
    fail("Usage: LK1_BOOTSTRAP_MANIFEST_SHA256=<sha> verify_lk1_subscription_dev_bootstrap.mjs --bundle <directory>");
  }
  const result = verifyBootstrapBundle(process.argv[3], process.env.LK1_BOOTSTRAP_MANIFEST_SHA256);
  process.stdout.write(`LK1_DEV_BOOTSTRAP_BUNDLE=VERIFIED\nmanifestSha256=${result.manifestSha256}\n`);
}

export { EXPECTED_FILES, EXPECTED_UNITS };
