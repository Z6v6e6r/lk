import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_LIVES } from '../../src/components/padel-jump/live-contract.ts';
import { createSpectatorChannel } from '../../games/padel-jump/live/spectator.mjs';
import { applySceneDelta } from '../../src/components/padel-jump/spectator/state.mjs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';

function fixture() {
  let now = 0;
  const registry = createRegistry({ communityId: 'test-community', now: () => now });
  const actor = { id: 'private-profile-test', name: 'Игрок тест', communityId: 'test-community' };
  const ticket = registry.join({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }, actor);
  return { registry, ticket, actor, tick: ms => { now += ms; } };
}

test('spectator read negotiates compact state, stable source clock and separate immutable catalog', () => {
  const { registry, ticket, tick } = fixture();
  assert.equal(typeof registry.spectator, 'function', 'registry must expose the additive spectator projection');
  const initial = registry.spectator({ runs: [ticket.id] });
  assert.equal(initial.schema, 'jump-spectator-v1');
  assert.equal(initial.sourceNow, 0);
  assert.equal(initial.catalog.players[0].initialLives, LIVE_LIVES);
  assert.equal(initial.catalog.players[0].name, 'Игрок тест');
  assert.ok(initial.scenes[ticket.id]);
  assert.equal(initial.poses[0].runId, ticket.id);
  assert.equal(initial.poses[0].score, 0);
  const wire = JSON.stringify(initial);
  for (const secret of [ticket.token, 'private-profile-test', 'actorId', 'communityId']) assert.ok(!wire.includes(secret));
  tick(500);
  const next = registry.spectator({ runs: [ticket.id], catalog: initial.catalogVersion, scenes: { [ticket.id]: initial.poses[0].segmentId } });
  assert.equal(next.catalog, undefined);
  assert.deepEqual(next.scenes, {});
  assert.equal(next.sourceNow, 500);
  assert.ok(!JSON.stringify(next.poses).includes('platforms'));
  assert.deepEqual(initial.scenes[ticket.id].game, ticket.player.game);
  assert.deepEqual(registry.board().players[0].game.ball, ticket.player.game.ball);
});

test('reliable transitions bypass pose coalescing and replay until acknowledged', () => {
  const { ticket } = fixture(); let now = 0;
  const channel = createSpectatorChannel({ now: () => now });
  const player = structuredClone(ticket.player);
  const board = () => ({ players: [player], results: [] });
  channel.capture(structuredClone(player), 0);
  channel.read({ runs: [player.id] }, board());
  now = 50; player.game.ball.x = 150; channel.capture(structuredClone(player), 1);
  now = 100; player.state = 'retry'; player.failures = 1; player.livesRemaining = 4; player.game.mode = 'over';
  channel.capture(structuredClone(player), 2);
  const first = channel.read({ runs: [player.id] }, board());
  assert.equal(first.poses[0].seq, 2, 'a critical transition cannot be blocked by the pose rate limit');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].eventId, player.id + ':1');
  assert.equal(first.poses[0].segmentId, first.scenes[player.id].segmentId);
  assert.deepEqual(applySceneDelta(first.scenes[player.id].game, first.poses[0].changes), player.game);
  assert.deepEqual(channel.read({ runs: [player.id] }, board()).events, first.events);
  assert.deepEqual(channel.read({ runs: [player.id], acks: { [player.id]: 1 } }, board()).events, []);
});

test('existing public board negotiates spectator without changing legacy response or opening writes', async () => {
  const { registry, ticket } = fixture();
  const server = createLiveServer({ registry });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/jump-live-api/board`;
  try {
    const response = await fetch(base + '?spectator=1&runs=' + ticket.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const packet = await response.json();
    assert.equal(packet.schema, 'jump-spectator-v1');
    assert.equal(packet.poses.length, 1);
    assert.ok(Array.isArray((await (await fetch(base)).json()).players));
    assert.equal((await fetch(base + '?spectator=1&profile=invalid')).status, 422);
    assert.equal((await fetch(base + '?spectator=1&runs=' + Array(5).fill(ticket.id).join(','))).status, 422);
    assert.equal((await fetch(base + '?spectator=1&acks=bad-json')).status, 422);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('expired runs release spectator journals even when nobody requests spectator data', () => {
  let now = 0;
  const registry = createRegistry({ communityId: 'test-community', now: () => now });
  assert.equal(typeof registry.spectatorStats, 'function', 'bounded spectator retention needs independently testable diagnostics');
  for (let i = 0; i < 100; i++) {
    registry.join({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }, { id: 'test-' + i, name: 'Тест', communityId: 'test-community' });
    assert.equal(registry.spectatorStats().runs, 1);
    now += 10001; registry.board();
    assert.equal(registry.spectatorStats().runs, 0);
  }
});
