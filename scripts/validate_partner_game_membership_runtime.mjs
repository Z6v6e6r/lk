#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.join(SCRIPT_DIR, "partner_game_membership_runtime");
const CUSTOM_NODE_ROOT = path.join(SCRIPT_DIR, "../node-red/custom-nodes/partner-game-membership-api");
const CUSTOM_NODE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "partner-game-membership-core.mjs",
  "partner-game-membership-mongo.mjs",
  "partner-game-membership-viva.mjs",
  "partner-game-membership-node.cjs",
  "partner-game-membership-node.html",
]);
const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    fail(`${label} fields do not match the approved schema`);
  }
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function readEvidence(runtimeRoot = RUNTIME_ROOT) {
  const read = (name) => fs.readFileSync(path.join(runtimeRoot, name));
  return {
    manifestBytes: read("runtime-manifest.json"),
    packageJsonBytes: read("package.json"),
    packageLockBytes: read("package-lock.json"),
    dependencyTreeBytes: read("dependency-tree.json"),
    auditReportBytes: read("audit-report.json"),
    functionalRehearsalBytes: read("functional-rehearsal.json"),
  };
}

function customNodeReleaseSha256(customNodeRoot = CUSTOM_NODE_ROOT) {
  const identity = CUSTOM_NODE_FILES.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(customNodeRoot, relativePath));
    return { relativePath, sha256: sha256(bytes), size: bytes.length };
  });
  return sha256(Buffer.from(JSON.stringify(identity), "utf8"));
}

export function validatePartnerRuntimeEvidence({
  manifestBytes,
  packageJsonBytes,
  packageLockBytes,
  dependencyTreeBytes,
  auditReportBytes,
  functionalRehearsalBytes,
  customReleaseSha256,
}) {
  for (const [name, bytes] of Object.entries({
    manifestBytes, packageJsonBytes, packageLockBytes, dependencyTreeBytes, auditReportBytes, functionalRehearsalBytes,
  })) if (!Buffer.isBuffer(bytes)) fail(`Partner runtime ${name} must be exact bytes`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
  const dependencyTree = JSON.parse(dependencyTreeBytes.toString("utf8"));
  const auditReport = JSON.parse(auditReportBytes.toString("utf8"));
  const functionalRehearsal = JSON.parse(functionalRehearsalBytes.toString("utf8"));

  exactKeys(manifest, [
    "formatVersion", "deploymentId", "state", "sourceBaseCommit", "runtime", "closure",
    "installation", "dependencyTree", "audit", "productionTouched",
  ], "Partner runtime manifest");
  exactKeys(manifest.runtime, [
    "platform", "architecture", "nodeImageSha256", "nodeVersion", "npmVersion", "nodeRedVersion",
  ], "Partner runtime identity");
  exactKeys(manifest.closure, [
    "packageJsonSha256", "packageLockSha256", "dependencyTreeSha256", "auditReportSha256",
    "functionalRehearsalSha256", "customNodeReleaseSha256", "containerReceiptSha256",
  ], "Partner runtime closure");
  exactKeys(manifest.installation, ["command", "installedPackageCount", "exitCode"], "Partner runtime installation");
  exactKeys(manifest.dependencyTree, [
    "capturedAt", "command", "packageOccurrenceCount", "invalidPackageCount", "extraneousPackageCount", "exitCode",
  ], "Partner runtime dependency tree summary");
  exactKeys(manifest.audit, ["capturedAt", "command", "affectedPackages", "decision"], "Partner runtime audit summary");
  exactKeys(manifest.audit.affectedPackages, ["critical", "high", "moderate", "low", "total"], "Partner runtime audit counts");
  if (manifest.formatVersion !== 1
    || manifest.deploymentId !== "partner-game-membership-api-v02"
    || manifest.state !== "SECURITY_AUDIT_PASS"
    || manifest.sourceBaseCommit !== "26f90b6d5f54fa3ae6f51f77e70391957b44b781"
    || manifest.runtime.platform !== "linux"
    || manifest.runtime.architecture !== "x64"
    || manifest.runtime.nodeImageSha256 !== "83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5"
    || manifest.runtime.nodeVersion !== "22.23.2"
    || manifest.runtime.npmVersion !== "10.9.8"
    || manifest.runtime.nodeRedVersion !== "5.0.6"
    || manifest.productionTouched !== false) {
    fail("Partner runtime identity or fail-closed state changed");
  }
  if (manifest.closure.packageJsonSha256 !== sha256(packageJsonBytes)
    || manifest.closure.packageLockSha256 !== sha256(packageLockBytes)
    || manifest.closure.dependencyTreeSha256 !== sha256(dependencyTreeBytes)
    || manifest.closure.auditReportSha256 !== sha256(auditReportBytes)
    || manifest.closure.functionalRehearsalSha256 !== sha256(functionalRehearsalBytes)
    || manifest.closure.customNodeReleaseSha256 !== customReleaseSha256) {
    fail("Partner runtime immutable closure hash mismatch");
  }
  const receipt = functionalRehearsal.containerReceipt;
  exactKeys(receipt, [
    "formatVersion", "evidenceScope", "containerId", "imageReference", "containerImageId",
    "platformImageId", "imageRepoDigests", "platform", "architecture", "networkMode",
    "publishedPortCount", "mounts", "orchestratorSha256", "inspectedAt", "finishedAt",
    "exitCode", "cleanupCapturedAt", "containerPresentAfterCleanup", "hostListenerPresentAfterCleanup",
  ], "Partner container receipt");
  if (manifest.closure.containerReceiptSha256 !== sha256(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`))) {
    fail("Partner container receipt hash mismatch");
  }
  const imageReference = `node@sha256:${manifest.runtime.nodeImageSha256}`;
  const receiptTimes = [receipt.inspectedAt, receipt.finishedAt, receipt.cleanupCapturedAt].map(Date.parse);
  if (receipt.formatVersion !== 1 || receipt.evidenceScope !== "LOCAL_CONTAINER_CLI_READBACK"
    || !/^[a-f0-9]{64}$/.test(receipt.containerId)
    || receipt.imageReference !== imageReference
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.containerImageId)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.platformImageId)
    || !Array.isArray(receipt.imageRepoDigests) || !receipt.imageRepoDigests.includes(imageReference)
    || receipt.platform !== "linux" || receipt.architecture !== "amd64"
    || receipt.networkMode !== "none" || receipt.publishedPortCount !== 0
    || !/^[a-f0-9]{64}$/.test(receipt.orchestratorSha256)
    || !receiptTimes.every(Number.isFinite)
    || receiptTimes[0] > receiptTimes[1] || receiptTimes[1] > receiptTimes[2]
    || receipt.exitCode !== 0 || receipt.containerPresentAfterCleanup !== false
    || receipt.hostListenerPresentAfterCleanup !== false
    || !isDeepStrictEqual(receipt.mounts, [
      { sourceRelativePath: ".tmp/partner-viva-p2-sidecar", target: "/input/flows", readOnly: true },
      { sourceRelativePath: ".tmp/partner-viva-rehearse.mjs", target: "/input/rehearse.mjs", readOnly: true },
      { sourceRelativePath: ".tmp/partner-viva-p2-runtime", target: "/input/runtime", readOnly: true },
      { sourceRelativePath: "scripts/partner_game_membership_sidecar", target: "/input/sidecar", readOnly: true },
      { sourceRelativePath: ".tmp/partner-viva-p2-output", target: "/output", readOnly: false },
    ])) fail("Partner container receipt does not prove the isolated rehearsal boundary");
  if (!isDeepStrictEqual(packageJson, {
    name: "padlhub-partner-game-membership-runtime",
    version: "0.2.0",
    private: true,
    dependencies: {
      "@padlhub/node-red-partner-game-membership-api": "file:./partner-package",
      "node-red": "5.0.6",
    },
  })
    || packageLock.lockfileVersion !== 3
    || packageLock.packages?.[""]?.dependencies?.["node-red"] !== "5.0.6"
    || packageLock.packages?.[""]?.dependencies?.["@padlhub/node-red-partner-game-membership-api"] !== "file:./partner-package"
    || packageLock.packages?.["partner-package"]?.dependencies?.mongodb !== "7.2.0"
    || packageLock.packages?.["node_modules/node-red"]?.version !== "5.0.6"
    || packageLock.packages?.["node_modules/mongodb"]?.version !== "7.2.0") {
    fail("Partner runtime package-lock does not pin the exact Node-RED and custom-node closure");
  }
  exactKeys(dependencyTree, [
    "formatVersion", "capturedAt", "command", "root", "packageOccurrenceCount",
    "invalidPackageCount", "extraneousPackageCount", "packages",
  ], "Partner dependency tree evidence");
  if (dependencyTree.command !== manifest.dependencyTree.command
    || dependencyTree.capturedAt !== manifest.dependencyTree.capturedAt
    || dependencyTree.packageOccurrenceCount !== manifest.dependencyTree.packageOccurrenceCount
    || dependencyTree.packages.length !== dependencyTree.packageOccurrenceCount
    || dependencyTree.invalidPackageCount !== 0
    || dependencyTree.extraneousPackageCount !== 0
    || manifest.dependencyTree.exitCode !== 0) {
    fail("Partner npm ls evidence is incomplete or inconsistent");
  }
  exactKeys(auditReport, ["formatVersion", "capturedAt", "command", "runtime", "metadata", "vulnerabilities", "decision"], "Partner audit evidence");
  const reportedCounts = auditReport.metadata?.vulnerabilities || {};
  const counts = {
    critical: reportedCounts.critical,
    high: reportedCounts.high,
    moderate: reportedCounts.moderate,
    low: reportedCounts.low,
    total: reportedCounts.total,
  };
  if (auditReport.command !== manifest.audit.command
    || auditReport.capturedAt !== manifest.audit.capturedAt
    || auditReport.runtime?.nodeVersion !== manifest.runtime.nodeVersion
    || auditReport.runtime?.npmVersion !== manifest.runtime.npmVersion
    || auditReport.runtime?.nodeRedVersion !== manifest.runtime.nodeRedVersion
    || !isDeepStrictEqual(counts, manifest.audit.affectedPackages)
    || auditReport.vulnerabilities.length !== counts.total
    || auditReport.decision !== "PASS_NO_CRITICAL_OR_HIGH_AFFECTED_PACKAGES"
    || manifest.audit.decision !== auditReport.decision
    || counts.critical !== 0
    || counts.high !== 0
    || counts.moderate !== 7
    || counts.low !== 0
    || counts.total !== 7) {
    fail("Partner audit evidence was altered or overclaims remediation");
  }
  if (manifest.installation.command !== "npm ci --ignore-scripts --no-fund --no-audit"
    || manifest.installation.installedPackageCount !== 291
    || manifest.installation.exitCode !== 0) {
    fail("Partner runtime installation evidence changed");
  }
  exactKeys(functionalRehearsal, [
    "formatVersion", "deploymentId", "capturedAt", "clockSource", "evidenceScope", "sourceBaseCommit",
    "customNodeReleaseSha256", "runtime", "installation", "candidate", "defaultOff",
    "shutdown", "flowRollback", "packageRollback", "cleanup", "decision", "productionTouched", "containerReceipt",
  ], "Partner functional rehearsal evidence");
  exactKeys(functionalRehearsal.runtime, [
    "platform", "architecture", "nodeImageSha256", "nodeVersion", "npmVersion", "nodeRedVersion",
  ], "Partner functional rehearsal runtime");
  exactKeys(functionalRehearsal.installation, ["command", "installedPackageCount", "exitCode"], "Partner functional rehearsal installation");
  exactKeys(functionalRehearsal.candidate, [
    "sourceFlowSha256", "candidateFlowSha256", "audienceEnvironmentVariable", "signatureVersion",
  ], "Partner functional rehearsal candidate");
  exactKeys(functionalRehearsal.defaultOff, [
    "httpStatus", "cacheControl", "corsResponseHeader", "errorCode", "mongoCalls", "vivaCalls",
  ], "Partner functional rehearsal default-off result");
  exactKeys(functionalRehearsal.shutdown, ["logMarkers"], "Partner functional rehearsal shutdown");
  exactKeys(functionalRehearsal.flowRollback, ["httpStatus", "partnerFlowMatches"], "Partner functional rehearsal flow rollback");
  exactKeys(functionalRehearsal.packageRollback, [
    "httpStatus", "packageLinkPresent", "palettePartnerMatches",
  ], "Partner functional rehearsal package rollback");
  exactKeys(functionalRehearsal.cleanup, [
    "containerPresent", "listenerPort", "listenerPresent", "temporaryDirectoriesRemoved",
  ], "Partner functional rehearsal cleanup");
  if (functionalRehearsal.formatVersion !== 1
    || functionalRehearsal.deploymentId !== manifest.deploymentId
    || functionalRehearsal.capturedAt !== "2026-09-05T06:49:04.000Z"
    || functionalRehearsal.clockSource !== "node-red-container-log"
    || functionalRehearsal.evidenceScope !== "CUSTOM_NODE_LOAD_DEFAULT_OFF_AND_REMOVAL_COMPATIBILITY_ONLY"
    || functionalRehearsal.sourceBaseCommit !== manifest.sourceBaseCommit
    || functionalRehearsal.customNodeReleaseSha256 !== customReleaseSha256
    || !isDeepStrictEqual(functionalRehearsal.runtime, manifest.runtime)
    || !isDeepStrictEqual(functionalRehearsal.installation, {
      command: "npm ci --ignore-scripts --no-fund --no-audit", installedPackageCount: 291, exitCode: 0,
    })
    || !isDeepStrictEqual(functionalRehearsal.candidate, {
      sourceFlowSha256: "ea9b6a5e1b783327a5e4785e8ef6656ee2c3ea3c8523bf46c63599ae0580a2b2",
      candidateFlowSha256: "5a5aefe3dd19a8e6687222c80b229a40f924174359c181be7caaa6997134e965",
      audienceEnvironmentVariable: "LK_PARTNER_GAME_API_AUDIENCE",
      signatureVersion: "v2",
    })
    || !isDeepStrictEqual(functionalRehearsal.defaultOff, {
      httpStatus: 503, cacheControl: "no-store", corsResponseHeader: null,
      errorCode: "PARTNER_API_DISABLED", mongoCalls: 0, vivaCalls: 0,
    })
    || !isDeepStrictEqual(functionalRehearsal.shutdown.logMarkers, ["Stopping flows", "Stopped flows"])
    || !isDeepStrictEqual(functionalRehearsal.flowRollback, { httpStatus: 404, partnerFlowMatches: 0 })
    || !isDeepStrictEqual(functionalRehearsal.packageRollback, {
      httpStatus: 404, packageLinkPresent: false, palettePartnerMatches: 0,
    })
    || !isDeepStrictEqual(functionalRehearsal.cleanup, {
      containerPresent: false, listenerPort: null, listenerPresent: false, temporaryDirectoriesRemoved: true,
    })
    || functionalRehearsal.decision !== "FUNCTIONAL_COMPATIBILITY_PASS_SECURITY_AUDIT_PASS"
    || functionalRehearsal.productionTouched !== false) {
    fail("Partner functional rehearsal evidence is incomplete or overclaims production readiness");
  }
  return {
    manifest,
    functionalRehearsal,
    manifestSha256: sha256(manifestBytes),
    artifactBytes: Object.freeze({
      "runtime-manifest.json": Buffer.from(manifestBytes),
      "package.json": Buffer.from(packageJsonBytes),
      "package-lock.json": Buffer.from(packageLockBytes),
      "dependency-tree.json": Buffer.from(dependencyTreeBytes),
      "audit-report.json": Buffer.from(auditReportBytes),
      "functional-rehearsal.json": Buffer.from(functionalRehearsalBytes),
    }),
  };
}

export function validateCheckedPartnerRuntimeEvidence({ runtimeRoot = RUNTIME_ROOT, customNodeRoot = CUSTOM_NODE_ROOT } = {}) {
  return validatePartnerRuntimeEvidence({
    ...readEvidence(runtimeRoot),
    customReleaseSha256: customNodeReleaseSha256(customNodeRoot),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = validateCheckedPartnerRuntimeEvidence();
    process.stdout.write(`PARTNER_RUNTIME=SECURITY_AUDIT_PASS manifestSha256=${result.manifestSha256}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
