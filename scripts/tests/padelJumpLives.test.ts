import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { createCampaignGame, stepGame, drainEvents, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_LIVES } from '../../src/components/padel-jump/live-contract.ts';
import { pilotTarget } from './helpers/padelJumpPilot.ts';

const body = () => ({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE });
function harness(directory?: string) {
  directory ??= mkdtempSync(join(tmpdir(), 'jump-lives-case-'));
  let time = 0, seq = 0;
  const actor = { id: 'fixture-player', name: 'Игрок', communityId: 'fixture-community' };
  const registry = createRegistry({ communityId: actor.communityId, now: () => time, directory });
  const ticket = registry.join(body(), actor);
  const send = (command: string, inputs?: number[][]) => registry.command(ticket.id, ticket.token, { seq: ++seq, command, ...(inputs ? { inputs } : {}) }, actor);
  const fall = () => {
    const game = structuredClone(send('inputs', []).player.game); let last, count = 0;
    for (let tick = 0; tick < 1200 && game.mode === 'running'; tick++) {
      stepGame(game, -1); drainEvents(game); time += FIXED_STEP * 1000;
      count++;
      if (count === 60 || game.mode !== 'running') {
        const inputs = [[-100, count]]; const ack = send('inputs', inputs); last = { ack, envelope: { seq: ack.seq, command: 'inputs', inputs } }; count = 0;
      }
    }
    assert.equal(game.mode, 'over'); assert.ok(last); return last;
  };
  return { actor, registry, ticket, send, fall, directory, dispose() { rmSync(directory!, { recursive: true, force: true }); }, wait(ms: number) { time += ms; } };
}

test('five losses freeze score/time, deny a sixth attempt and save a partial ranked result', t => {
  const h = harness(); t.after(h.dispose); assert.equal(h.ticket.player.livesRemaining, LIVE_LIVES);
  let last;
  for (let loss = 1; loss <= LIVE_LIVES; loss++) {
    last = h.fall(); assert.equal(last.ack.player.failures, loss); assert.equal(last.ack.player.livesRemaining, LIVE_LIVES - loss);
    assert.equal(last.ack.player.state, loss === LIVE_LIVES ? 'eliminated' : 'retry');
    if (loss < LIVE_LIVES) assert.equal(h.send('retry').player.state, 'playing');
  }
  const terminal = last!.ack;
  assert.deepEqual(h.registry.command(h.ticket.id, h.ticket.token, last!.envelope, h.actor), terminal);
  h.wait(5000); const heartbeat = h.send('inputs', []);
  assert.equal(heartbeat.player.elapsedMs, terminal.player.elapsedMs); assert.equal(heartbeat.player.playMs, terminal.player.playMs); assert.equal(heartbeat.player.livesRemaining, 0);
  for (const [command, inputs] of [['retry'], ['advance'], ['pause'], ['resume'], ['inputs', [[0, 1]]]] as const) {
    assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: heartbeat.seq + 1, command, ...(inputs ? { inputs } : {}) }, h.actor), /RUN_ELIMINATED/);
  }
  assert.equal(h.registry.board().results.length, 0); assert.equal(h.registry.board().players[0].state, 'eliminated');
  const saved = h.send('finish'); assert.equal(saved.player.state, 'finished'); assert.equal(saved.player.completedParts, 0);
  assert.equal(saved.result.elapsedMs, terminal.player.elapsedMs); assert.equal(saved.result.stars, terminal.player.stars); assert.equal(saved.result.failures, 5);
  assert.deepEqual(h.registry.board().results, [saved.result]);
  assert.deepEqual(h.registry.command(h.ticket.id, h.ticket.token, { seq: saved.seq, command: 'finish' }, h.actor), saved);
});

test('fresh own race saves an unconfirmed partial result before retiring its capability at full capacity', t => {
  const h = harness(); t.after(h.dispose);
  for (let n = 0; n < LIVE_LIVES; n++) { h.fall(); if (n < LIVE_LIVES - 1) h.send('retry'); }
  const others = Array.from({ length: 11 }, (_, index) => h.registry.join(body(), { ...h.actor, id: 'fixture-other-' + index }));
  const before = h.registry.board().players.filter(p => p.id !== h.ticket.id);
  assert.throws(() => h.registry.join(body(), { ...h.actor, id: 'fixture-thirteenth' }), /EVENT_FULL/);
  const fresh = h.registry.join(body(), h.actor);
  assert.equal(h.registry.board().results.length, 1); assert.equal(h.registry.board().results[0].id, h.ticket.id);
  assert.notEqual(fresh.id, h.ticket.id); assert.notEqual(fresh.token, h.ticket.token); assert.equal(fresh.player.slot, h.ticket.player.slot);
  assert.equal(fresh.player.failures, 0); assert.equal(fresh.player.livesRemaining, LIVE_LIVES); assert.equal(fresh.player.elapsedMs, 0); assert.equal(fresh.player.playMs, 0);
  assert.equal(fresh.player.game.campaign!.station, 0); assert.equal(fresh.player.game.campaign!.section, 0);
  assert.deepEqual(h.registry.board().players.filter(p => p.id !== fresh.id), before); assert.equal(others.length, 11);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'inputs', inputs: [] }, h.actor), /RUN_ACCESS_DENIED/);
  assert.throws(() => h.registry.command(fresh.id, h.ticket.token, { seq: 1, command: 'inputs', inputs: [] }, h.actor), /RUN_ACCESS_DENIED/);
});

test('unfinished races cannot reset lives by joining again or supplying a client life counter', t => {
  const h = harness(); t.after(h.dispose); h.fall();
  assert.throws(() => h.registry.join(body(), h.actor), /PROFILE_ALREADY_RUNNING/);
  assert.throws(() => h.registry.join({ ...body(), livesRemaining: 5 }, h.actor), /RULES_CHANGED/);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 999, command: 'retry', livesRemaining: 5 }, h.actor), /COMMAND_INVALID/);
  assert.equal(h.registry.board().players[0].livesRemaining, 4);
});

test('a failed durable result during new-race recovery keeps the old capability and frozen score retriable', t => {
  const h = harness(); t.after(h.dispose);
  for (let n = 0; n < 5; n++) { h.fall(); if (n < 4) h.send('retry'); }
  const frozen = h.registry.board().players[0];
  rmSync(h.directory, { recursive: true }); writeFileSync(h.directory, 'local storage fault fixture');
  assert.throws(() => h.registry.join(body(), h.actor), /ENOTDIR/);
  const pending = h.send('inputs', []); assert.equal(pending.player.id, h.ticket.id); assert.equal(pending.player.state, 'eliminated');
  assert.equal(pending.player.elapsedMs, frozen.elapsedMs); assert.equal(h.registry.board().results.length, 0);
  rmSync(h.directory); mkdirSync(h.directory, { mode: 0o700 }); h.wait(5000);
  const saved = h.send('finish'); assert.equal(saved.result.elapsedMs, frozen.elapsedMs); assert.equal(saved.result.stars, frozen.stars); assert.equal(readdirSync(h.directory).length, 1);
  assert.equal(h.registry.join(body(), h.actor).player.livesRemaining, 5);
});

test('old unlimited-life receipts stay byte-identical on disk and outside the five-life ranking', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-five-lives-'));
  try {
    const id = randomUUID(), path = join(directory, id + '.json');
    const bytes = JSON.stringify({ id, actorId: 'fixture-player', communityId: 'fixture-community', alias: 'Игрок', engine: LIVE_ENGINE_VERSION, rule: 'active-total-community-v1', elapsedMs: 1000, playMs: 1000, failures: 9, finishedAt: new Date().toISOString() });
    writeFileSync(path, bytes);
    const registry = createRegistry({ communityId: 'fixture-community', directory });
    assert.equal(registry.board().results.length, 0); assert.equal(readFileSync(path, 'utf8'), bytes); assert.deepEqual(readdirSync(directory), [id + '.json']);
    assert.throws(() => registry.join({ ...body(), rule: 'active-total-community-v1' }, { id: 'fixture-player', name: 'Игрок', communityId: 'fixture-community' }), /RULES_CHANGED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const recoverOnJoin of [false, true]) test(`four losses leave one life for a 33-part result saved by ${recoverOnJoin ? 'fresh own join after a lost finish response' : 'verified finish'}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-last-life-'));
  try {
    const h = harness(directory);
    for (let loss = 0; loss < 4; loss++) { h.fall(); assert.equal(h.send('retry').player.livesRemaining, 4 - loss); }
    for (let station = 0; station < 11; station++) for (let section = 0; section < 3; section++) {
      const game = createCampaignGame(station, section); game.mode = 'running'; let landed = 0, count = 0, blocks: number[][] = [];
      for (let tick = 0; tick < 12000 && game.mode === 'running'; tick++) {
        const target = pilotTarget(game, landed, false), direction = Math.round(Math.max(-1, Math.min(1, (target - game.ball.x) / (250 * FIXED_STEP))) * 100);
        const last = blocks.at(-1); if (last?.[0] === direction && last[1] < 120) last[1]++; else blocks.push([direction, 1]);
        stepGame(game, direction / 100); h.wait(FIXED_STEP * 1000); count++;
        for (const e of drainEvents(game)) if (e.type === 'landing') landed = Number(e.id);
        if (count === 60 || game.mode !== 'running') { h.send('inputs', blocks); count = 0; blocks = []; }
      }
      assert.equal(game.mode, 'complete');
      if (station < 10 || section < 2) assert.equal(h.send('advance').player.livesRemaining, 1);
    }
    if (recoverOnJoin) {
      const next = h.registry.join(body(), h.actor); assert.notEqual(next.id, h.ticket.id); assert.equal(next.player.livesRemaining, 5); assert.equal(next.player.stars, 0);
      const result = h.registry.board().results[0]; assert.equal(result.id, h.ticket.id); assert.equal(result.failures, 4); assert.ok(result.stars > 0);
    } else {
      const final = h.send('finish'); assert.equal(final.player.state, 'finished'); assert.equal(final.player.livesRemaining, 1); assert.equal(final.result.failures, 4);
      assert.equal(final.result.rule, LIVE_RULE); assert.deepEqual(h.registry.board().results, [final.result]);
    }
    assert.equal(readdirSync(directory).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
