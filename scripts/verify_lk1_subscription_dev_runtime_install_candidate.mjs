#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateMinimalDevFlow,
  validateRuntimeSourceContract,
} from "./verify_lk1_subscription_dev_runtime_source.mjs";
import { validateReleaseReceiptV2 } from "./validate_lk1_subscription_dev_release_receipt_v2.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const CONTRACT_CANONICAL_SHA256 = "dd5475a7e412a465015d8e38c4909b25de8d4f4126bbcbead1c930abe7446dea";
const NODE_RED_SETTINGS_SHA256 = "6b6cc7253b120f2a8b2397c0d3a5f82db9a72fb6d62948bd9f6e6bdb5ab3deb6";
const UNIT_SHA256 = Object.freeze({
  "lk1-subscription-dev-cup.service": "21423847b61c56bb7c8d2561e4a740d2e21aad399abbb1b2725a2936d3631ba5",
  "lk1-subscription-dev-identity-fixture.service": "aa3b2b3da47f5dd21b139f0bba98a1da9a9c9a4114ac5f357ce9970a131f1ffd",
  "lk1-subscription-dev-nodered.service": "dfb45a305fd27d32eacfbf5a3f437e257dcd05f385256289804ba496bdea6e99",
  "lk1-subscription-dev-provider-fixture.service": "29a050c070d8fd66318caff69008817a4813a606c345feeba36a0d68f2f9e27a",
});
const EXPECTED_FILES = Object.freeze([
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs",
  "payload/lk1_subscription_dev_runtime/minimal.flow.json",
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json",
  "payload/runtime-install-contract.json",
  "payload/node-red/flows.json",
  "payload/node-red/source-candidate.manifest.json",
  "payload/node-red/release-receipt-v2.template.json",
  "payload/node-red/settings.js",
  ...Object.keys(UNIT_SHA256).map((name) => `payload/units/${name}`),
  "payload/verify_lk1_subscription_dev_runtime_source.mjs",
  "payload/verify_lk1_subscription_dev_runtime_install_candidate.mjs",
  "payload/validate_lk1_subscription_dev_release_receipt_v2.mjs",
]);

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateRuntimeInstallContract(contract) {
  if (sha256(Buffer.from(JSON.stringify(contract))) !== CONTRACT_CANONICAL_SHA256) {
    fail("runtime install contract canonical digest mismatch");
  }
  exactKeys(contract, [
    "formatVersion", "stage", "environment", "sourceCommit", "target",
    "authorizationCustody", "credentialBinding", "units", "prerequisites",
    "candidateContents", "runtimeCapabilityDisclosure", "intendedStoppedPostconditions", "authority",
  ], "runtime install contract");
  if (contract.formatVersion !== 1 || contract.stage !== "LOCAL_INSTALL_CANDIDATE"
    || contract.environment !== "DEV" || contract.sourceCommit !== null) {
    fail("runtime install contract identity mismatch");
  }
  if (contract.target.unixUser !== "lk1-subscription-dev"
    || contract.target.unixGroup !== "lk1-subscription-dev"
    || contract.target.rootPath !== "/srv/lk1-subscription-dev"
    || contract.target.tlsKeyPath !== "/srv/lk1-subscription-dev/tls/server.key"
    || contract.target.tlsCertificatePath !== "/srv/lk1-subscription-dev/tls/server.crt"
    || contract.authorizationCustody.sourceMarker
      !== "/srv/lk1-subscription-dev/authorization/service-start.approved"
    || contract.authorizationCustody.sourceDirectoryOwner !== "root:lk1-subscription-dev"
    || contract.authorizationCustody.sourceDirectoryMode !== "0750"
    || contract.authorizationCustody.sourceFileOwner !== "root:lk1-subscription-dev"
    || contract.authorizationCustody.sourceFileMode !== "0440"
    || contract.authorizationCustody.transport !== "ROOT_OWNED_GROUP_READ_ONLY_FILE"
    || contract.authorizationCustody.credentialName !== "service-start.approved"
    || contract.authorizationCustody.runtimePath
      !== "/srv/lk1-subscription-dev/authorization/service-start.approved"
    || contract.authorizationCustody.runtimePathEnvironmentVariable
      !== "LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE"
    || contract.authorizationCustody.maximumLifetimeSeconds !== 3600
    || contract.authorizationCustody.systemdMinimumVersion !== 245
    || contract.authorizationCustody.authorizationTransportHostSupportVerified !== true) {
    fail("runtime install marker custody is not exact or host-compatible");
  }
  if (contract.credentialBinding.installedSourceEnvironmentVariable
      !== "LK1_SUBSCRIPTION_DEV_INSTALLED_SOURCE_COMMIT"
    || contract.credentialBinding.installedManifestEnvironmentVariable
      !== "LK1_SUBSCRIPTION_DEV_RUNTIME_MANIFEST_SHA256"
    || JSON.stringify(contract.credentialBinding.roles)
      !== JSON.stringify(["cup", "provider", "identity", "nodered"])
    || Object.entries(contract.credentialBinding).some(([key, value]) => (
      !["environment", "roles", "installedSourceEnvironmentVariable",
        "installedManifestEnvironmentVariable"].includes(key) && value !== true
    ))) {
    fail("runtime install credential binding is incomplete");
  }
  const expectedUnits = [
    "lk1-subscription-dev-cup.service",
    "lk1-subscription-dev-provider-fixture.service",
    "lk1-subscription-dev-identity-fixture.service",
    "lk1-subscription-dev-nodered.service",
  ];
  if (JSON.stringify(contract.units) !== JSON.stringify(expectedUnits)
    || Object.values(contract.prerequisites).some((value) => value !== true)
    || contract.candidateContents.nodeRedFlow !== "GENERATED_EXACT_SOURCE_CANDIDATE"
    || contract.candidateContents.sourceCandidateManifest !== "INCLUDED_SOURCE_ONLY"
    || contract.candidateContents.releaseReceiptV2Template !== "INCLUDED_SOURCE_ONLY"
    || Object.entries(contract.candidateContents).some(([key, value]) => (
      !["nodeRedFlow", "sourceCandidateManifest", "releaseReceiptV2Template"].includes(key)
      && value !== "NOT_INCLUDED"
    ))
    || JSON.stringify(contract.runtimeCapabilityDisclosure) !== JSON.stringify({
      nodeRedExposure: "DORMANT_WRITE_CAPABLE_SOURCE_GRAPH",
      httpRoutes: ["POST /lk/subscription-bookings", "OPTIONS /lk/subscription-bookings"],
      outboundHttpNodes: 2,
      mongoOperations: ["find", "insertOne", "updateOne"],
      providerFixture: "HEALTH_ONLY_FAIL_CLOSED",
      cupManagedContract: "SYNTHETIC_IN_MEMORY_SOURCE_IMPLEMENTED_LOCAL_PHYSICAL_VERIFIED",
      networkIsolationRuntimeVerified: false,
      serviceStartBlocked: true,
      serviceStartBlocker: "NON_LOOPBACK_EGRESS_ENFORCEMENT_NOT_VERIFIED",
      positiveUat: "NOT_AUTHORIZED",
      requiresSeparateStartReview: true,
      requiresSeparateMutationReview: true,
    })
    || Object.values(contract.intendedStoppedPostconditions).some((value) => value !== false)
    || contract.authority.bundleBuildAllowed !== true
    || Object.entries(contract.authority).some(([key, value]) => (
      key !== "bundleBuildAllowed" && value !== false
    ))) {
    fail("runtime install candidate exceeds local stopped-only authority");
  }
  return true;
}

export function validateInstallCandidateUnit(name, source) {
  if (UNIT_SHA256[name] === undefined || sha256(Buffer.from(source)) !== UNIT_SHA256[name]) {
    fail(`runtime install unit canonical digest mismatch (${name})`);
  }
  for (const required of [
    "User=lk1-subscription-dev",
    "Group=lk1-subscription-dev",
    "ConditionPathExists=/srv/lk1-subscription-dev/authorization/service-start.approved",
    "RefuseManualStart=yes",
    "Environment=LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE=/srv/lk1-subscription-dev/authorization/service-start.approved",
    "EnvironmentFile=/srv/lk1-subscription-dev/runtime/install-identity.env",
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
    "[Install]", "WantedBy=", "ExecStartPre=", "ExecStartPost=", "ExecReload=",
    "systemctl", "LoadCredential=", "https://", "padlhub", "vivacrm", "/root/.node-red",
    "0.0.0.0", "Environment=NODE_ENV=production",
  ]) {
    if (source.includes(forbidden)) fail(`${name} contains forbidden content (${forbidden})`);
  }
  const fixtureRoles = {
    "lk1-subscription-dev-cup.service": "cup",
    "lk1-subscription-dev-provider-fixture.service": "provider",
    "lk1-subscription-dev-identity-fixture.service": "identity",
  };
  if (fixtureRoles[name]) {
    if (!source.includes("ConditionPathExists=/srv/lk1-subscription-dev/private/fixture.json")
      || !source.includes("ConditionPathExists=/srv/lk1-subscription-dev/tls/server.key")
      || !source.includes("ConditionPathExists=/srv/lk1-subscription-dev/tls/server.crt")
      || !source.includes("Environment=LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE=/srv/lk1-subscription-dev/private/fixture.json")
      || !source.includes("Environment=LK1_SUBSCRIPTION_DEV_TLS_KEY_FILE=/srv/lk1-subscription-dev/tls/server.key")
      || !source.includes("Environment=LK1_SUBSCRIPTION_DEV_TLS_CERT_FILE=/srv/lk1-subscription-dev/tls/server.crt")
      || !source.includes(`ExecStart=/srv/lk1-subscription-dev/runtime/node/bin/node /srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs --role ${fixtureRoles[name]}`)) {
      fail(`${name} fixture execution identity mismatch`);
    }
  } else if (name === "lk1-subscription-dev-nodered.service") {
    for (const required of [
      "ConditionPathExists=/srv/lk1-subscription-dev/node-red/flows.json",
      "ConditionPathExists=/srv/lk1-subscription-dev/node-red/release-identity.json",
      "ConditionPathExists=/srv/lk1-subscription-dev/tls/server.crt",
      "Environment=NODE_EXTRA_CA_CERTS=/srv/lk1-subscription-dev/tls/server.crt",
      "ExecCondition=/srv/lk1-subscription-dev/runtime/node/bin/node /srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs --validate-start-authorization --role nodered",
      "ReadOnlyPaths=/srv/lk1-subscription-dev/node-red/flows.json /srv/lk1-subscription-dev/node-red/release-identity.json /srv/lk1-subscription-dev/node-red/settings.js",
      "--settings /srv/lk1-subscription-dev/node-red/settings.js --port 1882",
    ]) {
      if (!source.includes(required)) fail(`${name} lacks ${required}`);
    }
  }
  return true;
}

export function validateNodeRedSettings(source) {
  if (sha256(Buffer.from(source)) !== NODE_RED_SETTINGS_SHA256
    || !source.includes('uiHost: "127.0.0.1"')
    || !source.includes("uiPort: 1882")
    || !source.includes("disableEditor: true")
    || !source.includes("httpAdminRoot: false")
    || !source.includes("autoInstall: false")
    || /https?:\/\/|padlhub|vivacrm|credentialSecret:\s*["']/.test(source)) {
    fail("Node-RED settings are not exact, loopback-only, and editor-locked");
  }
  return true;
}

function inspectBundleInventory(root) {
  const files = [];
  const visit = (directory) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      fail("runtime install bundle directory custody mismatch");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("runtime install bundle contains a symlink");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(path.relative(root, target));
      else fail("runtime install bundle contains a special file");
    }
  };
  visit(root);
  return files.sort();
}

export function verifyRuntimeInstallCandidateBundle(bundleDirectory, expectedManifestSha256) {
  const root = fs.realpathSync(bundleDirectory);
  if (!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) {
    fail("runtime install candidate must stay in a temporary workspace");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
    fail("runtime install candidate root custody mismatch");
  }
  const manifestPath = path.join(root, "manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || (manifestStat.mode & 0o777) !== 0o600) fail("runtime install candidate manifest custody mismatch");
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (!SHA256.test(expectedManifestSha256 || "") || manifestSha256 !== expectedManifestSha256) {
    fail("runtime install candidate manifest SHA mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  exactKeys(manifest, [
    "formatVersion", "stage", "environment", "sourceCommit", "toolingCommit",
    "sourceCandidateSha256", "sourceCandidateManifestSha256", "createdAt", "files", "authority",
  ], "runtime install candidate manifest");
  if (manifest.formatVersion !== 1 || manifest.stage !== "LOCAL_INSTALL_CANDIDATE"
    || manifest.environment !== "DEV" || !COMMIT.test(manifest.sourceCommit || "")
    || !COMMIT.test(manifest.toolingCommit || "")
    || !SHA256.test(manifest.sourceCandidateSha256 || "")
    || !SHA256.test(manifest.sourceCandidateManifestSha256 || "")
    || !Number.isFinite(Date.parse(manifest.createdAt || ""))
    || JSON.stringify(manifest.authority) !== JSON.stringify({
      hostRead: false,
      hostInstall: false,
      daemonReload: false,
      serviceStart: false,
      enableUnits: false,
      ingress: false,
      activation: false,
      canaryIds: false,
      secrets: false,
      externalWrites: false,
    })) {
    fail("runtime install candidate manifest identity or authority mismatch");
  }
  if (!Array.isArray(manifest.files)
    || JSON.stringify(manifest.files.map((row) => row.path).sort())
      !== JSON.stringify([...EXPECTED_FILES].sort())
    || JSON.stringify(inspectBundleInventory(root))
      !== JSON.stringify(["manifest.json", ...EXPECTED_FILES].sort())) {
    fail("runtime install candidate inventory mismatch");
  }
  for (const row of manifest.files) {
    exactKeys(row, ["path", "mode", "sha256", "size"], `runtime install candidate file ${row.path}`);
    if (!EXPECTED_FILES.includes(row.path) || !["0550", "0600", "0640", "0644"].includes(row.mode)
      || !SHA256.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 1) {
      fail("runtime install candidate file metadata invalid");
    }
    const target = path.resolve(root, row.path);
    if (!target.startsWith(`${root}${path.sep}`)) fail("runtime install candidate path escaped");
    const stat = fs.lstatSync(target);
    const bytes = fs.readFileSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== Number.parseInt(row.mode, 8)
      || bytes.length !== row.size || sha256(bytes) !== row.sha256) {
      fail(`runtime install candidate file drift (${row.path})`);
    }
  }
  const contract = JSON.parse(fs.readFileSync(path.join(root, "payload/runtime-install-contract.json")));
  const runtimeContract = JSON.parse(fs.readFileSync(
    path.join(root, "payload/lk1_subscription_dev_runtime/runtime_source_contract.json"),
  ));
  const flow = JSON.parse(fs.readFileSync(
    path.join(root, "payload/lk1_subscription_dev_runtime/minimal.flow.json"),
  ));
  const sourceCandidateBytes = fs.readFileSync(path.join(root, "payload/node-red/flows.json"));
  const sourceCandidateManifestBytes = fs.readFileSync(
    path.join(root, "payload/node-red/source-candidate.manifest.json"),
  );
  const sourceCandidateManifest = JSON.parse(sourceCandidateManifestBytes);
  const receiptTemplate = JSON.parse(fs.readFileSync(
    path.join(root, "payload/node-red/release-receipt-v2.template.json"),
  ));
  validateRuntimeInstallContract(contract);
  validateRuntimeSourceContract(runtimeContract);
  validateMinimalDevFlow(flow);
  validateReleaseReceiptV2(receiptTemplate);
  if (sourceCandidateManifest.sourceCommit !== manifest.sourceCommit
    || sourceCandidateManifest.candidateSha256 !== manifest.sourceCandidateSha256
    || sha256(sourceCandidateBytes) !== manifest.sourceCandidateSha256
    || sha256(sourceCandidateManifestBytes) !== manifest.sourceCandidateManifestSha256
    || receiptTemplate.sourceCommit !== manifest.sourceCommit
    || receiptTemplate.candidateSha256 !== manifest.sourceCandidateSha256
    || receiptTemplate.manifestSha256 !== manifest.sourceCandidateManifestSha256
    || !Array.isArray(JSON.parse(sourceCandidateBytes))) {
    fail("runtime install candidate source flow or receipt binding mismatch");
  }
  validateNodeRedSettings(fs.readFileSync(path.join(root, "payload/node-red/settings.js"), "utf8"));
  for (const name of Object.keys(UNIT_SHA256)) {
    validateInstallCandidateUnit(name, fs.readFileSync(path.join(root, "payload/units", name), "utf8"));
  }
  return {
    manifest, contract, runtimeContract, flow, sourceCandidateManifest, receiptTemplate, manifestSha256,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--bundle") {
    fail("Usage: LK1_RUNTIME_INSTALL_CANDIDATE_MANIFEST_SHA256=<sha> verify_lk1_subscription_dev_runtime_install_candidate.mjs --bundle <directory>");
  }
  const result = verifyRuntimeInstallCandidateBundle(
    process.argv[3],
    process.env.LK1_RUNTIME_INSTALL_CANDIDATE_MANIFEST_SHA256,
  );
  process.stdout.write(`LK1_DEV_RUNTIME_INSTALL_CANDIDATE=VERIFIED\nmanifestSha256=${result.manifestSha256}\n`);
}

export { EXPECTED_FILES, UNIT_SHA256 };
