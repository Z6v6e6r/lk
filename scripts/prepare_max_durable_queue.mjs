import { isDeepStrictEqual } from 'node:util';
import { preparePatch } from './prepare_max_outbox_receipts.mjs';
import { MAX_OUTBOX_RESUME_REQUIRED_IDS, MAX_OUTBOX_RESUME_TOPOLOGY, sha256, nodeSha256 } from './nodered_max_outbox_resume.mjs';
export const MAX_DURABLE_QUEUE_REQUIRED_IDS = Object.freeze([...MAX_OUTBOX_RESUME_REQUIRED_IDS,
  ...MAX_OUTBOX_RESUME_TOPOLOGY.map(r => r.newSender)]);
const need = (ok, code) => { if (!ok) throw Error(code); };
/** Offline builder only. Exact independently reviewed whole-flow/node pins; no API, file writes or activation. */
export function prepareDurableQueue(raw, pins) {
  need(typeof raw === 'string' || Buffer.isBuffer(raw), 'RAW_FLOW_REQUIRED');
  need(pins?.flowSha256 === sha256(raw), 'FLOW_PIN_MISMATCH');
  const flow = JSON.parse(raw.toString()), ids = new Set();
  need(Array.isArray(flow), 'FLOW_ARRAY_REQUIRED');
  for (const n of flow) { need(n && typeof n.id === 'string' && !ids.has(n.id), 'FLOW_IDS_INVALID'); ids.add(n.id); }
  const by = new Map(flow.map(n => [n.id, n]));
  need(Object.keys(pins.nodeSha256 ?? {}).sort().join(',') === [...MAX_DURABLE_QUEUE_REQUIRED_IDS].sort().join(','), 'NODE_PIN_SET_MISMATCH');
  for (const id of MAX_DURABLE_QUEUE_REQUIRED_IDS) need(by.has(id) && nodeSha256(by.get(id)) === pins.nodeSha256[id], 'NODE_PIN_MISMATCH');
  const sendIds = new Set(MAX_OUTBOX_RESUME_TOPOLOGY.flatMap(r => [r.sender, r.newSender]));
  const receiveIds = new Set(MAX_OUTBOX_RESUME_TOPOLOGY.map(r => r.receiver));
  need(flow.every(n => n.type !== 'maxbot-send' || sendIds.has(n.id))
    && flow.every(n => n.type !== 'maxbot-receive' || receiveIds.has(n.id))
    && !flow.some(n => ['max-outbox-send', 'max-outbox-receipt'].includes(n.type)), 'FOREIGN_MAX_NODE');
  const normalized = structuredClone(flow), validationBy = new Map(normalized.map(n => [n.id, n]));
  for (const r of MAX_OUTBOX_RESUME_TOPOLOGY) {
    const sender = by.get(r.sender), dedicated = by.get(r.newSender), poller = by.get(r.poller), dispatch = by.get(r.dispatch);
    need(sender.d === true && by.get(r.receiver).d === true && by.get(r.callback).d === true, 'LEGACY_BRANCH_ENABLED');
    need(isDeepStrictEqual(dedicated, { ...sender, id: r.newSender, name: r.newName, d: false })
      && dedicated.bot === r.bot && dedicated.z === r.tab && poller.type === 'inject' && poller.d === false
      && dispatch.wires?.[0]?.length === 1 && dispatch.wires[0][0] === r.newSender, 'DEDICATED_TOPOLOGY_MISMATCH');
    validationBy.get(r.dispatch).wires[0] = [r.sender];
  }
  // Reuse the closed, channel-specific pull/function preimage validation. Never relax it to arbitrary wiring.
  const legacyPatch = preparePatch(normalized), patchBy = new Map(legacyPatch.map(n => [n.id, n]));
  const additions = [], changed = new Map();
  for (const r of MAX_OUTBOX_RESUME_TOPOLOGY) {
    const suffix = r.connector === 'MAX_BOT' ? 'main' : 'academy';
    const sendId = 'max_outbox_fenced_send_' + suffix, receiptId = 'max_outbox_durable_receipt_' + suffix;
    need(!ids.has(receiptId) && !flow.some(n => JSON.stringify(n.wires ?? []).includes(receiptId)
      || JSON.stringify(n.links ?? []).includes(receiptId)), 'RECEIPT_ID_COLLISION');
    const dispatch = patchBy.get(r.dispatch), pull = patchBy.get(r.pull), send = patchBy.get(sendId);
    need(pull.func.includes('limit=10&leaseSec=60'), 'PULL_TEMPLATE_DRIFT');
    changed.set(r.dispatch, dispatch); changed.set(r.pull, { ...pull,
      func: pull.func.replace('limit=10&leaseSec=60', 'limit=1&leaseSec=120') });
    changed.set(r.poller, { ...by.get(r.poller), repeat: '0.5', once: false });
    changed.set(r.newSender, { ...by.get(r.newSender), d: true });
    additions.push({ ...send, d: false, wires: [[receiptId]] }, { id: receiptId, type: 'max-outbox-receipt',
      z: r.tab, name: 'Persist MAX receipt with bounded retry', x: send.x + 200, y: send.y, d: false, wires: [[]] });
  }
  const newIds = new Set(additions.map(n => n.id));
  for (const n of flow) for (const field of ['wires', 'links', 'scope']) {
    const refs = JSON.stringify(n[field] ?? []);
    need(![...newIds].some(id => refs.includes(id)), 'NEW_ID_ALREADY_REFERENCED');
  }
  const candidate = flow.map(n => changed.get(n.id) ?? structuredClone(n)).concat(additions);
  return { flow: candidate, candidateJson: JSON.stringify(candidate, null, 2) + '\n',
    sourceSha256: sha256(raw), changedIds: [...changed.keys()], addedIds: additions.map(n => n.id),
    activated: false, archiveMutation: false };
}
