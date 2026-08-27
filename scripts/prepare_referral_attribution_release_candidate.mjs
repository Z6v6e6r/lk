#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import {
  REFERRAL_ATTRIBUTION_APPROVAL_GATE,
  REFERRAL_ATTRIBUTION_AUDIT_SCHEMA,
  REFERRAL_ATTRIBUTION_TARGETS,
  inspectReferralAttributionSource,
  sha256
} from './lib/referralAttributionReleaseContract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTION_DIRECTORY = path.join(ROOT, 'scripts/nodered_games_nodes');

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const workspace = value('--workspace');
  const contract = value('--contract');
  const expectedContractSha256 = value('--expected-contract-sha256');
  const outputDirectory = value('--output-dir');
  if (argv.length !== 8 || !workspace || !contract || !expectedContractSha256 || !outputDirectory) {
    fail('Usage: node scripts/prepare_referral_attribution_release_candidate.mjs --workspace <absolute-workspace> --contract <private-approved-contract> --expected-contract-sha256 <sha256> --output-dir <absolute-new-directory>');
  }
  return { workspace, contract, expectedContractSha256, outputDirectory };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readPrivateContract(contractArg, workspace, expectedSha256) {
  if (!path.isAbsolute(contractArg)) fail('Referral attribution approval contract must be absolute');
  const stat = fs.lstatSync(contractArg);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail('Referral attribution approval contract must be a private regular file');
  }
  const canonical = fs.realpathSync(contractArg);
  if (canonical !== path.resolve(contractArg) || !isWithin(workspace, canonical)) {
    fail('Referral attribution approval contract must resolve inside the external workspace');
  }
  const body = fs.readFileSync(canonical);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(body) !== expectedSha256) {
    fail('Referral attribution approval contract SHA-256 mismatch');
  }
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    fail('Referral attribution approval contract must contain valid JSON');
  }
  return { path: canonical, sha256: expectedSha256, value };
}

function safeTargetRecord(target) {
  return {
    id: target.id,
    tabId: target.tabId,
    tabLabel: target.tabLabel,
    name: target.name,
    sourceFile: target.sourceFile,
    purposes: target.purposes,
    preimageSha256: target.preimageSha256,
    candidateSha256: target.candidateSha256,
    preimageObservations: target.preimageObservations,
    candidateObservations: target.candidateObservations
  };
}

const args = parseArguments(process.argv.slice(2));
const verified = verifyWorkspace(args.workspace, { quiet: true });
const inspected = inspectReferralAttributionSource(verified.source, FUNCTION_DIRECTORY);
const contract = readPrivateContract(args.contract, verified.workspace, args.expectedContractSha256);
const approval = contract.value;

if (approval.schema !== REFERRAL_ATTRIBUTION_AUDIT_SCHEMA
  || approval.formatVersion !== 1
  || approval.approvalState !== 'APPROVED'
  || approval.approvalGate !== REFERRAL_ATTRIBUTION_APPROVAL_GATE
  || approval.sourceKind !== 'live-147'
  || approval.sourceSha256 !== verified.sourceSha256
  || approval.sourceNodeCount !== verified.nodeCount) {
  fail('Referral attribution approval contract identity mismatch');
}
if (!Array.isArray(approval.targets) || approval.targets.length !== REFERRAL_ATTRIBUTION_TARGETS.length) {
  fail('Referral attribution approval contract target set mismatch');
}
for (let index = 0; index < inspected.targets.length; index += 1) {
  const actual = safeTargetRecord(inspected.targets[index]);
  const approved = approval.targets[index];
  if (approved?.reviewDecision !== 'APPROVED'
    || JSON.stringify({ ...approved, reviewDecision: undefined })
      !== JSON.stringify({ ...actual, reviewDecision: undefined })) {
    fail(`Referral attribution approval target mismatch: ${actual.id}`);
  }
}
if (JSON.stringify(approval.debugGuards) !== JSON.stringify(inspected.debugGuards)) {
  fail('Referral attribution debug guard approval mismatch');
}
const currentPasswordGrantInventory = inspected.activePasswordGrantConsumers;
if (JSON.stringify(approval.activePasswordGrantConsumers) !== JSON.stringify(currentPasswordGrantInventory)
  || approval.unmanagedActivePasswordGrantConsumerCount !== inspected.unmanagedActivePasswordGrantConsumers.length
  || approval.providerRotationBlocked !== (inspected.unmanagedActivePasswordGrantConsumers.length > 0)) {
  fail('Referral attribution provider credential inventory mismatch');
}
const requiredRotationDecision = inspected.unmanagedActivePasswordGrantConsumers.length > 0
  ? 'ROTATION_REMAINS_BLOCKED'
  : 'ROTATION_REQUIRES_SEPARATE_APPROVAL';
if (approval.providerRotationDecision !== requiredRotationDecision) {
  fail('Referral attribution provider rotation decision mismatch');
}

if (!path.isAbsolute(args.outputDirectory)) fail('Referral attribution candidate output must be absolute');
const parent = fs.realpathSync(path.dirname(args.outputDirectory));
const outputDirectory = path.join(parent, path.basename(args.outputDirectory));
if (!isWithin(verified.workspace, outputDirectory)) {
  fail('Referral attribution candidate output must stay inside the external workspace');
}
if (fs.existsSync(outputDirectory)) fail('Referral attribution candidate output already exists');

const candidate = structuredClone(verified.source);
const candidateById = new Map(candidate.map((node) => [node.id, node]));
const changedNodes = [];
for (const target of inspected.targets) {
  const node = candidateById.get(target.id);
  const previousSource = String(node.func ?? '');
  if (previousSource === target.candidateSource) continue;
  node.func = target.candidateSource;
  changedNodes.push({
    id: target.id,
    tabId: target.tabId,
    name: target.name,
    purposes: target.purposes,
    previousSha256: target.preimageSha256,
    candidateSha256: target.candidateSha256
  });
}
if (changedNodes.length === 0) fail('All referral attribution targets already match the reviewed candidate');

const sourceById = new Map(verified.source.map((node) => [node.id, node]));
const actualChanged = candidate.filter((node) => JSON.stringify(node) !== JSON.stringify(sourceById.get(node.id)));
if (actualChanged.length !== changedNodes.length
  || !actualChanged.every((node) => changedNodes.some((entry) => entry.id === node.id))) {
  fail(`Unexpected referral attribution changed node count: ${actualChanged.length}`);
}

fs.mkdirSync(outputDirectory, { mode: 0o700 });
fs.chmodSync(outputDirectory, 0o700);
const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
const candidatePath = path.join(outputDirectory, 'referral-attribution.candidate.json');
const reportPath = path.join(outputDirectory, 'referral-attribution.report.json');
fs.writeFileSync(candidatePath, candidateText, { mode: 0o600, flag: 'wx' });
fs.chmodSync(candidatePath, 0o600);
const report = {
  schema: 'lk-referral-attribution-candidate-report-v1',
  formatVersion: 1,
  ok: true,
  sourceKind: 'live-147',
  sourceSha256: verified.sourceSha256,
  candidateSha256: sha256(candidateText),
  sourceNodeCount: verified.nodeCount,
  candidateNodeCount: candidate.length,
  approvalContractSha256: contract.sha256,
  approvedTargetNodeCount: inspected.targets.length,
  changedNodeCount: changedNodes.length,
  changedNodes,
  debugGuards: inspected.debugGuards,
  activePasswordGrantConsumerCount: inspected.activePasswordGrantConsumers.length,
  unmanagedActivePasswordGrantConsumerCount: inspected.unmanagedActivePasswordGrantConsumers.length,
  providerRotationBlocked: inspected.unmanagedActivePasswordGrantConsumers.length > 0,
  providerRotationDecision: requiredRotationDecision,
  deployAuthorized: false
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
fs.chmodSync(reportPath, 0o600);

console.log(`sourceSha256=${report.sourceSha256}`);
console.log(`candidateSha256=${report.candidateSha256}`);
console.log(`changedNodeCount=${report.changedNodeCount}`);
console.log(`unmanagedActivePasswordGrantConsumerCount=${report.unmanagedActivePasswordGrantConsumerCount}`);
console.log(`providerRotationBlocked=${report.providerRotationBlocked}`);
console.log(`deployAuthorized=${report.deployAuthorized}`);
console.log(`candidatePath=${candidatePath}`);
console.log(`reportPath=${reportPath}`);
