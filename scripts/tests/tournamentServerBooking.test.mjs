import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { describeTournamentLevelGate, resolveTournamentLevelGate, normalizeTournamentLevelDecision } from '../../src/utils/tournamentLevelDecision.ts';
import {
  createTournamentServerBookingKey,
  normalizeTournamentServerBookingView,
  resolveTournamentServerBookingOutcome,
  shouldUseTournamentServerBooking,
} from '../../src/utils/tournamentServerBooking.ts';
import { isTournamentCapacityError } from '../../src/utils/tournamentCapacityError.ts';
import { isSubscriptionBookingReleased } from '../../src/utils/subscriptionRejoin.ts';

const decision = (overrides = {}) => ({ schemaVersion: 1, policyVersion: 'tournament-level-v2', mode: 'ENFORCE', enforced: true,
  allowed: true, reasonCode: 'LEVEL_ALLOWED', message: 'ok', ruleKind: 'RANGE', baseRange: { min: 3, max: 3.5 }, allowedGrades: null,
  levelTolerance: 0.2, effectiveRange: { min: 2.8, max: 3.7 }, playerLevel: 3.31, ruleVersion: 'fixture', ...overrides });
const allowedGate = resolveTournamentLevelGate({ decision: normalizeTournamentLevelDecision(decision()), requestFailed: false, notFound: false, levelRestrictedHint: true });
const openGate = { kind: 'OPEN', decision: null };

test('server booking is used only when enabled, CUP admitted a restricted tournament and the product is one-time', () => {
  assert.equal(shouldUseTournamentServerBooking({ enabled: true, gate: allowedGate, productSource: 'one-time' }), true);
  assert.equal(shouldUseTournamentServerBooking({ enabled: true, gate: allowedGate, productSource: 'client-one-time' }), true);
  assert.equal(shouldUseTournamentServerBooking({ enabled: false, gate: allowedGate, productSource: 'one-time' }), false);
  assert.equal(shouldUseTournamentServerBooking({ enabled: true, gate: openGate, productSource: 'one-time' }), false);
  assert.equal(shouldUseTournamentServerBooking({ enabled: true, gate: allowedGate, productSource: 'client-subscription' }), false);
});

test('idempotency key matches the CUP format', () => {
  const key = createTournamentServerBookingKey(() => '123e4567-e89b-42d3-a456-426614174000');
  assert.match(key, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(key, 'lk1-123e4567-e89b-42d3-a456-426614174000');
});

test('CUP answers map to separate screen outcomes', () => {
  assert.deepEqual(resolveTournamentServerBookingOutcome({ status: 200, error: null,
    data: { state: 'PAYMENT_PENDING', bookingId: 'b-1', paymentUrl: 'https://pay.example/x', toPayMinor: 250000 } }),
  { kind: 'PAY', bookingId: 'b-1', paymentUrl: 'https://pay.example/x' });
  assert.deepEqual(resolveTournamentServerBookingOutcome({ status: 200, error: null, data: { state: 'CONFIRMED', toPayMinor: 0 } }), { kind: 'CONFIRMED' });
  for (const state of ['BOOKING', 'BOOKING_UNKNOWN', 'PAYMENT_UNKNOWN', 'PAYMENT_CREATING', 'BOOKED', 'ADMITTED']) {
    assert.equal(resolveTournamentServerBookingOutcome({ status: 200, error: null, data: { state } }).kind, 'PROCESSING', state);
  }
  // Non-https payment URL is never followed.
  assert.equal(resolveTournamentServerBookingOutcome({ status: 200, error: null, data: { state: 'PAYMENT_PENDING', paymentUrl: 'javascript:alert(1)' } }).kind, 'PROCESSING');
  const failed = resolveTournamentServerBookingOutcome({ status: 200, error: null, data: { state: 'FAILED', errorCode: 'CAPACITY_FULL' } });
  assert.equal(failed.kind, 'FAILED');
  assert.equal(failed.retryWithNewKey, true);
  const refused = resolveTournamentServerBookingOutcome({ status: 403, data: null,
    error: { message: 'x', raw: { code: 'LEVEL_NOT_ALLOWED', levelDecision: decision({ allowed: false, reasonCode: 'LEVEL_NOT_ALLOWED', playerLevel: 3.8 }) } } });
  assert.equal(refused.kind, 'REFUSED');
  assert.equal(refused.gate.kind, 'BLOCKED');
  assert.match(refused.message, /3,80 вне допустимых границ 2,80–3,70/);
  assert.equal(resolveTournamentServerBookingOutcome({ status: 409, data: null, error: { raw: { code: 'SERVER_BOOKING_IN_PROGRESS' } } }).kind, 'PROCESSING');
  const transport = resolveTournamentServerBookingOutcome({ status: null, data: null, error: { message: 'Network' } });
  assert.equal(transport.kind, 'FAILED');
  assert.equal(transport.retryWithNewKey, false, 'an unknown result keeps the same key');
  assert.equal(normalizeTournamentServerBookingView({ state: 'WHATEVER' }), null);
});

const source = ts.createSourceFile('signup.tsx', fs.readFileSync('src/components/tournament-signup/TournamentSignupPage.tsx', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function hook(name, dependencies) {
  let callback;
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  })(source);
  const js = ts.transpileModule(`const callback = ${callback.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), `${js}; return callback`)(...Object.values(dependencies));
}

function signupDeps(serverAnswer, enabled = true) {
  const calls = { viva: 0, server: [], navigated: [], changes: [] };
  const checkout = { profile: { id: 'fixture-actor', phone: 'fixture-phone' } };
  const deps = { selectedId: 'fixture-tournament', selectedExerciseId: 'fixture-event', actionLoading: false,
    subscriptionUsageShadowEnabled: false, isAuthenticated: true, isRestoringSession: false, checkout,
    discountPending: false, discountError: null, currentDiscountQuotes: [], checkoutRequestIdRef: { current: 1 },
    readAuthToken: () => 'fixture-session', tournamentPaymentSessionIdentity: value => value, normalizePhone: value => value,
    detail: { levelLabel: 'C' }, selectedTournament: null, isTournamentCapacityError, isSubscriptionBookingReleased,
    resolveTournamentLevelGate, describeTournamentLevelGate, TOURNAMENT_SERVER_BOOKING_ENABLED: enabled,
    shouldUseTournamentServerBooking, resolveTournamentServerBookingOutcome,
    createTournamentServerBookingKey: () => 'lk1-fixture-key', serverBookingKeysRef: { current: new Map() },
    apiFetchTournamentLevelDecision: async () => ({ status: 200, error: null, data: normalizeTournamentLevelDecision(decision()) }),
    apiCreateTournamentServerBooking: async (id, key) => { calls.server.push([id, key]); return serverAnswer(); },
    apiCreateTournamentVivaTransaction: async () => { calls.viva += 1; return { status: 200, data: {}, error: null }; },
    storeTournamentPendingPayment: async () => {}, canPayTournamentPending: () => true, PAYMENT_HOLD_MS: 900000,
    navigateToExternalUrl: url => { calls.navigated.push(url); return true; },
    loadPublicRoster: async () => {}, loadDetail: async () => {}, loadList: async () => {}, clearStoredPendingPayment: () => {},
  };
  for (const name of ['setActionLoading', 'setError', 'setSubscriptionConfirmationNotice', 'setConfirmingSubscriptionProductKey',
    'setCheckout', 'setLevelGate', 'setRegistration', 'setRegistrationSessionIdentity', 'setDiscountQuotes']) {
    deps[name] = value => calls.changes.push([name, value]);
  }
  return { deps, calls, checkout };
}

test('enabled: a one-time payment goes through CUP and never creates a Viva transaction from LK1', async () => {
  const { deps, calls, checkout } = signupDeps(async () => ({ status: 200, error: null,
    data: { state: 'PAYMENT_PENDING', bookingId: 'b-1', paymentUrl: 'https://pay.example/x' } }));
  await hook('completeVivaRegistration', deps)(checkout, { id: 'one-time-1', source: 'one-time' });
  assert.equal(calls.viva, 0);
  assert.deepEqual(calls.server, [['fixture-tournament', 'lk1-fixture-key']]);
  assert.deepEqual(calls.navigated, ['https://pay.example/x']);
  assert.equal(calls.changes.find(([name]) => name === 'setRegistration')[1].status, 'PAYMENT_PENDING');
});

test('enabled: a retry after an unknown result reuses the same idempotency key', async () => {
  const { deps, calls, checkout } = signupDeps(async () => ({ status: null, data: null, error: { message: 'Network' } }));
  await hook('completeVivaRegistration', deps)(checkout, { id: 'one-time-1', source: 'one-time' });
  deps.createTournamentServerBookingKey = () => 'lk1-other-key';
  await hook('completeVivaRegistration', deps)(checkout, { id: 'one-time-1', source: 'one-time' });
  assert.deepEqual(calls.server.map(([, key]) => key), ['lk1-fixture-key', 'lk1-fixture-key']);
  assert.equal(calls.viva, 0);
});

test('enabled: a CUP refusal blocks signup with the server reason', async () => {
  const { deps, calls, checkout } = signupDeps(async () => ({ status: 403, data: null,
    error: { message: 'x', raw: { levelDecision: decision({ allowed: false, reasonCode: 'LEVEL_NOT_ALLOWED', playerLevel: 3.8 }) } } }));
  await hook('completeVivaRegistration', deps)(checkout, { id: 'one-time-1', source: 'one-time' });
  assert.equal(calls.changes.filter(([name]) => name === 'setLevelGate').at(-1)[1].kind, 'BLOCKED');
  assert.match(calls.changes.filter(([name]) => name === 'setError').at(-1)[1], /вне допустимых границ/);
  assert.equal(calls.viva, 0);
});

test('disabled (default) or subscription product: the existing Viva path is unchanged', async () => {
  for (const [enabled, source] of [[false, 'one-time'], [true, 'client-subscription']]) {
    const { deps, calls, checkout } = signupDeps(async () => assert.fail('server booking must not be called'), enabled);
    await hook('completeVivaRegistration', deps)(checkout, { id: 'p', source });
    assert.equal(calls.server.length, 0);
    assert.equal(calls.viva, 1);
  }
});
