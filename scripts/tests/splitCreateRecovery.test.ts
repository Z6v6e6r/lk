import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SplitCreateAttempts, confirmedSplitCreateResult, recoverSplitCreateResult,
  isAmbiguousSplitCreate, pendingSplitCreateResult, waitForSplitCreateResult } from '../../src/utils/splitCreateRecovery.ts';
import { moscowBookingEndIso } from '../../src/utils/bookingEndTime.ts';
import { hasDeterministicSubscriptionDecision } from '../../src/utils/subscriptionDecisionContract.ts';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const binding = { operationId: 'lk-split-create-synthetic', paymentRef: 'original-ref',
  clientSubscriptionId: id(2), studioId: id(3), roomId: id(4),
  fromTime: '2035-01-02T07:00:00+03:00', toTime: '2035-01-02T08:00:00+03:00' };
const success = () => ({ schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', mode: 'create',
  state: 'CONFIRMED', referenceSource: 'STORED_RECEIPT', ...binding, exerciseId: id(5), bookingId: id(6), selectedPaymentMode: 'subscription',
  toPayMinor: 0, toPay: 0, shareAmountMinor: 75000, shareAmount: 750,
  settlementState: 'CONFIRMED', paymentUrl: null, transactionId: null });
const pending = () => ({ data: { schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', state: 'PENDING_CONFIRMATION' }, error: null, status: 202 });

test('recovery accepts only a fully bound, explicit and consistent success', () => {
  assert.equal(confirmedSplitCreateResult(success(), binding), true);
  for (const change of [
    { state: 'PENDING_CONFIRMATION' }, { recovery: undefined }, { operationId: 'foreign' },
    { paymentRef: '' }, { clientSubscriptionId: id(8) }, { roomId: id(8) },
    { fromTime: '2035-01-03T07:00:00+03:00' }, { bookingId: null }, { toPayMinor: '0' },
    { toPay: 7 }, { paymentUrl: 'https://payments.example.test' }, { selectedPaymentMode: 'one_time' },
  ]) assert.equal(confirmedSplitCreateResult({ ...success(), ...change }, binding), false);
  const paid = { ...success(), toPayMinor: 10000, toPay: 100, settlementState: 'PAYMENT_REQUIRED',
    paymentUrl: 'https://payments.example.test', transactionId: id(9) };
  assert.equal(confirmedSplitCreateResult(paid, binding), true);
  assert.equal(confirmedSplitCreateResult({ ...paid, paymentUrl: 'javascript:alert(1)' }, binding), false);
});

test('bounded reads recover pending/failed status attempts without accepting an unbound result', async () => {
  let calls = 0;
  const r = await recoverSplitCreateResult(binding, async () => {
    calls++;
    return calls === 1 ? { data: { ...success(), bookingId: 'bad' }, error: null, status: 200 }
      : calls === 2 ? pending() : { data: success(), error: null, status: 200 };
  }, { session: () => 'synthetic-session', wait: async () => {}, delaysMs: [0, 0, 0] });
  assert.equal(r.status, 200);
  assert.equal(calls, 3);
  const missing = await recoverSplitCreateResult(binding, async () => ({ data: null, error: { status: 404, message: 'missing' }, status: 404 }),
    { session: () => 'synthetic-session', wait: async () => {} });
  assert.equal(missing.status, 202);
  assert.equal(missing.error, null);
});

test('abort and auth change discard even a late successful status response', async () => {
  for (const kind of ['abort', 'auth']) {
    const controller = new AbortController(); let session = 'synthetic-session';
    const r = await recoverSplitCreateResult(binding, async () => {
      if (kind === 'abort') controller.abort(); else session = 'new-session';
      return { data: success(), error: null, status: 200 };
    }, { signal: controller.signal, session: () => session, wait: async () => {} });
    assert.equal(r.status, 409);
    assert.equal(r.data, null);
  }
  const c = new AbortController(); c.abort();
  await assert.rejects(waitForSplitCreateResult(10000, c.signal), { name: 'AbortError' });
});

const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
const ast = ts.createSourceFile('apiClient.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'requestPadelSplitCreateWithPendingPoll');
assert.ok(fn);
const emitted = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const calls: { method: string; path?: string; ref?: string }[] = [];
  let session = 'synthetic-session', reads = 0;
  const context = {
    URLSearchParams, AbortController, readAuthToken: () => session, splitCreateAttempts: new SplitCreateAttempts(),
    isRecord: (value: unknown) => !!value && typeof value === 'object',
    getSplitCreateAttempts: () => context.splitCreateAttempts,
    isAmbiguousSplitCreate, recoverSplitCreateResult, pendingSplitCreateResult, moscowBookingEndIso,
    runWithAbortTimeout: async (_ms: number, run: (signal: AbortSignal) => unknown) => run(new AbortController().signal),
    requestPadelSplitPayment: async (_request: unknown, _base: string, params: { paymentRef: string }) => {
      calls.push({ method: 'POST', ref: params.paymentRef });
      return { data: null, error: { status: null, message: 'timeout', raw: { code: 'REQUEST_TIMEOUT' } }, status: null };
    },
    request: async (path: string, options: { method: string }) => {
      calls.push({ method: options.method, path }); reads++;
      return reads === 1 ? pending() : { data: success(), error: null, status: 200 };
    },
  };
  vm.createContext(context);
  vm.runInContext(emitted, context);
  const run = (context as unknown as { requestPadelSplitCreateWithPendingPoll: (...args: unknown[]) => Promise<{ data: unknown; error: unknown; status: number | null }> }).requestPadelSplitCreateWithPendingPoll;
  const params = { paymentMode: 'subscription', paymentRef: binding.paymentRef, clientSubscriptionId: id(2),
    studioId: id(3), roomId: id(4), date: '2035-01-02', fromTime: '07:00', toTime: '08:00' };
  return { calls, context, params, session: (value: string) => { session = value; }, run: (options = {}, p = params) =>
    run({ operationId: binding.operationId, path: '/lk/games/split/create?operationId=' + binding.operationId }, '', p,
      { delaysMs: [0, 0, 0], wait: async () => {}, ...options }) };
}
test('actual CREATE adapter: one original POST, GET-only late recovery, same paymentRef on later checks', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 200);
  assert.deepEqual(h.calls.map(c => c.method), ['POST', 'GET', 'GET']);
  assert.equal((await h.run({}, { ...h.params, paymentRef: 'new-ref-must-not-be-used' })).status, 200);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  for (const c of h.calls.filter(c => c.method === 'GET')) {
    const url = new URL(c.path!, 'https://example.test');
    assert.equal(url.pathname, '/lk/games/split/create-result');
    assert.deepEqual([...url.searchParams.keys()], ['operationId']);
    assert.equal(url.searchParams.get('operationId'), binding.operationId);
  }
});

test('reload preserves original opaque refs; quota failure cannot replace memory with stale stored refs', () => {
  const key = 'lk_split_create_attempt_refs_v1:';
  const data = new Map([[key + 'lk-split-create-old', JSON.stringify('old-ref')]]);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, value: string) => { data.set(k, value); } };
  const first = new SplitCreateAttempts(storage);
  first.begin(binding.operationId, binding.paymentRef);
  const reload = new SplitCreateAttempts(storage);
  assert.deepEqual(reload.begin(binding.operationId, 'new-ref'), { paymentRef: binding.paymentRef, recoveryOnly: true });
  const broken = new SplitCreateAttempts({ getItem: storage.getItem, setItem: () => { throw Error('QuotaExceeded'); } });
  broken.begin('lk-split-create-new', 'new-original-ref');
  assert.equal(broken.has('lk-split-create-new'), true);
  assert.deepEqual(broken.begin('lk-split-create-new', 'must-not-write'), { paymentRef: 'new-original-ref', recoveryOnly: true });
  const malformed = new SplitCreateAttempts({ getItem: () => '{invalid', setItem: () => {} });
  assert.throws(() => malformed.begin(binding.operationId, 'ref'), /JOURNAL_INVALID/);
  assert.equal(key.includes('token'), false);
  // Separate keys avoid read/modify/write loss of another tab's pending attempt.
  const other = new SplitCreateAttempts(storage); other.begin('lk-split-create-other', 'other-ref');
  first.complete(binding.operationId);
  assert.equal(new SplitCreateAttempts(storage).has('lk-split-create-other'), true);
});

test('a stored server receipt is canonical when two tabs supplied different local payment refs', async () => {
  const result = await recoverSplitCreateResult({ ...binding, paymentRef: 'other-local-ref' },
    async () => ({ data: success(), error: null, status: 200 }), { session: () => 'synthetic-session', wait: async () => {} });
  assert.equal((result.data as {paymentRef: string}).paymentRef, binding.paymentRef);
});

test('an ordinary legacy success returns without reads and retains its known operationId for completion', async () => {
  const h = harness();
  h.context.requestPadelSplitPayment = async () => ({ data: { ...success(), operationId: undefined, state: undefined }, error: null, status: 201 });
  Object.assign(h.context, { getServ2Origin: () => '',
    buildPadelSplitRequest: () => ({ operationId: binding.operationId, path: '/lk/games/split/create', options: {} }),
    normalizePadelSplitPaymentResult: (data: Record<string, unknown>) => ({ ...data, raw: data, operationId: data.operationId ?? null }),
    hasDeterministicSubscriptionDecision, markPadelSplitDecisionSettled: () => {},
    resolvePadelSplitPendingError: () => null,
  });
  const api = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'apiCreatePadelSplitGamePayment');
  assert.ok(api);
  vm.runInContext(ts.transpileModule(api.getText(ast).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h.context);
  const run = (h.context as unknown as { apiCreatePadelSplitGamePayment: (params: unknown) => Promise<{data: {operationId: string}}> }).apiCreatePadelSplitGamePayment;
  const result = await run({ ...h.params, clientPhone: 'synthetic-phone' });
  assert.equal(result.data.operationId, binding.operationId);
  assert.equal(h.calls.length, 0);
});

test('GET recovery has a bounded schedule and never retries an original CREATE on exhaustion', async () => {
  const h = harness(); let reads = 0;
  h.context.request = async () => { reads++; return pending(); };
  const result = await h.run();
  assert.equal(result.status, 202); assert.equal(reads, 3);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(h.context.splitCreateAttempts.has(binding.operationId), true);
});
test('actual CREATE adapter: definitive denial never polls; one-time behavior is unchanged', async () => {
  const h = harness();
  h.context.requestPadelSplitPayment = async () => ({ data: null, error: { status: 409, message: 'no visits' }, status: 409 });
  assert.equal((await h.run()).status, 409);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.splitCreateAttempts.has(binding.operationId), false);
  await h.run({}, { ...h.params, paymentMode: 'one_time' });
  assert.equal(h.calls.length, 0);
});
test('actual CREATE adapter: no calls after cancellation or missing auth, no poll after auth changes', async () => {
  const h = harness(); const c = new AbortController(); c.abort();
  assert.equal((await h.run({ signal: c.signal })).status, 409);
  assert.equal(h.calls.length, 0);
  h.context.requestPadelSplitPayment = async () => {
    h.session('another-session');
    return { data: null, error: { status: null, message: 'timeout', raw: {} }, status: null };
  };
  assert.equal((await h.run()).status, 409);
  assert.equal(h.calls.length, 0);
});
test('attempt references remain bounded and are cleared only after LK persistence or definitive refusal', () => {
  const store = new SplitCreateAttempts();
  assert.equal(store.begin('op', 'first').recoveryOnly, false);
  assert.deepEqual(store.begin('op', 'second'), { paymentRef: 'first', recoveryOnly: true });
  store.complete('op'); assert.equal(store.begin('op', 'second').recoveryOnly, false);
  for (let i = 0; i < 63; i++) store.begin(`extra-${i}`, 'ref');
  assert.throws(() => store.begin('overflow', 'ref'), /LIMIT/);
});
