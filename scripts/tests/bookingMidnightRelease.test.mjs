import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { composeBookingMidnightRelease, midnightReplace, MIDNIGHT_LIVE_PINS } from '../prepare_booking_midnight_release.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const release = 'a'.repeat(40);
test('closing release requires exact source identity, release identity and complete graph', () => {
  const bytes = Buffer.from('[]');
  assert.throws(() => composeBookingMidnightRelease(bytes), /FLOW_DRIFT/);
  assert.throws(() => composeBookingMidnightRelease(bytes, { expectedSourceSha256: 'f'.repeat(64), release }), /FLOW_DRIFT/);
  assert.throws(() => composeBookingMidnightRelease(bytes, { expectedSourceSha256: sha(bytes), release: 'unknown' }), /COMMIT_REQUIRED/);
  assert.throws(() => composeBookingMidnightRelease(bytes, { expectedSourceSha256: sha(bytes), release }), /GRAPH_DRIFT/);
});
test('unrecognized function bodies cannot enter a correctly shaped closing release graph', () => {
  const flow = Object.values(MIDNIGHT_LIVE_PINS).map(pin => ({ id: pin.id, type: 'function', func: 'return msg;' }));
  for (let i = flow.length; i < 4985; i++) flow.push({ id: 'synthetic-' + i, type: 'comment' });
  const bytes = Buffer.from(JSON.stringify(flow));
  assert.throws(() => composeBookingMidnightRelease(bytes, { expectedSourceSha256: sha(bytes), release }), /FUNCTION_DRIFT/);
});
test('replacement guards require the exact tuple size and reject missing/duplicate anchors', () => {
  assert.equal(midnightReplace('abc', 'b', 'x'), 'axc');
  assert.equal(midnightReplace('b-b-b', 'b', 'x', 3), 'x-x-x');
  for (const [source, count] of [['ac', 1], ['bb', 1], ['b-b', 3], ['b-b-b-b', 3]]) {
    assert.throws(() => midnightReplace(source, 'b', 'x', count), /ANCHOR_DRIFT/);
  }
});
const fixture = process.env.LK_MIDNIGHT_RELEASE_LIVE;
test('private fresh live packet preserves graph, observer bundle and all foreign fields', {
  skip: !fixture && 'Requires exact private live147 source; never copied into Git',
}, () => {
  const bytes = fs.readFileSync(fixture), source = JSON.parse(bytes);
  const options = { expectedSourceSha256: sha(bytes), release };
  const packet = composeBookingMidnightRelease(bytes, options);
  assert.deepEqual(packet.candidateBytes, composeBookingMidnightRelease(bytes, options).candidateBytes);
  const candidate = JSON.parse(packet.candidateBytes);
  const targets = new Set(Object.values(MIDNIGHT_LIVE_PINS).map(pin => pin.id));
  assert.equal(packet.contract.allowedChanges.length, 4);
  assert.equal(packet.contract.allowedAdditions.length, 0);
  for (let i = 0; i < source.length; i++) {
    if (!targets.has(source[i].id)) assert.deepEqual(candidate[i], source[i]);
    else {
      const fields = source[i].id === MIDNIGHT_LIVE_PINS.preview.id ? ['func', 'initialize'] : ['func'];
      const restored = { ...candidate[i] };
      for (const key of fields) restored[key] = source[i][key];
      assert.deepEqual(restored, source[i]);
    }
  }
  const before = source.find(n => n.id === MIDNIGHT_LIVE_PINS.preview.id);
  const after = candidate.find(n => n.id === before.id);
  const restoredInitialize = after.initialize.replaceAll(release, '20e8190ee862678a2c3f18f372b36375f8594346')
    .replaceAll(packet.report.sourceHash, '1139b85ce9bfe126a87cb2b705e92bd64d57a7f81d5af5708ebcd504446f42a3');
  assert.equal(restoredInitialize, before.initialize);
  assert.equal(sha(after.func), packet.report.sourceHash);
  for (const changedField of ['func', 'initialize', 'finalize', 'libs']) {
    const drift = structuredClone(source), n = drift.find(n => n.id === before.id);
    n[changedField] = changedField === 'libs' ? [] : n[changedField] + '\n// drift';
    const driftBytes = Buffer.from(JSON.stringify(drift));
    assert.throws(() => composeBookingMidnightRelease(driftBytes, { expectedSourceSha256: sha(driftBytes), release }), /(?:FUNCTION|OBSERVER)_DRIFT/);
  }
  const split = candidate.find(n => n.id === MIDNIGHT_LIVE_PINS.split.id);
  assert.equal(split.func.split('timeTo: `${splitCreateEndDate(ctx)}T${ctx.toTime}+03:00`,').length - 1, 3);
  assert.equal(split.func.includes('timeTo: `${ctx.date}T${ctx.toTime}+03:00`,'), false);
  assert.equal(packet.report.workerChanged, false);
  assert.equal(packet.report.settingsChanged, false);
});
