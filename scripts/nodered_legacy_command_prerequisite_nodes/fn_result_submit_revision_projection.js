const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? raw?.payload?.upsertedCount ?? 0);
const upsertedId = raw?.upsertedId ?? raw?.result?.upsertedId ?? raw?.payload?.upsertedId ?? null;
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error) || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const persisted = acknowledged && !hasMongoError
  && (matchedCount > 0 || modifiedCount > 0 || upsertedCount > 0 || Boolean(upsertedId));
const doc = isObject(msg._resultSubmitDoc) ? msg._resultSubmitDoc : null;

if (!persisted || !doc) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result was not saved. Retry with the same submission id.",
      code: "RESULT_PERSISTENCE_FAILED",
      retryable: true,
      gameId: doc?.gameId || msg?._resultSubmit?.gameId || null,
      resultId: doc?.id || null,
    },
  });
  return [null, null, null, errorMsg, errorMsg];
}

const sourceGame = isObject(msg._resultSubmit?.game) ? msg._resultSubmit.game : null;
const tenantKey = String(sourceGame?.tenantKey || "").trim();
const gameId = String(sourceGame?.id || doc.gameId || "").trim();
const sourceRevision = sourceGame?.revision;
if (!tenantKey || !gameId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result was saved but the legacy game projection requires migration before it can be updated.",
      code: "LEGACY_GAME_REVISION_REQUIRED",
      retryable: true,
      gameId,
      resultId: doc.id || null,
    },
  });
  return [null, null, null, errorMsg, errorMsg];
}

const inserted = upsertedCount > 0 || Boolean(upsertedId);
const matchedExisting = !inserted && (matchedCount > 0 || modifiedCount > 0);
if (matchedExisting) {
  const readbackMsg = Object.assign({}, msg, {
    _resultSubmitIdempotencyReadback: {
      tenantKey: doc.tenantKey,
      idempotencyKey: doc.idempotencyKey,
      resultId: doc.id,
    },
  });
  return [null, null, null, null, null, readbackMsg];
}
const acceptedMsg = Object.assign({}, msg, {
  statusCode: 202,
  _resultSubmitDoc: doc,
});
const gameMsg = Object.assign({}, msg, {
  _legacyGameRevisionCas: { tenantKey, gameId, sourceRevision, nextRevision: sourceRevision + 1 },
  payload: [
    { tenantKey, id: gameId, revision: sourceRevision },
    {
      $set: {
        resultStatus: "PENDING_REVIEW",
        resultLifecycleState: "PENDING_REVIEW",
        resultId: doc.id,
        resultRatingStatus: doc?.ratingWork?.status || (doc.ratingEnabled === false ? "SKIPPED" : "QUEUED"),
        lastResultAt: doc.submittedAt,
        updatedAt: doc.updatedAt,
      },
      $inc: { revision: 1 },
    },
    { upsert: false },
  ],
});

const ratingEvent = isObject(doc.ratingEvent) ? doc.ratingEvent : null;
const eventMsg = ratingEvent ? Object.assign({}, msg, {
  payload: [
    { _id: ratingEvent.id },
    {
      $setOnInsert: {
        _id: ratingEvent.id,
        createdAt: doc.createdAt,
        createdTs: doc.createdTs,
        id: ratingEvent.id,
        gameId: ratingEvent.gameId,
        resultId: ratingEvent.resultId,
        ratingEnabled: true,
        pendingAt: ratingEvent.pendingAt,
        pendingAtTs: ratingEvent.pendingAtTs,
        appliedAt: ratingEvent.appliedAt,
        appliedAtTs: ratingEvent.appliedAtTs,
        finalizedAt: ratingEvent.finalizedAt,
        revertedAt: ratingEvent.revertedAt,
        formula: ratingEvent.formula,
        ratingImpact: [],
        ratingFactsVersion: ratingEvent.ratingFactsVersion || doc?.ratingFacts?.version || null,
      },
      $set: { status: "PENDING_CONFIRMATION", updatedAt: doc.updatedAt },
    },
    { upsert: true },
  ],
}) : null;

gameMsg._resultSubmitRevisionDeferred = { acceptedMsg, eventMsg };
return [null, gameMsg, null, null, null, null];
