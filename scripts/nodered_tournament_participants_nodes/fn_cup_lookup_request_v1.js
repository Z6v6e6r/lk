const exerciseId =
  msg.participantCacheExerciseId ||
  msg.req?.query?.exerciseId ||
  msg.req?.query?.tournamentId ||
  msg.payload?.exerciseId ||
  msg.payload?.tournamentId;

if (!exerciseId) {
  msg.statusCode = 400;
  msg.headers = {
    ...(msg.headers || {}),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = { error: "exerciseId required" };
  return [null, msg];
}

const rawBase = (() => {
  try {
    return String(env.get("CUP_API_BASE_URL") || "").trim();
  } catch {
    return "";
  }
})();
const base = rawBase.replace(/\/+$/, "");
const validBase =
  /^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(base)
  || /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^\s?#]*)?$/i.test(base);
if (!validBase) {
  msg.statusCode = 503;
  msg.headers = {
    ...(msg.headers || {}),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = { error: "CUP_API_BASE_URL invalid" };
  return [null, msg];
}

msg.method = "GET";
msg.requestTimeout = 3_500;
msg.url = `${base}/tournaments/${encodeURIComponent(String(exerciseId).trim())}`;
msg.headers = { Accept: "application/json" };
return [msg, null];
