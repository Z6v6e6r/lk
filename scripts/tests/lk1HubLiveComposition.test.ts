/* eslint-disable @typescript-eslint/no-explicit-any */
import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { composeHubFlow, composeHubReleaseArtifacts, HUB_IDS, assertHubOutputPath } from "../patch_live_lk1_hub.mjs";
import { hasDeterministicSubscriptionDecision } from "../../src/utils/subscriptionDecisionContract.ts";
import { validateReviewedFlowContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
const fixturePath = process.env.LK1_HUB_LIVE_FIXTURE;
const original = fixturePath ? JSON.parse(fs.readFileSync(fixturePath, "utf8")) : null;
const fixtureRule = { productId: "db7a5250-7369-4f43-8ac5-9111be24bc74", maxActiveBookings: 4,
  freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const fixturePolicy = { expectedPrior: null, desired: fixtureRule };
const composed = original ? composeHubFlow(original, fixturePolicy) : null;
const test = (name: string, fn: () => void) => nodeTest(name, { skip: !composed }, fn);
nodeTest("HUB artifact output rejects current and primary worktrees before creating files", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
  const primary = path.dirname(path.resolve(repo, common));
  for (const parent of new Set([repo, primary])) {
    const target = path.join(parent, "fixture-hub-output-must-not-exist");
    assert.equal(fs.existsSync(target), false);
    assert.throws(() => assertHubOutputPath(target), /outside every Git/);
    assert.equal(fs.existsSync(target), false);
  }
});
test("HUB graph composition is reproducible and rejects body dependency or route drift", () => {
  assert.equal(JSON.stringify(composeHubFlow(original, fixturePolicy)), JSON.stringify(composed));
  const changed = composed.filter((node: any, index: number) =>
    JSON.stringify(node) !== JSON.stringify(original[index]));
  assert.equal(changed.length, 4);
  for (const node of changed) {
    const before = original.find((n: any) => n.id === node.id);
    assert.deepEqual({ ...node, func: before.func,
      ...(node.id === HUB_IDS.gateway ? { initialize: before.initialize } : {}) }, before);
  }
  for (const mutate of [
    (f: any[]) => { f.push(structuredClone(f[0])); },
    (f: any[]) => { f.find(n => n.id === HUB_IDS.split).func += "\n// drift"; },
    (f: any[]) => { f.find(n => n.id === HUB_IDS.gateway).outputs = 8; },
    (f: any[]) => { f.find(n => n.id === "lk_subscription_booking_update_20260804").collection = "foreign"; },
    (f: any[]) => { f.push({ id: "fixture-foreign-writer", type: "function", wires: [[HUB_IDS.gateway]] }); },
  ]) {
    const flow = structuredClone(original); mutate(flow);
    assert.throws(() => composeHubFlow(flow), /duplicate|drift/i);
  }
  const foreign = structuredClone(original);
  foreign.push({ id: "fixture-independent-node", type: "comment", name: "preserve" });
  assert.deepEqual(composeHubFlow(foreign).at(-1), foreign.at(-1));
});
test("HUB exact graph packet includes a source-bound safe OFF that retains pure replay", () => {
  const packet = composeHubReleaseArtifacts(Buffer.from(JSON.stringify(original)), fixturePolicy, "fixture-hub-policy");
  assert.equal(packet.contract.contractKind, "exact-graph");
  assert.equal(packet.installOffContract.allowedChanges.length, 4);
  assert.equal(packet.contract.allowedChanges.length, 1);
  assert.equal(packet.contract.sourceSha256, packet.installOffContract.candidateSha256);
  assert.equal(packet.safeOffContract.candidateSha256, packet.installOffContract.candidateSha256);
  assert.throws(() => validateReviewedFlowContract({ liveBytes: Buffer.from(JSON.stringify(original)),
    candidateBytes: packet.candidateBytes, contract: packet.contract }), /Live flow digest/);
  assert.deepEqual(packet.contract.allowedChanges.find((c: any) => c.id === HUB_IDS.gateway).fields, ['func', 'initialize']);
  assert.equal(packet.safeOffContract.allowedChanges.length, 1);
  const offGateway = JSON.parse(packet.safeOffBytes.toString()).find((n: any) => n.id === HUB_IDS.gateway);
  const offPacket = composeHubReleaseArtifacts(Buffer.from(JSON.stringify(original)), { expectedPrior: fixtureRule, desired: null }, 'fixture-hub-off');
  assert.equal(offPacket.safeOffContract, null);
  assert.ok(offPacket.candidateBytes.equals(offPacket.safeOffBytes));
  let globalValue;
  const store = { get: () => globalValue, set: (_key: string, value: any) => { globalValue = value; } };
  new Function('global', offGateway.initialize)(store);
  assert.equal(globalValue, undefined, 'absent memory state already proves OFF');
  new Function('global', packet.candidate.find((n: any) => n.id === HUB_IDS.gateway).initialize)(store);
  assert.deepEqual(globalValue, fixtureRule);
  new Function('global', offGateway.initialize)(store); // exact predecessor restored after enable failure
  assert.equal(globalValue, null);
  const run = (msg: any, value: any) => new Function('msg', 'global', 'node', 'env', offGateway.func)(
    msg, { get: () => value }, { warn() {}, error() {} }, { get() {} });
  const fixture = lk1DirectFixture(60);
  const input = structuredClone(fixture.start()[1]);
  input._subscriptionBooking.step = "exercise";
  input.payload = fixture.exercise;
  input.statusCode = 200;
  for (const policy of [undefined, fixtureRule]) {
    const out = run(structuredClone(input), policy);
    assert.ok(out.every((value: any, index: number) => index === 4 || value === null));
    assert.equal(out[4].payload.state, "PENDING_CONFIRMATION");
    assert.match(out[4].payload.details.code, /RULE_OFF|SOURCE_MISMATCH/);
  }
  const { record } = lk1ThroughBooking(60);
  const request = { _subscriptionBooking: baseContext("profile", { action: "book", managedAction: "JOIN_GAME" }),
    statusCode: 200, payload: createProfile };
  let out = run(request, fixtureRule); // even stale persisted ON cannot defeat source OFF
  assert.ok(out[1]);
  out = run({ ...out[1], payload: [record] }, fixtureRule);
  assertPureFinal(out, "CONFIRMED");
});
const ROUTER_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js";

const FINALIZE_FILE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js";

const SPLIT_ROUTER_FILE = "scripts/nodered_games_nodes/fn_split_router.js";

const PITER_PRODUCT_ID = "8bf334ba-3050-4017-b40a-7eef2db1eb16";

const HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";

const MANAGED_PURCHASE_DATE = "2026-09-01T00:00:00+03:00";

const mongoUpdateResult = (matchedCount = 1) => ({
  acknowledged: true, matchedCount, modifiedCount: matchedCount, upsertedCount: 0, upsertedId: null,
});

const PITER_STATION_ID = "1ea77cbf-bc36-49a1-96d6-f35c216a409b";

const managedEnforcement = (
  enabled: boolean,
  productId: string | null = PITER_PRODUCT_ID,
  purchaseDate: string | null = enabled ? MANAGED_PURCHASE_DATE.slice(0, 10) : null,
) => ({
  source: "SERVER_GLOBAL_ALLOWLIST_AND_VIVA_PURCHASE_DATE",
  configuredProductIds: enabled ? [PITER_PRODUCT_ID] : [],
  exactProductId: productId,
  productIdentity: productId,
  purchaseDate,
  purchaseDateCandidates: purchaseDate ? [purchaseDate] : [],
  purchaseDateEvidenceValid: Boolean(purchaseDate),
  purchaseDateCutoff: "2026-09-01",
  purchaseDateTimeZone: "Europe/Moscow",
  purchaseDateEligible: Boolean(purchaseDate && purchaseDate >= "2026-09-01"),
  environment: enabled ? "PROD" : null,
  enabled,
  planKey: enabled ? "piter_friendship" : null,
});

const futureManagedTarget = () => {
  const futureDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
  const serviceDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(futureDate);
  return {
    serviceDate,
    startsAt: `${serviceDate}T09:00:00.000Z`,
  };
};

function baseContext(step: string, overrides: Record<string, unknown> = {}) {
  const context: Record<string, any> = {
    caller: "http",
    step,
    tenantKey: "iSkq6G",
    operationId: "idem-operation-1",
    authHeader: "Bearer user-token",
    exerciseId: "exercise-target",
    clientSubscriptionId: "client-subscription-1",
    actorClientId: "client-1",
    actorPhone: ("7" + "999" + "0000001"),
    serviceDate: "2026-08-10",
    category: "tournament",
    planKey: "sport",
    trackedDailyLimit: true,
    limitMode: "shared_day",
    operationKey: "iSkq6G:client-subscription-1:2026-08-10",
    studioId: "studio-1",
    ...overrides,
  };
  if (!("managedEnforcement" in overrides)) {
    context.managedEnforcement = context.planKey === "piter_friendship"
      ? managedEnforcement(true)
      : managedEnforcement(false, "82caad6f-4d19-4d01-852b-932bdbb0f405");
  }
  return context;
}

function flatBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-existing",
    paymentType: "SUBSCRIPTION",
    clientSubscriptionId: "client-subscription-1",
    exerciseId: "exercise-existing",
    exerciseDate: "2026-08-10",
    exerciseDirection: { id: 4588, name: "Открытая игра" },
    exerciseType: { id: 1613, name: "Открытая игра" },
    timeFrom: "10:00:00",
    timeTo: "11:00:00",
    ...overrides,
  };
}

function trustedExercise({
  directionId = 2617,
  planName = "Лето.Падел.Спорт",
  productId = "82caad6f-4d19-4d01-852b-932bdbb0f405",
  studioId = "studio-1",
  typeId = 839,
} = {}) {
  return {
    id: "exercise-target",
    timeFrom: "2026-08-10T10:00:00+03:00",
    timeTo: "2026-08-10T11:00:00+03:00",
    direction: { id: directionId, name: directionId === 4588 ? "Открытая игра" : "Турнир" },
    type: { id: typeId, name: typeId === 1613 ? "Открытая игра" : "Турнир" },
    studio: { id: studioId },
    availableClientSubscriptions: [{
      clientSubscriptionId: "client-subscription-1",
      productId,
      name: planName,
    }],
  };
}

function managedExercise(
  productId = PITER_PRODUCT_ID,
  name = "Падел.Дружба.Питер — 12 месяцев",
  purchaseDate: string | null = MANAGED_PURCHASE_DATE,
) {
  const exercise = trustedExercise({
    directionId: 4588,
    planName: name,
    productId,
    studioId: PITER_STATION_ID,
    typeId: 1613,
  });
  return {
    ...exercise,
    availableClientSubscriptions: exercise.availableClientSubscriptions.map((subscription) => ({
      ...subscription,
      ...(purchaseDate ? { purchaseDate } : {}),
    })),
    timeFrom: "2026-08-21T18:00:00+03:00",
    timeTo: "2026-08-21T19:00:00+03:00",
  };
}
function functionSource(file: string) {
  const key = file.includes("fn_split_router") ? "split" : file.includes("finalize") ? "finalize"
    : file.includes("evaluate") ? "evaluator" : "gateway";
  return composed.find((node: any) => node.id === HUB_IDS[key]).func;
}
function runFunction(file: string, msg: any, values: any = {}) {
  return new Function("msg", "global", "node", "env", functionSource(file))(msg,
    { get: (key: string) => values[key] }, { warn() {}, error() {} }, { get() {} });
}
function runOriginal(key: string, message: any, values: any = {}) {
  return new Function("msg", "global", "node", "env", original.find((n: any) => n.id === HUB_IDS[key]).func)(
    structuredClone(message), { get: (name: string) => values[name] },
    { warn() {}, error() {} }, { get() {} });
}
test("HUB leaves live non-HUB rounding and daily-limit decisions byte equivalent", () => {
  const input = { evaluatedAt: "2026-09-06T10:00:00Z", action: "JOIN_GAME",
    policy: { runtimeSchemaVersion: 1, status: "PUBLISHED", subscriptionTypeId: "fixture:type",
      policyVersion: 1, effectiveAt: "2026-08-01", timeZone: "Europe/Moscow",
      joinGame: { enabled: true, minDurationMinutes: 60, maxDurationMinutes: 120 },
      createGame: { enabled: true, durationsMinutes: [60] },
      dailyUsageLimit: 1, usageUnitsByDuration: { "60": 1 }, lifecycle: { allowBookingsAfterExpiry: false },
      stationAccessRules: [{ ruleId: "fixture:station", enabled: true, priority: 1,
        selector: { kind: "ALL_STATIONS", stationIds: [] }, surcharge: { kind: "NONE" } }],
      benefitRules: [{ ruleId: "fixture:discount", enabled: true, category: "GAME", actions: ["JOIN_GAME"],
        stationIds: ["fixture:station"], externalEventTypeIds: ["fixture:event"], durationMinutes: [60],
        priority: 1, kind: "PERCENT_DISCOUNT", percentage: 30 }], usage: {} },
    instance: { subscriptionInstanceId: "fixture:instance", subscriptionTypeId: "fixture:type", policyVersion: 1,
      activeFrom: "2026-08-01", activeTo: "2027-08-01", status: "ACTIVE" },
    target: { category: "GAME", resolutionSource: "SERVER", startsAt: "2026-09-21T10:00:00Z",
      durationMinutes: 60, stationId: "fixture:station", externalEventTypeId: "fixture:event", basePriceMinor: 105 },
    usage: { activeServices: 0, dailyUsed: 0, weeklyUsed: 0, monthlyUsed: 0, futureBookings: 0 } };
  for (const dailyUsed of [0, 1, 2]) {
    input.usage.dailyUsed = dailyUsed;
    const message = { _managedSubscriptionPolicyInput: structuredClone(input) };
    const expected = runOriginal("evaluator", message);
    const actual = runFunction("fn_managed_subscription_policy_evaluate.js", structuredClone(message));
    assert.deepEqual(actual, expected);
    const result = actual[0] || actual[1];
    assert.equal(result._managedSubscriptionPolicyDecision.benefit.discountMinor, 32, "live Math.round stays unchanged");
  }
});
test("HUB preserves live readonly write barriers and no-delete late-failure responses", () => {
  const { readonly } = createBeforeAttempt();
  for (const step of ["operation_find", "operation_insert", "operation_preaccept"]) {
    const message = { ...structuredClone(readonly), payload: [], _subscriptionBooking: {
      ...structuredClone(readonly._subscriptionBooking), step } };
    const out = runFunction(ROUTER_FILE, message, LK1_DIRECT_GLOBALS);
    assert.ok(out.slice(0, 4).every((value: any) => value === null));
  }
  for (const payload of [{ error: "fixture denial" }, { state: "PENDING_CONFIRMATION" }]) {
    const message = { statusCode: 409, payload, _subscriptionBooking: { caller: "split", exerciseId: "fixture-created" },
      _splitCtx: { action: "create", ownsExercise: true, exerciseId: "fixture-created" } };
    const actual = runFunction(FINALIZE_FILE, structuredClone(message));
    assert.deepEqual(actual, runOriginal("finalize", message));
    assert.equal(actual[0], null);
    assert.equal(actual[1].payload.details.destructiveRetryBlocked, true);
  }
});
const LK1_DIRECT_GLOBALS = { vivacrm_access_token: "fixture-service-token",
  subscriptions_lk1_product_policy: fixtureRule };

function createStart(extra: any = {}) {
  const { serviceDate } = futureManagedTarget();
  return runFunction(SPLIT_ROUTER_FILE, { statusCode: 200, payload: { price: 6000 },
    req: { headers: { authorization: "Bearer fixture-user", "idempotency-key": "fixture-create-1" } },
    _splitCtx: { action: "create", step: "ordinary_exact_price", paymentMode: "subscription",
      clientSubscriptionId: "client-subscription-1", token: "fixture-service-token",
      roomId: "fixture-room", studioId: PITER_STATION_ID, date: serviceDate,
      fromTime: "12:00", toTime: "13:30", durationMinutes: 90, maxClientsCount: 4,
      shareCount: 4, ...extra } }, LK1_DIRECT_GLOBALS);
}
function createOwned() {
  return [{ id: "client-subscription-1", product: { id: HUB_PRODUCT_ID },
    purchaseDate: MANAGED_PURCHASE_DATE, name: "Падел.Дружба.ХАБ", status: "ACTIVE",
    visitsLeft: 365, expirationDate: "2027-09-01", hasTypeLimitation: true,
    availableTypes: [{ id: 1613 }], hasStudioLimitation: false, hasDirectionLimitation: false }];
}
const createProfile = { id: "client-1", phone: ["7", "999", "0000001"].join("") };
function ingressLookup(request: any, globals: any = {}) {
  const out = runFunction(ROUTER_FILE, { ...structuredClone(request), statusCode: 200, payload: createProfile }, globals);
  assert.equal(out[1]?._subscriptionBooking.step, "lk1_ingress_operation_find");
  assert.ok(out.every((value: any, index: number) => index === 1 || value === null));
  const ctx = out[1]._subscriptionBooking;
  assert.deepEqual(out[1].payload, { _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}` });
  return out[1];
}
function assertPureFinal(out: any, state: string) {
  assert.ok(out.every((value: any, index: number) => index === 4 || value === null));
  assert.equal(out[4].payload.state, state);
  const final = runFunction(FINALIZE_FILE, out[4]);
  assert.equal(final[0], null, "replay must never enter CREATE or checkout serializer");
  assert.equal(final[1].payload.state, state);
  return final[1];
}
test("HUB readonly ingress has one exact read and ambiguous/error lookup cannot become empty with rule OFF", () => {
  const request = createStart()[3];
  const read = ingressLookup(request);
  for (const payload of [null, {}, [null], [undefined], [{}, {}]]) {
    const out = runFunction(ROUTER_FILE, { ...structuredClone(read), payload });
    assertPureFinal(out, "PENDING_CONFIRMATION");
  }
  assertPureFinal(runFunction(ROUTER_FILE, { ...structuredClone(read), payload: [], error: { message: "fixture failure" } }), "PENDING_CONFIRMATION");
  const empty = runFunction(ROUTER_FILE, { ...structuredClone(read), payload: [] });
  assert.equal(empty[0].method, "GET");
  assert.equal(empty[0]._subscriptionBooking.step, "prospective_subscriptions");
  assert.equal(empty[0]._subscriptionBooking.lk1IngressReplay, undefined);
  const failedAuth = runFunction(ROUTER_FILE, { ...request, statusCode: 401, payload: {} });
  assert.equal(failedAuth[1], null, "no DB lookup before authentication");
});
test("HUB fresh ingress ignores forged skip markers and cannot cross actor tenant or request identity", () => {
  const { record } = lk1ThroughBooking(60);
  const request = { _subscriptionBooking: baseContext("profile", { action: "book", managedAction: "JOIN_GAME",
    lk1IngressReplay: false, lk1LookupComplete: true }) };
  const read = ingressLookup(request);
  const before = structuredClone(record);
  const replay = assertPureFinal(runFunction(ROUTER_FILE, { ...structuredClone(read), payload: [record] }), "CONFIRMED");
  assert.equal(replay.payload.bookingId, record.bookingId);
  assert.deepEqual(record, before);
  for (const mutate of [
    (r: any) => { r.actorClientId = "fixture:other-actor"; },
    (r: any) => { r.tenantKey = "fixture-other-tenant"; },
    (r: any) => { r.operationId = "fixture-other-operation"; },
    (r: any) => { r.clientSubscriptionId = "fixture:other-subscription"; },
    (r: any) => { r.exerciseId = "fixture:other-event"; },
    (r: any) => { r.lk1.fingerprint = "fixture:forged"; },
    (r: any) => { r.state = "PENDING_CONFIRMATION"; },
    (r: any) => { r.state = "PREPARED"; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assertPureFinal(runFunction(ROUTER_FILE, { ...structuredClone(read), payload: [changed] }), "PENDING_CONFIRMATION");
  }
  const body = { exerciseId: "exercise-target", clientSubscriptionId: "client-subscription-1",
    lk1BeforeCreate: true, lk1CreateBinding: { operationKey: "forged" },
    _subscriptionBooking: { step: "lk1_profile_continue", actorClientId: "forged" } };
  const source = original.find((n: any) => n.id === "lk_subscription_booking_prepare_20260804").func;
  const prepared = new Function("msg", source)({ payload: body, req: { headers: {
    authorization: "Bearer fixture-user", "idempotency-key": "idem-operation-1" } } })[0];
  assert.equal(prepared._subscriptionBooking.step, "profile");
  assert.equal(prepared._subscriptionBooking.lk1CreateBinding, undefined);
  assert.equal(prepared._subscriptionBooking.actorClientId, undefined);
  ingressLookup(prepared);
});
function createBeforeAttempt(extra: any = {}) {
  let out = createStart(extra);
  assert.ok(out[3]);
  assert.equal(out[3]._subscriptionBooking.caller, "split_create_readonly_preflight");
  out = lk1Reply(out[3], createProfile);
  assert.equal(out[1]?._subscriptionBooking.step, "lk1_ingress_operation_find");
  out = lk1Reply(out[1], []);
  out = lk1Reply(out[0], createOwned());
  assert.equal(out[4]?.payload.state, "CREATE_PREFLIGHT_PASSED", JSON.stringify(out));
  assert.ok(out.slice(0, 4).every((value: any) => value === null), "readonly has zero DB/provider effects");
  const readonly = structuredClone(out[4]);
  out = runFunction(FINALIZE_FILE, out[4], LK1_DIRECT_GLOBALS);
  assert.ok(out[0]);
  out = runFunction(SPLIT_ROUTER_FILE, out[0], LK1_DIRECT_GLOBALS);
  assert.ok(out[3], "handoff goes to authenticated gateway, not CREATE");
  assert.equal(out[3].method, "GET");
  assert.equal(out[3]._subscriptionBooking.caller, "split");
  assert.equal(out[3]._subscriptionBooking.lk1BeforeCreate, true);
  const mutatingProfile = structuredClone(out[3]);
  out = lk1Reply(out[3], createProfile);
  out = lk1Reply(out[0], createOwned());
  assert.ok(out[1], JSON.stringify(out));
  return { readonly, mutatingProfile, find: out[1] };
}
function createPrepared() {
  const before = createBeforeAttempt();
  let out = lk1Reply(before.find, []);
  out = lk1Reply(out[0], []);
  out = lk1Reply(out[0], []);
  out = lk1Reply(out[1], []);
  out = runFunction("fn_managed_subscription_policy_evaluate.js", out[6], LK1_DIRECT_GLOBALS);
  assert.ok(out[0], JSON.stringify(out));
  out = runFunction(ROUTER_FILE, out[0], LK1_DIRECT_GLOBALS);
  const record = structuredClone(out[2].payload[0]);
  out = lk1Reply(out[2], { acknowledged: true, insertedId: record._id });
  assert.ok(out[3]);
  assert.equal(out[3]._subscriptionBooking.step, "lk1_create_attempt_saved");
  return { ...before, record, cas: out[3] };
}
function createBound() {
  const prepared = createPrepared();
  const out = lk1Reply(prepared.cas, lk1Apply(prepared.record, prepared.cas));
  const final = runFunction(FINALIZE_FILE, out[4], LK1_DIRECT_GLOBALS);
  assert.ok(final[0], JSON.stringify(final));
  return { ...prepared, final: final[0] };
}
test("HUB actual CREATE handoff journals before CREATE and separately before booking", () => {
  const { record, final } = createBound();
  const create = runFunction(SPLIT_ROUTER_FILE, structuredClone(final), LK1_DIRECT_GLOBALS)[0];
  assert.equal(create.method, "POST");
  assert.match(create.url, /\/api\/v1\/exercises$/);
  assert.deepEqual(create.payload, record.lk1.createPayload);
  assert.equal(record.state, "PENDING_CONFIRMATION");
  assert.ok(record.lk1.createAttemptedAt);
  assert.equal(record.lk1.bookingAttemptedAt, undefined);
  const event = { ...lk1DirectFixture(90).exercise, id: "fixture-created" };
  let out = runFunction(SPLIT_ROUTER_FILE, { ...create, statusCode: 201, payload: event }, LK1_DIRECT_GLOBALS);
  out = lk1Reply(out[3], createProfile);
  out = lk1Reply(out[0], event);
  out = lk1Reply(out[1], [record]);
  assert.equal(out[3]?._subscriptionBooking.step, "lk1_create_booking_bound", JSON.stringify(out));
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  out = lk1Reply(out[0], event);
  assert.equal(out[0].method, "POST");
  assert.match(out[0].url, /\/exercises\/fixture-created\/bookings$/);
  assert.equal(out[0].payload.count, 1);
  assert.ok(record.lk1.bookingAttemptedAt);
  const booking = flatBooking({ id: "fixture:created-booking", exerciseId: event.id,
    exerciseDate: record.serviceDate, clientId: "client-1", count: 1 });
  out = lk1Reply(out[0], booking, 201);
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  out = lk1Reply(out[0], [booking]);
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  assert.equal(record.state, "CONFIRMED");
  out = lk1Reply(out[0], [{ id: "fixture:service", productType: "SERVICE", cost: 1_000_000 }]);
  out = runFunction(FINALIZE_FILE, out[4], LK1_DIRECT_GLOBALS);
  out = runFunction(SPLIT_ROUTER_FILE, out[0], LK1_DIRECT_GLOBALS);
  out = lk1Reply(out[3], createProfile);
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  assert.equal(out[0].method, "POST");
  assert.match(out[0].url, /\/transactions$/);
  assert.deepEqual(out[0].payload.products[0].bookingIds, [booking.id]);
  assert.equal(out[0].payload.products[0].discount, 965_000);
  out = lk1Reply(out[0], { id: "fixture:create-transaction" }, 201);
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  out = lk1Reply(out[0], { id: "fixture:create-transaction", clientId: "client-1",
    bookingIds: [booking.id], toPayMinor: 35_000, currency: "RUB",
    paymentUrl: "https://checkout.invalid/fixture-only" });
  out = lk1Reply(out[3], lk1Apply(record, out[3]));
  out = runFunction(FINALIZE_FILE, out[4], LK1_DIRECT_GLOBALS);
  out = runFunction(SPLIT_ROUTER_FILE, out[0], LK1_DIRECT_GLOBALS);
  assert.equal(out[1].payload.exerciseId, event.id);
  assert.equal(out[1].payload.paid, false);
  assert.equal(out[1].payload.toPayMinor, 35_000);
  const before = structuredClone(record);
  const replay = lk1Reply(createBeforeAttempt().find, [record]);
  assert.equal(replay[4].payload.transactionId, "fixture:create-transaction");
  assert.ok(replay.slice(0, 4).every((value: any) => value === null));
  assert.deepEqual(record, before);
  const ingress = ingressLookup(createStart()[3]);
  assert.equal(assertPureFinal(runFunction(ROUTER_FILE, { ...structuredClone(ingress), payload: [record] }),
    "CONFIRMED").payload.transactionId, "fixture:create-transaction");
  for (const mutate of [
    (r: any) => { r.lk1.createPayload.maxClientsCount += 1; },
    (r: any) => { delete r.lk1.checkout; },
    (r: any) => { r.lk1.checkout.toPayMinor += 1; },
    (r: any) => { r.lk1.checkout.paymentUrl = "http://checkout.invalid"; },
    (r: any) => { r.lk1.checkout.paymentUrl = ["https://checkout.invalid/fixture-only"]; },
    (r: any) => { r.lk1.transactionIntent.bookingId = "fixture:other-booking"; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assertPureFinal(runFunction(ROUTER_FILE, { ...structuredClone(ingress), payload: [changed] }), "PENDING_CONFIRMATION");
  }
  const changedStudio = structuredClone(ingress);
  changedStudio._subscriptionBooking.prospectiveTarget.studioId = "fixture:other-studio";
  assertPureFinal(runFunction(ROUTER_FILE, { ...changedStudio, payload: [record] }), "PENDING_CONFIRMATION");
});
test("HUB CREATE failed or ambiguous durable ACK never dispatches exercise", () => {
  for (const ack of [mongoUpdateResult(0), { ...mongoUpdateResult(), modifiedCount: 0 },
    { result: mongoUpdateResult() }, { ...mongoUpdateResult(), acknowledged: false }]) {
    const { cas } = createPrepared();
    const failed = lk1Reply(cas, ack);
    assert.ok(failed.slice(0, 4).every((value: any) => value === null));
    assert.equal(runFunction(FINALIZE_FILE, failed[4], LK1_DIRECT_GLOBALS)[0], null);
  }
  const { cas } = createPrepared();
  const timeout = lk1Reply({ ...cas, error: { message: "fixture database timeout" } }, {});
  assert.equal(timeout[4].payload.state, "PENDING_CONFIRMATION");
  assert.ok(timeout.slice(0, 4).every((value: any) => value === null));
});
test("HUB internal CREATE cannot fall through to legacy after OFF or purchase-cohort drift", () => {
  const { final, mutatingProfile } = createBound();
  const create = runFunction(SPLIT_ROUTER_FILE, structuredClone(final), LK1_DIRECT_GLOBALS)[0];
  const event = { ...lk1DirectFixture(90).exercise, id: "fixture-created" };
  const postCreateProfile = runFunction(SPLIT_ROUTER_FILE, { ...create, statusCode: 201, payload: event }, LK1_DIRECT_GLOBALS)[3];
  for (const [profile, payload] of [[mutatingProfile, createOwned()], [postCreateProfile, event]]) {
    for (const off of [false, true]) {
      const globals = off ? {} : LK1_DIRECT_GLOBALS;
      const changed = structuredClone(payload);
      if (!off) {
        const owned = Array.isArray(changed) ? changed : changed.availableClientSubscriptions;
        for (const subscription of owned) subscription.purchaseDate = "2026-08-25";
      }
      let out = runFunction(ROUTER_FILE, { ...structuredClone(profile), statusCode: 200, payload: createProfile }, globals);
      assert.equal(out[0].method, "GET");
      out = runFunction(ROUTER_FILE, { ...out[0], statusCode: 200, payload: changed }, globals);
      assert.ok(out.every((value: any, index: number) => index === 4 || value === null));
      assert.equal(out[4].payload.state, "PENDING_CONFIRMATION");
    }
  }
});
test("HUB CREATE replay and frozen payload drift cannot repeat an uncertain effect", () => {
  const { record, final } = createBound();
  const create = runFunction(SPLIT_ROUTER_FILE, final, LK1_DIRECT_GLOBALS)[0];
  const uncertain = runFunction(SPLIT_ROUTER_FILE, { ...create, statusCode: 504, payload: {} }, LK1_DIRECT_GLOBALS);
  assert.equal(uncertain[0], null);
  assert.equal(uncertain[1].payload.state, "PENDING_CONFIRMATION");
  for (const extra of [{}, { maxClientsCount: 8 }, { roomId: "fixture-other-room" }]) {
    const replay = createBeforeAttempt(extra);
    const denied = lk1Reply(replay.find, [record]);
    assert.ok(denied.slice(0, 4).every((value: any) => value === null));
    assert.equal(denied[4].payload.state, "PENDING_CONFIRMATION");
  }
});
test("HUB CREATE forged incomplete or mismatched continuation cannot dispatch", () => {
  const { final } = createBound();
  for (const mutate of [
    (m: any) => { delete m._subscriptionBooking; },
    (m: any) => { m._splitCtx.maxClientsCount = 8; },
    (m: any) => { m._splitCtx.lk1CreateBinding.fingerprint = "forged"; },
    (m: any) => { m._subscriptionBooking.lk1CreateAck.actorClientId = "wrong-actor"; },
    (m: any) => { m._subscriptionBooking.lk1CreateAck.createAttemptedAt = ""; },
    (m: any) => { m._splitCtx.lk1CreateDispatchUsed = true; },
  ]) {
    const message = structuredClone(final); mutate(message);
    const rejected = runFunction(SPLIT_ROUTER_FILE, message, LK1_DIRECT_GLOBALS);
    assert.equal(rejected[0], null);
    assert.equal(rejected[1].payload.state, "PENDING_CONFIRMATION");
  }
});

function lk1DirectFixture(duration = 90) {
  const { startsAt } = futureManagedTarget();
  const exercise = { ...managedExercise(HUB_PRODUCT_ID, "Падел.Дружба.ХАБ — годовая"),
    roomId: "fixture-room", timeFrom: startsAt,
    timeTo: new Date(Date.parse(startsAt) + duration * 60_000).toISOString() };
  const context = baseContext("exercise", { caller: "split", managedAction: "JOIN_GAME",
    lk1TariffProof: { source: "VIVA_EXISTING_TARIFF", amountMinor: 100_000 * duration / 60,
      stationId: PITER_STATION_ID, roomId: "fixture-room", durationMinutes: duration,
      startsAt, observedAt: Date.now() } });
  return { exercise, start: () => runFunction(ROUTER_FILE, { statusCode: 200,
    payload: structuredClone(exercise), _subscriptionBooking: structuredClone(context),
    _splitCtx: { action: "join", token: "fixture-service-token", paymentRef: "fixture:payment-ref", gameId: "fixture:game" },
    req: { body: { purchasedAt: "2099-01-01", price: 1, productId: "browser:wrong" } },
  }, LK1_DIRECT_GLOBALS) };
}

const lk1Reply = (request: any, payload: any, statusCode = 200) => runFunction(ROUTER_FILE,
  { ...request, payload, statusCode }, LK1_DIRECT_GLOBALS);

function lk1Apply(record: any, request: any) {
  const [query, update, options] = request.payload;
  assert.deepEqual(options.writeConcern, { w: "majority", j: true });
  const at = (key: string) => key.split(".").reduce((value: any, part) => value?.[part], record);
  const matched = Object.entries(query).every(([key, expected]: [string, any]) =>
    expected && typeof expected === "object" && "$exists" in expected
      ? (at(key) !== undefined) === expected.$exists : at(key) === expected);
  if (!matched) return mongoUpdateResult(0);
  for (const [operator, fields] of Object.entries(update)) {
    for (const [key, value] of Object.entries(fields as Record<string, any>)) {
      const parts = key.split(".");
      const field = parts.pop()!;
      let target = record;
      for (const part of parts) target = target[part] ||= {};
      if (operator === "$set") target[field] = structuredClone(value);
      else if (operator === "$inc") target[field] = (target[field] || 0) + Number(value);
      else if (operator === "$unset") delete target[field];
      else assert.fail(`Unsupported fixture operator ${operator}`);
    }
  }
  return mongoUpdateResult();
}

function lk1ThroughBooking(duration = 90, used = 0) {
  const fixture = lk1DirectFixture(duration);
  let output = fixture.start();
  assert.ok(output[1], JSON.stringify(output));
  output = lk1Reply(output[1], []); // request record absent
  output = lk1Reply(output[0], []); // complete active bookings
  output = lk1Reply(output[0], []); // complete history
  const context = output[1]._subscriptionBooking;
  const prior = used ? [{ tenantKey: context.tenantKey, actorClientId: context.actorClientId,
    serviceDate: context.serviceDate, state: "CONFIRMED", bookingId: "fixture:prior-booking",
    lk1: { decision: { gameMinutes: { localDate: context.serviceDate, freeMinutes: used } } } }] : [];
  output = lk1Reply(output[1], prior);
  const evaluated = runFunction("scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js", output[6]);
  assert.ok(evaluated[0], JSON.stringify(evaluated[1]?._managedSubscriptionPolicyDecision));
  output = runFunction(ROUTER_FILE, evaluated[0], LK1_DIRECT_GLOBALS);
  const record = structuredClone(output[2].payload[0]);
  output = lk1Reply(output[2], { acknowledged: true, insertedId: record._id });
  output = lk1Reply(output[3], lk1Apply(record, output[3]));
  output = lk1Reply(output[0], fixture.exercise);
  const bookingPost = structuredClone(output[0]);
  assert.equal(bookingPost.method, "POST");
  assert.match(bookingPost.url, /\/exercises\/exercise-target\/bookings$/);
  const booking = flatBooking({ id: "fixture:confirmed-booking", exerciseId: "exercise-target",
    exerciseDate: record.serviceDate, clientId: "client-1", count: record.lk1.decision.subscriptionVisitCount,
    paymentType: record.lk1.decision.subscriptionVisitCount ? "SUBSCRIPTION" : "ON_PLACE",
    clientSubscriptionId: record.lk1.decision.subscriptionVisitCount ? "client-subscription-1" : undefined });
  output = lk1Reply(output[0], booking, 201);
  output = lk1Reply(output[3], lk1Apply(record, output[3]));
  output = lk1Reply(output[0], [booking]);
  output = lk1Reply(output[3], lk1Apply(record, output[3]));
  return { fixture, record, output, bookingPost };
}

test("LK1 product flow confirms one visit for free hour without a CUP call or money transaction", () => {
  const { fixture, record, output, bookingPost } = lk1ThroughBooking(60);
  assert.equal(bookingPost.payload.paymentType, "SUBSCRIPTION");
  assert.equal(bookingPost.payload.count, 1);
  assert.equal(output[4].payload.toPayMinor, 0);
  assert.equal(output[4].payload.subscriptionVisitCount, 1);
  assert.equal(record.lk1.decision.gameMinutes.freeMinutes, 60);
  const replay = lk1Reply(fixture.start()[1], [record]);
  assert.equal(replay[0], null);
  assert.equal(replay[2], null);
  assert.equal(replay[3], null);
  assert.equal(replay[4].payload.bookingId, "fixture:confirmed-booking");
});

test("LK1 mixed actual function chain consumes one visit then creates one SERVICE checkout for paid minutes", () => {
  for (const [used, duration, charge, visits] of [[0, 90, 35_000, 1], [30, 90, 70_000, 1], [60, 60, 70_000, 0]]) {
    const { fixture, record, output: afterBooking, bookingPost } = lk1ThroughBooking(duration, used);
    assert.equal(bookingPost.payload.paymentType, visits ? "SUBSCRIPTION" : "ON_PLACE");
    assert.equal(bookingPost.payload.count, visits ? 1 : undefined);
    assert.equal(record.lk1.decision.benefit.finalPriceMinor, charge);
    let output = lk1Reply(afterBooking[0], [{ id: "fixture:service", name: "Услуга 10000",
      productType: "SERVICE", type: "SERVICE", cost: 1_000_000 }]);
    const bridged = runFunction(FINALIZE_FILE, output[4]);
    const serialized = runFunction(SPLIT_ROUTER_FILE, bridged[0]);
    assert.ok(serialized[3], JSON.stringify(serialized));
    assert.equal(serialized[0], null, "serializer cannot dispatch before persisted CAS");
    output = lk1Reply(serialized[3], { id: "client-1", phone: ("7" + "999" + "0000001") });
    const attempt = structuredClone(output[3]);
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    assert.equal(output[0].method, "POST");
    assert.match(output[0].url, /\/transactions$/);
    assert.deepEqual(output[0].payload.products, [{ id: "fixture:service", count: 1,
      customAmount: null, type: "SERVICE", discount: 1_000_000 - charge,
      bookingIds: ["fixture:confirmed-booking"] }]);
    const duplicateAttempt = lk1Reply(attempt, lk1Apply(record, attempt));
    assert.equal(duplicateAttempt[0], null, "a repeated CAS cannot send another transaction");
    const timeout = lk1Reply(structuredClone(output[0]), {}, 503);
    assert.equal(timeout[4].payload.state, "PENDING_CONFIRMATION");
    const retryUnknown = lk1Reply(fixture.start()[1], [structuredClone(record)]);
    assert.equal(retryUnknown[0], null, "unknown transaction outcome cannot cause another POST");
    output = lk1Reply(output[0], { id: "fixture:transaction" }, 201);
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    assert.equal(output[0].method, "GET");
    output = lk1Reply(output[0], { id: "fixture:transaction", clientId: "client-1",
      bookingIds: ["fixture:confirmed-booking"], toPayMinor: charge, currency: "RUB",
      paymentUrl: "https://checkout.invalid/fixture-only" });
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    assert.equal(output[4].payload.toPayMinor, charge);
    assert.equal(output[4].payload.paid, false, "checkout creation does not prove payment");
    const final = runFunction(SPLIT_ROUTER_FILE, runFunction(FINALIZE_FILE, output[4])[0]);
    assert.equal(final[1].payload.subscriptionVisitCount, visits);
    assert.equal(final[1].payload.paymentUrl, "https://checkout.invalid/fixture-only");
    assert.equal(hasDeterministicSubscriptionDecision({ ...final[1].payload, raw: final[1].payload }, "subscription"), true,
      "existing game client must accept the deterministic money leg, not label it an unknown decision");
    const before = structuredClone(record);
    const replay = lk1Reply(fixture.start()[1], [record]);
    assert.equal(replay[0], null);
    assert.equal(replay[3], null);
    assert.equal(replay[4].payload.transactionId, "fixture:transaction");
    assert.deepEqual(record, before, "replay never consumes allowance again");
  }
});

test("LK1 replay never adopts an unrelated booking after rejection or an idless outcome", () => {
  const { fixture, record, bookingPost } = lk1ThroughBooking(90);
  for (const state of ["FAILED", "RELEASED", "UNKNOWN", "PENDING_CONFIRMATION"]) {
    const unresolved = { ...structuredClone(record), state, bookingId: null, upstreamBookingId: null };
    const replay = lk1Reply(fixture.start()[1], [unresolved]);
    assert.equal(replay[0], null);
    assert.equal(replay[3], null);
    assert.equal(replay[4].payload.state, "PENDING_CONFIRMATION");
  }
  const pending = { ...structuredClone(record), state: "PENDING_CONFIRMATION", bookingId: null };
  const read = lk1Reply(fixture.start()[1], [pending]);
  assert.equal(read[0]._subscriptionBooking.immediateBookingId, record.upstreamBookingId);
  const unrelated = flatBooking({ id: "fixture:other-request", exerciseId: "exercise-target",
    clientId: "client-1", paymentType: "SUBSCRIPTION", clientSubscriptionId: "client-subscription-1", count: 1 });
  for (const request of [read[0], { ...bookingPost, _subscriptionBooking: {
    ...bookingPost._subscriptionBooking, step: "confirmation_bookings", immediateBookingId: null,
  } }]) {
    const output = lk1Reply(request, [unrelated]);
    assert.equal(output[3], null, "unrelated booking cannot be persisted as this request's result");
    assert.equal(output[0], null, "unrelated booking cannot authorize another checkout");
    assert.equal(output[4].payload.state, "PENDING_CONFIRMATION");
  }
});

test("LK1 write permission requires a modified CAS and missing service token cannot dispatch", () => {
  const { bookingPost, output } = lk1ThroughBooking(90);
  for (const step of ["operation_preaccept", "lk1_payment_attempt_saved"]) {
    const rejected = lk1Reply({ ...bookingPost, _subscriptionBooking: {
      ...bookingPost._subscriptionBooking, step,
    } }, { ...mongoUpdateResult(), modifiedCount: 0 });
    assert.equal(rejected[0], null);
    assert.equal(rejected[4].payload.state, "PENDING_CONFIRMATION");
  }
  const missingToken = runFunction(ROUTER_FILE, { ...output[0], payload: mongoUpdateResult(),
    _subscriptionBooking: { ...output[0]._subscriptionBooking, step: "lk1_payment_attempt_saved" },
  }, { ...LK1_DIRECT_GLOBALS, vivacrm_access_token: undefined });
  assert.equal(missingToken[0], null);
  assert.equal(missingToken[4].payload.details.code, "LK1_SERVICE_TOKEN_UNAVAILABLE");
});

test("LK1 checkout rejects contradictory readback aliases and malformed products without throwing", () => {
  const { output } = lk1ThroughBooking(90);
  const context = { ...output[0]._subscriptionBooking, step: "lk1_transaction_readback" };
  context.lk1.transactionId = "fixture:transaction";
  context.lk1.transactionIntent = { productId: "fixture:service", chargeMinor: 35_000, discountMinor: 965_000 };
  const valid = { id: "fixture:transaction", clientId: "client-1",
    bookingIds: ["fixture:confirmed-booking"], toPayMinor: 35_000, currency: "RUB",
    paymentUrl: "https://checkout.invalid/fixture-only" };
  for (const delta of [
    { toPay: 70_000 }, { toPay: null }, { transactionId: "fixture:other" },
    { client: { id: "fixture:other" } }, { paymentLink: "https://checkout.invalid/other" },
    { products: {} }, { products: null }, { products: [null] },
    { products: [{ id: "fixture:service", type: "SERVICE", count: 1, discount: 965_000,
      bookingIds: ["fixture:other"] }] },
  ]) {
    const rejected = lk1Reply({ _subscriptionBooking: structuredClone(context) }, { ...valid, ...delta });
    assert.equal(rejected[3], null, "ambiguous evidence cannot be saved as a checkout");
    assert.equal(rejected[4].payload.state, "PENDING_CONFIRMATION");
  }
  const accepted = lk1Reply({ _subscriptionBooking: structuredClone(context) }, {
    ...valid, transactionId: valid.id, toPay: valid.toPayMinor, client: { id: valid.clientId },
  });
  assert.ok(accepted[3]);
});

test("LK1 carrier failure after visit confirmation stays pending without compensation or event", () => {
  const { output } = lk1ThroughBooking(90);
  for (const products of [[], [{ id: "fixture:wrong", type: "SERVICE", productType: "SERVICE", cost: 100 }]]) {
    const available = lk1Reply(structuredClone(output[0]), products);
    const bridged = runFunction(FINALIZE_FILE, available[4]);
    const rejected = runFunction(SPLIT_ROUTER_FILE, bridged[0]);
    assert.equal(rejected[0], null);
    assert.equal(rejected[2], null);
    assert.equal(rejected[1].statusCode, 202);
    assert.equal(rejected[1].payload.state, "PENDING_CONFIRMATION");
    assert.doesNotMatch(JSON.stringify(rejected[1].payload), /fixture:wrong/);
  }
});

test("HUB money carrier rejects missing contradictory coerced or rounded provider type and cost", () => {
  for (const carrier of [
    { id: "fixture:carrier", cost: 1_000_000 },
    { id: "fixture:carrier", cost: 1_000_000, productType: "UNKNOWN", type: "SUBSCRIPTION" },
    { id: "fixture:carrier", cost: 1_000_000, productType: "SERVICE", type: "SUBSCRIPTION" },
    { id: "fixture:carrier", cost: "1000000", productType: "SERVICE" },
    { id: "fixture:carrier", cost: 999_999.6, productType: "SERVICE" },
    { id: 1234, cost: 1_000_000, productType: "SERVICE" },
  ]) {
    const { output } = lk1ThroughBooking(90);
    const available = lk1Reply(output[0], [carrier]);
    const bridged = runFunction(FINALIZE_FILE, available[4]);
    const rejected = runFunction(SPLIT_ROUTER_FILE, bridged[0]);
    assert.equal(rejected[0], null);
    assert.equal(rejected[3], undefined);
    assert.equal(rejected[1].payload.state, "PENDING_CONFIRMATION");
  }
});

test("LK1 carrier cap rejects an unrepresentable charge before any operation or provider write", () => {
  const { fixture, record } = lk1ThroughBooking(90);
  const decision = structuredClone(record.lk1.decision);
  decision.benefit.finalPriceMinor = 1_000_001;
  for (const caller of ["split", "split_create_readonly_preflight"]) {
    const rejected = runFunction(ROUTER_FILE, {
      _subscriptionBooking: { ...fixture.start()[1]._subscriptionBooking, caller, step: "lk1_policy_decision" },
      _managedSubscriptionPolicyDecision: decision,
    }, LK1_DIRECT_GLOBALS);
    assert.equal(rejected[0], null);
    assert.equal(rejected[2], null);
    assert.equal(rejected[3], null);
    assert.equal(rejected[4].payload.state, "PENDING_CONFIRMATION");
  }
  const replay = lk1Reply(fixture.start()[1], [{ ...record, lk1: { ...record.lk1, decision } }]);
  assert.equal(replay[0], null);
  assert.equal(replay[3], null);
  assert.equal(replay[4].payload.state, "PENDING_CONFIRMATION");
});

test("LK1 subscription ingress without a tariff runs existing authenticated price reads before any booking", () => {
  const { serviceDate } = futureManagedTarget();
  for (const action of ["create", "join"]) {
    const fixture = lk1DirectFixture(90);
    const start = fixture.start()[1];
    const context = { ...start._subscriptionBooking, lk1TariffProof: null, step: "exercise",
      caller: action === "create" ? "split_create_readonly_preflight" : "split",
      managedAction: action === "create" ? "CREATE_GAME" : "JOIN_GAME" };
    const tariff = lk1Reply({ ...start, _subscriptionBooking: context, _splitCtx: {
      action, paymentMode: "subscription", clientSubscriptionId: "client-subscription-1",
      masterServiceId: "fixture:master", subServiceIds: ["fixture:service"],
      studioId: PITER_STATION_ID, roomId: "fixture-room", date: serviceDate,
      fromTime: "12:00", toTime: "13:30", durationMinutes: 90,
    } }, fixture.exercise);
    assert.equal(tariff[0], null);
    assert.equal(tariff[2], null);
    assert.equal(tariff[3], null);
    assert.equal(tariff[4]._subscriptionBooking.step, "lk1_tariff_required");
    const final = runFunction(FINALIZE_FILE, tariff[4]);
    let price = runFunction(SPLIT_ROUTER_FILE, final[0], LK1_DIRECT_GLOBALS);
    assert.equal(price[0].method, "GET");
    assert.match(price[0].url, /\/products\/master-services\/fixture%3Amaster\/studios/);
    assert.equal(price[0].headers.Authorization, context.authHeader);
    price = runFunction(SPLIT_ROUTER_FILE, { ...price[0], statusCode: 200, payload: [{ id: PITER_STATION_ID }] }, LK1_DIRECT_GLOBALS);
    assert.equal(price[0].method, "GET");
    assert.match(price[0].url, /\/subServices/);
    price = runFunction(SPLIT_ROUTER_FILE, { ...price[0], statusCode: 200, payload: [{ id: "fixture:service" }] }, LK1_DIRECT_GLOBALS);
    assert.equal(price[0].method, "GET");
    assert.match(price[0].url, /\/price\?/);
  }
});

function lk1MoneyEventFixture(typeId = 839, directionId = 2617) {
  const { startsAt, serviceDate } = futureManagedTarget();
  const exercise = { ...managedExercise(HUB_PRODUCT_ID), type: { id: typeId }, direction: { id: directionId },
    roomId: "fixture-room", timeFrom: startsAt, timeTo: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(),
    availableClientSubscriptions: [] };
  const subscription = { clientSubscriptionId: "client-subscription-1", productId: HUB_PRODUCT_ID,
    clientId: "client-1", status: "ACTIVE", purchaseDate: MANAGED_PURCHASE_DATE,
    activationDate: "2026-09-01T00:00:00.230651+03:00", expirationDate: "2027-09-01", holdUntil: null, visitsLeft: 0 };
  const tariff = [{ id: "fixture:event-price", productType: "SERVICE", exerciseId: "exercise-target", cost: 200_000 }];
  const start = () => runFunction(ROUTER_FILE, { statusCode: 200, payload: structuredClone(exercise),
    _subscriptionBooking: baseContext("exercise", { caller: "http", managedAction: null, category: null }) }, LK1_DIRECT_GLOBALS);
  return { exercise, subscription, tariff, serviceDate, start };
}

test("LK1 GT/T lifecycle accepts Viva microseconds without widening validity boundaries", () => {
  const source = functionSource(ROUTER_FILE);
  const calendar = source.slice(source.indexOf("const isValidDateKey ="), source.indexOf("const normalizePurchaseDateMoscow ="));
  const lifecycle = source.slice(source.indexOf("const lk1LifecycleInstant ="), source.indexOf("const lk1Quote ="));
  const parse = new Function(`${calendar}\n${lifecycle}\nreturn lk1LifecycleInstant;`)();
  const second = Date.parse("2026-09-07T09:00:00Z");
  for (const [fraction, floor, ceiling] of [
    ["1", 100, 100], ["12", 120, 120], ["123", 123, 123],
    ["1230", 123, 123], ["1234", 123, 124], ["12300", 123, 123], ["12345", 123, 124],
    ["123000", 123, 123], ["123001", 123, 124], ["123456", 123, 124], ["999999", 999, 1000],
  ] as const) {
    for (const [time, zone] of [["09:00:00", "Z"], ["12:00:00", "+03:00"],
      ["12:00:00", "+0300"], ["12:00:00", ""], ["05:00:00", "-04:00"]]) {
      const value = `2026-09-07T${time}.${fraction}${zone}`;
      assert.equal(parse(value), second + ceiling, `activation ceiling: ${value}`);
      assert.equal(parse(value, true), second + floor, `expiry floor: ${value}`);
    }
  }
  assert.equal(parse("2026-09-07"), Date.parse("2026-09-07T00:00:00+03:00"));
  assert.equal(parse("2026-09-07", true), Date.parse("2026-09-07T23:59:59.999+03:00"));
  assert.equal(parse("2026-09-07T09:00Z"), second);
  assert.equal(parse("2026-09-07 12:00:00.123456+03:00"), second + 124);
  for (const invalid of ["2026-09-07T09:00:00.1234567Z", "2026-09-07T09:00:00.1230000Z",
    "2026-02-30T09:00:00.123456Z", "2026-09-07T24:00:00.123456Z",
    "2026-09-07T09:60:00.123456Z", "2026-09-07T09:00:60.123456Z",
    "2026-09-07T09:00:00.123456+24:00", "2026-09-07T09:00:00.123456+03:60",
    "2026-09-07T09:00:00.Z", "2026-09-07T09:00:00.123456Zsuffix"]) {
    assert.equal(parse(invalid), null, invalid);
    assert.equal(parse(invalid, true), null, invalid);
  }
});

test("LK1 GT/T owned money discount works without exercise visit availability and never debits a visit", () => {
  for (const [typeId, directionId] of [[839, 2617], [605, 1234]]) {
    const f = lk1MoneyEventFixture(typeId, directionId);
    let output = f.start();
    assert.equal(output[0]._subscriptionBooking.step, "lk1_money_owned_subscriptions");
    assert.equal(output[0].method, "GET");
    output = lk1Reply(output[0], [f.subscription]);
    assert.equal(output[0]._subscriptionBooking.step, "lk1_event_tariff");
    output = lk1Reply(output[0], f.tariff);
    const operationFind = structuredClone(output[1]);
    output = lk1Reply(output[1], []);
    output = lk1Reply(output[0], []);
    output = lk1Reply(output[0], []);
    output = lk1Reply(output[1], []);
    const evaluated = runFunction("scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js", output[6]);
    output = runFunction(ROUTER_FILE, evaluated[0], LK1_DIRECT_GLOBALS);
    const record = structuredClone(output[2].payload[0]);
    assert.equal(record.lk1.decision.subscriptionVisitCount, 0);
    assert.equal(record.lk1.decision.benefit.finalPriceMinor, 100_000);
    assert.equal(record.lk1.decision.gameMinutes, undefined);
    output = lk1Reply(output[2], { acknowledged: true, insertedId: record._id });
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    output = lk1Reply(output[0], f.exercise);
    assert.equal(output[0]._subscriptionBooking.step, "lk1_money_owned_subscriptions", "fresh ownership before write");
    const ownershipRecheck = structuredClone(output[0]);
    const expired = lk1Reply(structuredClone(ownershipRecheck), [{ ...f.subscription, expirationDate: "2026-08-01" }]);
    assert.equal(expired[0], null);
    assert.equal(expired[3], null);
    output = lk1Reply(output[0], [f.subscription]);
    assert.equal(output[0]._subscriptionBooking.step, "lk1_event_tariff", "fresh price before write");
    const changedPrice = lk1Reply(structuredClone(output[0]), [{ ...f.tariff[0], cost: 220_000 }]);
    assert.equal(changedPrice[0], null);
    assert.equal(changedPrice[4].payload.state, "PENDING_CONFIRMATION");
    output = lk1Reply(output[0], f.tariff);
    assert.equal(output[0].method, "POST");
    assert.equal(output[0].payload.paymentType, "ON_PLACE");
    assert.equal(output[0].payload.clientSubscriptionId, undefined);
    assert.equal(output[0].payload.count, undefined);
    assert.deepEqual(f.exercise.availableClientSubscriptions, [], "never fake provider availability");
    const booking = flatBooking({ id: "fixture:money-booking", exerciseId: "exercise-target", clientId: "client-1",
      paymentType: "ON_PLACE", clientSubscriptionId: undefined });
    output = lk1Reply(output[0], booking, 201);
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    output = lk1Reply(output[0], [booking]);
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    output = lk1Reply(output[0], [{ id: "fixture:service", type: "SERVICE", productType: "SERVICE", cost: 1_000_000 }]);
    const serializer = runFunction(SPLIT_ROUTER_FILE, runFunction(FINALIZE_FILE, output[4])[0], LK1_DIRECT_GLOBALS);
    output = lk1Reply(serializer[3], { id: "client-1", phone: ("7" + "999" + "0000001") });
    output = lk1Reply(output[3], lk1Apply(record, output[3]));
    assert.deepEqual(output[0].payload.products, [{ id: "fixture:service", type: "SERVICE", count: 1,
      customAmount: null, discount: 900_000, bookingIds: [booking.id] }]);
    const retry = lk1Reply(operationFind, [record]);
    assert.equal(retry[0], null, "unknown money result cannot cause another transaction or visit");
  }
});

test("LK1 GT/T missing conflicting expired frozen or unknown ownership and tariff proof stops before writes", () => {
  const f = lk1MoneyEventFixture();
  for (const subscription of [null, { ...f.subscription, productId: "fixture:other" },
    { ...f.subscription, clientId: "fixture:other" }, { ...f.subscription, subscriptionId: "fixture:other" },
    { ...f.subscription, status: "NEW" }, { ...f.subscription, activationDate: null },
    { ...f.subscription, expirationDate: null }, { ...f.subscription, expirationDate: "2026-08-01" },
    { ...f.subscription, isFrozen: true }, { ...f.subscription, holdUntil: "2027-01-01" },
    { ...f.subscription, activationDate: new Date(Date.now() + 60_000).toISOString() },
    { ...f.subscription, expirationDate: new Date(Date.parse(f.exercise.timeFrom) - 60_000).toISOString() },
    { ...f.subscription, clientSubscriptionId: ["client-subscription-1"] },
    { ...f.subscription, clientId: ["client-1"] },
    { ...f.subscription, clientId: { toString: null } },
    { ...f.subscription, purchaseAt: "2026-08-01" }]) {
    const rejected = lk1Reply(f.start()[0], subscription ? [subscription] : []);
    assert.equal(rejected[0], null);
    assert.equal(rejected[2], null);
    assert.equal(rejected[3], null);
  }
  const priced = lk1Reply(f.start()[0], [f.subscription]);
  for (const prices of [[], [...f.tariff, ...f.tariff], [{ ...f.tariff[0], exerciseId: undefined }],
    [{ ...f.tariff[0], exerciseId: "fixture:other" }], [{ ...f.tariff[0], price: 300_000 }]]) {
    const rejected = lk1Reply(structuredClone(priced[0]), prices);
    assert.equal(rejected[0], null);
    assert.equal(rejected[2], null);
    assert.equal(rejected[3], null);
  }
});
