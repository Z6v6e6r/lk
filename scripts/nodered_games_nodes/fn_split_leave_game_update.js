const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const strongId = (value) => (isObj(value)
  ? normalizeId(value.clientId || value.playerId || value.userId || value.id)
  : null);
const matchesTarget = (value, targetId, targetPhone) => {
  if (!isObj(value)) return false;
  const recordId = strongId(value);
  const phones = [value.phoneNorm, value.phone, value.mobile, value.clientPhoneNorm, value.clientPhone]
    .map(normalizePhone).filter(Boolean);
  if (targetId && recordId) return targetId === recordId;
  return Boolean(targetPhone && phones.includes(targetPhone));
};
const ackOk = (payload) => {
  if (!payload || typeof payload !== "object") return false;
  if (payload.acknowledged === false) return false;
  if (payload.acknowledged === true) return true;
  if (Array.isArray(payload)) return payload.some(ackOk);
  const count = payload.matchedCount ?? payload.modifiedCount ?? payload.n;
  return count !== undefined && Number(count) >= 0;
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
if (!ctx || !isObj(ctx.game)) {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "RETRY_REQUIRED", message: "LK game snapshot missing" };
  return [null, null, msg];
}
if (ctx.chatCleanupAttempted === true && (msg.error || !ackOk(msg.payload))) {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx.operationId,
    gameId: ctx.gameId,
    message: "Viva подтверждена; требуется повторить синхронизацию чата",
  };
  return [null, null, msg];
}
if (ctx.localAlreadyApplied === true) return [null, msg, null];

const game = ctx.game;
const nowIso = new Date().toISOString();
const targetId = normalizeId(ctx.targetClientId);
const targetPhone = normalizePhone(ctx.targetPhoneNorm);
const participants = asArray(game.participants).filter((item) => !matchesTarget(item, targetId, targetPhone));
const waitlist = asArray(game.waitlist).filter((item) => !matchesTarget(item, targetId, targetPhone));
const invitedPhones = asArray(game.invitedPhones).map(normalizePhone).filter((phone) => phone && phone !== targetPhone);
const participantPhones = uniq(participants.map((item) => normalizePhone(item?.phoneNorm || item?.phone)));
const waitlistPhones = uniq(waitlist.map((item) => normalizePhone(item?.phoneNorm || item?.phone)));
const metadata = isObj(game.metadata) ? JSON.parse(JSON.stringify(game.metadata)) : {};
const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
splitPayment.payments = asArray(splitPayment.payments).map((payment) => (
  matchesTarget(payment, targetId, targetPhone)
    ? {
      ...payment,
      status: "LEFT",
      leftAt: toStr(payment.leftAt) || nowIso,
      cancelledAt: toStr(payment.cancelledAt) || nowIso,
      cancelReason: ctx.reason || "PLAYER_LEFT",
      leaveOperationId: ctx.operationId,
    }
    : payment
));
metadata.splitPayment = splitPayment;
if (targetPhone && isObj(metadata.joinResponses)) {
  const currentJoinResponse = isObj(metadata.joinResponses[targetPhone])
    ? metadata.joinResponses[targetPhone]
    : {};
  metadata.joinResponses[targetPhone] = {
    ...currentJoinResponse,
    status: "DECLINED",
    leftAt: nowIso,
    updatedAt: nowIso,
    operationId: ctx.operationId,
  };
}
if (ctx.targetWasOrganizer === true) {
  delete metadata.organizerId;
  delete metadata.organizerPhone;
  delete metadata.organizerPhoneNorm;
}
const leaveEventExists = asArray(metadata.leaveEvents).some((item) => toStr(item?.operationId) === toStr(ctx.operationId));
const auditActor = ctx.mode === "SELF" ? "self" : (ctx.mode === "STAFF_TARGET" ? "staff" : "organizer");
if (!leaveEventExists) {
  metadata.leaveEvents = [...asArray(metadata.leaveEvents), {
    operationId: ctx.operationId,
    playerId: ctx.targetClientId || null,
    playerPhone: targetPhone,
    leftAt: nowIso,
    reason: ctx.reason || "PLAYER_LEFT",
    actor: auditActor,
    ...(ctx.mode === "STAFF_TARGET" ? { staffActorId: ctx.staffActorId || null } : {}),
  }].slice(-100);
}
const auditExists = asArray(metadata.selfRemovalAuditLog).some((item) => toStr(item?.operationId) === toStr(ctx.operationId));
if (!auditExists) {
  const localOnlyNoBooking = ctx.vivaVerification === "no_active_booking_for_exercise"
    && asArray(ctx.initialBookingIds).length === 0;
  metadata.selfRemovalAuditLog = [...asArray(metadata.selfRemovalAuditLog), {
    operationId: ctx.operationId,
    at: nowIso,
    source: ctx.mode === "STAFF_TARGET" ? "cup_staff" : "split_leave_server",
    actor: auditActor,
    ...(ctx.mode === "STAFF_TARGET" ? { staffActorId: ctx.staffActorId || null } : {}),
    status: localOnlyNoBooking ? "no_viva_booking_target" : "cancelled_in_viva",
    verification: ctx.vivaVerification || (localOnlyNoBooking
      ? "no_active_booking_for_exercise"
      : "active_absent_history_cancelled"),
  }].slice(-100);
}
const operationExists = asArray(metadata.leaveOperations).some((item) => toStr(item?.operationId) === toStr(ctx.operationId));
if (!operationExists) {
  metadata.leaveOperations = [...asArray(metadata.leaveOperations), {
    operationId: ctx.operationId,
    state: ctx.subscriptionReturnState === "RETURN_PENDING" ? "RETURN_PENDING" : "DONE",
    at: nowIso,
    mode: ctx.mode,
    ...(ctx.subscriptionReturnState ? { subscriptionReturnState: ctx.subscriptionReturnState } : {}),
  }].slice(-100);
}
metadata.lastLeaveUpdateAt = nowIso;
metadata.lastSelfRemovalAuditAt = nowIso;

const organizer = ctx.targetWasOrganizer === true ? null : game.organizer;
const activeSplitPhones = asArray(splitPayment.payments)
  .filter((item) => !/CANCEL|LEFT|REMOV|REFUND|VOID/i.test(String(item?.status || "")))
  .map((item) => normalizePhone(item?.phoneNorm || item?.phone || item?.clientPhoneNorm || item?.clientPhone));
const allRelatedPhones = uniq([
  normalizePhone(organizer?.phoneNorm || organizer?.phone),
  ...participantPhones,
  ...waitlistPhones,
  ...invitedPhones,
  ...activeSplitPhones,
]);

ctx.localApplyAt = nowIso;
msg._splitLeaveCtx = ctx;
const query = { id: ctx.gameId, archived: { $ne: true } };
if (game.updatedAt !== undefined) query.updatedAt = game.updatedAt;
const update = {
  $set: {
    organizer,
    participants,
    waitlist,
    participantPhones,
    waitlistPhones,
    invitedPhones,
    allRelatedPhones,
    metadata,
    updatedAt: nowIso,
  },
  $unset: {
    resultRosterSnapshot: "",
  },
};
msg.payload = [query, update, {}];
return [msg, null, null];
