#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPiterAtomicActivationPacket,
  redactPiterAtomicActivationPacket,
} from "./lib/piterAtomicActivationContract.mjs";

const usage = `
prepare_piter_atomic_activation_packet

Builds a private, short-lived Piter atomic-ledger activation packet from four
complete read-only snapshots and the exact reviewed-flow candidate report. It
never connects to Viva or MongoDB and never mutates live state.

Usage:
  node scripts/prepare_piter_atomic_activation_packet.mjs \\
    --ledger-file /absolute/private/ledger-evidence.json \\
    --provider-file /absolute/private/provider-evidence.json \\
    --product-file /absolute/private/product-evidence.json \\
    --binding-file /absolute/private/nodered-binding-evidence.json \\
    --candidate-report /absolute/fresh-live-workspace/build-piter-atomic/report.json \\
    --product-id <exact-viva-product-id> \\
    --output-dir /absolute/new/private/output-directory

Evidence envelopes must be formatVersion=1, complete=true, have exact query
scope and capturedAt, and be no older than the contract freshness window.
`;

const valueFlags = new Map([
  ["--ledger-file", "ledgerFile"],
  ["--provider-file", "providerFile"],
  ["--product-file", "productFile"],
  ["--binding-file", "bindingFile"],
  ["--candidate-report", "candidateReport"],
  ["--product-id", "productId"],
  ["--output-dir", "outputDir"],
]);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

export function parseArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
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
  for (const key of ["ledgerFile", "providerFile", "productFile", "bindingFile", "candidateReport", "outputDir"]) {
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
  const parent = path.dirname(outputDir);
  const parentStat = fsImpl.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("--output-dir parent must be a regular directory");
  }
  fsImpl.mkdirSync(outputDir, { mode: 0o700 });
  fsImpl.writeFileSync(
    path.join(outputDir, "activation.packet.json"),
    `${JSON.stringify(packet, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  fsImpl.writeFileSync(
    path.join(outputDir, "activation.report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
};

export function preparePacket(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const now = dependencies.now || (() => new Date());
  const createdAt = now().toISOString();
  const packet = buildPiterAtomicActivationPacket({
    ledgerEvidence: readProtectedJson(options.ledgerFile, "ledger evidence", fsImpl),
    providerEvidence: readProtectedJson(options.providerFile, "provider evidence", fsImpl),
    productEvidence: readProtectedJson(options.productFile, "product evidence", fsImpl),
    bindingEvidence: readProtectedJson(options.bindingFile, "Node-RED binding evidence", fsImpl),
    candidateReport: readProtectedJson(options.candidateReport, "candidate report", fsImpl),
    productId: options.productId,
    createdAt,
  });
  const report = redactPiterAtomicActivationPacket(packet);
  createPrivateOutput(options.outputDir, packet, report, fsImpl);
  return report;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
      return;
    }
    process.stdout.write(`${JSON.stringify(preparePacket(options), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
