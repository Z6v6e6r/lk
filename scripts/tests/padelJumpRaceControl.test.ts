import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { createCampaignGame, stepGame, drainEvents, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';
import { createRaceTransport } from '../../src/components/padel-jump/race-connection.ts';
import { createRaceControl } from '../../src/components/padel-jump/race-control.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
import type { LiveAck } from '../../src/components/padel-jump/race-connection.ts';
import { pilotTarget } from './helpers/padelJumpPilot.ts';

type Envelope = { seq: number; command: string; inputs?: number[][] };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(directory?: string) {
  let time = 0, foreground = true, stopped = false, busy = false, game = createCampaignGame(); game.mode = 'running';
  const actor = { id: 'fixture-player', communityId: 'fixture-community', name: 'Тестовый участник' };
  const registry = createRegistry({ communityId: actor.communityId, now: () => time, directory });
  const ticket = registry.join({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }, actor);
  const sent: Envelope[] = [], errors: string[] = [], acknowledgements: LiveAck[] = [];
  let hold: (body: Envelope, ack: LiveAck) => boolean = () => false, release: (() => void) | undefined, prepare: () => Promise<void> = async () => {};
  const connection = createRaceTransport(ticket, ack => { acknowledgements.push(ack); control.acknowledge(ack.player); }, message => { errors.push(message); stopped = true; }, async (_path, input) => {
    const body = input as Envelope; sent.push(structuredClone(body));
    const ack = registry.command(ticket.id, ticket.token, body, actor);
    if (hold(body, ack)) await new Promise<void>(resolve => { release = resolve; });
    return ack;
  });
  const control = createRaceControl({ game: () => game, replace: value => { game = value; }, connection: () => connection, foreground: () => foreground, prepareResume: () => prepare(), stopped: () => stopped, canPause: () => true, changed() {}, pending: value => { busy = value; } });
  const drive = async (fail = false) => {
    let landed = 0, ticks = 0;
    for (; ticks < 12000 && game.mode === 'running'; ticks++) {
      const target = fail ? 12 : pilotTarget(game, landed, false);
      const direction = Math.round(Math.max(-1, Math.min(1, (target - game.ball.x) / (250 * FIXED_STEP))) * 100) / 100;
      assert.ok(connection.canStep() && control.canStep());
      connection.record(direction); stepGame(game, direction); time += FIXED_STEP * 1000;
      for (const event of drainEvents(game)) if (event.type === 'landing') landed = Number(event.id);
      if (game.mode === 'running' && ticks % 60 === 59) await connection.flush();
    }
    assert.equal(game.mode, fail ? 'over' : 'complete');
    const pending = connection.flush(); await settle(); return { pending, ticks };
  };
  return { registry, connection, control, drive, sent, errors, acknowledgements,
    get game() { return game; }, get busy() { return busy; }, advance: (ms: number) => { time += ms; }, focus: (value: boolean) => { foreground = value; },
    hold: (fn: typeof hold) => { hold = fn; }, release: () => { assert.ok(release); const fn = release; release = undefined; hold = () => false; fn(); }, prepare: (fn: typeof prepare) => { prepare = fn; },
  };
}

for (const fail of [false, true]) test(`server ${fail ? 'failure' : 'first 190m checkpoint'} ACK discards only unsent prediction tail and keeps waiting heartbeat valid`, async () => {
  const h = harness(); h.hold((body, ack) => body.command === 'inputs' && ack.player.game.mode === (fail ? 'over' : 'complete'));
  const terminal = await h.drive(fail);
  if (!fail) assert.equal(h.game.score, 190);
  // Fault injection: a predictor can still be running until the terminal ACK.
  h.connection.record(0.4); h.release(); await terminal.pending;
  assert.equal(h.connection.canStep(), false); h.connection.record(-0.4);
  for (let i = 0; i < 3; i++) { h.advance(6000); await h.connection.flush(); assert.deepEqual(h.sent.at(-1)!.inputs, []); }
  assert.equal(h.registry.board().players.length, 1); assert.deepEqual(h.errors, []);
  const previous = h.sent.at(-1)!.seq;
  const next = h.control.command(fail ? 'retry' : 'advance'); assert.equal(h.connection.canStep(), false); await next;
  assert.equal(h.sent.at(-1)!.seq, previous + 1); assert.equal(h.game.mode, 'running'); assert.equal(h.connection.canStep(), true);
  h.connection.dispose();
});

for (const fail of [false, true]) test(`terminal ACK during local pause resumes the canonical ${fail ? 'over' : 'complete'} mode`, async () => {
  const h = harness(); h.hold((body, ack) => body.command === 'inputs' && ack.player.game.mode === (fail ? 'over' : 'complete'));
  const terminal = await h.drive(fail);
  h.game.mode = 'running'; // Predictor hasn't recognized the server's terminal state.
  const pausing = h.control.pause(); assert.equal(h.game.mode, 'paused');
  h.release(); await terminal.pending; await pausing;
  await h.control.command('resume');
  assert.equal(h.game.mode, fail ? 'over' : 'complete'); assert.equal(h.connection.canStep(), false); assert.deepEqual(h.errors, []);
  h.connection.dispose();
});

for (const fail of [false, true]) test(`blur while ${fail ? 'retry' : 'advance'} is in flight pauses the new game before prediction reopens`, async () => {
  const h = harness(); await (await h.drive(fail)).pending;
  const action = fail ? 'retry' : 'advance'; h.hold(body => body.command === action);
  const transition = h.control.command(action); await settle();
  h.focus(false); const pausing = h.control.pause();
  assert.equal(h.control.canStep(), false); h.connection.record(1); void h.connection.flush();
  h.release(); await transition; await pausing;
  assert.equal(h.game.mode, 'paused'); assert.equal(h.game.campaign!.section, fail ? 0 : 1);
  assert.equal(h.registry.board().players[0].state, 'paused'); assert.equal(h.connection.canStep(), false);
  h.focus(true); await h.control.command('resume'); assert.equal(h.game.mode, 'running'); assert.ok(h.connection.canStep() && h.control.canStep()); assert.deepEqual(h.errors, []);
  h.connection.dispose();
});

test('hiding during sensor calibration leaves the server paused and requires another explicit resume', async () => {
  const h = harness(); await h.control.pause(); let release: (() => void) | undefined;
  h.prepare(() => new Promise(resolve => { release = resolve; }));
  const resuming = h.control.command('resume'); await settle(); h.focus(false); void h.control.pause(); release!(); await resuming;
  assert.ok(!h.sent.some(body => body.command === 'resume')); assert.equal(h.game.mode, 'paused'); assert.equal(h.registry.board().players[0].state, 'paused');
  h.focus(true); h.prepare(async () => {}); await h.control.command('resume'); assert.ok(h.control.canStep() && h.connection.canStep()); h.connection.dispose();
});

test('hiding during resume acknowledgement applies a new pause before admitting input', async () => {
  const h = harness(); await h.control.pause(); h.hold(body => body.command === 'resume');
  const resuming = h.control.command('resume'); await settle(); h.focus(false); void h.control.pause();
  h.release(); await resuming;
  assert.equal(h.game.mode, 'paused'); assert.equal(h.registry.board().players[0].state, 'paused');
  assert.deepEqual(h.sent.map(body => body.command), ['pause', 'resume', 'pause']); assert.deepEqual(h.errors, []); h.connection.dispose();
});

test('duplicate transition taps admit only one command and disposal cannot publish a new game', async () => {
  const h = harness(); await (await h.drive()).pending; h.hold(body => body.command === 'advance');
  const first = h.control.command('advance'), duplicate = h.control.command('advance'); await settle();
  assert.equal(h.sent.filter(body => body.command === 'advance').length, 1);
  h.control.dispose(); h.connection.dispose(); h.release(); await first; await duplicate;
  assert.equal(h.game.campaign!.section, 0); assert.equal(h.game.mode, 'complete'); assert.equal(h.control.canStep(), false);
});

test('all 33 sections cross actual transport/control/registry boundaries and save the verified finish', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-control-'));
  try {
    const h = harness(directory);
    for (let part = 0; part < 33; part++) {
      await (await h.drive()).pending;
      if (part < 32) await h.control.command('advance'); else await h.control.command('finish');
    }
    assert.deepEqual(h.errors, []); assert.equal(h.registry.board().results.length, 1); assert.ok(h.acknowledgements.at(-1)!.result);
    assert.deepEqual(h.sent.map(body => body.seq), h.sent.map((_, index) => index + 1)); h.connection.dispose();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
