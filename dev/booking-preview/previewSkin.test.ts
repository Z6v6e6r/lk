import assert from 'node:assert/strict';
import test from 'node:test';
import { previewFrameQuery, readPreviewSkin } from './previewSkin.ts';

test('current is the default and unknown skins cannot select arbitrary styles', () => {
  for (const skin of ['', 'current', 'other', 'https://example.com/style.css']) assert.equal(readPreviewSkin(new URLSearchParams({ skin })), 'current');
  assert.equal(readPreviewSkin(new URLSearchParams()), 'current');
  assert.equal(readPreviewSkin(new URLSearchParams('skin=lk2')), 'lk2');
});

test('changing skins keeps the iframe identity and every booking setting intact', () => {
  const params = new URLSearchParams('stage=full&screen=game-booking&subscription=1&boost=0&boostPrice=8800&dailyQuota=used&skin=current');
  const original = params.toString();
  const frame = previewFrameQuery(params);
  assert.equal(params.toString(), original);
  params.set('skin', 'lk2');
  assert.equal(previewFrameQuery(params), frame);
  const embedded = new URLSearchParams(frame);
  for (const [key, value] of params) if (key !== 'skin') assert.equal(embedded.get(key), value);
  assert.equal(embedded.has('skin'), false);
  params.set('dailyQuota', 'available');
  assert.notEqual(previewFrameQuery(params), frame, 'Business scenario changes still refresh the fixture');
});
