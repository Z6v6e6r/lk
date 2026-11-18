import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { prepareSupportPhotos, SUPPORT_PHOTO_PREIMAGE_IDS } from '../prepare_support_photos.mjs';
const read = name => fs.readFileSync(new URL(`../nodered_support_nodes/${name}.js`, import.meta.url), 'utf8');
const state = new Map();
const run = (name, msg, settings = {}) => vm.runInNewContext(`(function(){${read(name)}})()`, {
  msg, Buffer, Date, global: { get: k => state.get(k), set: (k, v) => state.set(k, v) },
  env: { get: k => ({ SUPPORT_MEDIA_INTEGRATION_TOKEN: 'synthetic-token', ...settings })[k] }
});
const photo = { id: 'synthetic-photo', type: 'IMAGE', url: 'data:image/jpeg;base64,/9j/2w==' };
const message = () => ({ _msgid: '0123456789abcdef', req: { socket: { remoteAddress: 'synthetic-ip' } }, res: {},
  payload: { text: '', attachments: [photo], userId: 'synthetic-user' } });
const ref = { ...photo, url: 'cup-media:v1:synthetic.ref', mediaRef: 'cup-media:v1:synthetic.ref', mediaScope: 'a'.repeat(64) };

test('text path is untouched; photo service fields disappear before business writer and on every error', () => {
  state.clear(); const text = message(); text.payload.attachments = [];
  assert.equal(run('fn_support_photo_prepare', text)[0], text);
  const input = message(), prepared = run('fn_support_photo_prepare', input)[1];
  assert.equal(prepared.headers['x-integration-token'], 'synthetic-token');
  assert.equal(prepared.payload.owner, 'WEB_LK:0123456789abcdef');
  prepared.payload = { attachments: [ref] }; prepared.statusCode = 201;
  const output = run('fn_support_photo_prepared', prepared)[0];
  assert.equal(output.payload.attachments[0].mediaRef, ref.mediaRef);
  assert(!JSON.stringify(output).includes('synthetic-token')); assert(!('_supportPhoto' in output));
  assert.equal(Object.keys(state.get('supportPhotoAdmission').reservations).length, 0);
  const failed = run('fn_support_photo_error', prepared)[0];
  assert.equal(failed.statusCode, 503); assert(!JSON.stringify(failed).includes('synthetic-token'));
  assert.equal(run('fn_support_photo_prepare', message(), { SUPPORT_MEDIA_INTEGRATION_TOKEN: '' })[2].statusCode, 503);
  const wrong = message(); wrong.payload.attachments[0] = { ...photo, url: 'https://127.0.0.1/private' };
  assert.equal(run('fn_support_photo_prepare', wrong)[2].statusCode, 400);
});
test('admission is bounded; reordered or cross-scope service replies cannot reach business writer', () => {
  state.clear(); run('fn_support_photo_prepare', message());
  const second = message(); second._msgid = '1123456789abcdef'; run('fn_support_photo_prepare', second);
  const third = message(); third._msgid = '2123456789abcdef';
  assert.equal(run('fn_support_photo_prepare', third)[2].statusCode, 429);
  const prepared = message(); prepared.payload = { attachments: [{ ...ref, id: 'foreign' }] };
  prepared.statusCode = 200; prepared._supportPhoto = { operation: 'prepare', count: 1, ids: [photo.id], original: {} };
  assert.equal(run('fn_support_photo_prepared', prepared)[1].statusCode, 503);
});
test('GET history and POST echo resolve durable references without mutating Mongo or leaking headers/refs to browser/debug', () => {
  for (const single of [false, true]) {
    const stored = { id: 'synthetic-message', attachments: [ref] };
    const original = single ? { ok: true, message: stored } : { messages: [stored], hasMore: false };
    const before = JSON.stringify(original);
    const input = { ...message(), payload: original }, pending = run('fn_support_photo_resolve', input)[1];
    assert.equal(pending.payload.items[0].mediaRef, ref.mediaRef);
    pending.payload = { items: [{ index: 0, id: photo.id, url: 'https://synthetic-storage.invalid/signed' }] }; pending.statusCode = 200;
    const output = run('fn_support_photo_resolved', pending);
    assert.equal((single ? output.payload.message : output.payload.messages[0]).attachments[0].url, 'https://synthetic-storage.invalid/signed');
    assert(!JSON.stringify(output).includes('cup-media:')); assert(!JSON.stringify(output).includes('synthetic-token'));
    assert.equal(JSON.stringify(original), before);
  }
  const response = run('fn_support_photo_event_response', { ...message(), _supportEvent: { message: { id: 'm', attachments: [ref] } } });
  assert(!JSON.stringify(response[1]).includes('cup-media:'));
});
test('failed display grant after committed POST remains accepted; GET failures remain errors', () => {
  const original = { ok: true, message: { id: 'committed-message', attachments: [ref] } };
  const missingToken = run('fn_support_photo_resolve', { ...message(), payload: original }, { SUPPORT_MEDIA_INTEGRATION_TOKEN: '' })[2];
  assert.equal(missingToken.statusCode, 200); assert.equal(missingToken.payload.message.id, 'committed-message');
  assert(!JSON.stringify(missingToken).includes('cup-media:'));
  const prepared = run('fn_support_photo_resolve', { ...message(), payload: original })[1];
  prepared.statusCode = 503; prepared.payload = {};
  for (const output of [run('fn_support_photo_resolved', prepared), run('fn_support_photo_error', prepared)[1]]) {
    assert.equal(output.statusCode, 200); assert.equal(output.payload.ok, true);
    assert.equal(output.payload.mediaRefreshRequired, true); assert(!JSON.stringify(output).includes('cup-media:'));
  }
  const get = run('fn_support_photo_resolve', { ...message(), payload: { messages: [original.message] } })[1];
  get.statusCode = 503; get.payload = {};
  assert.equal(run('fn_support_photo_resolved', get).statusCode, 503);
});
function baseline() {
  const [ingress, history, d1, d2, s1, s2, response, prepare] = SUPPORT_PHOTO_PREIMAGE_IDS;
  const z = 'synthetic-tab'; return [
    { id: ingress, z, type: 'http in', method: 'post', url: '/lk/support/dialogs/events', wires: [[prepare]] },
    { id: history, z, type: 'function', func: 'return [msg,msg]', wires: [['9d2ab6d44c9ab611'], ['ca7984daa2fe8824']] },
    ...[[d1, s1, 'a5d5eca27e9e56da'], [d2, s2, '55b05444842e7b84']].flatMap(([d, s, bot]) => [
      { id: d, z, type: 'function', func: 'return msg', wires: [[s]] }, { id: s, z, type: 'maxbot-send', bot, wires: [['synthetic-ack']] }]),
    { id: response, z, type: 'function', wires: [['e2e7ac514b442d4a'], ['d6cd11bef22dfad0']] },
    { id: prepare, z, type: 'function', func: 'return msg', wires: [['synthetic-business']] },
    { id: 'unrelated', z, type: 'function', func: 'MUST STAY EXACT', wires: [] }
  ];
}
const hash = value => createHash('sha256').update(value).digest('hex');
test('candidate is pinned, bounded and preserves all unrelated nodes; stale or occupied preimages are refused', () => {
  const original = baseline(), raw = JSON.stringify(original), pins = { flowSha256: hash(raw), nodes: Object.fromEntries(original.map(n => [n.id, hash(JSON.stringify(n))])) };
  const result = prepareSupportPhotos(raw, pins), candidate = JSON.parse(result.candidate);
  assert.equal(result.changedIds.length, 8); assert.equal(result.addedIds.length, 9);
  assert.deepEqual(candidate.find(n => n.id === 'unrelated'), original.find(n => n.id === 'unrelated'));
  assert(candidate.filter(n => n.type === 'max-legacy-outbox-send').length === 2);
  assert.throws(() => prepareSupportPhotos(raw + ' ', pins), /FLOW_PREIMAGE_DRIFT/);
  const bad = { ...pins, nodes: { ...pins.nodes, [SUPPORT_PHOTO_PREIMAGE_IDS[0]]: '0'.repeat(64) } };
  assert.throws(() => prepareSupportPhotos(raw, bad), /NODE_PREIMAGE_DRIFT/);
});
