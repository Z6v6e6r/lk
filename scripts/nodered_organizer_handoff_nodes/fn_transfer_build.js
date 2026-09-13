const ctx = msg._organizerTransfer;
const fail = (message) => { msg.statusCode = 409; msg.payload = { ok: false, code: "ORGANIZER_TRANSFER_CONFLICT", message }; return [null, msg]; };
const game = Array.isArray(msg.payload) ? msg.payload.find(row => row?.id === ctx?.gameId) : null;
const id = value => String(value ?? "").trim().toLowerCase();
const memberId = row => id(row?.clientId || row?.playerId || row?.userId || row?.id);
const phone = value => { const digits = String(value || "").replace(/\D/g, ""); return digits.length === 10 ? `7${digits}` : digits.length === 11 && digits[0] === "8" ? `7${digits.slice(1)}` : digits; };
const active = row => row && !/CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV|PAYMENT_PENDING/i.test(String(row.status || ""));
if (msg.error || !ctx || !game || /CANCEL|ARCHIVE|REMOV|FINISH|COMPLETE/i.test(game.status || "")) return fail("Игра недоступна для передачи");
const organizerId = memberId(game.organizer);
const metadata = game.metadata && typeof game.metadata === "object" ? game.metadata : {};
if (!organizerId || organizerId !== ctx.actorId
  || (metadata.organizerId && id(metadata.organizerId) !== organizerId)) return fail("Передать роль может только текущий организатор");
if (ctx.successorId === organizerId) return fail("Выберите другого участника");
if (game.updatedAt !== ctx.expectedUpdatedAt || game.membershipMutation) return fail("Состав игры изменяется. Обновите игру и повторите передачу");
const participants = Array.isArray(game.participants) ? game.participants : [];
const candidates = participants.filter(row => memberId(row) === ctx.successorId && active(row));
if (candidates.length !== 1) return fail("Выбранный игрок больше не участвует в игре");
const successor = candidates[0];
const successorPhone = phone(successor.phoneNorm || successor.phone);
const identities = [game.organizer, ...participants, ...(Array.isArray(game.waitlist) ? game.waitlist : [])];
if (successorPhone && identities.some(row => memberId(row) && memberId(row) !== ctx.successorId
  && phone(row?.phoneNorm || row?.phone) === successorPhone)) return fail("Не удалось однозначно определить профиль участника");
const now = new Date().toISOString();
// Transfer authority only. Booking/payment ownership and the old organizer's membership stay intact.
const nextOrganizer = { ...successor, id: ctx.successorId };
const nextParticipants = participants.some(row => memberId(row) === organizerId)
  ? participants : [...participants, { ...game.organizer, status: "CONFIRMED" }];
const set = { organizer: nextOrganizer, participants: nextParticipants,
  "metadata.organizerId": nextOrganizer.id,
  "metadata.organizerPhone": successorPhone || null,
  "metadata.organizerPhoneNorm": successorPhone || null,
  "metadata.organizerInMatch": true,
  updatedAt: now };
if (game.resultRosterSnapshot && typeof game.resultRosterSnapshot === "object") {
  set["resultRosterSnapshot.organizer"] = nextOrganizer;
  set["resultRosterSnapshot.organizerInMatch"] = true;
}
const query = { id: ctx.gameId, archived: { $ne: true }, updatedAt: game.updatedAt,
  organizer: game.organizer, participants: game.participants || [], membershipMutation: { $exists: false } };
if (game.revision !== undefined) query.revision = game.revision;
const update = { $set: set, $push: { organizerTransfers: { $each: [{ actorId: ctx.actorId, successorId: ctx.successorId, at: now }], $slice: -100 } } };
if (Number.isSafeInteger(game.revision)) update.$inc = { revision: 1 };
msg.payload = [query, update, { upsert: false }];
return [msg, null];
