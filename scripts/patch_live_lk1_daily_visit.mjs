#!/usr/bin/env node
// Preparation only. Preserve the installed graph; change the gateway and the
// identical allowance/evaluator logic embedded in its advisory price preview.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { moveFreeCancellationStepsAfterDailyHelpers } from './patch_live_lk1_free_cancellation.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const DAILY_VISIT_SOURCE_SHA256 = 'f88f9af400e945f280904d31ffd5e33014e25ff98ece2cb3b96ae7ae2380d4ac';
export const DAILY_VISIT_PINS = Object.freeze({
  lk_subscription_booking_router_20260804: '71ad42a9bd61572194a48b81e8929c3b6796683b1bba46f896fc02969e6005a6',
  lk_subscription_managed_policy_20260820: '2ae7ff615c1ce03d14e35109ff3401c8269f98bd86a5dd1d4907b3071d3f659a',
  lk_subscription_price_preview_20260908_router: '966b29062fb33bc87120ec0809584eff42c4378a7868ea07a58c56e063ffd5b5',
  lk_subscription_price_preview_20260908_evaluate: '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
});
export const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Daily visit source anchor drift');
  return source.replace(before, () => after);
};
export function patchDailyVisitUsage(source) {
  if (source.includes('usedOrReservedVisitsToday: dailyVisits')) throw new Error('Daily usage already patched; source drift');
  const start = 'if (ctx.step === "lk1_usage_operations") {';
  const end = '  delete ctx.lk1.bookings;\n  delete ctx.lk1.activeBookings;\n  return emit(OUTPUT_MANAGED_POLICY);\n}';
  const from = source.indexOf(start), endAt = source.indexOf(end, from), to = endAt + end.length;
  if (from < 0 || endAt < 0 || source.split(start).length !== 2) throw new Error('Daily usage boundary drift');
  let block = source.slice(from, to);
  block = replaceOnce(block, '  let used = 0;', '  let used = 0;\n  let dailyVisits = 0;');
  block = replaceOnce(block, '    if (operation.serviceDate !== ctx.serviceDate) continue;',
    `    if (operation.serviceDate !== ctx.serviceDate) continue;
    const visits = operation.lk1.decision.subscriptionVisitCount;
    if (![0, 1].includes(visits)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
    dailyVisits += visits;`);
  block = replaceOnce(block, '    const category = resolveCategory(booking);',
    `    // A live subscription booking without an operation also consumes the day.
    // Operation-bound rows were deduplicated by booking ID above.
    if (String(booking.paymentType || booking.paymentMethod || "").toUpperCase() === "SUBSCRIPTION") dailyVisits += 1;
    const category = resolveCategory(booking);`);
  block = replaceOnce(block, '      usedOrReservedFreeMinutesToday: used,',
    '      usedOrReservedFreeMinutesToday: used,\n      usedOrReservedVisitsToday: dailyVisits,');
  return source.slice(0, from) + block + source.slice(to);
}
export function patchDailyVisitEvaluator(source) {
  return replaceOnce(source, '  const aboveActiveLimit = decision.aboveActiveLimit === true;',
    `  // One visit per subscription and Moscow service day, across every category.
  // A later event retains its existing discount/co-pay, without a second visit.
  const dailyVisits = usage?.usedOrReservedVisitsToday;
  if (!Number.isSafeInteger(dailyVisits) || dailyVisits < 0
    || usage?.dailyBucketLocalDate !== moscowLocalDate(target?.startsAt)) {
    block("DAILY_VISIT_SNAPSHOT_INVALID", "Дневное посещение подписки не подтверждено");
  }
  const aboveActiveLimit = decision.aboveActiveLimit === true || dailyVisits !== 0;`);
}
export function patchDailyVisitGateway(source) {
  let patched = patchDailyVisitUsage(source);
  const guard = fs.readFileSync(new URL('./nodered_lk1_hub_nodes/daily_visit_guard.js', import.meta.url), 'utf8');
  const steps = 'if (ctx.step === "lk1_ingress_operation_find") {';
  patched = replaceOnce(patched, steps, guard + '\n' + steps);
  patched = replaceOnce(patched, 'const preparePreaccept = (ctx) => {',
    `const preparePreaccept = (ctx) => {
  if (ctx.lk1?.decision?.subscriptionVisitCount === 1 && ctx.lk1DailyVisitOwned !== true) {
    return lk1DailyVisitAcquire(ctx);
  }`);
  patched = replaceOnce(patched, 'const prepareBookingCreate = (ctx) => {',
    `const prepareBookingCreate = (ctx) => {
  if (ctx.lk1?.decision?.subscriptionVisitCount === 1 && ctx.lk1DailyVisitOwned !== true) {
    ctx.lk1DailyVisitContinuation = "booking";
    return lk1DailyVisitAcquire(ctx);
  }`);
  patched = replaceOnce(patched, '  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));',
    '  ctx.lk1.dailyVisitPolicyVersion = 1;\n  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));');
  const insert = '  msg.payload = [record, { writeConcern: { w: "majority", j: true } }];';
  // Scope this replacement to the LK1 decision block, not the legacy insert.
  const start = patched.indexOf('if (ctx.step === "lk1_policy_decision") {');
  const at = patched.indexOf(insert, start);
  if (at < 0) throw new Error('Daily visit operation insert anchor drift');
  const retry = `  if (ctx.lk1DailyVisitRetry) {
    const replacement = { ...record };
    delete replacement._id;
    return prepareMongoUpdate(ctx, "lk1_daily_visit_retry_saved", {
      _id: ctx.operationKey, operationId: ctx.operationId, state: "FAILED",
      "failure.rawCode": "LK1_DAILY_VISIT_CHANGED",
      "lk1.fingerprint": ctx.lk1DailyVisitRetry.fingerprint,
      upstreamAttemptedAt: { $exists: false }, bookingId: { $exists: false },
      upstreamBookingId: { $exists: false }, "lk1.createAttemptedAt": { $exists: false },
    }, { $set: replacement, $unset: { failure: "", failedAt: "" } });
  }
`;
  patched = patched.slice(0, at) + retry + patched.slice(at);
  // Canonical HUB sources can already contain the cancellation dispatch.
  // Keep it behind the guard helpers added by this composer as well.
  if (patched.includes("if (ctx.step === 'lk1_free_cancel_booking_gate') {")) {
    patched = moveFreeCancellationStepsAfterDailyHelpers(patched);
  }
  return patched;
}
export function composeDailyVisitArtifacts(liveBytes) {
  if (sha256(liveBytes) !== DAILY_VISIT_SOURCE_SHA256) throw new Error('Daily visit live preimage drift');
  const source = JSON.parse(liveBytes), candidate = structuredClone(source);
  if (source.length !== 4876) throw new Error('Daily visit node count drift');
  for (const [id, digest] of Object.entries(DAILY_VISIT_PINS)) {
    const nodes = candidate.filter(n => n.id === id && n.type === 'function' && !n.d && !n.disabled);
    if (nodes.length !== 1 || sha256(nodes[0].func) !== digest) throw new Error('Daily visit function preimage drift');
    const node = nodes[0];
    node.func = id === 'lk_subscription_booking_router_20260804' ? patchDailyVisitGateway(node.func)
      : id === 'lk_subscription_price_preview_20260908_router' ? patchDailyVisitUsage(node.func)
        : patchDailyVisitEvaluator(node.func);
    new Function('msg', 'node', 'global', 'env', 'context', 'flow', 'RED', node.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-one-daily-visit', allowedAdditionIds: [],
    allowedChanges: Object.keys(DAILY_VISIT_PINS).map(id => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, changedNodes: Object.keys(DAILY_VISIT_PINS) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = verifyWorkspace(process.argv[2], { quiet: true });
  const source = fs.readFileSync(workspace.sourcePath);
  const built = composeDailyVisitArtifacts(source);
  const output = path.join(workspace.workspace, 'daily-visit-candidate.json');
  fs.writeFileSync(output, built.candidateBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(workspace.workspace, 'daily-visit-contract.json'),
    JSON.stringify(built.contract, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ sourceSha256: sha256(source), candidateSha256: sha256(built.candidateBytes),
    changedNodes: built.changedNodes, deploymentPerformed: false, liveMutationPerformed: false }));
}
