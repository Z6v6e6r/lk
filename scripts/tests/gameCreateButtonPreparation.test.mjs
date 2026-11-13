import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { isRequestTimeoutError, runWithAbortTimeout } from '../../src/utils/requestTimeout.ts';

const source = fs.readFileSync('src/components/games/GamesPage.tsx', 'utf8');
const file = ts.createSourceFile('GamesPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let button;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === 'button'
    && node.attributes.getText(file).includes('game-submit-inline')) button = node;
  ts.forEachChild(node, visit);
}
visit(file);
const emit = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Execute the production callbacks, not a copy of their control flow. No network.
function harness(stage) {
  const read = deferred();
  const state = { error: null, profileReads: 0, slotReads: 0, writes: 0, profileUpdates: 0, slotUpdates: 0, signal: null,
    cardPayloads: [], completed: [], step: null };
  const context = {
    AbortController, Promise, Date, Math, Set, isRequestTimeoutError, runWithAbortTimeout,
    subscriptionUsageShadowEnabled: false, studioId: 'studio', selectedDate: new Date('2030-01-01'),
    courtId: 'court', time: '20:00', duration: 60, selectedSlotId: 'slot', studioMasterServiceId: 'master',
    studioName: 'Station', selectedCourtName: 'Court', resolvedSelectedSubServiceIds: ['service'],
    activeModePreferredSubServiceId: 'service', activeModeSubServiceIds: ['service'], activeModePreferredRoomIds: [],
    resolvedGameFormat: 'doubles', GAME_BOOKING_MIN_LEAD_MINUTES: 30,
    checkGameBookingLeadTime: () => ({ ok: true }), hasRevalidatedGameSlot: () => true,
    matchesCourtNameByGameFormat: () => true, setTimeslots: () => state.slotUpdates++,
    profileId: stage === 'profile' ? null : 'client', profilePhone: stage === 'profile' ? null : 'synthetic-phone',
    setProfileId: value => { state.profileUpdates++; context.profileId = value; },
    setProfilePhone: value => { state.profileUpdates++; context.profilePhone = value; },
    apiFetchProfile: signal => { state.profileReads++; state.signal = signal; return read.promise; },
    apiFetchMasterServiceTimeslots: (_date, { signal }) => { state.slotReads++; state.signal = signal; return read.promise; },
    validateGamePublicationFields: () => true, splitPaymentAvailable: true,
    setLoadingPay: value => { context.loadingPay = value; }, setPayError: value => { state.error = value; },
    setGameRecordError: () => {}, setGamePreparationStage: value => { context.gamePreparationStage = value; },
    gamePreparationRef: { current: null }, splitSubscriptionSubmitInFlightRef: { current: false },
    gameCreationRef: { current: null }, gameCreationPending: false,
    setGameCreationPending: value => { context.gameCreationPending = value; },
    hasPendingPadelSplitCreate: () => false,
    readAuthToken: () => 'synthetic-session',
    formatDateLocalIso: () => '2030-01-01', addMinutesToTime: () => '21:00', generatePaymentRef: () => 'ref',
    buildBaseRedirectUrl: () => 'synthetic-url', PAYMENT_REF_QUERY_KEY: 'ref', activeSplitPaymentPromoConfig: { enabled: false },
    paymentAmount: 8000, splitShareCount: 4, DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG: { baseShareAmount: 2000 },
    resolveSplitBaseShareAmount: () => 2000, splitHasEligibleSubscriptions: true,
    SPLIT_OPEN_GAME_DIRECTION_ID: 4588, SPLIT_OPEN_GAME_EXERCISE_TYPE_ID: 1613,
    apiCreatePadelSplitGamePayment: async () => { state.writes++; return { error: { message: 'test stop' } }; },
    apiPayMasterService: async () => { state.writes++; return { error: { message: 'test stop' } }; },
    resolveSubscriptionCategoryDailyLimitErrorMessage: () => null,
    isRecordObject: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    resolveSubscriptionDecisionPresentation: () => ({}), formatSubscriptionDecisionPresentation: () => 'test stop',
    canProceedToPayment: true, loadingPay: false, gamePreparationStage: null,
    subscriptionUsageShadow: { busy: false }, publicCreateNeedsSplitSubscriptionSelection: false,
    splitPaymentSelected: true, splitCheckoutMode: 'subscription', splitHasSubscriptionPaymentOptions: true,
    publicCreateSurchargeMinor: null, selectedSplitSubscriptionId: 'subscription', formatPrice: String,
    participants: [], waitlistPlayers: [], profileName: 'Synthetic player', profileGrade: null, profileRatingNumeric: null,
    profilePhoto: null, SPLIT_PAYMENT_DEADLINE_MINUTES: 25, normalizePhoneForGame: value => value,
    buildGameAllRelatedPhones: () => [], moscowBookingEndIso: () => '2030-01-01T21:00:00+03:00',
    effectiveRatingGame: false, isPrivate: false, gameTitleDraft: 'Synthetic game', gameParticipantCommentDraft: 'Synthetic comment',
    gameJoinPriceDraft: '', publicCreatePreciseRatingMetadata: {}, buildCommunityAutopublishMetadata: () => ({}),
    buildCommunityAutopublishMetadataFields: () => ({}), buildGameOptionalMetadataFields: value => value,
    completePadelSplitCreate: id => state.completed.push(id),
    apiCreatePadelGameRecord: async payload => { state.cardPayloads.push(payload); return { data: { id: 'pay_original', status: 'PAID' } }; },
    buildInviteFallbackUrl: () => '/synthetic-invite', resolveGameInviteUrl: () => '/synthetic-invite',
    upsertGameRecordInStores: () => {}, runPaidGameCommunityMembershipAndPublication: async () => {},
    setGameRecordId: () => {}, setGameRecordStatus: () => {}, setInviteLink: () => {}, setGamePaymentUrl: () => {},
    setGamePaid: () => {}, setGameSnapshot: () => {}, setConfirmCancelUnpaidGame: () => {},
    mergeMatchSnapshots: () => ({}), buildMatchSnapshotFromPayload: () => ({}), buildMatchSnapshotFromRecord: () => ({}),
    pushCabinetFlashNotice: () => {}, setStep: value => { state.step = value; },
  };
  vm.createContext(context);
  for (const name of ['resolveCurrentClientProfile', 'revalidateSelectedSlotForPayment', 'prepareGamePayment',
    'handleSplitGamePay', 'submitSplitGamePayment', 'handleMasterServicePay']) {
    const callback = declarations.get(name).initializer.arguments[0].getText(file);
    vm.runInContext(emit(`globalThis.${name} = ${callback}`), context);
  }
  function visual() {
    for (const name of ['publicCreateSubscriptionSubmitTitle', 'publicCreateFinalSubmitTitle']) {
      vm.runInContext(emit(`globalThis.${name} = ${declarations.get(name).initializer.getText(file)}`), context);
    }
    const attribute = name => button.attributes.properties.find(node => node.name?.getText(file) === name).initializer.expression.getText(file);
    return { label: context.publicCreateFinalSubmitTitle, disabled: vm.runInContext(attribute('disabled'), context),
      busy: vm.runInContext(attribute('aria-busy'), context) };
  }
  return { read, state, context, visual, submit: () => context.submitSplitGamePayment('subscription', 'subscription') };
}

for (const stage of ['profile', 'slot']) {
  test(`pending ${stage}: visible busy state, deadline unlocks, late read cannot create or overwrite state`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(stage);
    const first = h.submit();
    await flush();
    assert.match(h.visual().label, stage === 'profile' ? /Проверяем профиль/ : /Проверяем доступность корта/);
    assert.equal(h.visual().disabled, true);
    assert.equal(h.visual().busy, true);
    await h.submit();
    assert.equal(h.state.profileReads + h.state.slotReads, 1);
    t.mock.timers.tick(20_000);
    await first;
    assert.match(h.state.error, /Проверка данных заняла слишком много времени/);
    assert.doesNotMatch(h.state.error, /Игра не создана/);
    assert.equal(h.visual().disabled, false);
    assert.equal(h.visual().busy, false);
    assert.equal(h.state.signal.aborted, true);
    assert.equal(h.state.writes, 0);
    assert.equal(h.context.splitSubscriptionSubmitInFlightRef.current, false);
    h.read.resolve(stage === 'profile' ? { data: { id: 'late-client', phone: 'synthetic-phone' } } : { data: [] });
    await flush();
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.profileUpdates, 0);
    assert.equal(h.state.slotUpdates, 0);
    assert.match(h.state.error, /Проверка данных заняла слишком много времени/);
  });
}

test('a fresh submission succeeds while the timed-out read later resolves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness('slot');
  const first = h.submit();
  await flush();
  t.mock.timers.tick(20_000);
  await first;
  h.context.apiFetchMasterServiceTimeslots = async () => ({ data: [] });
  await h.submit();
  assert.equal(h.state.writes, 1);
  h.read.resolve({ data: [] });
  await flush();
  assert.equal(h.state.writes, 1);
});

test('closing or changing the selection cancels preparation without a late write', async () => {
  const h = harness('slot');
  const pending = h.submit();
  await flush();
  h.context.gamePreparationRef.current.abort(); // production effect cleanup
  await pending;
  assert.equal(h.state.signal.aborted, true);
  assert.equal(h.visual().busy, false);
  h.read.resolve({ data: [] });
  await flush();
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.slotUpdates, 0);
});

test('full-court payment also stops before a write on preparation timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness('profile');
  const pending = h.context.handleMasterServicePay();
  await flush();
  t.mock.timers.tick(20_000);
  await pending;
  h.read.resolve({ data: { id: 'late-client', phone: 'synthetic-phone' } });
  await flush();
  assert.equal(h.state.writes, 0);
  assert.equal(h.visual().busy, false);
});

test('a normal submission reaches CREATE once after successful revalidation', async () => {
  const h = harness('slot');
  const pending = h.submit();
  await flush();
  h.read.resolve({ data: [] });
  await pending;
  assert.equal(h.state.writes, 1);
  assert.equal(h.visual().busy, false);
});

test('pending CREATE stays busy; unresolved recovery shows a neutral check action without another CREATE', async () => {
  const h = harness('slot');
  const create = deferred();
  h.context.apiCreatePadelSplitGamePayment = () => { h.state.writes++; return create.promise; };
  const pending = h.submit();
  await flush();
  h.read.resolve({ data: [] });
  await flush();
  assert.equal(h.state.writes, 1);
  assert.equal(h.visual().label, 'Создаём игру…');
  assert.equal(h.visual().busy, true);
  assert.equal(h.visual().disabled, true);
  await h.submit();
  assert.equal(h.state.writes, 1);
  create.resolve({ data: null, status: 202, error: { status: 202, raw: { state: 'PENDING_CONFIRMATION' } } });
  await pending;
  assert.equal(h.visual().busy, false);
  assert.equal(h.state.writes, 1);
  assert.equal(h.state.error, null);
  assert.equal(h.context.gameCreationPending, true);
  assert.equal(h.visual().label, 'Проверить создание игры');
});

test('late confirmed result completes one LK card with original paymentRef and draft metadata', async () => {
  const h = harness('slot');
  h.context.apiCreatePadelSplitGamePayment = async (_params, options) => {
    h.state.writes++; options.onRecovery();
    assert.equal(h.context.gamePreparationStage, 'confirmation');
    return { data: { paymentRef: 'original-ref', operationId: 'original-operation', exerciseId: 'exercise', bookingId: 'booking',
      toPay: 0, shareAmount: 750, shareAmountMinor: 75000 } };
  };
  const pending = h.submit(); await flush(); h.read.resolve({ data: [] }); await pending;
  assert.equal(h.state.writes, 1);
  assert.equal(h.state.cardPayloads.length, 1);
  assert.equal(h.state.cardPayloads[0].paymentRef, 'original-ref');
  assert.equal(h.state.cardPayloads[0].metadata.gameTitle, 'Synthetic game');
  assert.equal(h.state.cardPayloads[0].metadata.participantComment, 'Synthetic comment');
  assert.equal(h.state.cardPayloads[0].metadata.splitPayment.shareAmount, 750);
  assert.deepEqual(h.state.completed, ['original-operation']);
  assert.equal(h.state.step, 'details');
  assert.equal(h.state.error, null);
});

test('auth change during LK card persistence prevents publication, completion and navigation', async () => {
  const h = harness('slot'); const card = deferred();
  let upserts = 0;
  h.context.apiCreatePadelSplitGamePayment = async () => ({ data: {
    paymentRef: 'original-ref', operationId: 'original-operation', exerciseId: 'exercise', bookingId: 'booking', toPay: 0 } });
  h.context.apiCreatePadelGameRecord = () => card.promise;
  h.context.upsertGameRecordInStores = () => upserts++;
  const pending = h.submit(); await flush(); h.read.resolve({ data: [] }); await flush();
  h.context.readAuthToken = () => 'new-session';
  card.resolve({ data: { id: 'pay_original' } }); await pending;
  assert.equal(upserts, 0); assert.equal(h.state.completed.length, 0); assert.equal(h.state.step, null);
});

test('unmount or changed selection discards a late confirmation before LK publication', async () => {
  const h = harness('slot'); const create = deferred();
  h.context.apiCreatePadelSplitGamePayment = () => create.promise;
  const pending = h.submit(); await flush(); h.read.resolve({ data: [] }); await flush();
  h.context.gameCreationRef.current.abort(); h.context.gameCreationRef.current = null;
  create.resolve({ data: { paymentRef: 'original-ref', exerciseId: 'exercise', bookingId: 'booking', toPay: 0 } });
  await pending;
  assert.equal(h.state.cardPayloads.length, 0);
  assert.equal(h.state.completed.length, 0);
});

test('checking an existing pending attempt skips fresh-slot admission and remains in recovery', async () => {
  const h = harness('slot');
  h.context.hasPendingPadelSplitCreate = () => true;
  h.context.apiCreatePadelSplitGamePayment = async () => ({ data: null, status: 202,
    error: { status: 202, raw: { state: 'PENDING_CONFIRMATION' } } });
  await h.submit();
  assert.equal(h.state.slotReads, 0);
  assert.equal(h.state.cardPayloads.length, 0);
  assert.equal(h.context.gameCreationPending, true);
});

const apiSource = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
const apiFile = ts.createSourceFile('apiClient.ts', apiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function apiFunction(name, context) {
  const declaration = apiFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const text = declaration.getText(apiFile).replace(/^export /, '');
  vm.runInContext(emit(`${text};globalThis.extracted = ${name}`), context);
  return context.extracted;
}

test('cancelled bootstrap stops nested reads and never marks its cache complete', async () => {
  const owner = new AbortController();
  const firstRead = deferred();
  const calls = [];
  const completeCache = new Set();
  const context = vm.createContext({
    API_BASE: 'https://example.invalid', TENANT_KEY: 'synthetic',
    masterServiceBootstrapCache: completeCache,
    request: (_url, options) => { calls.push(options.signal); return firstRead.promise; },
  });
  const bootstrap = apiFunction('bootstrapMasterService', context);
  const pending = bootstrap('master', 'studio', owner.signal);
  assert.equal(calls[0], owner.signal);
  owner.abort();
  firstRead.resolve({ data: [] });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls.length, 1);
  assert.equal(completeCache.size, 0);
});

test('cancelled master-service discovery does not start a fallback read', async () => {
  const owner = new AbortController();
  const firstRead = deferred();
  const calls = [];
  const cache = new Map();
  const context = vm.createContext({
    API_BASE: 'https://example.invalid', TENANT_KEY: 'synthetic', masterServiceByStudioCache: cache,
    request: (_url, options) => { calls.push(options.signal); return firstRead.promise; },
  });
  const discover = apiFunction('resolveMasterServiceIdByStudio', context);
  const pending = discover('studio', owner.signal);
  owner.abort();
  firstRead.resolve({ error: { status: null } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls[0], owner.signal);
  assert.equal(calls.length, 1);
  assert.equal(cache.size, 0);
});

test('timeslot lookup passes the same signal through discovery, bootstrap and the final read', async () => {
  const owner = new AbortController();
  const read = deferred();
  const signals = [];
  const context = vm.createContext({
    API_BASE: 'https://example.invalid', TENANT_KEY: 'synthetic', ENABLE_MASTER_SERVICE_AUTO_DISCOVERY: true,
    resolveMasterServiceIdByStudio: async (_studio, signal) => { signals.push(signal); return 'master'; },
    bootstrapMasterService: async (_master, _studio, signal) => { signals.push(signal); },
    uniqueIds: ids => ids, isUuidLike: () => true,
    masterServiceStudioPreferredSubServiceCache: new Map(), masterServiceStudioPreferredRoomIdsCache: new Map(),
    request: (_url, options) => { signals.push(options.signal); return read.promise; },
  });
  const lookup = apiFunction('apiFetchMasterServiceTimeslots', context);
  const pending = lookup('2030-01-01', { studioId: 'studio', signal: owner.signal });
  await flush();
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal === owner.signal));
  owner.abort();
  read.resolve({ data: [] });
  await assert.rejects(pending, { name: 'AbortError' });
});
