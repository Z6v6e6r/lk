const exerciseId =
  msg.participantCacheExerciseId ||
  msg.req?.query?.exerciseId ||
  msg.req?.query?.tournamentId ||
  msg.payload?.exerciseId ||
  msg.payload?.tournamentId;

if (!exerciseId) {
  msg.statusCode = 400;
  msg.payload = { error: "exerciseId required" };
  return [null, msg];
}

delete msg.error;
const token = global.get("vivacrm_access_token");
if (!token) {
  msg.statusCode = 401;
  msg.payload = { error: "VIVA_ADMIN_TOKEN missing" };
  return [null, msg];
}

msg.method = "GET";
const size = msg.participantSize || Math.max(1, Math.min(Number(msg.req?.query?.size) || 100, 200));
const safeExerciseId = encodeURIComponent(exerciseId);
const vivaBase = (() => {
  try {
    const value = String(env.get("VIVA_API_BASE_URL") || "").trim();
    if (value) return value.replace(/\/+$/, "");
  } catch { /* fall through */ }
  return "https://api.vivacrm.ru";
})();
msg.requestTimeout = 4_500;
msg.url =
  `${vivaBase}/api/v1/exercises/${safeExerciseId}/bookings` +
  `?showCancelled=false` +
  `&size=${encodeURIComponent(String(size))}` +
  `&sort=visitConfirmed%2Casc` +
  `&sort=client.lastName%2Casc`;
msg.headers = {
  Authorization: `Bearer ${token}`,
  "x-lk-participants-source": "viva-fallback",
};
return [msg, null];
