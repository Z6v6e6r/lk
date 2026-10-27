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

test('retired confirmed finals remain recoverable without consuming another viewer cursor', () => {
  const { ticket } = fixture(); let now = 0;
  const channel = createSpectatorChannel({ now: () => now });
  channel.capture(ticket.player, 0);
  const finished = { ...ticket.player, state: 'finished', elapsedMs: 61234, stars: 7 };
  now = 500; channel.capture(finished, 1); channel.remove(ticket.id);
  const board = { players: [], results: [] };
  const first = channel.read({ runs: [ticket.id] }, board);
  assert.equal(first.poses.length, 1, 'removing a run cannot erase its undelivered durable final');
  assert.equal(first.poses[0].status, 'finished');
  assert.equal(first.poses[0].elapsedMs, 61234);
  assert.equal(first.events.length, 1);
  assert.equal(channel.read({ runs: [ticket.id], acks: { [ticket.id]: 1 } }, board).events.length, 0);
  assert.equal(channel.read({ runs: [ticket.id] }, board).events.length, 1);
  now = 30501;
  assert.equal(channel.read({ runs: [ticket.id] }, board).poses.length, 0);
  assert.equal(channel.stats().runs, 0);
});

test('legacy SSE serializes no board without viewers and resumes its existing cadence for a reader', async () => {
  let reads = 0;
  const server = createLiveServer({ registry: { board: () => ({ testRead: ++reads }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(reads, 0, 'the new polling wall must not pay for unused legacy SSE serialization');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/jump-live-api/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.ok(new TextDecoder().decode((await reader.read()).value).includes('testRead'));
    await reader.read(); assert.ok(reads >= 2);
  } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('removed platforms use absolute presence overlays without repeating immutable geometry', () => {
  const { ticket } = fixture(); let now = 0;
  const channel = createSpectatorChannel({ now: () => now });
  channel.capture(ticket.player, 0);
  const initial = channel.read({ runs: [ticket.id] }, { players: [ticket.player], results: [] });
  const player = structuredClone(ticket.player); player.game.platforms.splice(1, 1);
  now = 500; channel.capture(player, 1);
  const next = channel.read({ runs: [ticket.id], scenes: { [ticket.id]: initial.poses[0].segmentId }, fresh: true }, { players: [player], results: [] });
  assert.deepEqual(applySceneDelta(initial.scenes[ticket.id].game, next.poses[0].changes), player.game);
  assert.ok(!JSON.stringify(next.poses).includes('"kind"'), 'a removed racket must not resend the remaining full map every pose');
  assert.deepEqual(next.scenes, {});
});

test('a projection-only clone failure cannot corrupt a committed command ACK or its identical retry', () => {
  const { registry, ticket, actor } = fixture();
  const original = globalThis.structuredClone; let calls = 0, ack;
  globalThis.structuredClone = (...args) => {
    if (++calls === 3) throw new Error('INJECTED_SPECTATOR_FAILURE');
    return original(...args);
  };
  const body = { seq: 1, command: 'pause' };
  try { assert.doesNotThrow(() => { ack = registry.command(ticket.id, ticket.token, body, actor); }); }
  finally { globalThis.structuredClone = original; }
  assert.equal(ack.seq, 1); assert.equal(ack.player.state, 'paused');
  assert.deepEqual(registry.command(ticket.id, ticket.token, body, actor), ack);
  const failed = registry.spectator({ runs: [ticket.id] });
  assert.deepEqual(failed.poses, []); assert.ok(failed.gaps.includes(ticket.id));
  registry.command(ticket.id, ticket.token, { seq: 2, command: 'resume' }, actor);
  const recovered = registry.spectator({ runs: [ticket.id], fresh: true });
  assert.equal(recovered.poses[0].phase, 'playing');
  assert.ok(recovered.baselines[ticket.id] > 0);
});

test('a failed optional join projection cannot lose the newly allocated capability', () => {
  const original = globalThis.structuredClone; let calls = 0, state;
  globalThis.structuredClone = (...args) => {
    if (++calls === 2) throw new Error('INJECTED_JOIN_PROJECTION_FAILURE');
    return original(...args);
  };
  try { assert.doesNotThrow(() => { state = fixture(); }); }
  finally { globalThis.structuredClone = original; }
  assert.equal(typeof state.ticket.token, 'string');
  assert.equal(state.registry.command(state.ticket.id, state.ticket.token, { seq: 1, command: 'pause' }, state.actor).player.state, 'paused');
});
