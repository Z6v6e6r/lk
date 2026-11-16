// Offline only. One complete graph candidate, never an import/deploy/restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildBookingPaymentCancellationNodes, BOOKING_PAYMENT_CANCEL_PATH } from './lib/bookingPaymentCancellationFlow.mjs';
import { bookingPaymentAttemptSource } from './lib/eventPaymentSources.mjs';
import { splitCreateResultFunctionSource } from './lib/splitCreateResultFlow.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const targets = JSON.parse(read('./lib/bookingPaymentAttemptSourceEdits.json'));
const ordinary = read('./lib/splitBookingPaymentAttempt.mjs').replace(/^export /gm, '');
export const splitBookingPaymentAttemptSource = () => bookingPaymentAttemptSource() + 'const __splitBookingPaymentAttempt = (() => {\n'
  + ordinary + '\nreturn {splitAttemptWindow,splitAttemptTransaction,splitAttemptResume,splitAttemptHeadKey,splitAttemptCloseIntent,splitAttemptHeadClosure};\n})();\n';
export const PAYMENT_GRAPH_IDS = Object.freeze({
  router: '8f7bd5b482fe9763', cleanup: 'bcc3dccf8d64f9bb', ack: 'lk_split_cleanup_write_ack_20260826',
  routerFind: 'booking_payment_attempt_router_find_20261116', routerUpdate: 'booking_payment_attempt_router_update_20261116',
  routerGameFind: 'booking_payment_attempt_router_game_find_20261116', routerGameUpdate: 'booking_payment_attempt_router_game_update_20261116',
  cleanupUpdate: 'booking_payment_attempt_cleanup_update_20261116', cleanupFind: 'booking_payment_attempt_cleanup_find_20261116',
  ackFind: 'booking_payment_attempt_ack_find_20261116', ackUpdate: 'booking_payment_attempt_ack_update_20261116',
});
export function patchBookingPaymentFunction(source, target) {
  if (target.reader) {
    if (sha(source) !== target.beforeSha256) throw Error('PAYMENT_READER_PREIMAGE_DRIFT');
    return splitCreateResultFunctionSource();
  }
  let next = source;
  for (const { before, after } of target.edits) {
    if (!before || next.split(before).length !== 2) throw Error('PAYMENT_SOURCE_ANCHOR_DRIFT:' + target.file);
    next = next.replace(before, () => after);
  }
  if (target.id === 'lk_subscription_booking_router_20260804') next = bookingPaymentAttemptSource() + next;
  if (['router', 'cleanup', 'ack'].some(k => PAYMENT_GRAPH_IDS[k] === target.id)) next = splitBookingPaymentAttemptSource() + next;
  new Function('msg', 'node', 'global', 'env', 'flow', next);
  return next;
}
export function composeBookingPaymentLifecycle(liveBytes, expectedSourceSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256 || '') || sha(liveBytes) !== expectedSourceSha256) throw Error('PAYMENT_SOURCE_DRIFT');
  const source = JSON.parse(liveBytes);
  if (!Array.isArray(source) || new Set(source.map(n => n.id)).size !== source.length) throw Error('PAYMENT_GRAPH_INVALID');
  const candidate = structuredClone(source), by = id => candidate.find(n => n.id === id);
  // Never replace an installed canonical confirmation lane with a Mongo lane.
  if (by(PAYMENT_GRAPH_IDS.router)?.outputs !== 5
    || JSON.stringify(by(PAYMENT_GRAPH_IDS.router).wires?.[4]) !== '["legacy_payment_confirm_canonical_prepare_20260816"]'
    || by(PAYMENT_GRAPH_IDS.cleanup)?.outputs !== 6 || by(PAYMENT_GRAPH_IDS.ack)?.outputs !== 4) {
    throw Error('PAYMENT_CANONICAL_GRAPH_PREREQUISITE_REQUIRED');
  }
  for (const target of targets.functions) {
    const node = by(target.id), tab = by(node?.z);
    if (node?.type !== 'function' || node.d || tab?.type !== 'tab' || tab.disabled || tab.d) throw Error('PAYMENT_NODE_INACTIVE:' + target.id);
    node.func = patchBookingPaymentFunction(node.func, target);
  }
  const gateway = by('lk_subscription_booking_router_20260804');
  const template = by('lk_subscription_booking_find_20260804');
  const gameReader = by(by(PAYMENT_GRAPH_IDS.ack).wires?.[0]?.[0]);
  if (template?.type !== 'mongodb4' || template.operation !== 'find'
    || template.collection !== 'lk_subscription_daily_booking_ops' || template.z !== gateway.z
    || JSON.stringify(gateway.wires?.[1]) !== JSON.stringify([template.id])
    || JSON.stringify(template.wires) !== JSON.stringify([[gateway.id]])
    || by(template.clientNode)?.type !== 'mongodb4-client'
    || gameReader?.type !== 'mongodb4' || gameReader.operation !== 'find' || gameReader.collection !== 'lk_games'
    || gameReader.clientNode !== template.clientNode || gameReader.z !== by(PAYMENT_GRAPH_IDS.ack).z
    || JSON.stringify(gameReader.wires) !== JSON.stringify([[PAYMENT_GRAPH_IDS.ack]])) {
    throw Error('PAYMENT_MONGO_TEMPLATE_REQUIRED');
  }
  const added = [];
  function add(key, owner, operation, collection = 'lk_subscription_daily_booking_ops') {
    const id = PAYMENT_GRAPH_IDS[key];
    if (by(id)) throw Error('PAYMENT_ADDITION_COLLISION');
    candidate.push({ ...structuredClone(template), id, z: by(owner).z, name: 'Booking payment ' + key,
      operation, collection, mode: 'collection', output: 'toArray', maxTimeMS: '5000', handleDocId: false,
      wires: [[owner]] }); added.push(id); return [id];
  }
  const r = by(PAYMENT_GRAPH_IDS.router), c = by(PAYMENT_GRAPH_IDS.cleanup), a = by(PAYMENT_GRAPH_IDS.ack);
  r.outputs = 9; r.wires = [...r.wires, add('routerFind', r.id, 'find'), add('routerUpdate', r.id, 'updateOne'),
    add('routerGameFind', r.id, 'find', 'lk_games'), add('routerGameUpdate', r.id, 'updateOne', 'lk_games')];
  c.outputs = 8; c.wires = [...c.wires, add('cleanupUpdate', c.id, 'updateOne'), add('cleanupFind', c.id, 'find')];
  a.outputs = 6; a.wires = [...a.wires, add('ackFind', a.id, 'find'), add('ackUpdate', a.id, 'updateOne')];
  if (candidate.some(n => n.type === 'http in' && n.url === BOOKING_PAYMENT_CANCEL_PATH)) throw Error('PAYMENT_CANCEL_ROUTE_COLLISION');
  const cancelNodes = buildBookingPaymentCancellationNodes(r.z, template.clientNode, '9508f8e0ae8d282a');
  for (const n of cancelNodes) {
    if (by(n.id)) throw Error('PAYMENT_ADDITION_COLLISION');
    if (n.type === 'function') new Function('msg', 'global', 'env', n.func);
    candidate.push(n); added.push(n.id);
  }
  const all = new Set(candidate.map(n => n.id));
  if (candidate.some(n => (n.wires || []).flat().some(id => !all.has(id)))) throw Error('PAYMENT_GRAPH_BROKEN_WIRE');
  const graphIds = [r.id, c.id, a.id];
  const allowedChanges = targets.functions.map(t => ({ id: t.id,
    fields: graphIds.includes(t.id) ? ['func', 'outputs', 'wires'] : ['func'] }));
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'booking-payment-lifecycle-15m',
    allowedChanges, allowedAdditionIds: added });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, sourceSha256: expectedSourceSha256, candidateSha256: sha(candidateBytes) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [workspace, output] = process.argv.slice(2);
  const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
  const verified = verifyWorkspace(workspace, { quiet: true });
  const root = fs.realpathSync(new URL('..', import.meta.url));
  if (!path.isAbsolute(output || '') || path.resolve(output) !== output || fs.existsSync(output)
    || output === root || output.startsWith(root + path.sep)
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw Error('NEW_PRIVATE_EXTERNAL_OUTPUT_REQUIRED');
  const bytes = fs.readFileSync(verified.sourcePath);
  const result = composeBookingPaymentLifecycle(bytes, sha(bytes));
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of [['candidate.json', result.candidateBytes], ['contract.json', JSON.stringify(result.contract, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ sourceSha256: result.sourceSha256, candidateSha256: result.candidateSha256, liveMutations: 0 }));
}
