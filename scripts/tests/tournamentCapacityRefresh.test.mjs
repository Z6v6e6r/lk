import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { isTournamentCapacityError } from '../../src/utils/tournamentCapacityError.ts';
import { isSubscriptionBookingReleased } from '../../src/utils/subscriptionRejoin.ts';

const source = ts.createSourceFile('signup.tsx', fs.readFileSync(
  'src/components/tournament-signup/TournamentSignupPage.tsx', 'utf8'),
ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function hook(name, dependencies) {
  dependencies = { isSubscriptionBookingReleased, ...dependencies };
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(callback);
  const js = ts.transpileModule(`const callback = ${callback.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return callback`)(...Object.values(dependencies));
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('only an explicit terminal capacity error triggers a capacity refresh', () => {
  assert.equal(isTournamentCapacityError({ status: 409, message: 'Нет свободных мест', raw: { details: { code: 'CAPACITY_FULL' } } }), true);
  assert.equal(isTournamentCapacityError({ status: 409, message: 'Нет свободных мест', raw: { code: 'CONFLICT' } }), true);
  for (const error of [null, { status: 202, message: 'Нет свободных мест', raw: { details: { code: 'CONFLICT' } } },
    { status: 409, message: 'Другой конфликт', raw: { code: 'CONFLICT' } },
    { status: 409, message: 'Лимит подписки', raw: { details: { code: 'SUBSCRIPTION_LIMIT_REACHED' } } },
    { status: 503, message: 'Нет свободных мест', raw: { code: 'CAPACITY_FULL' } }]) {
    assert.equal(isTournamentCapacityError(error), false);
  }
});

test('capacity refresh updates roster and cards without repeating the booking or hiding its error', async () => {
  const checkout = { profile: { id: 'fixture-actor', phone: 'fixture-phone' } };
  const changes = [];
  let bookings = 0;
  const deps = { selectedId: 'fixture-tournament', selectedExerciseId: 'fixture-event', actionLoading: false,
    subscriptionUsageShadowEnabled: false, isAuthenticated: true, isRestoringSession: false,
    checkout, discountPending: false, discountError: null, currentDiscountQuotes: [],
    checkoutRequestIdRef: { current: 1 }, readAuthToken: () => 'fixture-session',
    tournamentPaymentSessionIdentity: value => value, normalizePhone: value => value,
    detail: null, selectedTournament: null, isTournamentCapacityError,
    apiCreateTournamentVivaTransaction: async () => { bookings++; return { status: 409, data: null,
      error: { status: 409, message: 'Нет свободных мест', raw: { details: { code: 'CAPACITY_FULL' } } } }; },
    loadPublicRoster: async (id, options) => { changes.push(['roster', id, options]); },
    loadList: async () => { assert.fail('List reload would clear the capacity error via the detail effect'); },
  };
  for (const name of ['setActionLoading', 'setError', 'setSubscriptionConfirmationNotice',
    'setConfirmingSubscriptionProductKey', 'setCheckout']) deps[name] = value => changes.push([name, value]);
  await hook('completeVivaRegistration', deps)(checkout, { id: 'fixture-subscription', source: 'client-subscription' });
  assert.equal(bookings, 1);
  assert.deepEqual(changes.filter(([name]) => name === 'roster'), [['roster', 'fixture-event', { force: true }]]);
  assert.equal(changes.filter(([name]) => name === 'setError').at(-1)[1], 'Нет свободных мест');
  assert.equal(changes.some(([name, value]) => name === 'setSubscriptionConfirmationNotice' && value), false);
  assert.deepEqual(changes.at(-1), ['setActionLoading', false]);
});

test('a forced refresh waits out the older request, then coalesces a fresh GET and updates shared card data', async () => {
  const old = deferred(), fresh = deferred();
  let calls = 0;
  let state = {};
  const refs = { current: {} };
  const requests = { current: new Map() };
  const load = hook('loadPublicRoster', { publicRosterByExerciseIdRef: refs,
    publicRosterRequestsRef: requests, apiFetchTournamentParticipants: () => (++calls === 1 ? old.promise : fresh.promise),
    normalizeTournamentSignupPublicRoster: value => value,
    setPublicRosterByExerciseId: update => { state = update(state); refs.current = state; },
  });
  const first = load('fixture-event');
  const forced1 = load('fixture-event', { force: true });
  const forced2 = load('fixture-event', { force: true });
  assert.equal(calls, 1);
  old.resolve({ data: { participantsCount: 8 } });
  await first;
  await Promise.resolve();
  assert.equal(calls, 2);
  fresh.resolve({ data: { participantsCount: 12 } });
  assert.deepEqual(await forced1, { participantsCount: 12 });
  assert.deepEqual(await forced2, { participantsCount: 12 });
  assert.deepEqual(state['fixture-event'], { participantsCount: 12 });
  assert.equal(requests.current.size, 0);
});

test('a failed roster refresh preserves the previous participants', async () => {
  const cached = { participantsCount: 8 };
  let writes = 0;
  const load = hook('loadPublicRoster', { publicRosterByExerciseIdRef: { current: { event: cached } },
    publicRosterRequestsRef: { current: new Map() },
    apiFetchTournamentParticipants: async () => ({ data: null, error: { message: 'unavailable' } }),
    setPublicRosterByExerciseId: () => { writes++; },
  });
  assert.equal(await load('event', { force: true }), cached);
  assert.equal(writes, 0);
});
