// Disabled-by-default execution adapter for the LK2 booked-operation receiver.
//
// This node verifies the Viva profile and delegates once to the local canonical owner. It runs
// only when the router forwards an admission whose durable state is PENDING, the
// delegation carried the user-scoped token binding
// (`actor_token_sha256` + `X-Subscription-Actor-Token`), and the activation flag
// `BOOKED_OPERATION_EXECUTION_ENABLED` is on. Otherwise no message ever reaches
// the provider request node.
//
// Durable state machine on the SAME operation document (`_id = operationId`,
// kind BOOKED_OPERATION_ADMISSION):
//   PENDING -> ATTEMPTING  (CAS marker written BEFORE the canonical-owner POST)
//           -> CONFIRMED | UNKNOWN | REJECTED
//   CONFIRMED / REJECTED are terminal. v1 UNKNOWN never retries. A signed v2
//   recovery-only replay may lease an existing ATTEMPTING/UNKNOWN row and ask the
//   canonical owner for existing-operation reconciliation, never a new booking.
// The attempt marker is the single dispatch gate: a repeat or racing admission
// that lost the CAS is reconciled by a durable readback and never sends a second
// canonical-owner POST. Every confirmation is derived from the canonical owner result, never assumed.
//
// Secrets: the actor token lives only in `msg._bookedOperation.execution`, is
// sent as a Bearer header, is scrubbed before every response and is never
// written to Mongo, receipts or attempts (only its sha256 binding is recorded).

const EXEC_OUTPUT_HTTP = 0;
const EXEC_OUTPUT_ATTEMPT = 1;
const EXEC_OUTPUT_FINALIZE = 2;
const EXEC_OUTPUT_RESPOND = 3;
const EXEC_OUTPUT_FIND = 4;
const EXEC_ATTEMPT_PREFIX = "booked-operation-attempt:v1\0";
const EXEC_STEPS = [
  "execute",
  "owner_contract",
  "profile",
  "attempt_claim",
  "booking_create",
  "finalize",
];

const execOutput = (index, value = msg) => {
  const outputs = [null, null, null, null, null];
  outputs[index] = value;
  return outputs;
};
const execResponseHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});
const execOutcome = (state, asOf) => {
  if (stored.contractVersion === 2 && state === "CONFIRMED") state = "UNKNOWN";
  if (state === "CONFIRMED") {
    return {
      asOf: asOf || null,
      contractVersion: stored.contractVersion,
      operationId,
      reason: "OWNER_BOOKING_CONFIRMED",
      status: "CONFIRMED",
    };
  }
  if (state === "UNKNOWN") {
    return {
      asOf: asOf || null,
      contractVersion: stored.contractVersion,
      operationId,
      reason: "RECONCILIATION_REQUIRED",
      status: "UNKNOWN",
    };
  }
  return {
    asOf: asOf || null,
    contractVersion: stored.contractVersion,
    operationId,
    reason: "OWNER_PENDING",
    status: "PENDING",
  };
};
const execRejectionPayload = (rejectionCode, asOf) => ({
  asOf: asOf || null,
  code: "BOOKED_OPERATION_REJECTED",
  contractVersion: stored.contractVersion,
  error: "BOOKED_OPERATION_REJECTED",
  operationId,
  rejectionCode: bookedOperationVivaToText(rejectionCode) || "PROVIDER_BOOKING_REJECTED",
});
// A direct response always rebuilds msg.headers, so a provider response header
// set (or a request Authorization header kept by a failed transport) cannot leak
// into the HTTP reply.
const execRespond = (statusCode, payload) => {
  msg.statusCode = statusCode;
  msg.headers = execResponseHeaders();
  msg.payload = payload;
  delete msg._bookedOperation;
  delete msg.method;
  delete msg.url;
  delete msg.requestTimeout;
  delete msg.followRedirects;
  delete msg.maxRedirects;
  delete msg.responseUrl;
  delete msg.error;
  return execOutput(EXEC_OUTPUT_RESPOND);
};
const execReject = (statusCode, code) => execRespond(statusCode, { error: code, code });
const execPending = (asOf) => execRespond(202, execOutcome("PENDING", asOf));
const execScrubRequest = () => {
  delete msg.method;
  delete msg.url;
  delete msg.headers;
  delete msg.requestTimeout;
  delete msg.followRedirects;
  delete msg.maxRedirects;
  delete msg.statusCode;
  delete msg.responseUrl;
  delete msg.error;
};

const execContext = bookedOperationVivaIsObject(msg._bookedOperation)
  ? msg._bookedOperation
  : null;
if (
  !execContext
  || execContext.mode !== "admit"
  || !EXEC_STEPS.includes(execContext.step)
  || !bookedOperationVivaIsObject(execContext.execution)
  || !bookedOperationVivaIsObject(execContext.stored)
) {
  return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
}
const operationId = bookedOperationVivaToText(execContext.operationId);
const execution = execContext.execution;
const stored = execContext.stored;
if (stored.contractVersion === 2 && (!managedJoinV2Request(stored.managedJoinV2)
  || typeof nodeCrypto === "undefined" || typeof nodeCrypto.createHash !== "function"
  || stored.requestSha256 !== "sha256:" + nodeCrypto.createHash("sha256")
    .update("booked-operation-admission:v2\0" + JSON.stringify(managedJoinV2Request(stored.managedJoinV2))).digest("hex"))) {
  return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
}
if (
  !operationId
  || !BOOKED_OP_VIVA_ID.test(operationId)
  || execution.enabled !== true
  || stored.kind !== "BOOKED_OPERATION_ADMISSION"
  || ![1, 2].includes(stored.contractVersion)
  || stored.operationId !== operationId
  || (execution.recoveryOnly === true
    ? stored.contractVersion !== 2 || execution.recoveryOnlyRequested !== true || !["ATTEMPTING", "UNKNOWN"].includes(stored.state)
    : stored.state !== "PENDING")
  || (execution.recoveryOnly !== true && stored.targetAdmissible !== true)
  || !BOOKED_OP_VIVA_ID.test(bookedOperationVivaToText(stored.providerExerciseId) || "")
  || !BOOKED_OP_VIVA_ID.test(bookedOperationVivaToText(stored.providerClientId) || "")
  || !BOOKED_OP_VIVA_ID.test(bookedOperationVivaToText(stored.providerClientSubscriptionId) || "")
  || !BOOKED_OP_VIVA_ID.test(bookedOperationVivaToText(stored.tenantKey) || "")
  || !bookedOperationVivaIsCanonicalIso(bookedOperationVivaToText(stored.targetStartsAt))
) {
  return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
}
if (execContext.step !== "execute" && !bookedOperationVivaIsObject(execution.config)) {
  return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
}
const actorToken = bookedOperationVivaToText(execution.actorToken);
const actorTokenSha256 = bookedOperationVivaToText(execution.actorTokenSha256);
if (
  !actorToken
  || !BOOKED_OP_VIVA_TOKEN.test(actorToken)
  || !BOOKED_OP_VIVA_SHA256.test(actorTokenSha256 || "")
) {
  return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
}
// Re-check the delegation binding in this node too: the token is only usable when
// its own sha256 is the claim the signed delegation carried.
if (`sha256:${bookedOperationVivaSha256Hex(actorToken)}` !== actorTokenSha256) {
  return execReject(403, "BOOKED_OPERATION_ACTOR_TOKEN_MISMATCH");
}
const actorTokenExpiresAt = bookedOperationVivaToText(execution.actorTokenExpiresAt);
if (["execute", "owner_contract", "profile"].includes(execContext.step)
  && actorTokenExpiresAt && !(Date.parse(actorTokenExpiresAt) > Date.now())) {
  // Pre-dispatch: nothing was written and nothing may be released; a fresh
  // delegation can be retried for the same operation id.
  return execReject(403, "BOOKED_OPERATION_ACTOR_TOKEN_EXPIRED");
}
const attemptId = `sha256:${bookedOperationVivaSha256Hex(
  EXEC_ATTEMPT_PREFIX + operationId + "\0"
  + (bookedOperationVivaToText(stored.idempotencyKeySha256) || ""),
)}`;
const asOfStored = bookedOperationVivaIsCanonicalIso(
  bookedOperationVivaToText(stored.updatedAt),
) ? stored.updatedAt : null;
execution.attemptId = attemptId;

const execProviderRequest = (method, url, payload, nextStep) => {
  if (!url || !bookedOperationVivaToText(execution.config?.apiBase)) {
    return null;
  }
  execContext.step = nextStep;
  msg._bookedOperation = execContext;
  execScrubRequest();
  msg.method = method;
  msg.url = url;
  msg.headers = {
    Authorization: `Bearer ${actorToken}`,
    Accept: "application/json",
    ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
  };
  msg.payload = payload;
  msg.requestTimeout = execution.config.timeoutMs;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  return execOutput(EXEC_OUTPUT_HTTP);
};

// The only writer of terminal state. It runs after the dispatch marker exists, so
// a failed final write leaves ATTEMPTING (an honest uncertainty) and the caller
// gets UNKNOWN rather than a fabricated CONFIRMED/REJECTED.
const execFinalize = (state, details = {}) => {
  const at = new Date().toISOString();
  const attempt = { at, attemptId: execution.recoveryOnly === true ? execution.recoveryAttemptId : attemptId, kind: "PROVIDER_UNKNOWN" };
  if (state === "CONFIRMED") attempt.kind = "CONFIRMED_READBACK";
  if (state === "REJECTED") attempt.kind = "PROVIDER_REJECTED";
  if (details.statusCode) attempt.statusCode = Number(details.statusCode);
  if (details.reason) attempt.reason = details.reason;
  if (details.rejectionCode) attempt.rejectionCode = details.rejectionCode;
  if (details.bookingId) attempt.bookingId = details.bookingId;
  const set = {
    state,
    stateReason: state === "CONFIRMED"
      ? "OWNER_BOOKING_CONFIRMED"
      : (state === "REJECTED" ? "OWNER_BOOKING_REJECTED" : "RECONCILIATION_REQUIRED"),
    updatedAt: at,
  };
  let receipt = null;
  if (state === "CONFIRMED") {
    set.bookingId = details.bookingId;
    set.confirmedAt = at;
    receipt = stored.contractVersion === 2 ? null : bookedOperationOwnerReceipt(stored, details.bookingId, at);
  }
  if (state === "REJECTED") {
    set.rejectedAt = at;
    set.rejectionCode = details.rejectionCode || "PROVIDER_BOOKING_REJECTED";
  }
  if (state === "UNKNOWN") {
    set.unknownAt = at;
    set.unknownReason = details.reason || "PROVIDER_RESULT_UNKNOWN";
  }
  execution.finalState = {
    asOf: at,
    bookingId: details.bookingId || null,
    rejectionCode: set.rejectionCode || null,
    state,
  };
  execContext.step = "finalize";
  msg._bookedOperation = execContext;
  execScrubRequest();
  const update = { $set: set, $push: { attempts: attempt },
    ...(execution.recoveryOnly === true ? { $unset: { "recovery.leaseUntil": "" } } : {}) };
  if (receipt) update.$push.receipts = receipt;
  msg.payload = [
    {
      _id: operationId,
      kind: "BOOKED_OPERATION_ADMISSION",
      ...(execution.recoveryOnly === true ? {
        state: stored.state, "recovery.attemptId": execution.recoveryAttemptId,
        delegationBindingSha256: stored.delegationBindingSha256,
      } : { state: "ATTEMPTING", "attempt.attemptId": attemptId }),
    },
    update,
    {},
  ];
  return execOutput(EXEC_OUTPUT_FINALIZE);
};

if (execContext.step === "execute") {
  const loaded = bookedOperationVivaReadExecutionConfig(env);
  if (!loaded.ok) {
    // Flag off between verification and dispatch, or an unusable endpoint
    // configuration: no provider call and no durable state change.
    if (loaded.code === "BOOKED_OPERATION_EXECUTION_DISABLED") {
      return execPending(asOfStored);
    }
    return execReject(503, "BOOKED_OPERATION_EXECUTION_UNAVAILABLE");
  }
  if (stored.tenantKey !== loaded.config.ownerTenantKey || !stored.reservationId) {
    return execReject(503, "BOOKED_OPERATION_EXECUTION_UNAVAILABLE");
  }
  execution.config = loaded.config;
  execContext.step = "owner_contract";
  execScrubRequest();
  msg.method = "GET";
  msg.url = loaded.config.ownerBase + "/lk/subscription-bookings";
  msg.headers = { "X-Booked-Operation-Owner-Contract": stored.contractVersion === 2 ? "2" : "1", Accept: "application/json" };
  msg.payload = undefined;
  msg.requestTimeout = loaded.config.timeoutMs;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  return execOutput(EXEC_OUTPUT_HTTP);
}

if (execContext.step === "owner_contract") {
  const body = msg.payload;
  const contentType = bookedOperationVivaToText(msg.headers?.["content-type"] || msg.headers?.["Content-Type"]);
  if (!contentType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)
    || msg.error || Number(msg.statusCode) !== 200 || !bookedOperationVivaIsObject(body)
    || Object.keys(body).sort().join(",") !== "contractVersion,owner,policy"
    || body.contractVersion !== stored.contractVersion || body.owner !== "LK1_SUBSCRIPTION_BOOKING_OWNER"
    || body.policy !== (stored.contractVersion === 2 ? "MANAGED_JOIN_V2" : "ATOMIC_MANAGED_V1")
    || (stored.contractVersion === 2 && msg.responseUrl !== execution.config.ownerBase + "/lk/subscription-bookings")) {
    return execReject(503, "BOOKED_OPERATION_OWNER_CONTRACT_UNAVAILABLE");
  }
  const profileUrl = bookedOperationVivaExpandPath(
    execution.config.apiBase + execution.config.profilePath,
    { tenant_key: stored.tenantKey },
  );
  if (!profileUrl) return execReject(503, "BOOKED_OPERATION_EXECUTION_UNAVAILABLE");
  return execProviderRequest("GET", profileUrl, undefined, "profile");
}

if (execContext.step === "profile") {
  const statusCode = Number(msg.statusCode) || null;
  if (msg.error || !statusCode) return execPending(asOfStored);
  if (statusCode >= 500 || statusCode === 408) return execPending(asOfStored);
  if (statusCode >= 400) {
    // The user-scoped credential itself was refused. Nothing has been written, so
    // no terminal state is persisted; the same operation id may be retried with a
    // fresh delegation.
    return execReject(
      statusCode === 401 || statusCode === 403 ? 403 : 502,
      statusCode === 401 || statusCode === 403
        ? "BOOKED_OPERATION_ACTOR_TOKEN_REJECTED"
        : "BOOKED_OPERATION_ACTOR_PROFILE_UNAVAILABLE",
    );
  }
  if (!bookedOperationVivaIsHttpOk(statusCode)) {
    // A redirect (followRedirects is off) is not a usable profile: keep the
    // operation PENDING and never write from an unexpected reply.
    return execReject(502, "BOOKED_OPERATION_ACTOR_PROFILE_UNAVAILABLE");
  }
  const profile = bookedOperationVivaUnwrapRecord(msg.payload);
  const profileClientId = bookedOperationVivaToText(profile?.id || profile?.clientId);
  const profilePhone = bookedOperationVivaNormalizePhone(
    profile?.phone || profile?.phoneNumber || profile?.mobile,
  );
  if (
    !profileClientId
    || bookedOperationVivaNormalizeId(profileClientId)
      !== bookedOperationVivaNormalizeId(stored.providerClientId)
  ) {
    return execReject(403, "BOOKED_OPERATION_ACTOR_PROFILE_IDENTITY_MISMATCH");
  }
  if (!profilePhone) {
    return execReject(502, "BOOKED_OPERATION_ACTOR_PROFILE_INCOMPLETE");
  }
  execution.actorClientId = profileClientId;
  execution.actorPhone = profilePhone;
  // Durable dispatch marker BEFORE the canonical-owner POST: exactly one racing/repeat
  // admission can claim PENDING -> ATTEMPTING, and the provider write happens
  // only after that claim is acknowledged.
  execContext.step = "attempt_claim";
  msg._bookedOperation = execContext;
  execScrubRequest();
  const markerAt = new Date().toISOString();
  if (execution.recoveryOnly === true) {
    execution.recoveryAttemptId = nodeCrypto.randomUUID();
    msg.payload = [
      { _id: operationId, kind: "BOOKED_OPERATION_ADMISSION", state: stored.state,
        delegationBindingSha256: stored.delegationBindingSha256, managedJoinV2: stored.managedJoinV2,
        $or: [{ "recovery.leaseUntil": { $exists: false } }, { "recovery.leaseUntil": { $lte: markerAt } }] },
      { $set: { recovery: { attemptId: execution.recoveryAttemptId, startedAt: markerAt,
        leaseUntil: new Date(Date.parse(markerAt) + 120000).toISOString() } } }, {},
    ];
    return execOutput(EXEC_OUTPUT_ATTEMPT);
  }
  msg.payload = [
    { _id: operationId, kind: "BOOKED_OPERATION_ADMISSION", state: "PENDING" },
    {
      $set: {
        attempt: { actorTokenSha256, attemptId, startedAt: markerAt },
        state: "ATTEMPTING",
        stateReason: "DISPATCH_ATTEMPTING",
        updatedAt: markerAt,
      },
      $push: {
        attempts: {
          at: markerAt,
          attemptId,
          correlationId: bookedOperationVivaToText(stored.delegation?.correlationId),
          kind: "DISPATCH_ATTEMPTING",
        },
      },
    },
    {},
  ];
  return execOutput(EXEC_OUTPUT_ATTEMPT);
}

if (execContext.step === "attempt_claim") {
  if (msg.error) return execReject(503, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  const claimed = bookedOperationVivaMongoUpdateAck(msg.payload, "MATCHED");
  if (!claimed) {
    const beaten = bookedOperationVivaMongoUpdateAck(msg.payload, "NONE");
    if (!beaten) return execReject(503, "BOOKED_OPERATION_STORE_UNAVAILABLE");
    // A concurrent or repeated admission already owns the attempt (or the
    // operation reached a terminal state): reconcile by durable readback only.
    execContext.executionSuppressed = true;
    execContext.step = "readback";
    msg._bookedOperation = execContext;
    execScrubRequest();
    msg.payload = { _id: operationId };
    return execOutput(EXEC_OUTPUT_FIND);
  }
  // The marker is now durable. Only this single loopback POST may dispatch the
  // canonical owner; neither a timeout nor a replay can send another purchase.
  execContext.step = "booking_create";
  execScrubRequest();
  msg.method = "POST";
  msg.url = execution.config.ownerBase + "/lk/subscription-bookings";
  msg.headers = {
    Authorization: `Bearer ${actorToken}`,
    "Idempotency-Key": operationId,
    "X-Correlation-ID": stored.delegation.correlationId,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  msg.payload = {
    operationId,
    exerciseId: stored.providerExerciseId,
    clientSubscriptionId: stored.providerClientSubscriptionId,
    ...(stored.contractVersion === 2 ? { managedJoinV2: stored.managedJoinV2,
      ...(execution.recoveryOnly === true ? { managedJoinV2RecoveryOnly: true } : {}) } : { lk2LegacyJoin: true }),
  };
  msg.requestTimeout = execution.config.timeoutMs;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  return execOutput(EXEC_OUTPUT_HTTP);
}

if (execContext.step === "booking_create") {
  const statusCode = Number(msg.statusCode) || null;
  const body = msg.payload;
  // A gateway error may follow a provider side effect. Preserve uncertainty on
  // every refusal/error; read-only reconciliation can consume its durable receipt.
  if (msg.error || !bookedOperationVivaIsHttpOk(statusCode)
    || !bookedOperationVivaIsObject(body)
    || body.ok !== true || body.state !== "CONFIRMED"
    || body.operationId !== operationId
    || body.exerciseId !== stored.providerExerciseId
    || body.clientSubscriptionId !== stored.providerClientSubscriptionId
    || !BOOKED_OP_VIVA_ID.test(bookedOperationVivaToText(body.bookingId) || "")) {
    return execFinalize("UNKNOWN", { reason: "CANONICAL_OWNER_RECONCILIATION_REQUIRED" });
  }
  return execFinalize("CONFIRMED", { bookingId: body.bookingId });
}

if (execContext.step === "finalize") {
  const finalState = bookedOperationVivaIsObject(execution.finalState)
    ? execution.finalState
    : { state: "UNKNOWN" };
  const confirmed = msg.error
    ? null
    : bookedOperationVivaMongoUpdateAck(msg.payload, "MATCHED");
  if (!confirmed) {
    // The provider write already happened; an unpersisted terminal state must
    // never be reported as terminal.
    return execRespond(202, execOutcome("UNKNOWN", null));
  }
  if (finalState.state === "CONFIRMED") {
    return execRespond(200, execOutcome("CONFIRMED", finalState.asOf));
  }
  if (finalState.state === "REJECTED") {
    return execRespond(409, execRejectionPayload(finalState.rejectionCode, finalState.asOf));
  }
  return execRespond(202, execOutcome("UNKNOWN", finalState.asOf));
}

return execReject(503, "BOOKED_OPERATION_EXECUTION_CONTEXT_INVALID");
