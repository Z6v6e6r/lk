const task = msg._organizerCleanupTask;
const game = Array.isArray(msg.payload) ? msg.payload.find(row => row?.id === task?.gameId) : null;
const fail = message => { msg.statusCode = 409; msg.payload = { ok: false, code: "ORGANIZER_TRANSFER_REQUIRED", error: message }; return [null, msg]; };
const id = value => String(value || "").trim().toLowerCase();
const actorId = id(msg._splitCleanupAuth?.actorClientId);
if (msg.error || !task || !game || !actorId || id(game.organizer?.id || game.organizer?.clientId) !== actorId) return fail("Только текущий организатор может отменить игру");
const key = `cancel:${task.gameId}:${actorId}`;
const marker = game.membershipMutation;
if (!marker && (!task.expectedUpdatedAt || task.expectedUpdatedAt !== game.updatedAt)) return fail("Запись игры изменилась. Обновите игру перед отменой");
if (marker && (marker.operationKey !== key || marker.executorActive !== false)) return fail("Отмена ещё выполняется. Дождитесь подтверждения перед повтором");
const rows = [...(game.participants || []), ...(game.waitlist || []), ...(game.metadata?.splitPayment?.payments || [])];
if (rows.some(row => !/CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|CLOSE|ARCHIVE|LEFT|REMOV/i.test(String(row?.status || ""))
  && id(row?.clientId || row?.playerId || row?.userId || row?.id) !== actorId)) return fail("Передайте роль организатора другому участнику");
if (marker && (marker.task?.preferredRefundMethod !== task.preferredRefundMethod
  || marker.task?.cancellationActionId !== task.cancellationActionId
  || marker.task?.actorBookingId !== task.actorBookingId)) return fail("Отмена уже начата с другими параметрами. Повторите исходный вариант возврата");
msg._organizerCleanupTask = marker?.task || task;
msg._organizerCleanupKey = key;
const query = { id: game.id, organizer: game.organizer, updatedAt: game.updatedAt ?? { $exists: false },
  membershipMutation: marker || { $exists: false } };
const executorToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
msg._organizerCleanupExecutor = executorToken;
msg.payload = [query, { $set: { membershipMutation: { ...(marker || { operationKey: key, kind: "CANCEL", startedAt: new Date().toISOString(), task }), executorActive: true, executorToken } } }, { upsert: false }];
return [msg, null];
