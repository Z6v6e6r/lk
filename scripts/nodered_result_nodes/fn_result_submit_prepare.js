const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const toNum = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const toInt = (value) => {
  const numeric = toNum(value);
  return Number.isInteger(numeric) ? numeric : null;
};
const isAcceptableSetScore = (left, right) => {
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right < 0 || left === right) {
    return false;
  }
  return true;
};
const normalizeSet = (item) => {
  if (!item || typeof item !== "object") return null;
  const left = toInt(item.left ?? item.teamA ?? item.a ?? item.scoreA ?? item.score1);
  const right = toInt(item.right ?? item.teamB ?? item.b ?? item.scoreB ?? item.score2);
  if (left === null || right === null) return null;
  if (!isAcceptableSetScore(left, right)) return null;
  return { left, right };
};
const normalizeRef = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    const raw = toStr(value);
    return raw ? { memberKey: raw, id: null, phone: null, name: null } : null;
  }
  if (typeof value !== "object") return null;
  return {
    memberKey: toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey),
    id: toStr(value.id || value.clientId || value.uuid),
    phone: normPhone(value.phone || value.phoneNorm || value.phoneNumber || value.mobile),
    name: toStr(value.name || value.fullName || value.title),
  };
};
const normalizePairing = (item, index) => {
  if (!item || typeof item !== "object") return null;
  const setIndexRaw = toInt(item.setIndex ?? item.index);
  const setNumberRaw = toInt(item.setNumber);
  const setIndex = Number.isInteger(setIndexRaw)
    ? setIndexRaw
    : Number.isInteger(setNumberRaw)
      ? setNumberRaw - 1
      : index;
  if (setIndex < 0) return null;
  const rawSlots = asArray(item.teamSlots || item.slots || item.players || item.pairing);
  const teamSlots = Array.from({ length: 4 }, (_, slotIndex) => normalizeRef(rawSlots[slotIndex]));
  return teamSlots.every(Boolean) ? { setIndex, teamSlots } : null;
};

const gameId = toStr(msg.req?.params?.gameId);
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}
let tenantKey = null;
try { tenantKey = toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY")); } catch { tenantKey = null; }
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  msg.statusCode = 503;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result tenant is not configured", code: "LEGACY_GAME_TENANT_CONFIG_INVALID" };
  return [null, msg, msg];
}

const body = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};
const resultSession = (body.resultSession && typeof body.resultSession === "object") ? body.resultSession : {};
const rosterSnapshot = body.rosterSnapshot && typeof body.rosterSnapshot === "object"
  ? body.rosterSnapshot
  : (resultSession.rosterSnapshot && typeof resultSession.rosterSnapshot === "object"
    ? resultSession.rosterSnapshot
    : null);
const trustedActor = (msg._resultActor && typeof msg._resultActor === "object")
  ? msg._resultActor
  : null;
const actorHint = (body.submittedBy && typeof body.submittedBy === "object")
  ? body.submittedBy
  : (body.actor && typeof body.actor === "object" ? body.actor : {});
const actor = {
  id: toStr(
    trustedActor?.id
    || actorHint.id
    || actorHint.clientId
    || actorHint.uuid
    || actorHint.userId
    || actorHint.playerId,
  ),
  phoneNorm: normPhone(
    trustedActor?.phoneNorm
    || trustedActor?.phone
    || actorHint.phoneNorm
    || actorHint.phone
    || body.phone
    || body.senderPhone
    || body.playerPhone
    || msg.req?.query?.phone,
  ),
  name: toStr(trustedActor?.name || actorHint.name || actorHint.fullName || actorHint.title),
  verified: trustedActor?.verified === true,
};
const phone = actor.phoneNorm;
if (!actor.id && !phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "actor id or phone is required" };
  return [null, msg, msg];
}

const rawSets = asArray(body.sets || body.score?.sets);
const sets = rawSets.map(normalizeSet).filter(Boolean);
if (rawSets.length === 0 || sets.length !== rawSets.length) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "At least one valid set is required. Each set must contain non-negative integer scores and cannot end in a draw." };
  return [null, msg, msg];
}
const scoreA = sets.reduce((sum, setItem) => sum + setItem.left, 0);
const scoreB = sets.reduce((sum, setItem) => sum + setItem.right, 0);

const rawSetPairings = asArray(body.setPairings || body.pairings);
const setPairings = rawSetPairings
  .map(normalizePairing)
  .filter(Boolean);
if (setPairings.length !== rawSetPairings.length) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Each explicit set pairing must contain exactly four player references" };
  return [null, msg, msg];
}
const seenSetIndexes = new Set();
for (const pairing of setPairings) {
  if (pairing.setIndex >= sets.length) {
    msg.statusCode = 400;
    msg.headers = { "Content-Type": "application/json; charset=utf-8" };
    msg.payload = { error: "setPairings cannot reference a set outside submitted sets" };
    return [null, msg, msg];
  }
  if (seenSetIndexes.has(pairing.setIndex)) {
    msg.statusCode = 400;
    msg.headers = { "Content-Type": "application/json; charset=utf-8" };
    msg.payload = { error: "Each set can have at most one explicit pairing" };
    return [null, msg, msg];
  }
  seenSetIndexes.add(pairing.setIndex);
}
const idempotencyKey = toStr(body.idempotencyKey || body.requestId || body.clientMutationId);
if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/.test(idempotencyKey)) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "A canonical result idempotency key is required",
    code: "RESULT_IDEMPOTENCY_KEY_INVALID",
  };
  return [null, msg, msg];
}

msg._resultSubmit = {
  gameId,
  tenantKey,
  phone,
  actor,
  scoreA: Math.round(scoreA),
  scoreB: Math.round(scoreB),
  sets,
  setPairings,
  attachments: asArray(body.photos || body.attachments),
  idempotencyKey,
  sessionId: toStr(body.sessionId || resultSession.sessionId),
  sessionRevision: toNum(body.sessionRevision ?? resultSession.sessionRevision ?? resultSession.revision),
  rosterSnapshot,
};

msg.payload = { tenantKey, id: gameId, archived: { $ne: true } };
return [msg, null, msg];
