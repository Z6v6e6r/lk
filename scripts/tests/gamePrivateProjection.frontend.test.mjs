import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { mergeRosterMetadata } from '../../src/components/games/rosterMetadata.ts';
import { fixture, getPublic, ids, phone, prepare, acknowledge, applyFixtureUpdate } from './helpers/gamePrivateProjectionFixture.mjs';

const path = 'src/components/games/GamesPage.tsx';
const text = fs.readFileSync(path, 'utf8');
const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function callback(name) {
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) result = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(result, name); return result;
}
function runnable(expression, scope) {
  return new Function(...Object.keys(scope), compile(`return (${expression});`))(...Object.values(scope));
}
const playerKey = row => row.id || row.clientId || row.phone;
const dedupe = rows => [...new Map(rows.map(row => [playerKey(row), row])).values()];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parseIds = value => Array.isArray(value) ? value.filter(Boolean) : typeof value === 'string' ? value.split(',').filter(Boolean) : [];

function scenario({ getFailure = 0, changedBinding = false, conflictPatch = 0, foreignBetweenStages = true, capacity = 4, fillCourtBeforeFinal = false } = {}) {
  let canonical = fixture(), reads = 0, patches = 0, providerCalls = 0;
  const calls = [], errors = [];
  const stale = getPublic(canonical);
  // Existing player/payment joined after the UI's original render.
  stale.participants = stale.participants.filter(row => row.id !== ids.player);
  stale.metadata.bookingIds = [];
  stale.metadata.splitPayment.payments = [];
  canonical.updatedAt = '2099-11-15T10:01:00.000Z';
  canonical.invite.maxPlayers = capacity;
  const scope = {
    gameRecordId: canonical.id, activeGameRecord: stale,
    detailsParticipants: stale.participants, detailsWaitlist: stale.waitlist, detailsMetadata: stale.metadata,
    detailsOrganizerPayload: stale.organizer, detailsOrganizerInMatch: true, detailsTeamSlots: [],
    detailsMaxPlayers: 8, detailsSplitShareCount: 4, detailsSplitPaymentMetadata: stale.metadata.splitPayment,
    profile: { clientId: ids.actor, clientPhone: phone(4) }, profileId: ids.actor, profilePhone: phone(4), profileName: 'Actor fixture', profilePhoto: null, profileGrade: 'D', profileRatingNumeric: 2,
    shareAmount: 0, paymentRef: 'fixture-payment', exerciseId: 'fixture-exercise',
    SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES: 10,
    normalizePhoneForGame: value => value ? String(value).replace(/\D/g, '') : null,
    normalizeComparableId: value => typeof value === 'string' ? value.trim().toLowerCase() : null,
    normalizeBookingId: value => typeof value === 'string' ? value.trim() : null,
    toFiniteNumber: value => value != null && Number.isFinite(Number(value)) ? Number(value) : null,
    parseBookingIdsFromUnknown: parseIds, isRecordObject: isRecord,
    dedupePlayersByIdentity: dedupe, getPadelPlayerIdentityKey: playerKey,
    excludePlayersAlreadyInRoster: (waiting, players) => waiting.filter(row => !players.some(p => playerKey(p) === playerKey(row))),
    isCurrentUserPlayer: row => row.id === ids.actor,
    buildStoredTeamSlots: rows => rows, extractSplitPaymentPhones: () => [], mergeRosterMetadata,
    resolveGameVivaExerciseId: row => row.booking?.exerciseId,
    resolveGameDetailsMaxPlayers: row => row.invite?.maxPlayers ?? 4,
    resolveSplitJoinShareCount: (share, max) => max <= 2 ? 2 : share ?? 4,
    waitlistEnabled: true,
    enqueuePendingPaymentSync: () => calls.push('enqueue-local-sync'),
    setGameRosterError: value => errors.push(value),
    setUpdatingGameRoster: () => {}, setGameDetailsMetaError: () => {}, setUpdatingGameMeta: () => {},
    setActiveGameRecordStore: () => {}, setParticipants: () => {}, setWaitlistPlayers: () => {},
    upsertGameRecordInStores: () => {}, setCommunityGames: () => {},
    isPadelGameRecordRelevantToIdentity: () => true,
    mergePadelGameRecord: (_base, incoming) => incoming,
    removeGameRecordFromStores: () => {}, setGameRecordId: () => {}, setStep: () => {},
    pushCabinetFlashNotice: () => {}, subscriptionDecisionNotice: 'fixture already confirmed',
    navigateToExternalUrl: () => { throw Error('No redirect for zero cost'); },
    notifyGameRecordsUpdated: () => {},
    apiCreatePadelSplitParticipantPayment: () => { throw Error('Provider replay forbidden'); },
    apiFetchPadelGameRecord: async (_id, options) => {
      reads++; calls.push({ type: 'GET', options });
      if (reads === getFailure) return { error: { message: 'fixture read failed' }, data: null };
      const data = getPublic(canonical);
      if (changedBinding) data.booking.exerciseId = 'other-exercise';
      return { error: null, data };
    },
    apiUpdatePadelGameRecord: async (_id, payload) => {
      patches++; calls.push({ type: 'PATCH', payload: structuredClone(payload) });
      if (patches === conflictPatch) canonical.updatedAt = 'foreign-concurrent-version';
      const { write, response } = prepare(canonical, payload);
      if (!write) return { data: null, error: { message: response.payload.error }, status: response.statusCode, conflictRecord: getPublic(canonical) };
      applyFixtureUpdate(canonical, write);
      const [reply] = acknowledge(write);
      if (patches === 1 && foreignBetweenStages) {
        canonical.participants.push({ id: 'foreign-between', name: 'Foreign between fixture', phone: phone(7), status: 'CONFIRMED' });
        canonical.metadata.bookingIds.push('foreign-between-booking');
        canonical.metadata.splitPayment.payments.push({ clientId: 'foreign-between', bookingId: 'foreign-between-booking', phone: phone(7), status: 'PAID' });
        if (fillCourtBeforeFinal) canonical.participants.push({ id: 'foreign-last-seat', name: 'Last seat fixture', phone: phone(8), status: 'CONFIRMED' });
        canonical.updatedAt = '2099-11-15T10:02:00.000Z';
      }
      return { data: getPublic(canonical), status: reply.statusCode, error: null };
    },
  };
  scope.buildDetailsRosterMetadata = runnable(callback('buildDetailsRosterMetadata').getText(source), scope);
  scope.patchGameRoster = runnable(callback('patchGameRoster').getText(source), scope);
  const handler = callback('handleSplitJoinCurrentUserFromDetails');
  const statements = handler.body.statements.find(node => ts.isTryStatement(node)).tryBlock.statements;
  const first = statements.findIndex(node => node.getText(source).startsWith('const pendingBaseResult ='));
  assert.ok(first >= 0);
  const continuation = statements.slice(first).map(node => node.getText(source)).join('\n');
  const run = async () => {
    providerCalls++;
    const paymentResult = { error: null, data: { bookingId: 'confirmed-actor-booking', exerciseId: 'fixture-exercise', paymentRef: 'fixture-payment', toPay: 0, toPayMinor: 0, paymentUrl: null, shareAmount: 0, spot: 4, transactionId: null } };
    await runnable(`async () => { ${continuation} }`, { ...scope, paymentResult })();
  };
  return { run, calls, errors, current: () => canonical, counts: () => ({ reads, patches, providerCalls }), scope };
}

test('actual zero-cost continuation uses fresh roster/version/payment metadata in both stages and keeps foreign joins', async () => {
  const fixture = scenario(); await fixture.run();
  assert.deepEqual(fixture.counts(), { reads: 2, patches: 2, providerCalls: 1 });
  const writes = fixture.calls.filter(row => row.type === 'PATCH');
  assert.equal(Object.hasOwn(writes[0].payload, 'organizer'), false);
  assert.equal(writes[0].payload.expectedUpdatedAt, '2099-11-15T10:01:00.000Z');
  assert.equal(writes[1].payload.expectedUpdatedAt, '2099-11-15T10:02:00.000Z');
  assert.ok(writes[0].payload.participants.some(row => row.id === ids.player));
  assert.ok(writes[1].payload.participants.some(row => row.id === 'foreign-between'));
  const game = fixture.current();
  assert.equal(game.participants.find(row => row.id === ids.actor).status, 'CONFIRMED');
  for (const id of ['existing-booking', 'foreign-between-booking', 'confirmed-actor-booking']) assert.ok(game.metadata.bookingIds.includes(id), id);
  assert.equal(game.metadata.splitPayment.payments.find(row => row.clientId === ids.actor).status, 'PAID');
  assert.equal(game.participants.find(row => row.id === ids.player).phone, phone(2));
  assert.equal(game.organizer.phone, phone(1));
});
for (const options of [{ getFailure: 1 }, { changedBinding: true }, { conflictPatch: 1 }, { getFailure: 2 }, { conflictPatch: 2 }]) test(`post-confirmation failure stops without provider replay: ${JSON.stringify(options)}`, async () => {
  const fixture = scenario(options); await fixture.run();
  assert.equal(fixture.counts().providerCalls, 1);
  assert.ok(fixture.errors.some(Boolean));
  assert.ok(fixture.counts().patches <= (options.getFailure === 1 || options.changedBinding ? 0 : options.getFailure === 2 || options.conflictPatch === 1 ? 1 : 2));
});
for (const name of ['patchGameRoster', 'saveDetailsMetadata']) test(`${name} does not echo privacy-projected organizer`, async () => {
  const fixture = scenario();
  const invoke = runnable(callback(name).getText(source), fixture.scope);
  if (name === 'patchGameRoster') await invoke(fixture.scope.detailsParticipants, fixture.scope.detailsWaitlist);
  else await invoke(fixture.scope.detailsMetadata, 'fixture fallback');
  assert.equal(Object.hasOwn(fixture.calls.find(row => row.type === 'PATCH').payload, 'organizer'), false);
});

test('own pending placeholder becomes CONFIRMED when the paid provider spot still fits', async () => {
  const fixture = scenario({ foreignBetweenStages: false }); await fixture.run();
  const game = fixture.current(); assert.equal(game.participants.find(r => r.id === ids.actor).status, 'CONFIRMED');
  assert.equal(game.waitlist.some(r => r.id === ids.actor), false);
});
test('fresh capacity and share count are used instead of stale UI values', async () => {
  const fixture = scenario({ foreignBetweenStages: false, capacity: 2 }); await fixture.run();
  const game = fixture.current(); assert.equal(game.participants.length, 2);
  assert.equal(game.waitlist.find(r => r.id === ids.actor).status, 'WAITLIST');
  assert.equal(game.metadata.splitPayment.shareCount, 2);
  assert.equal(fixture.counts().providerCalls, 1);
});
test('a concurrent last seat is kept, and the paid actor is not silently truncated', async () => {
  const fixture = scenario({ fillCourtBeforeFinal: true }); await fixture.run();
  const game = fixture.current(); assert.ok(game.participants.some(r => r.id === 'foreign-last-seat'));
  assert.equal(game.waitlist.find(r => r.id === ids.actor).status, 'WAITLIST');
  assert.ok(game.metadata.bookingIds.includes('confirmed-actor-booking'));
  assert.equal(fixture.counts().providerCalls, 1);
});

const inviteText = fs.readFileSync('src/components/games/GameJoinPage.tsx', 'utf8');
const inviteContinuation = inviteText.slice(inviteText.indexOf('        const confirmedBase ='), inviteText.indexOf('\n      const localMembershipId ='));
assert.ok(inviteContinuation.endsWith('      }\n'));
const inviteBody = inviteContinuation.slice(0, inviteContinuation.lastIndexOf('      }'));
async function inviteScenario({ readError = false, changedBinding = false, conflict = false, paid = true, capacity = 4 } = {}) {
  const canonical = fixture(); canonical.invite.maxPlayers = capacity;
  canonical.updatedAt = 'fresh-invite-version';
  const stale = getPublic(canonical); stale.participants = []; stale.metadata.bookingIds = [];
  const calls = [], errors = [], location = {};
  const scope = {
    apiFetchPadelGameRecord: async (_id, options) => {
      calls.push({ type: 'GET', options });
      const data = getPublic(canonical); if (changedBinding) data.booking.exerciseId = 'other';
      return { data, error: readError ? { message: 'fixture read error' } : null };
    },
    apiUpdatePadelGameRecord: async (_id, payload) => {
      calls.push({ type: 'PATCH', payload });
      if (conflict) canonical.updatedAt = 'foreign-invite-version';
      const { write, response } = prepare(canonical, payload);
      if (!write) return { error: { message: response.payload.error }, conflictRecord: getPublic(canonical) };
      applyFixtureUpdate(canonical, write); return { data: getPublic(canonical) };
    },
    resolveGameExerciseId: row => row.booking.exerciseId, resolveMaxPlayers: row => row.invite.maxPlayers,
    resolveSplitJoinShareCount: (share, max) => max <= 2 ? 2 : share ?? 4,
    getSplitShareCount: row => row.metadata.splitPayment.shareCount,
    resolveSplitPaymentMetadata: row => row.metadata.splitPayment,
    dedupePlayers: dedupe, removePlayer: (rows, _phone, id) => rows.filter(row => row.id !== id),
    isRecord, parseBookingIdsFromUnknown: parseIds,
    normalizePhone: value => value || null, toFiniteNumber: value => value ?? null,
    profile: { id: ids.actor, phone: phone(4) }, myPhoneNorm: phone(4),
    myPlayer: { id: ids.actor, name: 'Invite actor fixture', phone: phone(4) },
    exerciseId: 'fixture-exercise', paymentRef: 'invite-actor-payment', shareAmount: 0, nextSpot: 4,
    comment: '', SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES: 10,
    paymentResult: { data: { bookingId: 'invite-actor-booking', exerciseId: 'fixture-exercise', toPay: paid ? 0 : 50, paymentUrl: paid ? null : 'https://fixture.invalid/pay', shareAmount: 0 } },
    setSubmitting: () => {}, setDecisionError: error => errors.push(error), setGame: () => {},
    notifyGameRecordUpdated: () => {}, pushCabinetFlashNotice: () => {}, subscriptionDecisionNotice: 'fixture confirmed',
    window: { location }, cabinetUrl: 'https://fixture.invalid/cabinet', buildCabinetGameUrl: () => 'https://fixture.invalid/game',
  };
  await runnable(`async () => { let actualGame = initialGame, maxPlayers = 8, shareCount = 8, participants = [], waitlist = [], splitPaymentMeta = {}, currentPayments = [], appliedStatus = 'NONE'; ${inviteBody} }`, { ...scope, initialGame: stale })();
  return { canonical, calls, errors, location };
}
test('actual invite continuation uses the fresh version, roster, share count and payment references', async () => {
  const result = await inviteScenario({ capacity: 2 });
  const patch = result.calls.find(row => row.type === 'PATCH').payload;
  assert.equal(patch.expectedUpdatedAt, 'fresh-invite-version');
  assert.equal(patch.metadata.splitPayment.shareCount, 2);
  assert.ok(patch.participants.some(row => row.id === ids.player));
  assert.ok(patch.metadata.bookingIds.includes('existing-booking'));
  assert.ok(result.canonical.metadata.bookingIds.includes('invite-actor-booking'));
  assert.equal(result.canonical.participants.find(row => row.id === ids.player).phone, phone(2));
  assert.ok(result.canonical.waitlist.some(row => row.id === ids.actor));
  assert.equal(result.location.href, 'https://fixture.invalid/game');
});
test('invite paid redirect is released only after the reference PATCH succeeds', async () => {
  const result = await inviteScenario({ paid: false });
  assert.equal(result.calls.filter(row => row.type === 'PATCH').length, 1);
  assert.equal(result.location.href, 'https://fixture.invalid/pay');
  assert.ok(result.canonical.metadata.bookingIds.includes('invite-actor-booking'));
});
for (const options of [{ readError: true }, { changedBinding: true }, { conflict: true }]) test(`invite continuation stops after confirmation without provider replay ${JSON.stringify(options)}`, async () => {
  const result = await inviteScenario(options);
  assert.ok(result.errors.length); assert.equal(result.location.href, undefined);
  assert.equal(result.calls.filter(row => row.type === 'PATCH').length, options.conflict ? 1 : 0);
});
