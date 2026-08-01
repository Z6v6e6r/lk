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
const inactiveStatus = (value) => /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV/i
  .test(String(value || ""));
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
const phoneIdentityAmbiguous = (records, targetId, targetPhone) => {
  if (!targetPhone) return false;
  const phoneLinkedIds = asArray(records)
    .filter((value) => isObj(value) && [
      value.phoneNorm, value.phone, value.mobile, value.clientPhoneNorm, value.clientPhone,
    ].map(normalizePhone).includes(targetPhone))
    .map(strongId)
    .filter(Boolean);
  if (targetId) return phoneLinkedIds.some((recordId) => recordId !== targetId);
  return new Set(phoneLinkedIds).size > 1;
};
const membershipVersion = (parts) => {
  const stableParts = Array.from(new Set(asArray(parts).map(toStr).filter(Boolean))).sort();
  if (stableParts.length === 0) return null;
  const hashPart = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const seed = stableParts.join("|");
  return `${hashPart(seed)}${hashPart([...seed].reverse().join(""))}`;
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const game = rows[0] && isObj(rows[0]) ? rows[0] : null;
if (!ctx || !game) return [null, null, msg, null];
ctx.bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
ctx.trace = Array.isArray(ctx.trace) ? ctx.trace : [];
ctx.game = game;
ctx.localAlreadyApplied = asArray(game.metadata?.leaveOperations)
  .some((item) => item?.operationId === ctx.operationId && item?.state === "DONE");

const targetId = normalizeId(ctx.targetClientId);
const targetPhone = normalizePhone(ctx.targetPhoneNorm);
const metadata = isObj(game.metadata) ? game.metadata : {};
const identityRecords = [
  game.organizer,
  { id: metadata.organizerId, phoneNorm: metadata.organizerPhoneNorm || metadata.organizerPhone },
  ...asArray(game.participants),
  ...asArray(game.waitlist),
  ...asArray(metadata.splitPayment?.payments),
].filter(isObj);
if (phoneIdentityAmbiguous(identityRecords, targetId, targetPhone)) {
  msg._splitLeaveCtx = ctx;
  msg.payload = { operationId: ctx.operationId, reason: "ambiguous_phone_linked_client_ids" };
  return [null, null, msg, null];
}
const payments = asArray(metadata.splitPayment?.payments)
  .filter((item) => matchesTarget(item, targetId, targetPhone) && !inactiveStatus(item?.status));
const participants = asArray(game.participants)
  .filter((item) => matchesTarget(item, targetId, targetPhone) && !inactiveStatus(item?.status));
const waitlist = asArray(game.waitlist)
  .filter((item) => matchesTarget(item, targetId, targetPhone) && !inactiveStatus(item?.status));
const joinResponse = targetPhone && isObj(metadata.joinResponses?.[targetPhone])
  && !inactiveStatus(metadata.joinResponses[targetPhone].status)
  ? metadata.joinResponses[targetPhone]
  : null;
const currentVersion = membershipVersion([
  ...payments.flatMap((item) => [item.membershipId, ...asArray(item.bookingIds), item.bookingId, item.paymentRef]),
  ...participants.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  ...waitlist.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  joinResponse?.membershipId,
  joinResponse?.paymentRef,
]);

if (currentVersion && (!ctx.membershipVersion || currentVersion !== ctx.membershipVersion)) {
  if (ctx.operationState === "STARTED" && ctx.vivaTargetMode !== "NONE") {
    ctx.rejoinDetected = true;
    ctx.localMutationDisabled = true;
    ctx.successMessage = "Новая запись в игре сохранена";
  } else {
    ctx.supersededByRejoin = true;
    ctx.localAlreadyApplied = true;
    ctx.chatCleanupSkipped = true;
    ctx.localApplyAt = new Date().toISOString();
    ctx.successMessage = "Новая запись в игре сохранена";
    msg._splitLeaveCtx = ctx;
    msg.payload = undefined;
    return [null, null, null, msg];
  }
} else if (currentVersion && ctx.localAlreadyApplied) {
  msg._splitLeaveCtx = ctx;
  msg.payload = { operationId: ctx.operationId, reason: "applied_operation_has_active_original_generation" };
  return [null, null, msg, null];
} else if (!currentVersion && !ctx.localAlreadyApplied) {
  msg._splitLeaveCtx = ctx;
  msg.payload = { operationId: ctx.operationId, reason: "current_membership_generation_missing" };
  return [null, null, msg, null];
} else if (!currentVersion && ctx.localAlreadyApplied) {
  ctx.chatCleanupSkipped = true;
  ctx.localApplyAt = ctx.localApplyAt || new Date().toISOString();
  msg._splitLeaveCtx = ctx;
  msg.payload = undefined;
  return [null, null, null, msg];
}

msg._splitLeaveCtx = ctx;
msg.payload = undefined;
if (ctx.operationState === "STARTED") {
  const serviceToken = String(global.get("vivacrm_access_token") || "").trim();
  if (ctx.vivaTargetMode !== "NONE" && !serviceToken) return [null, null, msg, null];
  ctx.backgroundStartedRecovery = true;
  ctx.upstreamAuthHeader = serviceToken ? `Bearer ${serviceToken}` : null;
  ctx.preCancelVerification = true;
  ctx.step = ctx.vivaTargetMode === "NONE" ? "local_apply" : "start_verify_active";
  msg._splitLeaveCtx = ctx;
  return [null, msg, null, null];
}
return [msg, null, null, null];
