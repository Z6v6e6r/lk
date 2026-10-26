import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityVerifier } from '../../games/padel-jump/live/identity.mjs';
import { createEnrollment } from '../../games/padel-jump/live/enrollment.mjs';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { createCampaignGame, drainEvents, FIXED_STEP, stepGame } from '../../src/components/padel-jump/engine.ts';
import { createRaceTransport } from '../../src/components/padel-jump/race-connection.ts';
import type { LiveAck, LiveTicket } from '../../src/components/padel-jump/race-connection.ts';
import { createRaceControl } from '../../src/components/padel-jump/race-control.ts';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
import { pilotTarget } from './helpers/padelJumpPilot.ts';

for (const fullRoute of [false, true]) test(`HTTP journey: login → form/join → game → ${fullRoute ? '33 parts' : 'five lives with a star'} → ranked result`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-journey-')), communityId = 'fixture-community', profileId = 'fixture-visitor';
  let member = false, time = 0, joins = 0;
  const methods: string[] = [], email = ['visitor', 'example.invalid'].join('@'), website = 'https://company.example.invalid/';
  const fetcher = async (url: string, options: { headers: Record<string, string>; method?: string; body?: string }) => {
    assert.equal(options.headers.Authorization, 'Bearer fixture-session');
    if (String(url).includes('vivacrm')) { methods.push(options.method ?? 'GET'); return new Response(JSON.stringify({ id: profileId, firstName: 'Проверенный', lastName: 'Игрок' })); }
    if (String(url).endsWith('join-by-invite')) {
      const body = JSON.parse(options.body!); assert.equal(body.member.id, profileId); assert.equal(body.member.role, 'MEMBER'); assert.equal(body.inviteCode, 'fixture-invite');
      assert.ok(!options.body!.includes(email) && !options.body!.includes(website)); member = true; joins++;
      return new Response(JSON.stringify({ ok: true, membershipStatus: 'ACTIVE' }));
    }
    return new Response(JSON.stringify({ id: communityId, name: 'Тестовое сообщество', inviteCode: 'fixture-invite', membersLoaded: true, pendingCount: 0, bannedCount: 0, members: member ? [{ id: profileId, status: 'ACTIVE', name: 'Проверенный Игрок' }] : [] }));
  };
  const authenticate = createIdentityVerifier({ communityId, fetcher });
  const enrollment = createEnrollment({ communityId, directory, authenticate, fetcher });
  const registry = createRegistry({ communityId, directory, now: () => time });
  const server = createLiveServer({ communityId, directory, registry, authenticate, enrollment, origin: 'http://127.0.0.1:5192' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/jump-live-api/`, headers = { Authorization: 'Bearer fixture-session', Origin: 'http://127.0.0.1:5192', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + 'entry')).status, 401);
    assert.equal((await (await fetch(base + 'entry', { headers })).json()).state, 'form');
    const form = { firstName: 'Тестовый', lastName: 'Гость', email, companyWebsite: website, consent: true };
    const enrolled = await fetch(base + 'enrollment', { method: 'POST', headers, body: JSON.stringify(form) }); assert.equal(enrolled.status, 200); assert.equal((await enrolled.json()).state, 'ready');
    assert.equal((await (await fetch(base + 'entry', { headers })).json()).state, 'ready'); assert.equal(joins, 1); assert.equal(readdirSync(join(directory, 'enrollments')).length, 1);
    const joined = await fetch(base + 'runs', { method: 'POST', headers, body: JSON.stringify({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }) }); assert.equal(joined.status, 201); const ticket = await joined.json() as LiveTicket;
    let game = createCampaignGame(); game.mode = 'running'; const errors: string[] = [];
    const connection = createRaceTransport(ticket, ack => control.acknowledge(ack.player, ack.prediction), message => errors.push(message), async (path, body, signal, token) => {
      const response = await fetch(base + path, { method: 'POST', headers: { ...headers, 'X-Jump-Run-Token': token! }, body: JSON.stringify(body), signal }); const result = await response.json();
      assert.equal(response.status, 200, result.error); return result as LiveAck;
    });
    const control = createRaceControl({ game: () => game, replace: value => { game = value; }, connection: () => connection, foreground: () => true, prepareResume: async () => {}, stopped: () => !!errors.length, canPause: () => true, changed() {}, pending() {} });
    if (!fullRoute) {
      for (let loss = 0; loss < 5; loss++) {
        for (let tick = 0; tick < 1200 && game.mode === 'running'; tick++) {
          const direction = loss === 0 && !game.campaign!.stars[0].collected ? Math.round(Math.max(-1, Math.min(1, (game.campaign!.stars[0].x - game.ball.x) / (250 * FIXED_STEP))) * 100) / 100 : -1;
          connection.record(direction); stepGame(game, direction); time += FIXED_STEP * 1000; drainEvents(game);
          if (tick % 60 === 59 || game.mode !== 'running') await connection.flush();
        }
        assert.equal(game.mode, 'over');
        if (loss < 4) await control.command('retry');
      }
      const stoppedAt = registry.board().players[0].elapsedMs; time += 5000; await connection.flush();
      await control.command('finish'); assert.equal(registry.board().results[0].elapsedMs, stoppedAt);
      assert.equal(registry.board().results[0].stars, 1); assert.equal(registry.board().players[0].completedParts, 0);
    }
    for (let part = 0; fullRoute && part < 33; part++) {
      let landed = 0;
      for (let tick = 0; tick < 12000 && game.mode === 'running'; tick++) {
        const target = pilotTarget(game, landed, false), direction = Math.round(Math.max(-1, Math.min(1, (target - game.ball.x) / (250 * FIXED_STEP))) * 100) / 100;
        assert.ok(connection.canStep()); connection.record(direction); stepGame(game, direction); time += FIXED_STEP * 1000;
        for (const event of drainEvents(game)) if (event.type === 'landing') landed = Number(event.id);
        if (tick % 60 === 59 || game.mode !== 'running') await connection.flush();
      }
      assert.equal(game.mode, 'complete', `part ${part}`); assert.equal(control.checkpointConfirmed(), true);
      if (part < 32) { await control.command('advance'); assert.equal(game.campaign!.station * 3 + game.campaign!.section, part + 1); } else await control.command('finish');
    }
    const board = await (await fetch(base + 'board')).text(); const result = JSON.parse(board);
    assert.equal(result.results.length, 1); assert.equal(result.results[0].alias, 'Проверенный Игрок');
    assert.deepEqual(createRegistry({ communityId, directory }).board().results, result.results);
    assert.ok(!board.includes(email) && !board.includes(website) && !board.includes('Тестовый Гость')); assert.ok(methods.every(method => method === 'GET')); assert.deepEqual(errors, []); connection.dispose();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
