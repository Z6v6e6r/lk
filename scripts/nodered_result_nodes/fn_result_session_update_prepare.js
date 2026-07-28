const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};
const asArray = (v) => (Array.isArray(v) ? v : []);
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const normalizeDraftScore = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return String(Math.round(numeric));
};
const normalizeSet = (item) => {
  if (!item || typeof item !== "object") return null;
  const left = normalizeDraftScore(item.left ?? item.teamA ?? item.a ?? item.scoreA ?? item.score1);
  const right = normalizeDraftScore(item.right ?? item.teamB ?? item.b ?? item.scoreB ?? item.score2);
  if (left === null || right === null) return null;
  return { left, right };
};
const normalizeRef = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    const raw = toStr(value);
    if (!raw) return null;
    return { memberKey: raw, id: null, phone: null, name: null };
  }
  if (typeof value !== "object") return null;
  return {
    memberKey: toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey),
    id: toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId),
    phone: normPhone(value.phone || value.phoneNorm || value.phoneNumber || value.mobile),
    name: toStr(value.name || value.fullName || value.title),
  };
};
const normalizePairing = (item, index) => {
  if (!item || typeof item !== "object") return null;
  const setIndexRaw = toNum(item.setIndex ?? item.index);
  const setNumberRaw = toNum(item.setNumber);
  const setIndex = Number.isInteger(setIndexRaw)
    ? setIndexRaw
    : Number.isInteger(setNumberRaw)
      ? setNumberRaw - 1
      : index;
  const rawSlots = asArray(item.teamSlots || item.slots || item.players || item.pairing);
  const teamSlots = Array.from({ length: 4 }, (_, slotIndex) => normalizeRef(rawSlots[slotIndex]));
  if (!teamSlots.some(Boolean)) return null;
  return { setIndex, teamSlots };
};
const normalizeActor = (value, fallbackPhone) => {
  if (!value || typeof value !== "object") {
    return {
      id: null,
      name: null,
      phoneNorm: fallbackPhone,
    };
  }
  return {
    id: toStr(value.id || value.clientId || value.uuid),
    name: toStr(value.name || value.fullName || value.title),
    phoneNorm: normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile) || fallbackPhone,
  };
};

const gameId = toStr(msg.req?.params?.gameId);
const sessionId = toStr(msg.req?.params?.sessionId);
if (!gameId || !sessionId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId and sessionId are required" };
  return [null, msg, msg];
}

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const trustedActor = msg._resultActor && typeof msg._resultActor === "object"
  ? normalizeActor(msg._resultActor, null)
  : null;
const phone = normPhone(
  trustedActor?.phoneNorm
  || body.phone
  || body.senderPhone
  || body.playerPhone
  || body.actor?.phone
  || body.openedBy?.phone
  || msg.req?.query?.phone,
);
const actor = trustedActor || normalizeActor(body.actor || body.submittedBy || body.openedBy, phone);
if (!actor.id && !phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "actor id or phone is required" };
  return [null, msg, msg];
}

const hasDraftSets = Object.prototype.hasOwnProperty.call(body, "draftSets") || Object.prototype.hasOwnProperty.call(body, "sets");
const hasDraftPairings = Object.prototype.hasOwnProperty.call(body, "draftPairings")
  || Object.prototype.hasOwnProperty.call(body, "setPairings")
  || Object.prototype.hasOwnProperty.call(body, "pairings");
const hasAttachments = Object.prototype.hasOwnProperty.call(body, "attachments")
  || Object.prototype.hasOwnProperty.call(body, "photos");

if (!hasDraftSets && !hasDraftPairings && !hasAttachments) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "No draft fields provided for session update" };
  return [null, msg, msg];
}

const expectedRevisionRaw = body.revision ?? body.expectedRevision;
const expectedRevision = expectedRevisionRaw === null || expectedRevisionRaw === undefined
  ? null
  : toNum(expectedRevisionRaw);
if (expectedRevisionRaw !== null && expectedRevisionRaw !== undefined && !Number.isInteger(expectedRevision)) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "revision must be an integer when provided" };
  return [null, msg, msg];
}

msg._resultSessionPatch = {
  gameId,
  sessionId,
  phone: actor.phoneNorm || phone,
  actor,
  expectedRevision,
  hasDraftSets,
  hasDraftPairings,
  hasAttachments,
  draftSets: hasDraftSets ? asArray(body.draftSets ?? body.sets).map(normalizeSet).filter(Boolean) : null,
  draftPairings: hasDraftPairings ? asArray(body.draftPairings ?? body.setPairings ?? body.pairings).map(normalizePairing).filter(Boolean) : null,
  attachments: hasAttachments ? asArray(body.attachments ?? body.photos) : null,
};
msg.payload = { _id: sessionId, gameId, deleted: { $ne: true } };
return [msg, null, msg];
