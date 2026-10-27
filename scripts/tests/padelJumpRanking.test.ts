import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { stepGame, drainEvents, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';
import type { Game } from '../../src/components/padel-jump/engine.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
import { pilotTarget } from './helpers/padelJumpPilot.ts';

const body = () => ({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE });

test('ranking chooses each profile best by stars first, then minimum time; equal metrics have stable order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-star-ranking-'));
  const rows: { id: string; actorId: string; stars: number; elapsedMs: number; finishedAt: string }[] = [];
  const add = (actorId: string, stars: number, elapsedMs: number, offset: number) => {
    const row = { id: randomUUID(), actorId, alias: actorId, communityId: 'fixture-community', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, stars, elapsedMs, playMs: elapsedMs, failures: 5, finishedAt: new Date(Date.now() + offset).toISOString() };
    rows.push(row); writeFileSync(join(directory, row.id + '.json'), JSON.stringify(row)); return row;
  };
  try {
    add('A', 9, 1, 0); add('A', 10, 1000, 1); const bestA = add('A', 10, 900, 2); add('A', 10, 950, 3);
    const bestB = add('B', 11, 5000, 4), bestC = add('C', 10, 100, 5);
    const tiedD = add('D', 10, 100, 6);
    const registry = createRegistry({ communityId: 'fixture-community', directory });
    const ranked = registry.board().results;
    assert.deepEqual(ranked.map(r => r.id), [bestB.id, bestC.id, tiedD.id, bestA.id]);
    assert.equal(ranked.find(r => r.alias === 'A')!.stars, 10); assert.equal(ranked.find(r => r.alias === 'A')!.elapsedMs, 900);
    assert.deepEqual(createRegistry({ communityId: 'fixture-community', directory }).board().results, ranked);
    assert.equal(readdirSync(directory).length, rows.length);
    assert.ok(!JSON.stringify(ranked).includes('actorId'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function replayHarness(directory?: string) {
  let time = 0, seq = 0;
  const actor = { id: 'fixture-player', name: 'Игрок', communityId: 'fixture-community' };
  const registry = createRegistry({ communityId: actor.communityId, now: () => time, directory });
  const ticket = registry.join(body(), actor);
  const send = (command: string, inputs?: number[][]) => registry.command(ticket.id, ticket.token, { seq: ++seq, command, ...(inputs ? { inputs } : {}) }, actor);
  const play = (game: Game, choose: (g: Game, landed: number) => number, stop = (g: Game) => g.mode !== 'running') => {
    let landed = 0, count = 0, blocks: number[][] = [], last;
    for (let n = 0; n < 12000 && game.mode === 'running' && !stop(game); n++) {
      const direction = Math.round(Math.max(-1, Math.min(1, choose(game, landed))) * 100);
      const block = blocks.at(-1); if (block?.[0] === direction && block[1] < 120) block[1]++; else blocks.push([direction, 1]);
      stepGame(game, direction / 100); time += FIXED_STEP * 1000; count++;
      for (const event of drainEvents(game)) if (event.type === 'landing') landed = Number(event.id);
      if (count === 60 || stop(game) || game.mode !== 'running') { last = send('inputs', blocks); count = 0; blocks = []; }
    }
    assert.ok(last); return last;
  };
  return { registry, ticket, actor, send, play, wait(ms: number) { time += ms; } };
}

test('a star counts once across retry; the same platform index in the next section is a new star', () => {
  const h = replayHarness(), direction = (g: Game) => (g.campaign!.stars[0].x - g.ball.x) / (250 * FIXED_STEP), stop = (g: Game) => g.campaign!.stars[0].collected;
  let game = structuredClone(h.ticket.player.game);
  const firstId = game.campaign!.stars[0].id;
  assert.equal(h.play(game, direction, stop).player.stars, 1);
  h.play(game, () => -1); assert.equal(game.mode, 'over');
  const retry = h.send('retry'); game = structuredClone(retry.player.game);
  assert.equal(game.campaign!.stars[0].claimed, true); assert.equal(game.campaign!.stars[0].id, firstId);
  assert.equal(h.play(game, direction, stop).player.stars, 1);
  h.play(game, (g, landed) => (pilotTarget(g, landed, false) - g.ball.x) / (250 * FIXED_STEP)); assert.equal(game.mode, 'complete');
  const before = h.send('advance'); game = structuredClone(before.player.game);
  assert.notEqual(game.campaign!.stars[0].id, firstId);
  const next = h.play(game, direction, stop); assert.equal(next.player.stars, before.player.stars + 1);
});

test('rejected replay containing a star then post-failure excess input cannot mutate claimed score or sequence', () => {
  const h = replayHarness(), game = structuredClone(h.ticket.player.game); const blocks: number[][] = []; let total = 0, collected = false;
  for (; total < 479 && game.mode === 'running'; total++) {
    const direction = collected ? -100 : Math.round(Math.max(-1, Math.min(1, (game.campaign!.stars[0].x - game.ball.x) / (250 * FIXED_STEP))) * 100);
    const last = blocks.at(-1); if (last?.[0] === direction && last[1] < 120) last[1]++; else blocks.push([direction, 1]);
    stepGame(game, direction / 100); for (const event of drainEvents(game)) if (event.type === 'star') collected = true;
  }
  assert.ok(collected); assert.equal(game.mode, 'over'); blocks.push([0, 1]); h.wait((total + 1) * FIXED_STEP * 1000);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'inputs', inputs: blocks }, h.actor), /EXCESS_INPUTS/);
  const prior = h.registry.board().players[0]; assert.equal(prior.stars, 0); assert.equal(prior.failures, 0); assert.equal(prior.game.time, 0);
  const accepted = h.registry.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'inputs', inputs: [[0, 1]] }, h.actor);
  assert.equal(accepted.seq, 1); assert.equal(accepted.player.stars, 0);
});


test('a 601st attempt is saved permanently, acknowledges its own worse score, and keeps the old personal best', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-permanent-attempts-'));
  const oldest = Date.now() - 100 * 24 * 3600000; let bestId = '';
  try {
    for (let n = 0; n < 600; n++) {
      const id = randomUUID(); if (!n) bestId = id;
      writeFileSync(join(directory, id + '.json'), JSON.stringify({ id, actorId: 'fixture-player', alias: 'Игрок', communityId: 'fixture-community', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, stars: n ? 1 : 1000, elapsedMs: n + 1000, playMs: 1000, failures: 5, finishedAt: new Date(oldest).toISOString() }));
    }
    const h = replayHarness(directory); let game = structuredClone(h.ticket.player.game);
    assert.equal(h.registry.communityRanking(h.actor).total, 0); // Prime compatibility cache before the new durable result.
    for (let life = 0; life < 5; life++) {
      h.play(game, () => -1); assert.equal(game.mode, 'over');
      if (life < 4) game = structuredClone(h.send('retry').player.game);
    }
    const finished = h.send('finish');
    assert.equal(finished.result.id, h.ticket.id); assert.ok(finished.result.stars < 1000);
    assert.equal(h.registry.board().results[0].id, bestId);
    assert.equal(h.registry.communityRanking(h.actor).me.id, h.ticket.id);
    assert.equal(h.registry.communityRanking(h.actor, { allTime: true }).me.id, bestId);
    assert.equal(readdirSync(directory).length, 601);
    const restored = createRegistry({ communityId: h.actor.communityId, directory, wall: () => Date.now() + 1000 * 24 * 3600000 });
    assert.equal(restored.communityRanking(h.actor, { allTime: true }).me.id, bestId);
    assert.equal(readdirSync(directory).length, 601);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('legacy window expires only its read cache and reveals a recent runner-up without deleting the permanent winner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-legacy-window-')); let wall = 1800000000000;
  const owner = { id: 'fixture-player', communityId: 'fixture-community' };
  try {
    const rows = [
      { id: randomUUID(), stars: 9, finishedAt: new Date(wall - 48 * 3600000 + 1).toISOString() },
      { id: randomUUID(), stars: 8, finishedAt: new Date(wall - 3600000).toISOString() },
    ];
    for (const row of rows) writeFileSync(join(directory, row.id + '.json'), JSON.stringify({ ...row, actorId: owner.id, alias: 'Игрок', communityId: owner.communityId, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, elapsedMs: 1000, playMs: 900, failures: 5 }));
    const registry = createRegistry({ communityId: owner.communityId, directory, wall: () => wall });
    assert.equal(registry.communityRanking(owner).me.id, rows[0].id);
    wall += 2;
    assert.equal(registry.communityRanking(owner).me.id, rows[1].id);
    assert.equal(registry.communityRanking(owner, { allTime: true }).me.id, rows[0].id);
    wall += 100 * 24 * 3600000;
    assert.equal(registry.communityRanking(owner).total, 0); assert.equal(registry.board().results[0].id, rows[0].id);
    assert.equal(readdirSync(directory).length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('failed durable publication cannot replace the permanent best; the exact finish envelope retries safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-permanent-durability-'));
  const oldId = randomUUID();
  try {
    writeFileSync(join(directory, oldId + '.json'), JSON.stringify({ id: oldId, actorId: 'fixture-player', alias: 'Игрок', communityId: 'fixture-community', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, stars: 0, elapsedMs: 1000000, playMs: 900000, failures: 5, finishedAt: new Date().toISOString() }));
    const h = replayHarness(directory); let game = structuredClone(h.ticket.player.game), last;
    for (let life = 0; life < 5; life++) {
      last = h.play(game, () => -1);
      if (life < 4) game = structuredClone(h.send('retry').player.game);
    }
    const envelope = { seq: last.seq + 1, command: 'finish' };
    const target = join(directory, h.ticket.id + '.json'); mkdirSync(target);
    assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, envelope, h.actor));
    assert.equal(h.registry.communityRanking(h.actor, { allTime: true }).me.id, oldId);
    rmSync(target, { recursive: true }); h.wait(60000);
    const accepted = h.registry.command(h.ticket.id, h.ticket.token, envelope, h.actor);
    assert.equal(accepted.result.id, h.ticket.id); assert.ok(accepted.result.elapsedMs < 1000000);
    assert.equal(h.registry.communityRanking(h.actor, { allTime: true }).me.id, h.ticket.id);
    assert.deepEqual(h.registry.command(h.ticket.id, h.ticket.token, envelope, h.actor), accepted);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
