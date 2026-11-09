import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
import { stepGame, drainEvents, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';
const event = { epoch: '2026-11-09T09:00:00.000Z', policyRevision: 2, startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionUntil: '2027-11-13T21:00:00.000Z', inviteCode: 'fixture-invite' };
const actor = { id: 'fixture-player', name: 'Verified Player', communityId: 'fixture-event', eventEpoch: event.epoch, policyRevision: 2 };
const body = { consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE };
test('exhibition starts only inside its exact window and only for the pinned activation/policy', () => {
  let at = Date.parse(event.startsAt) - 1;
  const registry = createRegistry({ communityId: actor.communityId, event, wall: () => at });
  assert.throws(() => registry.join(body, actor), /EVENT_CLOSED/);
  at++;
  assert.throws(() => registry.join(body, { ...actor, policyRevision: 1 }), /EVENT_BINDING_CHANGED/);
  assert.throws(() => registry.join(body, { ...actor, eventEpoch: 'old' }), /EVENT_BINDING_CHANGED/);
  const ticket = registry.join(body, actor); assert.equal(ticket.player.livesRemaining, 5);
  at = Date.parse(event.endsAt);
  assert.throws(() => registry.command(ticket.id, ticket.token, { seq: 1, command: 'inputs', inputs: [] }, actor), /EVENT_CLOSED/);
  assert.throws(() => registry.join(body, { ...actor, id: 'other' }), /EVENT_CLOSED/);
});
test('exhibition result reads are activation/policy isolated and stop at retention without pruning team or event files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-event-results-'));
  try {
    let at = Date.parse(event.endsAt) + 1000;
    const common = { alias: 'Verified Player', communityId: actor.communityId, actorId: actor.id, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, elapsedMs: 1000, playMs: 900, failures: 5, stars: 5, finishedAt: event.endsAt };
    for (const [index, fields] of [{ eventEpoch: event.epoch, policyRevision: 2, retentionUntil: event.retentionUntil }, { eventEpoch: 'old', policyRevision: 1, retentionUntil: event.retentionUntil }, {}].entries()) {
      const id = randomUUID(); writeFileSync(join(directory, id + '.json'), JSON.stringify({ ...common, actorId: index ? 'fixture-other-' + index : actor.id, id, ...fields }), { mode: 0o600 });
    }
    const registry = createRegistry({ directory, communityId: actor.communityId, event, wall: () => at });
    assert.equal(registry.board().results.length, 1);
    assert.equal(registry.communityRanking(actor, { allTime: true }).total, 1);
    at = Date.parse(event.retentionUntil);
    assert.equal(registry.board().results.length, 0);
    assert.throws(() => registry.communityRanking(actor, { allTime: true }), /EVENT_DATA_EXPIRED/);
    assert.equal(readdirSync(directory).length, 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const expires of [false, true]) test(expires ? 'pending terminal save is denied at the exact ten-minute closing cutoff' : 'accepted terminal finish survives closing and a failed durable save without accepting late play', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-event-finish-'));
  try {
    let at = Date.parse(event.endsAt) - 1, time = 0, seq = 0;
    const registry = createRegistry({ directory, communityId: actor.communityId, event, wall: () => at, now: () => time });
    const ticket = registry.join(body, actor);
    const send = (command: string, inputs?: number[][]) => registry.command(ticket.id, ticket.token, { seq: ++seq, command, ...(inputs ? { inputs } : {}) }, actor);
    let terminal;
    for (let loss = 0; loss < 5; loss++) {
      const game = structuredClone(send('inputs', []).player.game); let count = 0;
      for (let tick = 0; tick < 1200 && game.mode === 'running'; tick++) {
        stepGame(game, -1); drainEvents(game); time += FIXED_STEP * 1000; count++;
        if (count === 60 || game.mode !== 'running') { terminal = send('inputs', [[-100, count]]); count = 0; }
      }
      assert.equal(game.mode, 'over'); if (loss < 4) send('retry');
    }
    assert.equal(terminal.player.state, 'eliminated');
    at = Date.parse(event.endsAt) + 1;
    assert.throws(() => registry.command(ticket.id, ticket.token, { seq: seq + 1, command: 'retry' }, actor), /EVENT_CLOSED/);
    const collision = join(directory, ticket.id + '.json'); mkdirSync(collision);
    const finish = { seq: seq + 1, command: 'finish' };
    assert.throws(() => registry.command(ticket.id, ticket.token, finish, actor));
    assert.equal(registry.board().results.length, 0);
    rmSync(collision, { recursive: true });
    at += 1000;
    if (expires) {
      at = Date.parse(event.endsAt) + 600000;
      assert.throws(() => registry.command(ticket.id, ticket.token, finish, actor), /EVENT_CLOSED/);
      assert.equal(registry.board().results.length, 0); assert.equal(readdirSync(directory).length, 0); return;
    }
    const saved = registry.command(ticket.id, ticket.token, finish, actor);
    assert.equal(saved.result.elapsedMs, terminal.player.elapsedMs); assert.equal(saved.result.stars, terminal.player.stars);
    assert.deepEqual(registry.command(ticket.id, ticket.token, finish, actor), saved);
    const receipt = JSON.parse(readFileSync(collision, 'utf8'));
    assert.equal(receipt.eventEpoch, event.epoch); assert.equal(receipt.policyRevision, 2); assert.equal(receipt.retentionUntil, event.retentionUntil);
    assert.equal(receipt.terminalAt, new Date(Date.parse(event.endsAt) - 1).toISOString());
    assert.equal(createRegistry({ directory, communityId: actor.communityId, event, wall: () => at }).board().results.length, 1);
    at = Date.parse(event.retentionUntil);
    assert.equal(registry.board().players.length, 0); assert.equal(registry.board().results.length, 0);
    assert.throws(() => registry.spectator({ runs: [ticket.id], fresh: true }), /EVENT_DATA_EXPIRED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
