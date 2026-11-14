import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { sanitizeTypedCommunityPayload, addTypedCommunityResponseRedaction } from '../lib/communityResponseRedaction.mjs';
import { sanitizeTypedCommunityPayload as previousSanitizer } from '../fixtures/communityResponseRedactionBeforeBinaryFix.mjs';
import { buildCommunityLogoRepairCandidate } from '../patch_live_community_logo_binary.mjs';
import { sha256, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const image = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
const rev = 'lkLogoRev=20261112-binary-v1';
const asset = '/lk/media/community-logo/asset/thumb';
const legacy = '/lk/media/community-logo-legacy/community/thumb';

test('real image Buffers retain identity and bytes, including nested typed responses', () => {
  for (const typed of [false, true]) {
    assert.strictEqual(sanitizeTypedCommunityPayload(image, typed), image);
    const output = sanitizeTypedCommunityPayload({ payloads: [{ image }], logo: image }, typed);
    assert.strictEqual(output.payloads[0].image, image);
    assert.strictEqual(output.logo, image);
    assert.deepEqual(output.logo, Buffer.from(image));
  }
  assert.equal(Buffer.isBuffer(previousSanitizer(image)), false, 'fixture reproduces the production regression');
});

test('binary fix preserves typed PII redaction and ordinary community compatibility', () => {
  const phone = ['7', '900', '000', '00', '01'].join('');
  const row = { id: 'actor', phone, playerKey: 'phone:' + phone, name: 'Player', image };
  const source = { communities: [{ communityType: 'STATION', members: [row] }, { communityType: 'FRIENDS', members: [row] }] };
  const output = sanitizeTypedCommunityPayload(source);
  assert.equal(output.communities[0].members[0].phone, undefined);
  assert.equal(output.communities[0].members[0].playerKey, undefined);
  assert.equal(output.communities[1].members[0].phone, phone);
  assert.equal(output.communities[1].members[0].playerKey, 'phone:' + phone);
  const fakeBuffer = { type: 'Buffer', data: [1, 2], authorPhone: phone, eventRegistration: 'private' };
  const scrubbed = sanitizeTypedCommunityPayload(fakeBuffer, true);
  assert.deepEqual(scrubbed, { type: 'Buffer', data: [1, 2] });
  assert.equal(fakeBuffer.authorPhone, phone, 'source must not be mutated');
});

test('public logo fields get stable cache versions for originals, thumbs and legacy URLs', () => {
  for (const base of ['', 'https://padlhub.su', '//padlhub.su', 'https://lk-reserve.89-108-64-209.sslip.io']) {
    for (const url of [asset, asset.replace('/thumb', ''), legacy, legacy.replace('/thumb', '')]) {
      const source = { logo: base + url, logoUrl: base + url, logoThumbUrl: base + url };
      const output = sanitizeTypedCommunityPayload({ communities: [source] });
      for (const key of Object.keys(source)) assert.equal(output.communities[0][key], base + url + '?' + rev);
      assert.deepEqual(sanitizeTypedCommunityPayload(output), output);
      assert.equal(source.logo, base + url);
    }
  }
  const query = { logo: asset + '?size=160&lkLogoRev=old#preview' };
  assert.equal(sanitizeTypedCommunityPayload(query).logo, asset + '?size=160&' + rev + '#preview');
});

test('cache repair leaves external assets, data URLs and non-logo values unchanged', () => {
  for (const url of [
    'https://external.example' + asset, 'https://padlhub.su.evil.example' + asset,
    'data:image/png;base64,AA==', '/lk/media/unrelated/asset', '/lk/media/community-logo/',
  ]) assert.equal(sanitizeTypedCommunityPayload({ logo: url }).logo, url);
  assert.deepEqual(sanitizeTypedCommunityPayload({ imageUrl: asset, title: asset }), { imageUrl: asset, title: asset });
});

const mediaIds = ['b274fa471d4654a3', '9fa15a3c8d86528a', '75cd8607d472a975', 'ea4db740fdcd920c', '4573edfe3e109f3a', '87fc796ba5710287', '335e7e97639670f2', '4ec662e1ded03673'];
function oldFlow() {
  const nodes = [];
  for (const id of mediaIds) nodes.push({
    id, type: 'function', z: 'communities', name: 'Build community logo asset response', outputs: 2,
    func: 'if (!msg.payload) { msg.statusCode = 404; msg.payload = { error: "not found" }; return [msg, msg]; }\nmsg.statusCode = 200; return [msg, msg];',
    wires: [[id + '-http'], [id + '-debug']],
  }, { id: id + '-http', type: 'http response', z: 'communities' }, { id: id + '-debug', type: 'debug', z: 'communities' });
  for (const name of ['Build communities list response', 'Build community get response', 'Store community logo asset']) {
    nodes.push({ id: name, name, type: 'function', outputs: 1, func: '// normalizeCommunityForResponse\nreturn msg;', wires: [[mediaIds[0] + '-http']] });
  }
  const wrapped = addTypedCommunityResponseRedaction(nodes);
  const updated = sanitizeTypedCommunityPayload.toString();
  for (const node of wrapped) if (node.type === 'function') node.func = node.func.replace(updated, previousSanitizer.toString());
  wrapped.push({ id: 'unwrapped', type: 'function', name: 'Community unrelated', func: 'return msg;', wires: [[mediaIds[0] + '-http']] });
  return wrapped;
}

test('guarded candidate upgrades existing wrappers only; binary/404 outputs still reach HTTP', () => {
  const source = oldFlow(), bytes = Buffer.from(JSON.stringify(source));
  const { candidateBytes, contract } = buildCommunityLogoRepairCandidate(bytes, sha256(bytes));
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  const candidate = JSON.parse(candidateBytes);
  assert.equal(contract.allowedChanges.length, 11);
  assert.equal(contract.allowedChanges.some(node => node.id === 'unwrapped'), false);
  assert.deepEqual(candidate.at(-1), source.at(-1));
  for (const id of mediaIds) {
    const node = candidate.find(item => item.id === id);
    for (const typed of [false, true]) {
      const run = new Function('msg', 'Buffer', node.func);
      const output = run({ payload: image, _typedCommunity: typed }, Buffer);
      assert.equal(output[0].statusCode, 200);
      assert.strictEqual(output[0].payload, image);
      assert.strictEqual(output[0], output[1]);
      const missing = run({ payload: null, _typedCommunity: typed }, Buffer);
      assert.equal(missing[0].statusCode, 404);
      assert.deepEqual(missing[0].payload, { error: 'not found' });
    }
  }
  assert.deepEqual(addTypedCommunityResponseRedaction(candidate, { existingOnly: true }), candidate);
});

test('candidate fails closed on flow, sanitizer, wiring or missing-copy drift', () => {
  const source = Buffer.from(JSON.stringify(oldFlow()));
  assert.throws(() => buildCommunityLogoRepairCandidate(source, '0'.repeat(64)), /preimage mismatch/);
  for (const mutate of [
    nodes => { nodes[0].func = nodes[0].func.replace('const scoped = typed', 'const scoped = false'); },
    nodes => { nodes[0].wires = [[nodes[0].id + '-debug'], [nodes[0].id + '-http']]; },
    nodes => { nodes.splice(0, 1); },
  ]) {
    const nodes = oldFlow(); mutate(nodes); const bytes = Buffer.from(JSON.stringify(nodes));
    assert.throws(() => buildCommunityLogoRepairCandidate(bytes, sha256(bytes)), /DRIFT|drift|Missing/);
  }
});

test('actual wrapped original/thumb/legacy functions preserve bytes and HTTP 404/500 delivery', () => {
  const flow = addTypedCommunityResponseRedaction(JSON.parse(fs.readFileSync('node-red/lk_communities_nodes_import.json')));
  for (const id of ['community_logo_asset_fn_response_001', 'community_logo_thumb_fn_response_001', 'community_logo_legacy_fn_response_001', 'community_logo_legacy_thumb_fn_response_001']) {
    const node = flow.find(item => item.id === id);
    const run = new Function('msg', 'Buffer', node.func);
    const legacy = id.includes('legacy'), thumb = id.includes('thumb');
    const part = { mimeType: 'image/jpeg', encoding: 'base64', body: image.toString('base64') };
    const message = () => ({
      _typedCommunity: true,
      _communityLogoAsset: { variant: thumb ? 'thumb' : 'original' },
      _communityLegacyLogo: { variant: thumb ? 'thumb' : 'original' },
      payload: [legacy ? { logoLegacyDataUrl: 'data:image/jpeg;base64,' + part.body } : { original: part, thumb: part }],
    });
    const output = run(message(), Buffer);
    assert.equal(output[0].statusCode, 200, id);
    assert.ok(Buffer.isBuffer(output[0].payload), id);
    assert.deepEqual(output[0].payload, image);
    assert.strictEqual(output[0], output[1]);
    assert.equal(run({ payload: [] }, Buffer)[0].statusCode, 404, id);
    const brokenBuffer = { isBuffer: Buffer.isBuffer, from() { throw new Error('decode failure'); } };
    assert.equal(run(message(), brokenBuffer)[0].statusCode, 500, id);
  }
});
