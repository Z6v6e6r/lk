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
const recordId = (value) => (isObj(value)
  ? normalizeId(value.clientId || value.playerId || value.userId || value.id)
  : null);
const stableVersion = (parts) => {
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
const respond = (statusCode, code, message, ctx) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { ok: false, code, gameId: ctx?.gameId || null, message };
  delete msg._staffLeaveCtx;
  return [null, msg];
};

const input = isObj(msg._staffLeaveCtx) ? msg._staffLeaveCtx : null;
const game = asArray(msg.payload).find((row) => isObj(row) && toStr(row.id) === toStr(input?.gameId));
if (!input) return respond(500, "CONTEXT_MISSING", "Staff leave context missing", input);
if (!game) return respond(404, "GAME_NOT_FOUND", "Game not found", input);

const targetId = normalizeId(input.targetClientId);
const organizerIds = [
  recordId(game.organizer),
  normalizeId(game.metadata?.organizerId),
].filter(Boolean);
if (organizerIds.includes(targetId)) {
  return respond(409, "ORGANIZER_TARGET_FORBIDDEN", "Organizer cannot be removed by participant leave", input);
}

const payments = asArray(game.metadata?.splitPayment?.payments)
  .filter((row) => recordId(row) === targetId && !inactive(row?.status));
const participants = asArray(game.participants)
  .filter((row) => recordId(row) === targetId && !inactive(row?.status));
const waitlist = asArray(game.waitlist)
  .filter((row) => recordId(row) === targetId && !inactive(row?.status));
if (payments.length + participants.length + waitlist.length === 0) {
  return respond(409, "TARGET_NOT_ACTIVE", "Target is not an active game member", input);
}

const bookingItems = [];
for (const row of [...payments, ...participants, ...waitlist]) {
  for (const bookingId of [...asArray(row.bookingIds), row.bookingId, row.vivaBookingId]) {
    const normalized = toStr(bookingId);
    if (normalized) bookingItems.push({ bookingId: normalized, clientId: input.targetClientId });
  }
}
const queue = Array.from(new Map(bookingItems.map((item) => [item.bookingId.toLowerCase(), item])).values());
if (!queue.some((item) => normalizeId(item.bookingId) === normalizeId(input.targetBookingId))) {
  return respond(409, "BOOKING_TARGET_MISMATCH", "Booking is not active for the exact target", input);
}

const targetPhones = Array.from(new Set([...payments, ...participants, ...waitlist]
  .flatMap((row) => [row.phoneNorm, row.phone, row.clientPhoneNorm, row.clientPhone])
  .map(normalizePhone).filter(Boolean)));
if (targetPhones.length > 1) {
  return respond(409, "AMBIGUOUS_TARGET_IDENTITY", "Target has conflicting phone identities", input);
}
const targetPhone = targetPhones[0] || null;
if (targetPhone) {
  const identityRows = [
    game.organizer,
    { id: game.metadata?.organizerId, phoneNorm: game.metadata?.organizerPhoneNorm || game.metadata?.organizerPhone },
    ...asArray(game.participants),
    ...asArray(game.waitlist),
    ...asArray(game.metadata?.splitPayment?.payments),
  ].filter(isObj);
  const conflictingIdentity = identityRows.some((row) => {
    const phoneMatches = [row.phoneNorm, row.phone, row.clientPhoneNorm, row.clientPhone]
      .map(normalizePhone).includes(targetPhone);
    const strongId = recordId(row);
    return phoneMatches && strongId && strongId !== targetId;
  });
  if (conflictingIdentity) {
    return respond(409, "AMBIGUOUS_TARGET_IDENTITY", "Target phone is linked to another client", input);
  }
}
const joinResponse = targetPhone && isObj(game.metadata?.joinResponses?.[targetPhone])
  && !inactive(game.metadata.joinResponses[targetPhone].status)
  ? game.metadata.joinResponses[targetPhone]
  : null;
const membershipVersion = stableVersion([
  ...payments.flatMap((row) => [row.membershipId, ...asArray(row.bookingIds), row.bookingId, row.paymentRef]),
  ...participants.flatMap((row) => [row.membershipId, row.bookingId, row.paymentRef]),
  ...waitlist.flatMap((row) => [row.membershipId, row.bookingId, row.paymentRef]),
  joinResponse?.membershipId,
  joinResponse?.paymentRef,
]);
if (!membershipVersion || membershipVersion !== input.expectedMembershipVersion) {
  return respond(409, "STALE_MEMBERSHIP_VERSION", "Game membership changed; refresh before removal", input);
}

const exerciseId = toStr(
  game.metadata?.splitPayment?.vivaExerciseId
  || game.booking?.vivaExerciseId
  || game.booking?.exerciseId
  || game.metadata?.vivaExerciseId
  || game.metadata?.exerciseId,
);
const serviceToken = toStr(global.get("vivacrm_access_token"));
if (!exerciseId || !serviceToken) {
  return respond(503, "UPSTREAM_UNAVAILABLE", "Cancellation service is temporarily unavailable", input);
}

const claimToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
const operationId = `staff-leave:${input.gameId}:${input.targetClientId}:${membershipVersion}`;
const subscriptionInstanceIds = Array.from(new Set(
  payments.map((row) => toStr(row.clientSubscriptionId || row.subscriptionProductId)).filter(Boolean),
));
const subscriptionVisitCounts = Array.from(new Set(
  payments
    .map((row) => Number(row.subscriptionVisitCount))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
));
msg._splitLeaveCtx = {
  gameId: input.gameId,
  operationId,
  claimToken,
  reason: "CUP_STAFF_REMOVAL",
  requestedRefundMethod: input.requestedRefundMethod,
  actorClientId: null,
  actorPhoneNorm: null,
  staffActorId: input.staffActorId,
  source: "CUP",
  idempotencyDigest: input.idempotencyDigest,
  mode: "STAFF_TARGET",
  membershipVersion,
  game,
  exerciseId,
  bookingQueue: queue.map((item) => ({ ...item })),
  initialBookingIds: queue.map((item) => item.bookingId),
  bookingResults: [],
  clientSubscriptionId: subscriptionInstanceIds.length === 1 ? subscriptionInstanceIds[0] : null,
  subscriptionVisitCount: subscriptionVisitCounts.length === 1 ? subscriptionVisitCounts[0] : null,
  trace: [],
  successMessage: "Игрок удалён из игры",
  upstreamAuthHeader: `Bearer ${serviceToken}`,
  localAlreadyApplied: false,
  targetClientId: input.targetClientId,
  targetPhoneNorm: targetPhone,
  targetWasOrganizer: false,
  needsBookingDiscovery: false,
  preOperationDiscovery: false,
  step: "start_cancel",
};
delete msg._staffLeaveCtx;
delete msg.statusCode;
msg.payload = undefined;
return [msg, null];
