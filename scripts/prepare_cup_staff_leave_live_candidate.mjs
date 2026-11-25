import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { routeCupBookingDiscovery } from './lib/cup_staff_leave_discovery.mjs';
import { prepareStaffDiscoveryUnlock, finishStaffDiscoveryUnlock } from './lib/cup_staff_leave_unlock.mjs';

export const ids = Object.freeze({
  prepare: 'lk_staff_player_leave_prepare_20260812',
  authorize: 'lk_staff_player_leave_authorize_20260812',
  router: '9878400d518ebcbd',
  start: 'lk_split_leave_operation_start_build_20260801',
  route: 'lk_split_leave_operation_route_20260801',
  retrySelect: 'lk_split_leave_retry_select_20260801',
  retryHydrate: 'lk_split_leave_retry_hydrate_20260801',
  update: 'lk_split_leave_game_update_build_20260801',
  response: '35f7c89069fc393a',
  count: 'cancellation_sync_20261114_count_prepare',
  http: '52af61191cdbe9ef',
  providerGate: 'organizer_handoff_20260913_provider_build',
  lockUpdate: 'organizer_handoff_20260913_provider_update',
  unlockPrepare: 'cup_staff_booking_discovery_unlock_prepare_20261125',
  unlockUpdate: 'cup_staff_booking_discovery_unlock_update_20261125',
  unlockFinish: 'cup_staff_booking_discovery_unlock_finish_20261125',
  unlockCatch: 'cup_staff_booking_discovery_unlock_catch_20261125',
});
const pins = {
  prepare: '302b4c2982e72d3253930cf1fedffa1c6a35a8464d21698fb9306a0c9c441b80',
  authorize: '21b49b991112ec559295a9ce5764a33ee70b324e660490948b91bfacdf98241d',
  router: 'd745181d442daf87bdfb7bdbcd9b5afdb3741c4b96057909c3ab2e1bddffd96c',
  start: '8e38fcb72ddc20628a18a7b8e781dbf35c5d57626eddc7ddbbffbaba84df96da',
  route: 'b77f69725f5f032e4e438ff67192abc0b173f82a73c0121b104e944828010a97',
  retrySelect: '1fd8dafababbfe2c939b144d007c7df7a8e2e919e99c612be9ca6996c998a38f',
  retryHydrate: '30e4ced1b3187a0a8cf6762039188b8b28d42dadefc1461cc631f898140245d2',
  providerGate: '4e294ab209e10c3beb8ddb5657b195a9992cce2dcbe6ca61c2bbedee79cb5648',
  // The installed write path already checks discovery snapshots and preserves inactive payments.
  update: '6a4367b3f58ec853ad43920895a06c02adebea4c9af4bae0416c2c3c8f28dc80',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readNode = name => fs.readFileSync(new URL(`./nodered_games_nodes/${name}.js`, import.meta.url), 'utf8');
export const replaceOnce = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw new Error('CUP staff leave source anchor drift');
  return source.replace(anchor, () => replacement);
};

// All other router modes and the installed November cancellation gates keep their original bodies and wires.
export const renderers = {
  prepare: () => readNode('fn_staff_player_leave_prepare'),
  authorize: () => replaceOnce(readNode('fn_staff_player_leave_authorize'),
    'return [msg, null];', `if (needsDiscovery) {
  msg._splitLeaveCtx.preOperationDiscovery = true;
  msg._splitLeaveCtx.step = "start_verify_active";
  return [null, null, msg];
}
return [msg, null];`),
  router: source => replaceOnce(
    replaceOnce(source, '  delete msg._splitLeaveCtx;',
      `  if (ctx.bookingDiscoveryLockClaim && ctx.mode === "STAFF_TARGET") {
    return [null, null, null, null, null, msg];
  }
  delete msg._splitLeaveCtx;`),
    'if (ctx.step === "start_verify_active") return startActiveVerification(ctx);',
    `const discoveryResult = (${routeCupBookingDiscovery.toString()})(ctx, msg, {
  completeBookingPage, responseRows, rowBookingId, rowClientId, rowExerciseId, isCancelled,
  normalizeId, isOk, fail, resolveOptions,
  cancelProbeUrl, upstream, toOperationStart,
});
if (discoveryResult) return discoveryResult;
if (ctx.step === "start_verify_active") return startActiveVerification(ctx);`),
  start: source => replaceOnce(source, '      bookingIds,',
    `      ...(ctx.bookingDiscovery ? { bookingDiscovery: ctx.bookingDiscovery } : {}),
      bookingIds,`),
  route: source => replaceOnce(source, 'ctx.localReconciliation = operation.localReconciliation || ctx.localReconciliation || null;',
    `if (ctx.mode === "STAFF_TARGET" && (ctx.bookingDiscovery || operation.bookingDiscovery)) {
  const saved = operation.bookingDiscovery;
  const expected = ctx.bookingDiscovery;
  if (!expected?.bookingId || !saved || saved.bookingId !== expected.bookingId
    || saved.snapshotUpdatedAt !== expected.snapshotUpdatedAt || operation.gameId !== ctx.gameId
    || operation.exerciseId !== ctx.exerciseId || operation.vivaTargetMode !== "BOOKINGS"
    || operation.requestedRefundMethod !== "NONE"
    || !Array.isArray(operation.bookingIds) || operation.bookingIds.length !== 1
    || operation.bookingIds[0] !== expected.bookingId) {
    return respond(409, "CONFLICT", "Запись Viva изменилась. Обновите игру перед удалением.");
  }
  ctx.bookingDiscovery = saved;
  ctx.bookingDiscoveryLeaseUntil = operation.claimLeaseUntil;
}
ctx.localReconciliation = operation.localReconciliation || ctx.localReconciliation || null;`),
  retrySelect: source => replaceOnce(
    replaceOnce(source, '  localReconciliation: operation.localReconciliation || null,',
      '  localReconciliation: operation.localReconciliation || null,\n  bookingDiscovery: operation.bookingDiscovery || null,'),
    '      $inc: { recoveryAttempts: 1 },\n    },\n    {},\n  ];',
    `      $inc: { recoveryAttempts: 1 },
    },
    {},
  ];
  if (msg._splitLeaveCtx.bookingDiscovery) {
    msg._splitLeaveCtx.bookingDiscoveryLeaseUntil = msg.payload[1].$set.claimLeaseUntil;
  }`),
  retryHydrate: source => replaceOnce(
    replaceOnce(source, 'const currentVersion = membershipVersion([', 'const linkedVersion = membershipVersion(['),
    'if (ctx.localReconciliation) {', `if (ctx.bookingDiscovery && !ctx.localAlreadyApplied) {
  const proof = ctx.bookingDiscovery;
  const currentExerciseId = metadata.splitPayment?.vivaExerciseId || game.booking?.vivaExerciseId
    || game.booking?.exerciseId || metadata.vivaExerciseId || metadata.exerciseId;
  const localBookingIds = [...participants, ...payments, ...waitlist]
    .flatMap(row => [...asArray(row.bookingIds), row.bookingId, row.vivaBookingId]).filter(Boolean);
  const version = linkedVersion || membershipVersion([
    "viva-discovery", game.id, ctx.targetClientId, currentExerciseId, game.updatedAt,
  ]);
  if (ctx.mode !== "STAFF_TARGET" || ctx.requestedRefundMethod !== "NONE"
    || !proof.bookingId || ctx.initialBookingIds?.length !== 1
    || ctx.initialBookingIds[0] !== proof.bookingId || game.updatedAt !== proof.snapshotUpdatedAt
    || currentExerciseId !== ctx.exerciseId || version !== ctx.membershipVersion || localBookingIds.length
    || participants.length !== 1 || String(participants[0].source || "").toUpperCase() !== "ADMIN") {
    msg.payload = { operationId: ctx.operationId, reason: "staff_discovery_snapshot_changed" };
    return [null, null, msg, null];
  }
}
const currentVersion = linkedVersion || (ctx.bookingDiscovery && !ctx.localAlreadyApplied ? ctx.membershipVersion : null);

if (ctx.localReconciliation) {`),
  providerGate: source => replaceOnce(
    replaceOnce(
      replaceOnce(source, 'msg._splitLeaveCtx = ctx;\nconst query =', `if (ctx.bookingDiscovery && ctx.mode === "STAFF_TARGET") {
  if (!ctx.claimToken || !(Date.parse(ctx.bookingDiscoveryLeaseUntil) > Date.now())) {
    return fail("Истёк срок проверки записи. Повторите отмену.");
  }
  ctx.bookingDiscoveryLockClaim = ctx.claimToken;
}
msg._splitLeaveCtx = ctx;
const query =`),
      'msg.payload = [query,', `if (ctx.bookingDiscoveryLockClaim) {
  query.$expr = { $lt: ["$$NOW", new Date(ctx.bookingDiscoveryLeaseUntil)] };
}
msg.payload = [query,`),
    '  kind: "LEAVE", targetId: ctx.targetClientId, startedAt:',
    `  kind: "LEAVE", targetId: ctx.targetClientId,
  ...(ctx.bookingDiscoveryLockClaim ? { staffDiscoveryClaim: ctx.bookingDiscoveryLockClaim } : {}),
  startedAt:`),
};

const changed = Object.keys(renderers);
const allowedChanges = changed.map(name => ({
  id: ids[name],
  fields: ['authorize', 'router'].includes(name) ? ['func', 'outputs', 'wires'] : ['func'],
}));

const allowedAdditionIds = [ids.unlockPrepare, ids.unlockUpdate, ids.unlockFinish, ids.unlockCatch];

export function buildCupStaffLeaveCandidate(liveBytes, deploymentId) {
  const graph = JSON.parse(liveBytes);
  if (!Array.isArray(graph)) throw new Error('CUP staff leave requires an array snapshot');
  const nodes = new Map(graph.map(node => [node.id, node]));
  const exact = (id, type) => {
    const node = nodes.get(id);
    if (!node || node.type !== type || node.d || node.disabled) throw new Error(`Unexpected node: ${id}`);
    return node;
  };
  for (const [name, pin] of Object.entries(pins)) {
    const node = exact(ids[name], 'function');
    if (typeof node.func !== 'string' || sha(node.func) !== pin || node.outputs !== node.wires?.length) {
      throw new Error(`CUP staff leave preimage drift: ${ids[name]}`);
    }
  }
  const authorizer = nodes.get(ids.authorize);
  const router = nodes.get(ids.router);
  const route = nodes.get(ids.route);
  const http = exact(ids.http, 'http request');
  const lockUpdate = exact(ids.lockUpdate, 'mongodb4');
  const providerGate = nodes.get(ids.providerGate);
  exact(ids.count, 'function');
  exact(ids.response, 'http response');
  if (!isDeepStrictEqual(authorizer.wires, [[ids.count], [ids.response]])
    || !isDeepStrictEqual(router.wires, [[ids.http], [ids.response], ['cf731009d4167f78'],
      ['lk_split_leave_operation_viva_build_20260801'], [ids.count]])
    || !isDeepStrictEqual(route.wires, [['organizer_handoff_20260913_provider'], ['organizer_handoff_20260913_local'],
      [ids.response], ['lk_split_leave_operation_claim_build_20260801'], ['organizer_handoff_20260913_release']])
    || !isDeepStrictEqual(http.wires, [[ids.router]]) || http.method !== 'use' || http.ret !== 'obj'
    || !isDeepStrictEqual(providerGate.wires, [[ids.lockUpdate], [ids.response], [ids.router]])
    || lockUpdate.operation !== 'updateOne' || lockUpdate.collection !== 'lk_games' || lockUpdate.z !== router.z
    || !exact(lockUpdate.clientNode, 'mongodb4-client')
    || http.url !== '' || router.z !== authorizer.z || router.z !== http.z) {
    throw new Error('CUP staff leave topology drift');
  }
  authorizer.outputs += 1;
  authorizer.wires.push([ids.router]);
  router.outputs += 1;
  router.wires.push([ids.unlockPrepare]);
  const addFunction = (id, name, body, wires, x, y) => {
    const func = `return (${body.toString()})(msg);`;
    new Function('msg', func);
    return { id, name, type: 'function', z: router.z, func, wires, outputs: wires.length, x, y };
  };
  graph.push(
    addFunction(ids.unlockPrepare, 'Release failed CUP booking discovery lock', prepareStaffDiscoveryUnlock,
      [[ids.unlockUpdate], [ids.response]], 1400, 2360),
    { ...structuredClone(lockUpdate), id: ids.unlockUpdate, name: 'Unset exact CUP discovery claim',
      wires: [[ids.unlockFinish]], x: 1680, y: 2360 },
    addFunction(ids.unlockFinish, 'Respond after CUP discovery unlock', finishStaffDiscoveryUnlock, [[ids.response]], 1960, 2360),
    { id: ids.unlockCatch, type: 'catch', z: router.z, name: 'Catch CUP discovery release errors',
      scope: [ids.unlockUpdate], uncaught: false, wires: [[ids.unlockFinish]], x: 1680, y: 2400 },
  );
  for (const name of changed) {
    const node = nodes.get(ids[name]);
    node.func = renderers[name](node.func);
    new Function('msg', 'global', 'flow', 'env', node.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(graph, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges, allowedAdditionIds });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, deploymentId] = process.argv.slice(2);
  if (![input, output].every(value => value && path.isAbsolute(value)) || !deploymentId) {
    throw new Error('Usage: prepare_cup_staff_leave_live_candidate.mjs /absolute/input /absolute/new-private-output deployment-id');
  }
  const parent = path.dirname(output);
  if (path.resolve(output) !== output || fs.realpathSync(parent) !== parent) {
    throw new Error('Use a new canonical private output path');
  }
  const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: parent, encoding: 'utf8' });
  if (git.status !== 128 || !git.stderr.includes('not a git repository')) {
    throw new Error('Raw flow artifacts must stay outside Git');
  }
  const { candidateBytes, contract } = buildCupStaffLeaveCandidate(fs.readFileSync(input), deploymentId);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'candidate.flow.json'), candidateBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(output, 'contract.json'), JSON.stringify(contract, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({
    deploymentId, sourceSha256: contract.sourceSha256, candidateSha256: contract.candidateSha256,
    changedNodes: contract.allowedChanges.length, addedNodes: contract.allowedAdditions.length, liveWrites: 0,
  }));
}
