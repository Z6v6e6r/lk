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
const reservationId = crypto.randomUUID();
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
  LK1_BOOKED_OPERATION_OWNER_BASE_URL: "http://127.0.0.1:1880",
  LK1_BOOKED_OPERATION_OWNER_TENANT_KEY: TENANT_KEY,
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
  reservation_id: reservationId,
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
const SYNTHETIC_PHONE = ["+7", "999", "000", "11", "22"].join(" ");
const providerProfile = () => ({ id: PROVIDER_CLIENT_ID, phone: SYNTHETIC_PHONE });
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

const gatewayConfirmed = () => ({ ok: true, state: "CONFIRMED", operationId,
  exerciseId: PROVIDER_EXERCISE_ID, clientSubscriptionId: CLIENT_SUBSCRIPTION_ID, bookingId: "viva-booking-0001" });
const gatewayRow = () => ({ ...gatewayConfirmed(), tenantKey: TENANT_KEY, actorClientId: PROVIDER_CLIENT_ID,
  confirmedAt: new Date().toISOString(), activationState: "NOT_REQUIRED" });

test("one canonical owner POST follows the durable marker; complete binding receipt is persisted", () => {
  const driven = driveToProviderPost();
  const post = driven.postRequest[0];
  assert.equal(driven.profileRequest[0].headers.Authorization, `Bearer ${ACTOR_TOKEN}`);
  assert.equal(driven.markerRequest[1].payload[1].$set.state, "ATTEMPTING");
  assert.equal(driven.markerRequest[0], null);
  assert.equal(post.url, "http://127.0.0.1:1880/lk/subscription-bookings");
  assert.equal(post.headers["Idempotency-Key"], operationId);
  assert.equal(post.headers.Authorization, `Bearer ${ACTOR_TOKEN}`);
  assert.deepEqual(post.payload, { operationId, exerciseId: PROVIDER_EXERCISE_ID,
    clientSubscriptionId: CLIENT_SUBSCRIPTION_ID });
  driven.execMsg.statusCode = 200;
  driven.execMsg.payload = gatewayConfirmed();
  const finalize = driven.step();
  const update = finalize[2].payload[1];
  assert.equal(update.$set.state, "CONFIRMED");
  assert.equal(update.$push.receipts.reservationId, reservationId);
  assert.equal(update.$push.receipts.providerClientId, PROVIDER_CLIENT_ID);
  assert.equal(update.$push.receipts.providerClientSubscriptionId, CLIENT_SUBSCRIPTION_ID);
  assert.equal(update.$push.receipts.targetMappingId, targetMappingId);
  assert.equal(update.$push.receipts.source, "LK1_SUBSCRIPTION_BOOKING_OWNER");
  assert.equal(JSON.stringify(finalize[2].payload).includes(ACTOR_TOKEN), false);
  assert.equal(JSON.stringify(finalize[2].payload).includes("phone"), false);
  driven.execMsg.payload = mongoAck();
  const response = driven.step();
  assert.equal(response[3].payload.status, "CONFIRMED");
  assert.equal(JSON.stringify(response).includes(ACTOR_TOKEN), false);
  assert.equal(driven.providerCalls.filter((call) => call.method === "POST").length, 1);
  const persisted = applyUpdate(applyUpdate(driven.document, driven.markerRequest[1].payload[1]), update);
  const repeat = runFunction("router", { _bookedOperation: { ...driven.findContext, step: "find" }, payload: [persisted] }, executionEnv);
  assert.equal(repeat[3], null);
  assert.equal(readOutcome(persisted)[1].payload.status, "CONFIRMED");
});

for (const reply of [
  { error: { message: "timeout" } }, { statusCode: 502 }, { statusCode: 409 },
  { statusCode: 200, payload: { ...gatewayConfirmed(), exerciseId: "another-exercise" } },
  { statusCode: 200, payload: { ...gatewayConfirmed(), clientSubscriptionId: "another-product" } },
  { statusCode: 200, payload: { ...gatewayConfirmed(), operationId: crypto.randomUUID() } },
  { statusCode: 200, payload: { ok: true, state: "PENDING_CONFIRMATION" } },
]) {
  test(`ambiguous/mismatched canonical reply remains UNKNOWN (${JSON.stringify(reply)})`, () => {
    const driven = driveToProviderPost();
    delete driven.execMsg.statusCode;
    Object.assign(driven.execMsg, reply);
    const update = driven.step()[2].payload[1];
    assert.equal(update.$set.state, "UNKNOWN");
    assert.equal("receipts" in update.$push, false);
    const persisted = applyUpdate(driven.document, update);
    const repeat = runFunction("router", { _bookedOperation: { ...driven.findContext, step: "find" }, payload: [persisted] }, executionEnv);
    assert.equal(repeat[3], null);
    assert.equal(driven.providerCalls.filter((call) => call.method === "POST").length, 1);
  });
}

const receiptRead = (stored, rows, claimOverrides = {}) => {
  const verify = runFunction("read_verify", readMessage(sign({ ...readClaims(), receipt_version: 1, ...claimOverrides })), baseEnv);
  assert.equal(verify[1], null);
  const find = runFunction("router", { _bookedOperation: verify[0]._bookedOperation, payload: [stored] }, baseEnv);
  assert.ok(find[2], "receipt lookup must be read-only Mongo FIND");
  assert.equal(find[0], null); assert.equal(find[3], null);
  assert.deepEqual(find[2].payload, { operationId, tenantKey: TENANT_KEY,
    actorClientId: PROVIDER_CLIENT_ID, exerciseId: PROVIDER_EXERCISE_ID,
    clientSubscriptionId: CLIENT_SUBSCRIPTION_ID, state: "CONFIRMED" });
  find[2].payload = rows;
  const result = runFunction("router", find[2], baseEnv);
  assert.equal(result[0], null); assert.equal(result[2], null); assert.equal(result[3], null);
  return result[1];
};

test("read-only receipt recovery after outer timeout/crash accepts only the complete canonical result", () => {
  const driven = driveToAttemptMarker();
  const stored = applyUpdate(driven.document, driven.markerRequest[1].payload[1]);
  const result = receiptRead(stored, [gatewayRow()]);
  assert.equal(result.payload.status, "CONFIRMED");
  assert.equal(result.payload.receipt.reservationId, reservationId);
  assert.equal(result.payload.receipt.providerExerciseId, PROVIDER_EXERCISE_ID);
  assert.equal(JSON.stringify(result).includes(ACTOR_TOKEN), false);
  // Legacy signed reads keep the exact original five-field contract.
  assert.deepEqual(Object.keys(readOutcome(stored)[1].payload).sort(),
    ["asOf", "contractVersion", "operationId", "reason", "status"]);
  for (const rows of [[], [gatewayRow(), gatewayRow()],
    ...["operationId", "tenantKey", "actorClientId", "exerciseId", "clientSubscriptionId", "state", "bookingId", "confirmedAt", "activationState"]
      .map((key) => [{ ...gatewayRow(), [key]: key === "bookingId" ? "" : "wrong" }]),
    [{ ...gatewayRow(), managedEntitlementOperationId: "entitlement-1", managedEntitlementState: "RESERVED" }]]) {
    const rejected = receiptRead(stored, rows);
    assert.equal(rejected.payload.status, "UNKNOWN");
    assert.equal(rejected.payload.receipt, undefined);
  }
});

test("token expiry after dispatch does not strand a confirmed canonical result", () => {
  const driven = driveToProviderPost();
  driven.execMsg._bookedOperation.execution.actorTokenExpiresAt = new Date(Date.now()-1000).toISOString();
  driven.execMsg.statusCode = 200; driven.execMsg.payload = gatewayConfirmed();
  assert.equal(driven.step()[2].payload[1].$set.state, "CONFIRMED");
});

test("reservation and local canonical owner configuration are required before dispatch", () => {
  const missing = dispatchAdmission(executionEnv, (body) => ({ ...boundClaims(body), reservation_id: undefined }));
  assert.equal(missing.executorMessage, null);
  for (const override of [{ LK1_BOOKED_OPERATION_OWNER_BASE_URL: "http://attacker.invalid:1880" },
    { LK1_BOOKED_OPERATION_OWNER_BASE_URL: "http://127.0.0.1:1880" + "@" + "attacker.invalid" },
    { LK1_BOOKED_OPERATION_OWNER_TENANT_KEY: "foreign-tenant" }]) {
    const driven = startExecution({ ...executionEnv, ...override });
    assert.equal(driven.step()[3].statusCode, 503);
    assert.equal(driven.providerCalls.length, 0);
  }
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
  foreignProfile.execMsg.payload = { id: "another-viva-client", phone: SYNTHETIC_PHONE };
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

test("canonical owner retains subscription rechecks, atomic claim and separate admin credential", () => {
  const router = fs.readFileSync(path.join(ROOT, "nodered_subscription_booking_nodes/fn_subscription_booking_router.js"), "utf8");
  const executor = receiverFunctionSource("executor");
  assert.match(executor, /\/lk\/subscription-bookings/);
  assert.doesNotMatch(executor.slice(executor.indexOf('const EXEC_OUTPUT_HTTP')), /\/api\/v2\/exercises/);
  assert.match(router, /exercise_recheck/);
  assert.match(router, /findOwnedSubscriptions/);
  assert.match(router, /vivacrm_access_token/);
  assert.match(router, /operation_preaccept/);
});
