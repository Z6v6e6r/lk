const statusCode = Number(msg.statusCode) || 0;
const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const body = parse(msg.payload);
const exerciseId = String(msg.participantCacheExerciseId || "").trim();
const isObject = Boolean(body && typeof body === "object" && !Array.isArray(body));
const slug = isObject ? String(body.slug || "").trim() : "";
const lookupSucceeded = !msg.error && statusCode >= 200 && statusCode < 300 && isObject;
const matchesExercise = lookupSucceeded && exerciseId && [body.id, body.exerciseId].includes(exerciseId);
const isVivaOnly = matchesExercise && body.source === "VIVA"
  && !slug && !body.linkedCustomTournamentId && !body.publicUrl;
// This exact CUP runtime checks all custom lookup keys before reporting this miss.
const isSnapshotMiss = !msg.error && statusCode === 503 && isObject && exerciseId
  && body.statusCode === 503 && body.error === "Service Unavailable"
  && body.message === `Persisted tournament snapshot for ${exerciseId} is unavailable`;

if (isVivaOnly || isSnapshotMiss) return [null, msg, null];
if (!matchesExercise || !slug) {
  msg.statusCode = 502;
  msg.headers = {};
  msg.payload = { error: "Participants temporarily unavailable" };
  return [null, null, msg];
}

const rawBase = (() => {
  try {
    return String(env.get("CUP_API_BASE_URL") || "").trim();
  } catch {
    return "";
  }
})();
const base = rawBase.replace(/\/+$/, "");
msg.method = "GET";
msg.requestTimeout = 3_500;
msg.url = `${base}/tournaments/public/${encodeURIComponent(slug)}?format=json`;
msg.headers = { Accept: "application/json" };
return [msg, null, null];
