import fs from "node:fs";
import { isTournamentFinalized } from "./tournamentFinalization.mjs";
import { eventInstant, publicationStartTs, publicationIsPublic } from "../../src/services/community-rating/monthlyContract.ts";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const toRecords = value => Array.isArray(value) ? value : [];
const closedStatuses = ["completed", "finished", "closed", "done", "завершен", "завершён"];
export function tournamentClosedExpression() {
  const statuses = ["status", "state", "tournamentStatus"];
  const normalized = field => ({ $toLower: { $trim: { input: { $convert: { input: "$" + field, to: "string", onNull: "", onError: "" } } } } });
  const flags = ["finished", "isFinished", "tournamentFinished", "manualFinish"];
  const markers = ["finishedAt", "completedAt", "manualFinishedAt"];
  return { $or: ["", "params.", "summary."].flatMap(prefix => [
    ...statuses.map(field => ({ $in: [normalized(prefix + field), closedStatuses] })),
    ...flags.map(field => ({ $in: [normalized(prefix + field), ["1", "true"]] })),
    ...markers.map(field => ({ $ne: [{ $ifNull: ["$" + prefix + field, ""] }, ""] })),
  ]) };
}
export const TOURNAMENT_WRITE_FIELDS = ["_id", "updatedAt", "createdAt", "params", "summary", "rounds", "participants", "standings", "totals", "playerLogs", "startRatingChanges", "status", "state", "tournamentStatus", "archived", "cancelled", "canceled", "isPrivate", "published", "isPublished", "visibility", "finished", "isFinished", "tournamentFinished", "manualFinish", "finishedAt", "completedAt", "manualFinishedAt"];
export function buildTournamentWriteSnapshot(tournament) {
  return Object.fromEntries(TOURNAMENT_WRITE_FIELDS.map(key => [key, own(tournament, key) ? { value: key === "_id" || key.endsWith("At") ? tournament[key] : JSON.parse(JSON.stringify(tournament[key])) } : { missing: true }]));
}
export function tournamentWriteFilter(tournamentId, snapshot) {
  return { tournamentId, $and: Object.entries(snapshot).map(([key, state]) => state.missing ? { [key]: { $exists: false } } : { [key]: { $eq: state.value } }) };
}
export function planCommunityTournamentClose({ tournament, publications, ratingEvents = [], ratingStates = [], nowTs }) {
  const skip = reason => ({ close: false, reason });
  if (typeof tournament.tournamentId !== "string" || !tournament.tournamentId.trim()) return skip("MISSING_CANONICAL_TOURNAMENT_ID");
  if (!publicationIsPublic({ ...tournament, kind: "TOURNAMENT" })) return skip("NOT_ACTIVE");
  if (isTournamentFinalized(tournament)) return skip("ALREADY_FINISHED");
  const starts = publications.map(publicationStartTs);
  if (starts.length === 0 || starts.some(ts => ts == null) || new Set(starts).size !== 1) return skip("MISSING_OR_AMBIGUOUS_SCHEDULE");
  const actualStartTs = eventInstant(tournament.params?.actualStartedAt || tournament.actualStartedAt || tournament.createdAt);
  if (actualStartTs == null) return skip("MISSING_ACTUAL_START");
  const deadlineTs = Math.max(starts[0], actualStartTs) + 3 * 60 * 60 * 1000;
  if (deadlineTs > nowTs) return skip("NOT_DUE");
  if (ratingEvents.length > 0) return skip("EXISTING_LEDGER_REQUIRES_REVIEW");
  if (toRecords(tournament.startRatingChanges).length > 0) return skip("START_RATING_OVERRIDE_REQUIRES_REVIEW");
  if (ratingStates.some(state => (eventInstant(state.lastEventAt) ?? 0) > deadlineTs)) return skip("NEWER_CANONICAL_LEVEL_REQUIRES_REVIEW");
  const participants = toRecords(tournament.participants), ids = participants.map(player => String(player.id || ""));
  if (ids.length < 4 || ids.some(id => !id) || new Set(ids).size !== ids.length) return skip("INVALID_PARTICIPANTS");
  const rounds = toRecords(tournament.rounds), matches = rounds.flatMap(round => toRecords(round.matches));
  if (rounds.length === 0 || rounds.some(round => !Array.isArray(round.matches) || round.matches.length === 0) || matches.length === 0) return skip("NO_MATCHES");
  const totalRounds = Number(tournament.params?.totalRounds || tournament.params?.roundsCount || 0);
  if (totalRounds > rounds.length) return skip("ROUNDS_NOT_COMPLETE");
  for (const match of matches) {
    if (match.score1 == null || match.score2 == null || match.score1 === "" || match.score2 === "") return skip("INCOMPLETE_SCORES");
    if ([match.score1, match.score2].some(score => !["number", "string"].includes(typeof score) || (typeof score === "string" && !score.trim()) || !Number.isFinite(Number(score)) || Number(score) < 0 || !Number.isInteger(Number(score)))) return skip("INVALID_SCORE");
    const pairs = [...toRecords(match.pair1), ...toRecords(match.pair2)].map(String);
    if (toRecords(match.pair1).length !== 2 || toRecords(match.pair2).length !== 2 || new Set(pairs).size !== 4 || pairs.some(id => !ids.includes(id))) return skip("INVALID_PAIRING");
  }
  const standings = toRecords(tournament.standings);
  if (standings.length !== participants.length || new Set(standings.map(row => String(row.id || row.playerId || ""))).size !== participants.length) return skip("INCOMPLETE_STANDINGS");
  if (standings.some(row => !ids.includes(String(row.id || row.playerId || "")))) return skip("INVALID_STANDINGS_IDENTITY");
  const finishedAt = new Date(deadlineTs).toISOString();
  return { close: true, reason: "COMPLETE_RESULTS", finishedAt, matches: matches.length, patch: {
    "params.status": "completed", "params.finished": true, "params.manualFinish": true, "params.finishedAt": finishedAt, "params.completedAt": finishedAt,
    "summary.status": "completed", "summary.finished": true, "summary.manualFinish": true, "summary.finishedAt": finishedAt, "summary.completedAt": finishedAt,
    "params.administrativeClosedAt": new Date(nowTs).toISOString(), updatedAt: new Date(nowTs).toISOString(),
  } };
}
export function assertTournamentWritersGuarded(flow) {
  const required = [
    ["2e70b2e547e77c00", "monthly_tournament_write_guard_v1"],
    ["4f0f1ce8189a9e8c", "monthly_tournament_create_guard_v1"],
    ["745f991e11130b08", "monthly_tournament_ack_guard_v1"],
  ];
  for (const [id, marker] of required) {
    if (!flow.find(node => node.id === id && node.type === "function" && node.disabled !== true && !flow.some(tab => tab.id === node.z && tab.disabled === true) && node.func?.includes(marker))) throw new Error("TOURNAMENT_WRITE_GUARDS_NOT_INSTALLED");
  }
}
export async function applyCommunityTournamentClose(db, tournament, plan, backupDir) {
  if (!plan.close) return { applied: false, reason: plan.reason };
  if (!backupDir) throw new Error("FINALIZATION_BACKUP_DIRECTORY_REQUIRED");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const { BSON } = await import("mongodb");
  const backupPath = `${backupDir}/${encodeURIComponent(tournament.tournamentId)}.ejson`;
  const preimage = BSON.EJSON.stringify(tournament, { relaxed: false });
  if (fs.existsSync(backupPath) && fs.readFileSync(backupPath, "utf8") !== preimage) throw new Error("FINALIZATION_BACKUP_PREIMAGE_CONFLICT");
  if (!fs.existsSync(backupPath)) {
    const fd = fs.openSync(backupPath, "wx", 0o600);
    try { fs.writeFileSync(fd, preimage); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(backupDir, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
  const result = await db.collection("tournaments").updateOne(tournamentWriteFilter(tournament.tournamentId, buildTournamentWriteSnapshot(tournament)), { $set: plan.patch });
  if (result.matchedCount !== 1) return { applied: false, reason: "SOURCE_CHANGED" };
  const saved = await db.collection("tournaments").findOne({ _id: tournament._id });
  if (!saved || !isTournamentFinalized(saved) || saved.params?.finishedAt !== plan.finishedAt || JSON.stringify(saved.rounds) !== JSON.stringify(tournament.rounds) || JSON.stringify(saved.standings) !== JSON.stringify(plan.patch.standings || tournament.standings)) throw new Error("FINALIZATION_POSTCHECK_FAILED");
  return { applied: true, reason: "COMPLETED", finishedAt: plan.finishedAt, matches: plan.matches };
}
