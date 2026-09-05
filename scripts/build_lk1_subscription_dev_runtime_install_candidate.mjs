#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_FILES,
  UNIT_SHA256,
  validateInstallCandidateUnit,
  validateNodeRedSettings,
  validateRuntimeInstallContract,
  verifyRuntimeInstallCandidateBundle,
} from "./verify_lk1_subscription_dev_runtime_install_candidate.mjs";
import {
  validateMinimalDevFlow,
  validateRuntimeSourceContract,
} from "./verify_lk1_subscription_dev_runtime_source.mjs";
import { buildOfflineDevSourceFlow } from "./generate_lk1_subscription_dev_offline_source.mjs";
import {
  buildDevCandidate,
  CHECKED_DEV_CANDIDATE_BINDING,
  LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
} from "./prepare_lk1_subscription_dev_candidate.mjs";
import { validateReleaseReceiptV2 } from "./validate_lk1_subscription_dev_release_receipt_v2.mjs";
import { currentCaptureIdentity } from "./validate_lk1_subscription_dev_host_preflight.mjs";

const PREFLIGHT_PROVISIONING_CONTRACT = JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_provisioning_contract.json", import.meta.url),
  "utf8",
));

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_LAUNCHER_SOURCE = "launch_lk1_subscription_dev_stopped_candidate.mjs";
const SOURCE_BY_DESTINATION = Object.freeze({
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs": "lk1_subscription_dev_runtime/fixture_runtime.mjs",
  "payload/lk1_subscription_dev_runtime/minimal.flow.json": "lk1_subscription_dev_runtime/minimal.flow.json",
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json": "lk1_subscription_dev_runtime/runtime_source_contract.json",
  "payload/runtime-install-contract.json": "lk1_subscription_dev_runtime_install_contract.json",
  "payload/node-red/release-receipt-v2.template.json": "lk1_subscription_dev_release_receipt_v2_contract.json",
  "payload/node-red/settings.js": "lk1_subscription_dev_bootstrap/settings.js",
  ...Object.fromEntries(Object.keys(UNIT_SHA256).map((name) => [
    `payload/units/${name}`,
    `lk1_subscription_dev_runtime_install/units/${name}`,
  ])),
  "payload/verify_lk1_subscription_dev_runtime_source.mjs": "verify_lk1_subscription_dev_runtime_source.mjs",
  "payload/verify_lk1_subscription_dev_runtime_install_candidate.mjs": "verify_lk1_subscription_dev_runtime_install_candidate.mjs",
  "payload/validate_lk1_subscription_dev_release_receipt_v2.mjs": "validate_lk1_subscription_dev_release_receipt_v2.mjs",
  "payload/install_lk1_subscription_dev_stopped_candidate.mjs": "install_lk1_subscription_dev_stopped_candidate.mjs",
  "payload/validate_lk1_subscription_dev_host_preflight.mjs": "validate_lk1_subscription_dev_host_preflight.mjs",
  "payload/lk1_subscription_dev_provisioning_contract.json": "lk1_subscription_dev_provisioning_contract.json",
  "payload/lk1_subscription_dev_release_receipt_v2_contract.json": "lk1_subscription_dev_release_receipt_v2_contract.json",
  "payload/lk1_subscription_dev_host_preflight_evidence.json": "lk1_subscription_dev_host_preflight_evidence.json",
  ...Object.fromEntries([
    "lk1-subscription-dev-mongo.service",
    "lk1-subscription-dev-cup.service",
    "lk1-subscription-dev-provider-fixture.service",
    "lk1-subscription-dev-identity-fixture.service",
    "lk1-subscription-dev-nodered.service",
  ].map((name) => [
    `payload/lk1_subscription_dev_bootstrap/units/${name}`,
    `lk1_subscription_dev_bootstrap/units/${name}`,
  ])),
  ...Object.fromEntries(Object.keys(UNIT_SHA256).map((name) => [
    `payload/lk1_subscription_dev_runtime_install/units/${name}`,
    `lk1_subscription_dev_runtime_install/units/${name}`,
  ])),
});
const MODE_BY_DESTINATION = Object.freeze({
  "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs": 0o550,
  "payload/lk1_subscription_dev_runtime/runtime_source_contract.json": 0o600,
  "payload/runtime-install-contract.json": 0o600,
  "payload/node-red/flows.json": 0o600,
  "payload/node-red/source-candidate.manifest.json": 0o600,
  "payload/node-red/release-receipt-v2.template.json": 0o600,
  "payload/node-red/settings.js": 0o640,
  "payload/verify_lk1_subscription_dev_runtime_source.mjs": 0o550,
  "payload/verify_lk1_subscription_dev_runtime_install_candidate.mjs": 0o550,
  "payload/validate_lk1_subscription_dev_release_receipt_v2.mjs": 0o550,
  "payload/install_lk1_subscription_dev_stopped_candidate.mjs": 0o550,
  "payload/validate_lk1_subscription_dev_host_preflight.mjs": 0o550,
});

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const currentRepositoryIdentity = () => {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  let trackedBytesMatchHead = true;
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], {
      cwd: ROOT, stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    trackedBytesMatchHead = false;
  }
  const hiddenIndexFlagsAbsent = !git("ls-files", "-v").split("\n")
    .some((line) => /^[a-zS] /.test(line));
  return {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    originMain: git("rev-parse", "origin/main"),
    headOriginMergeBase: git("merge-base", "HEAD", "origin/main"),
    clean: git("status", "--porcelain", "--untracked-files=all") === ""
      && trackedBytesMatchHead && hiddenIndexFlagsAbsent,
  };
};

export function buildRuntimeInstallCandidateBundle({
  outputDirectory,
  sourceCommit,
  now = new Date(),
  repositoryIdentity = () => ({
    ...currentRepositoryIdentity(),
    sourceOriginMergeBase: execFileSync(
      "git", ["merge-base", sourceCommit, "origin/main"], { cwd: ROOT, encoding: "utf8" },
    ).trim(),
  }),
  commitFile = (commit, repositoryPath) => execFileSync(
    "git",
    ["show", `${commit}:${repositoryPath}`],
    { cwd: ROOT, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
  ),
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) fail("sourceCommit must be an exact 40-hex commit");
  const identity = repositoryIdentity();
  if (!/^[a-f0-9]{40}$/.test(identity.head || "") || !/^[a-f0-9]{40}$/.test(identity.tree || "")
    || identity.clean !== true
    || !/^[a-f0-9]{40}$/.test(identity.originMain || "")
    || identity.headOriginMergeBase !== identity.originMain
    || identity.sourceOriginMergeBase !== sourceCommit) {
    fail("runtime install candidate builder requires clean tooling HEAD containing current origin/main and its frozen source base");
  }
  const root = path.resolve(outputDirectory);
  if ((!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) || fs.existsSync(root)) {
    fail("runtime install candidate output must be a new temporary directory");
  }

  const sourceBytes = new Map();
  for (const destination of EXPECTED_FILES) {
    if (["payload/node-red/flows.json", "payload/node-red/source-candidate.manifest.json"].includes(destination)) {
      continue;
    }
    const source = SOURCE_BY_DESTINATION[destination];
    if (!source) fail(`runtime install candidate source mapping missing (${destination})`);
    const bytes = fs.readFileSync(path.join(ROOT, source));
    const committedBytes = commitFile(identity.head, `scripts/${source}`);
    if (!Buffer.isBuffer(committedBytes) || !bytes.equals(committedBytes)) {
      fail(`runtime install candidate tooling bytes do not belong to tooling HEAD (${source})`);
    }
    sourceBytes.set(destination, bytes);
  }

  const sourceReader = (commit, repositoryPath) => {
    const bytes = commitFile(commit, repositoryPath);
    if (!Buffer.isBuffer(bytes)) fail(`exact-main source blob is unavailable (${repositoryPath})`);
    return bytes.toString("utf8");
  };
  const trustedLauncherBytes = fs.readFileSync(path.join(ROOT, TRUSTED_LAUNCHER_SOURCE));
  const committedTrustedLauncherBytes = commitFile(
    identity.head, `scripts/${TRUSTED_LAUNCHER_SOURCE}`,
  );
  if (!Buffer.isBuffer(committedTrustedLauncherBytes)
    || !trustedLauncherBytes.equals(committedTrustedLauncherBytes)) {
    fail("trusted stopped-install launcher does not belong to tooling HEAD");
  }
  const sourceFlow = buildOfflineDevSourceFlow(sourceCommit, sourceReader);
  const sourceText = `${JSON.stringify(sourceFlow, null, 2)}\n`;
  const candidate = buildDevCandidate(
    sourceText,
    CHECKED_DEV_CANDIDATE_BINDING,
    (repositoryPath) => sourceReader(sourceCommit, repositoryPath),
    LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  );
  const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`);
  sourceBytes.set("payload/node-red/flows.json", Buffer.from(candidate.candidateText));
  sourceBytes.set("payload/node-red/source-candidate.manifest.json", candidateManifestBytes);
  const receiptTemplate = JSON.parse(sourceBytes.get(
    "payload/node-red/release-receipt-v2.template.json",
  ).toString("utf8"));
  validateReleaseReceiptV2(receiptTemplate);
  if (receiptTemplate.sourceCommit !== sourceCommit
    || receiptTemplate.sourceFlowSha256 !== sha256(Buffer.from(sourceText))
    || receiptTemplate.candidateSha256 !== candidate.manifest.candidateSha256
    || receiptTemplate.manifestSha256 !== sha256(candidateManifestBytes)) {
    fail("runtime install candidate receipt does not bind the exact source candidate");
  }

  validateRuntimeInstallContract(JSON.parse(sourceBytes.get("payload/runtime-install-contract.json")));
  validateRuntimeSourceContract(JSON.parse(
    sourceBytes.get("payload/lk1_subscription_dev_runtime/runtime_source_contract.json"),
  ));
  validateMinimalDevFlow(JSON.parse(sourceBytes.get("payload/lk1_subscription_dev_runtime/minimal.flow.json")));
  validateNodeRedSettings(sourceBytes.get("payload/node-red/settings.js").toString("utf8"));
  for (const name of Object.keys(UNIT_SHA256)) {
    validateInstallCandidateUnit(name, sourceBytes.get(`payload/units/${name}`).toString("utf8"));
  }

  fs.mkdirSync(root, { mode: 0o700 });
  const files = EXPECTED_FILES.map((destination) => {
    const bytes = sourceBytes.get(destination);
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
    stage: "STOPPED_INSTALL_CANDIDATE",
    environment: "DEV",
    sourceCommit,
    toolingCommit: identity.head,
    toolingTreeSha: identity.tree,
    sourceCandidateSha256: candidate.manifest.candidateSha256,
    sourceCandidateManifestSha256: sha256(candidateManifestBytes),
    createdAt: now.toISOString(),
    files,
    trustedLauncher: {
      path: "scripts/launch_lk1_subscription_dev_stopped_candidate.mjs",
      sha256: sha256(trustedLauncherBytes),
    },
    preflightBinding: {
      ...currentCaptureIdentity(),
      expectedSharedFlowSha256: PREFLIGHT_PROVISIONING_CONTRACT.evidence.sharedFlowSha256,
    },
    authority: {
      hostRead: true,
      hostInstall: true,
      daemonReload: false,
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
  verifyRuntimeInstallCandidateBundle(root, manifestSha256);
  return { outputDirectory: root, manifest, manifestSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--output" || process.argv[4] !== "--source-commit") {
    fail("Usage: build_lk1_subscription_dev_runtime_install_candidate.mjs --output <new-temp-directory> --source-commit <sha>");
  }
  const result = buildRuntimeInstallCandidateBundle({
    outputDirectory: process.argv[3],
    sourceCommit: process.argv[5],
  });
  process.stdout.write(`LK1_DEV_RUNTIME_INSTALL_CANDIDATE=BUILT\nmanifestSha256=${result.manifestSha256}\noutput=${result.outputDirectory}\n`);
}
