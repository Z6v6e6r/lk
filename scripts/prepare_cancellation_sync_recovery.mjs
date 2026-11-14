// Offline source-driven candidate. No import/restart, provider or database write.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildOrganizerHandoffCandidate } from './build_organizer_handoff_candidate.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
export const CANCELLATION_SYNC_SOURCE = 'd61b4edb5f3766e138b4ec8eae5c3578e3e09af2b2eecd90b4c8c308cb9dd64f';
const edits = JSON.parse(read('./lib/cancellationSyncSourceEdits.json'));
const budget = JSON.parse(read('./lib/cancellationSyncContractBudget.json'));
const replace = (s, a, b) => {
  if (!a || s.split(a).length !== 2) throw Error('CANCELLATION_SYNC_ANCHOR_DRIFT');
  return s.replace(a, () => b);
};
export function patchCancellationSyncRouter(source) {
  const start = source.indexOf('// Native, zero-money subscription cancellation.');
  const end = source.indexOf('// lk1Free* pure protocol', start);
  if (start < 0 || end < start || sha(source.slice(start, end).trim()) !== '59950b6aea87ec191ae8ba3cf71b0fd0278f8087dac62b0d52f0f247afc5a7ed') throw Error('CANCELLATION_PROTOCOL_PREIMAGE_DRIFT');
  let s = source.slice(0, start) + read('./lib/lk1FreeCancellation.mjs').replace(/^export /gm, '') + '\n' + source.slice(end);
  const [helpers, steps] = read('./nodered_lk1_hub_nodes/free_cancel.js').split('// FREE_CANCEL_STEPS\n');
  s = replace(s, edits.freeHelpers, helpers);
  s = replace(s, edits.freeSteps, steps.trim());
  s = replace(s, edits.cancelledAllowanceBefore, read('./nodered_lk1_hub_nodes/cancelled_allowance.js').trim());
  s = replace(s, '  if (typeof lk1FreeReturnedOperation === "function" && lk1FreeReturnedOperation(operation)) return true;',
    '  if (lk1SeatReleasedOperation(operation)) return true;\n  if (typeof lk1FreeReturnedOperation === "function" && lk1FreeReturnedOperation(operation)) return true;');
  s = replace(s, '(lk1FreeReturnedOperation(operation) || lk1LegacyVerified(ctx, operation))',
    '(lk1FreeReturnedOperation(operation) || lk1SeatReleasedOperation(operation) || lk1LegacyVerified(ctx, operation))');
  s = replace(s, 'previous.lk1.freeCancellationReturn?.jobKey\n', 'previous.lk1.freeCancellationReturn?.jobKey || previous.lk1.seatRelease?.jobKey\n');
  s = replace(s, 'previous.releaseOperationId || previous.lk1?.freeCancellationReturn?.jobKey,',
    'previous.releaseOperationId || previous.lk1?.freeCancellationReturn?.jobKey || previous.lk1?.seatRelease?.jobKey,');
  s = replace(s, '|| owner.serviceDate !== ctx.serviceDate || owner.lk1?.decision?.subscriptionVisitCount !== 1)',
    '|| owner.serviceDate !== ctx.serviceDate || owner.actorClientId !== ctx.actorClientId || owner.lk1?.decision?.subscriptionVisitCount !== 1)');
  s = replace(s, '  if (!released && !lk1ReconciledVerified(ctx, owner)) return lk1DailyVisitReject(ctx);',
    `  if (!released && !lk1SeatReleasedOperation(owner) && !lk1ReconciledVerified(ctx, owner)) {
    const started = lk1SeatStart(ctx, owner); if (started) return started;
    return lk1DailyVisitReject(ctx);
  }`);
  new Function('msg', 'node', 'global', 'env', 'flow', s);
  return s;
}
export function composeCancellationSyncRecovery(liveBytes) {
  if (sha(liveBytes) !== CANCELLATION_SYNC_SOURCE) throw Error('CANCELLATION_SYNC_SOURCE_DRIFT');
  const source = JSON.parse(liveBytes);
  const n = id => { const matches = source.filter(n => n.id === id); if (matches.length !== 1) throw Error('NODE_ID_DRIFT'); return matches[0]; };
  // Preserve the installed legacy/managed/monetary lineage; only add the handoff
  // completion fence here, rather than copying an unrelated maintained router.
  const routeSource = replace(n('lk_split_leave_operation_route_20260801').func,
    '  return respond(200, "DONE", operation.refundMessage || operation.successMessage || "Вы вышли из игры");',
    '  respond(200, "DONE", operation.refundMessage || operation.successMessage || "Вы вышли из игры");\n  msg._splitLeaveCtx = ctx; return [null, null, null, null, msg];');
  const { flow } = buildOrganizerHandoffCandidate(source, { functionSources: {
    lk_split_leave_operation_route_20260801: routeSource,
  } });
  const node = id => flow.find(n => n.id === id);
  node('lk_subscription_booking_router_20260804').func = patchCancellationSyncRouter(n('lk_subscription_booking_router_20260804').func);
  node('lk_subscription_price_preview_20260908_router').func = replace(n('lk_subscription_price_preview_20260908_router').func,
    edits.cancelledAllowanceBefore, read('./nodered_lk1_hub_nodes/cancelled_allowance.js').trim());
  for (const [id, file] of [['7c280001a0c1e015', 'scripts/nodered_games_nodes/fn_split_leave_authorize.js'],
    ['9878400d518ebcbd', 'scripts/nodered_games_nodes/fn_split_leave_router.js']]) {
    for (const [before, after] of edits[file]) node(id).func = replace(node(id).func, before, after);
  }
  const module = read('./lib/gameCancellationReconciliation.mjs').replace(/^export /gm, '');
  const prefix = 'cancellation_sync_20261114_';
  const add = (template, suffix, fields) => {
    const created = { ...structuredClone(node(template)), id: prefix + suffix, ...fields };
    flow.push(created); return created.id;
  };
  const response = '35f7c89069fc393a';
  const fn = (suffix, file, wires, embedded = '') => add('016d6797a530ed0a', suffix, {
    name: 'Cancellation sync ' + suffix, func: embedded + read('./nodered_organizer_handoff_nodes/' + file + '.js'), outputs: wires.length, wires });
  const mongo = (suffix, operation, collection, wires) => add(operation === 'find' ? '7c280001a0c1e014' : 'lk_split_leave_game_update_20260801', suffix,
    { name: 'Cancellation sync ' + suffix, operation, collection, wires });
  add('ecf32036257013bd', 'http', { name: 'Reconcile cancelled game', url: '/lk/games/:gameId/cancellation/status', wires: [[prefix + 'auth']] });
  for (const [suffix, template, next] of [['auth', '7c280001a0c1e011', 'profile'], ['profile', '7c280001a0c1e012', 'resolve'], ['resolve', '7c280001a0c1e013', 'prepare']]) {
    add(template, suffix, { wires: [[prefix + next], ...node(template).wires.slice(1)] });
  }
  fn('prepare', 'fn_cancellation_status_prepare', [[prefix + 'find'], [response]], module);
  mongo('find', 'find', 'lk_games', [[prefix + 'route']]);
  fn('route', 'fn_cancellation_status_route', [[prefix + 'provider'], [prefix + 'update'], [response], [prefix + 'find']], module);
  add('7c280001a0c1e012', 'provider', { name: 'Read exact cancellation truth', followRedirects: false, wires: [[prefix + 'route']] });
  mongo('update', 'updateOne', 'lk_games', [[prefix + 'route']]);
  const operationStart = 'lk_split_leave_operation_start_build_20260801';
  for (const item of flow) if (item.wires) item.wires = item.wires.map(w => w.map(id => id === operationStart ? prefix + 'count_prepare' : id));
  fn('count_prepare', 'fn_leave_count_find', [[prefix + 'count_find'], [operationStart]]);
  mongo('count_find', 'find', 'lk_subscription_daily_booking_ops', [[prefix + 'count_resolve']]);
  fn('count_resolve', 'fn_leave_count_resolve', [[operationStart]]);
  const ids = new Set(flow.map(n => n.id));
  if (ids.size !== flow.length) throw Error('CANCELLATION_DUPLICATE_NODES');
  for (const item of flow) {
    if ((item.wires || []).flat().some(id => !ids.has(id))) throw Error('CANCELLATION_BROKEN_WIRE:' + item.id + ':' + (item.wires || []).flat().filter(id => !ids.has(id)).join(','));
    if (item.type === 'function') new Function('msg', 'node', 'global', 'env', 'flow', item.func);
  }
  const before = new Map(source.map(n => [n.id, n])), actualChanges = [];
  for (const item of flow) if (before.has(item.id) && !isDeepStrictEqual(before.get(item.id), item)) {
    actualChanges.push({ id: item.id, fields: Object.keys(item).filter(k => !isDeepStrictEqual(item[k], before.get(item.id)[k])) });
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const additions = flow.filter(n => !before.has(n.id)).map(n => n.id);
  const normalized = rows => rows.map(r => ({ id: r.id, fields: [...r.fields].sort() })).sort((a, b) => a.id.localeCompare(b.id));
  if (source.length !== budget.sourceNodeCount || !isDeepStrictEqual(normalized(actualChanges), normalized(budget.allowedChanges))
    || !isDeepStrictEqual([...additions].sort(), [...budget.allowedAdditionIds].sort())) throw Error('CANCELLATION_CHANGE_BUDGET_DRIFT');
  const { allowedChanges, allowedAdditionIds } = budget;
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'cancellation-sync-recovery', allowedChanges, allowedAdditionIds });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, allowedChanges, allowedAdditionIds, candidateSha256: sha(candidateBytes) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [input, output] = process.argv.slice(2);
  if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '') || fs.existsSync(output)) throw Error('NEW_PRIVATE_OUTPUT_REQUIRED');
  const result = composeCancellationSyncRecovery(fs.readFileSync(input));
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'candidate.json'), result.candidateBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(output, 'contract.json'), JSON.stringify(result.contract, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: CANCELLATION_SYNC_SOURCE, candidateSha256: result.candidateSha256,
    changed: result.allowedChanges, added: result.allowedAdditionIds, deployed: false }));
}
