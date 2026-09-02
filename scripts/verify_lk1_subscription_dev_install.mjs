#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  validateDevBinding,
  validateDevInstallManifest,
} from "./prepare_lk1_subscription_dev_candidate.mjs";

const checkedBinding = JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_candidate_binding.json", import.meta.url),
  "utf8",
));

export function verifyDevInstallManifest(
  manifest,
  candidateBytes,
  binding = checkedBinding,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
) {
  validateDevBinding(binding, trustedBindings);
  const candidateSha256 = crypto.createHash("sha256").update(candidateBytes).digest("hex");
  if (manifest?.sourceSha256 !== binding.source.sourceSha256
    || manifest?.candidateSha256 !== binding.candidateSha256
    || candidateSha256 !== binding.candidateSha256) {
    throw new Error("DEV install manifest does not match the frozen candidate binding");
  }
  return validateDevInstallManifest(manifest, {
    environment: binding.environment,
    sourceHost: binding.installTarget.sourceHost,
    sourceHostname: binding.installTarget.sourceHostname,
    remoteFlowPath: binding.installTarget.remoteFlowPath,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--manifest" || process.argv[4] !== "--candidate") {
    throw new Error("Usage: node scripts/verify_lk1_subscription_dev_install.mjs --manifest <manifest.json> --candidate <candidate.json>");
  }
  const manifest = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const candidateBytes = fs.readFileSync(process.argv[5]);
  verifyDevInstallManifest(manifest, candidateBytes);
  process.stdout.write("DEV_INSTALL_MANIFEST=VERIFIED_NO_IMPORT_PERFORMED\n");
}
