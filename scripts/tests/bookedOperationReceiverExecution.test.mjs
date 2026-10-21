import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { receiverFunctionSource } from "../patch_nodered_booked_operation_receiver_flow.mjs";

// LOCAL, network-free execution-adapter matrix. HTTP and Mongo are simulated by
// feeding the exact messages the Node-RED http request / mongodb4 nodes would
// emit; no provider, database or live Node-RED is contacted. The RSA key pair is
// generated per run and is never a deployed secret.

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUER = "https://lk2.example.test/issuer";
const AUDIENCE = "lk1-booked-operation";
const KEY_ID = "lk2-booked-op-test";
const ADMIT_PATH = "/lk/integrations/v1/booked-operation-admissions";
const READ_PREFIX = "/lk/integrations/v1/booked-operations/";
const ADMIT_SCOPE = "subscription-runtime.booked-operation.admit";
const READ_SCOPE = "subscription-runtime.booked-operation.read";
const DELEGATION_TYPE = "phub-subscription-runtime-actor-delegation+jwt";
const ACTOR_TOKEN = "viva-actor-token-0123456789abcdef";
const VIVA_API_BASE = "https://viva.test.invalid";
const CLIENT_SUBSCRIPTION_ID = "viva-client-subscription-1";
const PROVIDER_CLIENT_ID = "viva-client-1";
const PROVIDER_EXERCISE_ID = "viva-exercise-1";
const TENANT_KEY = "iSkq6G";

const b64url = (value) => Buffer.from(value).toString("base64url");
const sha256Hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const actorTokenSha256 = `sha256:${sha256Hex(ACTOR_TOKEN)}`;
const now = () => Math.floor(Date.now() / 1000);
const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

const tenantId = crypto.randomUUID();
const userId = crypto.randomUUID();
const operationId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const providerMappingId = crypto.randomUUID();
const targetMappingId = crypto.randomUUID();
const targetId = crypto.randomUUID();
const correlationId = "booked-op-correlation-0001";

const baseEnv = {
  LK1_BOOKED_OPERATION_RECEIVER_ENABLED: "true",
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER: ISSUER,
  LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: AUDIENCE,
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: KEY_ID,
  LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: publicKey,
};
const executionEnv = {
  ...baseEnv,
  BOOKED_OPERATION_EXECUTION_ENABLED: "true",
  LK1_BOOKED_OPERATION_VIVA_API_BASE: VIVA_API_BASE,
};
const envOf = (values) => ({
  get: (key) => (key in values ? values[key] : (baseEnv[key] ?? null)),
});
const runFunction = (name, msg, values) => new Function(
  "msg",
  "env",
  "nodeCrypto",
  receiverFunctionSource(name),
)(msg, envOf(values), crypto);

const sign = (payload, key = privateKey) => {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: DELEGATION_TYPE, kid: KEY_ID }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${b64url(signature)}`;
};

const admissionBody = () => ({
  action: "JOIN_GAME",
  paymentIntent: "USE_SUBSCRIPTION",
  target: { id: targetId, expectedRevision: 7 },
});
const requestSha = (body) => "sha256:" + sha256Hex(
  "booked-operation-admission:v1\0" + JSON.stringify({
    action: "JOIN_GAME",
    target: { id: body.target.id, expectedRevision: body.target.expectedRevision },
    paymentIntent: "USE_SUBSCRIPTION",
  }),
);
const admissionClaims = (body, overrides = {}) => ({
  contract_version: 1,
  scope: ADMIT_SCOPE,
  caller: "lk2-api",
  method: "POST",
  path: ADMIT_PATH,
  operation_id: operationId,
  tenant_id: tenantId,
  tenant_key: TENANT_KEY,
  sid: sessionId,
  provider: "VIVA",
  provider_client_id: PROVIDER_CLIENT_ID,
  provider_mapping_id: providerMappingId,
  correlation_id: correlationId,
  request_sha256: requestSha(body),
  idempotency_key_sha256: "sha256:" + sha256Hex("idempotency-key-0001"),
  target_id: body.target.id,
  expected_revision: body.target.expectedRevision,
  target_mapping_id: targetMappingId,
  provider_exercise_id: PROVIDER_EXERCISE_ID,
  target_version: "1",
  target_starts_at: futureIso(72 * 60 * 60 * 1000),
  target_duration_minutes: 90,
  target_capacity: 4,
  target_admissible: true,
  iss: ISSUER,
  aud: AUDIENCE,
  sub: userId,
  iat: now() - 1,
  nbf: now() - 1,
  exp: now() + 30,
  jti: crypto.randomUUID(),
  ...overrides,
});
const boundClaims = (body) => admissionClaims(body, {
  actor_token_expires_at: futureIso(45 * 1000),
  actor_token_sha256: actorTokenSha256,
  provider_client_subscription_id: CLIENT_SUBSCRIPTION_ID,
});
const readClaims = () => ({
  contract_version: 1,
  scope: READ_SCOPE,
  caller: "lk2-api",
  method: "GET",
  path: READ_PREFIX + operationId,
  operation_id: operationId,
  tenant_id: tenantId,
  tenant_key: TENANT_KEY,
  sid: sessionId,
  provider: "VIVA",
  provider_client_id: PROVIDER_CLIENT_ID,
  provider_mapping_id: providerMappingId,
  correlation_id: correlationId,
  iss: ISSUER,
  aud: AUDIENCE,
  sub: userId,
  iat: now() - 1,
  nbf: now() - 1,
  exp: now() + 30,
  jti: crypto.randomUUID(),
});
const admissionMessage = (token, body, headers = {}) => ({
  req: {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-subscription-actor-delegation": token,
      "x-correlation-id": correlationId,
      ...headers,
    },
    query: {},
  },
  payload: structuredClone(body),
});
const boundHeaders = { "x-subscription-actor-token": ACTOR_TOKEN };
const readMessage = (token) => ({
  req: {
    method: "GET",
    params: { operationId },
    headers: {
      "x-subscription-actor-delegation": token,
      "x-correlation-id": correlationId,
    },
    query: {},
  },
  payload: undefined,
});
const mongoAck = (overrides = {}) => ({
  acknowledged: true,
  matchedCount: 1,
  modifiedCount: 1,
  upsertedCount: 0,
  upsertedId: null,
  ...overrides,
});
const applyUpdate = (document, update) => {
  const next = structuredClone(document);
  Object.assign(next, update.$set || {});
  for (const key of ["attempts", "receipts"]) {
    if (update.$push && update.$push[key]) {
      next[key] = [...(next[key] || []), update.$push[key]];
    }
  }
  return next;
};
const providerProfile = () => ({ id: PROVIDER_CLIENT_ID, phone: "+7 999 000-11-22" });
const providerBooking = () => ({
  id: "viva-booking-0001",
  exerciseId: PROVIDER_EXERCISE_ID,
  clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
  paymentType: "SUBSCRIPTION",
  status: "ACTIVE",
});

// admission -> verify -> find (empty) -> guarded insert -> execution dispatch
const dispatchAdmission = (values = executionEnv, claims = boundClaims, headers = boundHeaders) => {
  const body = admissionBody();
  const verify = runFunction(
    "admission_verify",
    admissionMessage(sign(claims(body)), body, headers),
    values,
  );
  assert.equal(verify[1], null, JSON.stringify(verify[1]));
  const contextMsg = verify[0];
  const find = runFunction("router", {
    _bookedOperation: contextMsg._bookedOperation,
    payload: [],
  }, values);
  assert.ok(find[0], "fresh admission must start the guarded insert");
  const insertMsg = find[0];
  insertMsg.payload = mongoAck({
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 1,
    upsertedId: operationId,
  });
  const afterInsert = runFunction("router", insertMsg, values);
  return {
    afterInsert,
    document: contextMsg._bookedOperation.document,
    executorMessage: afterInsert[3],
    findContext: contextMsg._bookedOperation,
    insertMessage: insertMsg,
    verify,
  };
};
const readOutcome = (document, values = baseEnv) => {
  const verify = runFunction("read_verify", readMessage(sign(readClaims())), values);
  assert.equal(verify[1], null, JSON.stringify(verify[1]));
  return runFunction("router", {
    _bookedOperation: verify[0]._bookedOperation,
    payload: [document],
  }, values);
};
const provideProfile = (msg) => {
  msg.statusCode = 200;
  msg.payload = providerProfile();
  delete msg.error;
};
// Executor steps mutate the same Node-RED message, so every result is snapshotted
// before the next step: the assertions see the exact message each node emitted.
const startExecution = (values = executionEnv) => {
  const dispatched = dispatchAdmission(values);
  const execMsg = dispatched.executorMessage;
  assert.ok(execMsg, "a bound, enabled admission must reach the executor");
  const providerCalls = [];
  const step = () => {
    const result = structuredClone(runFunction("executor", execMsg, values));
    if (result[0] && result[0].method) {
      providerCalls.push({
        method: result[0].method,
        payload: result[0].payload,
        url: result[0].url,
      });
    }
    return result;
  };
  return { ...dispatched, execMsg, providerCalls, step };
};
const driveToAttemptMarker = (values = executionEnv) => {
  const driven = startExecution(values);
  const profileRequest = driven.step();
  provideProfile(driven.execMsg);
  const markerRequest = driven.step();
  return { ...driven, markerRequest, profileRequest };
};
const driveToProviderPost = (values = executionEnv, markerAck = mongoAck()) => {
  const driven = driveToAttemptMarker(values);
  delete driven.execMsg.statusCode;
  driven.execMsg.payload = markerAck;
  const postRequest = driven.step();
  return { ...driven, postRequest };
};

test("activation flag off keeps the admission PENDING with no provider call", () => {
  const { afterInsert, document } = dispatchAdmission(baseEnv, () => admissionClaims(admissionBody()));
  assert.equal(afterInsert[3], null, "disabled adapter must not dispatch");
  assert.equal(afterInsert[1].statusCode, 202);
  assert.equal(afterInsert[1].payload.status, "PENDING");
  assert.equal(afterInsert[1].payload.reason, "OWNER_PENDING");
  assert.equal(document.state, "PENDING");
  assert.equal(document.providerClientSubscriptionId, null);
  assert.equal(JSON.stringify(document).includes("Bearer"), false);
});

test("flag on without the token/claim binding still performs no provider call", () => {
  const { afterInsert, document, executorMessage } = dispatchAdmission(
    executionEnv,
    () => admissionClaims(admissionBody()),
  );
  assert.equal(executorMessage, null);
  assert.equal(afterInsert[1].statusCode, 202);
  assert.equal(afterInsert[1].payload.status, "PENDING");
  assert.equal(document.providerClientSubscriptionId, null);
  assert.equal(document.attempts[0].executionBlockedReason, "ACTOR_TOKEN_BINDING_MISSING");
  assert.equal(JSON.stringify(document).includes(ACTOR_TOKEN), false);
});

test("actor-token binding failures are 403 at verification and never dispatch", () => {
  const body = admissionBody();
  const mismatched = admissionClaims(body, {
    actor_token_sha256: `sha256:${sha256Hex("some-other-token-0123456789")}`,
    provider_client_subscription_id: CLIENT_SUBSCRIPTION_ID,
  });
  const mismatch = runFunction(
    "admission_verify",
    admissionMessage(sign(mismatched), body, boundHeaders),
    executionEnv,
  );
  assert.equal(mismatch[0], null);
  assert.equal(mismatch[1].statusCode, 403);
  assert.equal(mismatch[1].payload.code, "BOOKED_OPERATION_ACTOR_TOKEN_MISMATCH");

  const missing = runFunction(
    "admission_verify",
    admissionMessage(sign(boundClaims(body)), body),
    executionEnv,
  );
  assert.equal(missing[0], null);
  assert.equal(missing[1].statusCode, 403);
  assert.equal(missing[1].payload.code, "BOOKED_OPERATION_ACTOR_TOKEN_REQUIRED");

  const expired = runFunction(
    "admission_verify",
    admissionMessage(
      sign(admissionClaims(body, {
        actor_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
        actor_token_sha256: actorTokenSha256,
        provider_client_subscription_id: CLIENT_SUBSCRIPTION_ID,
      })),
      body,
      boundHeaders,
    ),
    executionEnv,
  );
  assert.equal(expired[1].statusCode, 403);
  assert.equal(expired[1].payload.code, "BOOKED_OPERATION_ACTOR_TOKEN_EXPIRED");
});

test("bound token: profile read, ATTEMPTING marker before the single SUBSCRIPTION POST, CONFIRMED receipt", () => {
  const driven = driveToProviderPost();
  const { execMsg, document } = driven;
  const profileRequest = driven.profileRequest;
  const markerResult = driven.markerRequest;
  const postResult = driven.postRequest;

  // 1. The actor's own Viva profile is resolved with the user-scoped token.
  assert.equal(profileRequest[0].method, "GET");
  assert.equal(profileRequest[0].url, `${VIVA_API_BASE}/end-user/api/v1/${TENANT_KEY}/profile`);
  assert.equal(profileRequest[0].headers.Authorization, `Bearer ${ACTOR_TOKEN}`);
  assert.equal(profileRequest[0].payload, undefined);
  assert.equal(profileRequest[1], null, "profile read must not write durable state");
  assert.equal(JSON.stringify(profileRequest[0]._bookedOperation).includes(ACTOR_TOKEN), true);

  // 2. ATTEMPTING is written BEFORE the provider POST is emitted.
  const [markerFilter, markerUpdate] = markerResult[1].payload;
  assert.deepEqual(markerFilter, {
    _id: operationId,
    kind: "BOOKED_OPERATION_ADMISSION",
    state: "PENDING",
  });
  assert.equal(markerUpdate.$set.state, "ATTEMPTING");
  assert.equal(markerUpdate.$set.stateReason, "DISPATCH_ATTEMPTING");
  assert.equal(markerUpdate.$push.attempts.kind, "DISPATCH_ATTEMPTING");
  assert.match(markerUpdate.$push.attempts.attemptId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(markerResult[1].payload).includes(ACTOR_TOKEN), false);
  assert.equal(markerResult[0], null, "no provider POST may precede the marker");

  // 3. Exactly one booking POST with the mapped identifiers from the op document.
  const post = postResult[0];
  assert.equal(post.method, "POST");
  assert.equal(
    post.url,
    `${VIVA_API_BASE}/api/v2/exercises/${PROVIDER_EXERCISE_ID}/bookings`,
  );
  assert.deepEqual(post.payload, {
    clientId: PROVIDER_CLIENT_ID,
    phone: "+79990001122",
    paymentType: "SUBSCRIPTION",
    clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
    customFields: [],
  });
  assert.equal(post.headers.Authorization, `Bearer ${ACTOR_TOKEN}`);

  // 4. The provider acceptance is confirmed by the readback, never assumed.
  execMsg.statusCode = 201;
  execMsg.payload = { id: "viva-booking-0001", correlationId: "provider-corr-1" };
  delete execMsg.error;
  const readback = driven.step();
  assert.equal(readback[0].method, "GET");
  assert.equal(
    readback[0].url,
    `${VIVA_API_BASE}/end-user/api/v2/${TENANT_KEY}/bookings?size=1000`,
  );

  // 5. Only the observed booking confirms the operation, with a durable receipt.
  execMsg.statusCode = 200;
  execMsg.payload = { content: [providerBooking()] };
  const finalize = driven.step();
  const [finalFilter, finalUpdate] = finalize[2].payload;
  assert.deepEqual(finalFilter, {
    _id: operationId,
    "attempt.attemptId": markerUpdate.$push.attempts.attemptId,
    kind: "BOOKED_OPERATION_ADMISSION",
    state: "ATTEMPTING",
  });
  assert.equal(finalUpdate.$set.state, "CONFIRMED");
  assert.equal(finalUpdate.$set.bookingId, "viva-booking-0001");
  assert.equal(finalUpdate.$push.attempts.kind, "CONFIRMED_READBACK");
  assert.deepEqual(finalUpdate.$push.receipts, {
    bookingId: "viva-booking-0001",
    confirmedAt: finalUpdate.$set.confirmedAt,
    operationId,
    source: "PROVIDER_BOOKING_READBACK",
  });
  assert.equal(JSON.stringify(finalize[2].payload).includes(ACTOR_TOKEN), false);

  execMsg.payload = mongoAck();
  const response = driven.step();
  assert.equal(response[3].statusCode, 200);
  assert.deepEqual(response[3].payload, {
    asOf: finalUpdate.$set.updatedAt,
    contractVersion: 1,
    operationId,
    reason: "OWNER_BOOKING_CONFIRMED",
    status: "CONFIRMED",
  });
  assert.equal(JSON.stringify(execMsg).includes(ACTOR_TOKEN), false, "token must be scrubbed");
  assert.equal(driven.providerCalls.filter((call) => call.method === "POST").length, 1);

  const guarded = runFunction("response", response[3], executionEnv);
  assert.equal(guarded[0].statusCode, 200);
  assert.equal(guarded[0].headers["Cache-Control"], "no-store");

  // Terminal CONFIRMED: a repeat admission and a read never dispatch again.
  const persisted = applyUpdate(applyUpdate(document, markerUpdate), finalUpdate);
  assert.equal(persisted.state, "CONFIRMED");
  assert.equal(persisted.receipts.length, 1);
  const repeat = runFunction("router", {
    _bookedOperation: { ...driven.findContext, step: "find" },
    payload: [persisted],
  }, executionEnv);
  assert.equal(repeat[3], null, "CONFIRMED is terminal: no second dispatch");
  assert.equal(repeat[1].statusCode, 200);
  assert.equal(repeat[1].payload.status, "CONFIRMED");
  const read = readOutcome(persisted);
  assert.equal(read[3], null);
  assert.equal(read[1].statusCode, 200);
  assert.equal(read[1].payload.status, "CONFIRMED");
  assert.equal(read[1].payload.reason, "OWNER_BOOKING_CONFIRMED");
});

test("provider timeout or 5xx after the POST becomes terminal UNKNOWN and is never retried", () => {
  const driven = driveToProviderPost();
  const { execMsg } = driven;
  execMsg.error = { message: "connect ETIMEDOUT" };
  delete execMsg.statusCode;
  const finalize = driven.step();
  const finalUpdate = finalize[2].payload[1];
  assert.equal(finalUpdate.$set.state, "UNKNOWN");
  assert.equal(finalUpdate.$set.unknownReason, "PROVIDER_TRANSPORT_ERROR");
  assert.equal(finalUpdate.$set.stateReason, "RECONCILIATION_REQUIRED");
  assert.equal("receipts" in finalUpdate.$push, false);

  execMsg.payload = mongoAck();
  delete execMsg.error;
  const response = driven.step();
  assert.equal(response[3].statusCode, 202);
  assert.deepEqual(response[3].payload, {
    asOf: finalUpdate.$set.updatedAt,
    contractVersion: 1,
    operationId,
    reason: "RECONCILIATION_REQUIRED",
    status: "UNKNOWN",
  });

  const persisted = applyUpdate(
    applyUpdate(driven.document, driven.markerRequest[1].payload[1]),
    finalUpdate,
  );
  assert.equal(persisted.state, "UNKNOWN");
  const repeat = runFunction("router", {
    _bookedOperation: { ...driven.findContext, step: "find" },
    payload: [persisted],
  }, executionEnv);
  assert.equal(repeat[3], null, "UNKNOWN is never retried by a repeat admission");
  assert.equal(repeat[1].statusCode, 202);
  assert.equal(repeat[1].payload.status, "UNKNOWN");
  const read = readOutcome(persisted);
  assert.equal(read[1].payload.status, "UNKNOWN");
  assert.equal(read[1].payload.reason, "RECONCILIATION_REQUIRED");

  // The same classification applies to a definitive 5xx response.
  const second = driveToProviderPost();
  second.execMsg.statusCode = 502;
  second.execMsg.payload = { message: "bad gateway" };
  const secondFinalize = second.step();
  assert.equal(secondFinalize[2].payload[1].$set.state, "UNKNOWN");
  assert.equal(secondFinalize[2].payload[1].$set.unknownReason, "PROVIDER_UNAVAILABLE");
});

test("definitive provider rejection becomes terminal REJECTED with a stable 409 payload", () => {
  const driven = driveToProviderPost();
  const { execMsg } = driven;
  execMsg.statusCode = 409;
  execMsg.payload = { code: "exercise_full", message: "No free slots" };
  const finalize = driven.step();
  const finalUpdate = finalize[2].payload[1];
  assert.equal(finalUpdate.$set.state, "REJECTED");
  assert.equal(finalUpdate.$set.stateReason, "OWNER_BOOKING_REJECTED");
  assert.equal(finalUpdate.$set.rejectionCode, "EXERCISE_FULL");
  assert.equal(finalUpdate.$push.attempts.kind, "PROVIDER_REJECTED");
  assert.equal(finalUpdate.$push.attempts.statusCode, 409);
  assert.equal("receipts" in finalUpdate.$push, false);
  assert.equal(JSON.stringify(finalize[2].payload).includes("No free slots"), false);

  execMsg.payload = mongoAck();
  const response = driven.step();
  assert.equal(response[3].statusCode, 409);
  assert.deepEqual(response[3].payload, {
    asOf: finalUpdate.$set.rejectedAt,
    code: "BOOKED_OPERATION_REJECTED",
    contractVersion: 1,
    error: "BOOKED_OPERATION_REJECTED",
    operationId,
    rejectionCode: "EXERCISE_FULL",
  });

  const persisted = applyUpdate(
    applyUpdate(driven.document, driven.markerRequest[1].payload[1]),
    finalUpdate,
  );
  const repeat = runFunction("router", {
    _bookedOperation: { ...driven.findContext, step: "find" },
    payload: [persisted],
  }, executionEnv);
  assert.equal(repeat[3], null, "REJECTED is terminal");
  assert.equal(repeat[1].statusCode, 409);
  assert.equal(repeat[1].payload.code, "BOOKED_OPERATION_REJECTED");
  const read = readOutcome(persisted);
  assert.equal(read[1].statusCode, 409);
  assert.equal(read[1].payload.rejectionCode, "EXERCISE_FULL");
});

test("a lost or repeated attempt claim reconciles by readback and sends no second POST", () => {
  const driven = driveToAttemptMarker();
  // A concurrent winner already moved the operation off PENDING.
  delete driven.execMsg.statusCode;
  driven.execMsg.payload = mongoAck({
    matchedCount: 0,
    modifiedCount: 0,
  });
  const beaten = driven.step();
  assert.equal(beaten[0], null, "the losing claim must not send a provider POST");
  assert.ok(beaten[4], "the losing claim must reconcile by a durable readback");
  assert.deepEqual(beaten[4].payload, { _id: operationId });
  assert.equal(beaten[4]._bookedOperation.executionSuppressed, true);

  const attempting = applyUpdate(
    driven.document,
    driven.markerRequest[1].payload[1],
  );
  assert.equal(attempting.state, "ATTEMPTING");
  const readback = runFunction("router", {
    _bookedOperation: beaten[4]._bookedOperation,
    payload: [attempting],
  }, executionEnv);
  assert.equal(readback[3], null, "a suppressed readback must not dispatch again");
  assert.equal(readback[1].statusCode, 202);
  assert.equal(readback[1].payload.status, "PENDING");
  assert.equal(readback[1].payload.reason, "OWNER_PENDING");

  // ATTEMPTING also maps to PENDING on the read path.
  const read = readOutcome(attempting);
  assert.equal(read[1].statusCode, 200);
  assert.equal(read[1].payload.status, "PENDING");
  assert.equal(read[1].payload.reason, "OWNER_PENDING");
});

test("pre-dispatch failures never persist state and keep the operation recoverable", () => {
  const tokenRejected = startExecution();
  tokenRejected.step();
  tokenRejected.execMsg.statusCode = 401;
  tokenRejected.execMsg.payload = { message: "invalid token" };
  const rejected = tokenRejected.step();
  assert.equal(rejected[3].statusCode, 403);
  assert.equal(rejected[3].payload.code, "BOOKED_OPERATION_ACTOR_TOKEN_REJECTED");
  assert.equal(rejected[1], null, "no marker write before a provider POST");
  assert.equal(rejected[0], null);

  const transient = startExecution();
  transient.step();
  transient.execMsg.error = { message: "ECONNRESET" };
  delete transient.execMsg.statusCode;
  const pending = transient.step();
  assert.equal(pending[3].statusCode, 202);
  assert.equal(pending[3].payload.status, "PENDING");
  assert.equal(pending[1], null);

  const foreignProfile = startExecution();
  foreignProfile.step();
  foreignProfile.execMsg.statusCode = 200;
  foreignProfile.execMsg.payload = { id: "another-viva-client", phone: "+79990001122" };
  const mismatch = foreignProfile.step();
  assert.equal(mismatch[3].statusCode, 403);
  assert.equal(
    mismatch[3].payload.code,
    "BOOKED_OPERATION_ACTOR_PROFILE_IDENTITY_MISMATCH",
  );
  assert.equal(mismatch[0], null);

  const storeFailure = driveToAttemptMarker();
  storeFailure.execMsg.error = { message: "mongo write timeout" };
  delete storeFailure.execMsg.statusCode;
  const unavailable = storeFailure.step();
  assert.equal(unavailable[3].statusCode, 503);
  assert.equal(unavailable[3].payload.code, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  assert.equal(unavailable[0], null, "an ambiguous marker write must not send the POST");
});

test("executor stays fail-closed when the activation flag is off at dispatch time", () => {
  const driven = dispatchAdmission(executionEnv);
  const execMsg = driven.executorMessage;
  assert.ok(execMsg);
  const result = runFunction("executor", execMsg, baseEnv);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[3].statusCode, 202);
  assert.equal(result[3].payload.status, "PENDING");
});

test("the adapter reuses the existing subscription-booking provider contract", () => {
  const prepareSource = fs.readFileSync(
    path.join(ROOT, "nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js"),
    "utf8",
  );
  const routerSource = fs.readFileSync(
    path.join(ROOT, "nodered_subscription_booking_nodes/fn_subscription_booking_router.js"),
    "utf8",
  );
  const contractSource = fs.readFileSync(
    path.join(ROOT, "nodered_booked_operation_receiver_nodes/_booked_operation_viva_contract.js"),
    "utf8",
  );
  // Same profile read, same booking endpoint shape and same payload contract.
  assert.match(prepareSource, /end-user\/api\/v1\/\$\{TENANT_KEY\}\/profile/);
  assert.match(routerSource, /\/api\/\$\{adminVersion\}\/exercises\/\$\{encodeURIComponent\(ctx\.exerciseId\)\}\/bookings/);
  assert.match(routerSource, /paymentType: "SUBSCRIPTION"/);
  assert.match(routerSource, /clientSubscriptionId: ctx\.clientSubscriptionId/);
  assert.match(routerSource, /end-user\/api\/v2\/\$\{ctx\.tenantKey\}\/bookings\?size=1000/);
  assert.match(contractSource, /BOOKED_OP_VIVA_PAYMENT_TYPE = "SUBSCRIPTION"/);
  assert.match(contractSource, /"\/api\/v2\/exercises\/\{provider_exercise_id\}\/bookings"/);
  assert.match(contractSource, /"\/end-user\/api\/v1\/\{tenant_key\}\/profile"/);
  assert.match(contractSource, /"\/end-user\/api\/v2\/\{tenant_key\}\/bookings\?size=1000"/);
  assert.match(contractSource, /customFields: \[\]/);
});
