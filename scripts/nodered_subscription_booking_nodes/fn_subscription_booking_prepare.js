// Training capability traverses this actual prepare node, then router and finalizer.
if (msg._trainingRegistrationCapability !== undefined) {
  const accepted = msg._trainingRegistrationCapability.version === 1 && msg._trainingRegistrationCapability.stage === "prepare"
    && msg.req?.method === "GET" && (msg.req.originalUrl || msg.req.url) === "/lk/subscription-bookings"
    && msg.req.headers?.["x-training-registration-owner-contract"] === "1"
    && msg.req.headers?.["x-booked-operation-owner-contract"] === undefined
    && (!msg.req.query || Object.keys(msg.req.query).length === 0);
  if (accepted) {
    msg._trainingRegistrationCapability.stage = "router";
    msg._subscriptionBooking = { step: "booked_operation_contract_probe" };
    return [null, null, msg];
  }
  delete msg._trainingRegistrationCapability;
  msg.statusCode = 404; msg.headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  msg.payload = { code: "TRAINING_REGISTRATION_OWNER_UNAVAILABLE" };
  return [null, msg];
}
// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (msg.req?.body?.trainingRegistration || msg._subscriptionBooking?.trainingRegistration || msg.payload?.trainingRegistration) return;
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "booking_prepare", { sourceHash: "a64d3a44995e7cbe12b37f0e2d3c28ea34efbf5ce3079694911ef10800dc4e25", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const VIVA_API_BASE = "https://api.vivacrm.ru";
// Exact managed JOIN wire parser shared by the receiver's verifier, read and executor.
// This parser never supplies missing authority or mints an entitlement/usage reference.
const managedJoinV2Object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const managedJoinV2Keys = (value, keys) => managedJoinV2Object(value)
  && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
const managedJoinV2Id = value => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value) && !/[\r\n]/.test(value);
const managedJoinV2Positive = value => Number.isSafeInteger(value) && value > 0;
const managedJoinV2Digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) && value.length === 71;
const managedJoinV2Entitlement = value => {
  if (!managedJoinV2Keys(value, "subscriptionInstanceId,expectations") || !managedJoinV2Id(value.subscriptionInstanceId)) return null;
  const e = value.expectations;
  if (!managedJoinV2Keys(e, "schemaVersion,policyVersion,policyDigest,targetSnapshot") || e.schemaVersion !== 1
    || !managedJoinV2Positive(e.policyVersion) || !managedJoinV2Digest(e.policyDigest)
    || !managedJoinV2Keys(e.targetSnapshot, "snapshotId,revision,evidenceRef")
    || !managedJoinV2Id(e.targetSnapshot.snapshotId) || !managedJoinV2Positive(e.targetSnapshot.revision)
    || !managedJoinV2Id(e.targetSnapshot.evidenceRef)) return null;
  return { subscriptionInstanceId: value.subscriptionInstanceId, expectations: {
    schemaVersion: 1, policyVersion: e.policyVersion, policyDigest: e.policyDigest,
    targetSnapshot: { snapshotId: e.targetSnapshot.snapshotId, revision: e.targetSnapshot.revision,
      evidenceRef: e.targetSnapshot.evidenceRef }
  } };
};
const managedJoinV2Request = (value, preflight = false) => {
  if (!managedJoinV2Keys(value, preflight ? "contractVersion,action,target,paymentIntent"
    : "contractVersion,action,target,paymentIntent,entitlement") || value.contractVersion !== 2
    || value.action !== "JOIN_GAME" || value.paymentIntent !== "USE_SUBSCRIPTION"
    || !managedJoinV2Keys(value.target, "id,expectedRevision")
    || typeof value.target.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.target.id)
    || !managedJoinV2Positive(value.target.expectedRevision)) return null;
  const entitlement = preflight ? null : managedJoinV2Entitlement(value.entitlement);
  if (!preflight && !entitlement) return null;
  return { contractVersion: 2, action: "JOIN_GAME",
    target: { id: value.target.id, expectedRevision: value.target.expectedRevision },
    paymentIntent: "USE_SUBSCRIPTION", ...(preflight ? {} : { entitlement }) };
};

const TENANT_KEY = "iSkq6G";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const requestHeader = (name) => {
  const headers = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  return toStr(headers[String(name).toLowerCase()] || headers[name]);
};

const finish = (statusCode, error, details) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { error, details: details || null };
  return [null, msg];
};

const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : {};
const authHeader = requestHeader("authorization");
const operationId = requestHeader("idempotency-key")
  || toStr(msg.req?.query?.operationId)
  || toStr(body.operationId);
const action = toStr(body.action)?.toLowerCase() || "book";
const releaseBookingId = toStr(body.bookingId);
const exerciseId = toStr(body.exerciseId);
const clientSubscriptionId = toStr(body.clientSubscriptionId);
const spotNumber = Number(body.spot);
const trainingRegistration = body.trainingRegistration;
if (trainingRegistration !== undefined) {
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) && value.length === 36;
  if (!managedJoinV2Keys(trainingRegistration, "schemaVersion,admissionId,requestSha256,preparationSha256,attemptId,recoveryOnly")
    || trainingRegistration.schemaVersion !== 1 || !uuid(trainingRegistration.admissionId) || !uuid(trainingRegistration.attemptId)
    || !managedJoinV2Digest(trainingRegistration.requestSha256) || !managedJoinV2Digest(trainingRegistration.preparationSha256)
    || typeof trainingRegistration.recoveryOnly !== "boolean" || action !== "book" || body.operationId !== operationId
    || trainingRegistration.admissionId !== operationId
    || Object.keys(body).sort().join(",") !== "clientSubscriptionId,exerciseId,operationId,trainingRegistration") {
    return finish(400, "Некорректная привязка тренировки", { code: "TRAINING_REGISTRATION_INVALID" });
  }
}
const managedSelfLeave = body.managedSelfLeave;
if (managedSelfLeave !== undefined) {
  const fields = "actorClientId,bookingId,bookingOperationId,bookingOperationKey,clientSubscriptionId,entitlementOperationId,exerciseId,gameId,leaveClaimToken,leaveOperationId,leaveOperationKey,membershipVersion,schemaVersion,serviceDate,subscriptionInstanceId,tenantKey";
  if (!managedJoinV2Keys(managedSelfLeave, fields) || managedSelfLeave.schemaVersion !== 1
    || Object.entries(managedSelfLeave).some(([key, value]) => key !== "schemaVersion"
      && (typeof value !== "string" || value.length < 1 || value.length > 500 || /[\s\x00-\x1f\x7f]/.test(value)))
    || managedSelfLeave.tenantKey !== TENANT_KEY
    || !/^\d{4}-\d{2}-\d{2}$/.test(managedSelfLeave.serviceDate)
    || managedSelfLeave.leaveOperationKey !== `${managedSelfLeave.gameId}:${managedSelfLeave.leaveOperationId}`
    || action !== "release" || body.bookingId !== managedSelfLeave.bookingId
    || operationId !== managedSelfLeave.leaveOperationId
    || Object.keys(body).sort().join(",") !== "action,bookingId,managedSelfLeave,operationId") {
    return finish(400, "Некорректная привязка возврата посещения", { code: "MANAGED_SELF_LEAVE_INVALID" });
  }
}
const recoveryOnly = body.managedJoinV2RecoveryOnly === true;
if (body.managedJoinV2RecoveryOnly !== undefined && (!recoveryOnly || body.managedJoinV2 === undefined))
  return finish(400, "Некорректное восстановление JOIN", { code: "MANAGED_JOIN_V2_INVALID" });
const managedJoinV2 = body.managedJoinV2 === undefined ? undefined : managedJoinV2Request(body.managedJoinV2);
if (body.lk2LegacyJoin !== undefined && (body.lk2LegacyJoin !== true || body.managedJoinV2 !== undefined
  || action !== "book" || Object.keys(body).sort().join(",") !== "clientSubscriptionId,exerciseId,lk2LegacyJoin,operationId"
  || body.operationId !== operationId)) return finish(400, "Некорректная привязка legacy JOIN", { code: "LK2_LEGACY_JOIN_INVALID" });
if (body.managedJoinV2 !== undefined && (!managedJoinV2 || action !== "book"
  || Object.keys(body).sort().join(",") !== (recoveryOnly ? "clientSubscriptionId,exerciseId,managedJoinV2,managedJoinV2RecoveryOnly,operationId" : "clientSubscriptionId,exerciseId,managedJoinV2,operationId")
  || body.operationId !== operationId)) {
  return finish(400, "Некорректная привязка управляемой записи", { code: "MANAGED_JOIN_V2_INVALID" });
}


if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
  return finish(401, "Требуется авторизация Viva", { code: "SUBSCRIPTION_BOOKING_AUTH_REQUIRED" });
}
if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
  return finish(400, "Требуется корректный operationId", { code: "SUBSCRIPTION_BOOKING_OPERATION_ID_REQUIRED" });
}
if (!['book', 'release'].includes(action)) {
  return finish(400, "Неизвестное действие с дневным посещением", {
    code: "SUBSCRIPTION_BOOKING_ACTION_UNSUPPORTED",
  });
}
if (action === "release" && !releaseBookingId) {
  return finish(400, "bookingId обязателен для освобождения дневного посещения", {
    code: "SUBSCRIPTION_BOOKING_RELEASE_BOOKING_ID_REQUIRED",
  });
}
if (action === "book" && (!exerciseId || !clientSubscriptionId)) {
  return finish(400, "exerciseId и clientSubscriptionId обязательны", {
    code: "SUBSCRIPTION_BOOKING_TARGET_REQUIRED",
  });
}

msg._subscriptionBooking = {
  caller: "http",
  ...(trainingRegistration === undefined ? {} : { trainingRegistration: JSON.parse(JSON.stringify(trainingRegistration)) }),
  ...(managedJoinV2 ? { managedJoinV2, managedAction: "JOIN_GAME", ...(recoveryOnly ? { managedJoinV2RecoveryOnly: true } : {}) } : {}),
  ...(body.lk2LegacyJoin === true ? { lk2LegacyJoin: true } : {}),
  action,
  ...(managedSelfLeave === undefined ? {} : { managedSelfLeave: JSON.parse(JSON.stringify(managedSelfLeave)) }),
  step: "profile",
  tenantKey: TENANT_KEY,
  operationId,
  authHeader,
  releaseBookingId,
  exerciseId: action === "book" ? exerciseId : null,
  clientSubscriptionId: action === "book" ? clientSubscriptionId : null,
  spot: Number.isFinite(spotNumber) && spotNumber > 0 ? Math.floor(spotNumber) : null,
  startedAt: new Date().toISOString(),
};
msg.method = "GET";
msg.url = `${VIVA_API_BASE}/end-user/api/v1/${TENANT_KEY}/profile`;
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;
msg.requestTimeout = 10000;
msg.followRedirects = false;
msg.maxRedirects = 0;
return [msg, null];
