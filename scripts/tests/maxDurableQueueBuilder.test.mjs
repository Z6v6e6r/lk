import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { prepareDurableQueue, MAX_DURABLE_QUEUE_REQUIRED_IDS } from '../prepare_max_durable_queue.mjs';
import { MAX_OUTBOX_RESUME_TOPOLOGY as routes, sha256, nodeSha256 } from '../nodered_max_outbox_resume.mjs';
const fixture = () => routes.flatMap(r => {
  const n = (id, type, fields = {}) => ({ id, type, z: r.tab, wires: [], ...fields });
  const sender = n(r.sender, 'maxbot-send', { name: 'Shared sender', bot: r.bot, d: true, x: 100, y: 100,
    wires: [[r.sendDebug, r.ack]], opaque: 'preserved' });
  return [n(r.tab, 'tab'), n(r.bot, 'maxbot-config'), sender, { ...sender, id: r.newSender, name: r.newName, d: false },
    n(r.receiver, 'maxbot-receive', { bot: r.bot, d: true }), n(r.callback, 'function', { d: true }),
    n(r.poller, 'inject', { d: false, once: false, repeat: '5', wires: [[r.pull]] }),
    n(r.pull, 'function', { func: fs.readFileSync('scripts/tests/fixtures/max-outbox/pull-before.function.txt', 'utf8')
      .replace('connector=MAX_BOT', 'connector=' + r.connector), wires: [[r.http]] }),
    n(r.http, 'http request', { wires: [[r.parse]] }), n(r.parse, 'function', { wires: [[r.split], [r.error]] }),
    n(r.split, 'split', { wires: [[r.dispatch]] }), n(r.dispatch, 'function', {
      func: fs.readFileSync('scripts/tests/fixtures/max-outbox/dispatch-before.function.txt', 'utf8'),
      outputs: 2, wires: [[r.newSender], [r.error]] }), n(r.error, 'debug'), n(r.sendDebug, 'debug'), n(r.ack, 'function')];
});
const bytes = f => JSON.stringify(f, null, 2) + '\n';
const pins = f => ({ flowSha256: sha256(bytes(f)), nodeSha256: Object.fromEntries(MAX_DURABLE_QUEUE_REQUIRED_IDS.map(id => [id, nodeSha256(f.find(n => n.id === id))])) });
const prepare = f => prepareDurableQueue(Buffer.from(bytes(f)), pins(f));
test('current4+2 becomes exact8edited+4added durable chains without changing source/configs/legacy branches', () => {
  const flow = fixture(), saved = structuredClone(flow), result = prepare(flow);
  assert.deepEqual(flow, saved); assert.equal(result.changedIds.length, 8); assert.equal(result.addedIds.length, 4);
  assert.equal(result.flow.length, flow.length + 4); assert.equal(result.activated, false); assert.equal(result.archiveMutation, false);
  for (const n of flow) if (!result.changedIds.includes(n.id)) assert.deepEqual(result.flow.find(x => x.id === n.id), n);
  for (const r of routes) {
    const get = id => result.flow.find(n => n.id === id);
    assert.equal(get(r.newSender).d, true); assert.equal(get(r.sender).d, true); assert.equal(get(r.receiver).d, true);
    assert.equal(get(r.poller).repeat, '0.5'); assert.equal(get(r.poller).once, false);
    const pull = new Function('msg', 'env', get(r.pull).func)({}, { get: () => null });
    assert.equal(new URL(pull.url).searchParams.get('connector'), r.connector);
    assert.equal(new URL(pull.url).searchParams.get('limit'), '1'); assert.equal(new URL(pull.url).searchParams.get('leaseSec'), '120');
    const sender = get(get(r.dispatch).wires[0][0]), receipt = get(sender.wires[0][0]);
    assert.equal(sender.type, 'max-outbox-send'); assert.equal(sender.bot, r.bot); assert.equal(receipt.type, 'max-outbox-receipt');
    assert.equal(sender.d, false); assert.equal(receipt.d, false);
  }
});
test('bad raw/node pins, duplicate IDs and nonraw input fail closed', () => {
  const f = fixture(), p = pins(f);
  assert.throws(() => prepareDurableQueue(bytes(f) + ' ', p), /FLOW_PIN/);
  assert.throws(() => prepareDurableQueue(bytes(f), { ...p, nodeSha256: { ...p.nodeSha256, [routes[0].pull]: '0'.repeat(64) } }), /NODE_PIN/);
  assert.throws(() => prepareDurableQueue(bytes(f), { ...p, nodeSha256: {} }), /NODE_PIN_SET/);
  assert.throws(() => prepareDurableQueue(f, p), /RAW_FLOW/);
  const dup = [...f, f[0]]; assert.throws(() => prepareDurableQueue(bytes(dup), { ...p, flowSha256: sha256(bytes(dup)) }), /FLOW_IDS/);
});
test('approved pins do not bypass unsafe old branches, dedicated drift or channel swaps', () => {
  for (const mutate of [
    f => { f.find(n => n.id === routes[0].receiver).d = false; },
    f => { f.find(n => n.id === routes[0].sender).d = false; },
    f => { f.find(n => n.id === routes[0].callback).d = false; },
    f => { f.find(n => n.id === routes[0].newSender).bot = routes[1].bot; },
    f => { f.find(n => n.id === routes[0].newSender).opaque = 'changed'; },
    f => { f.find(n => n.id === routes[0].dispatch).wires[0].push('foreign'); },
    f => { f.find(n => n.id === routes[0].pull).func = f.find(n => n.id === routes[1].pull).func; }
  ]) { const f = fixture(); mutate(f); assert.throws(() => prepare(f)); }
});
test('occupied IDs, dangling future wires/links/scope and extra sender types cannot revive hidden routes', () => {
  const result = prepare(fixture());
  for (const id of result.addedIds) for (const field of ['wires', 'links', 'scope']) {
    const f = fixture(); f.push({ id: 'foreign', type: 'function', [field]: field === 'wires' ? [[id]] : [id] });
    assert.throws(() => prepare(f), /COLLISION|REFERENCED/);
  }
  const occupied = fixture(); occupied.push({ id: result.addedIds[0], type: 'debug' }); assert.throws(() => prepare(occupied));
  for (const type of ['maxbot-send', 'maxbot-receive', 'max-outbox-send', 'max-outbox-receipt']) {
    const f = fixture(); f.push({ id: 'foreign', type }); assert.throws(() => prepare(f), /FOREIGN_MAX/);
  }
});
