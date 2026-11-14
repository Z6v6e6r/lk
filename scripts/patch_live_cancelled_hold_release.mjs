// ADR 0004, request-time check. Offline, exact-preimage composition; never imports or
// deploys a flow.
//
// Usage (booking + preview routers): a CONFIRMED operation without money side effects
// whose bound booking the request's fresh self-API receipt proves cancelled no longer
// counts as a used daily visit or free minutes (cancelled_hold.js).
// Takeover (booking router only): the daily-visit guard owned by such an operation is
// handed to the new operation when this same request proved that exact owner cancelled
// (cancelled_hold_guard.js). The old operation stays CONFIRMED without the guard; the
// scheduled dead-hold release returns it later.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const CANCELLED_HOLD_TARGETS = Object.freeze({
  booking: { id: 'lk_subscription_booking_router_20260804', outputs: 8 },
  preview: { id: 'lk_subscription_price_preview_20260908_router', outputs: 6 },
});
export const CANCELLED_HOLD_DEPLOYMENT_ID = 'cancelled-hold-release';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(new URL(`./nodered_lk1_hub_nodes/${name}.js`, import.meta.url), 'utf8');

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Cancelled hold anchor drift: ${before.trim().slice(0, 60)}`);
  return source.replace(before, () => after);
}

export const USAGE_START = 'if (ctx.step === "lk1_usage_operations") {';
const ZERO_VISIT_SKIP = '    if (lk1CancelledZeroVisitOperation(operation)) continue;';
const ZERO_VISIT_END = '\n  let used = 0;';
export const GUARD_REJECT = '  if (!released && !lk1ReconciledVerified(ctx, owner)) return lk1DailyVisitReject(ctx);';
const GUARD_TOP = 'const lk1DailyVisitKey =';

function usageBounds(source) {
  const start = source.indexOf(USAGE_START);
  const policyEnd = source.indexOf('if (ctx.step === "lk1_policy_decision") {', start);
  const end = policyEnd >= 0 ? policyEnd : source.indexOf('\n\n  };\n// Dedicated advisory graph.', start);
  if (start < 0 || end < 0 || source.indexOf(USAGE_START, start + 1) >= 0) throw new Error('Cancelled hold usage boundaries missing');
  return { start, end };
}

/** Usage edits, shared by both routers. Each anchor must occur exactly once in the usage step. */
export function cancelledHoldUsageEdits() {
  return [
    [ZERO_VISIT_END, `\n${read('cancelled_hold')}${ZERO_VISIT_END}`],
    [ZERO_VISIT_SKIP, `${ZERO_VISIT_SKIP}\n    if (lk1CancelledProviderHold(operation)) { lk1RememberCancelledHold(operation); continue; }`],
  ];
}
export function cancelledHoldGuardEdits() {
  return [
    [GUARD_TOP, `${read('cancelled_hold_guard')}\n${GUARD_TOP}`],
    [GUARD_REJECT, '  if (!released && !lk1ReconciledVerified(ctx, owner) && !lk1CancelledHoldVerified(ctx, owner)) {\n'
      + '    return lk1DailyVisitReject(ctx);\n  }'],
  ];
}
const apply = (source, edits) => edits.reduce((value, [before, after]) => replaceOnce(value, before, after), source);
const invert = edits => edits.slice().reverse().map(([before, after]) => [after, before]);

export function patchCancelledHoldUsage(source) {
  const { start, end } = usageBounds(source);
  return source.slice(0, start) + apply(source.slice(start, end), cancelledHoldUsageEdits()) + source.slice(end);
}
export function unpatchCancelledHoldUsage(source) {
  const { start, end } = usageBounds(source);
  return source.slice(0, start) + apply(source.slice(start, end), invert(cancelledHoldUsageEdits())) + source.slice(end);
}
export const patchCancelledHoldBooking = source => apply(patchCancelledHoldUsage(source), cancelledHoldGuardEdits());
export const patchCancelledHoldPreview = source => patchCancelledHoldUsage(source);

/**
 * Compose candidate and exact graph contract from the live flow. `expected` pins the
 * whole-flow SHA and both node SHAs; the composer refuses any drift and proves the
 * patch is exactly invertible.
 */
export function composeCancelledHoldArtifacts(liveBytes, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected?.sourceSha256 ?? '') || hash(liveBytes) !== expected.sourceSha256) {
    throw new Error('Cancelled hold whole-flow preimage drift');
  }
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid flow identity');
  const original = JSON.parse(liveBytes);
  for (const [kind, target] of Object.entries(CANCELLED_HOLD_TARGETS)) {
    const node = flow.find(n => n.id === target.id), tab = flow.find(t => t.id === node?.z);
    if (node?.type !== 'function' || node.d === true || node.disabled === true || node.outputs !== target.outputs
      || node.wires?.length !== node.outputs || tab?.type !== 'tab' || tab.disabled
      || hash(node.func) !== expected[kind]) throw new Error(`Cancelled hold ${kind} node preimage drift`);
    node.func = kind === 'booking' ? patchCancelledHoldBooking(node.func) : patchCancelledHoldPreview(node.func);
    new Function('msg', 'node', 'global', 'env', 'flow', node.func);
    const back = kind === 'booking' ? unpatchCancelledHoldUsage(apply(node.func, invert(cancelledHoldGuardEdits())))
      : unpatchCancelledHoldUsage(node.func);
    if (back !== original.find(n => n.id === target.id).func) throw new Error('Cancelled hold inverse invalid');
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: CANCELLED_HOLD_DEPLOYMENT_ID,
    allowedChanges: Object.values(CANCELLED_HOLD_TARGETS).map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return {
    candidateBytes, contract, sourceSha256: hash(liveBytes), candidateSha256: hash(candidateBytes),
    bookingSha256: hash(flow.find(n => n.id === CANCELLED_HOLD_TARGETS.booking.id).func),
    previewSha256: hash(flow.find(n => n.id === CANCELLED_HOLD_TARGETS.preview.id).func),
    changedNodeCount: 2, addedNodeCount: 0,
  };
}

async function main() {
  const [workspace, output, contractPath, sourceSha256, bookingSha256, previewSha256] = process.argv.slice(2);
  if (process.argv.length !== 8) {
    throw new Error('Usage: WORKSPACE NEW_PRIVATE_CANDIDATE NEW_PRIVATE_CONTRACT FLOW_SHA256 BOOKING_SHA256 PREVIEW_SHA256');
  }
  const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
  const verified = verifyWorkspace(workspace, { quiet: true });
  for (const file of [output, contractPath]) {
    const parent = path.dirname(file);
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.existsSync(file)
      || fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o777) !== 0o700
      || file.startsWith(`${fs.realpathSync(new URL('..', import.meta.url))}/`)
      || file.startsWith(`${verified.workspace}/`)) throw new Error('New private external output required');
  }
  if (output === contractPath) throw new Error('Distinct outputs required');
  const built = composeCancelledHoldArtifacts(fs.readFileSync(verified.sourcePath),
    { sourceSha256, booking: bookingSha256, preview: previewSha256 });
  fs.writeFileSync(output, built.candidateBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(contractPath, `${JSON.stringify(built.contract, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    bookingSha256: built.bookingSha256, previewSha256: built.previewSha256, changedNodeCount: 2, addedNodeCount: 0,
    deploymentPerformed: false }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
