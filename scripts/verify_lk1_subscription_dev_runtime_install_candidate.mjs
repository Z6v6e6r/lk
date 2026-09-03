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
const CONTRACT_CANONICAL_SHA256 = "c4eccbe9bcf8d21030656a52a2a6dbcf24d4a49c4f5bd9c94f195da948375fc7";
const NODE_RED_SETTINGS_SHA256 = "6b6cc7253b120f2a8b2397c0d3a5f82db9a72fb6d62948bd9f6e6bdb5ab3deb6";
const UNIT_SHA256 = Object.freeze({
  "lk1-subscription-dev-cup.service": "754908f5c20da6213c3ea5f4a59f02bcf4f4d42ce48bf05e559ee4dd13d436f4",
  "lk1-subscription-dev-identity-fixture.service": "ef884ba523bebeae3608765183ac163b1f7424d77ad9e622801555c928f312c1",
  "lk1-subscription-dev-nodered.service": "d0ea5576c3a71fdb5343ff991c2eaf40f56cae517b75b528da8fe2b62d99a49a",
  "lk1-subscription-dev-provider-fixture.service": "c591415fb4e79677d95c9800566b69015bf2da98f8f854986b0062cd3b262218",
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
    || contract.authorizationCustody.sourceMarker
      !== "/srv/lk1-subscription-dev/authorization/service-start.approved"
    || contract.authorizationCustody.sourceDirectoryOwner !== "root:root"
    || contract.authorizationCustody.sourceDirectoryMode !== "0700"
    || contract.authorizationCustody.transport !== "SYSTEMD_LOAD_CREDENTIAL"
    || contract.authorizationCustody.credentialName !== "service-start.approved"
    || contract.authorizationCustody.runtimePath !== "$CREDENTIALS_DIRECTORY/service-start.approved"
    || JSON.stringify(contract.authorizationCustody.runtimeDirectories) !== JSON.stringify({
      cup: "/run/credentials/lk1-subscription-dev-cup.service",
      provider: "/run/credentials/lk1-subscription-dev-provider-fixture.service",
      identity: "/run/credentials/lk1-subscription-dev-identity-fixture.service",
      nodered: "/run/credentials/lk1-subscription-dev-nodered.service",
    })
    || contract.authorizationCustody.maximumLifetimeSeconds !== 3600
    || contract.authorizationCustody.systemdMinimumVersion !== 247
    || contract.authorizationCustody.hostSupportVerified !== false) {
    fail("runtime install marker custody is not exact and unverified");
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
    "LoadCredential=service-start.approved:/srv/lk1-subscription-dev/authorization/service-start.approved",
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
    "systemctl", "https://", "padlhub", "vivacrm", "/root/.node-red",
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
      || !source.includes("Environment=LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE=/srv/lk1-subscription-dev/private/fixture.json")
      || !source.includes(`ExecStart=/srv/lk1-subscription-dev/runtime/node/bin/node /srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs --role ${fixtureRoles[name]}`)) {
      fail(`${name} fixture execution identity mismatch`);
    }
  } else if (name === "lk1-subscription-dev-nodered.service") {
    for (const required of [
      "ConditionPathExists=/srv/lk1-subscription-dev/node-red/flows.json",
      "ConditionPathExists=/srv/lk1-subscription-dev/node-red/release-identity.json",
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
