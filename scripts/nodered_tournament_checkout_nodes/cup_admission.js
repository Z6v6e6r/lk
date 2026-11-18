// Embedded in both LK1 server writers. Only CUP evaluates player levels.
const CUP_TOURNAMENT_API = "https://padlhub.su/api";
const CUP_TOURNAMENT_ALLOWED = new Set([
  "LEVEL_NOT_RESTRICTED", "LEVEL_ALLOWED", "LEVEL_ALLOWED_WITH_TOLERANCE",
]);
const CUP_TOURNAMENT_DENIED = new Set([
  "LEVEL_NOT_ALLOWED", "PLAYER_LEVEL_REQUIRED", "PLAYER_LEVEL_UNKNOWN",
  "LEVEL_CHECK_UNAVAILABLE", "ACTIVITY_LEVEL_INVALID",
]);

const cupTournamentDecisionUrl = (exerciseId) =>
  CUP_TOURNAMENT_API + "/tournaments/" + encodeURIComponent(exerciseId) + "/level-decision";

const readCupTournamentDecision = (response, actor, exercise) => {
  const body = response.payload;
  const url = cupTournamentDecisionUrl(exercise);
  const unavailable = { status: 503, code: "TOURNAMENT_LEVEL_CHECK_UNAVAILABLE",
    message: "Не удалось подтвердить допуск к турниру. Повторите попытку." };
  if (response.error || response.method !== "GET" || response.url !== url
    || response.followRedirects !== false || response.maxRedirects !== 0
    || (response.responseUrl !== undefined && response.responseUrl !== url)) return unavailable;
  if (response.statusCode === 409 && body?.code === "TOURNAMENT_RULE_CHANGED") {
    return { status: 409, code: body.code, message: "Правила турнира изменились. Обновите страницу." };
  }
  if (response.statusCode !== 200 || body?.enforced !== true || body.mode !== "ENFORCE"
    || body.actorClientId !== actor || body.exerciseId !== exercise
    || typeof body.tournamentId !== "string" || !body.tournamentId
    || typeof body.ruleVersion !== "string" || !body.ruleVersion) return unavailable;
  if (body.allowed === true && CUP_TOURNAMENT_ALLOWED.has(body.reasonCode)) {
    return { admission: { actor, exercise, tournamentId: body.tournamentId, ruleVersion: body.ruleVersion,
      evaluatedAt: new Date().toISOString() } };
  }
  if (body.allowed === false && CUP_TOURNAMENT_DENIED.has(body.reasonCode)) {
    return { status: body.reasonCode === "LEVEL_CHECK_UNAVAILABLE" ? 503 : 403, code: body.reasonCode,
      message: typeof body.message === "string" && body.message.length <= 500 ? body.message : unavailable.message };
  }
  return unavailable;
};
