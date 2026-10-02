import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { isTrialGroupExercise } from '../lib/trialGroupEligibility.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const module = ts.transpileModule(read('../../src/utils/trialGroupTraining.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helpers = new Function('exports', module + '\nreturn exports;')({});
const source = ts.createSourceFile('api.ts', read('../../src/utils/tournamentSignupApi.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const entry = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'apiCreateTournamentVivaTransaction');
const compiled = ts.transpileModule(entry.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
async function invoke(params, response = { error: { status: 503, message: 'Fixture unavailable' }, status: 503 }) {
  const calls = []; let closed = false;
  const dependencies = { ...helpers,
    API_BASE: 'https://viva.example.test', TENANT_KEY: 'fixture',
    getServ2Origin: () => 'https://lk.example.test',
    apiCreateTournamentVivaBookingFromSubscription: async value => ({ routedSubscription: value }),
    createVivaPaymentWatcher: async () => ({ close() { closed = true; } }),
    buildTournamentPaymentReturnUrls: () => ({ successUrl: null, failUrl: null }),
    buildTournamentVivaTransactionPayload: () => ({ fixtureTransaction: true }),
    pickString: (value, keys) => keys.map(key => value?.[key]).find(value => typeof value === 'string') || null,
    request: async (url, options) => { calls.push({ url, options }); return response; },
  };
  const fn = new Function(...Object.keys(dependencies), compiled + '\nreturn apiCreateTournamentVivaTransaction;')(...Object.values(dependencies));
  return { result: await fn(params), calls, closed };
}
const params = (trial = true) => ({ exerciseId: 'fixture-event', clientId: 'fixture-actor',
  exercise: { id: 'fixture-event', type: { id: trial ? 1755 : 605 } },
  product: { id: 'fixture-product', type: 'SERVICE', source: 'one-time' } });

test('frontend and backend recognize the same catalogue aliases', () => {
  for (const value of [{ typeId: 1755 }, { exerciseType: { id: 1755 } }, { directionId: 4971 },
    { direction: 4971 }, { exerciseDirectionId: 4971 }, {}, { name: 'Пробная групповая' }]) {
    assert.equal(helpers.isTrialGroupTraining(value), isTrialGroupExercise(value));
  }
});
test('trial one-time checkout never falls back to direct Viva after a failed gate', async () => {
  const { calls, result, closed } = await invoke(params());
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/lk\/trial-group-bookings\?operationId=trial-/);
  assert.equal(calls[0].options.baseUrl, 'https://lk.example.test');
  assert.equal(calls[0].options.retries, 0); assert.equal(closed, true); assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(calls[0].options.body), { exerciseId: 'fixture-event', productId: 'fixture-product', source: 'one-time', promoCode: null });
});
test('uncertain checkout stops before client polling or a second provider POST', async () => {
  const { result, calls } = await invoke(params(), { error: null, status: 202, data: { state: 'PENDING_CONFIRMATION' } });
  assert.equal(result.error.status, 202); assert.equal(calls.length, 1);
});
test('subscription keeps server gateway; unsupported trial product cannot reach payment', async () => {
  const sub = params(); sub.product.source = 'client-subscription';
  assert.ok((await invoke(sub)).result.routedSubscription);
  const unsupported = params(); unsupported.product.source = 'subscription';
  const result = await invoke(unsupported); assert.equal(result.result.status, 409); assert.equal(result.calls.length, 0);
});
test('attempt stays stable on retry and only confirmed cancellation clears it', () => {
  const first = helpers.trialGroupCheckoutOperationId('fixture-event-cache', 'fixture-actor', 'fixture-product', null);
  assert.equal(helpers.trialGroupCheckoutOperationId('fixture-event-cache', 'fixture-actor', 'fixture-product', null), first);
  assert.notEqual(helpers.trialGroupCheckoutOperationId('fixture-event-cache', 'other', 'fixture-product', null), first);
  assert.notEqual(helpers.trialGroupCheckoutOperationId('fixture-event-cache', 'fixture-actor', 'fixture-product', null, 'client-one-time'), first);
  helpers.clearTrialGroupCheckoutOperations('fixture-event-cache');
  assert.notEqual(helpers.trialGroupCheckoutOperationId('fixture-event-cache', 'fixture-actor', 'fixture-product', null), first);
});
