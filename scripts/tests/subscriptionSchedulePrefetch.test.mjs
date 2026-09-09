import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production hooks, including the actual request/error handling.
const source = readFileSync('src/components/games/GamesPage.tsx', 'utf8');
const ast = ts.createSourceFile('GamesPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'GamesPage');
const statements = page.body.statements.map(node => node.getText(ast));
const pick = text => {
  const found = statements.filter(statement => statement.includes(text));
  assert.equal(found.length, 1, `unique production statement: ${text}`);
  return found[0];
};
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const schedule = compile(pick('apiFetchMasterServiceTimeslots(formatDateLocalIso(targetDate)'));
const loader = compile(pick('const loadSplitSubscriptions = useCallback').replace('const loadSplitSubscriptions', 'let loadSplitSubscriptions'));
const enabled = compile(pick('const splitSubscriptionsEnabled ='));
const subscriptionEffect = compile(pick('if (!splitSubscriptionsEnabled) return;'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function harness() {
  const timetable = deferred();
  const subscriptions = deferred();
  let calls = 0;
  let lastDependencies;
  let cleanup;
  const state = {
    step: 'time', studioId: 'synthetic-studio', dates: ['2030-01-01'], dateIndex: 0,
    studioMasterServiceId: 'synthetic-service', activeModePreferredSubServiceId: null,
    activeModeSubServiceIds: [], activeModePreferredRoomIds: [], resolvedGameFormat: 'doubles',
    duration: 60, selectedDate: '2030-01-01', splitRequiredDirectionIds: new Set(),
    splitRequiredTypeIds: new Set(), splitRequiredSubscriptionVisits: 1,
    usePublicCreateWizard: true, splitPaymentSelected: false,
    subscriptionPrefetchReady: false, loadingTimeslots: false, timeslotsError: null,
    splitSubscriptionsError: null, splitSubscriptionRequestRef: { current: 0 },
    subscriptionPrefetchReadyRef: { current: false },
    splitSubscriptionsLoading: false, splitSubscriptions: [], splitSubscriptionNamesById: {},
    formatDateLocalIso: value => value, matchesCourtNameByGameFormat: () => true,
    filterSplitEligibleSubscriptions: values => values, normalizeComparableId: value => value,
    apiFetchMasterServiceTimeslots: () => timetable.promise,
    apiFetchSubscriptions: () => { calls++; return subscriptions.promise; },
    apiFetchProfile: async () => ({ data: { phone: '' } }),
    useCallback: callback => callback,
  };
  for (const name of ['LoadingTimeslots', 'TimeslotsError', 'Timeslots', 'SubscriptionPrefetchReady', 'SplitSubscriptionsLoading', 'SplitSubscriptionsError', 'SplitSubscriptions', 'SplitSubscriptionNamesById']) {
    const key = name[0].toLowerCase() + name.slice(1);
    state[`set${name}`] = value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  }
  const context = vm.createContext(state);
  state.useEffect = callback => callback();
  vm.runInContext(schedule, context);
  vm.runInContext(`${loader}\nglobalThis.loadSplitSubscriptions = loadSplitSubscriptions;`, context);
  state.useEffect = (callback, dependencies) => {
    if (lastDependencies?.every((value, index) => Object.is(value, dependencies[index]))) return;
    cleanup?.();
    lastDependencies = dependencies;
    cleanup = callback();
  };
  return {
    state, timetable, subscriptions, calls: () => calls,
    render: () => vm.runInContext(`{ ${enabled}\n${subscriptionEffect} }`, context),
    unmount: () => cleanup?.(),
    refreshLoader: () => vm.runInContext("loadSplitSubscriptions = (previous => () => previous())(loadSplitSubscriptions);", context),
  };
}

test('starts after successful schedule, including empty schedule; payer selection reuses pending and resolved reads', async () => {
  const h = harness(); h.render(); assert.equal(h.calls(), 0);
  h.timetable.resolve({ data: [], error: null }); await tick(); h.render();
  assert.equal(h.calls(), 1); assert.equal(h.state.loadingTimeslots, false);
  assert.equal(h.state.splitSubscriptionsLoading, true);
  h.state.splitPaymentSelected = true; h.render(); assert.equal(h.calls(), 1);
  h.subscriptions.resolve({ data: { content: [{ subscriptionId: 'synthetic-subscription' }] }, error: null });
  await tick(); h.render(); assert.equal(h.state.splitSubscriptions.length, 1);
  h.state.splitPaymentSelected = false; h.render();
  h.state.splitPaymentSelected = true; h.render(); assert.equal(h.calls(), 1);
  assert.equal(h.state.splitSubscriptionsLoading, false);
});

test('failed schedule does not start speculative subscription reads', async () => {
  const h = harness(); h.render(); h.timetable.resolve({ data: [], error: { message: 'schedule unavailable' } });
  await tick(); h.render(); assert.equal(h.calls(), 0);
  assert.equal(h.state.timeslotsError, 'schedule unavailable');
});

test('subscription failure leaves schedule usable, does not loop, and allows payer-selection retry', async () => {
  const h = harness(); h.timetable.resolve({ data: [], error: null }); await tick(); h.render();
  h.subscriptions.resolve({ data: null, error: { message: 'subscriptions unavailable' } });
  await tick(); h.render(); h.render(); assert.equal(h.calls(), 1);
  assert.equal(h.state.timeslotsError, null); assert.equal(h.state.loadingTimeslots, false);
  assert.equal(h.state.splitSubscriptionsLoading, false);
  h.state.splitPaymentSelected = true; h.render(); assert.equal(h.calls(), 2);
  await tick(); h.render(); assert.equal(h.calls(), 2);
});

test('unmounted subscription request cannot publish late data', async () => {
  const h = harness(); h.timetable.resolve({ data: [], error: null }); await tick(); h.render(); h.unmount();
  h.subscriptions.resolve({ data: { content: [{ subscriptionId: 'late-subscription' }] }, error: null });
  await tick(); assert.equal(h.state.splitSubscriptions.length, 0);
});

test('ordinary non-public flow keeps its existing payer-selection trigger', async () => {
  const h = harness(); h.state.usePublicCreateWizard = false;
  h.timetable.resolve({ data: [], error: null }); await tick(); h.render(); assert.equal(h.calls(), 0);
  h.state.splitPaymentSelected = true; h.render(); assert.equal(h.calls(), 1);
});


test('same-flush schedule restart blocks an obsolete prefetch before queued React state resets commit', async () => {
  const h = harness(); h.timetable.resolve({ data: [], error: null }); await tick(); h.render();
  assert.equal(h.calls(), 1);
  // React effects still see the preceding render while the earlier schedule effect
  // has synchronously reset its ref and queued loading/ready state updates.
  h.refreshLoader();
  h.state.subscriptionPrefetchReadyRef.current = false;
  h.render(); assert.equal(h.calls(), 1);
  h.state.loadingTimeslots = true; h.state.subscriptionPrefetchReady = false; h.render();
  h.state.loadingTimeslots = false; h.state.subscriptionPrefetchReady = true;
  h.state.subscriptionPrefetchReadyRef.current = true; h.render();
  assert.equal(h.calls(), 2);
});


test('selected split payment waits for the new schedule then resumes even while enabled stays true', async () => {
  const h = harness(); h.state.splitPaymentSelected = true; h.render(); assert.equal(h.calls(), 0);
  h.timetable.resolve({ data: [], error: null }); await tick(); h.render(); assert.equal(h.calls(), 1);
  h.refreshLoader();
  h.state.subscriptionPrefetchReadyRef.current = false; h.render(); assert.equal(h.calls(), 1);
  h.state.subscriptionPrefetchReady = false; h.state.loadingTimeslots = true; h.render();
  h.state.subscriptionPrefetchReady = true; h.state.loadingTimeslots = false;
  h.state.subscriptionPrefetchReadyRef.current = true; h.render(); assert.equal(h.calls(), 2);
});
