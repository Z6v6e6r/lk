#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  validateDevBinding,
  validateDevInstallManifest,
} from "./prepare_lk1_subscription_dev_candidate.mjs";
import {
  checkedProvisioningContract,
  validateDevProvisioningContract,
} from "./validate_lk1_subscription_dev_provisioning_contract.mjs";

const checkedBinding = JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_candidate_binding.json", import.meta.url),
  "utf8",
));

export function verifyDevInstallManifest(
  manifest,
  candidateBytes,
  binding = checkedBinding,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  provisioningContract = checkedProvisioningContract,
) {
  validateDevProvisioningContract(provisioningContract);
  if (provisioningContract.installAllowed !== true) {
    throw new Error("Provisioning contract blocks DEV install");
  }
  validateDevBinding(binding, trustedBindings, provisioningContract);
  const candidateSha256 = crypto.createHash("sha256").update(candidateBytes).digest("hex");
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  const candidateNodes = new Map(candidate.map((node) => [node.id, node]));
  const targetPairs = [
    [binding.target.routerNodeId, binding.target.routerPreimageSha256],
    [binding.target.prepareNodeId, binding.target.preparePreimageSha256],
    [binding.target.splitRouterNodeId, binding.target.splitRouterPreimageSha256],
    [binding.target.splitCreatePrepareNodeId, binding.target.splitCreatePreparePreimageSha256],
    [binding.target.splitJoinPrepareNodeId, binding.target.splitJoinPreparePreimageSha256],
    [binding.target.finalizeNodeId, binding.target.finalizePreimageSha256],
  ];
  const expectedChangedNodeIds = targetPairs.filter(([id, preimage]) => {
    const node = candidateNodes.get(id);
    return node && crypto.createHash("sha256").update(String(node.func || "")).digest("hex") !== preimage;
  }).map(([id]) => id).sort();
  const candidateNodeInventorySha256 = crypto.createHash("sha256").update(JSON.stringify(candidate
    .map((node) => ({ id: node.id, sha256: crypto.createHash("sha256").update(JSON.stringify(node)).digest("hex") }))
    .sort((left, right) => left.id.localeCompare(right.id)))).digest("hex");
  const changedNodesVerified = manifest?.changedNodes?.every((entry) => {
    const node = candidateNodes.get(entry.id);
    return node && entry.candidateNodeSha256
      === crypto.createHash("sha256").update(JSON.stringify(node)).digest("hex");
  });
  if (manifest?.sourceSha256 !== binding.source.sourceSha256
    || manifest?.rollbackSourceSha256 !== binding.source.sourceSha256
    || manifest?.candidateSha256 !== binding.candidateSha256
    || candidateSha256 !== binding.candidateSha256
    || candidateNodeInventorySha256 !== manifest?.candidateNodeInventorySha256
    || JSON.stringify(manifest?.changedNodeIds) !== JSON.stringify(expectedChangedNodeIds)
    || changedNodesVerified !== true) {
    throw new Error("DEV install manifest does not match the frozen candidate binding");
  }
  return validateDevInstallManifest(manifest, {
    environment: binding.environment,
    sourceHost: binding.installTarget.sourceHost,
    sourceHostname: binding.installTarget.sourceHostname,
    serviceName: binding.installTarget.serviceName,
    unixUser: binding.installTarget.unixUser,
    userDir: binding.installTarget.userDir,
    remoteFlowPath: binding.installTarget.remoteFlowPath,
  }, trustedBindings);
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
