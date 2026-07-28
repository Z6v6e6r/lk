const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const toNumericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESULT_INPUT_OVERRIDE_START_TS = Date.parse("2026-05-31T00:00:00+03:00");
const RESULT_INPUT_OVERRIDE_END_TS = Date.parse("2026-06-10T23:59:59.999+03:00");

const resolveResultDisputeDeadlineTs = (submittedAtTs, storedDeadlineTs, game) => {
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

  if (Number.isFinite(storedDeadlineTs) && storedDeadlineTs > 0) {
    return storedDeadlineTs;
  }

  return Number.isFinite(submittedAtTs) && submittedAtTs > 0
    ? submittedAtTs + DISPUTE_WINDOW_MS
    : null;
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

const sanitizeMember = (value) => {
  if (!value || typeof value !== "object") return null;
  const memberKey = toStr(value.memberKey);
  return {
    memberKey: memberKey ? buildPublicMemberKey(memberKey) : null,
    name: toStr(value.name) || "Игрок",
    bucket: toStr(value.bucket || value.source) || null,
    rating: value.rating ?? null,
    ratingNumeric: toNumericOrNull(value.ratingNumeric),
  };
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

const sanitizeSetPairings = (setPairings) => asArray(setPairings).map((item) => ({
  setIndex: Number.isInteger(Number(item?.setIndex)) ? Number(item.setIndex) : 0,
  teamSlots: Array.from({ length: 4 }, (_, index) => sanitizeMember(asArray(item?.teamSlots || item?.slots)[index])).filter((slot, index) => index < 4 || Boolean(slot)),
}));

const sanitizeIntermediateResults = (items) => asArray(items).map((item) => ({
  setIndex: Number.isInteger(Number(item?.setIndex)) ? Number(item.setIndex) : 0,
  score: item?.score && typeof item.score === "object"
    ? {
      left: Number.isFinite(Number(item.score.left)) ? Number(item.score.left) : null,
      right: Number.isFinite(Number(item.score.right)) ? Number(item.score.right) : null,
    }
    : null,
  impact: sanitizeRatingImpact(item?.impact),
}));

const sanitizeActor = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    memberKey: toStr(value.memberKey) ? buildPublicMemberKey(value.memberKey) : null,
    name: toStr(value.name) || "Игрок",
  };
};

const sanitizeCorrectionContext = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    status: toStr(value.status),
    openedAt: toStr(value.openedAt),
    expiresAt: toStr(value.expiresAt),
    reason: toStr(value.reason),
    originalSubmittedBy: sanitizeActor(value.originalSubmittedBy),
    disputedBy: sanitizeActor(value.disputedBy),
    acceptedBy: sanitizeActor(value.acceptedBy),
  };
};

const sanitizeVivaSync = (value) => {
  if (!value || typeof value !== "object") return null;
  const failures = asArray(value.failures).map((item) => ({
    id: toStr(item?.id),
    phone: toStr(item?.phone),
    name: toStr(item?.name),
    reason: toStr(item?.reason || item?.error),
  })).filter((item) => item.id || item.phone || item.name || item.reason);
  const auditEventIds = asArray(value.auditEventIds).map((item) => toStr(item)).filter(Boolean);
  const result = {
    status: toStr(value.status),
    attempts: Math.max(0, Math.floor(Number(value.attempts || value.attemptCount || 0))),
    lastAttemptAt: toStr(value.lastAttemptAt),
    lastSuccessAt: toStr(value.lastSuccessAt),
    lastError: toStr(value.lastError),
    totalPlayers: Math.max(0, Math.floor(Number(value.totalPlayers || value.totalCount || 0))),
    syncedPlayers: Math.max(0, Math.floor(Number(value.syncedPlayers || value.successCount || 0))),
    failures,
    syncSignature: toStr(value.syncSignature),
    auditEventIds,
  };
  if (
    !result.status
    && result.attempts === 0
    && !result.lastAttemptAt
    && !result.lastSuccessAt
    && !result.lastError
    && result.totalPlayers === 0
    && result.syncedPlayers === 0
    && result.failures.length === 0
    && result.auditEventIds.length === 0
    && !result.syncSignature
  ) {
    return null;
  }
  return result;
};

const sanitizeSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    version: toStr(snapshot.version),
    capturedAt: toStr(snapshot.capturedAt),
    members: asArray(snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
    playerPool: asArray(snapshot.playerPool || snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
    initialTeamSlots: asArray(snapshot.initialTeamSlots).map((item) => sanitizeMember(item)),
    initialTeamMemberKeys: asArray(snapshot.initialTeamMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
  };
};

const sanitizeTeams = (teams) => {
  const source = toStr(teams?.source) || "resultRosterSnapshot";
  return {
    source,
    teamA: asArray(teams?.teamA).map((item) => sanitizeMember(item)).filter(Boolean),
    teamB: asArray(teams?.teamB).map((item) => sanitizeMember(item)).filter(Boolean),
  };
};

const rows = asArray(msg.payload);
const ctx = msg._resultState || {};
const nowTs = Date.now();
const latest = rows
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => Number(right?.submittedAtTs || right?.createdTs || 0) - Number(left?.submittedAtTs || left?.createdTs || 0))[0] || null;

const latestStatus = String(latest?.status || "").toUpperCase();
const latestSubmittedAtTs = Number(latest?.submittedAtTs || latest?.createdTs || 0);
const latestDeadlineTsRaw = Number(latest?.disputeDeadlineTs || 0);
const latestDeadlineTs = resolveResultDisputeDeadlineTs(latestSubmittedAtTs, latestDeadlineTsRaw, ctx.game);
const correctionDeadlineTs = Number(latest?.correctionContext?.expiresAtTs || 0);
const correctionExpired = latestStatus === "CORRECTION_PENDING"
  && Number.isFinite(correctionDeadlineTs)
  && correctionDeadlineTs > 0
  && correctionDeadlineTs <= nowTs;

const normalizedStatus = correctionExpired ? "NO_RESULT_EXPIRED" : (latestStatus || "NO_RESULT");
const viewerMemberKey = toStr(ctx.viewerMember?.memberKey);
const viewerId = toStr(ctx.viewerMember?.id || ctx.actor?.id);
const viewerPhone = toStr(ctx.phone);
const fallbackParticipant = Boolean(
  viewerPhone
  && (
    asArray(ctx.teams?.teamA).some((item) => item?.phoneNorm === viewerPhone)
    || asArray(ctx.teams?.teamB).some((item) => item?.phoneNorm === viewerPhone)
  )
);
const submittedByMemberKey = toStr(latest?.submittedBy?.memberKey);
const submittedById = toStr(latest?.submittedBy?.id || latest?.submittedBy?.clientId);
const viewerIsAuthor = Boolean(viewerId && submittedById && viewerId === submittedById)
  || Boolean(viewerMemberKey && submittedByMemberKey && viewerMemberKey === submittedByMemberKey);
const viewerIsLegacyAuthor = Boolean(!viewerIsAuthor && viewerPhone && latest?.submittedBy?.phoneNorm && latest.submittedBy.phoneNorm === viewerPhone);
const isAuthor = viewerIsAuthor || viewerIsLegacyAuthor;
const isParticipant = Boolean(ctx.viewerMember) || fallbackParticipant;
const activePending = normalizedStatus === "PENDING_REVIEW";
const correctionPending = normalizedStatus === "CORRECTION_PENDING";
const canSubmit = Boolean(ctx.isFinished && isParticipant && (!latest || normalizedStatus === "NO_RESULT"));
const canConfirm = Boolean(
  ctx.isFinished
  && isParticipant
  && (
    (activePending && !isAuthor)
    || (correctionPending && isAuthor)
  ),
);
const canDispute = Boolean(
  ctx.isFinished
  && isParticipant
  && activePending
  && !isAuthor
  && (!Number.isFinite(latestDeadlineTs) || latestDeadlineTs > nowTs)
);

const latestResult = latest ? {
  id: latest.id || null,
  gameId: latest.gameId || ctx.gameId || null,
  status: normalizedStatus,
  lifecycleState: normalizedStatus,
  score: latest.score || null,
  sets: asArray(latest.sets),
  setPairings: sanitizeSetPairings(latest.setPairings),
  intermediateResults: sanitizeIntermediateResults(latest.intermediateResults || latest.resultPayload?.intermediateResults),
  attachments: asArray(latest.resultPayload?.attachments),
  rosterSnapshot: sanitizeSnapshot(latest.rosterSnapshot),
  submittedBy: sanitizeActor(latest.submittedBy),
  submittedAt: latest.submittedAt || null,
  submittedAtTs: Number.isFinite(Number(latest.submittedAtTs)) ? Number(latest.submittedAtTs) : null,
  confirmedBy: sanitizeActor(latest.confirmedBy),
  confirmedAt: latest.confirmedAt || null,
  disputedBy: sanitizeActor(latest.disputedBy),
  disputedAt: latest.disputedAt || null,
  correctionContext: sanitizeCorrectionContext(latest.correctionContext),
  ratingEvent: latest.ratingEvent ? {
    id: latest.ratingEvent.id || null,
    status: latest.ratingEvent.status || null,
  } : null,
  ratingImpact: sanitizeRatingImpact(latest.ratingImpact),
  vivaSync: sanitizeVivaSync(latest.vivaSync),
  viewer: {
    role: isAuthor ? "AUTHOR" : (isParticipant ? "PARTICIPANT" : "SPECTATOR"),
    canSubmit,
    canConfirm,
    canDispute,
  },
} : null;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  gameId: ctx.gameId || null,
  isFinished: Boolean(ctx.isFinished),
  endTs: Number.isFinite(Number(ctx.endTs)) ? Number(ctx.endTs) : null,
  teams: sanitizeTeams(ctx.teams),
  rosterSnapshot: sanitizeSnapshot(ctx.resultRosterSnapshot),
  state: normalizedStatus,
  lifecycleState: normalizedStatus,
  viewerState: {
    role: isAuthor ? "AUTHOR" : (isParticipant ? "PARTICIPANT" : "SPECTATOR"),
    isParticipant,
    isAuthor,
  },
  latestResult,
  canSubmit,
  canConfirm,
  canDispute,
  disputeDeadlineAt: latest?.disputeDeadlineAt || (Number.isFinite(latestDeadlineTs) ? new Date(latestDeadlineTs).toISOString() : null),
  correctionExpiresAt: latest?.correctionContext?.expiresAt || null,
};

return [msg, msg];
