import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaxOutboxOnlyResume, MAX_OUTBOX_RESUME_TOPOLOGY as routes,
  MAX_OUTBOX_RESUME_REQUIRED_IDS, nodeSha256, sha256,
} from '../nodered_max_outbox_resume.mjs';

const bytes = (flow) => `${JSON.stringify(flow, null, 2)}\n`;
const byId = (flow, id) => flow.find((node) => node.id === id);
const pins = (flow, source = bytes(flow)) => ({
  flowSha256: sha256(source),
  nodeSha256: Object.fromEntries(MAX_OUTBOX_RESUME_REQUIRED_IDS
    .filter((id) => byId(flow, id)).map((id) => [id, nodeSha256(byId(flow, id))])),
});
const fixture = () => {
  const flow = [];
  for (const r of routes) {
    const add = (id, type, fields = {}) => flow.push({ id, type, z: r.tab, wires: [], ...fields });
    add(r.tab, 'tab', { disabled: false });
    add(r.bot, 'maxbot-config', { name: 'Synthetic bot config', fixtureOpaqueSetting: 'preserve' });
    add(r.sender, 'maxbot-send', { bot: r.bot, d: true, defaultChatId: '',
      x: 100, y: 200, wires: [[r.sendDebug, r.ack]] });
    add(r.receiver, 'maxbot-receive', { bot: r.bot, d: true, wires: [['direct-response']] });
    add(r.callback, 'function', { d: true, func: 'return msg;', wires: [['callback-http']] });
    add(r.poller, 'inject', { d: true, once: true, repeat: '5', wires: [[r.pull]] });
    add(r.pull, 'function', {
      func: `msg.url = base + "/support/outbox/pull?connector=${r.connector}&limit=10"; return msg;`,
      wires: [[r.http]],
    });
    add(r.http, 'http request', { wires: [[r.parse]] });
    add(r.parse, 'function', { func: 'return [msg, null];', wires: [[r.split], [r.error]] });
    add(r.split, 'split', { wires: [[r.dispatch]] });
    add(r.dispatch, 'function', { func: 'return [msg, null];', outputs: 2,
      wires: [[r.sender], [r.error]] });
    add(r.error, 'debug');
    add(r.sendDebug, 'debug');
    add(r.ack, 'function', { func: 'return msg;', wires: [['ack-http']] });
    add(`direct-${r.connector}`, 'function', { func: 'return msg;', wires: [[r.sender]] });
  }
  return flow;
};
const freeze = (obj) => {
  Object.values(obj).forEach((v) => { if (v && typeof v === 'object') freeze(v); });
  return Object.freeze(obj);
};

test('prepares exactly four existing edits and two isolated sender clones', () => {
  const source = fixture();
  const before = structuredClone(source);
  const result = buildMaxOutboxOnlyResume(bytes(source), pins(source));
  assert.deepEqual(source, before);
  assert.equal(result.flow.length, source.length + 2);
  assert.equal(result.sourceSha256, sha256(bytes(source)));
  assert.equal(result.candidateSha256, sha256(result.candidateJson));
  assert.deepEqual(JSON.parse(result.candidateJson), result.flow);
  const edited = source.filter((n) => !assertEqualNode(n, byId(result.flow, n.id))).map((n) => n.id);
  assert.deepEqual(edited.sort(), routes.flatMap((r) => [r.poller, r.dispatch]).sort());
  assert.deepEqual(result.changedIds.sort(), edited.sort());
  assert.deepEqual(result.addedIds, routes.map((r) => r.newSender));
  for (const r of routes) {
    assert.deepEqual(byId(result.flow, r.newSender), {
      ...byId(source, r.sender), id: r.newSender, name: r.newName, d: false,
    });
    assert.deepEqual(byId(result.flow, r.poller), { ...byId(source, r.poller), d: false });
    assert.deepEqual(byId(result.flow, r.dispatch), {
      ...byId(source, r.dispatch), wires: [[r.newSender], [r.error]],
    });
    for (const role of ['sender', 'receiver', 'callback']) {
      assert.equal(byId(result.flow, r[role]).d, true);
    }
    assert.deepEqual(byId(result.flow, `direct-${r.connector}`).wires, [[r.sender]]);
    const incoming = result.flow.filter((n) => n.wires?.flat().includes(r.newSender));
    assert.deepEqual(incoming.map((n) => n.id), [r.dispatch]);
  }
  for (const n of source.filter((n) => Object.hasOwn(n, 'func'))) {
    assert.equal(byId(result.flow, n.id).func, n.func);
  }
});
function assertEqualNode(a, b) {
  try { assert.deepEqual(a, b); return true; } catch { return false; }
}

test('accepts exact Buffer bytes and frozen array input without mutation', () => {
  const flow = freeze(fixture());
  const trusted = freeze(pins(flow, JSON.stringify(flow)));
  const result = buildMaxOutboxOnlyResume(flow, trusted);
  assert.deepEqual(result.flow, buildMaxOutboxOnlyResume(Buffer.from(JSON.stringify(flow)), trusted).flow);
  result.flow[0].name = 'caller edits candidate';
  assert.equal(flow[0].name, undefined);
});

test('whole-flow byte pin rejects whitespace and unrelated source changes', () => {
  const flow = fixture(); const trusted = pins(flow);
  assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow) + ' ', trusted), /FLOW_PREIMAGE_MISMATCH/);
  flow[flow.length - 1].name = 'foreign edit';
  assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), trusted), /FLOW_PREIMAGE_MISMATCH/);
});

test('node pin rejects config and wire drift even with refreshed whole-flow pin', () => {
  for (const mutate of [
    (f) => { byId(f, routes[0].sender).defaultChatId = 'wrong-target'; },
    (f) => { byId(f, routes[0].dispatch).wires[1] = ['foreign-error']; },
  ]) {
    const flow = fixture(); const trusted = pins(flow); mutate(flow);
    trusted.flowSha256 = sha256(bytes(flow));
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), trusted), /NODE_PREIMAGE_MISMATCH/);
  }
});

test('rejects missing required node and missing or extra node pins', () => {
  const flow = fixture(); const trusted = pins(flow);
  const missing = flow.filter((n) => n.id !== routes[0].callback);
  assert.throws(() => buildMaxOutboxOnlyResume(bytes(missing), {
    ...trusted, flowSha256: sha256(bytes(missing)),
  }), /MISSING_REQUIRED_NODE/);
  delete trusted.nodeSha256[routes[0].callback];
  assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), trusted), /INVALID_NODE_PIN_SET/);
  trusted.nodeSha256.foreign = '0'.repeat(64);
  assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), trusted), /INVALID_NODE_PIN_SET/);
});

test('rejects duplicate IDs and invalid node IDs before patching', () => {
  for (const extra of [fixture()[0], { type: 'debug' }]) {
    const flow = fixture(); flow.push(extra);
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), /DUPLICATE_NODE_ID|INVALID_NODE_ID/);
  }
});

test('rejects any extra MAX sender or receiver, including disabled controlled senders', () => {
  for (const type of ['maxbot-send', 'maxbot-receive', 'max-outbox-send']) {
    const flow = fixture(); flow.push({ id: 'unknown-max', type, d: true });
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), /UNRECOGNIZED_MAX_NODE/);
  }
});

test('rejects preoccupied dedicated sender IDs', () => {
  for (const r of routes) {
    const flow = fixture(); flow.push({ id: r.newSender, type: 'debug' });
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), /NEW_SENDER_ID_OCCUPIED/);
  }
});

test('semantic guards reject wrong bot or swapped connector even if freshly fingerprinted', () => {
  for (const mutate of [
    (f) => { byId(f, routes[0].sender).bot = routes[1].bot; },
    (f) => { byId(f, routes[0].receiver).bot = routes[1].bot; },
    (f) => { byId(f, routes[0].pull).func = byId(f, routes[1].pull).func; },
  ]) {
    const flow = fixture(); mutate(flow);
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), /WRONG_BOT_CONNECTOR|WRONG_PULL_CONNECTOR/);
  }
});

test('semantic guards reject type, tab, disabled-state and routing drift', () => {
  const cases = [
    [(f) => { byId(f, routes[0].poller).type = 'function'; }, /NODE_TYPE_MISMATCH/],
    [(f) => { byId(f, routes[0].dispatch).z = routes[1].tab; }, /NODE_TAB_MISMATCH/],
    [(f) => { byId(f, routes[0].sender).d = false; }, /EXPECTED_NODE_DISABLED/],
    [(f) => { byId(f, routes[0].receiver).d = false; }, /EXPECTED_NODE_DISABLED/],
    [(f) => { byId(f, routes[0].callback).d = false; }, /EXPECTED_NODE_DISABLED/],
    [(f) => { byId(f, routes[0].poller).d = false; }, /EXPECTED_NODE_DISABLED/],
    [(f) => { byId(f, routes[0].tab).disabled = true; }, /TAB_DISABLED/],
    [(f) => { byId(f, routes[0].ack).d = true; }, /OUTBOX_PATH_DISABLED/],
    [(f) => { byId(f, routes[0].dispatch).wires[0].push('direct-recipient'); }, /OUTBOX_WIRING_MISMATCH/],
    [(f) => { byId(f, routes[0].sender).wires = [[routes[1].ack]]; }, /OUTBOX_WIRING_MISMATCH/],
  ];
  for (const [mutate, error] of cases) {
    const flow = fixture(); mutate(flow);
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), error);
  }
});

test('failed preparation leaves caller inputs and pins unchanged', () => {
  const flow = fixture(); byId(flow, routes[0].callback).d = false;
  const trusted = pins(flow, JSON.stringify(flow)); const before = structuredClone({ flow, trusted });
  assert.throws(() => buildMaxOutboxOnlyResume(freeze(flow), freeze(trusted)), /EXPECTED_NODE_DISABLED/);
  assert.deepEqual({ flow, trusted }, before);
});

test('rejects rerunning against the prepared candidate', () => {
  const flow = fixture(); const candidate = buildMaxOutboxOnlyResume(bytes(flow), pins(flow));
  assert.throws(() => buildMaxOutboxOnlyResume(candidate.candidateJson, pins(candidate.flow, candidate.candidateJson)),
    /UNRECOGNIZED_MAX_NODE/);
});


test('rejects existing dangling routes that would become live when a dedicated sender is added', () => {
  for (const field of ['wires', 'links']) {
    const flow = fixture();
    flow.push({ id: 'synthetic-dangling-route', type: 'function', z: routes[0].tab,
      [field]: field === 'wires' ? [[routes[0].newSender]] : [routes[0].newSender] });
    assert.throws(() => buildMaxOutboxOnlyResume(bytes(flow), pins(flow)), /NEW_SENDER_ALREADY_REFERENCED/);
  }
});
