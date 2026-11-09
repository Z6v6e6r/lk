import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { createEventAccess } from '../../games/padel-jump/live/event-access.mjs';
import { createRegistry } from '../../games/padel-jump/live/registry.mjs';
import { eventJumpAdmission } from '../lib/eventJumpAdmission.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
const at = Date.parse('2026-11-12T09:00:00.000Z');
const event = { epoch: '2026-11-09T09:00:00.000Z', policyRevision: 2, startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionUntil: '2027-11-13T21:00:00.000Z', inviteCode: 'fixture-invite' };
test('exhibition HTTP journey uses canonical form and isolated routes; team API alias and foreign origins stay closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jump-event-http-'));
  const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer', contactEmail: ['organizer', 'example.invalid'].join('@'), startsAt: event.startsAt, endsAt: event.endsAt, retentionYears: 1 };
  const actor = { id: 'fixture-player', name: 'Verified Profile' };
  const community = { id: 'fixture-event', name: 'Synthetic Event', communityType: 'EVENT', members: [{ id: actor.id, status: 'ACTIVE' }], typeSettingsEffectiveAt: event.epoch, typeSettingsRevision: 2, typeSettings: { gameIds: ['padel-jump'], registrationPolicy: policy }, eventEntries: [] as Record<string, unknown>[] };
  let posts = 0;
  const fetcher = async (_url: string, options: { method?: string; body?: string }) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body!); posts++;
      community.eventEntries = [{ ...body.eventRegistration, playerId: actor.id, epoch: event.epoch, policyVersion: policy.version, registeredAt: new Date(at).toISOString(), retentionUntil: event.retentionUntil }];
      return new Response('{"ok":true}');
    }
    return new Response(JSON.stringify(eventJumpAdmission(community, actor, new Date(at).toISOString())));
  };
  const access = createEventAccess({ communityId: community.id, event, fetcher, now: () => at });
  const registry = createRegistry({ communityId: community.id, event, directory, wall: () => at });
  const server = createLiveServer({ communityId: community.id, event, directory, registry, authenticate: access.authenticate, enrollment: access.enrollment });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const origin = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer fixture-token', Origin: 'https://padlhub.ru', 'Content-Type': 'application/json' };
  const start = () => fetch(origin + '/jump-exhibition-api/runs', { method: 'POST', headers, body: JSON.stringify({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }) });
  try {
    const health = await fetch(origin + '/jump-exhibition-api/health'); assert.equal(health.status, 200); assert.equal((await health.json()).resultStoragePolicy, 'event-retention-v1');
    assert.equal((await fetch(origin + '/jump-live-api/health')).status, 404);
    const wall = await fetch(origin + '/jump-exhibition-api/board', { headers: { Origin: 'https://padlhub.ru' } });
    assert.equal(wall.headers.get('access-control-allow-origin'), 'https://padlhub.ru');
    assert.equal(wall.headers.get('access-control-allow-credentials'), null);
    assert.equal((await fetch(origin + '/jump-exhibition-api/entry')).status, 401);
    assert.equal((await start()).status, 403);
    const entry = await (await fetch(origin + '/jump-exhibition-api/entry', { headers })).json(); assert.equal(entry.state, 'form'); assert.equal(entry.registrationKind, 'event');
    const form = { fullName: 'Private Participant', company: 'Private Company', email: ['participant', 'example.invalid'].join('@'), policyRevision: 2 };
    const enrolled = await fetch(origin + '/jump-exhibition-api/enrollment', { method: 'POST', headers, body: JSON.stringify(form) }); assert.equal((await enrolled.json()).state, 'ready');
    assert.equal(posts, 1); assert.equal((await start()).status, 201);
    const board = await (await fetch(origin + '/jump-exhibition-api/board')).text(); assert.doesNotMatch(board, /Private Participant|Private Company|participant@|fixture-player|policyRevision|eventEpoch/);
    assert.ok(!readdirSync(directory).includes('enrollments'));
    assert.equal((await fetch(origin + '/jump-exhibition-api/enrollment', { method: 'POST', headers: { ...headers, Origin: 'https://other.example.invalid' }, body: JSON.stringify(form) })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
