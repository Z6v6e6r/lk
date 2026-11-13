import { isDeepStrictEqual } from 'node:util';
import { prepareDurableQueue, MAX_DURABLE_QUEUE_REQUIRED_IDS } from './prepare_max_durable_queue.mjs';
import { MAX_OUTBOX_RESUME_TOPOLOGY as routes, sha256, nodeSha256 } from './nodered_max_outbox_resume.mjs';
const need = (ok, code) => { if (!ok) throw Error(code); };
const encoded = flow => JSON.stringify(flow, null, 2) + '\n';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const MAX_DURABLE_FIELDS = Object.freeze(routes.flatMap(r => [
  { id: r.poller, fields: ['d', 'once', 'repeat'] }, { id: r.dispatch, fields: ['func', 'wires'] },
  { id: r.pull, fields: ['func'] }, { id: r.newSender, fields: ['d'] }
]));
export const MAX_DURABLE_ADDITIONS = Object.freeze(routes.flatMap(r => {
  const suffix = r.connector === 'MAX_BOT' ? 'main' : 'academy';
  return ['max_outbox_fenced_send_' + suffix, 'max_outbox_durable_receipt_' + suffix];
}));
const pinsFor = (raw, flow) => ({ flowSha256: sha256(raw), nodeSha256: Object.fromEntries(
  MAX_DURABLE_QUEUE_REQUIRED_IDS.map(id => [id, nodeSha256(flow.find(n => n.id === id))])) });
function pinned(raw, pins) {
  need((typeof raw === 'string' || Buffer.isBuffer(raw)) && pins?.flowSha256 === sha256(raw), 'MAXD_SOURCE_PIN');
  const flow = JSON.parse(raw.toString());
  need(Array.isArray(flow) && flow.every(n => n && typeof n.id === 'string')
    && new Set(flow.map(n => n.id)).size === flow.length, 'MAXD_SOURCE_IDS');
  need(isDeepStrictEqual(pinsFor(raw, flow), pins), 'MAXD_NODE_PINS');
  return flow;
}
export function buildMaxDurableTransition(raw, pins, purpose) {
  need(['pause', 'activate'].includes(purpose), 'MAXD_PURPOSE');
  const flow = pinned(raw, pins), by = new Map(flow.map(n => [n.id, n]));
  let built;
  if (purpose === 'pause') {
    prepareDurableQueue(raw, pins); // Complete closed legacy topology/source validation first.
    for (const r of routes) by.get(r.poller).d = true;
    built = { flow, changedIds: routes.map(r => r.poller), addedIds: [] };
  } else {
    need(routes.every(r => by.get(r.poller)?.d === true), 'MAXD_PAUSED_SOURCE_REQUIRED');
    const active = structuredClone(flow), activeBy = new Map(active.map(n => [n.id, n]));
    for (const r of routes) activeBy.get(r.poller).d = false;
    const normalized = encoded(active);
    // Only the independently pinned two disabled flags are normalized for the
    // already closed builder. No source function/bot/channel guard is relaxed.
    built = prepareDurableQueue(normalized, pinsFor(normalized, active));
    for (const r of routes) built.flow.find(n => n.id === r.poller).d = false;
  }
  return { ...built, sourceSha256: sha256(raw), candidateJson: encoded(built.flow), purpose,
    liveFlowWritten: false, archiveMutation: false };
}
export function buildMaxDurableRecovery(current, original, pins) {
  const forward = buildMaxDurableTransition(original, pins, 'activate');
  const raw = typeof current === 'string' || Buffer.isBuffer(current) ? current : JSON.stringify(current);
  need(isDeepStrictEqual(canonical(JSON.parse(raw.toString())), canonical(forward.flow)), 'MAXD_RECOVERY_SOURCE_DRIFT');
  const flow = JSON.parse(original.toString());
  need(routes.every(r => flow.find(n => n.id === r.poller)?.d === true), 'MAXD_RECOVERY_MUST_STAY_PAUSED');
  const candidateJson = encoded(flow);
  return { flow, candidateJson, changedIds: forward.changedIds, removedIds: forward.addedIds,
    originalSourceSha256: sha256(original), sourceSha256: sha256(raw), candidateSha256: sha256(candidateJson) };
}
export function durableRecoveryContract(current, original, pins) {
  const r = buildMaxDurableRecovery(current, original, pins);
  return { kind: 'max-durable-paused-recovery-v1', sourceSha256: r.sourceSha256,
    originalSourceSha256: r.originalSourceSha256, candidateSha256: r.candidateSha256,
    changedIds: r.changedIds, removedIds: r.removedIds };
}
export function durableOperations(before, after, purpose) {
  need(['pause', 'activate', 'recover'].includes(purpose), 'MAXD_PURPOSE');
  const by = new Map(before.map(n => [n.id, n])), post = new Map(after.map(n => [n.id, n]));
  need(by.size === before.length && post.size === after.length, 'MAXD_OPERATION_IDS');
  const scope = purpose === 'pause' ? routes.map(r => ({ id: r.poller, fields: ['d'] })) : MAX_DURABLE_FIELDS;
  const edits = [];
  for (const [id, node] of by) {
    if (!post.has(id)) { need(purpose === 'recover' && MAX_DURABLE_ADDITIONS.includes(id), 'MAXD_REMOVAL_SCOPE'); continue; }
    const target = post.get(id), keys = [...new Set([...Object.keys(node), ...Object.keys(target)])]
      .filter(k => !isDeepStrictEqual(node[k], target[k])).sort();
    if (!keys.length) continue;
    const allowed = scope.find(s => s.id === id);
    need(allowed && keys.every(k => allowed.fields.includes(k)), 'MAXD_EDIT_SCOPE');
    edits.push({ id, set: Object.fromEntries(keys.filter(k => Object.hasOwn(target, k)).map(k => [k, target[k]])),
      unset: keys.filter(k => !Object.hasOwn(target, k)) });
  }
  const additions = after.filter(n => !by.has(n.id)), removals = before.filter(n => !post.has(n.id)).map(n => n.id);
  need(edits.length === (purpose === 'pause' ? 2 : 8)
    && isDeepStrictEqual(edits.map(e => e.id).sort(), scope.map(s => s.id).sort()), 'MAXD_EDIT_SET');
  need(isDeepStrictEqual(additions.map(n => n.id).sort(), purpose === 'activate' ? [...MAX_DURABLE_ADDITIONS].sort() : [])
    && isDeepStrictEqual(removals.sort(), purpose === 'recover' ? [...MAX_DURABLE_ADDITIONS].sort() : []), 'MAXD_ADDITION_SET');
  return { purpose, edits, additions: structuredClone(additions), removals };
}
