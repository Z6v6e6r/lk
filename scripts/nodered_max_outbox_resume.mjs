import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Reviewed topology identifiers, not credentials or live source fingerprints.
export const MAX_OUTBOX_RESUME_TOPOLOGY = freeze([
  {
    connector: 'MAX_ACADEMY_BOT', tab: '99db28109ee6a1f7', bot: '55b05444842e7b84',
    sender: 'f64e5818bc8d7aa6', receiver: '4d7bfc1669c89afe', callback: 'abc7e416e271a301',
    poller: 'e75785ffa19c2e20', pull: '41be3d2c95b57295', http: 'b9dd8b1790758ae5',
    parse: 'ac58fde64d1af67e', split: '79607434c44c17f0', dispatch: '47c460de0db646e6',
    error: '468f0a7f6af3a67e', sendDebug: '9e31a7acad8d3b66', ack: 'f5f06035c95580a3',
    newSender: 'max_new_outbox_send_academy', newName: 'MAX new outbox only — academy',
  },
  {
    connector: 'MAX_BOT', tab: '913584cf84dbb460', bot: 'a5d5eca27e9e56da',
    sender: '466e8a3ac76c2fab', receiver: '65da992052644659', callback: '1169bfa43d18d9f2',
    poller: 'c1ecd06ce451751b', pull: '2e547e998eee631f', http: 'a429c13e79757eb9',
    parse: '7a92c5952f18e9c0', split: '3a6e121589c02e6d', dispatch: '0006d5707259bc5b',
    error: '2dd54a2db1b24366', sendDebug: '7fc39f31e272c82d', ack: '5e2be8655a5d3ebc',
    newSender: 'max_new_outbox_send_main', newName: 'MAX new outbox only — main',
  },
]);

const roles = {
  tab: 'tab', bot: 'maxbot-config', sender: 'maxbot-send', receiver: 'maxbot-receive',
  callback: 'function', poller: 'inject', pull: 'function', http: 'http request',
  parse: 'function', split: 'split', dispatch: 'function', error: 'debug',
  sendDebug: 'debug', ack: 'function',
};
export const MAX_OUTBOX_RESUME_REQUIRED_IDS = Object.freeze(
  MAX_OUTBOX_RESUME_TOPOLOGY.flatMap((route) => Object.keys(roles).map((role) => route[role])),
);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const nodeSha256 = (node) => sha256(JSON.stringify(node));
const reject = (code) => { throw new Error(code); };
const requireThat = (value, code) => { if (!value) reject(code); };
const same = (a, b) => isDeepStrictEqual(a, b);
const active = (node) => node.d === undefined || node.d === false;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Pure preparation only. Trusted fingerprints must come from an independent review. */
export function buildMaxOutboxOnlyResume(flow, trustedPins) {
  const source = typeof flow === 'string' || Buffer.isBuffer(flow)
    ? flow : Array.isArray(flow) ? JSON.stringify(flow) : reject('INVALID_FLOW_INPUT');
  requireThat(digest(trustedPins?.flowSha256), 'INVALID_FLOW_PIN');
  requireThat(sha256(source) === trustedPins.flowSha256, 'FLOW_PREIMAGE_MISMATCH');
  const nodes = JSON.parse(source.toString());
  requireThat(Array.isArray(nodes), 'INVALID_FLOW_ARRAY');
  const by = new Map();
  for (const node of nodes) {
    requireThat(node && typeof node === 'object' && !Array.isArray(node)
      && typeof node.id === 'string' && node.id.length > 0, 'INVALID_NODE_ID');
    requireThat(!by.has(node.id), 'DUPLICATE_NODE_ID');
    by.set(node.id, node);
  }
  requireThat(trustedPins.nodeSha256 && same(Object.keys(trustedPins.nodeSha256).sort(),
    [...MAX_OUTBOX_RESUME_REQUIRED_IDS].sort()), 'INVALID_NODE_PIN_SET');
  for (const id of MAX_OUTBOX_RESUME_REQUIRED_IDS) {
    requireThat(by.has(id), 'MISSING_REQUIRED_NODE');
    requireThat(digest(trustedPins.nodeSha256[id])
      && nodeSha256(by.get(id)) === trustedPins.nodeSha256[id], 'NODE_PREIMAGE_MISMATCH');
  }
  const allowedMax = new Set(MAX_OUTBOX_RESUME_TOPOLOGY.flatMap((r) => [r.sender, r.receiver]));
  for (const node of nodes) {
    requireThat(!(typeof node.type === 'string' && node.type.startsWith('max')
      && /send|receiv/.test(node.type)) || allowedMax.has(node.id),
      'UNRECOGNIZED_MAX_NODE');
  }
  for (const route of MAX_OUTBOX_RESUME_TOPOLOGY) {
    requireThat(!by.has(route.newSender), 'NEW_SENDER_ID_OCCUPIED');
    requireThat(!nodes.some(node => (node.wires ?? []).flat().includes(route.newSender)
      || (node.links ?? []).includes(route.newSender)), 'NEW_SENDER_ALREADY_REFERENCED');
    for (const [role, type] of Object.entries(roles)) {
      const node = by.get(route[role]);
      requireThat(node.type === type, 'NODE_TYPE_MISMATCH');
      if (role !== 'bot' && role !== 'tab') requireThat(node.z === route.tab, 'NODE_TAB_MISMATCH');
    }
    const get = (role) => by.get(route[role]);
    requireThat(get('tab').disabled !== true && active(get('tab')), 'TAB_DISABLED');
    requireThat(get('sender').bot === route.bot && get('receiver').bot === route.bot,
      'WRONG_BOT_CONNECTOR');
    for (const role of ['sender', 'receiver', 'callback', 'poller']) {
      requireThat(get(role).d === true, 'EXPECTED_NODE_DISABLED');
    }
    for (const role of ['pull', 'http', 'parse', 'split', 'dispatch', 'ack', 'bot']) {
      requireThat(active(get(role)), 'OUTBOX_PATH_DISABLED');
    }
    const pullFunction = get('pull').func;
    requireThat(typeof pullFunction === 'string'
      && pullFunction.includes(`/support/outbox/pull?connector=${route.connector}&`)
      && !MAX_OUTBOX_RESUME_TOPOLOGY.some((other) => other !== route
        && pullFunction.includes(`connector=${other.connector}&`)), 'WRONG_PULL_CONNECTOR');
    requireThat(same(get('poller').wires, [[route.pull]])
      && same(get('pull').wires, [[route.http]])
      && get('http').wires?.[0]?.[0] === route.parse
      && same(get('parse').wires?.[0], [route.split])
      && same(get('split').wires, [[route.dispatch]])
      && get('dispatch').outputs === 2
      && same(get('dispatch').wires, [[route.sender], [route.error]])
      && same(get('sender').wires, [[route.sendDebug, route.ack]]), 'OUTBOX_WIRING_MISMATCH');
  }

  // Parsing created fresh objects: no caller-owned array, node, wire or pin is changed.
  const changedIds = [];
  const addedIds = [];
  for (const route of MAX_OUTBOX_RESUME_TOPOLOGY) {
    by.get(route.poller).d = false;
    by.get(route.dispatch).wires[0] = [route.newSender];
    nodes.push({ ...structuredClone(by.get(route.sender)), id: route.newSender,
      name: route.newName, d: false });
    changedIds.push(route.poller, route.dispatch);
    addedIds.push(route.newSender);
  }
  const candidateJson = `${JSON.stringify(nodes, null, 2)}\n`;
  return {
    flow: nodes, candidateJson, sourceSha256: trustedPins.flowSha256,
    candidateSha256: sha256(candidateJson), changedIds, addedIds,
  };
}
