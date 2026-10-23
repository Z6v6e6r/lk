import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BALL_RADIUS, createCampaignGame, JUMP_SPEED, stepGame, WIDTH } from '../../src/components/padel-jump/engine.ts';
import { sectionBalance } from '../../src/components/padel-jump/campaign.ts';
import { panoramaRect, surfaceRect } from '../../src/components/padel-jump/yasenevo-layout.ts';

test('supplied SVG art retains exact provenance and contains no executable or external content', () => {
  const base = new URL('../../src/assets/yasenevo-v2/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 27);
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

test('painted panorama covers every ascent without wrapping, gaps or a sky-only fallback', () => {
  for (let section = 0; section < 3; section++) {
    const game = createCampaignGame(0, section), goal = game.campaign!.goalY;
    const end = goal - 640 * 0.43;
    let previous = -620;
    for (let camera = 0; camera <= end + 200; camera += 1) {
      const rect = panoramaRect(camera, goal, 420, 640);
      assert.ok(rect.y <= 0 && rect.y + rect.h >= 640);
      assert.ok(rect.y >= previous && rect.y - previous <= 1);
      previous = rect.y;
    }
    assert.deepEqual(panoramaRect(0, goal, 420, 640), { x: 0, y: -620, w: 420, h: 1260 });
    assert.equal(panoramaRect(end, goal, 420, 640).y, 0);
    assert.equal(panoramaRect(end * 2, goal, 420, 640).y, 0);
    for (const overscan of [36, 250, 500]) {
      for (const camera of [0, end / 2, end]) {
        const rect = panoramaRect(camera, goal, 420, 640, overscan);
        assert.ok(rect.y <= -overscan && rect.y + rect.h >= 640 + overscan);
        assert.ok(rect.x <= 0 && rect.x + rect.w >= 420);
        assert.equal(rect.h / rect.w, 3);
      }
    }
  }
});

test('prepared painted environment matches the pinned image provenance', () => {
  const base = new URL('../../src/assets/yasenevo-v2/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('panorama-provenance.json', base), 'utf8'));
  const data = readFileSync(new URL(manifest.file, base));
  assert.equal(data.subarray(0, 4).toString(), 'RIFF');
  assert.equal(data.subarray(8, 12).toString(), 'WEBP');
  assert.equal(data.length, manifest.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), manifest.sha256);
  assert.equal(manifest.height / manifest.width, 3);
});


test('Yasenevo rackets and landing heads are quarter size at the same route centres; courts and other stations stay unchanged', () => {
  const sprite = { w: 240, h: 88, surface: { x: 20, y: 11, width: 114 } };
  for (let section = 0; section < 3; section++) {
    const cfg = sectionBalance(0, section), game = createCampaignGame(0, section);
    for (const p of game.platforms.filter(p => p.id > 0)) {
      const centre = 210 + Math.sin(p.id * cfg.phase) * (section === 0 && p.id < 10 ? 20 : cfg.sway);
      const oldX = Math.max(26, Math.min(WIDTH - cfg.width - 26, centre - cfg.width / 2));
      assert.equal(p.x + p.width / 2, oldX + cfg.width / 2);
      if (p.kind === 'racket') {
        assert.equal(p.width, cfg.width / 4);
        const before = surfaceRect(cfg.width, sprite), after = surfaceRect(p.width, sprite);
        assert.equal(after.w, before.w / 4); assert.equal(after.h, before.h / 4);
      } else assert.equal(p.width, cfg.width);
    }
    assert.equal(game.platforms[0].width, 200);
    assert.ok(createCampaignGame(1, section).platforms.filter(p => p.kind === 'racket').every(p => p.width === 160));
  }
});
test('the reduced racket catches one head landing but no longer catches the former wide invisible edge', () => {
  for (const inside of [false, true]) {
    const g = createCampaignGame(), p = g.platforms.find(p => p.kind === 'racket')!;
    g.platforms = [p]; g.mode = 'running';
    g.ball = { x: p.x + (inside ? p.width / 2 : p.width + BALL_RADIUS + 2), y: p.y + BALL_RADIUS + 1, vx: 0, vy: -300 };
    stepGame(g, 0);
    assert.equal(g.bounces, inside ? 1 : 0);
    if (inside) { assert.equal(g.ball.vy, JUMP_SPEED); assert.equal(p.spent, 0); }
    else { assert.ok(g.ball.vy < 0); assert.equal(p.spent, undefined); }
  }
});
