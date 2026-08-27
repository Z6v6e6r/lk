#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import {
  REFERRAL_ATTRIBUTION_APPROVAL_GATE,
  REFERRAL_ATTRIBUTION_AUDIT_SCHEMA,
  inspectReferralAttributionSource
} from './lib/referralAttributionReleaseContract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTION_DIRECTORY = path.join(ROOT, 'scripts/nodered_games_nodes');

function fail(message) {
  throw new Error(message);
}

function workspaceArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--workspace') {
    fail('Usage: node scripts/audit_referral_attribution_release_preimages.mjs --workspace /absolute/external/workspace');
  }
  return argv[1];
}

const verified = verifyWorkspace(workspaceArgument(process.argv.slice(2)), { quiet: true });
const inspected = inspectReferralAttributionSource(verified.source, FUNCTION_DIRECTORY);
const reviewDirectory = path.join(verified.workspace, 'referral-attribution-review');
if (fs.existsSync(reviewDirectory)) fail('Referral attribution review directory already exists');
fs.mkdirSync(reviewDirectory, { mode: 0o700 });
fs.chmodSync(reviewDirectory, 0o700);

const report = {
  schema: REFERRAL_ATTRIBUTION_AUDIT_SCHEMA,
  formatVersion: 1,
  approvalState: 'UNBOUND',
  approvalGate: REFERRAL_ATTRIBUTION_APPROVAL_GATE,
  generatedAt: new Date().toISOString(),
  sourceKind: 'live-147',
  sourceSha256: verified.sourceSha256,
  sourceNodeCount: verified.nodeCount,
  sourceFreshnessSeconds: verified.freshnessSeconds,
  targets: inspected.targets.map((target) => ({
    id: target.id,
    tabId: target.tabId,
    tabLabel: target.tabLabel,
    name: target.name,
    sourceFile: target.sourceFile,
    purposes: target.purposes,
    preimageSha256: target.preimageSha256,
    candidateSha256: target.candidateSha256,
    preimageObservations: target.preimageObservations,
    candidateObservations: target.candidateObservations,
    reviewDecision: 'UNREVIEWED'
  })),
  debugGuards: inspected.debugGuards,
  activePasswordGrantConsumers: inspected.activePasswordGrantConsumers,
  unmanagedActivePasswordGrantConsumerCount: inspected.unmanagedActivePasswordGrantConsumers.length,
  providerRotationBlocked: inspected.unmanagedActivePasswordGrantConsumers.length > 0,
  providerRotationDecision: 'UNREVIEWED'
};
const reportPath = path.join(reviewDirectory, 'referral-attribution.preimage-audit.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
fs.chmodSync(reportPath, 0o600);

console.log(`sourceSha256=${report.sourceSha256}`);
console.log(`targetNodeCount=${report.targets.length}`);
console.log(`activePasswordGrantConsumerCount=${report.activePasswordGrantConsumers.length}`);
console.log(`unmanagedActivePasswordGrantConsumerCount=${report.unmanagedActivePasswordGrantConsumerCount}`);
console.log(`providerRotationBlocked=${report.providerRotationBlocked}`);
console.log(`approvalState=${report.approvalState}`);
console.log(`reportPath=${reportPath}`);
