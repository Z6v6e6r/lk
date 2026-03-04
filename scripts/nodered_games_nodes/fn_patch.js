const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => Array.isArray(v) ? v : [];
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const nowIso = new Date().toISOString();
const setDoc = {};

const assignIfPresent = (key) => {
  if (Object.prototype.hasOwnProperty.call(body, key)) {
    setDoc[key] = body[key];
  }
};

["status", "chatUrl", "inviteUrl", "metadata", "settings", "payment", "invite", "archived"].forEach(assignIfPresent);

if (isObj(body.organizer)) {
  setDoc.organizer = Object.assign({}, body.organizer, {
    phone: normPhone(body.organizer.phone || body.organizer.phoneNumber || body.organizer.mobile),
    phoneNorm: normPhone(body.organizer.phone || body.organizer.phoneNumber || body.organizer.mobile),
  });
}

if (isObj(body.booking)) {
  const b = Object.assign({}, body.booking);
  const date = toStr(b.date);
  const timeFrom = toStr(b.timeFrom);
  const timeTo = toStr(b.timeTo);
  const toIso = (baseDate, baseTime, explicitIso) => {
    const iso = toStr(explicitIso);
    if (iso) return iso;
    if (!baseDate || !baseTime) return null;
    const normalizedTime = /^\d{2}:\d{2}$/.test(baseTime) ? `${baseTime}:00` : baseTime;
    return `${baseDate}T${normalizedTime}+03:00`;
  };
  const startIso = toIso(date, timeFrom, b.timeFromIso);
  const endIso = toIso(date, timeTo, b.timeToIso);

  b.timeFromIso = startIso;
  b.timeToIso = endIso;
  b.startTs = startIso ? Date.parse(startIso) : b.startTs;
  b.endTs = endIso ? Date.parse(endIso) : b.endTs;

  setDoc.booking = b;
}

const normalizePlayer = (p, fallbackSource) => {
  if (!isObj(p)) return null;
  return {
    id: toStr(p.id || p.clientId || p.userId || p.uuid),
    name: toStr(p.name || p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ")) || "Игрок",
    phone: normPhone(p.phone || p.phoneNumber || p.mobile),
    photo: toStr(p.photo || p.avatar || p.imageUrl),
    rating: toStr(p.rating || p.level || p.grade),
    source: toStr(p.source || fallbackSource || "INVITED"),
    status: toStr(p.status || "CONFIRMED"),
  };
};

if (Array.isArray(body.participants)) {
  setDoc.participants = body.participants.map((p) => normalizePlayer(p, "INVITED")).filter(Boolean);
}
if (Array.isArray(body.waitlist)) {
  setDoc.waitlist = body.waitlist.map((p) => normalizePlayer(p, "WAITLIST")).filter(Boolean);
}

const shouldRecalcPhones = isObj(body.organizer)
  || Array.isArray(body.participants)
  || Array.isArray(body.waitlist)
  || Array.isArray(body.invitedPhones)
  || Array.isArray(body.invites);

if (shouldRecalcPhones) {
  const organizerPhone = normPhone((setDoc.organizer || body.organizer || {}).phone);
  const participants = asArray(setDoc.participants || body.participants);
  const waitlist = asArray(setDoc.waitlist || body.waitlist);
  const participantPhones = uniq(participants.map((p) => normPhone(p.phone)));
  const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone)));
  const invitedPhones = uniq([
    ...asArray(body.invitedPhones).map((v) => normPhone(v)),
    ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),
  ]);

  setDoc.participantPhones = participantPhones;
  setDoc.waitlistPhones = waitlistPhones;
  setDoc.invitedPhones = invitedPhones;
  setDoc.allRelatedPhones = uniq([
    organizerPhone,
    ...participantPhones,
    ...waitlistPhones,
    ...invitedPhones,
  ]);
}

setDoc.updatedAt = nowIso;

if (Object.keys(setDoc).length === 1 && setDoc.updatedAt) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Empty patch" };
  return [null, msg, msg];
}

const dbMsg = Object.assign({}, msg, {
  query: { id: gameId, archived: { $ne: true } },
  payload: { $set: setDoc },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: Object.assign({ id: gameId }, setDoc),
});

return [dbMsg, responseMsg, responseMsg];
