import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  NODE_IDS,
  buildReceiverCandidate,
  receiverFunctionSource,
} from "../patch_nodered_booked_operation_receiver_flow.mjs";

// Local synthetic RSA key material only: nothing here is a deployed secret.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { privateKey: otherPrivateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ISSUER = "https://lk2.example.test/issuer";
const AUDIENCE = "lk1-booked-operation";
const KEY_ID = "lk2-booked-op-test";
const ADMIT_PATH = "/lk/integrations/v1/booked-operation-admissions";
const READ_PREFIX = "/lk/integrations/v1/booked-operations/";
const ADMIT_SCOPE = "subscription-runtime.booked-operation.admit";
const READ_SCOPE = "subscription-runtime.booked-operation.read";
const DELEGATION_TYPE = "phub-subscription-runtime-actor-delegation+jwt";

const baseEnv = {
  LK1_BOOKED_OPERATION_RECEIVER_ENABLED: "true",
  LK2_BOOKED_OPERATION_DELEGATION_ISSUER: ISSUER,
  LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: AUDIENCE,
  LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: KEY_ID,
  LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: publicKey,
};

const envOf = (overrides = {}) => ({
  get: (key) => (key in overrides ? overrides[key] : (baseEnv[key] ?? null)),
});
const runFunction = (name, msg, envValues = {}) => new Function(
  "msg",
  "env",
  "nodeCrypto",
  receiverFunctionSource(name),
)(msg, envOf(envValues), crypto);

const b64url = (value) => Buffer.from(value).toString("base64url");
const sha256Hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const sign = (payload, key = privateKey, headerOverrides = {}) => {
  const header = b64url(JSON.stringify({
    alg: "RS256",
    typ: DELEGATION_TYPE,
    kid: KEY_ID,
    ...headerOverrides,
  }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${b64url(signature)}`;
};

const tenantId = crypto.randomUUID();
const userId = crypto.randomUUID();
const operationId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const providerMappingId = crypto.randomUUID();
const targetMappingId = crypto.randomUUID();
const targetId = crypto.randomUUID();
const correlationId = "booked-op-correlation-0001";

const admissionBody = (overrides = {}) => {
  const { target = {}, ...rest } = overrides;
  return {
    action: "JOIN_GAME",
    paymentIntent: "USE_SUBSCRIPTION",
    target: { id: targetId, expectedRevision: 7, ...target },
    ...rest,
  };
};
const requestSha = (body) => "sha256:" + sha256Hex(
  "booked-operation-admission:v1\0" + JSON.stringify({
    action: "JOIN_GAME",
    target: { id: body.target.id, expectedRevision: body.target.expectedRevision },
    paymentIntent: "USE_SUBSCRIPTION",
  }),
);
const now = () => Math.floor(Date.now() / 1000);
const admissionClaims = (body, overrides = {}) => ({
  contract_version: 1,
  scope: ADMIT_SCOPE,
  caller: "lk2-api",
  method: "POST",
  path: ADMIT_PATH,
  operation_id: operationId,
  tenant_id: tenantId,
  tenant_key: "iSkq6G",
  sid: sessionId,
  provider: "VIVA",
  provider_client_id: "viva-client-1",
  provider_mapping_id: providerMappingId,
  correlation_id: correlationId,
  request_sha256: requestSha(body),
  idempotency_key_sha256: "sha256:" + sha256Hex("idempotency-key-0001"),
  target_id: body.target.id,
  expected_revision: body.target.expectedRevision,
  target_mapping_id: targetMappingId,
  provider_exercise_id: "viva-exercise-1",
  target_version: "1",
  target_starts_at: "2026-10-25T09:00:00.000Z",
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
const readClaims = (overrides = {}) => ({
  contract_version: 1,
  scope: READ_SCOPE,
  caller: "lk2-api",
  method: "GET",
  path: READ_PREFIX + operationId,
  operation_id: operationId,
  tenant_id: tenantId,
  tenant_key: "iSkq6G",
  sid: sessionId,
  provider: "VIVA",
  provider_client_id: "viva-client-1",
  provider_mapping_id: providerMappingId,
  correlation_id: correlationId,
  iss: ISSUER,
  aud: AUDIENCE,
  sub: userId,
  iat: now() - 1,
  nbf: now() - 1,
  exp: now() + 30,
  jti: crypto.randomUUID(),
  ...overrides,
});
const admissionMessage = (token, body = admissionBody(), headers = {}) => ({
  req: {
    url: "/lk/integrations/v1/booked-operation-admissions",
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
const readMessage = (token, pathOperationId = operationId, headers = {}) => ({
  req: {
    url: `/lk/integrations/v1/booked-operations/${operationId}`,
    method: "GET",
    params: { operationId: pathOperationId },
    headers: {
      "x-subscription-actor-delegation": token,
      "x-correlation-id": correlationId,
      ...headers,
    },
    query: {},
  },
  payload: undefined,
});
const admittedMessage = () => {
  const body = admissionBody();
  const result = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body)), body),
  );
  assert.equal(result[1], null, JSON.stringify(result[1]));
  return result[0];
};
const storedDocument = (overrides = {}) => {
  const admitted = admittedMessage();
  return { ...admitted._bookedOperation.document, ...overrides };
};
const readContext = (document) => ({
  _bookedOperation: {
    mode: "read",
    step: "find",
    operationId,
    bindingSha256: "sha256:" + sha256Hex("read-binding"),
    identity: {
      tenantId,
      userId,
      providerClientId: "viva-client-1",
      providerMappingId,
    },
  },
  payload: [document],
});
const admitContext = (document) => {
  const admitted = admittedMessage();
  return {
    _bookedOperation: { ...admitted._bookedOperation, step: "find" },
    payload: [document],
  };
};
const exactOutcomeKeys = "asOf,contractVersion,operationId,reason,status";

test("valid admission verifies and produces only a Mongo lookup", () => {
  const body = admissionBody();
  const result = runFunction("admission_verify", admissionMessage(sign(admissionClaims(body)), body));
  const request = result[0];
  assert.ok(request, "verified admission must be forwarded");
  assert.equal(result[1], null);
  assert.deepEqual(request.payload, { _id: operationId });
  assert.equal(request.req.headers["x-subscription-actor-delegation"], undefined);
  const context = request._bookedOperation;
  assert.equal(context.mode, "admit");
  assert.equal(context.step, "find");
  assert.equal(context.operationId, operationId);
  assert.match(context.bindingSha256, /^sha256:[a-f0-9]{64}$/);
  const document = context.document;
  assert.equal(document._id, operationId);
  assert.equal(document.kind, "BOOKED_OPERATION_ADMISSION");
  assert.equal(document.state, "PENDING");
  assert.equal(document.tenantId, tenantId);
  assert.equal(document.userId, userId);
  assert.equal(document.providerMappingId, providerMappingId);
  assert.equal(document.requestSha256, requestSha(body));
  assert.equal(document.attempts.length, 1);
  assert.equal(document.attempts[0].kind, "ADMISSION_ACCEPTED");
  assert.deepEqual(document.receipts, []);
  assert.equal(document.padlHubOperation.operationId, operationId);
  assert.equal(document.padlHubOperation.providerMappingId, providerMappingId);
  assert.equal(document.padlHubOperation.caller, "lk2-api");
  assert.equal(JSON.stringify(document).includes("Bearer"), false);
  assert.equal(JSON.stringify(document).includes("authorization"), false);
  // Without the LK2 token contract the adapter is disabled: no provider path.
  assert.equal(request._bookedOperation.execution.enabled, false);
  assert.equal(request._bookedOperation.execution.blockedReason, "EXECUTION_FLAG_OFF");
  assert.equal(request._bookedOperation.execution.actorToken, null);
  assert.equal(request._bookedOperation.execution.actorTokenSha256, null);
});

test("delegation signature and header matrix fails closed with stable codes", () => {
  const body = admissionBody();
  const token = sign(admissionClaims(body));

  const badSignature = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body), otherPrivateKey)),
  );
  assert.equal(badSignature[0], null);
  assert.equal(badSignature[1].statusCode, 401);
  assert.equal(badSignature[1].payload.code, "BOOKED_OPERATION_DELEGATION_INVALID");

  const wrongKid = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body), privateKey, { kid: "another-key" })),
  );
  assert.equal(wrongKid[1].statusCode, 401);

  const wrongAlgorithmHeader = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body), privateKey, { alg: "PS256" })),
  );
  assert.equal(wrongAlgorithmHeader[1].statusCode, 401);

  const tamperedPayload = (() => {
    const parts = token.split(".");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    claims.target_capacity = 99;
    return `${parts[0]}.${b64url(JSON.stringify(claims))}.${parts[2]}`;
  })();
  const tampered = runFunction(
    "admission_verify",
    admissionMessage(tamperedPayload, body),
  );
  assert.equal(tampered[1].statusCode, 401);

  const missing = runFunction("admission_verify", admissionMessage(undefined, body));
  assert.equal(missing[1].statusCode, 401);
  assert.equal(missing[1].payload.code, "BOOKED_OPERATION_DELEGATION_REQUIRED");

  const disabled = runFunction(
    "admission_verify",
    admissionMessage(token, body),
    { LK1_BOOKED_OPERATION_RECEIVER_ENABLED: "false" },
  );
  assert.equal(disabled[1].statusCode, 503);
  assert.equal(disabled[1].payload.code, "BOOKED_OPERATION_RECEIVER_UNAVAILABLE");

  const missingKey = runFunction(
    "admission_verify",
    admissionMessage(token, body),
    { LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: "" },
  );
  assert.equal(missingKey[1].statusCode, 503);
});

test("wrong scope, method, path, issuer, audience and caller are rejected", () => {
  const body = admissionBody();
  const tokenFor = (overrides) => admissionMessage(sign(admissionClaims(body, overrides)));
  const cases = [
    ["read scope on POST", { scope: READ_SCOPE }, 403],
    ["wrong method", { method: "GET" }, 403],
    ["wrong path", { path: READ_PREFIX + operationId }, 403],
    ["wrong caller", { caller: "foreign-service" }, 403],
    ["wrong issuer", { iss: "https://elsewhere.example.test" }, 401],
    ["wrong audience", { aud: "other-audience" }, 401],
    ["wrong contract version", { contract_version: 2 }, 401],
    ["wrong provider", { provider: "OTHER" }, 401],
  ];
  for (const [label, overrides, statusCode] of cases) {
    const result = runFunction("admission_verify", tokenFor(overrides));
    assert.equal(result[0], null, label);
    assert.equal(result[1].statusCode, statusCode, label);
  }
});

test("expired, not-yet-valid and unbounded delegations are rejected", () => {
  const body = admissionBody();
  const expired = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body, { iat: now() - 120, nbf: now() - 120, exp: now() - 60 }))),
  );
  assert.equal(expired[1].statusCode, 401);

  const future = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body, { iat: now() + 120, nbf: now() + 120, exp: now() + 180 }))),
  );
  assert.equal(future[1].statusCode, 401);

  const unbounded = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(body, { exp: now() + 3600 }))),
  );
  assert.equal(unbounded[1].statusCode, 401);
});

test("replayed body, correlation and target binding mismatches are rejected", () => {
  const signedBody = admissionBody();
  const token = sign(admissionClaims(signedBody));

  const otherBody = admissionBody({ target: { expectedRevision: 8 } });
  const replayedBody = runFunction("admission_verify", admissionMessage(token, otherBody));
  assert.equal(replayedBody[1].statusCode, 403);
  assert.equal(replayedBody[1].payload.code, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");

  const replayedCorrelation = runFunction(
    "admission_verify",
    admissionMessage(token, signedBody, { "x-correlation-id": "booked-op-correlation-9999" }),
  );
  assert.equal(replayedCorrelation[1].statusCode, 403);
  assert.equal(replayedCorrelation[1].payload.code, "BOOKED_OPERATION_DELEGATION_CONTEXT_MISMATCH");

  const extraActorField = admissionBody();
  extraActorField.actorClientId = "victim";
  const forgedActor = runFunction(
    "admission_verify",
    admissionMessage(sign(admissionClaims(extraActorField)), extraActorField),
  );
  assert.equal(forgedActor[1].statusCode, 400);
  assert.equal(forgedActor[1].payload.code, "BOOKED_OPERATION_REQUEST_INVALID");

  const queryString = runFunction(
    "admission_verify",
    (() => {
      const message = admissionMessage(token, signedBody);
      message.req.query = { actor: "victim" };
      return message;
    })(),
  );
  assert.equal(queryString[1].statusCode, 400);
});

test("read delegation verifies without any write and rejects admission tokens", () => {
  const valid = runFunction("read_verify", readMessage(sign(readClaims())));
  assert.equal(valid[1], null);
  assert.deepEqual(valid[0].payload, { _id: operationId });
  assert.equal(valid[0]._bookedOperation.mode, "read");
  assert.equal(valid[0].req.headers["x-subscription-actor-delegation"], undefined);

  // Cross-mode tokens have a different exact claim set and are rejected first.
  const admitTokenOnRead = runFunction("read_verify", readMessage(sign(admissionClaims(admissionBody()))));
  assert.equal(admitTokenOnRead[0], null);
  assert.equal(admitTokenOnRead[1].statusCode, 401);
  assert.equal(admitTokenOnRead[1].payload.code, "BOOKED_OPERATION_DELEGATION_INVALID");

  const pathMismatch = runFunction(
    "read_verify",
    readMessage(sign(readClaims()), crypto.randomUUID()),
  );
  assert.equal(pathMismatch[1].statusCode, 403);
  assert.equal(pathMismatch[1].payload.code, "BOOKED_OPERATION_DELEGATION_CONTEXT_MISMATCH");

  const readTokenOnAdmission = runFunction(
    "admission_verify",
    admissionMessage(sign(readClaims()), admissionBody()),
  );
  assert.equal(readTokenOnAdmission[1].statusCode, 401);
  assert.equal(readTokenOnAdmission[1].payload.code, "BOOKED_OPERATION_DELEGATION_INVALID");
});

test("first admission writes exactly one PENDING document with setOnInsert", () => {
  const admitted = admittedMessage();
  const result = runFunction("router", {
    _bookedOperation: admitted._bookedOperation,
    payload: [],
  });
  const write = result[0];
  assert.ok(write, "empty store must start exactly one guarded write");
  assert.equal(result[1], null);
  assert.equal(result[2], null);
  assert.equal(result[3], null, "execution is disabled by default: no dispatch");
  const [query, update, options] = write.payload;
  assert.deepEqual(query, { _id: operationId });
  assert.deepEqual(options, { upsert: true });
  assert.equal(update.$setOnInsert.state, "PENDING");
  assert.equal(update.$setOnInsert.kind, "BOOKED_OPERATION_ADMISSION");
  assert.equal(update.$setOnInsert.delegationBindingSha256, admitted._bookedOperation.bindingSha256);
  assert.equal(update.$setOnInsert.providerClientSubscriptionId, null);
  assert.equal(update.$setOnInsert.attempts[0].executionEnabled, false);
  assert.equal("$set" in update, false);
  assert.equal(write._bookedOperation.step, "write");
});

test("repeat admission returns the stored state and never a second attempt", () => {
  const document = storedDocument();
  const result = runFunction("router", admitContext(document));
  assert.equal(result[0], null, "repeat must not write again");
  assert.equal(result[2], null);
  assert.equal(result[3], null, "repeat must not dispatch a second attempt");
  assert.equal(result[1].statusCode, 202);
  assert.equal(Object.keys(result[1].payload).sort().join(","), exactOutcomeKeys);
  assert.deepEqual(result[1].payload, {
    asOf: document.updatedAt,
    contractVersion: 1,
    operationId,
    reason: "OWNER_PENDING",
    status: "PENDING",
  });
});

test("changed actor/provider/request binding is a 409 conflict", () => {
  const document = storedDocument({ delegationBindingSha256: "sha256:" + sha256Hex("other-binding") });
  const result = runFunction("router", admitContext(document));
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 409);
  assert.equal(result[1].payload.code, "BOOKED_OPERATION_BINDING_CONFLICT");

  const foreign = storedDocument({ providerMappingId: crypto.randomUUID() });
  const foreignResult = runFunction("router", admitContext(foreign));
  assert.equal(foreignResult[1].statusCode, 409);
});

test("ambiguous or failed writes never report success", () => {
  const admitted = admittedMessage();
  const writeContext = { ...admitted._bookedOperation, step: "write" };
  const ambiguous = runFunction("router", { _bookedOperation: writeContext, error: { code: 1 } });
  assert.equal(ambiguous[1].statusCode, 503);
  assert.equal(ambiguous[1].payload.code, "BOOKED_OPERATION_STORE_UNAVAILABLE");

  const malformedAck = runFunction("router", {
    _bookedOperation: writeContext,
    payload: { acknowledged: true, upsertedCount: 1, upsertedId: crypto.randomUUID() },
  });
  assert.equal(malformedAck[1].statusCode, 503);

  const lostAckAck = runFunction("router", {
    _bookedOperation: writeContext,
    payload: { acknowledged: true, matchedCount: 1, upsertedCount: 0, upsertedId: null },
  });
  assert.equal(lostAckAck[0], null);
  assert.equal(lostAckAck[2]._bookedOperation.step, "readback");
  assert.deepEqual(lostAckAck[2].payload, { _id: operationId });

  const created = runFunction("router", {
    _bookedOperation: writeContext,
    payload: { acknowledged: true, matchedCount: 0, upsertedCount: 1, upsertedId: operationId },
  });
  assert.equal(created[1].statusCode, 202);
  assert.equal(created[1].payload.status, "PENDING");
  assert.equal(created[1].payload.reason, "OWNER_PENDING");

  const readbackMissing = runFunction("router", {
    _bookedOperation: { ...writeContext, step: "readback" },
    payload: [],
  });
  assert.equal(readbackMissing[1].statusCode, 503);

  const storeFailure = runFunction("router", {
    _bookedOperation: { ...admitted._bookedOperation, step: "find" },
    payload: null,
  });
  assert.equal(storeFailure[1].statusCode, 503);
});

test("read maps durable states to the strict outcome and hides foreign operations", () => {
  const pending = storedDocument();
  const pendingRead = runFunction("router", readContext(pending));
  assert.equal(pendingRead[1].statusCode, 200);
  assert.deepEqual(pendingRead[1].payload, {
    asOf: pending.updatedAt,
    contractVersion: 1,
    operationId,
    reason: "OWNER_PENDING",
    status: "PENDING",
  });
  assert.equal(pendingRead[0], null);
  assert.equal(pendingRead[2], null);

  const confirmedAt = "2026-10-21T12:00:00.000Z";
  const confirmed = runFunction(
    "router",
    readContext(storedDocument({ state: "CONFIRMED", stateReason: "OWNER_BOOKING_CONFIRMED", updatedAt: confirmedAt })),
  );
  assert.deepEqual(confirmed[1].payload, {
    asOf: confirmedAt,
    contractVersion: 1,
    operationId,
    reason: "OWNER_BOOKING_CONFIRMED",
    status: "CONFIRMED",
  });

  const unknown = runFunction("router", readContext(storedDocument({ state: "UNKNOWN", updatedAt: "not-a-date" })));
  assert.deepEqual(unknown[1].payload, {
    asOf: null,
    contractVersion: 1,
    operationId,
    reason: "RECONCILIATION_REQUIRED",
    status: "UNKNOWN",
  });

  const rejectedDocument = storedDocument({
    rejectionCode: "PROVIDER_BOOKING_REJECTED",
    state: "REJECTED",
  });
  const rejected = runFunction("router", readContext(rejectedDocument));
  assert.equal(rejected[1].statusCode, 409);
  assert.deepEqual(rejected[1].payload, {
    asOf: rejectedDocument.updatedAt,
    code: "BOOKED_OPERATION_REJECTED",
    contractVersion: 1,
    error: "BOOKED_OPERATION_REJECTED",
    operationId,
    rejectionCode: "PROVIDER_BOOKING_REJECTED",
  });

  const missing = runFunction("router", {
    _bookedOperation: readContext(storedDocument())._bookedOperation,
    payload: [],
  });
  assert.equal(missing[1].statusCode, 404);

  const foreign = runFunction(
    "router",
    readContext(storedDocument({ userId: crypto.randomUUID() })),
  );
  assert.equal(foreign[1].statusCode, 404);

  const changedMapping = runFunction(
    "router",
    readContext(storedDocument({ providerMappingId: crypto.randomUUID() })),
  );
  assert.equal(changedMapping[1].statusCode, 404);
});

test("response guard scrubs context and enforces fail-closed JSON", () => {
  const guarded = runFunction("response", {
    statusCode: 202,
    headers: { "X-Test": "1" },
    payload: { contractVersion: 1 },
    _bookedOperation: { operationId },
    req: { headers: { "x-subscription-actor-delegation": "token" } },
  });
  assert.equal(guarded[0]._bookedOperation, undefined);
  assert.equal(guarded[0].req.headers["x-subscription-actor-delegation"], undefined);
  assert.equal(guarded[0].headers["Cache-Control"], "no-store");
  assert.equal(guarded[0].statusCode, 202);

  const fault = runFunction("response", { payload: undefined, _bookedOperation: { operationId } });
  assert.equal(fault[0].statusCode, 503);
  assert.equal(fault[0].payload.code, "BOOKED_OPERATION_RESPONSE_INVALID");
});

test("candidate adds one isolated receiver tab and a gated execution adapter", () => {
  const source = [
    { id: "tab-games", type: "tab", label: "LK Games" },
    { id: "mongo-client", type: "mongodb4-client", name: "games" },
    {
      id: "daily-op-find",
      type: "mongodb4",
      z: "tab-games",
      collection: "lk_subscription_daily_booking_ops",
      operation: "find",
      clientNode: "mongo-client",
      wires: [[]],
    },
  ];
  const { candidate, report } = buildReceiverCandidate(source);
  const added = candidate.slice(source.length);
  const addedByType = new Set(added.map((node) => node.type));
  assert.equal(addedByType.has("exec"), false);
  assert.deepEqual(
    [...addedByType].sort(),
    ["catch", "comment", "function", "http in", "http request", "http response", "mongodb4", "tab"],
  );
  assert.equal(report.mode, "FAIL_CLOSED_EXECUTION_ADAPTER");
  assert.equal(report.executionEnabledByDefault, false);
  assert.equal(report.executionFlag, "BOOKED_OPERATION_EXECUTION_ENABLED");
  assert.equal(report.providerCallsWhenExecutionDisabled, 0);
  assert.equal(report.invariants.addedProviderWriteNodeCount, 1);
  assert.equal(report.invariants.addedExecutorNodeCount, 1);
  assert.equal(report.invariants.brokenWireCount, 0);
  assert.equal(report.invariants.addedHttpInRouteCount, 5);
  assert.equal(
    report.addedNodeIds.includes(NODE_IDS.admissionVerify),
    true,
  );
  const verifyNodes = added.filter((node) => (
    node.id === NODE_IDS.admissionVerify || node.id === NODE_IDS.readVerify
  ));
  assert.equal(verifyNodes.length, 2);
  for (const node of verifyNodes) {
    assert.deepEqual(node.libs, [{ var: "nodeCrypto", module: "crypto" }]);
    assert.match(node.func, /nodeCrypto\.verify/);
    assert.match(node.func, /bookedOperationVerifyDelegation/);
  }
  const providerRequests = added.filter((node) => node.type === "http request" && node.id !== NODE_IDS.preflightRequest);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].method, "use");
  assert.equal(providerRequests[0].senderr, true);
  assert.deepEqual(providerRequests[0].wires, [[NODE_IDS.executor]]);
  for (const node of added.filter((item) => item.type === "function")) {
    if (node.id === NODE_IDS.preflightRouter) continue;
    if (node.id === NODE_IDS.executor) {
      assert.match(node.func, /BOOKED_OPERATION_EXECUTION_ENABLED/);
      assert.match(node.func, /\/lk\/subscription-bookings/);
      assert.equal(node.outputs, 5);
      continue;
    }
    assert.doesNotMatch(node.func, /vivacrm|api\.viva/i);
  }
  const routerNode = added.find((node) => node.id === NODE_IDS.router);
  assert.equal(routerNode.outputs, 4);
  assert.deepEqual(routerNode.wires[3], [NODE_IDS.executor]);
});

test("v1 signed requests cannot cross into v2 admission or read routes", () => {
  const admission = admissionMessage(sign(admissionClaims(admissionBody())));
  admission.req.url = "/lk/integrations/v2/booked-operation-admissions";
  const rejectedAdmission = runFunction("admission_verify", admission);
  assert.equal(rejectedAdmission[0], null);
  assert.equal(rejectedAdmission[1].payload.code, "BOOKED_OPERATION_DELEGATION_SCOPE_INVALID");
  const read = readMessage(sign(readClaims()));
  read.req.url = `/lk/integrations/v2/booked-operations/${operationId}`;
  const rejectedRead = runFunction("read_verify", read);
  assert.equal(rejectedRead[0], null);
  assert.equal(rejectedRead[1].payload.code, "BOOKED_OPERATION_DELEGATION_SCOPE_INVALID");
});
