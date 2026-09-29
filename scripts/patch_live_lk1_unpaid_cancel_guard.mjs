#!/usr/bin/env node

// One-function live-flow patch. The full 147 source and gateway preimage are
// frozen below; any concurrent release requires a new review, not a rebase of
// this candidate. No import, restart, or provider write occurs here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE_SHA = 'c1d4448876d4d202e845f79c3f83578cacfa4c07e6e10dd2010ea8b8923f7dac';
const SOURCE_NODES = 4804;
const GATEWAY_ID = 'lk_subscription_booking_router_20260804';
const GATEWAY_SHA = 'ea704144c296e7c6e44ed1723d7b8ec80170642cb7e7980a5ff1b5bc563b3627';
const PATCHED_GATEWAY_SHA = 'e3b46e691517118cabbe259bb3831b99896b3f8a32202b437fa452d8349f17ee';
const ANCHOR = 'const lk1Finish = (ctx) => {\n  const payment = ctx.lk1?.checkout;';
const REPLACEMENT = 'const lk1Finish = (ctx) => {\n  if (isObj(ctx.lk1?.unpaidCancellation)) return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");\n  const payment = ctx.lk1?.checkout;';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const isWithin = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

function privateOutput(file, label) {
  if (!path.isAbsolute(file) || fs.existsSync(file)) throw new Error(`${label} must be a new absolute file`);
  const parent = path.dirname(file), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || fs.realpathSync(parent) !== parent || isWithin(ROOT, parent)) {
    throw new Error(`${label} must have a private external parent`);
  }
}

export function buildLk1UnpaidGuardCandidate(source, sourceSha) {
  if (sourceSha !== SOURCE_SHA || !Array.isArray(source) || source.length !== SOURCE_NODES) {
    throw new Error('LIVE_FLOW_PREIMAGE_CHANGED');
  }
  const matches = source.filter(node => node?.id === GATEWAY_ID);
  if (matches.length !== 1 || matches[0].type !== 'function'
    || sha(matches[0].func || '') !== GATEWAY_SHA) throw new Error('GATEWAY_PREIMAGE_CHANGED');
  const before = matches[0].func;
  if (before.split(ANCHOR).length !== 2 || before.includes('ctx.lk1?.unpaidCancellation')) {
    throw new Error('GATEWAY_ANCHOR_CHANGED');
  }
  const after = before.replace(ANCHOR, REPLACEMENT);
  if (sha(after) !== PATCHED_GATEWAY_SHA) throw new Error('GATEWAY_CANDIDATE_CHANGED');
  return source.map(node => node.id === GATEWAY_ID ? { ...node, func: after } : node);
}

function main(args) {
  const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  if (args.length !== 6 || !value('--workspace') || !value('--output') || !value('--report')) {
    throw new Error('Usage: patch_live_lk1_unpaid_cancel_guard.mjs --workspace ABS --output ABS --report ABS');
  }
  const output = value('--output'), report = value('--report');
  privateOutput(output, 'Candidate');
  privateOutput(report, 'Report');
  const live = verifyWorkspace(value('--workspace'), { quiet: true });
  const candidate = buildLk1UnpaidGuardCandidate(live.source, live.sourceSha256);
  const bytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const result = { sourceSha256: live.sourceSha256, candidateSha256: sha(bytes),
    changedNodeId: GATEWAY_ID, sourceFuncSha256: GATEWAY_SHA, candidateFuncSha256: PATCHED_GATEWAY_SHA,
    nodeCount: candidate.length };
  fs.writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`candidateSha256=${result.candidateSha256}\nchangedNodeCount=1\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
