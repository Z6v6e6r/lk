import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sanitizeTypedCommunityPayload, addTypedCommunityResponseRedaction } from '../lib/communityResponseRedaction.mjs';
import { addCommunityRosterWrites } from '../lib/communityRosterWrites.mjs';
import { patchCommunityTypesFlow } from '../patch_live_community_types.mjs';
import { addCommunityPolicyAuth, COMMUNITY_AUTH_PREPARE, COMMUNITY_AUTH_RESPONSE } from '../lib/communityPolicyAuth.mjs';
import { recalculateCommunityRating } from '../../src/services/community-rating/recalculation.ts';
import { loadCommunitySchedule } from '../lib/communitySchedule.mjs';
import { communityType, parseCommunityTypeSettings, DEFAULT_LEAGUE_DIVISIONS, resolveLeagueDivision } from '../../src/services/community-policy.ts';
import { communityPolicyEvent, matchesCommunityPolicy, buildStationMembershipMutation, buildCommunityPolicyPost, processCommunityPolicies, publishCommunityPolicyIntent } from '../lib/communityPolicyProjection.mjs';
import { assignLeagueResults, buildLeagueRatingTables } from '../../src/services/community-rating/league.ts';
import { buildCommunityRatingSnapshot } from '../../src/services/community-rating/aggregates.ts';
import { COMMUNITY_RATING_CALCULATION_VERSION } from '../../src/services/community-rating/contract.ts';
import type { CommunityRatingFact } from '../../src/services/community-rating/facts.ts';

const now = '2026-10-21T09:00:00.000Z';
const effective = '2026-10-21T08:00:00.000Z';
const station = { id: 'station-community', communityType: 'STATION', typeSettings: { stationId: 'station-a' }, typeSettingsRevision: 1, typeSettingsEffectiveAt: effective };
const game = { id: 'game-a', createdAt: now, booking: { studioId: 'station-a' }, organizer: { id: 'organizer-a', name: 'Организатор' }, participants: [{ id: 'participant-a', name: 'Участник' }, { id: 'waiting-a', status: 'WAITLIST' }, { id: 'cancelled-a', isCancelled: true } ] };

test('missing type is ordinary and policies never infer a type from a station-like name', () => {
  assert.equal(communityType(undefined), 'FRIENDS');
  assert.equal(matchesCommunityPolicy({ ...station, communityType: undefined, name: 'station-a' }, communityPolicyEvent('GAME', game)), false);
  const old = fs.readFileSync('scripts/nodered_games_nodes/fn_autojoin_prepare.js', 'utf8');
  const result = vm.runInNewContext('(function(msg){' + old + '\n})(msg)', { msg: { payload: game } });
  assert.equal(result[0], null);
});
test('station projects creators and confirmed participants using the exact station and activation boundary', () => {
  const event = communityPolicyEvent('GAME', game);
  assert.equal(matchesCommunityPolicy(station, event), true);
  assert.deepEqual(event.players.map(player => player.id), ['organizer-a', 'participant-a']);
  assert.equal(matchesCommunityPolicy(station, { ...event, stationId: 'station-b' }), false);
  assert.equal(matchesCommunityPolicy(station, { ...event, at: Date.parse(effective) - 1 }), false);
  assert.equal(matchesCommunityPolicy(station, communityPolicyEvent('GAME', { ...game, status: 'CANCELLED' })), false);
  assert.equal(matchesCommunityPolicy({ ...station, typeSettingsRevision: 0 }, event), false);
  const mutation = buildStationMembershipMutation(station, event, event.players[1], now)!;
  assert.ok(mutation.filter.bannedMembers);
  assert.ok(mutation.filter.members);
  assert.equal(mutation.filter.typeSettingsRevision, 1);
  assert.ok(Array.isArray(mutation.update), 'server-side pipeline appends without replacing an old roster');
  assert.match(JSON.stringify(mutation.update), /STATION_EVENT/);
});
test('corporate categories match by explicit IDs and optional subscription never controls membership', () => {
  const corporate = { ...station, communityType: 'CORPORATE', typeSettings: { directionIds: ['6180'], vivaSubscriptionId: 'subscription-a' } };
  const event = communityPolicyEvent('GAME', { ...game, direction: { id: 6180 } });
  assert.equal(matchesCommunityPolicy(corporate, event), true);
  assert.equal(matchesCommunityPolicy(corporate, { ...event, directionId: 'other' }), false);
  assert.equal(buildStationMembershipMutation(corporate, event, event.players[0], now), null);
  assert.throws(() => parseCommunityTypeSettings('CORPORATE', {}));
  assert.equal(buildCommunityPolicyPost(corporate, event, now)._id, buildCommunityPolicyPost(corporate, event, '2026-10-22T09:00:00Z')._id);
});
test('dry run never mutates, existing moderated posts are not recreated, and bounded reads fail before writes', async () => {
  let writes = 0;
  const db = { collection(name: string) { return {
    find() { return { limit() { return this; }, async toArray() { return name === 'lk_communities' ? [station] : name === 'lk_games' ? [game] : []; } }; },
    async findOne() { return name === 'lk_community_feed' ? { archived: true } : station; },
    async updateOne() { writes++; return { modifiedCount: 1, upsertedCount: 1 }; },
  }; } };
  const result = await processCommunityPolicies(db, { sinceIso: effective, nowIso: now, dryRun: true });
  assert.equal(writes, 0); assert.equal(result.posts, 0);
  await assert.rejects(() => processCommunityPolicies(db, { sinceIso: effective, nowIso: now, dryRun: false, maxEvents: 0 }), /EVENT_LIMIT/);
  assert.equal(writes, 0);
});
function fact(id = 'fact-a'): CommunityRatingFact {
  return { id, communityId: 'league-a', eventType: 'game', eventId: 'game-a', playerKey: 'id:player-a', playerId: 'player-a', playerPhone: null,
    playerName: 'Игрок', playerAvatarUrl: null, currentLevel: 5, sourcePostId: null, ratingDelta: 0, ratingEventIds: ['ledger-a'], lastRatingDelta: null, lastRatingChangedAt: null,
    lastRatingChangedAtTs: null, lastRatingEventId: null, occurredAt: now, occurredAtTs: Date.parse(now), calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION, collectedAt: now,
    metrics: { gamesPlayed: 1, gamesWon: 1, gamesLost: 0, setsWon: 2, gamesWonCount: 12, gamesDiff: 4, levelDelta: 0 } };
}
test('league boundaries put D+ and C in their higher division, with a single inclusive final edge', () => {
  const divisions = parseCommunityTypeSettings('LEAGUE', { divisions: DEFAULT_LEAGUE_DIVISIONS }).divisions!;
  assert.equal(resolveLeagueDivision(divisions, 2)?.id, 'd-plus-c');
  assert.equal(resolveLeagueDivision(divisions, 3)?.id, 'c-c-plus');
  assert.equal(resolveLeagueDivision(divisions, 3.5)?.id, 'c-c-plus');
  assert.equal(resolveLeagueDivision(divisions, 3.6), null);
});
test('result division uses event level and remains immutable across profile and config changes', () => {
  const community = { id: 'league-a', communityType: 'LEAGUE', typeSettingsRevision: 1, typeSettingsEffectiveAt: effective, typeSettings: { divisions: DEFAULT_LEAGUE_DIVISIONS } };
  const initial = assignLeagueResults({ community, facts: [fact()], ratingEvents: [{ id: 'ledger-a', occurredAt: now, change: { before: 2 } }], records: [], nowIso: now });
  assert.equal(initial.facts[0].leagueDivision?.id, 'd-plus-c', 'current profile level 5 must not replace level-at-event 2');
  const later = assignLeagueResults({ community: { ...community, typeSettingsRevision: 2, typeSettings: { divisions: [{ id: 'other', name: 'Новый', minLevel: 0, maxLevel: 10 }] } }, facts: [fact()], existing: initial.assignments,
    ratingEvents: [{ id: 'ledger-a', change: { before: 5 } }], records: [], nowIso: now });
  assert.equal(later.assignments.length, 0);
  assert.equal(later.facts[0].leagueDivision?.id, 'd-plus-c');
  const snapshot = buildCommunityRatingSnapshot({ communityId: 'league-a', facts: later.facts, period: 'all', nowTs: Date.parse(now), updatedAt: now });
  const tables = buildLeagueRatingTables(snapshot, later.facts, [...DEFAULT_LEAGUE_DIVISIONS]);
  assert.equal(tables.find(table => table.id === 'd-plus-c')?.rows[0].gamesPlayed, 1);
  assert.equal(tables.find(table => table.id === 'c-c-plus')?.rows.length, 0);
});
test('unknown event level and old events are not classified from a current profile', () => {
  const community = { id: 'league-a', communityType: 'LEAGUE', typeSettingsRevision: 1, typeSettingsEffectiveAt: effective, typeSettings: { divisions: DEFAULT_LEAGUE_DIVISIONS } };
  const unknown = assignLeagueResults({ community, facts: [fact()], ratingEvents: [], records: [], nowIso: now });
  assert.equal(unknown.assignments[0].division, null);
  const old = assignLeagueResults({ community, facts: [{ ...fact(), occurredAtTs: Date.parse(effective) - 1 }], ratingEvents: [], records: [], nowIso: now });
  assert.equal(old.assignments.length, 0);
});

test('public schedule is bounded, read-only and strips contacts before a corporate publication', async () => {
  const calls: string[] = [];
  const result = await loadCommunitySchedule({ nowIso: now, horizonDays: 1, fetchImpl: async (url: string, options: { method: string }) => {
    calls.push(url); assert.equal(options.method, 'GET');
    return { ok: true, async json() { return [{ id: 'exercise-a', timeFrom: now, direction: { id: 6180, name: 'Клубная игра' }, studio: { id: 'station-a', name: 'Станция' }, clientPhone: 'private', clients: [{ phone: 'private' }] }]; } };
  } });
  assert.equal(calls.length, 1); assert.equal(result[0].direction.id, 6180);
  assert.doesNotMatch(JSON.stringify(result), /private|clientPhone|clients":/);
  await assert.rejects(() => loadCommunitySchedule({ nowIso: now, horizonDays: 0 }), /HORIZON/);
});

test('focused Node-RED patch is idempotent and preserves graph, config and foreign functions', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = (name: string) => common + source.split('const ' + name + ' = `${commonHelpers}')[1].split('\n`;')[0];
  const nodes = [
    { id: 'create', name: 'Build community create docs', func: body('fnCreate') },
    { id: 'update', name: 'Prepare community update', func: body('fnUpdatePrepare') },
    { id: 'ranking', name: 'Use rating snapshot or fallback', func: body('fnRankingSnapshotResponse') },
    { id: 'list', name: 'Prepare communities list query', func: common + fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js', 'utf8') },
    { id: 'autojoin', name: 'Prepare game station autojoin', func: 'return [msg, null];' },
  ].map(node => ({ ...node, type: 'function', outputs: 2, wires: [['foreign']] }));
  const flow = [...nodes, { id: 'foreign', type: 'function', func: 'return msg;', wires: [] }, { id: 'config', type: 'mongodb', database: 'synthetic-db' }];
  const original = structuredClone(flow);
  const first = patchCommunityTypesFlow(flow);
  assert.deepEqual(flow, original, 'input/preimage stays intact');
  assert.equal(first.changes.length, 5, 'manifest includes identity hardening on every helper copy plus retired autojoin');
  assert.deepEqual(first.flow.at(-1), flow.at(-1));
  assert.deepEqual(first.flow.at(-2), flow.at(-2));
  assert.deepEqual(first.flow.map(node => node.wires), flow.map(node => node.wires));
  assert.equal(patchCommunityTypesFlow(first.flow).changes.length, 0);
  assert.throws(() => patchCommunityTypesFlow([]), /REQUIRED_NODES_MISSING/);
});

test('tournament enrollment requires an explicit confirmed spot within capacity', () => {
  const event = communityPolicyEvent('TOURNAMENT', { id: 't-a', createdAt: now, stationId: 'station-a', params: { maxParticipants: 4 }, participants: [
    { clientId: 'confirmed', isCancelled: false, spot: 1 }, { clientId: 'missing-confirmation', spot: 2 },
    { clientId: 'missing-spot', isCancelled: false }, { clientId: 'overflow', isCancelled: false, spot: 5 },
    { clientId: 'waiting', isCancelled: false, spot: 0 },
  ] });
  assert.deepEqual(event.players.map(player => player.id), ['confirmed']);
});
test('assignment identity survives a calculation version bump and new ranges', () => {
  const community = { id: 'league-a', communityType: 'LEAGUE', typeSettingsRevision: 1, typeSettingsEffectiveAt: effective, typeSettings: { divisions: DEFAULT_LEAGUE_DIVISIONS } };
  const first = assignLeagueResults({ community, facts: [fact('version-1')], ratingEvents: [{ id: 'ledger-a', change: { before: 2 } }], records: [], nowIso: now });
  const later = assignLeagueResults({ community: { ...community, typeSettings: { divisions: [{ id: 'new', name: 'Новый', minLevel: 0, maxLevel: 10 }] } }, facts: [{ ...fact('version-2'), calculationVersion: 'next' }], existing: first.assignments, ratingEvents: [], records: [], nowIso: now });
  assert.equal(later.assignments.length, 0);
  assert.equal(later.facts[0].leagueDivision?.id, 'd-plus-c');
});
test('typed private reads ignore a spoofed query identity; real profile verification binds query and actor', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = common + source.split('const fnGetResponse = `${commonHelpers}')[1].split('\n`;')[0];
  const graph = addCommunityPolicyAuth([
    { id: 'http', type: 'http in', z: 'tab', url: '/lk/communities/:communityId', method: 'get', wires: [['read']] },
    { id: 'read', type: 'function', name: 'Build community get response', func: body, outputs: 2, wires: [['response'], []] },
    { id: 'response', type: 'http response', wires: [] },
  ]);
  assert.equal(graph.filter(node => node.type.startsWith('subflow:')).length, 1);
  assert.deepEqual(addCommunityPolicyAuth(graph), graph, 'auth graph is idempotent');
  const run = (code: string, msg: Record<string, unknown>) => vm.runInNewContext('(function(msg){' + code + '\n})(msg)', { msg });
  const community = { id: 'typed-a', communityType: 'STATION', visibility: 'CLOSED', members: [{ id: 'victim', phone: 'private', name: 'Участник' }] };
  const denied = run(graph.find(node => node.id === 'read')!.func!, { req: { method: 'GET', headers: {} }, payload: [community], _communityGet: { clientId: 'victim' } });
  assert.equal(denied[0].statusCode, 403);
  assert.doesNotMatch(JSON.stringify(denied), /private|Участник/);
  const verified: Record<string, unknown> = { req: { url: '/lk/communities/a/members/manage', query: { clientId: 'victim', phone: 'spoofed' } }, statusCode: 200, payload: { id: 'real-user', phone: 'verified-phone' }, _communityPolicyAuth: { payload: { actor: { id: 'victim' }, member: { id: 'target' } } } };
  const authenticated = run(COMMUNITY_AUTH_RESPONSE, verified)[0];
  assert.equal(authenticated.req.query.clientId, 'real-user');
  assert.equal(authenticated.payload.actor.id, 'real-user');
  assert.equal(authenticated.payload.member.id, 'target', 'management target is not silently replaced');
  const aliases = run(COMMUNITY_AUTH_RESPONSE, { req: { url: '/lk/communities/a/chat' }, statusCode: 200, payload: { id: 'real' }, _communityPolicyAuth: { payload: { actor: { id: 'victim' }, member: { id: 'victim' }, user: { id: 'victim' } } } })[0].payload;
  assert.equal(aliases.member.id, 'real'); assert.equal(aliases.actor.id, 'real'); assert.equal(aliases.user.id, 'real');
  assert.equal(run(COMMUNITY_AUTH_PREPARE, { req: { headers: { authorization: 'invalid' } } })[2].statusCode, 401);
  const allowed = run(graph.find(node => node.id === 'read')!.func!, { req: { method: 'GET', headers: {} }, payload: [community], _verifiedCommunityActor: { id: 'victim' }, _communityGet: { clientId: 'victim' } });
  assert.equal(allowed[0].statusCode, 200);
  assert.equal(allowed[0].payload.members[0].phone, null);
});
function leagueCollections() {
  const doc: Record<string, unknown> = { id: 'league-a', name: 'Лига', communityType: 'LEAGUE', typeSettingsRevision: 1, typeSettingsEffectiveAt: effective, typeSettings: { divisions: DEFAULT_LEAGUE_DIVISIONS }, members: [{ id: 'player-a', name: 'Игрок A', levelScore: 2 }, { id: 'player-b', name: 'Игрок B', levelScore: 2 }] };
  const results = new Map<string, Record<string, unknown>>(); let failInsert = false, staleClaim = false, writes = 0;
  const read = (rows: Record<string, unknown>[]) => ({ find: () => ({ toArray: async () => rows }) });
  const communities = { ...read([doc]), async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    if (update.$push) {
      if (staleClaim) { doc.typeSettingsRevision = 2; return { matchedCount: 0 }; }
      assert.equal(filter.typeSettingsRevision, doc.typeSettingsRevision);
      const row = (update.$push as Record<string, unknown>).leagueAssignmentOutbox;
      doc.leagueAssignmentOutbox = [...(doc.leagueAssignmentOutbox as unknown[] ?? []), row];
    } else if (update.$pull) {
      const id = ((update.$pull as Record<string, unknown>).leagueAssignmentOutbox as Record<string, unknown>)._id;
      doc.leagueAssignmentOutbox = (doc.leagueAssignmentOutbox as Record<string, unknown>[]).filter(row => row._id !== id);
    }
    return { matchedCount: 1 };
  } };
  const leagueReader = { find(filter: Record<string, unknown>) { return { toArray: async () => [...results.values()].filter(row => !filter._id || row._id === filter._id) }; } };
  const leagueWriter = { async bulkWrite(operations: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>) {
    if (failInsert) throw new Error('synthetic interruption');
    for (const op of operations) if (!results.has(String(op.updateOne.filter._id))) results.set(String(op.updateOne.filter._id), op.updateOne.update.$setOnInsert as Record<string, unknown>);
    return {};
  } };
  const sink = { async bulkWrite() { writes++; return {}; } };
  return { doc, results, setFail: (value: boolean) => { failInsert = value; }, setStale: () => { staleClaim = true; }, getWrites: () => writes, collections: {
    source: { lk_communities: communities, community_league_results: leagueReader,
      lk_community_feed: read([{ id: 'post-a', communityId: 'league-a', kind: 'GAME', relatedGameId: 'game-a' }]),
      lk_games: read([{ id: 'game-a', updatedAt: now, participants: [{ id: 'player-a', name: 'Игрок A', levelScore: 2 }, { id: 'player-b', name: 'Игрок B', levelScore: 2 }], metadata: { teamSlots: ['player-a', 'player-b'], matchResult: { status: 'CONFIRMED', sets: [{ left: 6, right: 4 }] } } }]),
      tournaments: read([]), lk_training_visits: read([]), rating_events: read([]), player_rating_state: read([]),
    }, storage: { community_league_results: leagueWriter, community_rating_facts: sink, community_rating_player_aggregates: sink, community_rating_snapshots: sink },
  } };
}
test('stale league revision cannot claim or persist a permanent result assignment', async () => {
  const fixture = leagueCollections(); fixture.setStale();
  await assert.rejects(() => recalculateCommunityRating({ collections: fixture.collections, communityId: 'league-a', nowTs: Date.parse(now), updatedAt: now, ensureIndexes: false }), /POLICY_CHANGED/);
  assert.equal(fixture.results.size, 0); assert.equal(fixture.getWrites(), 0);
});
test('an interrupted league claim is recovered after configuration changes, then cleared', async () => {
  const fixture = leagueCollections(); fixture.setFail(true);
  await assert.rejects(() => recalculateCommunityRating({ collections: fixture.collections, communityId: 'league-a', nowTs: Date.parse(now), updatedAt: now, ensureIndexes: false }), /synthetic interruption/);
  assert.equal((fixture.doc.leagueAssignmentOutbox as unknown[]).length, 1);
  fixture.doc.typeSettingsRevision = 2;
  fixture.doc.typeSettings = { divisions: [{ id: 'new', name: 'Новый', minLevel: 0, maxLevel: 10 }] };
  fixture.setFail(false);
  await recalculateCommunityRating({ collections: fixture.collections, communityId: 'league-a', nowTs: Date.parse(now), updatedAt: now, ensureIndexes: false });
  assert.equal(fixture.results.size, 2);
  assert.deepEqual(fixture.doc.leagueAssignmentOutbox, []);
  assert.equal((([...fixture.results.values()].find(row => row.playerKey === 'id:player-a'))!.division as { id: string }).id, 'd-plus-c');
  assert.equal((([...fixture.results.values()].find(row => row.playerKey === 'id:player-b'))!.division as { id: string }).id, 'new');
});


test('typed manual joins commit with roster CAS before response or derived writes', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const join = common + source.split('const fnJoinApply = `${commonHelpers}')[1].split('\n`;')[0];
  const graph = addCommunityRosterWrites(addCommunityPolicyAuth([
    { id: 'apply', type: 'function', name: 'Apply community join', func: join, outputs: 6, wires: [['write'], ['ranking'], ['feed'], ['event'], ['response'], ['debug']] },
    { id: 'write', type: 'mongodb4', operation: 'updateOne', collection: 'lk_communities', wires: [] },
    { id: 'response', type: 'http response', wires: [] },
  ]));
  assert.deepEqual(addCommunityRosterWrites(graph), graph);
  const run = (code: string, msg: Record<string, unknown>) => vm.runInNewContext('(function(msg){' + code + '\n})(msg)', { msg });
  const community = { ...station, visibility: 'OPEN', members: [{ id: 'owner', name: 'Owner', role: 'OWNER' }], pendingMembers: [], bannedMembers: [] };
  const result = run(graph[0].func!, { req: { method: 'POST' }, payload: [], _communityJoin: { community, member: { id: 'joining', name: 'Joining' } }, _typedCommunity: true, _communityPolicyPreimage: community });
  assert.ok(result[0]); assert.ok(result.slice(1).every((item: unknown) => item === null));
  assert.equal(JSON.stringify(result[0].query.members), JSON.stringify(community.members));
  assert.equal(result[0].query.typeSettingsRevision, 1);
  const ack = graph.find(node => node.name === 'Confirm typed community roster commit')!;
  const failed = run(ack.func!, { ...result[0], payload: { acknowledged: true, matchedCount: 0 } });
  assert.equal(failed[3].statusCode, 409); assert.ok(failed.slice(0, 3).every((item: unknown) => item === null));
  const confirmed = run(ack.func!, { ...result[0], payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } });
  assert.equal(confirmed[3].statusCode, 200); assert.ok(confirmed[0]); assert.ok(confirmed[1]);
  // A worker append, a competing join, ban or manager demotion changes this exact
  // roster, so none can be overwritten by the now-stale filter.
  for (const next of [[...community.members, { id: 'station-added' }], [{ ...community.members[0], role: 'MEMBER' }]]) assert.notEqual(JSON.stringify(result[0].query.members), JSON.stringify(next));
});

test('policy publication claims reject stale config and recover a claimed post after interruption/type change', async () => {
  type Intent = { id: string; filter: Record<string, unknown>; update: Record<string, unknown>; options: Record<string, unknown> };
  const community = { ...station, typeSettings: station.typeSettings as Record<string, unknown>, communityPolicyOutbox: [] as Intent[] };
  let fail = false, writes = 0;
  const db = { collection(name: string) { return {
    async findOne() { return community; },
    async updateOne(filter: { typeSettingsRevision?: number }, update: { $push?: { communityPolicyOutbox: Intent }; $pull?: { communityPolicyOutbox: { id: string } } }) {
      if (name === 'lk_community_feed') { if (fail) throw new Error('feed interruption'); writes++; return { acknowledged: true, upsertedCount: 1, modifiedCount: 0 }; }
      if (update.$push) {
        if (filter.typeSettingsRevision !== community.typeSettingsRevision) return { matchedCount: 0 };
        community.communityPolicyOutbox.push(update.$push.communityPolicyOutbox); return { matchedCount: 1 };
      }
      if (update.$pull) community.communityPolicyOutbox = community.communityPolicyOutbox.filter(row => row.id !== update.$pull!.communityPolicyOutbox.id);
      return { matchedCount: 1 };
    },
    find() { return { limit() { return this; }, async toArray() { return name === 'lk_communities' ? [community] : []; } }; },
  }; } };
  const operation = { filter: { _id: 'post' }, update: { $setOnInsert: { id: 'post' } }, options: { upsert: true } };
  community.typeSettingsRevision = 2;
  await publishCommunityPolicyIntent(db, station, operation); assert.equal(writes, 0);
  community.typeSettingsRevision = 1; fail = true;
  await assert.rejects(() => publishCommunityPolicyIntent(db, station, operation), /feed interruption/);
  assert.equal(community.communityPolicyOutbox.length, 1);
  community.communityType = 'FRIENDS'; community.typeSettings = {}; community.typeSettingsRevision = 2; fail = false;
  await processCommunityPolicies(db, { sinceIso: effective, nowIso: now, dryRun: false });
  assert.equal(writes, 1); assert.equal(community.communityPolicyOutbox.length, 0);
});


test('unacknowledged feed writes retain the recovery intent and a full outbox fails the worker tick', async () => {
  let pending: Record<string, unknown>[] = [], pulled = false;
  const doc = { ...station, communityPolicyOutbox: pending };
  const db = { collection(name: string) { return {
    async findOne() { return { ...doc, communityPolicyOutbox: pending }; },
    async updateOne(_filter: unknown, update: { $push?: { communityPolicyOutbox: Record<string, unknown> }; $pull?: unknown }) {
      if (name === 'lk_community_feed') return { acknowledged: false };
      if (update.$push) { if (pending.length >= 100) return { matchedCount: 0 }; pending.push(update.$push.communityPolicyOutbox); }
      if (update.$pull) { pulled = true; pending = []; }
      return { acknowledged: true, matchedCount: 1 };
    },
  }; } };
  const operation = { filter: { _id: 'post' }, update: { $setOnInsert: { id: 'post' } }, options: { upsert: true } };
  await assert.rejects(() => publishCommunityPolicyIntent(db, station, operation), /UNACKNOWLEDGED/);
  assert.equal(pulled, false); assert.equal(pending.length, 1);
  pending = Array.from({ length: 100 }, (_, index) => ({ id: 'other-' + index }));
  await assert.rejects(() => publishCommunityPolicyIntent(db, station, operation), /OUTBOX_FULL/);
});

test('fresh sanitized complete graph proves auth ingress, roster acknowledgement edges and function syntax', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = (name: string) => common + source.split('const ' + name + ' = `${commonHelpers}')[1].split('\n`;')[0];
  const required = [
    ['create', 'Build community create docs', 'fnCreate'], ['update', 'Prepare community update', 'fnUpdatePrepare'],
    ['ranking', 'Use rating snapshot or fallback', 'fnRankingSnapshotResponse'],
  ].map(([id, name, code]) => ({ id, type: 'function', name, func: body(code), outputs: 2, wires: [['response'], []] }));
  const flow: Array<Record<string, unknown>> = [...required,
    { id: 'list', type: 'function', name: 'Prepare communities list query', func: common + fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js', 'utf8'), outputs: 2, wires: [['response'], []] },
    { id: 'autojoin', type: 'function', name: 'Prepare game station autojoin', func: 'return [msg,null];', outputs: 2, wires: [[], []] },
    { id: 'response', type: 'http response', wires: [] },
  ];
  for (const [id, name, code] of [['join', 'Apply community join', 'fnJoinApply'], ['invite', 'Apply invite join', 'fnJoinApply'], ['manage', 'Apply member management', 'fnMemberManageApply']]) {
    flow.push({ id: id + '-http', type: 'http in', z: 'tab', url: '/lk/communities/a/' + (id === 'manage' ? 'members/manage' : id), method: 'post', wires: [[id]] },
      { id, type: 'function', z: 'tab', name, func: body(code), outputs: 6, wires: [[id + '-db'], [], [], [], ['response'], []] },
      { id: id + '-db', type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'updateOne', wires: [] });
  }
  const original = structuredClone(flow), candidate = patchCommunityTypesFlow(flow);
  assert.deepEqual(flow, original);
  assert.equal(candidate.flow.filter(node => node.name === 'Confirm typed community roster commit').length, 3);
  assert.equal(candidate.flow.filter(node => String(node.type).startsWith('subflow:')).length, 3);
  for (const node of candidate.flow) if (node.type === 'function') new vm.Script('(function(msg){' + node.func + '\n})');
  for (const id of ['join', 'invite', 'manage']) {
    const db = candidate.flow.find(node => node.id === id + '-db')!;
    assert.equal(db.wires[0][0], id + '-typed-roster-ack');
    assert.ok(candidate.changes.some(node => node.id === id + '-typed-roster-ack' && node.kind === 'added'));
  }
  assert.equal(patchCommunityTypesFlow(candidate.flow).changes.length, 0);
});


test('corporate category-only selectors discover local tournaments, trainings and canonical games without public schedule', () => {
  for (const [kind, category, raw] of [
    ['TOURNAMENT', 'tournament', { id: 'local-tournament', createdAt: now }],
    ['TRAINING', 'group_training', { id: 'local-training', createdAt: now }],
    ['GAME', 'open_game', { id: 'local-game', createdAt: now, directionId: 6180 }],
    ['EVENT', 'court_rental', { id: 'local-rental', createdAt: now, category: 'court_rental' }],
  ] as const) {
    const corporate = { ...station, communityType: 'CORPORATE', typeSettings: { categories: [category] } };
    const event = communityPolicyEvent(kind, raw);
    assert.equal(event.category, category); assert.equal(matchesCommunityPolicy(corporate, event), true);
  }
});


test('typed rating, league, feed, thread and chat payloads redact contact identities; ordinary payloads retain compatibility', () => {
  const privatePhone = ['7', '900', '000', '00', '01'].join('');
  const row = { playerId: privatePhone, playerKey: 'phone:' + privatePhone, playerPhone: privatePhone, playerName: 'Игрок', score: 3 };
  const payload = { rows: [row], leagueTables: [{ id: 'division', name: 'Старт', rows: [row] }], posts: [{ memberPreview: { id: 'real', phone: privatePhone }, author: { id: 'real', phone: privatePhone } }], comments: [{ authorPhone: privatePhone }], messages: [{ authorPhone: privatePhone }] };
  assert.doesNotMatch(JSON.stringify(sanitizeTypedCommunityPayload(payload, true)), new RegExp(privatePhone + '|playerKey|authorPhone'));
  assert.equal(sanitizeTypedCommunityPayload(payload, true).rows[0].playerName, 'Игрок');
  assert.equal(JSON.stringify(sanitizeTypedCommunityPayload(payload)), JSON.stringify(payload));
  const flow = addTypedCommunityResponseRedaction([{ id: 'read', type: 'function', name: 'Community response', func: 'return [msg, msg];', outputs: 2, wires: [['response'], []] }, { id: 'response', type: 'http response' }]);
  assert.deepEqual(addTypedCommunityResponseRedaction(flow), flow);
  const result = vm.runInNewContext('(function(msg){' + flow[0].func + '\n})(msg)', { msg: { _typedCommunity: true, payload } });
  assert.doesNotMatch(JSON.stringify(result[0].payload), new RegExp(privatePhone));
  const mixedList = sanitizeTypedCommunityPayload({ communities: [{ communityType: 'STATION', members: [{ phone: privatePhone }] }, { members: [{ phone: privatePhone }] }] });
  assert.equal(mixedList.communities[0].members[0].phone, undefined);
  assert.equal(mixedList.communities[1].members[0].phone, privatePhone);
});

test('actual ranking/feed/thread/chat Node-RED response functions redact typed contact sentinels', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = (name: string) => common + source.split('const ' + name + ' = `${commonHelpers}')[1].split('\n`;')[0];
  const phone = ['7', '900', '000', '00', '02'].join('');
  const row = { playerId: phone, playerPhone: phone, playerKey: 'phone:' + phone, playerName: 'Игрок' };
  const author = { id: 'actor', phone, name: 'Автор' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['fnRankingSnapshotResponse', { _communityRatingCtx: { communityId: 'typed' }, payload: [{ rows: [row], leagueTables: [{ id: 'd', name: 'Дивизион', rows: [row] }] }] }],
    ['fnFeedResponse', { _communityFeed: { communityId: 'typed', slicedPosts: [{ id: 'post', kind: 'GAME', author, memberPreview: author }] }, payload: [] }],
    ['fnFeedThreadResponse', { _communityFeedThread: { communityId: 'typed', postId: 'post', comments: [{ id: 'comment', communityId: 'typed', postId: 'post', text: 'Комментарий', authorPhone: phone, authorId: 'actor', authorName: 'Автор', createdAt: now }] }, payload: [] }],
    ['fnChatGetResponse', { _communityChat: { communityId: 'typed', limit: 10 }, payload: [{ id: 'chat', communityId: 'typed', text: 'Сообщение', author, createdAt: now }] }],
  ];
  for (const [name, msg] of cases) {
    const graph = addTypedCommunityResponseRedaction([{ id: 'read', name: 'Community ' + name, type: 'function', func: body(name), outputs: 3, wires: [['response'], [], []] }, { id: 'response', type: 'http response' }]);
    const output = vm.runInNewContext('(function(msg){' + graph[0].func + '\n})(msg)', { msg: { ...msg, _typedCommunity: true } });
    assert.equal(output[0].statusCode, 200, name);
    assert.doesNotMatch(JSON.stringify(output[0].payload), new RegExp(phone), name);
    assert.ok(JSON.stringify(output[0].payload).includes(name === 'fnChatGetResponse' ? 'Сообщение' : name === 'fnRankingSnapshotResponse' ? 'Игрок' : name === 'fnFeedResponse' ? 'post' : 'Комментарий'), name);
  }
});
