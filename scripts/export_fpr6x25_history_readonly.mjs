// Read-only. Run via stdin on 147 from the rating worker's dependency directory.
// No names, phone numbers, organizer profiles, tokens or connection strings leave 147.
import fs from "node:fs";
import { MongoClient } from "mongodb";

const flow = JSON.parse(fs.readFileSync("/root/.node-red/flows.json", "utf8"));
const config = flow.find(n => n.type === "mongodb4-client" && typeof n.uri === "string" && n.uri.includes("/games"));
if (!config) throw new Error("games_configuration_missing");
const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
const arr = v => Array.isArray(v) ? v : [];
const text = v => v == null ? "" : String(v);
const numeric = v => v == null || text(v).trim() === "" ? null : Number.isFinite(Number(text(v).replace(",", "."))) ? Number(text(v).replace(",", ".")) : null;
const ref = v => v && typeof v === "object" ? v.id ?? v.participantId ?? v.playerId ?? v.clientId : v;
const isFriends = v => [v?.directionId, v?.direction?.id].some(x => text(x) === "5278")
  || [v?.directionName, v?.direction?.name, v?.name, v?.title].some(x => /время\s+на\s+друз/iu.test(text(x)));
try {
  await client.connect();
  const db = client.db("games"), linked = new Set();
  const addLinks = (value, parentFriends = false) => {
    if (!value || typeof value !== "object") return;
    const friends = parentFriends || isFriends(value);
    if (friends) for (const key of ["id", "tournamentId", "exerciseId", "sourceTournamentId", "relatedTournamentId"]) {
      if (value[key] != null) linked.add(text(value[key]));
    }
    for (const key of ["details", "sourceTournamentSnapshot", "publicTournament", "sourceTournament", "exercise", "tournament"]) addLinks(value[key], friends);
  };
  const snapshots = await db.collection("viva_tournament_snapshots").find({}, {
    projection: { _id: 0, "tournaments.id": 1, "tournaments.tournamentId": 1, "tournaments.exerciseId": 1,
      "tournaments.directionId": 1, "tournaments.directionName": 1, "tournaments.direction": 1 }, maxTimeMS: 30000,
  }).toArray();
  for (const snapshot of snapshots) for (const tournament of arr(snapshot.tournaments)) addLinks(tournament);
  const projection = { _id: 0 };
  for (const root of ["", "details.", "details.sourceTournamentSnapshot.", "details.publicTournament.", "details.sourceTournament.", "details.exercise."]) {
    for (const key of ["id", "tournamentId", "exerciseId", "sourceTournamentId", "relatedTournamentId", "directionId", "directionName", "direction"]) projection[root + key] = 1;
  }
  // Inclusion projection: do not mix a whole parent with nested children.
  delete projection.direction;
  const feeds = await db.collection("lk_community_feed").find({ kind: "TOURNAMENT" }, { projection, maxTimeMS: 30000 }).toArray();
  for (const post of feeds) addLinks(post);
  const records = await db.collection("tournaments").find({}, { projection: {
    tournamentId: 1, id: 1, tournamentType: 1, targetScore: 1, archived: 1,
    createdAt: 1, updatedAt: 1, finishedAt: 1, summary: 1, courts: 1, rounds: 1,
    "params.directionId": 1, "params.directionName": 1, "params.exerciseId": 1, "params.sourceExerciseId": 1,
    "params.tournamentId": 1, "params.stationId": 1, "params.finishedAt": 1, "params.status": 1,
    "params.finished": 1, "params.isFinished": 1, "params.manualFinish": 1,
    "participants.id": 1, "participants.participantId": 1, "participants.rating": 1,
    "standings.id": 1, "standings.rank": 1, "standings.wins": 1, "standings.totalPoints": 1,
  }, maxTimeMS: 30000 }).batchSize(100).toArray();
  const selected = records.filter(t => isFriends(t.params) || [t.tournamentId, t.id, t.params?.exerciseId, t.params?.sourceExerciseId].some(id => linked.has(text(id))));
  const clean = selected.map(t => {
    const ids = new Map(), courts = new Map();
    const player = value => { const key = text(ref(value)); if (!key) return null; if (!ids.has(key)) ids.set(key, `p${ids.size + 1}`); return ids.get(key); };
    const court = value => { const key = text(value); if (!courts.has(key)) courts.set(key, courts.size); return courts.get(key); };
    const participants = arr(t.participants).map((p, i) => ({ id: player(ref(p) ?? `missing-${i}`), level: numeric(p.rating), seed: i + 1 }));
    return {
      tournamentId: text(t.tournamentId ?? t.id), recordId: text(t._id), archived: t.archived === true,
      categoryEvidence: isFriends(t.params) ? "stored_direction" : "schedule_or_publication_link",
      createdAt: t.createdAt ?? null, updatedAt: t.updatedAt ?? null,
      type: t.tournamentType ?? null, targetScore: numeric(t.targetScore),
      finished: t.params?.finished === true || t.params?.isFinished === true || t.params?.manualFinish === true || t.summary?.finished === true,
      finishedAt: t.params?.finishedAt ?? t.summary?.finishedAt ?? t.finishedAt ?? null,
      summary: Object.fromEntries(["totalRounds", "completedRounds", "totalMatches", "completedMatches", "status"].filter(k => t.summary?.[k] != null).map(k => [k, t.summary[k]])),
      participants,
      rounds: arr(t.rounds).map((r, ri) => ({ index: numeric(r.index) ?? ri + 1,
        startedAt: r.startedAt ?? r.startAt ?? null, finishedAt: r.finishedAt ?? r.completedAt ?? null,
        byes: arr(r.byes).map(player), matches: arr(r.matches).map(m => ({
          courtIndex: numeric(m.courtIndex) ?? court(m.court),
          pair1: arr(m.pair1 ?? m.team1).map(player), pair2: arr(m.pair2 ?? m.team2).map(player),
          score1: numeric(m.score1), score2: numeric(m.score2), startedAt: m.startedAt ?? null,
          finishedAt: m.finishedAt ?? m.completedAt ?? null,
        })),
      })),
    };
  });
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), source: "147/games.tournaments", readonly: true,
    allRecordsScanned: records.length, selectedRecords: clean.length, scheduleFriendIds: linked.size,
    categoryDefinition: "Viva direction 5278 or explicit Time for Friends label or linked schedule/publication",
    redaction: "per-event player tokens; no personal names/phones/organizers/credentials", tournaments: clean }));
} catch (e) {
  console.log(JSON.stringify({ error: e.name, code: e.code ?? null, readonly: true }));
  process.exitCode = 1;
} finally { await client.close(); }
