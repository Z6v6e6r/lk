import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { createCampaignGame, drainEvents, stepGame } from '../../src/components/padel-jump/engine.ts';
import { createRaceTransport } from '../../src/components/padel-jump/race-connection.ts';
import type { LiveAck } from '../../src/components/padel-jump/race-connection.ts';
import { predictRaceAcknowledgement, restoreRaceSnapshot } from '../../src/components/padel-jump/race-prediction.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_SYNC } from '../../src/components/padel-jump/live-contract.ts';

const body = () => ({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE });
const actor = { id: 'fixture-private-id', name: 'Проверенный игрок', communityId: 'fixture-community' };
const registry = () => createRegistry({ communityId: actor.communityId });

test('full own snapshots are detached; both public slots remain filtered and exclude private identity/capability', () => {
  const r = registry(), tickets = [r.join(body(), actor), r.join(body(), { ...actor, id: 'fixture-private-second' })];
  for (const ticket of tickets) {
    assert.equal(ticket.sync, LIVE_SYNC); assert.equal(ticket.player.game.platforms.length, createCampaignGame().platforms.length);
    const publicPlayer = r.board().players.find(p => p.id === ticket.id)!;
    assert.ok(publicPlayer.game.platforms.length < ticket.player.game.platforms.length);
    assert.ok(publicPlayer.game.platforms.every(p => p.y <= publicPlayer.game.camera + 770));
    ticket.player.game.ball.x = -999; ticket.player.game.platforms.length = 0;
    const command = { seq: 1, command: 'inputs', inputs: [] };
    const ack = r.command(ticket.id, ticket.token, command, { ...actor, id: ticket === tickets[0] ? actor.id : 'fixture-private-second' });
    assert.ok(ack.player.game.ball.x > 0 && ack.player.game.platforms.length > 0);
    const prior = JSON.stringify(ack);
    const prediction = predictRaceAcknowledgement(ack.player, [[0, 2]]); prediction.game.platforms.length = 0;
    assert.equal(JSON.stringify(r.command(ticket.id, ticket.token, command, { ...actor, id: ticket === tickets[0] ? actor.id : 'fixture-private-second' })), prior);
  }
  const publicState = JSON.stringify(r.board());
  for (const secret of [actor.id, 'fixture-private-second', actor.communityId, ...tickets.map(t => t.token)]) assert.ok(!publicState.includes(secret));
  assert.throws(() => r.command(tickets[0].id, tickets[1].token, { seq: 2, command: 'inputs', inputs: [] }, actor), /RUN_ACCESS_DENIED/);
});

test('full prediction preserves tall offscreen glass contact, including already broken panels', () => {
  for (const broken of [false, true]) {
    const game = createCampaignGame(4, 0); game.mode = 'running'; game.camera = 549; game.peak = 800;
    game.ball = { x: 12, y: 559, vx: 0, vy: -100 };
    game.campaign!.glass = [{ id: 1, side: -1, y: 409, h: 160, broken }];
    game.campaign!.drops = []; game.campaign!.admins = []; game.campaign!.metals = []; game.campaign!.boosters = [];
    const authoritative = structuredClone(game); stepGame(authoritative, 0); drainEvents(authoritative);
    const snapshot = restoreRaceSnapshot(game), r = registry(), ticket = r.join(body(), actor);
    const predicted = predictRaceAcknowledgement({ ...ticket.player, game: snapshot }, [[0, 1]]);
    assert.deepEqual(predicted.game, authoritative); assert.equal(game.campaign!.glass[0].broken, broken);
    assert.equal(predicted.game.boost > 0, !broken);
    const trimmed = structuredClone(game); trimmed.campaign!.glass = []; stepGame(trimmed, 0);
    if (!broken) assert.notEqual(predicted.game.ball.vy, trimmed.ball.vy);
  }
});

test('ACK identity, sequence and full-state marker mismatch stop transport before a rebase', async () => {
  for (const change of [
    (ack: LiveAck) => { delete (ack as Partial<LiveAck>).sync; },
    (ack: LiveAck) => { (ack as { sync: string }).sync = 'old'; },
    (ack: LiveAck) => { ack.seq++; },
    (ack: LiveAck) => { ack.player.id = 'another-run'; },
    (ack: LiveAck) => { ack.player.livesRemaining = 6; },
    (ack: LiveAck) => { ack.player.state = 'eliminated'; },
  ]) {
    const r = registry(), ticket = r.join(body(), actor), errors: string[] = []; let acknowledgements = 0;
    const connection = createRaceTransport(ticket, () => { acknowledgements++; }, message => errors.push(message), async () => {
      const ack = r.command(ticket.id, ticket.token, { seq: 1, command: 'inputs', inputs: [] }, actor); change(ack); return ack;
    });
    await connection.flush(); assert.equal(acknowledgements, 0); assert.equal(errors.length, 1); assert.equal(connection.canStep(), false); connection.dispose();
  }
});

test('premature finish command leaves running prediction available and sends no invalid envelope', async () => {
  const r = registry(), ticket = r.join(body(), actor), errors: string[] = []; let sent = 0;
  const connection = createRaceTransport(ticket, () => {}, message => errors.push(message), async () => { sent++; throw new Error('must not send'); });
  assert.equal(await connection.command('finish'), false); assert.equal(connection.canStep(), true); assert.equal(sent, 0); assert.deepEqual(errors, []); connection.dispose();
});

test('delayed running ACK rebases mixed unsent input and sends that tail exactly once', async () => {
  const r = registry(), ticket = r.join(body(), actor), errors: string[] = [], sent: { seq: number; command: string; inputs?: number[][] }[] = [];
  let release!: () => void, started!: () => void, latest!: LiveAck;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const connection = createRaceTransport(ticket, ack => { latest = ack; }, message => errors.push(message), async (_path, input) => {
    const envelope = input as typeof sent[number]; sent.push(structuredClone(envelope));
    const ack = r.command(ticket.id, ticket.token, envelope, actor);
    if (envelope.seq === 1) { started(); await new Promise<void>(resolve => { release = resolve; }); }
    return ack;
  });
  connection.record(0.3); const flushing = connection.flush(); await waiting;
  for (const direction of [0.5, 0.5, -0.7, 0, 0]) connection.record(direction);
  const canonical = structuredClone(ticket.player.game); stepGame(canonical, 0.3); drainEvents(canonical);
  const expected = predictRaceAcknowledgement({ ...ticket.player, game: canonical }, [[50, 2], [-70, 1], [0, 2]]);
  release(); await flushing; assert.deepEqual(latest.prediction, expected.game);
  await connection.flush(); assert.deepEqual(sent[1].inputs, expected.inputs); assert.deepEqual(latest.player.game, expected.game);
  await connection.flush(); assert.deepEqual(sent[2].inputs, []); assert.deepEqual(latest.player.game, expected.game); assert.deepEqual(errors, []); connection.dispose();
});

test('complete snapshots across all authored sections stay bounded for mobile ACKs', () => {
  let largest = 0;
  for (let station = 0; station < 11; station++) for (let section = 0; section < 3; section++) {
    const game = createCampaignGame(station, section); largest = Math.max(largest, Buffer.byteLength(JSON.stringify(game)));
    assert.ok(game.platforms.length <= 43);
  }
  assert.ok(largest < 40000, `largest full snapshot ${largest} bytes`);
});
