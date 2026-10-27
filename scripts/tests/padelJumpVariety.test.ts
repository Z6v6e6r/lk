import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BALANCE } from '../../src/components/padel-jump/campaign.ts';
import { BALL_RADIUS, createCampaignGame, drainEvents, movingX, stepGame } from '../../src/components/padel-jump/engine.ts';
import { crossesRect } from '../../src/components/padel-jump/level-layout.ts';

test('authored routes include held lanes, stairs, reversals and varied vertical gaps, with deterministic retries', () => {
  const signatures = new Set<string>();
  for (let s = 0; s < 11; s++) for (let n = 0; n < 3; n++) {
    const g = createCampaignGame(s, n), route = g.platforms;
    assert.deepEqual(g, createCampaignGame(s, n));
    const steps = route.slice(5).map((p, i) => p.baseX + p.width / 2 - (route[i + 4].baseX + route[i + 4].width / 2));
    assert.ok(steps.some(x => x === 0)); assert.ok(steps.some(x => x > 0)); assert.ok(steps.some(x => x < 0));
    assert.ok(steps.every(x => Math.abs(x) <= 100));
    assert.ok(new Set(route.slice(4).map((p, i) => p.y - route[i + 3].y)).size >= 4);
    signatures.add(steps.join(','));
  }
  assert.ok(signatures.size >= 20);
});

test('paired racket routes move two heads together, then hold two still; recovery courts never move', () => {
  for (const [s, n] of [[1, 0], [1, 1], [1, 2], [6, 0], [9, 2]]) {
    const g = createCampaignGame(s, n), rackets = g.platforms.filter(p => p.kind === 'racket');
    for (let i = 0; i < rackets.length; i++) {
      const p = rackets[i]; assert.equal(p.moving, Math.floor(i / 2) % 2 === 0);
      if (i % 4 === 1) for (const t of [0, 0.8, 2.1]) {
        const a = rackets[i - 1];
        assert.ok(Math.abs((movingX(p, t) - p.baseX) - (movingX(a, t) - a.baseX)) < 1e-9);
      }
    }
    assert.ok(g.platforms.filter(p => p.id % 6 === 0).every(p => !p.moving && p.kind === 'court'));
  }
});

test('Premium has several fixed, warned drop columns in every section instead of a solitary obstacle', () => {
  const counts = [0, 1, 2].map(n => createCampaignGame(5, n).campaign!.drops.length);
  assert.ok(counts[0] >= 4); assert.ok(counts[1] >= counts[0]); assert.ok(counts[2] > counts[1]);
  for (let n = 0; n < 3; n++) {
    const drops = createCampaignGame(5, n).campaign!.drops;
    assert.ok(drops.every(d => d.phase === 'waiting' && d.y > d.triggerY + 200));
    assert.ok(new Set(drops.map(d => Math.round(d.x))).size >= 3);
  }
});

test('central glass catches swept crossings from either side, above and below, and emits only one bounded boost', () => {
  for (const [x, y, vx, vy] of [[150, 220, 12000, 0], [270, 220, -12000, 0], [209, 140, 0, 12000], [209, 330, 0, -12000], [209, 140, 0, 60000], [209, 330, 0, -60000]]) {
    const g = createCampaignGame(4), c = g.campaign!;
    g.mode = 'running'; g.platforms = []; Object.assign(c, { metals: [], drops: [], admins: [], boosters: [], stars: [] });
    const glass = { id: 1001, x: 200, w: 18, side: -1 as const, y: 200, h: 96, broken: false };
    c.glass = [glass]; g.ball = { x, y, vx: 0, vy }; g.impulseX = vx;
    // Physics caps horizontal speed, so horizontal contact starts within one supported step.
    if (vx) g.ball.x = vx > 0 ? 187 : 231;
    stepGame(g, Math.sign(vx)); assert.ok(glass.broken); assert.equal(g.ball.vy, BALANCE.glassSpeed);
    assert.ok(Math.abs(g.impulseX) <= BALANCE.maxSpeedX);
    assert.equal(drainEvents(g).filter(e => e.type === 'glass').length, 1);
    g.ball = { x: 209, y: 240, vx: 0, vy: 0 }; stepGame(g, 0);
    assert.equal(drainEvents(g).filter(e => e.type === 'glass').length, 0);
  }
  assert.equal(crossesRect(0, 250, 420, 250, 200, 200, 18, 96, BALL_RADIUS), true);
  assert.equal(crossesRect(0, 100, 420, 100, 200, 200, 18, 96, BALL_RADIUS), false);
  for (let n = 0; n < 3; n++) {
    const glass = createCampaignGame(4, n).campaign!.glass;
    assert.ok(glass.some(p => p.x === undefined)); assert.ok(glass.filter(p => p.x !== undefined).length >= 3);
  }
});

test('administrator locks a visible target at warning, permits a dodge and catches only in the active circle', () => {
  const g = createCampaignGame(1), c = g.campaign!;
  g.mode = 'running'; g.platforms = []; Object.assign(c, { metals: [], glass: [], drops: [], boosters: [], stars: [] });
  const admin = c.admins[0]; c.admins = [admin];
  g.ball = { x: 180, y: admin.triggerY + 1, vx: 0, vy: 0 }; stepGame(g, 0);
  const x = admin.x; assert.equal(admin.phase, 'warning');
  for (let i = 0; i < Math.ceil(BALANCE.adminWarning * 120) + 2; i++) {
    g.ball = { x: x + 65, y: admin.y, vx: 0, vy: 0 }; stepGame(g, 0);
    assert.equal(admin.x, x); assert.equal(g.mode, 'running');
  }
  assert.equal(admin.phase, 'catch');
  g.ball = { x, y: admin.y, vx: 0, vy: 0 }; stepGame(g, 0); assert.equal(g.failure, 'admin');
});

test('administrator atlas has pinned provenance and a genuine alpha WebP with four equal pose cells', () => {
  const base = new URL('../../src/assets/station-actors/', import.meta.url);
  const p = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'));
  const data = readFileSync(new URL(p.file, base));
  assert.equal(data.subarray(0, 4).toString(), 'RIFF'); assert.equal(data.subarray(8, 12).toString(), 'WEBP');
  assert.equal(data.subarray(12, 16).toString(), 'VP8X'); assert.ok(data[20] & 0x10);
  assert.equal(data.length, p.bytes); assert.equal(createHash('sha256').update(data).digest('hex'), p.sha256);
  assert.ok(p.bytes < 1000000); assert.equal(p.width, p.grid.cellWidth * 2); assert.equal(p.height, p.grid.cellHeight * 2);
});
