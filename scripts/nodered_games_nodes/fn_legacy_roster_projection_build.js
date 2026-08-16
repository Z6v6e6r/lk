const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const ctx = isObj(msg._legacyRosterBridge) ? msg._legacyRosterBridge : null;
const projection = isObj(msg._legacyRosterProjection) ? msg._legacyRosterProjection : null;
const paymentEvidence = isObj(msg._legacyPaymentEvidence) ? msg._legacyPaymentEvidence : null;
const fail = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  msg.payload = { code, error };
  return [null, null, msg];
};
if (!ctx || !projection || projection.legacyGameId !== ctx.gameId) {
  return fail(503, "LEGACY_ROSTER_PROJECTION_CONTEXT_INVALID", "Не удалось подготовить проекцию состава");
}
const game = asArray(msg.payload).find((item) => isObj(item) && toStr(item.id) === ctx.gameId);
if (!game) return fail(409, "LEGACY_GAME_NOT_FOUND", "Игра не найдена в legacy-проекции");

const metadata = isObj(game.metadata) ? { ...game.metadata } : {};
const bridgeMetadata = isObj(metadata.canonicalRosterProjection)
  ? { ...metadata.canonicalRosterProjection }
  : {};
const commandIds = uniq(asArray(bridgeMetadata.commandIds).map(toStr));
if (ctx.command === "CONFIRM_PAYMENT") {
  if (
    !paymentEvidence
    || toStr(paymentEvidence.bookingId) === null
    || normPhone(paymentEvidence.clientPhoneE164) !== normPhone(projection.player.phoneE164)
  ) {
    return fail(503, "LEGACY_PAYMENT_EVIDENCE_MISSING", "Не удалось применить проверенное подтверждение оплаты");
  }
  const splitPayment = isObj(metadata.splitPayment) ? { ...metadata.splitPayment } : {};
  const evidenceBookingId = toStr(paymentEvidence.bookingId);
  const evidenceOperationId = toStr(paymentEvidence.operationId);
  const evidencePhone = normPhone(paymentEvidence.clientPhoneE164);
  const payments = asArray(splitPayment.payments).filter(isObj);
  let matched = false;
  const nextPayments = payments.map((payment) => {
    const sameBooking = toStr(payment.bookingId) === evidenceBookingId
      || asArray(payment.bookingIds).map(toStr).includes(evidenceBookingId);
    const sameOperation = toStr(payment.transactionId) === evidenceOperationId;
    const paymentPhone = normPhone(payment.phoneNorm || payment.phone);
    const samePhone = evidencePhone && normPhone(payment.phoneNorm || payment.phone) === evidencePhone;
    if ((!sameBooking && !sameOperation) || (paymentPhone && !samePhone)) return payment;
    matched = true;
    return {
      ...payment,
      status: "PAID",
      bookingId: evidenceBookingId,
      bookingIds: uniq([...asArray(payment.bookingIds).map(toStr), evidenceBookingId]),
      transactionId: paymentEvidence.operationType === "TRANSACTION"
        ? evidenceOperationId
        : (toStr(payment.transactionId) || null),
      phone: evidencePhone,
      phoneNorm: evidencePhone,
      paidAt: toStr(paymentEvidence.verifiedAt) || new Date().toISOString(),
      verifiedBy: "VIVA_PROVIDER_LOOKUP",
    };
  });
  if (!matched) {
    nextPayments.push({
      role: "PARTICIPANT",
      status: "PAID",
      paymentRef: null,
      clientId: projection.player.userId,
      phone: evidencePhone,
      phoneNorm: evidencePhone,
      bookingId: evidenceBookingId,
      bookingIds: [evidenceBookingId],
      transactionId: paymentEvidence.operationType === "TRANSACTION" ? evidenceOperationId : null,
      amountMinor: Number.isSafeInteger(paymentEvidence.amountMinor) ? paymentEvidence.amountMinor : null,
      paidAt: toStr(paymentEvidence.verifiedAt) || new Date().toISOString(),
      verifiedBy: "VIVA_PROVIDER_LOOKUP",
    });
  }
  metadata.splitPayment = {
    ...splitPayment,
    enabled: true,
    status: "ACTIVE",
    bookingIds: uniq([...asArray(splitPayment.bookingIds).map(toStr), evidenceBookingId]),
    payments: nextPayments,
  };
  metadata.bookingIds = uniq([
    ...asArray(metadata.bookingIds).map(toStr),
    ...asArray(splitPayment.bookingIds).map(toStr),
    evidenceBookingId,
  ]);
}
const response = () => {
  const output = { ...msg };
  output.statusCode = projection.relation === "SEAT_RESERVED" ? 202 : 200;
  output.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  output.payload = {
    commandId: projection.commandId,
    replayed: projection.replayed || commandIds.includes(projection.commandId),
    projection,
  };
  delete output.error;
  return output;
};
if (commandIds.includes(projection.commandId)) return [null, response(), null];

const phoneNorm = normPhone(projection.player.phoneE164);
const samePlayer = (member) => {
  if (!isObj(member)) return false;
  const memberUserId = toStr(member.canonicalUserId || member.userId || member.id || member.clientId);
  const memberPhone = normPhone(member.phoneNorm || member.phone);
  return memberUserId === projection.player.userId || Boolean(phoneNorm && memberPhone === phoneNorm);
};
const withoutPlayer = (members) => asArray(members).filter((member) => !samePlayer(member));
const status = projection.relation === "PARTICIPANT"
  ? "CONFIRMED"
  : projection.relation === "WAITLISTED" ? "WAITLIST" : "PENDING";
const player = {
  id: projection.player.userId,
  userId: projection.player.userId,
  canonicalUserId: projection.player.userId,
  name: projection.player.displayName,
  phone: phoneNorm,
  phoneNorm,
  photo: null,
  rating: projection.player.levelLabel,
  ratingNumeric: projection.player.levelValue,
  source: "CANONICAL_ROSTER",
  status,
};
let participants = withoutPlayer(game.participants);
let waitlist = withoutPlayer(game.waitlist);
if (projection.relation === "PARTICIPANT") participants.push(player);
else waitlist.push(player);

const nowIso = new Date().toISOString();
const nextCommandIds = [...commandIds, projection.commandId].slice(-200);
const reservations = isObj(bridgeMetadata.reservations) ? { ...bridgeMetadata.reservations } : {};
if (projection.relation === "SEAT_RESERVED" && projection.reservationId) {
  reservations[projection.player.userId] = projection.reservationId;
} else {
  delete reservations[projection.player.userId];
}
metadata.canonicalRosterProjection = {
  version: 2,
  commandIds: nextCommandIds,
  lastCommandId: projection.commandId,
  canonicalGameId: projection.canonicalGameId,
  aggregateRevision: projection.aggregateRevision,
  relation: projection.relation,
  reservations,
  projectedAt: nowIso,
};
const snapshot = isObj(game.resultRosterSnapshot) ? { ...game.resultRosterSnapshot } : {};
const organizer = isObj(snapshot.organizer)
  ? snapshot.organizer
  : (isObj(game.organizer) ? game.organizer : null);
const allPlayers = [];
const allPlayerKeys = new Set();
const pushSnapshotPlayer = (member) => {
  if (!isObj(member)) return;
  const key = toStr(member.memberKey)
    || (toStr(member.canonicalUserId || member.userId || member.id || member.clientId)
      ? `id:${toStr(member.canonicalUserId || member.userId || member.id || member.clientId)}`
      : (normPhone(member.phoneNorm || member.phone) ? `phone:${normPhone(member.phoneNorm || member.phone)}` : null));
  if (!key || allPlayerKeys.has(key)) return;
  allPlayerKeys.add(key);
  allPlayers.push({ ...member, memberKey: key });
};
pushSnapshotPlayer(organizer);
participants.forEach(pushSnapshotPlayer);
waitlist.forEach(pushSnapshotPlayer);
asArray(snapshot.allPlayers || snapshot.playerPool).filter((member) => !samePlayer(member)).forEach(pushSnapshotPlayer);
const activeRoster = [];
if (snapshot.organizerInMatch === true && organizer) {
  const organizerKey = toStr(organizer.memberKey)
    || (toStr(organizer.canonicalUserId || organizer.userId || organizer.id || organizer.clientId)
      ? `id:${toStr(organizer.canonicalUserId || organizer.userId || organizer.id || organizer.clientId)}`
      : (normPhone(organizer.phoneNorm || organizer.phone) ? `phone:${normPhone(organizer.phoneNorm || organizer.phone)}` : null));
  const normalizedOrganizer = allPlayers.find((item) => item.memberKey === organizerKey);
  if (normalizedOrganizer) activeRoster.push(normalizedOrganizer);
}
participants.forEach((member) => {
  const key = toStr(member.memberKey)
    || `id:${toStr(member.canonicalUserId || member.userId || member.id || member.clientId)}`;
  const normalized = allPlayers.find((item) => item.memberKey === key);
  if (normalized && !activeRoster.some((item) => item.memberKey === key)) activeRoster.push(normalized);
});
const snapshotWaitlist = waitlist.map((member) => {
  const key = toStr(member.memberKey)
    || `id:${toStr(member.canonicalUserId || member.userId || member.id || member.clientId)}`;
  return allPlayers.find((item) => item.memberKey === key) || { ...member, memberKey: key };
});
const memberKeyMap = {};
allPlayers.forEach((member) => {
  if (member.memberKey) memberKeyMap[`member:${member.memberKey}`] = member.memberKey;
  const id = toStr(member.canonicalUserId || member.userId || member.id || member.clientId);
  const phone = normPhone(member.phoneNorm || member.phone);
  if (id) memberKeyMap[`id:${id}`] = member.memberKey;
  if (phone) memberKeyMap[`phone:${phone}`] = member.memberKey;
});
const maxPlayersRaw = Number(game.invite?.maxPlayers || snapshot.bookingContext?.maxPlayers);
const maxPlayers = Number.isFinite(maxPlayersRaw) && maxPlayersRaw > 0 ? Math.floor(maxPlayersRaw) : 4;
const resultRosterSnapshot = {
  ...snapshot,
  version: 3,
  schemaVersion: 3,
  canonical: true,
  source: "canonical_roster_bridge",
  capturedAt: nowIso,
  capturedAtTs: Date.now(),
  organizer,
  activeRoster: activeRoster.slice(0, maxPlayers),
  waitlist: snapshotWaitlist,
  allPlayers,
  playerPool: allPlayers,
  memberKeyMap,
  allowedPhoneNorms: uniq(allPlayers.map((member) => normPhone(member.phoneNorm || member.phone))),
  allowedClientIds: uniq(allPlayers.map((member) => toStr(member.canonicalUserId || member.userId || member.id || member.clientId))),
};
const auditEvent = {
  id: `g_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  at: nowIso,
  type: "CANONICAL_ROSTER_PROJECTED",
  source: "canonical_roster_bridge",
  payload: {
    commandId: projection.commandId,
    canonicalGameId: projection.canonicalGameId,
    aggregateRevision: projection.aggregateRevision,
    relation: projection.relation,
    userId: projection.player.userId,
    ...(paymentEvidence
      ? {
          paymentOperationType: toStr(paymentEvidence.operationType),
          paymentBookingId: toStr(paymentEvidence.bookingId),
        }
      : {}),
  },
};
const query = { id: ctx.gameId, archived: { $ne: true } };
if (Object.prototype.hasOwnProperty.call(game, "updatedAt")) query.updatedAt = game.updatedAt;
if (Number.isInteger(game.revision)) query.revision = game.revision;
msg._legacyRosterProjectionWrite = {
  response: response(),
  nextUpdatedAt: nowIso,
  nextRevision: Number.isInteger(game.revision) ? game.revision + 1 : null,
};
msg.payload = [
  query,
  {
    $set: {
      participants,
      waitlist,
      participantPhones: uniq(participants.map((member) => normPhone(member.phoneNorm || member.phone))),
      waitlistPhones: uniq(waitlist.map((member) => normPhone(member.phoneNorm || member.phone))),
      allRelatedPhones: uniq([
        ...asArray(game.allRelatedPhones).map(normPhone),
        normPhone(game.organizer?.phoneNorm || game.organizer?.phone),
        ...participants.map((member) => normPhone(member.phoneNorm || member.phone)),
        ...waitlist.map((member) => normPhone(member.phoneNorm || member.phone)),
      ]),
      metadata,
      resultRosterSnapshot,
      updatedAt: nowIso,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": auditEvent,
    },
    $push: { "audit.events": { $each: [auditEvent], $slice: -200 } },
    ...(Number.isInteger(game.revision) ? { $inc: { revision: 1 } } : {}),
  },
  { upsert: false },
];
return [msg, null, null];
