import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTrialGroupExercise, normalizeTrialGroupPolicy, trialVisitWindow, trialHistoryPage,
  evaluateTrialGroupVisits, trialAttendance, TRIAL_GROUP_HISTORY_CONTRACT,
} from '../lib/trialGroupEligibility.mjs';

const requestedAt = '2026-10-02T10:00:00.000Z';
const row = (id, overrides = {}) => ({ id: `booking-${id}`, clientId: 'fixture-actor',
  exerciseId: `event-${id}`, timeTo: '2026-07-02T10:00:00+03:00', visitConfirmed: true, ...overrides });
const evaluate = rows => evaluateTrialGroupVisits({ rows, actorId: 'fixture-actor', requestedAt });

test('trial selection uses stable catalogue IDs and ignores names and price markers', () => {
  for (const value of [{ type: { id: 1755 } }, { typeId: 1755 }, { exerciseType: { id: '1755' } },
    { direction: 4971 }, { exerciseDirectionId: 4971 }]) assert.equal(isTrialGroupExercise(value), true);
  for (const value of [{ name: 'Пробная групповая тренировка', typeId: 605 }, { trialCost: 0 }, null, {}]) {
    assert.equal(isTrialGroupExercise(value), false);
  }
});
test('off by default; activation requires a known version and verified history contract', () => {
  assert.equal(normalizeTrialGroupPolicy(undefined).mode, 'off');
  for (const mode of ['shadow', 'enforce']) {
    assert.ok(normalizeTrialGroupPolicy({ mode, version: 'trial-group-v1' }).code);
    assert.equal(normalizeTrialGroupPolicy({ mode, version: 'trial-group-v1', historyContract: TRIAL_GROUP_HISTORY_CONTRACT }).mode, mode);
  }
  for (const value of ['', { mode: 'bad' }, { mode: 'off', version: 'wrong' }]) assert.ok(normalizeTrialGroupPolicy(value).code);
});
test('six calendar months retain Moscow time, clamp month ends, cover leap years', () => {
  assert.equal(trialVisitWindow(requestedAt).from, '2026-04-02T10:00:00.000Z');
  assert.equal(trialVisitWindow('2026-08-31T12:00:00.000Z').from, '2026-02-28T12:00:00.000Z');
  assert.equal(trialVisitWindow('2024-08-31T12:00:00.000Z').from, '2024-02-29T12:00:00.000Z');
  assert.equal(trialVisitWindow('2026-10-01T22:00:00.000Z').from, '2026-04-01T22:00:00.000Z');
});
test('0..2 visits allowed; 3+ denied across categories and stations', () => {
  for (let count = 0; count <= 5; count++) {
    const result = evaluate(Array.from({ length: count }, (_, id) => row(id, { exerciseType: { id: id + 800 }, studioId: `station-${id}` })));
    assert.equal(result.count, count); assert.equal(result.eligible, count <= 2);
  }
});
test('lower bound inclusive, request instant exclusive, future and older visits excluded', () => {
  const result = evaluate([row(1, { timeTo: '2026-04-02T10:00:00Z' }),
    row(2, { timeTo: '2026-04-02T09:59:59Z' }), row(3, { timeTo: requestedAt }),
    row(4, { timeTo: '2026-10-02T09:59:59Z' }), row(5, { timeTo: '2030-01-01T10:00:00Z' })]);
  assert.equal(result.count, 2);
});
test('deduplication counts one actor/event and rejects conflicting attendance facts', () => {
  assert.equal(evaluate([row(1), row(1, { id: 'other-booking' })]).count, 1);
  assert.equal(evaluate([row(1), row(1, { visitConfirmed: false })]).code, 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED');
});
test('explicit attendance required; refunds retain attended visits', () => {
  assert.equal(evaluate([row(1, { status: 'REFUNDED' })]).count, 1);
  for (const status of ['PAID', 'COMPLETED', 'REFUNDED']) {
    assert.equal(trialAttendance({ status }), null);
  }
  for (const status of ['CANCELLED', 'NO_SHOW', 'WAITLIST']) {
    assert.equal(trialAttendance({ status }), false);
    assert.equal(trialAttendance({ status, visitConfirmed: true }), null);
  }
  for (const flags of [{ visitConfirmed: true, attended: false }, { visitConfirmed: 'true' }, {}]) {
    assert.equal(trialAttendance(flags), null);
  }
  assert.equal(evaluate([row(1, { visitConfirmed: false }), row(2, { visitConfirmed: false, status: 'NO_SHOW' })]).count, 0);
});
test('actor-scoped owner-less rows accepted, conflicting identities and unknown time rejected', () => {
  assert.equal(evaluate([row(1, { clientId: undefined })]).count, 1);
  for (const overrides of [{ clientId: 'other' }, { client: { id: 'other' } }, { clientId: null }]) {
    assert.equal(evaluate([row(1, overrides)]).code, 'TRIAL_TRAINING_HISTORY_IDENTITY_UNVERIFIED');
  }
  for (const overrides of [{ timeTo: undefined }, { timeTo: '2026-07-02' },
    { timeTo: '2026-02-30T10:00:00Z' }, { exerciseId: undefined }]) {
    assert.equal(evaluate([row(1, overrides)]).code, 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED');
  }
  assert.equal(evaluate([row(1, { exerciseDate: '2026-07-02', timeTo: '10:00:00' })]).count, 1);
});
test('pagination requires explicit completeness and correct page/total metadata', () => {
  const page = { content: [row(1)], number: 0, totalElements: 1, totalPages: 1, last: true };
  assert.equal(trialHistoryPage(page, 0).last, true);
  for (const value of [[], { content: [] }, { ...page, last: false }, { ...page, number: 1 },
    { ...page, totalElements: '1' }, { ...page, totalPages: 101 }]) assert.ok(trialHistoryPage(value, 0).code);
  assert.ok(trialHistoryPage(page, 0, 2).code);
  assert.equal(trialHistoryPage({ content: [], number: 0, totalElements: 0, totalPages: 0, last: true }, 0).total, 0);
});
