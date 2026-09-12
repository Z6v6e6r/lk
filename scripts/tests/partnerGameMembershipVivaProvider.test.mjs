import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTNER_VIVA_ADMIN_API_BASE,
  PARTNER_VIVA_CONTRACT_REVISION,
  PARTNER_VIVA_RESPONSE_MAX_BYTES,
  PARTNER_VIVA_TOKEN_URL,
  PARTNER_VIVA_TOKEN_RESPONSE_MAX_BYTES,
  createVivaServiceTokenResolver,
  VivaAdminTechnicalUserProvider,
} from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-viva.mjs";

const TOKEN = "header.payload.signature-value-for-tests";
const credentials = () => ({ clientId: "fixture-client", username: "fixture-user", password: "public-fixture-password" });
const grantResponse = (overrides = {}) => response(200, {
  access_token: TOKEN, token_type: "Bearer", expires_in: 300, ...overrides,
});
const tokenUnavailable = { code: "VIVA_SERVICE_TOKEN_UNAVAILABLE", httpStatus: 503, expose: false, ambiguous: false };
const OPERATION_ID = "550e8400-e29b-41d4-a716-446655440000";
const response = (status, payload) => new Response(
  payload === null ? null : JSON.stringify(payload),
  { status, headers: { "Content-Type": "application/json" } },
);

const readyProvider = (fetchImpl) => new VivaAdminTechnicalUserProvider({
  fetchImpl,
  tokenResolver: async () => TOKEN,
  mutationsEnabled: true,
  contractRevision: PARTNER_VIVA_CONTRACT_REVISION,
  idempotencyConfirmed: true,
  onPlacePaymentConfirmed: true,
  timeoutMs: 1_000,
});

const addInput = {
  operationId: OPERATION_ID,
  idempotencyKey: "partner-add-001",
  exerciseId: "exercise-1",
  technicalVivaClientId: "technical-client-1",
};

test("standalone token uses the pinned form grant without global context or credential normalization", async () => {
  const input = { ...credentials(), username: "fixture+user&=", password: " p&=+ 🎾 " };
  const calls = [];
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: () => input,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return grantResponse(); } });
  assert.equal(await resolve(), TOKEN);
  assert.equal(await resolve(), TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PARTNER_VIVA_TOKEN_URL);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].options.headers["Accept-Encoding"], "identity");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
    grant_type: "password", client_id: input.clientId, username: input.username, password: input.password,
  });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  resolve.close();
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(calls.length, 1);
});

test("standalone token refresh is single-flight and cache hits never extend its deadline", async () => {
  let now = 100;
  let finish;
  let calls = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials, monotonicNow: () => now,
    fetchImpl: () => { calls++; return new Promise(done => { finish = done; }); } });
  const pending = Array.from({ length: 20 }, () => resolve());
  assert.equal(calls, 1);
  now = 2_100;
  finish(grantResponse());
  assert.deepEqual(await Promise.all(pending), Array(20).fill(TOKEN));
  now = 270_099;
  assert.equal(await resolve(), TOKEN);
  assert.equal(calls, 1);
  now = 270_100;
  const renewed = resolve();
  assert.equal(calls, 2);
  finish(grantResponse({ access_token: "second.fixture.token-value" }));
  assert.equal(await renewed, "second.fixture.token-value");
  resolve.close();
});

test("standalone token rejects stale credentials during grant and invalidates cached credentials", async () => {
  let input = credentials();
  let finish;
  let calls = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: () => input,
    fetchImpl: () => { calls++; return new Promise(done => { finish = done; }); } });
  const old = resolve();
  input = { ...input, password: "public-rotated-fixture-password" };
  finish(grantResponse());
  await assert.rejects(old, tokenUnavailable);
  const fresh = resolve();
  finish(grantResponse({ access_token: "rotated.fixture.token-value" }));
  assert.equal(await fresh, "rotated.fixture.token-value");
  assert.equal(calls, 2);
  input = { ...input, password: "" };
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(calls, 2);
  resolve.close();
});

test("concurrent credential replacement aborts the old grant rather than returning its token", async () => {
  let input = credentials();
  let signal;
  let calls = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: () => input,
    fetchImpl: (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  const first = assert.rejects(resolve(), tokenUnavailable);
  input = { ...input, clientId: "other-fixture-client" };
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(signal.aborted, true);
  await first;
  assert.equal(calls, 1);
  resolve.close();
});

test("standalone token failure has bounded backoff then recovers without an old-token fallback", async () => {
  let now = 0;
  let calls = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials, monotonicNow: () => now,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) { now = 4_000; return response(401, { error_description: "PRIVATE_PROVIDER_ERROR" }); }
      return grantResponse();
    } });
  await assert.rejects(resolve(), tokenUnavailable);
  now = 4_999;
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(calls, 1);
  now = 5_000;
  assert.equal(await resolve(), TOKEN);
  assert.equal(calls, 2);
  resolve.close();
});

for (const ttl of [undefined, null, "300", 0, -1, 30, 30.5, 604_801, Number.MAX_SAFE_INTEGER]) {
  test(`standalone token rejects unsupported expires_in ${String(ttl)}`, async () => {
    const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials,
      fetchImpl: async () => grantResponse({ expires_in: ttl }) });
    await assert.rejects(resolve(), tokenUnavailable);
    resolve.close();
  });
}

test("standalone token accepts the production seven day lifetime", async () => {
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials,
    fetchImpl: async () => grantResponse({ expires_in: 604_800 }) });
  assert.equal(await resolve(), TOKEN);
  resolve.close();
});

test("standalone token TTL counts response latency and fails closed on clock reversal", async () => {
  let now = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials, monotonicNow: () => now,
    fetchImpl: async () => { now = 1_001; return grantResponse({ expires_in: 31 }); } });
  await assert.rejects(resolve(), tokenUnavailable);
  now = -1;
  await assert.rejects(resolve(), tokenUnavailable);
  resolve.close();
});

test("standalone token rejects missing credentials, extra fields and reader exceptions without fetching", async () => {
  let calls = 0;
  for (const value of [null, {}, { ...credentials(), password: "" }, { ...credentials(), clientId: "fixture\n" },
    { ...credentials(), username: " " }, { ...credentials(), password: "x".repeat(4097) },
    { ...credentials(), tokenUrl: "https://example.invalid" }, Promise.resolve(credentials())]) {
    const resolve = createVivaServiceTokenResolver({ credentialsResolver: () => value,
      fetchImpl: async () => { calls++; return grantResponse(); } });
    await assert.rejects(resolve(), tokenUnavailable);
    resolve.close();
  }
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: () => { throw new Error("PRIVATE_CREDENTIAL_ERROR"); },
    fetchImpl: async () => { calls++; return grantResponse(); } });
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(calls, 0);
  resolve.close();
});

test("standalone token rejects elapsed deadlines even before the abort timer can run", async () => {
  for (const phase of ["headers", "body"]) {
    let now = 0;
    let cancellations = 0;
    let releases = 0;
    const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials, monotonicNow: () => now,
      fetchImpl: async () => {
        if (phase === "headers") now = 5_000;
        return { status: 200, headers: { get: () => null }, body: { getReader: () => ({
          read: async () => {
            now = 5_000;
            return { done: false, value: Buffer.from(JSON.stringify({ access_token: TOKEN, token_type: "Bearer", expires_in: 300 })) };
          },
          cancel: () => { cancellations++; }, releaseLock: () => { releases++; },
        }) } };
      } });
    await assert.rejects(resolve(), tokenUnavailable);
    assert.equal(cancellations, 1);
    assert.equal(releases, 1);
    resolve.close();
  }
});

test("standalone token accepts identity framing and rejects encoded responses before reading", async () => {
  const body = JSON.stringify({ access_token: TOKEN, token_type: "Bearer", expires_in: 300 });
  const identity = createVivaServiceTokenResolver({ credentialsResolver: credentials,
    fetchImpl: async () => new Response(body, { headers: { "Content-Encoding": "identity", "Content-Length": String(Buffer.byteLength(body)) } }) });
  assert.equal(await identity(), TOKEN);
  identity.close();
  for (const encoding of ["gzip", "deflate", "br", "gzip, identity"]) {
    let reads = 0;
    let cancelled = 0;
    const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials,
      fetchImpl: async () => ({ status: 200, headers: { get: name => name === "content-encoding" ? encoding : null },
        body: { getReader: () => { reads++; }, cancel: () => { cancelled++; } } }) });
    await assert.rejects(resolve(), tokenUnavailable);
    assert.equal(reads, 0);
    assert.equal(cancelled, 1);
    resolve.close();
  }
});

test("standalone token rejects malformed, redirected, unbounded or incomplete responses with redacted errors", async () => {
  for (const make of [
    () => response(302, { access_token: TOKEN }),
    () => response(503, { error: "PRIVATE_PROVIDER_ERROR" }),
    () => new Response('{"access_token":"PRIVATE_TOKEN_BODY"', { status: 200 }),
    () => grantResponse({ access_token: "short" }),
    () => grantResponse({ access_token: `${TOKEN}\n` }),
    () => grantResponse({ token_type: "Basic" }),
    () => new Response(new Uint8Array([0xff]), { status: 200 }),
    () => new Response("{}", { status: 200, headers: { "Content-Length": "1" } }),
    () => new Response("{}", { status: 200, headers: { "Content-Length": "3" } }),
    () => new Response("{}", { status: 200, headers: { "Content-Length": "invalid" } }),
    () => new Response("{}", { status: 200, headers: { "Content-Length": String(PARTNER_VIVA_TOKEN_RESPONSE_MAX_BYTES + 1) } }),
    () => new Response("x".repeat(PARTNER_VIVA_TOKEN_RESPONSE_MAX_BYTES + 1), { status: 200 }),
    () => ({ status: 200, redirected: true, body: { cancel() {} } }),
    () => ({ status: 200, url: "https://example.invalid", body: { cancel() {} } }),
  ]) {
    let calls = 0;
    const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials,
      fetchImpl: async () => { calls++; return make(); } });
    await assert.rejects(resolve(), error => {
      assert.equal(error.code, tokenUnavailable.code);
      assert.equal(error.expose, false);
      assert.equal(error.ambiguous, false);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /PRIVATE_|fixture-user|fixture-password|header\.payload|example\.invalid/);
      return true;
    });
    assert.equal(calls, 1);
    resolve.close();
  }
});

test("standalone token deadline covers a stalled body and cancellation releases its reader", async () => {
  let signal;
  let cancellations = 0;
  let releases = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials, timeoutMs: 1_000,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { status: 200, headers: { get: () => null }, body: { getReader: () => ({
        read: () => new Promise(() => {}), cancel: () => { cancellations++; }, releaseLock: () => { releases++; },
      }) } };
    } });
  await assert.rejects(resolve(), tokenUnavailable);
  assert.equal(signal.aborted, true);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  resolve.close();
});

test("standalone token close aborts a non-cooperating transport and cancels its late response", async () => {
  let finish;
  let signal;
  let cancelled = 0;
  const resolve = createVivaServiceTokenResolver({ credentialsResolver: credentials,
    fetchImpl: (_url, options) => { signal = options.signal; return new Promise(done => { finish = done; }); } });
  const rejected = assert.rejects(resolve(), tokenUnavailable);
  resolve.close();
  await rejected;
  assert.equal(signal.aborted, true);
  finish({ body: { cancel: () => { cancelled++; } } });
  await new Promise(done => setImmediate(done));
  assert.equal(cancelled, 1);
});

test("provider readiness does not fetch credentials or tokens while any mutation gate is closed", async () => {
  let reads = 0;
  let calls = 0;
  const tokenResolver = createVivaServiceTokenResolver({ credentialsResolver: () => { reads++; return credentials(); },
    fetchImpl: async () => { calls++; return grantResponse(); } });
  for (const overrides of [{ mutationsEnabled: false }, { contractRevision: "wrong" },
    { idempotencyConfirmed: false }, { onPlacePaymentConfirmed: false }]) {
    const provider = new VivaAdminTechnicalUserProvider({ tokenResolver, mutationsEnabled: true,
      contractRevision: PARTNER_VIVA_CONTRACT_REVISION, idempotencyConfirmed: true, onPlacePaymentConfirmed: true,
      ...overrides });
    await assert.rejects(provider.assertReady());
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  tokenResolver.close();
});

test("new token source does not retry a booking mutation rejected with 401", async () => {
  let tokenCalls = 0;
  let mutationCalls = 0;
  const tokenResolver = createVivaServiceTokenResolver({ credentialsResolver: credentials,
    fetchImpl: async () => { tokenCalls++; return grantResponse(); } });
  const provider = new VivaAdminTechnicalUserProvider({ tokenResolver,
    mutationsEnabled: true, contractRevision: PARTNER_VIVA_CONTRACT_REVISION,
    idempotencyConfirmed: true, onPlacePaymentConfirmed: true,
    fetchImpl: async () => { mutationCalls++; return response(401, { error: "Unauthorized" }); } });
  await provider.assertReady();
  await assert.rejects(provider.addTechnicalUser(addInput));
  assert.equal(tokenCalls, 1);
  assert.equal(mutationCalls, 1);
  tokenResolver.close();
});

test("Viva provider remains fail-closed until every external contract gate is explicit", async () => {
  const calls = [];
  const base = {
    fetchImpl: async (...args) => { calls.push(args); return response(200, {}); },
    tokenResolver: async () => TOKEN,
    mutationsEnabled: true,
    contractRevision: PARTNER_VIVA_CONTRACT_REVISION,
    idempotencyConfirmed: true,
    onPlacePaymentConfirmed: true,
  };
  for (const [field, value, code] of [
    ["mutationsEnabled", false, "VIVA_RUNTIME_NOT_CONFIGURED"],
    ["contractRevision", "unapproved", "VIVA_CONTRACT_NOT_APPROVED"],
    ["idempotencyConfirmed", false, "VIVA_IDEMPOTENCY_NOT_CONFIRMED"],
    ["onPlacePaymentConfirmed", false, "VIVA_PAYMENT_TYPE_NOT_CONFIRMED"],
    ["apiBase", "https://example.invalid/api", "VIVA_API_BASE_INVALID"],
  ]) {
    const provider = new VivaAdminTechnicalUserProvider({ ...base, [field]: value });
    await assert.rejects(() => provider.assertReady(), { code, ambiguous: false });
  }
  const missingToken = new VivaAdminTechnicalUserProvider({ ...base, tokenResolver: async () => "" });
  await assert.rejects(() => missingToken.assertReady(), { code: "VIVA_SERVICE_TOKEN_UNAVAILABLE" });
  assert.equal(calls.length, 0);
});

test("Viva add uses the pinned path, body, proof headers, and exact response binding", async () => {
  const calls = [];
  const provider = readyProvider(async (url, options) => {
    calls.push({ url, options });
    return response(201, {
      id: "booking-1",
      clientId: addInput.technicalVivaClientId,
      exerciseId: addInput.exerciseId,
    });
  });
  assert.deepEqual(await provider.addTechnicalUser(addInput), { bookingId: "booking-1" });
  assert.equal(calls.length, 1, "mutation adapter must never retry");
  assert.equal(calls[0].url, `${PARTNER_VIVA_ADMIN_API_BASE}/exercises/exercise-1/bookings`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers["Idempotency-Key"], addInput.idempotencyKey);
  assert.equal(calls[0].options.headers["X-Correlation-ID"], OPERATION_ID);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    clientId: addInput.technicalVivaClientId,
    paymentType: "ON_PLACE",
    familyMemberId: "",
    customFields: [],
  });
});

test("Viva mutation transport and 5xx outcomes are ambiguous and never retried", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("socket closed"); },
    async () => response(503, { error: "unavailable" }),
  ]) {
    let calls = 0;
    const provider = readyProvider(async (...args) => { calls += 1; return fetchImpl(...args); });
    await assert.rejects(() => provider.addTechnicalUser(addInput), {
      code: "VIVA_ADD_OUTCOME_UNKNOWN",
      ambiguous: true,
      httpStatus: 202,
    });
    assert.equal(calls, 1);
  }
});

test("Viva response timeout remains active while the body is streaming", async () => {
  let signal;
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const provider = readyProvider(async (_url, options) => {
    signal = options.signal;
    return {
      status: 201,
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read() {
              readCalls += 1;
              return new Promise(() => {});
            },
            async cancel() { cancelCalls += 1; },
            releaseLock() { releaseCalls += 1; },
          };
        },
      },
    };
  });

  const startedAt = Date.now();
  await assert.rejects(() => provider.addTechnicalUser(addInput), {
    code: "VIVA_ADD_OUTCOME_UNKNOWN",
    ambiguous: true,
    httpStatus: 202,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(signal.aborted, true);
  assert.equal(readCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.ok(elapsedMs >= 900, `body timeout fired too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2_000, `body timeout did not bound the request: ${elapsedMs}ms`);
});

test("Viva response streaming stops and cancels before buffering an oversized body", async () => {
  const chunks = [
    new Uint8Array(600_000).fill(0x20),
    new Uint8Array(PARTNER_VIVA_RESPONSE_MAX_BYTES - 600_000 + 1).fill(0x20),
    new Uint8Array(1).fill(0x20),
  ];
  let readCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  const provider = readyProvider(async () => ({
    status: 201,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            const value = chunks[readCalls];
            readCalls += 1;
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          async cancel() { cancelCalls += 1; },
          releaseLock() { releaseCalls += 1; },
        };
      },
    },
  }));

  await assert.rejects(() => provider.addTechnicalUser(addInput), {
    code: "VIVA_RESPONSE_TOO_LARGE",
    ambiguous: true,
    httpStatus: 202,
  });
  assert.equal(readCalls, 2, "reader must stop before requesting another chunk");
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("Viva response rejects an oversized Content-Length before opening the stream", async () => {
  let getReaderCalls = 0;
  let cancelCalls = 0;
  const provider = readyProvider(async () => ({
    status: 201,
    ok: true,
    headers: {
      get(name) {
        return name === "content-length" ? String(PARTNER_VIVA_RESPONSE_MAX_BYTES + 1) : null;
      },
    },
    body: {
      getReader() {
        getReaderCalls += 1;
        throw new Error("oversized response must not be opened");
      },
      async cancel() { cancelCalls += 1; },
    },
  }));

  await assert.rejects(() => provider.addTechnicalUser(addInput), {
    code: "VIVA_RESPONSE_TOO_LARGE",
    ambiguous: true,
    httpStatus: 202,
  });
  assert.equal(getReaderCalls, 0);
  assert.equal(cancelCalls, 1);
});

test("Viva add rejects missing or mismatched booking identity as ambiguous", async () => {
  for (const payload of [
    {},
    { id: "booking-1", clientId: "someone-else", exerciseId: "exercise-1" },
    { id: "booking-1", bookingId: "booking-2" },
    { id: "booking-1", data: { id: "booking-2" } },
    {
      data: { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1" },
      booking: { id: "booking-2", clientId: "technical-client-1", exerciseId: "exercise-1" },
    },
  ]) {
    const provider = readyProvider(async () => response(201, payload));
    await assert.rejects(() => provider.addTechnicalUser(addInput), { ambiguous: true });
  }
});

test("Viva readback binds one booking and rejects duplicate identities", async () => {
  const readInput = { ...addInput, bookingId: "booking-1" };
  const provider = readyProvider(async (url, options) => {
    assert.equal(url, `${PARTNER_VIVA_ADMIN_API_BASE}/exercises/exercise-1/bookings?showCancelled=true&page=0&size=200`);
    assert.equal(options.method, "GET");
    return response(200, { content: [{
      id: "booking-1",
      clientId: "technical-client-1",
      exerciseId: "exercise-1",
      status: "ACTIVE",
    }] });
  });
  assert.deepEqual(await provider.readBooking(readInput), {
    bookingId: "booking-1",
    exerciseId: "exercise-1",
    clientId: "technical-client-1",
    active: true,
  });

  const duplicate = readyProvider(async () => response(200, [
    { id: "booking-1" },
    { id: "booking-1" },
  ]));
  await assert.rejects(() => duplicate.readBooking(readInput), {
    code: "VIVA_READBACK_AMBIGUOUS",
    ambiguous: true,
  });

  for (const row of [
    { id: "booking-1", clientId: "other", exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1" },
  ]) {
    const ambiguous = readyProvider(async () => response(200, [row]));
    await assert.rejects(() => ambiguous.readBooking(readInput), { ambiguous: true });
  }

  const incompleteAbsence = readyProvider(async () => response(200, { content: [], last: false }));
  await assert.rejects(() => incompleteAbsence.readBooking(readInput), {
    code: "VIVA_READBACK_INCOMPLETE",
    ambiguous: true,
  });
  const completeAbsence = readyProvider(async () => response(200, {
    content: [],
    number: 0,
    totalPages: 0,
    totalElements: 0,
  }));
  assert.equal((await completeAbsence.readBooking(readInput)).active, false);

  const conflictingContainers = readyProvider(async () => response(200, {
    content: [],
    items: [{
      id: "booking-1",
      clientId: "technical-client-1",
      exerciseId: "exercise-1",
      status: "ACTIVE",
    }],
    number: 0,
    totalPages: 0,
  }));
  await assert.rejects(() => conflictingContainers.readBooking(readInput), {
    code: "VIVA_READBACK_AMBIGUOUS",
    ambiguous: true,
  });

  const sharedRows = [{
    id: "booking-1",
    clientId: "technical-client-1",
    exerciseId: "exercise-1",
    status: "ACTIVE",
  }];
  const agreeingContainers = readyProvider(async () => response(200, {
    content: sharedRows,
    items: structuredClone(sharedRows),
  }));
  assert.equal((await agreeingContainers.readBooking(readInput)).active, true);
});

test("Viva readback accepts agreeing aliases and rejects contradictory identity or lifecycle evidence", async () => {
  const readInput = { ...addInput, bookingId: "booking-1" };
  for (const [row, active] of [
    [{
      id: "booking-1",
      bookingId: "booking-1",
      uuid: "booking-1",
      clientId: "technical-client-1",
      client: { id: "technical-client-1" },
      customer: { id: "technical-client-1" },
      exerciseId: "exercise-1",
      exercise: { id: "exercise-1" },
      service: { id: "exercise-1" },
      active: true,
      cancelled: false,
      canceled: false,
      status: "ACTIVE",
      state: "active",
    }, true],
    [{
      bookingId: "booking-1",
      client: { id: "technical-client-1" },
      service: { id: "exercise-1" },
      state: "CONFIRMED",
    }, true],
    [{
      uuid: "booking-1",
      customer: { id: "technical-client-1" },
      exercise: { id: "exercise-1" },
      active: false,
      status: "CANCELLED",
    }, false],
  ]) {
    const provider = readyProvider(async () => response(200, [row]));
    assert.equal((await provider.readBooking(readInput)).active, active);
  }

  for (const row of [
    { id: "booking-1", bookingId: "booking-2", clientId: "technical-client-1", exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", client: { id: "other" }, exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", service: { id: "other" }, status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: false, status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: true, status: "CANCELLED" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", status: "ACTIVE", state: "CANCELLED" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", cancelled: true, canceled: false },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: "false", status: "CANCELLED" },
  ]) {
    const provider = readyProvider(async () => response(200, [row]));
    await assert.rejects(() => provider.readBooking(readInput), {
      code: "VIVA_READBACK_AMBIGUOUS",
      ambiguous: true,
    });
  }
});

test("Viva removal requires cancellation-only proof before the pinned cancellation command", async () => {
  const calls = [];
  const input = { ...addInput, bookingId: "booking-1", idempotencyKey: "partner-remove-001" };
  const provider = readyProvider(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      return response(200, { cancellationOptions: { cancellationOnly: { available: true } } });
    }
    return response(200, { id: "booking-1" });
  });
  assert.deepEqual(await provider.removeTechnicalUser(input), { bookingId: "booking-1" });
  const expectedPath = "/clients/technical-client-1/bookings/booking-1/cancel";
  assert.equal(calls[0].url, `${PARTNER_VIVA_ADMIN_API_BASE}${expectedPath}`);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["Idempotency-Key"], input.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[1].options.body), { refundMethod: "NONE", cancelExercise: false });

  const unsafe = readyProvider(async () => response(200, { cancellationOptions: {} }));
  await assert.rejects(() => unsafe.removeTechnicalUser(input), {
    code: "VIVA_CANCEL_CONTRACT_MISMATCH",
    ambiguous: false,
    httpStatus: 409,
  });
});
