const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESULT_INPUT_OVERRIDE_START_TS = Date.parse("2026-05-31T00:00:00+03:00");
const RESULT_INPUT_OVERRIDE_END_TS = Date.parse("2026-06-10T23:59:59.999+03:00");

const buildResultSignature = (ctx) => JSON.stringify({
  scoreA: ctx.scoreA,
  scoreB: ctx.scoreB,
  sets: asArray(ctx.scoringSets || ctx.sets),
  setPairings: asArray(ctx.setPairings),
});

const resolveResultDisputeDeadlineTs = (submittedAtTs, game) => {
  const gameDate = String(game?.booking?.date || game?.date || "").trim();
  if (gameDate) {
    const gameDateTs = Date.parse(`${gameDate}T00:00:00+03:00`);
    if (
      Number.isFinite(gameDateTs)
      && gameDateTs >= RESULT_INPUT_OVERRIDE_START_TS
      && gameDateTs <= RESULT_INPUT_OVERRIDE_END_TS
    ) {
      return RESULT_INPUT_OVERRIDE_END_TS;
    }
  }

  return Number.isFinite(submittedAtTs) && submittedAtTs > 0
    ? submittedAtTs + DISPUTE_WINDOW_MS
    : null;
};

const sanitizeRatingMember = (value) => {
  if (!value || typeof value !== "object") return null;
  const memberKey = toStr(value.memberKey);
  const id = toStr(value.id);
  const phoneNorm = toStr(value.phoneNorm);
  if (!memberKey || (!id && !phoneNorm)) return null;
  return {
    memberKey,
    id,
    phoneNorm,
    name: toStr(value.name) || "Игрок",
    bucket: toStr(value.bucket || value.source) || null,
  };
};

const buildInternalRatingFacts = (ctx) => {
  const sets = asArray(ctx.scoringSets || ctx.sets).map((item) => ({
    left: Number(item?.left || 0),
    right: Number(item?.right || 0),
  }));
  const resolvedPairings = asArray(ctx.resolvedSetPairings).length > 0
    ? asArray(ctx.resolvedSetPairings)
    : sets.map((_, setIndex) => ({
      setIndex,
      teamA: asArray(ctx.teams?.teamA),
      teamB: asArray(ctx.teams?.teamB),
    }));
  const effectiveSetPairings = resolvedPairings.map((pairing, index) => ({
    setIndex: Number.isInteger(Number(pairing?.setIndex)) ? Number(pairing.setIndex) : index,
    teamA: asArray(pairing?.teamA).map(sanitizeRatingMember).filter(Boolean),
    teamB: asArray(pairing?.teamB).map(sanitizeRatingMember).filter(Boolean),
  }));
  const params = ctx?.game?.params && typeof ctx.game.params === "object"
    ? ctx.game.params
    : {};

  return {
    version: "game-result-rating-facts-v1",
    algorithm: "game-rating-v1",
    sets,
    effectiveSetPairings,
    params: {
      K: Number.isFinite(Number(params.K)) ? Number(params.K) : 0.3,
      D: Number.isFinite(Number(params.D)) ? Number(params.D) : 3,
      B: Number.isFinite(Number(params.B)) ? Number(params.B) : 0.3,
      minRating: Number.isFinite(Number(params.minRating)) ? Number(params.minRating) : 1,
      maxRating: Number.isFinite(Number(params.maxRating)) ? Number(params.maxRating) : 7,
      round: Number.isFinite(Number(params.round)) ? Number(params.round) : 5,
    },
  };
};

const rows = asArray(msg._resultExistingRows || msg.payload);
const ctx = msg._resultSubmit || {};
const latest = rows
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => Number(right?.submittedAtTs || right?.createdTs || 0) - Number(left?.submittedAtTs || left?.createdTs || 0))[0] || null;
const latestStatus = String(latest?.status || "").toUpperCase();
const latestCorrectionDeadlineTs = Number(latest?.correctionContext?.expiresAtTs || 0);
const latestExpiredCorrection = latestStatus === "CORRECTION_PENDING"
  && Number.isFinite(latestCorrectionDeadlineTs)
  && latestCorrectionDeadlineTs > 0
  && latestCorrectionDeadlineTs <= Date.now();
const latestActive = latest && ["PENDING_REVIEW", "CORRECTION_PENDING"].includes(latestStatus) && !latestExpiredCorrection;
const incomingSignature = buildResultSignature(ctx);
const latestSamePayload = Boolean(latest?.resultSignature && latest.resultSignature === incomingSignature);
const correctionActor = ctx.actorMember || ctx.actor || {};
const correctionActorMatchesAuthor = Boolean(
  toStr(correctionActor?.id)
    && toStr(latest?.submittedBy?.id || latest?.submittedBy?.clientId)
    && toStr(correctionActor.id) === toStr(latest.submittedBy.id || latest.submittedBy.clientId)
) || Boolean(
  toStr(correctionActor?.memberKey)
    && toStr(latest?.submittedBy?.memberKey)
    && toStr(correctionActor.memberKey) === toStr(latest.submittedBy.memberKey)
) || Boolean(
  toStr(correctionActor?.phoneNorm)
    && toStr(latest?.submittedBy?.phoneNorm)
    && toStr(correctionActor.phoneNorm) === toStr(latest.submittedBy.phoneNorm)
);
const isCorrectionSubmission = latestStatus === "CORRECTION_PENDING"
  && !latestExpiredCorrection
  && !latestSamePayload;

if (latestActive && !isCorrectionSubmission) {
  const projectionApplied = ctx.game?.resultId === latest.id
    && String(ctx.game?.resultLifecycleState || "").toUpperCase() === latestStatus;
  if (latestSamePayload && !projectionApplied) {
    msg.statusCode = 409;
    msg.headers = { "Content-Type": "application/json; charset=utf-8" };
    msg.payload = {
      error: "Result is durable but its legacy game projection is incomplete. Reconcile before retrying.",
      code: "LEGACY_GAME_PROJECTION_INCOMPLETE",
      retryable: false,
      recoveryRequired: true,
      gameId: ctx.gameId || ctx.game?.id || null,
      resultId: latest.id || null,
    };
    return [null, msg, msg, null, null, null];
  }
  msg.statusCode = latestSamePayload ? 200 : 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = latestSamePayload
    ? Object.assign({}, latest, { idempotent: true })
    : { error: "Active result review already exists", pendingResult: latest };
  return [null, msg, msg, null, null, null];
}

if (isCorrectionSubmission && !correctionActorMatchesAuthor) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only the original result author can submit a correction" };
  return [null, msg, msg, null, null, null];
}

if (latestStatus === "CONFIRMED") {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result already confirmed", result: latest };
  return [null, msg, msg, null, null, null];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const disputeDeadlineTs = resolveResultDisputeDeadlineTs(nowTs, ctx.game);
const disputeDeadlineAt = disputeDeadlineTs ? new Date(disputeDeadlineTs).toISOString() : null;
const submitter = ctx.actorMember || { memberKey: null, id: null, name: "Игрок", phoneNorm: ctx.phone || null };
const tenantKey = toStr(ctx.game?.tenantKey);
const contextTenantKey = toStr(ctx.tenantKey || ctx.game?.tenantKey);
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey) || tenantKey !== contextTenantKey) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result tenant context is invalid", code: "LEGACY_GAME_TENANT_CONFLICT" };
  return [null, msg, msg, null, null, null];
}
const idempotencyKey = toStr(ctx.idempotencyKey);
if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(idempotencyKey)) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result idempotency identity is invalid", code: "RESULT_IDEMPOTENCY_KEY_INVALID" };
  return [null, msg, msg, null, null, null];
}
const resultId = `res_v1_${tenantKey.length}_${tenantKey}_${idempotencyKey}`;
const ratingEventId = `rate_${resultId}`;
const previousScoreRevision = Number.isInteger(Number(latest?.scoreRevision)) && Number(latest.scoreRevision) > 0
  ? Number(latest.scoreRevision)
  : 1;
const scoreRevision = isCorrectionSubmission ? previousScoreRevision + 1 : 1;
const lineageRootResultId = isCorrectionSubmission
  ? (toStr(latest?.lineageRootResultId) || toStr(latest?.id) || resultId)
  : resultId;
const supersedesResultId = isCorrectionSubmission ? toStr(latest?.id) : null;
const ratingFacts = buildInternalRatingFacts(ctx);
const publicSetPairings = asArray(ctx.setPairings);
const ratingEvent = ctx.ratingEnabled === false
  ? null
  : {
    id: ratingEventId,
    gameId: ctx.gameId,
    resultId,
    ratingEnabled: true,
    status: "PENDING_CONFIRMATION",
    pendingAt: nowIso,
    pendingAtTs: nowTs,
    appliedAt: null,
    appliedAtTs: null,
    finalizedAt: null,
    revertedAt: null,
    formula: null,
    ratingImpact: [],
    ratingFactsVersion: ratingFacts.version,
  };
const ratingWork = {
  schemaVersion: 1,
  executionMode: "ACTIVE",
  jobKey: `game-result:${resultId}:score:${scoreRevision}:apply`,
  generation: 1,
  desiredState: "APPLIED",
  status: ctx.ratingEnabled === false ? "SKIPPED" : "QUEUED",
  applySemantics: isCorrectionSubmission ? "CORRECTION_TIME" : "INITIAL_APPLY",
  attempts: 0,
  queuedAt: nowIso,
  queuedAtTs: nowTs,
  nextAttemptAt: nowIso,
  nextAttemptAtTs: nowTs,
  leaseOwner: null,
  leaseUntil: null,
  leaseUntilTs: null,
  preparedPlan: null,
  appliedGeneration: null,
  appliedEventIds: [],
  lastError: null,
};

const doc = {
  _id: resultId,
  id: resultId,
  idempotencyKey,
  gameId: ctx.gameId,
  tenantKey,
  vivaExerciseId: ctx.game?.booking?.vivaExerciseId || null,
  resultModelVersion: 2,
  scoreRevision,
  lineageRootResultId,
  supersedesResultId,
  effectiveState: "EFFECTIVE",
  review: {
    state: "OPEN",
    openedAt: nowIso,
    openedAtTs: nowTs,
    deadlineAt: disputeDeadlineAt,
    deadlineAtTs: disputeDeadlineTs,
  },
  ratingWork,
  revision: 1,
  status: "PENDING_REVIEW",
  lifecycleState: "PENDING_REVIEW",
  resultPayload: {
    sets: asArray(ctx.scoringSets || ctx.sets),
    setPairings: publicSetPairings,
    attachments: asArray(ctx.attachments),
    sessionId: ctx.sessionId || null,
    sessionRevision: Number.isInteger(Number(ctx.sessionRevision)) ? Number(ctx.sessionRevision) : null,
    intermediateResults: [],
  },
  resultSignature: incomingSignature,
  score: { teamA: ctx.scoreA, teamB: ctx.scoreB },
  sets: asArray(ctx.scoringSets || ctx.sets),
  setPairings: publicSetPairings,
  effectiveSetPairings: publicSetPairings,
  intermediateResults: [],
  sourceSessionId: ctx.sessionId || null,
  sourceSessionRevision: Number.isInteger(Number(ctx.sessionRevision)) ? Number(ctx.sessionRevision) : null,
  resultRosterSnapshot: ctx.resultRosterSnapshot && typeof ctx.resultRosterSnapshot === "object" ? ctx.resultRosterSnapshot : null,
  rosterSnapshot: ctx.publicRosterSnapshot && typeof ctx.publicRosterSnapshot === "object" ? ctx.publicRosterSnapshot : null,
  ratingFacts,
  teams: ctx.teams,
  submittedBy: {
    memberKey: submitter.memberKey || null,
    id: submitter.id || null,
    name: submitter.name || "Игрок",
    phoneNorm: submitter.phoneNorm || null,
  },
  submittedByTeam: ctx.submitterTeam || null,
  submittedAt: nowIso,
  submittedAtTs: nowTs,
  disputeDeadlineAt,
  disputeDeadlineTs,
  ratingEnabled: ctx.ratingEnabled !== false,
  confirmedBy: null,
  confirmedAt: null,
  confirmedAtTs: null,
  disputedBy: null,
  disputedAt: null,
  disputedAtTs: null,
  correctionContext: null,
  ratingFormula: null,
  ratingImpact: [],
  ratingEvent,
  vivaSync: null,
  createdAt: nowIso,
  createdTs: nowTs,
  updatedAt: nowIso,
  deleted: false,
};

msg._resultSubmitDoc = doc;
const resultMsg = Object.assign({}, msg, {
  payload: [
    { _id: resultId, tenantKey, id: resultId },
    { $setOnInsert: doc },
    { upsert: true },
  ],
});
return [resultMsg, null, msg, null, null, null];
