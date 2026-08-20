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
const matchesActor = (value, actorId, actorPhone) => {
  if (!isObj(value)) return false;
  const recordId = strongId(value);
  const phones = [
    value.phoneNorm, value.phone, value.mobile, value.clientPhoneNorm, value.clientPhone,
  ].map(normalizePhone).filter(Boolean);
  if (actorId && recordId) return actorId === recordId;
  return Boolean(actorPhone && phones.includes(actorPhone));
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
const uniqBookingItems = (items) => {
  const byId = new Map();
  items.forEach((item) => {
    const bookingId = toStr(item?.bookingId);
    if (!bookingId || byId.has(bookingId.toLowerCase())) return;
    byId.set(bookingId.toLowerCase(), {
      bookingId,
      clientId: toStr(item?.clientId) || null,
    });
  });
  return Array.from(byId.values());
};
const stableVersion = (parts) => {
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
const respond = (statusCode, state, message, ctx) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    ok: false,
    state,
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message,
  };
  delete msg._splitCleanupAuth;
  return [null, msg, null];
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
if (!ctx || ctx.step !== "authorize_leave") {
  return respond(500, "CONFLICT", "Контекст удаления участника отсутствует", ctx);
}

const game = asArray(msg.payload).find((item) => isObj(item) && toStr(item.id) === toStr(ctx.gameId));
if (!game) return respond(404, "CONFLICT", "Игра не найдена", ctx);

const actorId = normalizeId(ctx.actorClientId);
const actorPhone = normalizePhone(ctx.actorPhoneNorm);
const mode = ctx.mode === "ORGANIZER_TARGET" ? "ORGANIZER_TARGET" : "SELF";
const metadata = isObj(game.metadata) ? game.metadata : {};
const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
const payments = asArray(splitPayment.payments).filter(isObj);
const identityRecords = [
  game.organizer,
  { id: metadata.organizerId, phoneNorm: metadata.organizerPhoneNorm || metadata.organizerPhone },
  ...asArray(game.participants),
  ...asArray(game.waitlist),
  ...payments,
].filter(isObj);
if (phoneIdentityAmbiguous(identityRecords, actorId, actorPhone)) {
  return respond(409, "CONFLICT", "Телефон связан с несколькими профилями игры", ctx);
}
const actorPayments = payments.filter((item) => matchesActor(item, actorId, actorPhone));
const actorIsOrganizer = matchesActor(game.organizer, actorId, actorPhone)
  || matchesActor({ id: metadata.organizerId, phone: metadata.organizerPhoneNorm || metadata.organizerPhone }, actorId, actorPhone);
const actorParticipants = asArray(game.participants).filter((item) => matchesActor(item, actorId, actorPhone));
const actorWaitlist = asArray(game.waitlist).filter((item) => matchesActor(item, actorId, actorPhone));
const actorKnown = actorIsOrganizer || actorParticipants.length > 0 || actorWaitlist.length > 0 || actorPayments.length > 0;
if (!actorKnown) return respond(403, "CONFLICT", "Профиль не связан с этой игрой", ctx);

if (mode === "ORGANIZER_TARGET" && !actorIsOrganizer) {
  return respond(403, "CONFLICT", "Удалить другого игрока может только организатор", ctx);
}
if (mode === "SELF" && actorIsOrganizer) {
  return respond(409, "CONFLICT", "Организатор не может покинуть игру через participant leave", ctx);
}

let targetClientId = mode === "SELF" ? toStr(ctx.actorClientId) : null;
let targetPhone = mode === "SELF" ? normalizePhone(ctx.actorPhoneNorm) : null;
let targetPayments = mode === "SELF" ? actorPayments : [];
let verifiedQueue = [];

if (mode === "ORGANIZER_TARGET") {
  const linkedTargets = new Map();
  payments.forEach((payment) => {
    const clientId = toStr(payment.clientId || payment.playerId || payment.userId);
    const phone = normalizePhone(payment.phoneNorm || payment.phone || payment.clientPhoneNorm || payment.clientPhone);
    [...asArray(payment.bookingIds), payment.bookingId].forEach((bookingIdRaw) => {
      const bookingId = toStr(bookingIdRaw);
      if (bookingId) linkedTargets.set(bookingId.toLowerCase(), { bookingId, clientId, phone, payment });
    });
  });
  const requested = asArray(ctx.legacyRequestedBookingIds).map(toStr).filter(Boolean);
  const selected = requested.map((bookingId) => linkedTargets.get(bookingId.toLowerCase()) || null);
  if (selected.some((item) => !item) || selected.length === 0) {
    return respond(403, "CONFLICT", "Запись игрока не связана с этой игрой", ctx);
  }
  const selectedClientIds = Array.from(new Set(selected.map((item) => normalizeId(item.clientId)).filter(Boolean)));
  const selectedPhones = Array.from(new Set(selected.map((item) => normalizePhone(item.phone)).filter(Boolean)));
  if (selectedClientIds.length > 1 || selectedPhones.length > 1) {
    return respond(409, "CONFLICT", "Запрос затрагивает несколько участников", ctx);
  }
  targetClientId = selected[0].clientId;
  targetPhone = selected[0].phone;
  targetPayments = Array.from(new Set(selected.map((item) => item.payment)));
  verifiedQueue = uniqBookingItems(selected);
} else {
  const bookingItems = [];
  actorPayments.filter((payment) => !inactiveStatus(payment.status)).forEach((payment) => {
    asArray(payment.bookingIds).forEach((bookingId) => bookingItems.push({
      bookingId,
      clientId: toStr(payment.clientId || payment.playerId || payment.userId || ctx.actorClientId),
    }));
    bookingItems.push({
      bookingId: payment.bookingId,
      clientId: toStr(payment.clientId || payment.playerId || payment.userId || ctx.actorClientId),
    });
  });
  [...actorParticipants, ...actorWaitlist].filter((member) => !inactiveStatus(member.status)).forEach((member) => {
    asArray(member.bookingIds).forEach((bookingId) => bookingItems.push({
      bookingId,
      clientId: toStr(member.clientId || member.playerId || member.userId || member.id || ctx.actorClientId),
    }));
    bookingItems.push({
      bookingId: member.bookingId || member.vivaBookingId,
      clientId: toStr(member.clientId || member.playerId || member.userId || member.id || ctx.actorClientId),
    });
  });
  if (actorIsOrganizer) {
    bookingItems.push({ bookingId: splitPayment.organizerBookingId, clientId: toStr(ctx.actorClientId) });
    asArray(game.booking?.bookingIds).forEach((bookingId) => bookingItems.push({
      bookingId,
      clientId: toStr(ctx.actorClientId),
    }));
    bookingItems.push({ bookingId: game.booking?.bookingId, clientId: toStr(ctx.actorClientId) });
  }
  verifiedQueue = uniqBookingItems(bookingItems);
}

const targetId = normalizeId(targetClientId);
const targetPhoneNorm = normalizePhone(targetPhone);
if (phoneIdentityAmbiguous(identityRecords, targetId, targetPhoneNorm)) {
  return respond(409, "CONFLICT", "Телефон участника связан с несколькими профилями игры", ctx);
}
const targetIsOrganizer = matchesActor(game.organizer, targetId, targetPhoneNorm)
  || matchesActor({ id: metadata.organizerId, phone: metadata.organizerPhoneNorm || metadata.organizerPhone }, targetId, targetPhoneNorm);
if (mode === "ORGANIZER_TARGET" && targetIsOrganizer) {
  return respond(409, "CONFLICT", "Организатор не может удалить себя через participant leave", ctx);
}
const targetParticipants = asArray(game.participants).filter((item) => matchesActor(item, targetId, targetPhoneNorm));
const targetWaitlist = asArray(game.waitlist).filter((item) => matchesActor(item, targetId, targetPhoneNorm));
const targetJoinResponse = isObj(metadata.joinResponses) && targetPhoneNorm
  && isObj(metadata.joinResponses[targetPhoneNorm])
  && !inactiveStatus(metadata.joinResponses[targetPhoneNorm].status)
  ? metadata.joinResponses[targetPhoneNorm]
  : null;
const activeTargetPayments = targetPayments.filter((item) => !inactiveStatus(item.status));
const activeTargetParticipants = targetParticipants.filter((item) => !inactiveStatus(item.status));
const activeTargetWaitlist = targetWaitlist.filter((item) => !inactiveStatus(item.status));
const canonicalMembershipVersion = stableVersion([
  ...activeTargetPayments.flatMap((item) => [
    item.membershipId,
    ...asArray(item.bookingIds),
    item.bookingId,
    item.paymentRef,
  ]),
  ...activeTargetParticipants.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  ...activeTargetWaitlist.flatMap((item) => [item.membershipId, item.bookingId, item.paymentRef]),
  targetJoinResponse?.membershipId,
  targetJoinResponse?.paymentRef,
]);
if (mode === "SELF") {
  if (canonicalMembershipVersion) {
    ctx.membershipVersion = canonicalMembershipVersion;
    ctx.operationId = `self-leave:${ctx.gameId}:${ctx.actorClientId || ctx.actorPhoneNorm}:${canonicalMembershipVersion}`;
  } else {
    const appliedOperationId = targetPayments.map((item) => toStr(item.leaveOperationId)).find(Boolean);
    if (appliedOperationId) {
      ctx.operationId = appliedOperationId;
      ctx.membershipVersion = appliedOperationId.split(":").pop() || null;
    } else {
      ctx.membershipVersion = null;
    }
  }
}
if (mode === "ORGANIZER_TARGET") {
  if (canonicalMembershipVersion) {
    ctx.membershipVersion = canonicalMembershipVersion;
    ctx.operationId = `organizer-leave:${ctx.gameId}:${ctx.actorClientId || ctx.actorPhoneNorm}:${targetClientId || targetPhoneNorm}:${canonicalMembershipVersion}`;
  } else {
    const appliedOperationId = targetPayments.map((item) => toStr(item.leaveOperationId)).find(Boolean);
    ctx.operationId = appliedOperationId || ctx.operationId;
    ctx.membershipVersion = appliedOperationId?.split(":").pop() || null;
  }
}

const leaveOperations = asArray(metadata.leaveOperations).filter(isObj);
const auditRows = asArray(metadata.selfRemovalAuditLog).filter(isObj);
const operationApplied = leaveOperations.some((item) => toStr(item.operationId) === toStr(ctx.operationId) && item.state === "DONE")
  || auditRows.some((item) => toStr(item.operationId) === toStr(ctx.operationId));
const targetActive = targetIsOrganizer
  || targetParticipants.some((item) => !inactiveStatus(item.status))
  || targetWaitlist.some((item) => !inactiveStatus(item.status))
  || targetPayments.some((item) => !inactiveStatus(item.status));
const previouslyApplied = operationApplied || (!targetActive && targetPayments.some((item) => (
  inactiveStatus(item.status) && (toStr(item.leftAt) || toStr(item.cancelledAt))
)));
const exerciseId = toStr(
  splitPayment.vivaExerciseId
  || game.booking?.vivaExerciseId
  || game.booking?.exerciseId
  || metadata.vivaExerciseId
  || metadata.exerciseId,
);
if (!previouslyApplied && (
  !exerciseId
  || !targetId
  || (mode === "ORGANIZER_TARGET" && !ctx.membershipVersion)
  || (mode !== "SELF" && verifiedQueue.length === 0)
)) {
  return respond(409, "CONFLICT", "Не удалось однозначно связать профиль, игру и запись Viva", ctx);
}

const upstreamAuthHeader = mode === "SELF"
  ? toStr(ctx.actorAuthHeader)
  : (toStr(global.get("vivacrm_access_token")) ? `Bearer ${toStr(global.get("vivacrm_access_token"))}` : null);
if (!previouslyApplied && !upstreamAuthHeader) {
  return respond(503, "CONFLICT", "Viva временно недоступна", ctx);
}

ctx.game = game;
ctx.exerciseId = exerciseId;
ctx.bookingQueue = verifiedQueue.map((item) => ({ ...item }));
ctx.initialBookingIds = verifiedQueue.map((item) => item.bookingId);
ctx.needsBookingDiscovery = mode === "SELF" && verifiedQueue.length === 0;
ctx.preOperationDiscovery = ctx.needsBookingDiscovery;
ctx.bookingResults = [];
const subscriptionInstanceIds = Array.from(new Set(
  targetPayments
    .map((item) => toStr(item.clientSubscriptionId || item.subscriptionProductId))
    .filter(Boolean),
));
const subscriptionVisitCounts = Array.from(new Set(
  targetPayments
    .map((item) => Number(item.subscriptionVisitCount))
    .filter((value) => Number.isSafeInteger(value) && value > 0),
));
ctx.clientSubscriptionId = subscriptionInstanceIds.length === 1 ? subscriptionInstanceIds[0] : null;
ctx.subscriptionVisitCount = subscriptionVisitCounts.length === 1 ? subscriptionVisitCounts[0] : null;
ctx.upstreamAuthHeader = upstreamAuthHeader;
ctx.localAlreadyApplied = previouslyApplied;
ctx.targetClientId = targetClientId;
ctx.targetPhoneNorm = targetPhoneNorm;
ctx.targetWasOrganizer = targetIsOrganizer;
ctx.step = previouslyApplied
  ? "local_apply"
  : (ctx.needsBookingDiscovery ? "start_verify_active" : "start_cancel");
msg._splitLeaveCtx = ctx;
delete msg.statusCode;
delete msg._splitCleanupAuth;
msg.payload = undefined;
if (previouslyApplied) {
  ctx.operationKey = `${ctx.gameId}:${ctx.operationId}`;
  msg._splitLeaveCtx = ctx;
  msg.payload = { _id: ctx.operationKey };
  return [null, null, null, null, msg];
}
if (!previouslyApplied && ctx.needsBookingDiscovery) return [null, null, null, msg];
return [msg, null, null, null, null];
