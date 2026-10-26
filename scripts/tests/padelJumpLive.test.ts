import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { createIdentityVerifier } from '../../games/padel-jump/live/identity.mjs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE, LIVE_SYNC, formatRaceTime } from '../../src/components/padel-jump/live-contract.ts';
import { createCampaignGame, stepGame, drainEvents, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';
import { readyRaceTilt } from '../../src/components/padel-jump/race-tilt.ts';
import { createTiltController } from '../../src/components/padel-jump/tilt.ts';
import { pilotTarget } from './helpers/padelJumpPilot.ts';

let fixtureId = 0;
const actor = (name = 'Тестовый профиль') => ({ id: 'test-member-' + ++fixtureId, name, communityId: 'test-community' });
const body = () => ({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE });
function harness(directory?: string) {
  let time = 0; const registry = createRegistry({ communityId: 'test-community', now: () => time, wall: () => 1800000000000 + time, directory });
  const identity = actor(), ticket = registry.join(body(), identity); let seq = 0;
  return { registry, ticket, identity, advance: (ms: number) => { time += ms; }, command: (command: string, inputs?: number[][]) => registry.command(ticket.id, ticket.token, { seq: ++seq, command, ...(inputs ? { inputs } : {}) }, identity) };
}

test('campaign replay version pins every simulation source, separately from existing endless events', () => {
  const hash = createHash('sha256');
  for (const name of ['campaign.ts', 'level-layout.ts', 'engine.ts']) hash.update(name + '\0').update(readFileSync(new URL('../../src/components/padel-jump/' + name, import.meta.url)));
  assert.equal(hash.digest('hex'), LIVE_ENGINE_VERSION);
  assert.equal(formatRaceTime(61234), '01:01.2'); assert.equal(formatRaceTime(Infinity), '00:00.0');
});
test('twelve stable slots, no private token on public board, stale participants disappear', () => {
  let time = 0; const r = createRegistry({ communityId: 'test-community', now: () => time });
  const tickets = Array.from({ length: 12 }, (_, i) => r.join(body(), actor('Тестовый профиль ' + i)));
  assert.deepEqual(r.board().players.map(p => p.slot), Array.from({ length: 12 }, (_, i) => i));
  assert.throws(() => r.join(body(), actor()), /EVENT_FULL/);
  assert.ok(tickets.every(t => !JSON.stringify(r.board()).includes(t.token)));
  time = 10001; assert.equal(r.board().players.length, 0); assert.throws(() => r.command(tickets[0].id, tickets[0].token, { seq: 1, command: 'inputs', inputs: [] }, actor()), /RUN_ACCESS_DENIED/);
  assert.equal(r.join(body(), actor()).player.slot, 0);
});
test('display consent, alias and exact rule are required; client identity/score/time cannot be submitted', () => {
  const r = createRegistry({ communityId: 'test-community' });
  for (const b of [{ ...body(), consent: false }, { ...body(), alias: '<script>' }, { ...body(), alias: 'a\n' }, { ...body(), alias: 'x'.repeat(25) }, { ...body(), engine: 'old' }, { ...body(), score: 1000 }, { ...body(), playerId: 'someone' }]) assert.throws(() => r.join(b));
  const h = harness(); assert.throws(() => h.registry.command(h.ticket.id, '0'.repeat(64), { seq: 1, command: 'finish' }, h.identity), /RUN_ACCESS_DENIED/);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'inputs', inputs: [], elapsedMs: 1 }, h.identity), /COMMAND_INVALID/);
});
test('input commands are atomic, ordered and idempotent; fast-forward and malformed input fail closed', () => {
  const h = harness(); h.advance(500);
  const payload = { seq: 1, command: 'inputs', inputs: [[0, 60]] };
  const ack = h.registry.command(h.ticket.id, h.ticket.token, payload, h.identity);
  assert.deepEqual(h.registry.command(h.ticket.id, h.ticket.token, payload, h.identity), ack);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { ...payload, inputs: [[1, 60]] }, h.identity), /SEQUENCE_CONFLICT/);
  const prior = h.registry.board().players[0].game;
  for (const inputs of [[[0, 241]], [[NaN, 1]], [[0, 1], [0, -1]], [[101, 1]], [[0, 120], [0, 120], [0, 1]]]) assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 2, command: 'inputs', inputs }, h.identity));
  assert.deepEqual(h.registry.board().players[0].game, prior);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 2, command: 'inputs', inputs: [[0, 120]] }, h.identity), /REPLAY_TOO_FAST/);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 2, command: 'advance' }, h.identity), /CHECKPOINT_NOT_READY/);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 2, command: 'finish' }, h.identity), /FINISH_NOT_VERIFIED/);
});
test('time includes repeated attempts and transitions; pause freezes server elapsed and rejects gameplay input', () => {
  const h = harness(); h.advance(700); h.command('inputs', []); h.command('pause'); h.advance(3000);
  assert.equal(h.registry.board().players[0].elapsedMs, 700);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 3, command: 'inputs', inputs: [[0, 1]] }, h.identity), /INPUTS_NOT_RUNNING/);
  h.command('resume'); h.advance(600); h.command('inputs', []);
  assert.equal(h.registry.board().players[0].elapsedMs, 1300);
});

test('a repeated retry envelope is idempotent and clears the old failure without resetting run accounting', () => {
  const h = harness(), game = createCampaignGame(); game.mode = 'running'; let ack;
  for (let tick = 0; tick < 1200 && game.mode === 'running'; tick++) {
    stepGame(game, -1); drainEvents(game); h.advance(FIXED_STEP * 1000); ack = h.command('inputs', [[-100, 1]]);
  }
  assert.equal(game.mode, 'over'); assert.equal(ack.player.failures, 1); const previous = ack.player;
  const retry = h.command('retry'); assert.equal(retry.player.game.failure, undefined); assert.equal(retry.player.failures, 1);
  assert.equal(retry.player.playMs, previous.playMs); assert.ok(retry.player.elapsedMs >= previous.elapsedMs);
  assert.deepEqual(h.registry.command(h.ticket.id, h.ticket.token, { seq: retry.seq, command: 'retry' }, h.identity), retry);
  h.advance(FIXED_STEP * 1000); const next = h.command('inputs', [[0, 1]]);
  assert.equal(next.seq, retry.seq + 1); assert.equal(next.player.failures, 1); assert.ok(next.player.game.ball.y > retry.player.game.ball.y);
});

test('all 33 parts finish via real quantized input, persist once and survive server restart; fabricated finish is rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-live-'));
  try {
    const h = harness(directory); let finalAck;
    for (let station = 0; station < 11; station++) for (let section = 0; section < 3; section++) {
      const g = createCampaignGame(station, section); g.mode = 'running'; let landed = 0, total = 0, blocks: number[][] = [];
      for (let tick = 0; tick < 12000 && g.mode === 'running'; tick++) {
        const target = pilotTarget(g, landed, false), direction = Math.round(Math.max(-1, Math.min(1, (target - g.ball.x) / (250 * FIXED_STEP))) * 100);
        const last = blocks.at(-1); if (last?.[0] === direction && last[1] < 120) last[1]++; else blocks.push([direction, 1]);
        stepGame(g, direction / 100); for (const e of drainEvents(g)) if (e.type === 'landing') landed = Number(e.id);
        total++;
        if (total === 60 || g.mode !== 'running') { h.advance(total * FIXED_STEP * 1000); finalAck = h.command('inputs', blocks); blocks = []; total = 0; }
      }
      assert.equal(g.mode, 'complete', `${station}:${section}`); assert.equal(finalAck.player.game.mode, 'complete');
      if (station < 10 || section < 2) { h.advance(500); h.command('advance'); }
    }
    const stoppedAt = h.registry.board().players[0].elapsedMs; h.advance(5000);
    assert.equal(h.registry.board().players[0].elapsedMs, stoppedAt);
    const result = h.command('finish').result; assert.equal(result.elapsedMs, stoppedAt); assert.equal(result.engine, LIVE_ENGINE_VERSION); assert.ok(result.elapsedMs >= result.playMs); assert.equal(h.registry.board().results.length, 1);
    assert.equal(readdirSync(directory).length, 1);
    const restored = createRegistry({ communityId: 'test-community', directory, wall: () => Date.parse(result.finishedAt) + 1000 });
    assert.deepEqual(restored.board().results[0], result); assert.equal(restored.board().players.length, 0);
    assert.throws(() => restored.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'finish' }), /RUN_ACCESS_DENIED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('HTTP endpoint isolates capabilities, rejects cross-origin writes and exposes safe board only', async () => {
  const identity = actor(); const server = createLiveServer({ origin: 'http://127.0.0.1:5192', communityId: 'test-community', authenticate: async () => identity }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/jump-live-api/`;
  try {
    const headers = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5192' };
    assert.equal((await fetch(base + 'runs', { method: 'POST', headers: { ...headers, Origin: 'https://other.test' }, body: JSON.stringify(body()) })).status, 403);
    assert.equal((await fetch(base + 'runs', { method: 'POST', headers, body: '{' })).status, 400);
    const response = await fetch(base + 'runs', { method: 'POST', headers, body: JSON.stringify(body()) }); assert.equal(response.status, 201); const ticket = await response.json();
    assert.equal((await fetch(base + 'runs/' + ticket.id, { method: 'POST', headers, body: JSON.stringify({ seq: 1, command: 'pause' }) })).status, 403);
    const board = await fetch(base + 'board'); assert.equal(board.headers.get('cache-control'), 'no-store'); assert.ok(!(await board.text()).includes(ticket.token));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('denied and missing sensors keep manual race start and resume available', async () => {
  for (const status of ['denied', 'unavailable'] as const) {
    const subscribers = new Set<(status: string) => void>();
    const tilt = { subscribe(fn: (status: string) => void) { subscribers.add(fn); fn(status); return () => { subscribers.delete(fn); }; },
      enable: async () => { for (const fn of subscribers) fn(status); }, recalibrate: () => {}, disable: () => {} };
    await readyRaceTilt(tilt as unknown as ReturnType<typeof createTiltController>, true);
    await readyRaceTilt(tilt as unknown as ReturnType<typeof createTiltController>, false);
    assert.equal(subscribers.size, 0);
  }
});

test('48-hour retention releases result capacity and deletes only expired owned result files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-live-retention-')); let wall = 1800000000000;
  try {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID(); writeFileSync(join(directory, id + '.json'), JSON.stringify({ id, alias: 'Тестовый профиль', actorId: 'test-profile-' + i, communityId: 'test-community', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, finishedAt: new Date(wall).toISOString(), elapsedMs: 600000, playMs: 599000, failures: 0 }));
    }
    writeFileSync(join(directory, 'operator-note.txt'), 'preserve');
    const registry = createRegistry({ communityId: 'test-community', directory, wall: () => wall }); assert.equal(registry.board().results.length, 100);
    wall += 48 * 3600000 + 1; assert.equal(registry.board().results.length, 0);
    assert.deepEqual(readdirSync(directory), ['operator-note.txt']); assert.equal(registry.join(body(), actor()).seq, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('read and stream-open requests share the bounded ingress rate budget', async () => {
  const server = createLiveServer({ requestLimit: 3 }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/jump-live-api/`;
  try {
    assert.equal((await fetch(base + 'health')).status, 200); assert.equal((await fetch(base + 'board')).status, 200); assert.equal((await fetch(base + 'board')).status, 200);
    assert.equal((await fetch(base + 'board')).status, 429); assert.equal((await fetch(base + 'stream')).status, 429);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('membership verifier uses the verified profile ID and denies missing configuration, pending members and upstream outages', async () => {
  const req = { headers: { authorization: 'Bearer ' + 'fixture' } };
  await assert.rejects(createIdentityVerifier()(req), /COMMUNITY_NOT_CONFIGURED/);
  const calls: string[] = []; let pending = false, wrong = false;
  const verifier = createIdentityVerifier({ communityId: 'test-community', fetcher: async (url: string) => {
    calls.push(String(url)); return new Response(JSON.stringify(String(url).includes('vivacrm') ? { id: 'verified-profile', name: 'Тестовый профиль' } : { id: wrong ? 'other-community' : 'test-community', bannedCount: 0, pendingCount: 0, members: [{ id: 'verified-profile', status: pending ? 'PENDING' : 'ACTIVE' }], membersLoaded: true }), { status: 200 });
  } });
  const verified = await verifier(req); assert.equal(verified.id, 'verified-profile'); assert.ok(calls[1].includes('clientId=verified-profile')); assert.ok(calls.every(u => u.startsWith('https://api.vivacrm.ru/') || u.startsWith('https://padlhub.su/lk/communities/')));
  pending = true; await assert.rejects(verifier(req, { fresh: true }), /COMMUNITY_MEMBER_REQUIRED/);
  pending = false; wrong = true; await assert.rejects(verifier(req, { fresh: true }), /MEMBERSHIP_NOT_VERIFIED/);
  await assert.rejects(createIdentityVerifier({ communityId: 'test-community', fetcher: async () => new Response('', { status: 503 }) })(req), /IDENTITY_UNAVAILABLE/);
});

test('profile scope cannot be spoofed or used for concurrent runs; public state excludes profile IDs', () => {
  const h = harness();
  assert.throws(() => h.registry.join(body(), h.identity), /PROFILE_ALREADY_RUNNING/);
  assert.throws(() => h.registry.join(body(), { ...actor(), communityId: 'other-community' }), /VERIFIED_PROFILE_REQUIRED/);
  assert.throws(() => h.registry.command(h.ticket.id, h.ticket.token, { seq: 1, command: 'pause' }, actor()), /PROFILE_RUN_MISMATCH/);
  const publicData = JSON.stringify(h.registry.board()); assert.ok(!publicData.includes(h.identity.id)); assert.ok(!publicData.includes(h.identity.communityId));
});

test('finish retry excludes heartbeat and blur commands while request is pending and after 503', async () => {
  const { createRaceTransport } = await import('../../src/components/padel-jump/race-connection.ts');
  const calls: Array<{ seq: number; command: string; inputs?: number[][] }> = [], errors: boolean[] = [];
  let rejectFinish: ((e: Error) => void) | undefined;
  const ticket = harness().ticket;
  const connection = createRaceTransport(ticket, () => {}, (_message, retry) => errors.push(!!retry), async (_path, input) => {
    const body = input as { seq: number; command: string; inputs?: number[][] }; calls.push(body);
    if (body.command === 'finish' && !errors.length) return new Promise((_resolve, reject) => { rejectFinish = reject; });
    const complete = createCampaignGame(10, 2); complete.mode = 'complete';
    return { seq: body.seq, sync: LIVE_SYNC, player: { ...ticket.player, state: 'checkpoint', completedParts: 33, game: complete } };
  });
  connection.record(0.5);
  // A previously accepted batch must complete before finish, but subsequent
  // empty heartbeats and blur/pause must never allocate a sequence number.
  void connection.flush();
  const finishing = connection.command('finish');
  void connection.flush(); void connection.command('pause');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(rejectFinish);
  void connection.flush(); void connection.command('pause');
  rejectFinish!(Object.assign(new Error('temporary'), { status: 503 }));
  await finishing;
  assert.deepEqual(calls.map(c => [c.seq, c.command]), [[1, 'inputs'], [2, 'finish']]);
  assert.deepEqual(calls[0].inputs, [[50, 1]]);
  assert.deepEqual(errors, [true]); assert.equal(connection.canStep(), false);
  await connection.flush(); await connection.command('pause');
  await connection.command('finish');
  assert.deepEqual(calls.map(c => [c.seq, c.command]), [[1, 'inputs'], [2, 'finish'], [2, 'finish']]);
  assert.deepEqual(calls[1], calls[2]); connection.dispose();
});


test('high-refresh alternating tilt stops at the server RLE budget during slow identity verification', async () => {
  const { createRaceTransport } = await import('../../src/components/padel-jump/race-connection.ts');
  const ticket = harness().ticket, calls: Array<{ inputs: number[][] }> = [];
  let release: (() => void) | undefined;
  const connection = createRaceTransport(ticket, () => {}, () => assert.fail('valid input rejected'), async (_path, body) => {
    calls.push(body as { inputs: number[][] });
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return { seq: calls.length, sync: LIVE_SYNC, player: ticket.player };
  });
  connection.record(0); const pending = connection.flush();
  await new Promise(resolve => setImmediate(resolve));
  let ticks = 0;
  while (connection.canStep()) { connection.record(ticks++ % 2 ? 1 : -1); }
  assert.equal(ticks, 120); assert.equal(connection.canStep(), false);
  release!(); await pending; await connection.flush();
  assert.equal(calls[1].inputs.length, 120);
  assert.equal(calls[1].inputs.reduce((n, b) => n + b[1], 0), 120);
  assert.equal(connection.canStep(), true); connection.dispose();
});


test('actual Cyrillic community IDs use the root LK detail route and remain URL-encoded', async () => {
  const communityId = 'community_1793001495612_падлхаб-команда';
  const urls: string[] = [];
  const verify = createIdentityVerifier({ communityId, fetcher: async (url: string) => {
    urls.push(String(url)); return new Response(JSON.stringify(String(url).includes('vivacrm') ? { id: 'fixture-profile', name: 'Тест' } : { id: communityId, bannedCount: 0, pendingCount: 0, membersLoaded: true, members: [{ id: 'fixture-profile', status: 'ACTIVE' }] }));
  } });
  assert.equal((await verify({ headers: { authorization: 'Bearer fixture' } })).communityId, communityId);
  assert.equal(urls[1], 'https://padlhub.su/lk/communities/' + encodeURIComponent(communityId) + '?clientId=fixture-profile');
  for (const bad of ['../other', 'community/other', 'community?x=1', 'community#fragment']) await assert.rejects(createIdentityVerifier({ communityId: bad })({ headers: { authorization: 'Bearer fixture' } }), /COMMUNITY_NOT_CONFIGURED/);
});

test('startup preserves valid receipts and quarantines torn legacy finals while ignoring unpublished temp files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-live-recovery-'));
  try {
    const id = randomUUID(), broken = randomUUID();
    const row = { id, alias: 'Тест', actorId: 'fixture', communityId: 'test-community', engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE, elapsedMs: 1000, playMs: 900, failures: 0, finishedAt: new Date().toISOString() };
    writeFileSync(join(directory, id + '.json'), JSON.stringify(row));
    writeFileSync(join(directory, broken + '.json'), '{"id":');
    writeFileSync(join(directory, '.pending-fixture-crash'), '{"id":');
    writeFileSync(join(directory, 'operator-note.txt'), 'preserve');
    const r = createRegistry({ communityId: 'test-community', directory });
    assert.equal(r.board().results.length, 1); assert.equal(r.board().results[0].id, id);
    const quarantine = readdirSync(directory).find(n => n.startsWith('.corrupt-')); assert.ok(quarantine);
    assert.equal(readFileSync(join(directory, quarantine), 'utf8'), '{"id":');
    assert.ok(readdirSync(directory).includes('.pending-fixture-crash')); assert.ok(readdirSync(directory).includes('operator-note.txt'));
    assert.equal(createRegistry({ communityId: 'test-community', directory }).board().results.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
