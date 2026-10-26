import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCampaignGame } from '../../src/components/padel-jump/engine.ts';
import { panoramaRect } from '../../src/components/padel-jump/yasenevo-layout.ts';

const base = new URL('../../src/assets/station-backgrounds/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8')) as {
  files: { station: number; file: string; width: number; height: number; bytes: number; sha256: string }[];
};

test('every remaining campaign station has a distinct pinned, metadata-free prepared painting', () => {
  assert.deepEqual(manifest.files.map(item => item.station), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(manifest.files.map(item => item.sha256)).size, 10);
  for (const item of manifest.files) {
    assert.match(item.file, /^[a-z-]+\.webp$/);
    const data = readFileSync(new URL(item.file, base));
    assert.equal(data.length, item.bytes); assert.ok(data.length < 1000000);
    assert.equal(createHash('sha256').update(data).digest('hex'), item.sha256);
    assert.equal(data.subarray(0, 4).toString(), 'RIFF');
    assert.equal(data.readUInt32LE(4) + 8, data.length);
    assert.equal(data.subarray(8, 16).toString(), 'WEBPVP8 ');
    assert.equal(20 + data.readUInt32LE(16) + data.readUInt32LE(16) % 2, data.length);
    assert.equal(data.readUInt16LE(26) & 0x3fff, item.width);
    assert.equal(data.readUInt16LE(28) & 0x3fff, item.height);
  }
});

test('all thirty remaining sections retain full image coverage and exact aspect through the ascent', () => {
  for (const item of manifest.files) for (let section = 0; section < 3; section++) {
    const g = createCampaignGame(item.station, section), end = g.campaign!.goalY - 640 * .43;
    const aspect = item.height / item.width;
    for (const overscan of [0, 38, 260, 500]) {
      let previous = -Infinity;
      for (let fraction = 0; fraction <= 1.2; fraction += .01) {
        const r = panoramaRect(end * fraction, g.campaign!.goalY, 420, 640, overscan, aspect);
        assert.ok(r.y <= -overscan + 1e-8 && r.y + r.h >= 640 + overscan - 1e-8);
        assert.ok(r.x <= 0 && r.x + r.w >= 420);
        assert.ok(Math.abs(r.h / r.w - aspect) < 1e-8);
        assert.ok(r.y >= previous - 1e-8); previous = r.y;
      }
    }
  }
});
