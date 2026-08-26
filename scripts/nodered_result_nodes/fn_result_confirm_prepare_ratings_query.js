const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (value) => Array.from(new Set(asArray(value).filter(Boolean)));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const buildIdentityKey = (member) => (
  (toStr(member?.id || member?.clientId) ? `id:${toStr(member?.id || member?.clientId)}` : null)
    || (toStr(member?.phoneNorm) ? `phone:${member.phoneNorm}` : null)
    || toStr(member?.memberKey)
);
const buildEffectiveSetPairings = (pending) => {
  const stored = asArray(pending?.ratingFacts?.effectiveSetPairings);
  if (stored.length > 0) return stored;
  const teamA = asArray(pending?.teams?.teamA);
  const teamB = asArray(pending?.teams?.teamB);
  if (teamA.length === 0 && teamB.length === 0) return [];
  const sets = asArray(pending?.sets || pending?.resultPayload?.sets);
  return (sets.length > 0 ? sets : [null]).map((_, setIndex) => ({ setIndex, teamA, teamB }));
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

const rows = asArray(msg.payload);
const ctx = msg._resultConfirm || {};
const action = String(ctx.action || "CONFIRM").toUpperCase();
const isDisputeAction = action === "DISPUTE";
const isExpireAction = action === "EXPIRE";
const isAcceptCorrectionAction = action === "ACCEPT_CORRECTION";
const isConfirmAction = action === "CONFIRM" || isExpireAction || isAcceptCorrectionAction;

const activeStatuses = ["PENDING_REVIEW", "CORRECTION_PENDING", "CONFIRMED", "NO_RESULT_EXPIRED"];
const latest = rows
  .filter((item) => item && typeof item === "object" && activeStatuses.includes(String(item.status || "").toUpperCase()))
  .sort((left, right) => Number(right?.submittedAtTs || right?.createdTs || 0) - Number(left?.submittedAtTs || left?.createdTs || 0))[0] || null;

if (!latest) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = isDisputeAction
    ? { error: "No result to dispute" }
    : isAcceptCorrectionAction
      ? { error: "No correction pending" }
      : isExpireAction
        ? { error: "No result to expire" }
        : { error: "No pending result to confirm" };
  return [null, msg, msg];
}
const ratingEnabled = latest?.ratingEnabled !== false
  && latest?.ratingEvent?.ratingEnabled !== false
  && ctx?.game?.settings?.ratingGame !== false;

const status = String(latest.status || "").toUpperCase();
const nowTs = Date.now();
const correctionDeadlineTs = Number(latest?.correctionContext?.expiresAtTs || 0);
const correctionExpired = status === "CORRECTION_PENDING"
  && Number.isFinite(correctionDeadlineTs)
  && correctionDeadlineTs > 0
  && correctionDeadlineTs <= nowTs;
const priorOutbox = latest?.legacyGameProjectionOutbox;
const priorTransitionAction = String(priorOutbox?.transitionAction || "").toUpperCase();
const replayActionMatches = priorTransitionAction === action
  || (status === "NO_RESULT_EXPIRED" && action === "EXPIRE" && priorTransitionAction === "EXPIRE_CRON");
const sameTransitionReplay = priorOutbox?.version === 2
  && replayActionMatches
  && String(priorOutbox?.transitionStatus || "").toUpperCase() === status
  && toStr(priorOutbox?.tenantKey) === toStr(latest?.tenantKey)
  && toStr(priorOutbox?.resultId) === toStr(latest?.id || latest?._id)
  && Number(priorOutbox?.resultRevision) === Number(latest?.revision)
  && Boolean(toStr(priorOutbox?.payloadJson));
if (!sameTransitionReplay && priorOutbox !== undefined && priorOutbox !== null) {
  const successfulSinkStates = new Set(["DELIVERED", "SKIPPED", "SUPERSEDED"]);
  const priorOutboxDelivered = priorOutbox?.version === 2
    && priorOutbox?.status === "DELIVERED"
    && Array.isArray(priorOutbox?.sinks)
    && priorOutbox.sinks.every((sink) => successfulSinkStates.has(String(sink?.status || "").toUpperCase()));
  if (!priorOutboxDelivered) {
    const recoveryRequired = priorOutbox?.status === "RECOVERY_REQUIRED"
      || priorOutbox?.sinks?.some?.((sink) => String(sink?.status || "").toUpperCase() === "UNKNOWN");
    msg.statusCode = recoveryRequired ? 202 : 409;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    msg.payload = {
      error: recoveryRequired
        ? "Previous result side effects require reconciliation"
        : "Previous result side effects are not terminal",
      code: recoveryRequired
        ? "RESULT_SIDE_EFFECT_RECOVERY_REQUIRED"
        : "RESULT_SIDE_EFFECTS_NOT_TERMINAL",
      recoveryRequired: Boolean(recoveryRequired),
      bundleId: toStr(priorOutbox?.bundleId),
    };
    return [null, msg, msg];
  }
}

if (sameTransitionReplay) {
  msg._resultPending = Object.assign({}, latest, { replayDurableOutbox: true });
  msg.payload = { phoneNorm: { $in: [] } };
  return [msg, null, msg];
}

if (correctionExpired && isConfirmAction) {
  msg._resultPending = Object.assign({}, latest, { expiredToNoResult: true });
  msg.payload = { phoneNorm: { $in: [] } };
  return [msg, null, msg];
}

if (isConfirmAction && status === "CONFIRMED") {
  msg._resultPending = Object.assign({}, latest, { alreadyFinal: true });
  msg.payload = { phoneNorm: { $in: [] } };
  return [msg, null, msg];
}

if (isAcceptCorrectionAction && status !== "CORRECTION_PENDING") {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result is not awaiting correction acceptance" };
  return [null, msg, msg];
}

if (action === "CONFIRM" && status !== "PENDING_REVIEW" && status !== "CORRECTION_PENDING") {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result is not pending review" };
  return [null, msg, msg];
}

if (isExpireAction && status !== "PENDING_REVIEW" && status !== "CORRECTION_PENDING") {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result is not expirable" };
  return [null, msg, msg];
}

if (isDisputeAction && status !== "PENDING_REVIEW") {
  const alreadyReverted = latest?.ratingEvent?.status === "REVERTED" || status === "CORRECTION_PENDING";
  if (alreadyReverted) {
    msg._resultPending = Object.assign({}, latest, { alreadyReverted: true });
    msg.payload = { phoneNorm: { $in: [] } };
    return [msg, null, msg];
  }
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result is not disputable" };
  return [null, msg, msg];
}

const submittedAtTs = Number(latest?.submittedAtTs || latest?.createdTs || 0);
const disputeDeadlineTsRaw = Number(latest?.disputeDeadlineTs || 0);
const disputeDeadlineTs = resolveResultDisputeDeadlineTs(submittedAtTs, disputeDeadlineTsRaw, ctx.game);

if (isExpireAction && status === "PENDING_REVIEW" && Number.isFinite(disputeDeadlineTs) && disputeDeadlineTs > nowTs) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Dispute window is still active" };
  return [null, msg, msg];
}

if (isExpireAction && status === "CORRECTION_PENDING" && (!Number.isFinite(correctionDeadlineTs) || correctionDeadlineTs > nowTs)) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Correction window is still active" };
  return [null, msg, msg];
}

const actorMemberKey = toStr(ctx.actorMember?.memberKey);
const submittedByMemberKey = toStr(latest?.submittedBy?.memberKey);
const actorId = toStr(ctx.actorMember?.id || ctx.actor?.id);
const submittedById = toStr(latest?.submittedBy?.id || latest?.submittedBy?.clientId);
const isResultAuthor = Boolean(actorId && submittedById && actorId === submittedById)
  || Boolean(actorMemberKey && submittedByMemberKey && actorMemberKey === submittedByMemberKey)
  || Boolean(ctx.phone && latest?.submittedBy?.phoneNorm && latest.submittedBy.phoneNorm === ctx.phone);

if (status === "PENDING_REVIEW" && isResultAuthor && (action === "CONFIRM" || action === "DISPUTE")) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: action === "DISPUTE" ? "Another roster member should dispute result" : "Another roster member should confirm result" };
  return [null, msg, msg];
}

if ((isAcceptCorrectionAction || (action === "CONFIRM" && status === "CORRECTION_PENDING")) && !isResultAuthor) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only result author can accept correction" };
  return [null, msg, msg];
}

if (isDisputeAction && Number.isFinite(disputeDeadlineTs) && disputeDeadlineTs <= nowTs) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Dispute window has expired" };
  return [null, msg, msg];
}

const requiresLiveRating = ratingEnabled
  && ["CONFIRM", "ACCEPT_CORRECTION", "EXPIRE"].includes(action)
  && Number(latest?.resultModelVersion || 1) < 2
  && !latest?.alreadyFinal
  && !latest?.expiredToNoResult;
const effectiveSetPairings = buildEffectiveSetPairings(latest);
const playedMembers = [];
const seenMembers = new Set();
let invalidPairing = null;
effectiveSetPairings.forEach((pairing, index) => {
  const teamA = asArray(pairing?.teamA);
  const teamB = asArray(pairing?.teamB);
  if (teamA.length !== 2 || teamB.length !== 2) {
    invalidPairing = invalidPairing || `Rating facts for set ${index + 1} must contain a complete 2v2 pairing`;
    return;
  }
  const setMembers = [...teamA, ...teamB];
  const setKeys = setMembers.map(buildIdentityKey).filter(Boolean);
  if (setKeys.length !== 4 || new Set(setKeys).size !== 4) {
    invalidPairing = invalidPairing || `Rating facts for set ${index + 1} contain duplicated or unidentified players`;
    return;
  }
  setMembers.forEach((member) => {
    const key = buildIdentityKey(member);
    if (!key || seenMembers.has(key)) return;
    seenMembers.add(key);
    playedMembers.push(member);
  });
});
const missingIdentityMember = playedMembers.find((member) => (
  !toStr(member?.id || member?.clientId)
  && !toStr(member?.phoneNorm)
));
const clientIds = uniq(playedMembers.map((member) => toStr(member?.id || member?.clientId)));
const phones = uniq(playedMembers.map((member) => toStr(member?.phoneNorm)));

if (requiresLiveRating && (effectiveSetPairings.length === 0 || invalidPairing || missingIdentityMember)) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: invalidPairing || (missingIdentityMember
      ? "Pending result has played players without stable id or phoneNorm"
      : "Pending result is missing complete internal rating facts"),
    code: "RESULT_RATING_FACTS_INVALID",
  };
  return [null, msg, msg];
}

msg._resultPending = Object.assign({}, latest, {
  disputeDeadlineTs,
  isResultAuthor,
  ratingEnabled,
});
msg._resultRatingCalculationRequired = requiresLiveRating;
const identityClauses = [];
if (clientIds.length > 0) identityClauses.push({ clientId: { $in: clientIds } });
if (clientIds.length > 0) identityClauses.push({ playerKey: { $in: clientIds.map((id) => `client:${id}`) } });
if (phones.length > 0) identityClauses.push({ phoneNorm: { $in: phones } });
msg.payload = requiresLiveRating && identityClauses.length > 0
  ? { $or: identityClauses }
  : { phoneNorm: { $in: [] } };
return [msg, null, msg];
