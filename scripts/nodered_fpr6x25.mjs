import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourcePath = fileURLToPath(new URL("../src/components/tournaments/fpr6x25.ts", import.meta.url));
export const FPR_PREFIX_END = "// END FPR_6X25_DISPATCH_V1\n";

// The live legacy suffix is preserved byte-for-byte. No unrelated tournament logic
// is regenerated from the repository's possibly older Node-RED snapshot.
export function buildFprNodeFunction(legacySource, kind) {
  if (!["prepare", "recalculate", "history_guard"].includes(kind)) throw new Error("Unknown FPR node kind");
  if (legacySource.includes("FPR_6X25_DISPATCH_V1")) throw new Error("FPR dispatch is already installed; use an exact reviewed upgrade");
  if (kind === "history_guard") return `// FPR_6X25_DISPATCH_V1 (history_guard)
// A fresh FPR readback must observe the committed revision. The legacy rate
// limiter and response handling below remain byte-identical.
{
  const query = msg.req?.query || {};
  const id = String(query.tournamentId || "").trim();
  if (/^fpr-[a-f0-9-]{36}$/.test(id) && String(query.readback || "").trim()) {
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
    if (!/^fpr-[a-f0-9-]{36}$/.test(input.tournamentId) || input.tournamentId !== fprBody.tournamentId
      || input.revision !== 0 || input.status !== "ready" || input.withdrawals.length) throw new Error("FPR_CREATE_REQUIRES_NEW_ID");
    const state = fpr.createFprState({
      tournamentId: input.tournamentId,
      players: input.players.map(({id,name,level,leaguePoints,leaguePlace}) => ({id,name,level,leaguePoints,leaguePlace})),
      courts: input.courts, leagueSource: input.leagueSource, now: input.leagueSnapshotAt,
      endsAt: input.endsAt, reserveAllowed: input.reserveAllowed, testMode: input.testMode,
    });
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
    if (JSON.stringify(stable(state)) !== JSON.stringify(stable(input))) throw new Error("FPR_INITIAL_PROTOCOL_MISMATCH");
    if (Date.parse(state.leagueSnapshotAt) > Date.now() + 60000 || Date.parse(state.endsAt) <= Date.now()) throw new Error("FPR_CREATE_TIME_INVALID");
    const participants = Array.isArray(fprBody.participants) ? fprBody.participants : [];
    if (participants.length !== state.players.length || new Set(participants.map(p => p.id)).size !== state.players.length
      || participants.some(p => !state.players.some(player => player.id === p.id))) throw new Error("FPR_ROSTER_MISMATCH");
    const projected = fpr.fprProjection(state, fprBody.params);
    const document = {
      tournamentId: state.tournamentId, tournamentType: "fpr_6x25", tenantKey: fprBody.tenantKey || null,
      organizer: fprBody.organizer || {}, participants, targetScore: 25, courts: state.courts,
      createdAt: state.leagueSnapshotAt, updatedAt: new Date().toISOString(), startRatingChanges: [], ...projected,
    };
    // Built-in _id uniqueness makes retries insert-only and forbids replacing an
    // existing/started document, even where tournamentId has no unique index.
    msg.query = { _id: "fpr6x25:" + state.tournamentId, "params.fpr6x25": state };
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
if (fprTournament?.tournamentType === "fpr_6x25") {
  ${engine}
  try {
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
    msg.mongoQuery = { tournamentId: fprTournament.tournamentId, "params.fpr6x25.revision": previous.revision };
    if (fprTournament._id) msg.mongoQuery._id = fprTournament._id;
    msg.mongoUpdate = { $set: { ...projected, startRatingChanges: [], updatedAt: new Date().toISOString() } };
    msg.statusCode = 200;
    msg.payload = { tournamentId: state.tournamentId, ...projected };
    return msg;
  } catch (error) {
    delete msg.query; delete msg.mongoQuery; delete msg.mongoUpdate;
    msg.statusCode = ["FPR_REVISION_CONFLICT", "FPR_COMMAND_ID_REUSED"].includes(error.message) ? 409 : 422;
    msg.payload = { error: msg.statusCode === 409 ? error.message : "FPR_COMMAND_INVALID",
      message: String(error.message || "Некорректная команда ФПР"), retryable: msg.statusCode === 409 };
    return msg;
  }
}
`;
  return `// FPR_6X25_DISPATCH_V1 (${kind})\n${kind === "prepare" ? prepare : recalculate}${FPR_PREFIX_END}${legacySource}`;
}
