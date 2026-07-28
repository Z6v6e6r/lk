const asArray = (v) => Array.isArray(v) ? v : [];
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const normalizeEventKeyPart = (value, fallback = 'unknown') => {
  const text = toStr(value);
  return encodeURIComponent(text || fallback).replace(/%/g, '~');
};
const resolveActorType = (actor) => {
  const id = toStr(actor?.id);
  if (id && id.startsWith('system:')) return 'SYSTEM';
  if (id && id.startsWith('admin:')) return 'ADMIN';
  return 'PLAYER';
};
const resolveRatingLedgerEventType = (mode, action, source) => {
  if (mode === 'revert' && source === 'game_result_expire_rollback') return 'GAME_RESULT_EXPIRED_REVERTED';
  if (mode === 'revert') return 'GAME_RESULT_DISPUTED_REVERTED';
  if (action === 'ACCEPT_CORRECTION') return 'GAME_RESULT_CORRECTION_APPLIED';
  if (action === 'EXPIRE') return 'GAME_RESULT_TIMEOUT_CONFIRMED';
  return 'GAME_RESULT_CONFIRMED';
};
const buildRatingLedgerMutations = ({
  ratingImpact,
  nowIso,
  gameId,
  resultId,
  resultRevision,
  mode,
  action,
  source,
  actor,
  lifecycleEventId,
  formula,
}) => asArray(ratingImpact).map((entry) => {
  const before = mode === 'revert' ? entry.after : entry.before;
  const after = mode === 'revert' ? entry.before : entry.after;
  const gradeBefore = mode === 'revert' ? entry.gradeAfter : entry.gradeBefore;
  const gradeAfter = mode === 'revert' ? entry.gradeBefore : entry.gradeAfter;
  const delta = mode === 'revert' ? -Number(entry.delta || 0) : Number(entry.delta || 0);
  const clientId = toStr(entry?.id);
  const phoneNorm = toStr(entry?.phoneNorm);
  const memberKey = toStr(entry?.memberKey);
  const playerKey = clientId
    ? `client:${clientId}`
    : phoneNorm
      ? `phone:${phoneNorm}`
      : memberKey
        ? `member:${memberKey}`
        : `name:${normalizeEventKeyPart(entry?.name)}`;
  const stateIdentityQuery = clientId
    ? {
      $or: [
        { playerKey },
        { clientId },
        ...(phoneNorm ? [{ phoneNorm }] : []),
      ],
    }
    : phoneNorm
      ? { phoneNorm }
      : { playerKey };
  const eventType = resolveRatingLedgerEventType(mode, action, source);
  const eventId = [
    'rating_evt',
    'game_result',
    normalizeEventKeyPart(resultId),
    String(Number(resultRevision || 1)),
    normalizeEventKeyPart(mode),
    normalizeEventKeyPart(playerKey),
  ].join(':');
  const actorDoc = {
    type: resolveActorType(actor),
    id: toStr(actor?.id),
    memberKey: toStr(actor?.memberKey),
    phoneNorm: toStr(actor?.phoneNorm),
    name: toStr(actor?.name) || (resolveActorType(actor) === 'SYSTEM' ? 'System' : 'Игрок'),
  };
  const eventDoc = {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: 1,
    eventType,
    occurredAt: nowIso,
    createdAt: nowIso,
    player: {
      key: playerKey,
      clientId,
      memberKey,
      phoneNorm,
      name: toStr(entry?.name) || 'Игрок',
    },
    actor: actorDoc,
    source: {
      domain: 'GAME_RESULT',
      sourceId: toStr(gameId),
      gameId: toStr(gameId),
      resultId: toStr(resultId),
      resultRevision: Number(resultRevision || 1),
      lifecycleEventId: toStr(lifecycleEventId),
      action: toStr(action),
      mode: toStr(mode),
      reason: toStr(source),
    },
    change: {
      before: toFiniteNumber(before),
      delta: toFiniteNumber(delta),
      after: toFiniteNumber(after),
      gradeBefore: toStr(gradeBefore),
      gradeAfter: toStr(gradeAfter),
      expected: toFiniteNumber(entry?.expected),
      actual: toFiniteNumber(entry?.actual),
    },
    formula: formula && typeof formula === 'object'
      ? Object.assign({ version: 'game-rating-v1' }, formula)
      : { version: 'game-rating-v1' },
    projectionIntent: {
      viva: 'REQUIRED_DURING_MIGRATION',
    },
  };
  const stateSet = {
    schemaVersion: 1,
    ownership: 'CUP_CANONICAL',
    playerKey,
    phoneNorm,
    name: toStr(entry?.name) || 'Игрок',
    ratingNumeric: toFiniteNumber(after),
    rating: toStr(gradeAfter),
    updatedAt: nowIso,
    lastEventId: eventId,
    lastEventType: eventType,
    lastEventAt: nowIso,
    lastGameId: toStr(gameId),
    lastResultId: toStr(resultId),
    lastResultRevision: Number(resultRevision || 1),
    lastDelta: toFiniteNumber(delta),
    lastSource: source,
    lastChangedBy: actorDoc,
    team: entry?.team || null,
  };
  if (clientId) stateSet.clientId = clientId;
  if (memberKey) stateSet.memberKey = memberKey;
  return {
    eventId,
    eventOperation: {
      query: { _id: eventId },
      update: { $setOnInsert: eventDoc },
    },
    stateOperation: {
      query: stateIdentityQuery,
      update: {
        $set: stateSet,
        $setOnInsert: { createdAt: nowIso },
      },
    },
    query: stateIdentityQuery,
    update: {
      $set: stateSet,
      $setOnInsert: { createdAt: nowIso },
    },
  };
});
const applyImpactToPlayers = (players, ratingImpact, mode) => asArray(players).map((p) => {
  const clientId = toStr(p?.id || p?.clientId || p?.uuid || p?.userId || p?.playerId);
  const phoneNorm = String(p?.phoneNorm || p?.phone || '').replace(/\D/g, '');
  const found = asArray(ratingImpact).find((ri) => (
    (clientId && toStr(ri?.id || ri?.clientId) === clientId)
    || (phoneNorm && ri.phoneNorm === phoneNorm)
  ));
  if (!found) return p;
  const ratingNumeric = mode === 'revert' ? found.before : found.after;
  const rating = mode === 'revert' ? found.gradeBefore : found.gradeAfter;
  return Object.assign({}, p, { ratingNumeric, rating });
});
const buildPublicMemberKey = (internalMemberKey) => {
  const source = toStr(internalMemberKey) || 'member';
  if (/^rm_[a-z0-9]+$/i.test(source)) return source;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rm_${(hash >>> 0).toString(36)}`;
};
const sanitizeMember = (value) => {
  if (!value || typeof value !== 'object') return null;
  const memberKey = toStr(value.memberKey);
  return {
    memberKey: memberKey ? buildPublicMemberKey(memberKey) : null,
    name: toStr(value.name) || 'Игрок',
    bucket: toStr(value.bucket || value.source) || null,
    rating: value.rating ?? null,
    ratingNumeric: toFiniteNumber(value.ratingNumeric),
  };
};
const sanitizeSetPairings = (setPairings) => asArray(setPairings).map((item) => ({
  setIndex: Number.isInteger(Number(item?.setIndex)) ? Number(item.setIndex) : 0,
  teamSlots: Array.from({ length: 4 }, (_, index) => sanitizeMember(asArray(item?.teamSlots || item?.slots)[index])),
}));
const sanitizeIntermediateResults = (items) => asArray(items).map((item) => ({
  setIndex: Number.isInteger(Number(item?.setIndex)) ? Number(item.setIndex) : 0,
  score: item?.score && typeof item.score === 'object'
    ? {
      left: Number.isFinite(Number(item.score.left)) ? Number(item.score.left) : null,
      right: Number.isFinite(Number(item.score.right)) ? Number(item.score.right) : null,
    }
    : null,
  impact: sanitizeRatingImpact(item?.impact),
}));
const sanitizeActor = (actor) => {
  if (!actor || typeof actor !== 'object') return null;
  return {
    memberKey: actor.memberKey ? buildPublicMemberKey(actor.memberKey) : null,
    name: actor.name || 'Игрок',
  };
};
const sanitizeRatingImpact = (ratingImpact) => asArray(ratingImpact).map((entry) => ({
  memberKey: entry?.memberKey ? buildPublicMemberKey(entry.memberKey) : null,
  name: entry?.name || 'Игрок',
  team: entry?.team || null,
  before: Number.isFinite(Number(entry?.before)) ? Number(entry.before) : null,
  expected: Number.isFinite(Number(entry?.expected)) ? Number(entry.expected) : null,
  actual: Number.isFinite(Number(entry?.actual)) ? Number(entry.actual) : null,
  delta: Number.isFinite(Number(entry?.delta)) ? Number(entry.delta) : null,
  after: Number.isFinite(Number(entry?.after)) ? Number(entry.after) : null,
  gradeAfter: entry?.gradeAfter || null,
}));
const sanitizeCorrectionContext = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    status: value.status || null,
    openedAt: value.openedAt || null,
    expiresAt: value.expiresAt || null,
    reason: value.reason || null,
    originalSubmittedBy: sanitizeActor(value.originalSubmittedBy),
    disputedBy: sanitizeActor(value.disputedBy),
    acceptedBy: sanitizeActor(value.acceptedBy),
  };
};
const sanitizeSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return null;
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
const sanitizeVivaSync = (value) => {
  if (!value || typeof value !== 'object') return null;
  const auditEventIds = uniq(asArray(value.auditEventIds).map((item) => toStr(item)));
  const failures = asArray(value.failures).map((item) => ({
    id: toStr(item?.id),
    phone: toStr(item?.phone),
    name: toStr(item?.name),
    reason: toStr(item?.reason || item?.error),
  })).filter((item) => item.id || item.phone || item.name || item.reason);
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
const buildResponseMessage = (baseMsg, payload, statusCode = 200) => Object.assign({}, baseMsg, {
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload,
});
const buildResponseSlot = (isCronExpireAction, responseMsg) => (isCronExpireAction ? null : responseMsg);
const buildRevisionFilter = (pendingId, statusFilter, revision) => {
  const filter = { id: pendingId, status: statusFilter };
  if (Number.isInteger(Number(revision)) && Number(revision) > 1) {
    filter.revision = Number(revision);
    return filter;
  }
  filter.$or = [
    { revision: 1 },
    { revision: { $exists: false } },
    { revision: null },
  ];
  return filter;
};
const buildSyncSignature = (resultId, revision, mode, action) => uniq([
  'result_viva_sync',
  toStr(resultId),
  Number.isInteger(Number(revision)) ? String(Number(revision)) : null,
  toStr(mode),
  toStr(action),
]).join(':');
const buildAuditEventId = (signature, player) => uniq([
  signature,
  toStr(player?.id),
  toStr(player?.phoneNorm),
  toStr(player?.memberKey),
  toStr(player?.name)?.toLowerCase().replace(/\s+/g, '_'),
]).join(':');
const buildPendingVivaSync = (signature, totalPlayers, auditEventIds) => ({
  status: 'PENDING',
  attempts: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  totalPlayers: Math.max(0, Number(totalPlayers || 0)),
  syncedPlayers: 0,
  failures: [],
  syncSignature: signature,
  auditEventIds: uniq(asArray(auditEventIds).map((item) => toStr(item))),
});
const buildPublicResult = ({
  pending,
  gameId,
  lifecycleState,
  ratingEventId,
  ratingEventStatus,
  vivaSync,
}) => ({
  id: pending.id || null,
  gameId: gameId || pending.gameId || null,
  status: lifecycleState,
  lifecycleState,
  revision: Number.isInteger(Number(pending?.revision)) ? Number(pending.revision) : 1,
  score: pending.score || null,
  sets: asArray(pending.sets),
  setPairings: sanitizeSetPairings(pending.setPairings),
  intermediateResults: sanitizeIntermediateResults(pending.intermediateResults || pending?.resultPayload?.intermediateResults),
  rosterSnapshot: sanitizeSnapshot(pending.rosterSnapshot),
  submittedBy: sanitizeActor(pending.submittedBy),
  submittedAt: pending.submittedAt || null,
  submittedAtTs: Number.isFinite(Number(pending.submittedAtTs)) ? Number(pending.submittedAtTs) : null,
  confirmedBy: sanitizeActor(pending.confirmedBy),
  confirmedAt: pending.confirmedAt || null,
  disputedBy: sanitizeActor(pending.disputedBy),
  disputedAt: pending.disputedAt || null,
  correctionContext: sanitizeCorrectionContext(pending.correctionContext),
  ratingEvent: ratingEventId ? { id: ratingEventId, status: ratingEventStatus || null } : null,
  ratingImpact: sanitizeRatingImpact(pending.ratingImpact),
  vivaSync: sanitizeVivaSync(vivaSync),
});
const buildVivaSyncBatch = ({
  pending,
  ratingImpact,
  ratingEventId,
  gameId,
  nextRevision,
  actor,
  nowIso,
  action,
  mode,
  source,
}) => {
  const syncSignature = buildSyncSignature(pending.id, nextRevision, mode, action);
  const tasks = asArray(ratingImpact).map((entry) => {
    const targetRating = mode === 'revert' ? entry.before : entry.after;
    const previousRating = mode === 'revert' ? entry.after : entry.before;
    const targetGrade = mode === 'revert' ? entry.gradeBefore : entry.gradeAfter;
    const auditEventId = buildAuditEventId(syncSignature, entry);
    return {
      outboxId: uniq(['result_viva_sync', pending.id, String(nextRevision), mode, toStr(entry?.id), toStr(entry?.phoneNorm), toStr(entry?.memberKey)]).join(':'),
      auditEventId,
      syncSignature,
      mode,
      source,
      gameId,
      resultId: pending.id,
      resultRevision: nextRevision,
      ratingEventId,
      player: {
        id: toStr(entry?.id),
        memberKey: toStr(entry?.memberKey),
        phoneNorm: toStr(entry?.phoneNorm),
        name: toStr(entry?.name) || 'Игрок',
      },
      payload: {
        clientId: toStr(entry?.id),
        phone: toStr(entry?.phoneNorm),
        playerName: toStr(entry?.name) || 'Игрок',
        levelLetter: toStr(targetGrade),
        levelNumeric: Number.isFinite(Number(targetRating)) ? Number(targetRating).toFixed(5) : null,
        source,
        gameId,
        previousRating: Number.isFinite(Number(previousRating)) ? Number(previousRating) : null,
        nextRating: Number.isFinite(Number(targetRating)) ? Number(targetRating) : null,
        confirmedAt: pending.confirmedAt || nowIso,
        changedById: toStr(actor?.id),
        changedByName: toStr(actor?.name) || 'Игрок',
        changedByPhone: toStr(actor?.phoneNorm),
        eventId: auditEventId,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      skipReason: !toStr(entry?.id)
        ? 'Missing clientId for Viva sync'
        : !Number.isFinite(Number(targetRating))
          ? 'Missing target rating for Viva sync'
          : null,
    };
  });
  const auditEventIds = tasks.map((task) => task.auditEventId);
  return {
    batchId: syncSignature,
    syncSignature,
    resultId: pending.id,
    resultRevision: nextRevision,
    gameId,
    action,
    mode,
    source,
    ratingEventId,
    startedAt: nowIso,
    actor: {
      id: toStr(actor?.id),
      name: toStr(actor?.name) || 'Игрок',
      phoneNorm: toStr(actor?.phoneNorm),
    },
    tasks,
    pendingState: buildPendingVivaSync(syncSignature, tasks.length, auditEventIds),
  };
};

const CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const ctx = msg._resultConfirm || {};
const action = String(ctx.action || 'CONFIRM').toUpperCase();
const isCronExpireAction = action === 'EXPIRE_CRON';
const pending = msg._resultPending || null;
if (!pending) {
  const responseMsg = buildResponseMessage(msg, { error: 'No result context' }, 409);
  return [null, null, null, buildResponseSlot(isCronExpireAction, responseMsg), responseMsg, null];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const gameId = ctx.game?.id || pending.gameId;
const ratingImpact = asArray(pending.ratingImpact);
const ratingEnabled = pending?.ratingEnabled !== false && pending?.ratingEvent?.ratingEnabled !== false;
const ratingEventId = ratingEnabled ? (pending?.ratingEvent?.id || `rate_${pending.id}`) : null;
const ratingEventStatus = String(pending?.ratingEvent?.status || '').toUpperCase();
const shouldRollbackAppliedRating = ratingEnabled && (ratingEventStatus === 'PROVISIONAL_APPLIED' || ratingEventStatus === 'FINAL');
const shouldApplyRatingNow = ratingEnabled && ratingEventStatus !== 'FINAL' && ratingEventStatus !== 'PROVISIONAL_APPLIED';
const pendingStatus = String(pending?.status || '').toUpperCase();
const hasGameRoster = Array.isArray(ctx.game?.participants) || Array.isArray(ctx.game?.waitlist);
const actor = ctx.actorMember
  || { memberKey: null, id: null, name: 'Игрок', phoneNorm: ctx.phone };
const currentRevision = Number.isInteger(Number(pending?.revision)) && Number(pending.revision) > 0
  ? Number(pending.revision)
  : 1;
const nextRevision = currentRevision + 1;
const ratingFormula = pending?.ratingFormula || pending?.ratingEvent?.formula || null;
const requiresLiveRatingAtConfirm = ratingEnabled
  && ['CONFIRM', 'ACCEPT_CORRECTION', 'EXPIRE'].includes(action)
  && pending?.ratingFacts?.version === 'game-result-rating-facts-v1'
  && !pending.alreadyFinal
  && !pending.expiredToNoResult;
if (requiresLiveRatingAtConfirm && msg._resultLiveRatingCalculated !== true) {
  const responseMsg = buildResponseMessage(msg, {
    error: 'Live rating state must be loaded before result confirmation',
    code: 'LIVE_RATING_CALCULATION_REQUIRED',
  }, 409);
  return [null, null, null, buildResponseSlot(isCronExpireAction, responseMsg), responseMsg, null];
}
const buildCanonicalRatingMutations = (mode, source, changedBy = actor) => buildRatingLedgerMutations({
  ratingImpact,
  nowIso,
  gameId,
  resultId: pending.id,
  resultRevision: nextRevision,
  mode,
  action,
  source,
  actor: changedBy,
  lifecycleEventId: ratingEventId,
  formula: ratingFormula,
});

if (pending.expiredToNoResult) {
  const syncBatch = shouldRollbackAppliedRating
    ? buildVivaSyncBatch({
      pending: Object.assign({}, pending, { confirmedAt: nowIso }),
      ratingImpact,
      ratingEventId,
      gameId,
      nextRevision,
      actor: action === 'EXPIRE_CRON'
        ? { id: 'system:result-expire', name: 'System result expire', phoneNorm: null }
        : actor,
      nowIso,
      action,
      mode: 'revert',
      source: 'game_result_expire_rollback',
    })
    : null;
  const resultSet = {
    status: 'NO_RESULT_EXPIRED',
    lifecycleState: 'NO_RESULT_EXPIRED',
    revision: nextRevision,
    'correctionContext.status': 'EXPIRED_NO_RESULT',
    'ratingEvent.status': shouldRollbackAppliedRating ? 'REVERTED' : 'EXPIRED',
    'ratingEvent.revertedAt': shouldRollbackAppliedRating ? nowIso : null,
    'ratingEvent.revertedAtTs': shouldRollbackAppliedRating ? nowTs : null,
    expiredAt: nowIso,
    expiredAtTs: nowTs,
    vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
    updatedAt: nowIso,
  };
  const gameSet = {
    resultStatus: 'NO_RESULT_EXPIRED',
    resultLifecycleState: 'NO_RESULT_EXPIRED',
    resultId: pending.id,
    updatedAt: nowIso,
  };
  if (hasGameRoster && shouldRollbackAppliedRating) {
    gameSet.participants = applyImpactToPlayers(ctx.game?.participants, ratingImpact, 'revert');
    gameSet.waitlist = applyImpactToPlayers(ctx.game?.waitlist, ratingImpact, 'revert');
  }
  const responsePayload = {
    gameId,
    resultId: pending.id,
    status: 'NO_RESULT_EXPIRED',
    lifecycleState: 'NO_RESULT_EXPIRED',
    ratingEventStatus: shouldRollbackAppliedRating ? 'REVERTED' : 'EXPIRED',
    expiredAt: nowIso,
    rollbackApplied: shouldRollbackAppliedRating,
    ratingImpact: sanitizeRatingImpact(ratingImpact),
    result: buildPublicResult({
      pending: Object.assign({}, pending, resultSet),
      gameId,
      lifecycleState: 'NO_RESULT_EXPIRED',
      ratingEventId,
      ratingEventStatus: shouldRollbackAppliedRating ? 'REVERTED' : 'EXPIRED',
      vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
    }),
  };
  const responseMsg = buildResponseMessage(msg, responsePayload);
  const resultUpdateMsg = Object.assign({}, msg, {
    payload: [
      buildRevisionFilter(pending.id, 'CORRECTION_PENDING', currentRevision),
      { $set: resultSet },
      { upsert: false },
    ],
    _resultConfirmBundle: {
      ratingsPayload: shouldRollbackAppliedRating
        ? buildCanonicalRatingMutations(
          'revert',
          'game_result_expire_rollback',
          action === 'EXPIRE_CRON'
            ? { id: 'system:result-expire', name: 'System result expire', phoneNorm: null }
            : actor,
        )
        : [],
      gamePayload: [
        { id: gameId },
        { $set: gameSet },
        { upsert: false },
      ],
      eventPayload: [
        { _id: ratingEventId },
        {
          $set: {
            status: shouldRollbackAppliedRating ? 'REVERTED' : 'EXPIRED',
            revertedAt: shouldRollbackAppliedRating ? nowIso : null,
            revertedAtTs: shouldRollbackAppliedRating ? nowTs : null,
            expiredAt: nowIso,
            expiredAtTs: nowTs,
            updatedAt: nowIso,
          },
        },
        { upsert: true },
      ],
      response: { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, payload: responsePayload },
      syncBatch,
    },
  });
  return [resultUpdateMsg, null, null, null, responseMsg, null];
}

if (action === 'CONFIRM' || action === 'ACCEPT_CORRECTION' || action === 'EXPIRE') {
  if (pending.alreadyFinal || pendingStatus === 'CONFIRMED') {
    const responsePayload = {
      gameId,
      resultId: pending.id,
      status: 'CONFIRMED',
      lifecycleState: 'CONFIRMED',
      ratingEventStatus: 'FINAL',
      idempotent: true,
      ratingImpact: sanitizeRatingImpact(ratingImpact),
      result: buildPublicResult({
        pending,
        gameId,
        lifecycleState: 'CONFIRMED',
        ratingEventId,
        ratingEventStatus: 'FINAL',
        vivaSync: pending?.vivaSync || null,
      }),
    };
    const responseMsg = buildResponseMessage(msg, responsePayload);
    return [null, Object.assign({}, msg, { payload: [] }), null, buildResponseSlot(isCronExpireAction, responseMsg), responseMsg, null];
  }

  const correctionAccepted = pendingStatus === 'CORRECTION_PENDING' && (action === 'ACCEPT_CORRECTION' || action === 'CONFIRM');
  const ratingApplyRequired = shouldApplyRatingNow || (ratingEnabled && correctionAccepted && ratingEventStatus === 'REVERTED');
  const syncBatch = ratingApplyRequired
    ? buildVivaSyncBatch({
      pending: Object.assign({}, pending, { confirmedAt: nowIso }),
      ratingImpact,
      ratingEventId,
      gameId,
      nextRevision,
      actor,
      nowIso,
      action,
      mode: 'apply',
      source: correctionAccepted ? 'game_result_accept_correction' : 'game_result_confirm',
    })
    : null;

  const resultSet = {
    status: 'CONFIRMED',
    lifecycleState: 'CONFIRMED',
    revision: nextRevision,
    confirmedBy: { id: actor.id || null, name: actor.name || 'Игрок', phoneNorm: actor.phoneNorm },
    confirmedAt: nowIso,
    confirmedAtTs: nowTs,
    vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
    updatedAt: nowIso,
  };
  if (ratingEnabled) {
    resultSet.ratingFormula = ratingFormula;
    resultSet.ratingImpact = ratingImpact;
    resultSet.intermediateResults = asArray(pending.intermediateResults);
    resultSet.ratingCalculatedAt = pending.ratingCalculatedAt || nowIso;
    resultSet.ratingCalculatedAtTs = Number(pending.ratingCalculatedAtTs || nowTs);
    resultSet['resultPayload.intermediateResults'] = asArray(pending.intermediateResults);
    resultSet['ratingEvent.status'] = 'FINAL';
    resultSet['ratingEvent.formula'] = ratingFormula;
    resultSet['ratingEvent.ratingImpact'] = ratingImpact;
    resultSet['ratingEvent.appliedAt'] = ratingApplyRequired ? nowIso : (pending?.ratingEvent?.appliedAt || null);
    resultSet['ratingEvent.appliedAtTs'] = ratingApplyRequired ? nowTs : (pending?.ratingEvent?.appliedAtTs || null);
    resultSet['ratingEvent.finalizedAt'] = nowIso;
    resultSet['ratingEvent.finalizedAtTs'] = nowTs;
  }
  if (correctionAccepted) {
    resultSet['correctionContext.status'] = 'ACCEPTED';
    resultSet['correctionContext.acceptedAt'] = nowIso;
    resultSet['correctionContext.acceptedAtTs'] = nowTs;
    resultSet['correctionContext.acceptedBy'] = { id: actor.id || null, name: actor.name || 'Игрок', phoneNorm: actor.phoneNorm };
  }
  if (action === 'EXPIRE') {
    resultSet.confirmReason = 'DISPUTE_TIMEOUT';
  }

  const gameSet = {
    resultStatus: 'CONFIRMED',
    resultLifecycleState: 'CONFIRMED',
    resultId: pending.id,
    lastResultAt: nowIso,
    updatedAt: nowIso,
  };
  if (ratingApplyRequired && hasGameRoster) {
    gameSet.participants = applyImpactToPlayers(ctx.game?.participants, ratingImpact, 'apply');
    gameSet.waitlist = applyImpactToPlayers(ctx.game?.waitlist, ratingImpact, 'apply');
  }
  const responsePayload = {
    gameId,
    resultId: pending.id,
    status: 'CONFIRMED',
    lifecycleState: 'CONFIRMED',
    confirmedAt: nowIso,
    ratingEventStatus: ratingEnabled ? 'FINAL' : null,
    ratingImpact: sanitizeRatingImpact(ratingImpact),
    ratingApplied: ratingApplyRequired,
    result: buildPublicResult({
      pending: Object.assign({}, pending, resultSet),
      gameId,
      lifecycleState: 'CONFIRMED',
      ratingEventId,
      ratingEventStatus: ratingEnabled ? 'FINAL' : null,
      vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
    }),
  };
  const responseMsg = buildResponseMessage(msg, responsePayload);
  const resultUpdateMsg = Object.assign({}, msg, {
    payload: [
      buildRevisionFilter(pending.id, { $in: ['PENDING_REVIEW', 'CORRECTION_PENDING'] }, currentRevision),
      { $set: resultSet },
      { upsert: false },
    ],
    _resultConfirmBundle: {
      ratingsPayload: ratingApplyRequired
        ? buildCanonicalRatingMutations(
          'apply',
          correctionAccepted ? 'game_result_accept_correction' : 'game_result_confirm',
        )
        : [],
      gamePayload: [
        { id: gameId },
        { $set: gameSet },
        { upsert: false },
      ],
      eventPayload: ratingEnabled ? [
        { _id: ratingEventId },
        {
          $set: {
            status: 'FINAL',
            formula: ratingFormula,
            ratingImpact,
            ratingFactsVersion: pending?.ratingFacts?.version || null,
            finalizedAt: nowIso,
            finalizedAtTs: nowTs,
            updatedAt: nowIso,
          },
        },
        { upsert: true },
      ] : null,
      response: { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, payload: responsePayload },
      syncBatch,
    },
  });
  return [resultUpdateMsg, Object.assign({}, msg, {
    payload: ratingApplyRequired
      ? buildCanonicalRatingMutations(
        'apply',
        correctionAccepted ? 'game_result_accept_correction' : 'game_result_confirm',
      )
      : [],
  }), Object.assign({}, msg, {
    payload: [
      { id: gameId },
      { $set: gameSet },
      { upsert: false },
    ],
  }), null, responseMsg, ratingEnabled ? Object.assign({}, msg, {
    payload: [
      { _id: ratingEventId },
      {
        $set: {
          status: 'FINAL',
          formula: ratingFormula,
          ratingImpact,
          ratingFactsVersion: pending?.ratingFacts?.version || null,
          finalizedAt: nowIso,
          finalizedAtTs: nowTs,
          updatedAt: nowIso,
        },
      },
      { upsert: true },
    ],
  }) : null];
}

if (pending.alreadyReverted || pending?.ratingEvent?.status === 'REVERTED') {
  const responsePayload = {
    gameId,
    resultId: pending.id,
    status: pending.status || 'CORRECTION_PENDING',
    lifecycleState: pending.lifecycleState || 'CORRECTION_PENDING',
    ratingEventStatus: 'REVERTED',
    idempotent: true,
    result: buildPublicResult({
      pending,
      gameId,
      lifecycleState: pending.lifecycleState || 'CORRECTION_PENDING',
      ratingEventId,
      ratingEventStatus: 'REVERTED',
      vivaSync: pending?.vivaSync || null,
    }),
  };
  const responseMsg = buildResponseMessage(msg, responsePayload);
  return [null, Object.assign({}, msg, { payload: [] }), null, buildResponseSlot(isCronExpireAction, responseMsg), responseMsg, null];
}

const correctionExpiresAtTs = nowTs + CORRECTION_WINDOW_MS;
const correctionExpiresAt = new Date(correctionExpiresAtTs).toISOString();
const syncBatch = shouldRollbackAppliedRating
  ? buildVivaSyncBatch({
    pending: Object.assign({}, pending, { confirmedAt: nowIso }),
    ratingImpact,
    ratingEventId,
    gameId,
    nextRevision,
    actor,
    nowIso,
    action,
    mode: 'revert',
    source: 'game_result_dispute_rollback',
  })
  : null;
const correctionContext = {
  status: 'PENDING_AUTHOR_APPROVAL',
  openedAt: nowIso,
  openedAtTs: nowTs,
  expiresAt: correctionExpiresAt,
  expiresAtTs: correctionExpiresAtTs,
  originalSubmittedBy: pending.submittedBy || null,
  disputedBy: { id: actor.id || null, name: actor.name || 'Игрок', phoneNorm: actor.phoneNorm },
  reason: ctx.reason || null,
  proposedCorrection: ctx.correctionPayload || null,
};
const resultSet = {
  status: 'CORRECTION_PENDING',
  lifecycleState: 'CORRECTION_PENDING',
  revision: nextRevision,
  disputeState: 'DISPUTED',
  disputedBy: { id: actor.id || null, name: actor.name || 'Игрок', phoneNorm: actor.phoneNorm },
  disputedAt: nowIso,
  disputedAtTs: nowTs,
  correctionContext,
  'ratingEvent.status': shouldRollbackAppliedRating ? 'REVERTED' : 'DISPUTED',
  'ratingEvent.revertedAt': shouldRollbackAppliedRating ? nowIso : null,
  'ratingEvent.revertedAtTs': shouldRollbackAppliedRating ? nowTs : null,
  vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
  updatedAt: nowIso,
};
const gameSet = {
  resultStatus: 'CORRECTION_PENDING',
  resultLifecycleState: 'CORRECTION_PENDING',
  resultDisputeState: 'DISPUTED',
  resultId: pending.id,
  updatedAt: nowIso,
};
if (hasGameRoster && shouldRollbackAppliedRating) {
  gameSet.participants = applyImpactToPlayers(ctx.game?.participants, ratingImpact, 'revert');
  gameSet.waitlist = applyImpactToPlayers(ctx.game?.waitlist, ratingImpact, 'revert');
}
const responsePayload = {
  gameId,
  resultId: pending.id,
  status: 'CORRECTION_PENDING',
  lifecycleState: 'CORRECTION_PENDING',
  disputeState: 'DISPUTED',
  disputedAt: nowIso,
  correctionContext: sanitizeCorrectionContext(correctionContext),
  ratingEventStatus: shouldRollbackAppliedRating ? 'REVERTED' : 'DISPUTED',
  rollbackApplied: shouldRollbackAppliedRating,
  result: buildPublicResult({
    pending: Object.assign({}, pending, resultSet),
    gameId,
    lifecycleState: 'CORRECTION_PENDING',
    ratingEventId,
    ratingEventStatus: shouldRollbackAppliedRating ? 'REVERTED' : 'DISPUTED',
    vivaSync: syncBatch ? syncBatch.pendingState : (pending?.vivaSync || null),
  }),
};
const responseMsg = buildResponseMessage(msg, responsePayload);
const resultUpdateMsg = Object.assign({}, msg, {
  payload: [
    buildRevisionFilter(pending.id, 'PENDING_REVIEW', currentRevision),
    { $set: resultSet },
    { upsert: false },
  ],
  _resultConfirmBundle: {
    ratingsPayload: shouldRollbackAppliedRating
      ? buildCanonicalRatingMutations('revert', 'game_result_dispute_rollback')
      : [],
    gamePayload: [
      { id: gameId },
      { $set: gameSet },
      { upsert: false },
    ],
    eventPayload: [
      { _id: ratingEventId },
      { $set: { status: shouldRollbackAppliedRating ? 'REVERTED' : 'DISPUTED', revertedAt: shouldRollbackAppliedRating ? nowIso : null, revertedAtTs: shouldRollbackAppliedRating ? nowTs : null, updatedAt: nowIso } },
      { upsert: true },
    ],
    response: { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, payload: responsePayload },
    syncBatch,
  },
});
return [
  resultUpdateMsg,
  Object.assign({}, msg, {
    payload: shouldRollbackAppliedRating
      ? buildCanonicalRatingMutations('revert', 'game_result_dispute_rollback')
      : [],
  }),
  Object.assign({}, msg, {
    payload: [
      { id: gameId },
      { $set: gameSet },
      { upsert: false },
    ],
  }),
  null,
  responseMsg,
  Object.assign({}, msg, {
    payload: [
      { _id: ratingEventId },
      { $set: { status: shouldRollbackAppliedRating ? 'REVERTED' : 'DISPUTED', revertedAt: shouldRollbackAppliedRating ? nowIso : null, revertedAtTs: shouldRollbackAppliedRating ? nowTs : null, updatedAt: nowIso } },
      { upsert: true },
    ],
  }),
];
