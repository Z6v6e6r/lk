#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXPECTED_FILES, validateBootstrapContract } from "./verify_lk1_subscription_dev_bootstrap.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_BY_DESTINATION = Object.freeze({
  "payload/contract.json": "lk1_subscription_dev_bootstrap_contract.json",
  "payload/provisioning-contract.json": "lk1_subscription_dev_provisioning_contract.json",
  "payload/fixtures/locked_fixture_runtime.mjs": "lk1_subscription_dev_bootstrap/locked_fixture_runtime.mjs",
  "payload/install_lk1_subscription_dev_bootstrap.sh": "install_lk1_subscription_dev_bootstrap.sh",
  "payload/node-red/settings.js": "lk1_subscription_dev_bootstrap/settings.js",
  "payload/units/lk1-subscription-dev-cup.service": "lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-cup.service",
  "payload/units/lk1-subscription-dev-identity-fixture.service": "lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-identity-fixture.service",
  "payload/units/lk1-subscription-dev-mongo.service": "lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-mongo.service",
  "payload/units/lk1-subscription-dev-nodered.service": "lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-nodered.service",
  "payload/units/lk1-subscription-dev-provider-fixture.service": "lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-provider-fixture.service",
  "payload/verify_lk1_subscription_dev_bootstrap.mjs": "verify_lk1_subscription_dev_bootstrap.mjs",
});
const MODE_BY_DESTINATION = Object.freeze({
  "payload/fixtures/locked_fixture_runtime.mjs": 0o550,
  "payload/install_lk1_subscription_dev_bootstrap.sh": 0o550,
  "payload/verify_lk1_subscription_dev_bootstrap.mjs": 0o550,
  "payload/contract.json": 0o600,
  "payload/node-red/settings.js": 0o640,
});

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function buildBootstrapBundle({
  outputDirectory,
  sourceCommit,
  now = new Date(),
  repositoryIdentity = () => ({
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    clean: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() === "",
  }),
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) fail("sourceCommit must be an exact 40-hex commit");
  const identity = repositoryIdentity();
  if (identity.head !== sourceCommit || identity.clean !== true) {
    fail("sourceCommit is not the exact clean builder repository HEAD");
  }
  const resolved = path.resolve(outputDirectory);
  if ((!resolved.startsWith("/private/tmp/") && !resolved.startsWith("/tmp/")) || fs.existsSync(resolved)) {
    fail("bootstrap output must be a new directory under /private/tmp or /tmp");
  }
  const contractSource = fs.readFileSync(path.join(ROOT, SOURCE_BY_DESTINATION["payload/contract.json"]));
  const contract = JSON.parse(contractSource);
  validateBootstrapContract(contract);
  const provisioningSource = fs.readFileSync(
    path.join(ROOT, SOURCE_BY_DESTINATION["payload/provisioning-contract.json"]),
  );
  if (sha256(provisioningSource) !== contract.authoritativeProvisioning.sha256) {
    fail("authoritative provisioning contract drift");
  }
  fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
  const files = [];
  for (const destination of EXPECTED_FILES) {
    const source = SOURCE_BY_DESTINATION[destination];
    if (!source) fail(`bootstrap source mapping missing (${destination})`);
    const bytes = fs.readFileSync(path.join(ROOT, source));
    const target = path.join(resolved, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = MODE_BY_DESTINATION[destination] ?? 0o644;
    fs.writeFileSync(target, bytes, { mode, flag: "wx" });
    files.push({
      path: destination,
      mode: mode.toString(8).padStart(4, "0"),
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  const manifest = {
    formatVersion: 1,
    stage: "STOPPED_BOOTSTRAP",
    environment: "DEV",
    sourceCommit,
    createdAt: now.toISOString(),
    contractSha256: sha256(contractSource),
    provisioningContractSha256: sha256(provisioningSource),
    files,
    mutationAuthority: {
      createIdentity: true,
      installStoppedDependencies: true,
      serviceStart: false,
      enableUnits: false,
      ingress: false,
      activation: false,
      canaryIds: false,
      secrets: false,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(resolved, "manifest.json");
  fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600, flag: "wx" });
  return { outputDirectory: resolved, manifestPath, manifest, manifestSha256: sha256(manifestBytes) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--output" || process.argv[4] !== "--source-commit") {
    fail("Usage: build_lk1_subscription_dev_bootstrap.mjs --output <new-temp-directory> --source-commit <sha>");
  }
  const result = buildBootstrapBundle({ outputDirectory: process.argv[3], sourceCommit: process.argv[5] });
  process.stdout.write(`LK1_DEV_BOOTSTRAP_BUNDLE=BUILT\nmanifestSha256=${result.manifestSha256}\noutput=${result.outputDirectory}\n`);
}
