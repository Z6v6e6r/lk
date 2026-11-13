// Offline, exact-preimage composition; never imports or deploys a flow.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
export const reconciledSha = value => crypto.createHash('sha256').update(value).digest('hex');
export const RECONCILED_IDS = ['lk_subscription_booking_router_20260804', 'lk_subscription_booking_finalize_20260804', 'bcc3dccf8d64f9bb'];
export const RECONCILED_PINS = ['a35313a5888f721f96d19bf5cf43e92bad5dc41757809e5ea8b8e8f7e5c2066b',
  'd3895c7bb1d10d91465e5e4052ce82a5a6ab656a153409f6fd6f17c234340edc',
  '676a2caff25cb948fb791e69c98dbdb58431f861957ef21fb9f481fc13bb3186'];
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('RECONCILED_CANCELLATION_ANCHOR_DRIFT');
  return source.replace(before, () => after);
};
export function reconciledRuntimeSource() {
  const transactionSource = read('./lib/lk1UnpaidBookingCancellation.mjs').replace(/^export /gm, '');
  const classifier = extractSubscriptionPricePreviewSource({ source: transactionSource, roots: ['classifyLk1Transaction'] }).source;
  const module = read('./lib/lk1ReconciledCancellation.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  return `const lk1ReconciledTransaction = (() => {\n${classifier}\nreturn classifyLk1Transaction;\n})();\n`
    + module + '\n' + read('./nodered_lk1_hub_nodes/reconciled_cancelled_visit.js');
}
export function reconciledRouterEdits() {
  return [
    ['const lk1DailyVisitKey =', reconciledRuntimeSource() + '\nconst lk1DailyVisitKey ='],
    ['  if (!released) return lk1DailyVisitReject(ctx);',
      '  if (!released && !lk1ReconciledVerified(ctx, owner)) return lk1DailyVisitReject(ctx);'],
  ];
}
export function reconciledFinalizerEdits() {
  // Preserve the installed http-only exception bytes as the exact preimage.
  const current = read('./nodered_lk1_hub_nodes/daily_visit_refusal.js');
  const before = current.slice(current.indexOf('if (ctx?.lk1 &&'))
    .replace("((ctx.caller === 'http' && ctx.action === 'book') || lk1SplitVisitRefusal)", "ctx.caller === 'http' && ctx.action === 'book'");
  const header = current.slice(0, current.indexOf('const lk1SplitVisitRefusal'));
  return [[header + before, current]];
}
export function timeoutPreservationEdits() {
  return [
    ['  const actorClientId = isActorBooking(ctx, bookingId) ? toStr(ctx.actorClientId) : null;',
      '  const actorClientId = isActorBooking(ctx, bookingId) ? toStr(ctx.actorClientId)\n    : ctx.currentTransactionUnpaidVerified === true ? toStr(clientId) : null;'],
    ['  ctx.currentTransactionUnpaidVerified = false;',
      '  ctx.currentTransactionUnpaidVerified = false;\n  delete ctx.currentTimeoutBookingChecked;'],
    ['  if (ctx.currentTransactionUnpaidVerified === true) {',
      `  if (ctx.currentTransactionUnpaidVerified === true) {
    if (ctx.currentTimeoutBookingChecked !== true || options.subscription || options.exercise
      || options.money || options.deposit || options.settlementAccount) {
      return { unsupportedReason: "Subscription or prepaid visit return requires a durable cancellation owner",
        unsupportedCode: "timeout_subscription_return_requires_owner" };
    }`],
    ['  if (isOk(statusCode) && isCancelledBookingRow(msg.payload)) {',
      read('./nodered_lk1_hub_nodes/timeout_subscription_preservation.js') + '\n  if (isOk(statusCode) && isCancelledBookingRow(msg.payload)) {'],
  ];
}
export const applyReconciledEdits = (source, edits) => edits.reduce((s, [a, b]) => replace(s, a, b), source);
export function composeReconciledCancellationRecovery(liveBytes, options) {
  if (!/^[a-f0-9]{64}$/.test(options?.expectedSourceSha256 || '')
    || reconciledSha(liveBytes) !== options.expectedSourceSha256) throw Error('RECONCILED_CANCELLATION_SOURCE_DRIFT');
  const source = JSON.parse(liveBytes);
  if (!Array.isArray(source) || new Set(source.map(n => n.id)).size !== source.length) throw Error('RECONCILED_CANCELLATION_GRAPH_INVALID');
  const candidate = structuredClone(source), edits = [reconciledRouterEdits(), reconciledFinalizerEdits(), timeoutPreservationEdits()];
  const pins = options.pins || RECONCILED_PINS;
  for (let i = 0; i < RECONCILED_IDS.length; i++) {
    const n = candidate.find(n => n.id === RECONCILED_IDS[i]), tab = candidate.find(t => t.id === n?.z);
    if (n?.type !== 'function' || n.d || n.disabled || tab?.type !== 'tab' || tab.disabled
      || n.outputs !== [8, 2, 4][i] || reconciledSha(n.func) !== pins[i]) throw Error('RECONCILED_CANCELLATION_NODE_DRIFT');
    n.func = applyReconciledEdits(n.func, edits[i]);
    new Function('msg', 'node', 'global', 'env', 'flow', n.func);
    if (applyReconciledEdits(n.func, edits[i].slice().reverse().map(([a, b]) => [b, a])) !== source.find(x => x.id === n.id).func) {
      throw Error('RECONCILED_CANCELLATION_INVERSE_INVALID');
    }
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'reconciled-cancellation-recovery',
    allowedChanges: RECONCILED_IDS.map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, changedNodes: RECONCILED_IDS, candidateSha256: reconciledSha(candidateBytes) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const verified = verifyWorkspace(process.argv[2], { quiet: true });
    const built = composeReconciledCancellationRecovery(fs.readFileSync(verified.sourcePath), { expectedSourceSha256: process.argv[3] });
    for (const [name, bytes] of [['reconciled-cancellation-candidate.json', built.candidateBytes],
      ['reconciled-cancellation-contract.json', JSON.stringify(built.contract, null, 2) + '\n']]) {
      fs.writeFileSync(path.join(verified.workspace, name), bytes, { mode: 0o600, flag: 'wx' });
    }
    console.log(JSON.stringify({ changedNodes: built.changedNodes, candidateSha256: built.candidateSha256, deploymentPerformed: false }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
