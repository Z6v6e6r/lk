const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? raw?.payload?.upsertedCount ?? 0);
const upsertedId = raw?.upsertedId ?? raw?.result?.upsertedId ?? raw?.payload?.upsertedId ?? null;
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error)
  || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const persisted = acknowledged
  && !hasMongoError
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

const inserted = upsertedCount > 0 || Boolean(upsertedId);
const matchedExisting = !inserted && (matchedCount > 0 || modifiedCount > 0);
const acceptedMsg = Object.assign({}, msg, {
  statusCode: matchedExisting ? 200 : 202,
  _resultSubmitDoc: matchedExisting ? Object.assign({}, doc, { idempotent: true }) : doc,
});

if (matchedExisting) {
  return [acceptedMsg, null, null, null, null];
}

const gameMsg = Object.assign({}, msg, {
  payload: [
    { id: doc.gameId },
    {
      $set: {
        resultStatus: "PENDING_REVIEW",
        resultLifecycleState: "PENDING_REVIEW",
        resultId: doc.id,
        lastResultAt: doc.submittedAt,
        updatedAt: doc.updatedAt,
      },
    },
    { upsert: false },
  ],
});

const ratingEvent = isObject(doc.ratingEvent) ? doc.ratingEvent : null;
const eventMsg = ratingEvent
  ? Object.assign({}, msg, {
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
          ratingImpact: asArray(ratingEvent.ratingImpact),
          ratingFactsVersion: ratingEvent.ratingFactsVersion || doc?.ratingFacts?.version || null,
        },
        $set: {
          status: "PENDING_CONFIRMATION",
          updatedAt: doc.updatedAt,
        },
      },
      { upsert: true },
    ],
  })
  : null;

return [acceptedMsg, gameMsg, eventMsg, null, null];
