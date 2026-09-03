#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_FILES,
  validateMinimalDevFlow,
  validateRuntimeSourceContract,
  verifyRuntimeSourceBundle,
} from "./verify_lk1_subscription_dev_runtime_source.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_BY_DESTINATION = Object.freeze({
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs": "lk1_subscription_dev_runtime/fixture_runtime.mjs",
  "payload/lk1_subscription_dev_runtime/minimal.flow.json": "lk1_subscription_dev_runtime/minimal.flow.json",
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json": "lk1_subscription_dev_runtime/runtime_source_contract.json",
  "payload/verify_lk1_subscription_dev_runtime_source.mjs": "verify_lk1_subscription_dev_runtime_source.mjs",
});
const MODE_BY_DESTINATION = Object.freeze({
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs": 0o550,
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json": 0o600,
  "payload/verify_lk1_subscription_dev_runtime_source.mjs": 0o550,
});
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

export function buildRuntimeSourceBundle({
  outputDirectory,
  sourceCommit,
  now = new Date(),
  repositoryIdentity = () => ({
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    clean: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() === "",
  }),
  commitFile = (commit, repositoryPath) => execFileSync(
    "git",
    ["show", `${commit}:${repositoryPath}`],
    { cwd: ROOT, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
  ),
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) fail("sourceCommit must be an exact 40-hex commit");
  const identity = repositoryIdentity();
  if (identity.head !== sourceCommit || identity.clean !== true) fail("runtime source builder requires exact clean HEAD");
  const root = path.resolve(outputDirectory);
  if ((!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) || fs.existsSync(root)) {
    fail("runtime source output must be a new temporary directory");
  }
  const contract = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    SOURCE_BY_DESTINATION["payload/lk1_subscription_dev_runtime/runtime_source_contract.json"],
  )));
  const flow = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    SOURCE_BY_DESTINATION["payload/lk1_subscription_dev_runtime/minimal.flow.json"],
  )));
  validateRuntimeSourceContract(contract);
  validateMinimalDevFlow(flow);
  fs.mkdirSync(root, { mode: 0o700 });
  const files = EXPECTED_FILES.map((destination) => {
    const source = SOURCE_BY_DESTINATION[destination];
    if (!source) fail(`runtime source mapping missing (${destination})`);
    const bytes = fs.readFileSync(path.join(ROOT, source));
    const committedBytes = commitFile(sourceCommit, `scripts/${source}`);
    if (!Buffer.isBuffer(committedBytes) || !bytes.equals(committedBytes)) {
      fail(`runtime source bytes do not belong to sourceCommit (${source})`);
    }
    const target = path.join(root, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = MODE_BY_DESTINATION[destination] ?? 0o644;
    fs.writeFileSync(target, bytes, { mode, flag: "wx" });
    return {
      path: destination,
      mode: mode.toString(8).padStart(4, "0"),
      sha256: sha256(bytes),
      size: bytes.length,
    };
  });
  const manifest = {
    formatVersion: 1,
    stage: "LOCAL_RUNTIME_SOURCE",
    environment: "DEV",
    sourceCommit,
    createdAt: now.toISOString(),
    files,
    authority: {
      hostInstall: false,
      serviceStart: false,
      enableUnits: false,
      ingress: false,
      activation: false,
      canaryIds: false,
      secrets: false,
      externalWrites: false,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
  const manifestSha256 = sha256(manifestBytes);
  verifyRuntimeSourceBundle(root, manifestSha256);
  return { outputDirectory: root, manifest, manifestSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--output" || process.argv[4] !== "--source-commit") {
    fail("Usage: build_lk1_subscription_dev_runtime_source.mjs --output <new-temp-directory> --source-commit <sha>");
  }
  const result = buildRuntimeSourceBundle({ outputDirectory: process.argv[3], sourceCommit: process.argv[5] });
  process.stdout.write(`LK1_DEV_RUNTIME_SOURCE_BUNDLE=BUILT\nmanifestSha256=${result.manifestSha256}\noutput=${result.outputDirectory}\n`);
}
