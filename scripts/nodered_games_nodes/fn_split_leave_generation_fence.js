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
const inactive = (value) => /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV/i
  .test(String(value || ""));
const strongId = (value) => (isObj(value)
  ? normalizeId(value.clientId || value.playerId || value.userId || value.id)
  : null);
const matches = (value, targetId, targetPhone) => {
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
const version = (parts) => {
  const values = Array.from(new Set(asArray(parts).map(toStr).filter(Boolean))).sort();
  if (values.length === 0) return null;
  const hashPart = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const seed = values.join("|");
  return `${hashPart(seed)}${hashPart([...seed].reverse().join(""))}`;
};
const retry = (ctx, reason) => {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Требуется повторная проверка поколения записи",
    reason,
  };
  return [null, msg];
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
const game = asArray(msg.payload).find((item) => isObj(item) && toStr(item.id) === toStr(ctx?.gameId));
if (!ctx || !game) return retry(ctx, "fresh_game_missing");
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
  return retry(ctx, "ambiguous_phone_linked_client_ids");
}
const payments = asArray(metadata.splitPayment?.payments)
  .filter((item) => matches(item, targetId, targetPhone) && !inactive(item?.status));
const participants = asArray(game.participants)
  .filter((item) => matches(item, targetId, targetPhone) && !inactive(item?.status));
const waitlist = asArray(game.waitlist)
  .filter((item) => matches(item, targetId, targetPhone) && !inactive(item?.status));
const joinResponse = targetPhone && isObj(metadata.joinResponses?.[targetPhone])
  && !inactive(metadata.joinResponses[targetPhone].status)
  ? metadata.joinResponses[targetPhone]
  : null;
const activeExists = payments.length > 0 || participants.length > 0 || waitlist.length > 0 || Boolean(joinResponse);
const currentVersion = version([
  ...payments.flatMap((item) => [item.membershipId, ...asArray(item.bookingIds), item.bookingId, item.paymentRef]),
  ...participants.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  ...waitlist.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  joinResponse?.membershipId,
  joinResponse?.paymentRef,
]);
if (activeExists && !currentVersion) return retry(ctx, "active_generation_missing");
if (currentVersion) {
  if (currentVersion === ctx.membershipVersion) return retry(ctx, "original_generation_still_active");
  ctx.supersededByRejoin = true;
  ctx.localAlreadyApplied = true;
  ctx.successMessage = "Новая запись в игре сохранена";
}
ctx.chatCleanupSkipped = true;
ctx.localApplyAt = ctx.localApplyAt || new Date().toISOString();
msg._splitLeaveCtx = ctx;
msg.payload = undefined;
return [msg, null];
