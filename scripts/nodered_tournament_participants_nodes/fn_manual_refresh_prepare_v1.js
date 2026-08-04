const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const VIVA_EXERCISE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toStr = (value) => {
  if (value === null || value === undefined || typeof value === "object") return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { error: code, code, message };
  return [null, msg];
};

const body = isObj(msg.payload) ? msg.payload : {};
const bodyExerciseId = toStr(body.exerciseId);
const queryExerciseId = toStr(msg.req?.query?.exerciseId);
if (bodyExerciseId && queryExerciseId && bodyExerciseId !== queryExerciseId) {
  return respond(400, "EXERCISE_ID_MISMATCH", "ID турнира в query и body не совпадают");
}
const exerciseId = bodyExerciseId || queryExerciseId;
if (!exerciseId || !VIVA_EXERCISE_UUID_RE.test(exerciseId)) {
  return respond(400, "EXERCISE_ID_INVALID", "Некорректный ID турнира");
}

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return respond(401, "AUTH_TOKEN_REQUIRED", "Необходимо войти в личный кабинет");
}

const requestedSize = Number(body.size ?? msg.req?.query?.size) || 100;
const size = Math.max(1, Math.min(Math.floor(requestedSize), 200));
msg._tournamentParticipantManualRefresh = {
  authorized: false,
  exerciseId,
  size,
};
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.requestTimeout = 4_500;
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;
return [msg, null];
