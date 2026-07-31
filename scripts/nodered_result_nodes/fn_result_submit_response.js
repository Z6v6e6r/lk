const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const buildPublicMemberKey = (internalMemberKey) => {
  const source = toStr(internalMemberKey) || "member";
  if (/^rm_[a-z0-9]+$/i.test(source)) return source;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rm_${(hash >>> 0).toString(36)}`;
};

const sanitizeRatingImpact = (ratingImpact) => asArray(ratingImpact).map((item) => ({
  memberKey: toStr(item?.memberKey) ? buildPublicMemberKey(item.memberKey) : null,
  name: item?.name || "Игрок",
  team: item?.team || null,
  before: Number.isFinite(Number(item?.before)) ? Number(item.before) : null,
  expected: Number.isFinite(Number(item?.expected)) ? Number(item.expected) : null,
  actual: Number.isFinite(Number(item?.actual)) ? Number(item.actual) : null,
  delta: Number.isFinite(Number(item?.delta)) ? Number(item.delta) : null,
  after: Number.isFinite(Number(item?.after)) ? Number(item.after) : null,
  gradeAfter: item?.gradeAfter || null,
}));

const sanitizeActor = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    memberKey: toStr(value.memberKey) ? buildPublicMemberKey(value.memberKey) : null,
    name: value.name || "Игрок",
  };
};
const sanitizeRatingWork = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    status: toStr(value.status),
    desiredState: toStr(value.desiredState),
    applySemantics: toStr(value.applySemantics),
    generation: Number.isInteger(Number(value.generation)) ? Number(value.generation) : null,
    attempts: Math.max(0, Math.floor(Number(value.attempts || 0))),
    queuedAt: toStr(value.queuedAt),
    appliedAt: toStr(value.appliedAt),
    revertedAt: toStr(value.revertedAt),
    nextAttemptAt: toStr(value.nextAttemptAt),
    lastError: toStr(value.lastError),
  };
};

const doc = msg._resultSubmitDoc || null;
msg.statusCode = msg.statusCode || 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
if (doc) {
  const ratingImpact = sanitizeRatingImpact(doc.ratingImpact);
  const attachments = asArray(doc.resultPayload?.attachments);
  const ratingWork = sanitizeRatingWork(doc.ratingWork);
  const result = {
    id: doc.id,
    resultId: doc.id,
    gameId: doc.gameId,
    status: doc.status,
    lifecycleState: doc.lifecycleState,
    resultModelVersion: Number(doc.resultModelVersion || 1),
    scoreRevision: Number(doc.scoreRevision || 1),
    lineageRootResultId: toStr(doc.lineageRootResultId),
    supersedesResultId: toStr(doc.supersedesResultId),
    effectiveState: toStr(doc.effectiveState),
    reviewState: toStr(doc?.review?.state),
    ratingWork,
    idempotent: doc.idempotent === true,
    score: doc.score || null,
    sets: asArray(doc.sets),
    setPairings: asArray(doc.setPairings),
    intermediateResults: asArray(doc.intermediateResults || doc.resultPayload?.intermediateResults),
    rosterSnapshot: doc.rosterSnapshot || null,
    submittedBy: sanitizeActor(doc.submittedBy),
    submittedAt: doc.submittedAt || null,
    submittedAtTs: Number.isFinite(Number(doc.submittedAtTs)) ? Number(doc.submittedAtTs) : null,
    disputeDeadlineAt: doc.disputeDeadlineAt || null,
    attachments,
    ratingImpact,
    viewer: {
      role: "AUTHOR",
      canSubmit: false,
      canConfirm: false,
      canDispute: false,
    },
    ratingEvent: doc.ratingEvent ? {
      id: doc.ratingEvent.id,
      status: doc.ratingEvent.status,
      pendingAt: doc.ratingEvent.pendingAt || null,
    } : null,
  };
  msg.payload = {
    ok: true,
    gameId: doc.gameId,
    resultId: doc.id,
    status: doc.status,
    lifecycleState: doc.lifecycleState,
    idempotent: doc.idempotent === true,
    result,
    ratingEvent: result.ratingEvent,
    ratingWork,
    ratingStatus: ratingWork?.status || result.ratingEvent?.status || null,
    ratingImpact,
    disputeDeadlineAt: doc.disputeDeadlineAt,
  };
} else {
  msg.payload = msg.payload || { ok: true };
}
return [msg, msg];
