if (msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1) {
  msg.statusCode = 409;
  msg.payload = { code: "GAME_PATCH_CONFLICT", error: "Игра изменилась. Обновите её перед сохранением." };
  return [msg, null];
}
const followup = { ...msg, payload: { id: msg._organizerPatchResponse?.id, archived: { $ne: true } }, _gameAutojoinPatch: msg._organizerPatchAutojoin };
msg.statusCode = 200;
msg.payload = msg._organizerPatchResponse;
return [msg, followup];
