const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const collectKnownPhones = (game) => {
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const splitPayment = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  const splitPayments = Array.isArray(splitPayment?.payments) ? splitPayment.payments : [];
  const participants = Array.isArray(game?.participants) ? game.participants : [];
  const waitlist = Array.isArray(game?.waitlist) ? game.waitlist : [];

  return uniq([
    normPhone(game?.organizer?.phoneNorm || game?.organizer?.phone),
    ...(Array.isArray(game?.allRelatedPhones) ? game.allRelatedPhones.map(normPhone) : []),
    ...(Array.isArray(game?.participantPhones) ? game.participantPhones.map(normPhone) : []),
    ...(Array.isArray(game?.waitlistPhones) ? game.waitlistPhones.map(normPhone) : []),
    ...(Array.isArray(game?.invitedPhones) ? game.invitedPhones.map(normPhone) : []),
    ...(Array.isArray(metadata?.allRelatedPhones) ? metadata.allRelatedPhones.map(normPhone) : []),
    ...(Array.isArray(metadata?.participantPhones) ? metadata.participantPhones.map(normPhone) : []),
    ...(Array.isArray(metadata?.waitlistPhones) ? metadata.waitlistPhones.map(normPhone) : []),
    ...participants.map((item) => normPhone(item?.phoneNorm || item?.phone || item?.mobile)),
    ...waitlist.map((item) => normPhone(item?.phoneNorm || item?.phone || item?.mobile)),
    ...splitPayments.map((item) => (
      isObj(item)
        ? normPhone(item.phoneNorm || item.phone || item.clientPhoneNorm || item.clientPhone)
        : null
    )),
  ]);
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const game = rows[0] || {};
const ctx = msg._chat || {};
const allPhones = collectKnownPhones(game);

if (allPhones.length > 0 && !allPhones.includes(ctx.senderPhone)) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Sender is not participant of this game" };
  return [null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const senderRole =
  normPhone(game?.organizer?.phoneNorm || game?.organizer?.phone) === ctx.senderPhone
    ? "ORGANIZER"
    : "PLAYER";

const messageDoc = {
  gameId: game.id,
  tenantKey: game.tenantKey || null,
  relatedPhones: allPhones,
  sender: {
    id: toStr(ctx.senderId),
    phoneNorm: ctx.senderPhone,
    name: toStr(ctx.senderName) || (senderRole === "ORGANIZER" ? (toStr(game?.organizer?.name) || "Организатор") : "Игрок"),
    role: senderRole,
  },
  type: ctx.type || "TEXT",
  text: ctx.text,
  createdAt: nowIso,
  createdTs: nowTs,
  editedAt: null,
  deleted: false,
};

msg._chatMessageDoc = messageDoc;
msg.payload = messageDoc;
return [msg, null, msg];
