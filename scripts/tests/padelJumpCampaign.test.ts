import test from 'node:test';
import assert from 'node:assert/strict';
import { BEST_KEY, createCampaignGame, createGame, drainEvents, FIXED_STEP, JUMP_SPEED, metalContact, movingX, SPRING_SPEED, stepGame } from '../../src/components/padel-jump/engine.ts';
import { BALANCE, sectionBalance, STATIONS } from '../../src/components/padel-jump/campaign.ts';
import { canPlayPart, claimStar, finishPart, freshProgress, loadProgress, PROGRESS_KEY, recordFailure, stationMedal, writeProgress } from '../../src/components/padel-jump/progress.ts';
import { createVisit, JOURNAL_KEY, readJournal } from '../../src/components/padel-jump/session.ts';
import { pilot } from './helpers/padelJumpPilot.ts';
function store() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function fixture(kind: 'court' | 'racket' | 'net' | 'crumble' = 'racket') {
  const g = createGame(1); g.mode = 'running'; g.platforms = [{ id: 1, x: 120, baseX: 120, y: 100, width: 180, kind, moving: false, flash: 0 }];
  g.ball = { x: 210, y: 113, vx: 0, vy: -300 }; return g;
}
function hazardGame() {
  const g = createCampaignGame(5, 0); g.mode = 'running'; g.platforms = [];
  Object.assign(g.campaign!, { metals: [], glass: [], drops: [], admins: [], boosters: [], stars: [] });
  g.ball = { x: 210, y: 200, vx: 0, vy: 0 }; return g;
}
test('rackets and cracked platforms bounce once, immediately disable collisions, then disappear; pause freezes collapse', () => {
  for (const kind of ['racket', 'crumble'] as const) {
    const g = fixture(kind); stepGame(g, 0); const p = g.platforms[0];
    assert.equal(g.ball.vy, JUMP_SPEED); assert.equal(p.spent, 0);
    g.ball.y = 113; g.ball.vy = -300; stepGame(g, 0); assert.equal(g.bounces, 1);
    g.mode = 'paused'; const age = p.spent; stepGame(g, 0); assert.equal(p.spent, age);
    g.mode = 'running'; for (let i = 0; i < 100; i++) { g.ball.y = 200; g.ball.vy = 0; stepGame(g, 0); }
    assert.ok(!g.platforms.includes(p));
  }
});
test('ordinary courts and spring nets can catch a return; the consumed racket cannot', () => {
  for (const kind of ['court', 'net', 'racket'] as const) {
    const g = fixture(kind); stepGame(g, 0); g.ball.y = 113; g.ball.vy = -300; stepGame(g, 0);
    assert.equal(g.bounces, kind === 'racket' ? 1 : 2);
    if (kind !== 'racket') assert.equal(g.ball.vy, kind === 'net' ? SPRING_SPEED : JUMP_SPEED);
  }
});
test('metal swept faces distinguish fatal upper landings, solid sides and underside at high speed', () => {
  const wall = { x: 100, y: 200, w: 100, h: 20 };
  const top = hazardGame(); top.ball = { x: 150, y: 150, vx: 0, vy: -1500 }; metalContact(top, wall, 150, 300);
  assert.equal(top.failure, 'metal'); assert.equal(top.ball.y, 232);
  const side = hazardGame(); side.ball = { x: 150, y: 210, vx: 900, vy: -20 }; metalContact(side, wall, 20, 210);
  assert.equal(side.mode, 'running'); assert.equal(side.ball.x, 88);
  const under = hazardGame(); under.ball = { x: 150, y: 260, vx: 0, vy: 1500 }; metalContact(under, wall, 150, 100);
  assert.equal(under.mode, 'running'); assert.equal(under.ball.y, 188); assert.equal(under.ball.vy, 0);
  const tangent = hazardGame(); tangent.ball = { x: 88, y: 200, vx: 0, vy: -1000 }; metalContact(tangent, wall, 88, 300);
  assert.equal(tangent.mode, 'running');
});
test('metal is not skipped by supported fixed simulation steps or capped slow-render deltas', () => {
  for (const dt of [FIXED_STEP, 1 / 60, 1 / 30, 2]) {
    const g = hazardGame(); g.campaign!.metals = [{ x: 100, y: 200, w: 180, h: 20 }];
    g.ball.y = 234; g.ball.vy = -860; stepGame(g, 0, dt); assert.equal(g.failure, 'metal');
  }
});
test('glass gives one bounded impulse inward per panel; broken panels never boost twice', () => {
  for (const side of [-1, 1] as const) {
    const g = hazardGame(); g.campaign!.glass = [{ id: 1, side, y: 100, h: 200, broken: false }]; g.ball.x = side < 0 ? 12 : 408;
    stepGame(g, side); assert.equal(g.ball.vy, BALANCE.glassSpeed); assert.equal(Math.sign(g.impulseX), -side);
    assert.equal(drainEvents(g).filter(e => e.type === 'glass').length, 1);
    g.ball.x = side < 0 ? 12 : 408; g.ball.vy = 0; stepGame(g, side);
    assert.ok(g.ball.vy < 0); assert.ok(Math.abs(g.ball.vx) <= BALANCE.maxSpeedX);
    assert.equal(drainEvents(g).filter(e => e.type === 'glass').length, 0);
  }
});
test('drop warns for one second, keeps a fixed column, hits once and allows a lower court recovery', () => {
  const g = hazardGame(); const drop = { id: 1, x: 210, y: 220, triggerY: 180, phase: 'waiting' as const, age: 0 };
  g.campaign!.drops.push(drop); stepGame(g, 0); assert.equal(g.campaign!.drops[0].phase, 'warning');
  for (let i = 0; i < 118; i++) { g.ball.y = 200; g.ball.vy = 0; stepGame(g, 0); }
  assert.equal(g.campaign!.drops[0].phase, 'warning'); assert.equal(drop.x, 210);
  for (let i = 0; i < 4; i++) { g.ball.y = 200; g.ball.vy = 0; stepGame(g, 0); }
  assert.equal(g.campaign!.drops[0].phase, 'spent'); assert.equal(g.mode, 'running'); assert.ok(g.protection > 0);
  const hitEvents = drainEvents(g).filter(e => e.type === 'drop'); assert.equal(hitEvents.length, 1);
  g.platforms = [{ id: 1, x: 120, baseX: 120, y: 150, width: 180, moving: false, kind: 'court', flash: 0 }];
  g.ball.vy = -240;
  for (let i = 0; i < 30 && g.bounces === 0; i++) stepGame(g, 0);
  assert.equal(g.bounces, 1); assert.equal(g.mode, 'running');
  assert.equal(drainEvents(g).filter(e => e.type === 'drop').length, 0);
});
test('admin warns without capture, captures only in active zone, and has a finite retreat', () => {
  const g = hazardGame(); const admin = { id: 1, x: 210, y: 200, triggerY: 180, phase: 'waiting' as const, age: 0 }; g.campaign!.admins.push(admin);
  for (let i = 0; i < 120; i++) { g.ball.y = 200; g.ball.vy = 0; stepGame(g, 0); }
  assert.equal(g.mode, 'running'); assert.equal(g.campaign!.admins[0].phase, 'warning');
  for (let i = 0; i < 50 && g.mode === 'running'; i++) { g.ball.y = 200; g.ball.vy = 0; stepGame(g, 0); }
  assert.equal(g.failure, 'admin');
  const safe = hazardGame(); safe.campaign!.admins.push({ ...admin, phase: 'waiting', age: 0 });
  for (let i = 0; i < 400; i++) { safe.ball.x = 60; safe.ball.y = 200; safe.ball.vy = 0; stepGame(safe, 0); }
  assert.equal(safe.mode, 'running'); assert.equal(safe.campaign!.admins[0].phase, 'gone');
});
test('all 33 sections have sampled executable routes across three starting motion phases', () => {
  for (let s = 0; s < STATIONS.length; s++) for (let n = 0; n < 3; n++) for (const phase of [0, 1.7, 4.3]) {
    const g = createCampaignGame(s, n); g.time = phase; pilot(g);
    assert.equal(g.mode, 'complete', `${s}:${n} phase ${phase}: ${g.failure}`);
  }
});
test('intro remains hazard-free; Seligerskaya introduces paired motion and delayed administrators', () => {
  const a = sectionBalance(0, 0), b = sectionBalance(0, 1), c = sectionBalance(0, 2);
  assert.ok(a.sway < b.sway); assert.equal(b.sway, c.sway); assert.ok(b.gap < c.gap);
  const intro = createCampaignGame(0, 0).campaign!;
  assert.equal(intro.metals.length + intro.admins.length + intro.drops.length + intro.glass.length, 0);
  assert.ok(createCampaignGame(1, 0).campaign!.admins.every(a => a.phase === 'waiting' && a.triggerY > 500));
  assert.ok(createCampaignGame(1, 2).campaign!.admins.length > 0);
  const p = createCampaignGame(6, 1).platforms.find(p => p.moving)!;
  const t = (6 - (p.motionPhase ?? p.id * 0.4) % 6) % 6;
  assert.equal(movingX(p, t + 0.2), movingX(p, t + 0.8));
});
test('idle 120 seconds earns no star/completion; stars are optional for a genuinely controlled finish', () => {
  const idle = createCampaignGame(); idle.mode = 'running'; for (let i = 0; i < 14400; i++) stepGame(idle, 0);
  assert.notEqual(idle.mode, 'complete'); assert.equal(idle.campaign!.stars.filter(s => s.collected).length, 0);
  const noStars = createCampaignGame(); noStars.campaign!.stars = []; pilot(noStars, { stars: false });
  assert.equal(noStars.mode, 'complete'); assert.ok(noStars.campaign!.controlledLandings >= 3); assert.ok(noStars.campaign!.directionChanges >= 1);
});
test('retries restore the same layout/motion/hazards; practice and assistance cannot manufacture competitive medals', () => {
  assert.deepEqual(createCampaignGame(5, 2), createCampaignGame(5, 2));
  const p = freshProgress(), g = createCampaignGame(); g.mode = 'complete'; g.campaign!.stars.forEach(s => { s.collected = true; });
  g.campaign!.assistedEver = true; g.campaign!.assist = false; assert.ok(finishPart(p, g));
  assert.equal(p.parts['0:0'].perfect, false); assert.equal(p.parts['0:0'].clean, false); assert.ok(canPlayPart(p, 0, 1)); assert.equal(p.tutorial, false);
  const practice = createCampaignGame(0, 1, { practice: true }); practice.mode = 'complete';
  assert.equal(finishPart(p, practice), false); assert.equal(claimStar(p, practice, '0:1:1'), false); assert.equal(p.current.section, 1);
});
test('checkpoint progress persists, rejects corrupt/untrusted unlocks, preserves future saves and legacy endless best', () => {
  const storage = store(); storage.setItem(BEST_KEY, '433');
  assert.deepEqual(loadProgress(storage), freshProgress());
  storage.setItem(PROGRESS_KEY, '{bad'); assert.deepEqual(loadProgress(storage), freshProgress());
  storage.setItem(PROGRESS_KEY, JSON.stringify({ schema: 1, unlocked: 10, current: { station: 10, section: 2 }, parts: {} }));
  assert.equal(loadProgress(storage).unlocked, 0);
  for (const raw of ['{"schema":2,"important":"keep"}', '{"schema":1,"balance":999,"parts":{}}']) {
    storage.setItem(PROGRESS_KEY, raw); const future = loadProgress(storage); assert.equal(writeProgress(future, storage), false); assert.equal(storage.getItem(PROGRESS_KEY), raw);
  }
  storage.values.delete(PROGRESS_KEY);
  const p = freshProgress(), g = createCampaignGame();
  assert.equal(claimStar(p, g, '0:0:1'), true); assert.equal(claimStar(p, g, '0:0:1'), false);
  recordFailure(p, g); g.mode = 'complete'; finishPart(p, g); writeProgress(p, storage);
  const restored = loadProgress(storage); assert.equal(restored.current.section, 1); assert.equal(restored.parts['0:0'].failures, 1); assert.equal(restored.claimed.length, 1);
  assert.equal(storage.getItem(BEST_KEY), '433'); assert.ok(!canPlayPart(restored, 1, 0));
  assert.equal(writeProgress(p, { getItem() { throw Error(); }, setItem() { throw Error(); } }), false);
});
test('all stations unlock sequentially and final completion and medals survive reload', () => {
  const p = freshProgress(), storage = store();
  for (let s = 0; s < 11; s++) for (let n = 0; n < 3; n++) {
    assert.ok(canPlayPart(p, s, n)); if (s < 10) assert.ok(!canPlayPart(p, s + 1, 0));
    const g = createCampaignGame(s, n); g.mode = 'complete'; g.campaign!.stars.forEach(star => { star.collected = true; }); finishPart(p, g);
  }
  assert.ok(p.completed); assert.ok(p.tutorial); assert.equal(stationMedal(p, 10), 'perfect');
  writeProgress(p, storage); assert.ok(loadProgress(storage).completed);
});
test('visit clock includes automatic screens and retries but excludes explicit pause/background; local journal is bounded and disableable', () => {
  const v = createVisit('anonymous-test'), storage = store(); v.advance(20, true, false, true); assert.equal(v.times().visibleSeconds, 0);
  assert.equal(v.start(), true); assert.equal(v.start(), false);
  v.advance(4, true, false, false); v.advance(10, true, false, true); v.advance(60, false, false, true); v.advance(30, true, true, false);
  assert.deepEqual(v.times(), { visibleSeconds: 14, controlSeconds: 10 });
  const context = { station: 0, section: 0, attempt: 1, input: 'touch' as const, assist: false, practice: false };
  v.log('off', context, false, storage); assert.equal(storage.getItem(JOURNAL_KEY), null);
  for (let i = 0; i < 250; i++) v.log('retry', context, true, storage);
  assert.equal(readJournal(storage).length, 200); assert.deepEqual(Object.keys(readJournal(storage)[0]).sort(), ['event', 'game', 'balance', 'visit', 'station', 'section', 'attempt', 'input', 'assist', 'practice', 'visibleSeconds', 'controlSeconds'].sort());
  assert.equal(v.first('moving'), true); assert.equal(v.first('moving'), false);
});

test('assistance follows the lower landing during descent rather than unreachable upper platforms', async () => {
  const { landingHint } = await import('../../src/components/padel-jump/engine.ts');
  const g = createCampaignGame(); g.mode = 'running'; for (let i = 0; i < 50; i++) stepGame(g, 0);
  assert.ok(g.ball.vy < 0); const target = landingHint(g); assert.ok(target); assert.equal(target.y, 128);
});
test('continued outward input cannot cancel the immediate glass rebound', () => {
  const g = hazardGame(); g.ball.x = 12; g.campaign!.glass = [{ id: 1, side: -1, y: 100, h: 300, broken: false }];
  stepGame(g, -1); for (let i = 0; i < 20; i++) stepGame(g, -1);
  assert.ok(g.ball.x > 30); assert.ok(g.ball.vx > 0); assert.equal(drainEvents(g).filter(e => e.type === 'glass').length, 1);
});
test('first glass and drop lessons expose wide reusable recovery courts in the visible continuation', () => {
  const glass = createCampaignGame(4, 0), drops = createCampaignGame(5, 0);
  for (const id of [6, 7]) { const p = glass.platforms.find(p => p.id === id)!; assert.equal(p.kind, 'court'); assert.ok(p.width >= 220); }
  for (const id of [18, 19]) { const p = drops.platforms.find(p => p.id === id)!; assert.equal(p.kind, 'court'); assert.ok(p.width >= 220); }
});

test('reproducible clean and two-mistake first visits reach and play Seliger in 120 visible seconds', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/padel-jump-ftue.ts'], { encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.scenarios.length, 2);
  for (const scenario of report.scenarios) {
    assert.ok(scenario.seligerReady.visibleSeconds <= 120);
    assert.ok(scenario.seligerFirstMovingLanding.visibleSeconds <= 120);
    assert.ok(scenario.movingLandings >= 1);
  }
});

test('real first glass panel has a reachable wide ordinary continuation from low/middle/high side contacts', () => {
  for (const offset of [-10, 80, 165]) {
    const g = createCampaignGame(4, 0), y = g.campaign!.glass[0].y + offset; g.mode = 'running'; g.ball = { x: 12, y, vx: 0, vy: 0 }; g.camera = y - 275;
    stepGame(g, -1); assert.ok(g.campaign!.glass[0].broken); drainEvents(g);
    let landing: number | undefined;
    for (let i = 0; i < 240 && landing === undefined && g.mode === 'running'; i++) {
      stepGame(g, Math.max(-1, Math.min(1, (210 - g.ball.x) / 5)));
      const e = drainEvents(g).find(e => e.type === 'landing'); if (e) landing = Number(e.id);
    }
    assert.equal(g.mode, 'running'); assert.ok(landing !== undefined && landing >= 6 && landing <= 9);
    const p = g.platforms.find(p => p.id === landing)!; assert.equal(p.kind, 'court'); assert.equal(p.width, 230);
  }
});

test('an older open tab cannot overwrite a future schema written by a newer tab', () => {
  const storage = store(), p = freshProgress(); storage.setItem(PROGRESS_KEY, '{"schema":2,"keep":true}');
  assert.equal(writeProgress(p, storage), false); assert.equal(storage.getItem(PROGRESS_KEY), '{"schema":2,"keep":true}');
});

test('the second Yasenevo geometry requires real steering rather than an idle central corridor', () => {
  const g = createCampaignGame(0, 1); g.mode = 'running'; for (let i = 0; i < 14400; i++) stepGame(g, 0);
  assert.notEqual(g.mode, 'complete'); assert.ok(g.peak < g.campaign!.goalY);
});
