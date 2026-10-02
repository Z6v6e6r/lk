#!/usr/bin/env node
// Preparation only. Four preview function bodies, no booking writes or graph changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { previewSources } from './patch_nodered_subscription_price_preview.mjs';
import { patchTopokratyReclaimPreviewBody } from './patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const root = path.dirname(fileURLToPath(import.meta.url));
const prefix = 'lk_subscription_price_preview_20260908_';
export const SOURCE_SHA256 = '0dacc3d0264a1d243b163996ef13939ef523e69a44b8f2cfe60729547570e268';
const pins = Object.freeze({
  booking: 'f97b4b2ec40db022257571a0b69f82bc5236ea96013719708cb0d076d7197bb9',
  evaluator: '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
  pricing: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b',
  join: '8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074',
});
const preimages = Object.freeze({
  router: '85fce3897ca1069f17c052402a7887cb37fede88dc476b28a1e1742141a47400',
  evaluate: 'c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945',
  final: '7c822e2bb7efa35f8877b66656e367686a930867b6781d7e97ddaa29dba933b8',
  error: 'b9e9bb3845fb16f54093d8226189fcf550375f6e42cab14649efc443adc5bfd3',
});
const usageSha256 = 'a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1';

export function composeSubscriptionCalculationRepair(liveBytes) {
  if (sha(liveBytes) !== SOURCE_SHA256) throw new Error('Subscription calculation live preimage drift');
  const flow = JSON.parse(liveBytes.toString('utf8'));
  if (!Array.isArray(flow) || flow.length !== 4804 || new Set(flow.map(n => n.id)).size !== flow.length) {
    throw new Error('Subscription calculation node identity drift');
  }
  for (const [name, hash] of Object.entries(preimages)) {
    const node = flow.find(n => n.id === prefix + name);
    if (!node || node.type !== 'function' || node.d === true || node.disabled === true || sha(node.func) !== hash) {
      throw new Error(`Subscription calculation ${name} preimage drift`);
    }
  }
  const sources = previewSources(flow, { pins, installedUsageSha256: usageSha256 });
  // Preserve the already installed club-only refusal using its existing reviewed
  // generation wrapper. The shared preview composer does not own that policy.
  const bodies = { router: patchTopokratyReclaimPreviewBody(sources.router), evaluate: sources.evaluator,
    final: fs.readFileSync(path.join(root, 'nodered_subscription_price_preview_nodes/final.js'), 'utf8'),
    error: fs.readFileSync(path.join(root, 'nodered_subscription_price_preview_nodes/error.js'), 'utf8') };
  const changes = [];
  for (const [name, func] of Object.entries(bodies)) {
    new Function('msg', 'node', 'env', 'global', func);
    const node = flow.find(n => n.id === prefix + name);
    if (sha(func) === preimages[name]) throw new Error(`Expected ${name} repair is absent`);
    changes.push({ id: node.id, fields: ['func'], beforeSha256: sha(node.func), afterSha256: sha(func) });
    node.func = func;
  }
  if (flow.find(n => n.id === prefix + 'evaluate').func !== flow.find(n => n.id === 'lk_subscription_managed_policy_20260820').func) {
    throw new Error('Preview/booking evaluator mismatch');
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'subscription-calculation-repair-20261002',
    allowedChanges: changes.map(({ id, fields }) => ({ id, fields })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { sourceSha256: SOURCE_SHA256, candidateSha256: sha(candidateBytes),
    changes, changedNodeCount: 4, topologyChanged: false, bookingChanged: false, liveMutationPerformed: false } };
}

function main(args) {
  if (args.length !== 6 || args[0] !== '--workspace' || args[2] !== '--output' || args[4] !== '--report') {
    throw new Error('Usage: --workspace /private/live --output /private/new/candidate.json --report /private/new/report.json');
  }
  const verified = verifyWorkspace(args[1], { quiet: true });
  const targets = [args[3], args[5]];
  const repository = path.dirname(root);
  if (new Set(targets).size !== 2) throw new Error('Candidate and report must have different paths');
  for (const target of targets) {
    if (!path.isAbsolute(target) || path.resolve(target) !== target || fs.existsSync(target)
      || target.startsWith(`${repository}${path.sep}`) || target.startsWith(`${verified.workspace}${path.sep}`)) {
      throw new Error('Output must be new, canonical and outside the repository/live workspace');
    }
    const parent = path.dirname(target);
    if (!fs.existsSync(parent) || fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o077)) {
      throw new Error('Output parent must be a private canonical directory');
    }
  }
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha(bytes) !== verified.sourceSha256) throw new Error('Verified source changed');
  const built = composeSubscriptionCalculationRepair(bytes);
  fs.writeFileSync(targets[0], built.candidateBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(targets[1], `${JSON.stringify({ ...built.report, contract: built.contract }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(built.report));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
