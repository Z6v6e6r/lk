import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/components/games/useSplitOrdinaryPrice.ts'], bundle: true,
  write: false, format: 'cjs', platform: 'node', external: ['react'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-price-api', setup(builder) {
    builder.onResolve({ filter: /utils\/apiClient$/ }, () => ({ path: 'price-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      'export const apiFetchMasterServicePrice = (...args) => globalThis.requestPrice(...args);' }));
  } }],
});

const nominalSplitPayment = {
  enabled: true, status: 'ACTIVE', shareCount: 4, shareAmount: 2500,
  bookingIds: ['booking-a'], payments: [{ role: 'PARTICIPANT', status: 'LEFT', amount: 1000 }],
};
const booking = {
  studioId: 'studio-piter', roomId: 'court-8', masterServiceId: 'service-1',
  subServiceIds: ['sub-1'], date: '2026-09-11', timeFrom: '21:30', timeTo: '22:30', durationMinutes: 60,
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(props = {}) {
  let cursor = 0, dirty = false, effects = [];
  const hooks = [], requests = [];
  const same = (a, b) => a && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: initial };
      return [hooks[index].value, value => {
        hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value;
        dirty = true;
      }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (same(hooks[index]?.deps, deps)) return;
      effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: callback() }; });
    },
  };
  const context = vm.createContext({
    module: { exports: {} }, exports: {},
    require: name => { assert.equal(name, 'react'); return React; },
    requestPrice: params => new Promise((resolve, reject) => { requests.push({ params, resolve, reject }); }),
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const hook = context.module.exports.useSplitOrdinaryPrice;
  const h = {
    props: {
      booking, metadata: null, splitPayment: nominalSplitPayment, shareCount: 4, enabled: true, ...props,
    },
    requests, result: null,
    render() {
      do {
        cursor = 0; dirty = false; effects = [];
        h.result = hook(h.props);
        effects.forEach(effect => effect());
      } while (dirty);
      return h.result;
    },
    async resolve(index = requests.length - 1, payload = { error: null, data: 4000 }) {
      requests[index].resolve(payload);
      await tick(); h.render();
    },
    unmount() { hooks.forEach(value => value.cleanup?.()); },
  };
  h.render(); return h;
}

test('a canonical stored share is trusted without any price lookup', () => {
  const h = harness({ splitPayment: { ...nominalSplitPayment, shareAmount: 1000, totalAmount: 4000 } });
  assert.equal(h.requests.length, 0);
  assert.equal(h.result.price, null);
  assert.equal(h.result.status, 'resolved');
});

test('a nominal stored share is re-priced from the exact Viva court price', async () => {
  const h = harness();
  assert.equal(h.requests.length, 1);
  const params = h.requests[0].params;
  assert.equal(params.date, '2026-09-11');
  assert.equal(params.fromTime, '21:30');
  assert.equal(params.toTime, '22:30');
  assert.equal(params.studioId, 'studio-piter');
  assert.equal(params.roomId, 'court-8');
  assert.equal(params.masterServiceId, 'service-1');
  assert.equal(params.subServiceIds.join(','), 'sub-1');
  assert.equal(h.result.price, null);
  assert.equal(h.result.status, 'pending');
  await h.resolve();
  assert.equal(h.result.status, 'resolved');
  assert.equal(h.result.price.totalAmount, 4000);
  assert.equal(h.result.price.shareAmount, 1000);
});

test('the exact court price is divided by the coerced share count', async () => {
  const h = harness({ splitPayment: { ...nominalSplitPayment, shareCount: 2 }, shareCount: 2 });
  await h.resolve(0, { error: null, data: 4000 });
  assert.equal(h.result.price.totalAmount, 4000);
  assert.equal(h.result.price.shareAmount, 2000);
});

test('an executed lookup without a usable price may fall back to the stored share', async () => {
  const h = harness();
  await h.resolve(0, { error: { status: 502, message: 'provider' }, data: null });
  assert.equal(h.result.status, 'failed');
  assert.equal(h.result.price, null);
});

test('a missing session is unavailable, never a normalised failure fallback', async () => {
  const h = harness();
  await h.resolve(0, { error: { status: 401, message: 'Не авторизован' }, data: null });
  assert.equal(h.result.status, 'unavailable');
  assert.equal(h.result.price, null);
});

test('a record without the exact station contract resolves to unavailable', async () => {
  for (const incomplete of [
    { booking: { ...booking, masterServiceId: null } },
    { booking: { ...booking, subServiceIds: [] } },
    { booking: { ...booking, roomId: null } },
  ]) {
    const h = harness(incomplete);
    assert.equal(h.requests.length, 0);
    assert.equal(h.result.price, null);
    await tick(); h.render();
    assert.equal(h.result.status, 'unavailable');
  }
});

test('a disabled hook performs no lookup and exposes no ordinary price', () => {
  const h = harness({ enabled: false });
  assert.equal(h.requests.length, 0);
  assert.equal(h.result.price, null);
});

test('a changed exact-price contract re-resolves and ignores the late first response', async () => {
  const h = harness();
  h.props = { ...h.props, booking: { ...booking, roomId: 'court-9' } };
  h.render();
  assert.equal(h.requests.length, 2);
  await h.resolve(0, { error: null, data: 8000 });
  assert.equal(h.result.status, 'pending');
  await h.resolve(1, { error: null, data: 4000 });
  assert.equal(h.result.price.totalAmount, 4000);
  assert.equal(h.result.price.shareAmount, 1000);
  h.unmount();
});

test('a malformed pricing-policy snapshot does not count as a canonical price', () => {
  const snapshot = harness({ splitPayment: { ...nominalSplitPayment, pricingPolicy: {} } });
  assert.equal(snapshot.requests.length, 1);
  const valid = harness({
    splitPayment: {
      ...nominalSplitPayment,
      pricingPolicy: {
        id: 'piter-split-250-per-hour-v1', pricingMode: 'PER_PARTICIPANT_HOUR', currency: 'RUB',
        twoTeamsHourlyAmount: 500, fourPlayersHourlyAmount: 250,
      },
    },
  });
  assert.equal(valid.requests.length, 0);
  assert.equal(valid.result.status, 'resolved');
});
