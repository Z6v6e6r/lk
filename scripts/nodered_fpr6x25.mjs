import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourcePath = fileURLToPath(new URL("../src/components/tournaments/fpr6x25.ts", import.meta.url));
export const FPR_PREFIX_END = "// END FPR_6X25_DISPATCH_V1\n";

// The live legacy suffix is preserved byte-for-byte. No unrelated tournament logic
// is regenerated from the repository's possibly older Node-RED snapshot.
export function buildFprNodeFunction(legacySource, kind) {
  if (!["prepare", "recalculate", "history_guard", "community_context", "broadcast_route", "create_ack", "history_response"].includes(kind)) throw new Error("Unknown FPR node kind");
  if (legacySource.includes("FPR_6X25_DISPATCH_V1")) throw new Error("FPR dispatch is already installed; use an exact reviewed upgrade");
  if (kind === "history_response") return `// FPR_6X25_DISPATCH_V1 (history_response)
if (msg._fprHistoryError) {
  msg.statusCode = 409;
  msg.payload = msg._fprHistoryError;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  delete msg._fprHistoryError;
  delete msg._tournamentHistoryCacheKey;
  return msg;
}
${FPR_PREFIX_END}${legacySource}`;
  if (kind === "create_ack") return `// FPR_6X25_DISPATCH_V1 (create_ack)
// Insert-only FPR and protected generic creates must not acknowledge a noop as
// the incoming protocol. A client reconciles retries through authoritative GET.
if (msg._eventCreateGuard && msg.payload?.acknowledged === true
    && Number(msg.payload.modifiedCount || 0) === 0 && Number(msg.payload.upsertedCount || 0) === 0 && !msg.payload.upsertedId) {
  delete msg._tournamentLegacySuccessPayload;
  msg.statusCode = 409;
  msg.payload = { error: "TOURNAMENT_ALREADY_EXISTS", message: "Турнир уже сохранён. Откройте его из списка.", retryable: false };
  return msg;
}
${FPR_PREFIX_END}${legacySource}`;
  if (kind === "broadcast_route") return `// FPR_6X25_DISPATCH_V1 (broadcast_route)
{
  const context = msg._tournamentBroadcast;
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const tournament = rows.find(row => row && typeof row === "object" && !Array.isArray(row)
    && String(row.tournamentId ?? "").trim() === context?.tournamentId);
  // A FPR creator controls their protocol metadata. Controlling a physical screen
  // requires the existing server-verified global tournament-host permission.
  // Status retains the legacy ownership check. A staff member can stop a session
  // through the existing saved-station recovery path, including after a timeout.
  if (["start", "stop"].includes(context?.action) && tournament?.tournamentType === "fpr_6x25" && context.hasHostingAccess !== true) {
    msg.statusCode = 403;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    msg.payload = { ok: false, code: "FPR_BROADCAST_HOST_ACCESS_REQUIRED", message: "Управлять трансляцией ФПР может сотрудник с доступом к проведению турниров" };
    return [null, null, msg];
  }
}
${FPR_PREFIX_END}${legacySource}`;
  if (kind === "community_context") return `// FPR_6X25_DISPATCH_V1 (community_context)
{
  const id = String(msg.req?.query?.tournamentId || "").trim();
  const contextOnly = String(msg.req?.query?.fprCommunityContext || "") === "1";
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const matches = rows.filter(row => row?.tournamentType === "fpr_6x25"
    && (row.tournamentId === id || row.params?.fpr6x25?.communityRating?.sourceExerciseId === id || row.params?.sourceExerciseId === id));
  // Do not silently choose the newest of two real results for a single event.
  const exact = rows.filter(row => row?.tournamentId === id);
  const inconsistent = matches.some(row => row.params?.sourceExerciseId && row.params?.fpr6x25?.communityRating?.sourceExerciseId
    && row.params.sourceExerciseId !== row.params.fpr6x25.communityRating.sourceExerciseId);
  if (!contextOnly && (inconsistent || matches.length > 1 || matches.length && exact.some(row => row !== matches[0]))) {
    msg._fprHistoryError = { error: "TOURNAMENT_EVENT_AMBIGUOUS", message: "У события несколько записей результатов. Требуется проверка организатора." };
    msg.payload = [];
    delete msg._tournamentHistoryCacheKey;
  }
  if (!contextOnly && matches.length === 1) msg.payload = [matches[0]];
  if (contextOnly) {
    msg.payload = [{ tournamentId: id, communityContextOnly: true }];
    delete msg._tournamentHistoryCacheKey;
  }
}
{
  const sourceRows = msg.payload;
  msg.payload = Array.isArray(sourceRows) ? sourceRows.map(row => row?.tournamentType === "fpr_6x25"
    ? { ...row, tournamentId: row.params?.fpr6x25?.communityRating?.sourceExerciseId || row.params?.sourceExerciseId || row.tournamentId } : row) : [];
  const result = (() => {
${legacySource}
})();
  if (result?._tournamentCommunityContext) result._tournamentCommunityContext.sourceRows = sourceRows;
  return result;
}
${FPR_PREFIX_END}${legacySource}`;
  if (kind === "history_guard") return `// FPR_6X25_DISPATCH_V1 (history_guard)
// A fresh FPR readback must observe the committed revision. The legacy rate
// limiter and response handling below remain byte-identical.
{
  const query = msg.req?.query || {};
  const id = String(query.tournamentId || "").trim();
  const contextOnly = String(query.fprCommunityContext || "") === "1";
  if (typeof query.tournamentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    msg.statusCode = 422; msg.payload = { error: "INVALID_TOURNAMENT_ID" }; return [msg, null];
  }
  if (contextOnly || String(query.readback || "").trim()) {
    const cache = flow.get("lkTournamentHistoryResponseCache") || {};
    delete cache["id:" + id];
    flow.set("lkTournamentHistoryResponseCache", cache);
  }
}
${FPR_PREFIX_END}${legacySource}`;
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const engine = `const fpr = (() => { const exports = {};\n${compiled}\nreturn exports; })();`;
  const prepare = `
const fprBody = msg.payload || {};
if (fprBody.tournamentType === "fpr_6x25") {
  ${engine}
  try {
    const input = fprBody.params?.fpr6x25;
    fpr.validateFprState(input);
    if (fprBody.params?.sourceExerciseId && input.communityRating?.sourceExerciseId && fprBody.params.sourceExerciseId !== input.communityRating.sourceExerciseId) throw new Error("FPR_SOURCE_MISMATCH");
    if ((!/^fpr-[a-f0-9-]{36}$/.test(input.tournamentId) && input.tournamentId !== input.communityRating?.sourceExerciseId) || input.tournamentId !== fprBody.tournamentId
      || input.revision !== 0 || input.status !== "ready" || input.withdrawals.length) throw new Error("FPR_CREATE_REQUIRES_NEW_ID");
    const state = fpr.createFprState({
      tournamentId: input.tournamentId,
      players: input.players.map(({id,name,level,leaguePoints,leaguePlace}) => ({id,name,level,leaguePoints,leaguePlace})),
      courts: input.courts, leagueSource: input.leagueSource, now: input.leagueSnapshotAt,
      endsAt: input.endsAt, reserveAllowed: input.reserveAllowed, testMode: input.testMode, communityRating: input.communityRating,
    });
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
    if (JSON.stringify(stable(state)) !== JSON.stringify(stable(input))) throw new Error("FPR_INITIAL_PROTOCOL_MISMATCH");
    if (Date.parse(state.leagueSnapshotAt) > Date.now() + 60000 || Date.parse(state.endsAt) <= Date.now() + 180000) throw new Error("FPR_CREATE_TIME_INVALID");
    const participants = Array.isArray(fprBody.participants) ? fprBody.participants : [];
    if (participants.length !== state.players.length || new Set(participants.map(p => p.id)).size !== state.players.length
      || participants.some(p => !state.players.some(player => player.id === p.id))) throw new Error("FPR_ROSTER_MISMATCH");
    const projected = fpr.fprProjection(state, fprBody.params);
    delete projected.params.broadcast;
    const document = {
      tournamentId: state.tournamentId, tournamentType: "fpr_6x25", tenantKey: fprBody.tenantKey || null,
      organizer: fprBody.organizer || {}, participants, targetScore: 25, courts: state.courts,
      createdAt: state.leagueSnapshotAt, updatedAt: new Date().toISOString(), startRatingChanges: [], ...projected,
    };
    const sourceId = state.communityRating?.sourceExerciseId;
    const linked = Boolean(sourceId);
    // All new event creates use the same deterministic _id across mechanics.
    // Match ANY existing event and leave it untouched, rather than filtering an
    // unsafe existing state out of an upsert and inserting a second document.
    msg.query = linked ? { $or: [{ tournamentId: sourceId }, { tournamentType: "fpr_6x25", "params.sourceExerciseId": sourceId }, { tournamentType: "fpr_6x25", "params.fpr6x25.communityRating.sourceExerciseId": sourceId }] } : { _id: "fpr6x25:" + state.tournamentId, "params.fpr6x25": state };
    if (linked) document._id = "tournament:" + sourceId;
    msg._eventCreateGuard = true;
    msg.payload = { $setOnInsert: document };
    msg._tournamentLegacySuccessPayload = { tournamentId: state.tournamentId, ...projected };
    msg.statusCode = 200;
    return [msg, null];
  } catch (error) {
    delete msg.query; delete msg.mongoQuery; delete msg.mongoUpdate;
    msg.statusCode = 422;
    msg.payload = { error: "FPR_CREATE_INVALID", message: String(error.message || "Некорректный протокол ФПР") };
    return [null, msg];
  }
}
`;
  const recalculate = `
const fprTournament = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
const fprRows = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
if (fprRows.length > 1 && fprRows.some(row => row?.tournamentType === "fpr_6x25")
  || msg.req?.body?.params?.fprCommand && (fprRows.length !== 1 || fprTournament?.tournamentType !== "fpr_6x25")) {
  delete msg.query; delete msg.mongoQuery; delete msg.mongoUpdate;
  msg.statusCode = 409;
  msg.payload = { error: "FPR_EVENT_AMBIGUOUS", message: "Не удалось однозначно найти ФПР этого события. Обновите турнир.", retryable: false };
  return msg;
}
if (fprTournament?.tournamentType === "fpr_6x25") {
  ${engine}
  try {
    if (Array.isArray(msg.payload) && msg.payload.length !== 1) throw new Error("FPR_EVENT_AMBIGUOUS");
    const previous = fprTournament.params?.fpr6x25;
    fpr.validateFprState(previous);
    if (previous.tournamentId !== fprTournament.tournamentId) throw new Error("FPR_TOURNAMENT_ID_MISMATCH");
    const body = msg.req?.body || {};
    if (Array.isArray(body.results) && body.results.length) throw new Error("FPR_COMMAND_REQUIRED");
    const command = body.params?.fprCommand;
    if (!command || typeof command !== "object") throw new Error("FPR_COMMAND_REQUIRED");
    const state = fpr.applyFprCommand(previous, command, new Date().toISOString());
    const projected = fpr.fprProjection(state, fprTournament.params);
    delete projected.params.fprCommand;
    const ownedParams = fpr.fprProjection(state, {}).params;
    const { params: ignoredParams, ...ownedFields } = projected;
    const update = { ...ownedFields, startRatingChanges: [], updatedAt: new Date().toISOString() };
    for (const key of ["fpr6x25", "tournamentFamily", "tournamentSubtype", "status", "state", "tournamentStatus", "finished", "isFinished", "tournamentFinished", "manualFinish", "finishedAt", "completedAt", "manualFinishedAt", "published", "totalRounds", "byePointsMode", "leagueResultStatus"]) {
      update["params." + key] = ownedParams[key];
    }
    msg.mongoQuery = { tournamentId: fprTournament.tournamentId, "params.fpr6x25.revision": previous.revision };
    if (fprTournament._id) msg.mongoQuery._id = fprTournament._id;
    msg.mongoUpdate = { $set: update };
    msg.statusCode = 200;
    msg.payload = { tournamentId: state.tournamentId, ...projected };
    return msg;
  } catch (error) {
    delete msg.query; delete msg.mongoQuery; delete msg.mongoUpdate;
    msg.statusCode = ["FPR_REVISION_CONFLICT", "FPR_COMMAND_ID_REUSED", "FPR_EVENT_AMBIGUOUS"].includes(error.message) ? 409 : 422;
    msg.payload = { error: msg.statusCode === 409 ? error.message : "FPR_COMMAND_INVALID",
      message: String(error.message || "Некорректная команда ФПР"), retryable: msg.statusCode === 409 };
    return msg;
  }
}
`;
  const genericCreate = kind === "prepare" ? `
// Preserve all installed generic preparation (monthly finalization guards etc.).
// Wrap only its prepared Mongo pipeline, preserving a FPR matched by event ID.
{
  const outputs = (() => {
${legacySource}
})();
  const prepared = outputs?.[0];
  if (prepared) {
    const id = prepared.query?.tournamentId;
    const envelope = prepared.payload;
    const update = Array.isArray(envelope) && envelope.length === 2 && Array.isArray(envelope[1]) ? envelope[1] : envelope;
    let pipeline = Array.isArray(update) ? update : null;
    if (!pipeline && update?.$set && update?.$setOnInsert) pipeline = [{ $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", { $literal: update.$set }, { createdAt: { $ifNull: ["$createdAt", { $literal: update.$setOnInsert.createdAt }] } }] } } }];
    if (!id || !pipeline || pipeline.some(stage => !stage.$replaceRoot?.newRoot && !stage.$replaceWith)) throw new Error("UNSUPPORTED_EVENT_CREATE_PIPELINE");
    prepared.payload = pipeline.map(stage => ({ $replaceRoot: { newRoot: { $cond: [
      { $or: [{ $eq: ["$tournamentType", "fpr_6x25"] }, { $ne: [{ $type: "$params.fpr6x25" }, "missing"] }] },
      "$$ROOT", stage.$replaceRoot?.newRoot || stage.$replaceWith,
    ] } } }));
    prepared.payload.push({ $set: { _id: { $ifNull: ["$_id", { $literal: "tournament:" + id }] } } });
    prepared.query = { $or: [{ tournamentId: id }, { tournamentType: "fpr_6x25", "params.sourceExerciseId": id }, { tournamentType: "fpr_6x25", "params.fpr6x25.communityRating.sourceExerciseId": id }] };
    prepared.payload = [prepared.query, prepared.payload];
    prepared._eventCreateGuard = true;
  }
  return outputs;
}
` : "";
  return `// FPR_6X25_DISPATCH_V1 (${kind})\n${kind === "prepare" ? prepare + genericCreate : recalculate}${FPR_PREFIX_END}${legacySource}`;
}
