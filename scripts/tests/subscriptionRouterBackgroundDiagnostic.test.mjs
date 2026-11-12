import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { subscriptionRouterBackgroundDiagnostic as diagnostic, diagnosticRuntimeSource,
  patchSubscriptionRouterDiagnosticSource, composeSubscriptionRouterDiagnosticCandidate } from '../lib/subscriptionRouterBackgroundDiagnostic.mjs';

const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_tournament_subscription_purchase_router.js', import.meta.url), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const nonce = '00000000-0000-4000-8000-000000000001';
const fixedCrypto = { ...crypto, randomUUID: () => nonce };
const plain = value => JSON.parse(JSON.stringify(value));
function run(msg, { cryptoModule = fixedCrypto, warn, getCrypto } = {}) {
  const warnings = [];
  const result = vm.runInNewContext(`(function(msg,node,global,env){${source}\n})(msg,node,global,env)`, {
    msg, node: { warn: value => { warnings.push(value); warn?.(value); } },
    global: { get: key => key === 'crypto' ? (getCrypto ? getCrypto() : cryptoModule) : undefined },
    env: { get: () => '' }, URL, URLSearchParams,
  }, { timeout: 1000 });
  return { result, warnings };
}
function failure(reconcile = true, step = 'token_confirm') {
  return { _summerSubscriptionCtx: { reconcile, step, counterKey: 'friendship' },
    statusCode: 401, payload: { privateBody: 'synthetic-private-body' },
    error: { message: 'synthetic-private-error' } };
}

test('known token and transaction errors produce precise static enums and a server-nonce hash', () => {
  for (const [step, error, originalError] of [
    ['token_confirm', 'Viva token error', 'VIVA_TOKEN_ERROR'],
    ['token_purchase', 'Viva token error', 'VIVA_TOKEN_ERROR'],
    ['confirm_lookup', 'Failed to fetch Viva transaction', 'VIVA_TRANSACTION_FETCH_FAILED'],
  ]) {
    const event = diagnostic(step, 502, error, () => fixedCrypto);
    assert.deepEqual(event, { event: 'subscription_router_background_failed',
      code: 'SUBSCRIPTION_ROUTER_BACKGROUND_FAILED', statusCode: 502, step, originalError,
      correlationHash: `c1:${hash(`lk-subscription-router-warning-v1\0${nonce}`)}`, correlationScope: 'WARNING_EVENT' });
    assert.ok(!JSON.stringify(event).includes(nonce));
  }
});

test('arbitrary error/status/step values never become log fields or hash inputs', () => {
  const privateValue = 'synthetic-private-input';
  const object = { toString() { throw new Error('must not stringify'); } };
  for (const value of [privateValue, 'VIVA_TOKEN_ERROR', '__proto__', 'constructor', '\nFORGED_LOG',
    'a'.repeat(10000), null, undefined, object, { code: privateValue }, [privateValue], 123]) {
    const hashed = [];
    const spy = { ...fixedCrypto, createHash: algorithm => {
      const inner = crypto.createHash(algorithm);
      return { update: input => { hashed.push(input); inner.update(input); return { digest: encoding => inner.digest(encoding) }; } };
    } };
    const event = diagnostic(value, value, value, () => spy);
    assert.equal(event.step, 'UNKNOWN'); assert.equal(event.originalError, 'UNKNOWN');
    assert.equal(event.statusCode, typeof value === 'number' && value === 123 ? 123 : null);
    assert.deepEqual(hashed, [`lk-subscription-router-warning-v1\0${nonce}`]);
    assert.ok(!JSON.stringify(event).includes(privateValue));
  }
});

test('correlation belongs to a warning occurrence, independent of user/payment/header/context values', () => {
  const a = diagnostic('token_confirm', 502, 'Viva token error', () => crypto);
  const b = diagnostic('token_confirm', 502, 'Viva token error', () => crypto);
  assert.match(a.correlationHash, /^c1:[a-f0-9]{64}$/);
  assert.notEqual(a.correlationHash, b.correlationHash);
  const msg = failure();
  msg._msgid = 'synthetic-private-id';
  msg.req = { headers: { 'x-correlation-id': 'synthetic-private-header' } };
  Object.assign(msg._summerSubscriptionCtx, { clientId: 'synthetic-private-client', paymentRef: 'synthetic-private-payment',
    token: 'synthetic-private-token', correlationHash: 'a'.repeat(64) });
  msg._lkDiagnosticContext = { correlationHash: 'b'.repeat(64) };
  const event = JSON.parse(run(msg).warnings[0]);
  assert.equal(event.correlationHash, `c1:${hash(`lk-subscription-router-warning-v1\0${nonce}`)}`);
  assert.ok(!JSON.stringify(event).includes('synthetic-private'));
  assert.deepEqual(Object.keys(event).sort(), ['code', 'correlationHash', 'correlationScope', 'event', 'originalError', 'statusCode', 'step']);
});

test('missing/broken crypto keeps safe diagnostics; no insecure hash or randomness fallback', () => {
  for (const getCrypto of [() => undefined, () => { throw new Error('synthetic-private-crypto-error'); },
    () => ({}), () => ({ randomUUID: () => 'synthetic-private-nonce' }),
    () => ({ randomUUID: () => nonce, createHash: () => { throw new Error('synthetic-private-hash-error'); } }),
    () => ({ randomUUID: () => nonce, createHash: () => ({ update: () => ({ digest: () => 'synthetic-private-digest' }) }) })]) {
    const event = diagnostic('token_confirm', 502, 'Viva token error', getCrypto);
    assert.equal(event.correlationHash, null);
    assert.equal(event.originalError, 'VIVA_TOKEN_ERROR');
    assert.ok(!JSON.stringify(event).includes('synthetic-private'));
  }
});

test('actual router token-confirm failure preserves response and four-port routing; logger failure is isolated', () => {
  for (const options of [{}, { cryptoModule: null }, { warn: () => { throw new Error('synthetic-logger-error'); } },
    { getCrypto: () => { throw new Error('synthetic-crypto-error'); } }]) {
    const msg = failure(), before = structuredClone(msg);
    const { result, warnings } = run(msg, options);
    assert.deepEqual(plain(result.slice(0, 3)), [null, null, null]);
    assert.equal(result[3].statusCode, 502);
    assert.deepEqual(plain(result[3].payload), { error: 'Viva token error', details: {
      step: 'token_confirm', statusCode: 401, error: before.error, payload: before.payload } });
    assert.deepEqual(msg, before);
    const event = JSON.parse(warnings[0]);
    assert.equal(event.step, 'token_confirm'); assert.equal(event.originalError, 'VIVA_TOKEN_ERROR');
    assert.equal(event.statusCode, 502); assert.ok(!warnings[0].includes('synthetic-private'));
  }
});

test('foreground failure and successful/delegated background routes mint no diagnostic nonce', () => {
  const forbidden = { randomUUID() { assert.fail('diagnostics must be lazy'); } };
  const foreground = run(failure(false), { cryptoModule: forbidden });
  assert.deepEqual(foreground.warnings, []);
  assert.equal(foreground.result[2], foreground.result[3]);
  assert.equal(foreground.result[2].payload.error, 'Viva token error');
  const success = run({ _summerSubscriptionCtx: { reconcile: true, step: 'token_purchase', counterKey: 'friendship' },
    statusCode: 200, payload: { access_token: 'synthetic-token' } }, { cryptoModule: forbidden });
  assert.deepEqual(success.warnings, []); assert.ok(success.result[0]);
  const delegated = run({ _summerSubscriptionCtx: { reconcile: true, step: 'annual_history_begin' } }, { cryptoModule: forbidden });
  assert.deepEqual(delegated.warnings, []); assert.ok(delegated.result[4]);
});

const warning = `    if (typeof node !== "undefined" && typeof node.warn === "function") {
      node.warn(JSON.stringify({ event: "subscription_router_background_failed",
        code: "SUBSCRIPTION_ROUTER_BACKGROUND_FAILED", statusCode: status }));
    }`;
const fixtureSource = `const fail = (status, error, details) => {
  if (msg._summerSubscriptionCtx?.reconcile === true) {
${warning}
    return [null, null, null, {statusCode: status, payload: {error, details}}];
  }
};
return fail(502, 'Viva token error', msg.payload);`;
function flowFixture() {
  return [{ id: 'fixture-active-tab', type: 'tab', disabled: false },
    { id: 'fixture-disabled-tab', type: 'tab', disabled: true },
    { id: 'fixture-owner', type: 'function', z: 'fixture-active-tab', name: 'Route tournament subscription payment',
      func: fixtureSource, outputs: 4, wires: [[], [], [], ['fixture-debug']] },
    { id: 'fixture-orphan', type: 'function', z: 'fixture-disabled-tab', name: 'Route tournament subscription payment',
      func: 'return msg;', outputs: 1, wires: [[]] },
    { id: 'fixture-debug', type: 'debug', active: false, console: false, wires: [] }];
}
const compose = flow => {
  const bytes = Buffer.from(JSON.stringify(flow));
  return composeSubscriptionRouterDiagnosticCandidate(bytes, hash(bytes), { expectedFunctionSha256: hash(fixtureSource) });
};

test('canonical node embeds exact generated helper; source anchors refuse repeat or unknown syntax', () => {
  const predecessor = execFileSync('git', ['show', 'f166b3cb74459e68dc0322304fab3c0b5f61f9c7:scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js'], { encoding: 'utf8' });
  const generation = JSON.parse(fs.readFileSync(new URL('../subscription_router_diagnostic_generation.json', import.meta.url)));
  assert.equal(generation.deploymentAuthorized, false);
  assert.equal(generation.targets.length, 1);
  assert.equal(generation.targets[0].preimageSha256, hash(predecessor));
  assert.equal(generation.targets[0].candidateSha256, hash(source));
  assert.equal(patchSubscriptionRouterDiagnosticSource(predecessor), source);
  assert.equal(source.split(diagnosticRuntimeSource).length, 2);
  const patched = patchSubscriptionRouterDiagnosticSource(fixtureSource);
  assert.ok(patched.includes(diagnosticRuntimeSource));
  assert.throws(() => patchSubscriptionRouterDiagnosticSource(patched), /anchor drift/);
  for (const bad of [fixtureSource.replace('node.warn', 'node.error'), fixtureSource + warning,
    fixtureSource.replace('const fail =', 'const failChanged ='), fixtureSource + '\nprivate invalid syntax']) {
    assert.throws(() => patchSubscriptionRouterDiagnosticSource(bad));
  }
});

test('guarded candidate changes only active owner.func and preserves disabled same-name node/topology', () => {
  const flow = flowFixture(), before = structuredClone(flow), built = compose(flow);
  const after = JSON.parse(built.candidateBytes);
  assert.deepEqual(flow, before);
  assert.notEqual(after[2].func, before[2].func);
  after[2].func = before[2].func;
  assert.deepEqual(after, before);
  assert.equal(built.report.changedFieldCount, 1); assert.equal(built.report.topologyUnchanged, true);
  const bytes = Buffer.from(JSON.stringify(flow));
  assert.throws(() => composeSubscriptionRouterDiagnosticCandidate(bytes, hash(bytes)), /source preimage drift/);
  assert.throws(() => composeSubscriptionRouterDiagnosticCandidate(bytes, '0'.repeat(64)), /Flow preimage drift/);
  assert.throws(() => composeSubscriptionRouterDiagnosticCandidate(Buffer.from('synthetic invalid json'), hash('synthetic invalid json')), /Invalid flow JSON/);
});

test('drifted, repeated, disabled, duplicate and ambiguous flow targets fail closed', () => {
  for (const mutate of [flow => { flow[2].func += '\n// drift'; }, flow => { flow[0].disabled = true; },
    flow => { flow[2].d = true; }, flow => { flow.push({ ...flow[2], id: 'fixture-extra-active' }); },
    flow => { flow.push({ ...flow[0] }); }, flow => { flow[2].func = patchSubscriptionRouterDiagnosticSource(fixtureSource); }]) {
    const flow = flowFixture(); mutate(flow); const before = structuredClone(flow);
    assert.throws(() => compose(flow)); assert.deepEqual(flow, before);
  }
});
