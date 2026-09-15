import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../../src/utils/tournamentPendingPayment.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { mergeTournamentPendingPayment: merge, storeTournamentPendingPayment: store,
  clearTournamentPendingPayments: clear, canPayTournamentPending: canPay } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const pending = extra => ({ status: 'PAYMENT_PENDING', bookingId: 'booking-A', canRegister: false, canCancel: true,
  placeNumber: null, waitlistNumber: null, message: null, paymentUrl: 'https://checkout.example.test/A',
  paymentExpiresAt: '2099-01-01T00:00:00Z', ...extra });

test('F5/F6 binding, expiry, logout and unchanged valid recovery', async () => {
  const values = new Map();
  const previous = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } } });
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    values.set('padlhub:tournament-payment:event', JSON.stringify(pending()));
    const unbound = pending({ bookingId: 'booking-B', paymentUrl: null, paymentExpiresAt: null });
    assert.equal((await merge('fixture-session-A', 'event', unbound)).paymentUrl, null);
    assert.equal(values.has('padlhub:tournament-payment:event'), false);
    await store('fixture-session-A', 'event', pending());
    const missing = pending({ paymentUrl: null, paymentExpiresAt: null });
    assert.equal((await merge('fixture-session-A', 'event', missing)).paymentUrl, pending().paymentUrl);
    for (const [token, event, reg] of [
      ['fixture-session-B', 'event', missing], ['fixture-session-A', 'other-event', missing],
      ['fixture-session-A', 'event', unbound], ['fixture-session-A', 'event', { ...missing, bookingId: null }],
      [null, 'event', missing],
    ]) assert.equal((await merge(token, event, reg)).paymentUrl, null);
    assert.ok([...values.keys()].every(name => !name.includes('fixture-session-A')));
    for (const expiry of ['2020-01-01T00:00:00Z', 'bad', null]) {
      const result = await merge('fixture-session-A', 'event', pending({ paymentExpiresAt: expiry }));
      if (expiry !== null) assert.equal(result.paymentUrl, null);
    }
    assert.equal(canPay(pending({ paymentExpiresAt: '2020-01-01T00:00:00Z' })), false);
    assert.equal(canPay(pending({ paymentExpiresAt: null })), false);
    assert.equal(canPay(pending({ paymentUrl: 'javascript:alert(1)' })), false);
    assert.equal(canPay(pending({ paymentUrl: ['https://', 'user:pass', '@', 'checkout.example.test'].join('') })), false);
    const expiry = Date.parse(pending().paymentExpiresAt);
    assert.equal(canPay(pending(), expiry), false);
    assert.equal(canPay(pending(), expiry - 1), true);
    const token = extra => ['fixture', Buffer.from(JSON.stringify({ iss: 'https://identity.example.test', sub: 'actor-A', sid: 'session-A', auth_time: 1, exp: 4102444800, ...extra })).toString('base64url'), 'fixture'].join('.');
    await store(token({ iat: 1 }), 'event', pending());
    assert.equal((await merge(token({ iat: 2 }), 'event', missing)).paymentUrl, pending().paymentUrl);
    assert.equal((await merge(token({ exp: 1 }), 'event', missing)).paymentUrl, pending().paymentUrl); // Identity only; fresh server read supplies authority.
    assert.equal((await merge(token({ sub: 'actor-B' }), 'event', missing)).paymentUrl, null);
    assert.equal((await merge(token({ sid: 'session-B' }), 'event', missing)).paymentUrl, null);
    clear(); assert.equal(values.size, 0);
    assert.equal((await merge('fixture-session-A', 'event', missing)).paymentUrl, null);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('payment action rechecks expiry and auth; logout clears every payment partition', () => {
  const page = fs.readFileSync(new URL('../../src/components/tournament-signup/TournamentSignupPage.tsx', import.meta.url), 'utf8');
  const auth = fs.readFileSync(new URL('../../src/utils/authTokenStorage.ts', import.meta.url), 'utf8');
  assert.match(page, /registrationSessionIdentity !== tournamentPaymentSessionIdentity\(readAuthToken\(\)\) \|\| !canPayTournamentPending\(registration\)/);
  assert.match(page, /tournamentPaymentSessionIdentity\(paymentToken\) !== tournamentPaymentSessionIdentity\(readAuthToken\(\)\)/);
  assert.match(auth, /export function clearAuthTokens\(\) \{\s*clearTournamentPendingPayments\(\)/);
});
