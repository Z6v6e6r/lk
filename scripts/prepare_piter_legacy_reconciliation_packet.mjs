#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPiterLegacyReconciliationPacket,
  redactPiterLegacyReconciliationPacket,
} from "./lib/piterLegacySalesReconciliation.mjs";

const usage = `
prepare_piter_legacy_reconciliation_packet

Builds a private, short-lived Piter legacy-sales reconciliation packet from
complete read-only snapshots. It never connects to Viva or MongoDB and never
mutates live state.

Usage:
  node scripts/prepare_piter_legacy_reconciliation_packet.mjs \\
    --ledger-file /absolute/private/ledger-evidence.json \\
    --provider-file /absolute/private/provider-evidence.json \\
    --subscription-file /absolute/private/subscription-evidence.json \\
    --candidate-report /absolute/fresh-live-workspace/build-piter-atomic/report.json \\
    --product-id <exact-viva-product-id> \\
    --output-dir /absolute/new/private/output-directory
`;

const valueFlags = new Map([
  ["--ledger-file", "ledgerFile"],
  ["--provider-file", "providerFile"],
  ["--subscription-file", "subscriptionFile"],
  ["--candidate-report", "candidateReport"],
  ["--product-id", "productId"],
  ["--output-dir", "outputDir"],
]);

const toStr = (value) => value == null ? null : (String(value).trim() || null);

export function parseArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--apply") throw new Error("--apply is unsupported: packet preparation is permanently offline");
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`Unsupported option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (options[key]) throw new Error(`${arg} may be provided only once`);
    options[key] = value;
    index += 1;
  }
  if (options.help) return options;
  for (const [flag, key] of valueFlags) {
    options[key] = toStr(options[key]);
    if (!options[key]) throw new Error(`${flag} is required`);
  }
  for (const key of ["ledgerFile", "providerFile", "subscriptionFile", "candidateReport", "outputDir"]) {
    if (!path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  return options;
}

const readProtectedJson = (filePath, label, fsImpl = fs) => {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
};

const createPrivateOutput = (outputDir, packet, report, fsImpl = fs) => {
  if (fsImpl.existsSync(outputDir)) throw new Error("--output-dir must not already exist");
  const parentStat = fsImpl.lstatSync(path.dirname(outputDir));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("--output-dir parent must be a regular directory");
  }
  fsImpl.mkdirSync(outputDir, { mode: 0o700 });
  fsImpl.writeFileSync(
    path.join(outputDir, "reconciliation.packet.json"),
    `${JSON.stringify(packet, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  fsImpl.writeFileSync(
    path.join(outputDir, "reconciliation.report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
};

export function prepareReconciliationPacket(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const now = dependencies.now || (() => new Date());
  const packet = buildPiterLegacyReconciliationPacket({
    ledgerEvidence: readProtectedJson(options.ledgerFile, "ledger evidence", fsImpl),
    providerEvidence: readProtectedJson(options.providerFile, "provider evidence", fsImpl),
    subscriptionEvidence: readProtectedJson(options.subscriptionFile, "subscription evidence", fsImpl),
    candidateReport: readProtectedJson(options.candidateReport, "candidate report", fsImpl),
    productId: options.productId,
    createdAt: now().toISOString(),
  });
  const report = redactPiterLegacyReconciliationPacket(packet);
  createPrivateOutput(options.outputDir, packet, report, fsImpl);
  return report;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage); return; }
    process.stdout.write(`${JSON.stringify(prepareReconciliationPacket(options), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
