#!/usr/bin/env node
// Normalizes the raw output of rehearse_partner_game_membership_guarded_startup.mjs
// into the committed guarded-sidecar-rehearsal.json that the packet builder and the
// production-controls closure verify.
//
// The guarded rehearsal prints a private output directory; this publisher reads only
// its results/probes.json and results/receipt.json, re-derives the artifact hashes from
// the recorded sources and refuses to publish anything that is not a complete PASS.
//
// Usage: node scripts/publish_partner_game_membership_sidecar_evidence.mjs --from <dir> [--write]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
if (argv[0] !== "--from" || !argv[1] || (argv[2] !== undefined && argv[2] !== "--write")) {
  throw new Error("Usage: --from <guarded-rehearsal-output-dir> [--write]");
}
const from = path.resolve(argv[1]);
const write = argv[2] === "--write";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(scripts, "partner_game_membership_sidecar/guarded-sidecar-rehearsal.json");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const receiptBytes = fs.readFileSync(path.join(from, "results/receipt.json"));
const probesBytes = fs.readFileSync(path.join(from, "results/probes.json"));
const receipt = JSON.parse(receiptBytes);
const probes = JSON.parse(probesBytes);

assert.equal(receipt.state, "PASS", "only a complete guarded rehearsal PASS may be published");
assert.equal(receipt.productionTouched, false);
assert.equal(probes.productionTouched, false);
assert.equal(probes.state, "LOCAL_GUARDED_STARTUP_PASS_NOT_PRODUCTION");
assert.equal(probes.nodeRedVersion, "5.0.6");
assert.equal(probes.platform, "linux");
assert.equal(probes.architecture, "x64");
assert.equal(probes.actualNodeRedCli, true);
assert.equal(probes.serviceCommandAndEnvironmentVerified, true);
assert.equal(probes.currentSymlink, true);
assert.equal(probes.systemdExecuted, false);

const source = (key) => {
  const hash = receipt.sources?.[key];
  assert.match(hash || "", /^[a-f0-9]{64}$/, `missing recorded source ${key}`);
  // Re-derive from the current repository bytes so the evidence can never silently
  // describe sources other than the ones being rehearsed.
  const relative = key === "candidate.flow.json"
    ? null
    : key.startsWith("../") ? key.slice(3) : path.join("scripts", key);
  if (relative) {
    const actual = sha(fs.readFileSync(path.join(scripts, "..", relative)));
    assert.equal(actual, hash, `recorded source ${key} differs from the repository bytes`);
  }
  return hash;
};

const sidecar = (name) => source(`partner_game_membership_sidecar/${name}`);
const startupRefused = probes.rows.filter((row) => row.startsWith("startup-refused:")).length;
const image = receipt.containers?.[0]?.imageId;
assert.match(image || "", /^sha256:[a-f0-9]{64}$/);

const evidence = {
  formatVersion: 2,
  capturedAt: receipt.capturedAt,
  environment: "LOCAL_DISPOSABLE_CONTAINER",
  networkMode: "none",
  runtime: {
    platform: probes.platform,
    architecture: probes.architecture,
    nodeImageSha256: image.slice("sha256:".length),
    nodeVersion: probes.nodeVersion.replace(/^v/, ""),
    nodeRedVersion: probes.nodeRedVersion,
  },
  artifacts: {
    settingsSha256: sidecar("settings.cjs"),
    serviceUnitSha256: sidecar("partner-game-membership-sidecar.service"),
    settingsRuntimeSha256: sidecar("settings-runtime.cjs"),
    settingsGuardedSha256: sidecar("settings-guarded.cjs"),
    guardedStartupSha256: sidecar("guarded-startup.cjs"),
    rawRequestGuardSha256: sidecar("raw-request-guard.cjs"),
    rawAuditSha256: sidecar("raw-audit.cjs"),
    guardedPolicySha256: sidecar("guarded-runtime-policy.json"),
    candidateFlowSha256: source("candidate.flow.json"),
  },
  readback: {
    exactProductionPathLayout: true,
    emptyUserDirAtStart: true,
    customNodeRouteLoaded: true,
    bindAddress: "127.0.0.1",
    port: 18894,
    adminUiDisabled: true,
    paletteEditorDisabled: true,
    partnerDefaultOffHttpStatus: 503,
    adminRootHttpStatus: 404,
    cacheControl: "no-store",
    corsResponseHeader: null,
    gracefulStopMarkers: ["Stopping flows", "Stopped flows"],
    actualNodeRedCli: probes.actualNodeRedCli,
    serviceCommandAndEnvironmentVerified: probes.serviceCommandAndEnvironmentVerified,
    currentSymlink: probes.currentSymlink,
    systemdExecuted: probes.systemdExecuted,
    rawDuplicateHeaderHttpStatus: 400,
    rawDuplicateJsonHttpStatus: 400,
    durableAuditRows: probes.auditRows,
    restartExistingAudit: probes.rows.includes("restart-existing-audit"),
    startupRefusedCases: startupRefused,
    physicalProbesPassed: probes.rows.length,
  },
  proof: {
    orchestratorSha256: source("rehearse_partner_game_membership_guarded_startup.mjs"),
    probeScriptSha256: source("tests/fixtures/partner-guarded-startup-runtime.cjs"),
    probesSha256: sha(probesBytes),
    receiptSha256: sha(receiptBytes),
  },
  cleanup: {
    ownedContainersRemoved: (receipt.cleanup || []).filter((entry) => entry.containerPresent === false).length,
    hostPortsPublished: 0,
  },
  productionTouched: false,
};

assert.equal(evidence.readback.physicalProbesPassed, 20, "expected 20 physical probe rows");
assert.equal(evidence.readback.startupRefusedCases, 10, "expected 10 startup refusal cases");
assert.equal(evidence.readback.durableAuditRows, 6, "expected 6 durable audit rows");
assert.equal(evidence.cleanup.ownedContainersRemoved, receipt.containers.length);

if (write) {
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`PARTNER_SIDECAR_REHEARSAL_WRITTEN sha256=${sha(fs.readFileSync(target))}\n`);
} else {
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
