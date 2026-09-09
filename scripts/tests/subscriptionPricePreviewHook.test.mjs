import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/components/games/useSubscriptionPricePreview.ts'], bundle: true,
  write: false, format: 'cjs', platform: 'node', external: ['react'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-preview-api', setup(builder) {
    builder.onResolve({ filter: /utils\/apiClient$/ }, () => ({ path: 'preview-api', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      'export const apiFetchSubscriptionPricePreview = (...args) => globalThis.requestPreview(...args);' }));
  } }],
});
const target = { targetKind: 'NEW_GAME', slotId: 'slot-a', stationId: 'station-a', roomId: 'room-a',
  masterServiceId: 'service-a', subServiceIds: ['sub-a'], startsAt: '2030-01-01T07:00:00+03:00', durationMinutes: 60, shareCount: 4 };
const key = value => value.targetKind === 'EXISTING_GAME' ? JSON.stringify([value.targetKind,value.gameId,value.startsAt,value.durationMinutes]) : JSON.stringify([value.slotId, value.stationId, value.roomId, value.masterServiceId,
  [...value.subServiceIds].sort(), value.startsAt, value.durationMinutes, value.shareCount]);
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let now = Date.parse('2030-01-01T00:00:00Z');
  let cursor = 0, dirty = false, timerId = 0;
  let effects = [];
  const hooks = [], timers = new Map(), requests = [];
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
    useMemo(factory, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (same(hooks[index]?.deps, deps)) return;
      effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: callback() }; });
    },
  };
  const context = vm.createContext({ module: { exports: {} }, exports: {},
    require: name => { assert.equal(name, 'react'); return React; }, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => { timers.set(++timerId, { at: now + delay, callback }); return timerId; },
    clearTimeout: id => timers.delete(id),
    requestPreview: (selection, ids, signal) => new Promise((resolve, reject) => {
      requests.push({ selection, ids, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const hook = context.module.exports.useSubscriptionPricePreview;
  const h = { props: { target, subscriptionIds: ['subscription-a', 'subscription-b'], actorId: 'actor-a', enabled: true, availabilityLoading: false },
    requests, result: null,
    render() {
      do {
        cursor = 0; dirty = false; effects = [];
        h.result = hook(h.props);
        effects.forEach(effect => effect());
      } while (dirty);
      return h.result;
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await tick(); h.render();
      }
      now = end; await tick(); h.render();
    },
    async resolve(index = requests.length - 1, change = {}) {
      const request = requests[index];
      request.resolve({ error: null, data: { quotes: request.ids.map((subscriptionId, i) => ({
        subscriptionId, selectionKey: key(request.selection), status: 'AVAILABLE', basePriceMinor: 75000,
        amountMinor: i ? 25000 : 0, freeMinutes: 60, paidMinutes: 0, reasonCode: 'ALLOWED',
        evaluatedAt: now, expiresAt: now + 30000, ...change,
      })) } });
      await tick(); h.render();
    },
    unmount() { hooks.forEach(value => value.cleanup?.()); },
  };
  h.render(); return h;
}

test('received prices survive TTL and unrelated renders without automatic reads', async () => {
  const h = harness(); await h.advance(300); await h.resolve();
  assert.equal(h.result.state, 'available'); assert.equal(h.result.bySubscriptionId['subscription-b'].amountMinor, 25000);
  await h.advance(5 * 60_000);
  h.props = { ...h.props, subscriptionIds: ['subscription-b', 'subscription-a'] }; h.render();
  assert.equal(h.result.state, 'available'); assert.equal(h.result.bySubscriptionId['subscription-b'].amountMinor, 25000);
  assert.equal(h.requests.length, 1);
});

test('already expired or malformed responses are not retained as valid prices', async () => {
  for (const change of [{ expiresAt: 1 }, { amountMinor: -1 }, { selectionKey: 'foreign' }]) {
    const h = harness(); await h.advance(300); await h.resolve(0, change);
    assert.equal(h.result.state, 'unavailable'); await h.advance(60000); assert.equal(h.result.amountMinor, null);
  }
});

test('target, actor and subscription-list changes immediately invalidate the displayed snapshot', async () => {
  for (const change of [{ target: { ...target, roomId: 'room-b' } }, { actorId: 'actor-b' }, { subscriptionIds: ['subscription-c'] }]) {
    const h = harness(); await h.advance(300); await h.resolve();
    h.props = { ...h.props, ...change }; h.render();
    assert.equal(h.result.state, 'checking'); assert.equal(h.result.amountMinor, null);
    await h.advance(300); assert.equal(h.requests.length, 2); await h.resolve(); assert.equal(h.result.state, 'available');
  }
});

test('late old response cannot replace the current target and closing cancels requests', async () => {
  const h = harness(); await h.advance(300);
  h.props = { ...h.props, target: { ...target, roomId: 'room-b' } }; h.render();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.resolve(0); assert.equal(h.result.amountMinor, null);
  await h.advance(300); h.unmount(); assert.equal(h.requests[1].signal.aborted, true); await tick();
});

test('timeout and explicit retry remain bounded, without background polling', async () => {
  const h = harness(); await h.advance(30000); assert.equal(h.result.state, 'unavailable');
  await h.advance(60000); assert.equal(h.requests.length, 1);
  h.result.refresh(); h.render(); await h.advance(300); assert.equal(h.requests.length, 2);
  await h.resolve(); assert.equal(h.result.state, 'available');
});

test('join quotes invalidate on game, date, account and options changes and ignore cancelled response',async()=>{
  const h=harness();h.props={...h.props,target:{targetKind:'EXISTING_GAME',gameId:'pay_a',startsAt:target.startsAt,durationMinutes:60}};h.render();
  await h.advance(300);await h.resolve();assert.equal(h.result.state,'available');
  h.props={...h.props,target:{...h.props.target,gameId:'pay_b'}};h.render();assert.equal(h.result.state,'checking');
  await h.advance(300);h.props={...h.props,actorId:'actor-b',availabilityLoading:true};h.render();
  assert.equal(h.requests.at(-1).signal.aborted,true);await h.resolve();assert.equal(h.result.amountMinor,null);
  await h.advance(1000);assert.equal(h.requests.length,2);
  h.props={...h.props,availabilityLoading:false,subscriptionIds:['subscription-new']};h.render();
  await h.advance(300);await h.resolve();assert.equal(h.result.state,'available');assert.deepEqual(Object.keys(h.result.bySubscriptionId),['subscription-new']);
});
