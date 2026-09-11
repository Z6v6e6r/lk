#!/usr/bin/env node
// Normalizes the raw output of audit_partner_game_membership_runtime.mjs into the
// committed audit-report.json and dependency-tree.json, then reseals the runtime
// manifest closure. The audit orchestrator prints a private output directory; this
// publisher reads only its observation, receipt and captured npm output.
//
// It refuses to publish anything that is not a complete local audit PASS and
// re-derives every published hash from the bytes it is about to write.
//
// Usage: node scripts/publish_partner_game_membership_audit_evidence.mjs --from <dir> [--write]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv[0] !== "--from" || !argv[1] || (argv[2] !== undefined && argv[2] !== "--write")) {
  throw new Error("Usage: --from <audit-output-dir> [--write]");
}
const from = path.resolve(argv[1]);
const write = argv[2] === "--write";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(scripts, "partner_game_membership_runtime");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

const observationBytes = fs.readFileSync(path.join(from, "results/audit-observation.json"));
const receiptBytes = fs.readFileSync(path.join(from, "results/receipt.json"));
const treeBytes = fs.readFileSync(path.join(from, "results/tree.stdout"));
const observation = JSON.parse(observationBytes);
const receipt = JSON.parse(receiptBytes);
const tree = JSON.parse(treeBytes);

assert.equal(receipt.state, "PASS_LOCAL_AUDIT_ONLY", "only a complete audit PASS may be published");
assert.equal(receipt.productionTouched, false);
assert.equal(observation.productionTouched, false);
assert.equal(observation.platform, "linux");
assert.equal(observation.architecture, "x64");
assert.equal(observation.nodeVersion, "22.23.2");
assert.equal(observation.npmVersion, "10.9.8");
assert.equal(observation.nodeRedVersion, "5.0.6");
assert.ok(!Array.isArray(tree.problems) || tree.problems.length === 0, "npm ls reported dependency problems");
assert.equal(sha(observationBytes), receipt.observationSha256, "observation hash mismatch");

const flatten = (dependencies, prefix = "") => {
  const rows = [];
  for (const [name, node] of Object.entries(dependencies || {})) {
    const rowPath = prefix ? `${prefix}>${name}` : name;
    rows.push({
      path: rowPath,
      name,
      version: node.version ?? null,
      resolved: node.resolved ?? null,
      overridden: Boolean(node.overridden),
      invalid: Boolean(node.invalid),
      extraneous: Boolean(node.extraneous),
    });
    rows.push(...flatten(node.dependencies, rowPath));
  }
  return rows;
};
const packages = flatten(tree.dependencies);
const invalidPackageCount = packages.filter((row) => row.invalid).length;
const extraneousPackageCount = packages.filter((row) => row.extraneous).length;
assert.ok(!Array.isArray(tree.problems) || tree.problems.length === 0, "npm ls reported dependency problems");
assert.equal(invalidPackageCount, 0);
assert.equal(extraneousPackageCount, 0);

const treeCommand = observation.commands.find((command) => command.name === "tree");
const auditCommand = observation.commands.find((command) => command.name === "audit");
assert.ok(treeCommand && auditCommand, "expected tree and audit commands");
assert.equal(auditCommand.completedAt, observation.capturedAt);

const counts = {
  critical: observation.audit.metadata?.vulnerabilities?.critical,
  high: observation.audit.metadata?.vulnerabilities?.high,
  moderate: observation.audit.metadata?.vulnerabilities?.moderate,
  low: observation.audit.metadata?.vulnerabilities?.low,
  total: observation.audit.metadata?.vulnerabilities?.total,
};
assert.ok(Object.values(counts).every((value) => Number.isSafeInteger(value)), "audit metadata is missing vulnerability counts");
const decision = counts.critical === 0 && counts.high === 0
  ? "PASS_NO_CRITICAL_OR_HIGH_AFFECTED_PACKAGES"
  : "REJECT_CRITICAL_OR_HIGH_AFFECTED_PACKAGES";

const manifest = readJson(path.join(runtimeRoot, "runtime-manifest.json"));
const dependencyTree = {
  formatVersion: 1,
  capturedAt: treeCommand.completedAt,
  command: "npm ls --all --json --omit=dev",
  root: { name: tree.name, version: tree.version },
  packageOccurrenceCount: packages.length,
  invalidPackageCount,
  extraneousPackageCount,
  packages,
};
const auditReport = {
  formatVersion: 1,
  capturedAt: observation.capturedAt,
  command: "npm audit --omit=dev --json --ignore-scripts",
  runtime: manifest.runtime,
  metadata: observation.audit.metadata,
  vulnerabilities: Object.values(observation.audit.vulnerabilities || {}),
  decision,
  executionEvidence: {
    formatVersion: 1,
    scope: receipt.scope,
    state: receipt.state,
    receiptSha256: sha(receiptBytes),
    observationSha256: receipt.observationSha256,
    orchestratorSha256: receipt.orchestratorSha256,
    runnerSha256: receipt.sourceHashes["tests/fixtures/partner-runtime-audit.mjs"],
    imageReference: receipt.reference,
    platformImageId: receipt.platformImageId,
    sourceHashes: receipt.sourceHashes,
    inputHashes: observation.inputs,
    commands: observation.commands,
    containers: receipt.containers,
    egressBoundary: "REGISTRY_CONFIGURED_BRIDGE_NOT_EGRESS_ACL",
    containerPresentAfterCleanup: receipt.containerPresentAfterCleanup,
    cleanupCapturedAt: receipt.capturedAt,
    productionTouched: false,
  },
};
assert.equal(auditReport.vulnerabilities.length, counts.total);

if (write) {
  writeJson(path.join(runtimeRoot, "dependency-tree.json"), dependencyTree);
  writeJson(path.join(runtimeRoot, "audit-report.json"), auditReport);
  const dependencyBytes = fs.readFileSync(path.join(runtimeRoot, "dependency-tree.json"));
  const auditBytes = fs.readFileSync(path.join(runtimeRoot, "audit-report.json"));
  manifest.closure.dependencyTreeSha256 = sha(dependencyBytes);
  manifest.closure.auditReportSha256 = sha(auditBytes);
  manifest.dependencyTree = {
    capturedAt: dependencyTree.capturedAt,
    command: dependencyTree.command,
    packageOccurrenceCount: dependencyTree.packageOccurrenceCount,
    invalidPackageCount,
    extraneousPackageCount,
    exitCode: 0,
  };
  manifest.audit = {
    capturedAt: auditReport.capturedAt,
    command: auditReport.command,
    affectedPackages: counts,
    decision,
  };
  writeJson(path.join(runtimeRoot, "runtime-manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({
    state: "AUDIT_EVIDENCE_WRITTEN",
    capturedAt: auditReport.capturedAt,
    counts,
    packageOccurrenceCount: dependencyTree.packageOccurrenceCount,
    executionEvidenceSha256: sha(Buffer.from(`${JSON.stringify(auditReport.executionEvidence, null, 2)}\n`)),
    auditReportSha256: sha(auditBytes),
    dependencyTreeSha256: sha(dependencyBytes),
    manifestSha256: sha(fs.readFileSync(path.join(runtimeRoot, "runtime-manifest.json"))),
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ counts, decision, packageOccurrenceCount: packages.length }, null, 2)}\n`);
}
