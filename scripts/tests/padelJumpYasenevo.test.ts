import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { surfaceRect } from '../../src/components/padel-jump/yasenevo-layout.ts';

test('supplied SVG art retains exact provenance and contains no executable or external content', () => {
  const base = new URL('../../src/assets/yasenevo-v2/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 26);
  for (const [name, item] of Object.entries(manifest.files) as [string, { sha256: string; bytes: number }][]) {
    const data = readFileSync(new URL(name, base)), svg = data.toString('utf8');
    assert.equal(data.length, item.bytes, name); assert.equal(createHash('sha256').update(data).digest('hex'), item.sha256, name);
    assert.ok(!/<(?:script|foreignObject)\b|<!ENTITY|\bon[a-z]+\s*=/i.test(svg), name);
    assert.ok(!/\b(?:href|xlink:href)\s*=\s*["'](?!#|data:image\/png;base64,)/i.test(svg), name);
  }
});
test('surface alignment preserves existing collider spans and sprite proportions, leaving the grip outside the supporting head', () => {
  for (const sprite of [{ w: 240, h: 88, surface: { x: 20, y: 11, width: 114 } }, { w: 192, h: 64, surface: { x: 14, y: 12, width: 164 } }]) {
    for (const width of [120, 160, 200]) {
      const rect = surfaceRect(width, sprite), scale = rect.w / sprite.w;
      assert.ok(Math.abs(rect.x + sprite.surface.x * scale) < 1e-9);
      assert.ok(Math.abs(rect.x + (sprite.surface.x + sprite.surface.width) * scale - width) < 1e-9);
      assert.ok(Math.abs(rect.y + sprite.surface.y * scale) < 1e-9);
      assert.ok(Math.abs(rect.w / rect.h - sprite.w / sprite.h) < 1e-9);
    }
  }
});
