#!/usr/bin/env node
// Local, deterministic, no network and no database writes. Input is the sanitized
// export from export_fpr6x25_history_readonly.mjs, never an identifiable roster.
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createFprState, applyFprCommand, fprCurrentAttempt, fprStandings, FPR_VERSION } from "../src/components/tournaments/fpr6x25.ts";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || fs.existsSync(outputPath)) throw new Error("Usage: node --experimental-strip-types scripts/simulate_fpr6x25_history.mjs sanitized.json new-report.json");
const bytes = fs.readFileSync(inputPath), input = JSON.parse(bytes);
if (input.readonly !== true || !Array.isArray(input.tournaments)) throw new Error("Expected sanitized read-only export");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const key = (a, b) => JSON.stringify([a, b].sort());
function random(seed) {
  let x = Number.parseInt(sha(seed).slice(0, 8), 16);
  return () => { x += 0x6D2B79F5; let t = x; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const validScore = m => Number.isInteger(m.score1) && Number.isInteger(m.score2) && m.score1 >= 0 && m.score2 >= 0;
const isPlayed = t => t.rounds.some(r => r.matches.some(validScore));
const all = input.tournaments;
const played = all.filter(isPlayed), empty = all.filter(t => !isPlayed(t));
const reports = [];
let simulations = 0, roundsChecked = 0;
for (const tournament of played) {
  const n = tournament.participants.length, c = Math.floor(n / 4);
  const audit = { scoredMatches: 0, completeRounds: 0, partialRounds: 0, non25Matches: 0,
    invalidRosters: 0, repeatedPlayerRounds: 0, timestampedRounds: 0, unknownLevelPlayers: tournament.participants.filter(p => p.level === null).length };
  for (const r of tournament.rounds) {
    const scored = r.matches.filter(validScore); audit.scoredMatches += scored.length;
    if (scored.length === r.matches.length && scored.length > 0) audit.completeRounds += 1;
    else if (scored.length) audit.partialRounds += 1;
    if (r.startedAt && r.finishedAt) audit.timestampedRounds += 1;
    const assigned = scored.flatMap(m => [...m.pair1, ...m.pair2]);
    if (new Set(assigned).size !== assigned.length) audit.repeatedPlayerRounds += 1;
    for (const m of scored) {
      if (m.score1 + m.score2 !== 25) audit.non25Matches += 1;
      if (m.pair1.length !== 2 || m.pair2.length !== 2 || new Set([...m.pair1, ...m.pair2]).size !== 4
        || [...m.pair1, ...m.pair2].some(id => !tournament.participants.some(p => p.id === id))) audit.invalidRosters += 1;
    }
  }
  if (n < 4 || n > 28 || new Set(tournament.participants.map(p => p.id)).size !== n) {
    reports.push({ tournamentId: tournament.tournamentId, audit, excluded: "invalid_roster" }); continue;
  }
  const results = [];
  // Two explicit seeding assumptions × two outcome models × ten independent,
  // reproducible seeds. These are counterfactuals, not historical results.
  for (const seeding of ["unrated_by_level", "synthetic_league_order"]) for (const outcomes of ["equal_strength", "saved_level_strength"]) {
    const samples = [];
    for (let repetition = 0; repetition < 10; repetition += 1) {
      const seed = `${tournament.tournamentId}:${seeding}:${outcomes}:${repetition}`, rng = random(seed);
      const base = Date.parse("2026-11-01T09:00:00Z"), time = mins => new Date(base + mins * 60_000).toISOString();
      let state = createFprState({ tournamentId: `fpr-sim-${sha(seed).slice(0, 24)}`,
        players: tournament.participants.map((p, i) => ({ id: p.id, name: p.id, level: p.level ?? 3,
          leaguePlace: seeding === "unrated_by_level" ? null : i + 1,
          leaguePoints: seeding === "unrated_by_level" ? 0 : (n - i) * 100 })),
        courts: Array.from({ length: c }, (_, i) => `c${i + 1}`), leagueSource: `SIMULATION:${seeding}`,
        endsAt: time(180), reserveAllowed: true, now: time(0) });
      const cmd = (action, minute) => { state = applyFprCommand(state, { ...action, id: `cmd-${state.revision + 1}`, expectedRevision: state.revision }, time(minute)); };
      const partnership = new Map(), snapshots = {};
      for (let r = 1; r <= 8; r += 1) {
        const minute = r * 12;
        if (!fprCurrentAttempt(state)) cmd({ action: "prepare_round" }, minute);
        const scheduled = fprCurrentAttempt(state);
        if (n >= 8 && r >= 2) {
          const order = fprStandings(state).map(p => p.id).filter(id => !scheduled.byes.includes(id));
          const position = id => order.indexOf(id);
          for (const m of scheduled.matches) {
            const positions = [...m.pair1, ...m.pair2].map(position);
            assert.ok(Math.max(...positions) - Math.min(...positions) < scheduled.window);
            assert.ok(positions.every(pos => Math.abs(Math.floor(pos / 4) - m.courtIndex) <= 1));
          }
        }
        cmd({ action: "start_round" }, minute);
        for (const m of fprCurrentAttempt(state).matches) {
          const power = ids => ids.reduce((sum, id) => sum + state.players.find(p => p.id === id).level, 0) / 2;
          const probability = outcomes === "equal_strength" ? 0.5 : 1 / (1 + Math.exp(-(power(m.pair1) - power(m.pair2)) * Math.log(3)));
          let score1 = 0;
          for (let point = 0; point < 25; point += 1) score1 += rng() < probability ? 1 : 0;
          cmd({ action: "score", matchId: m.id, score1, score2: 25 - score1, confirmed1: true, confirmed2: true }, minute + 8);
          for (const team of [m.pair1, m.pair2]) { const k = key(...team); partnership.set(k, (partnership.get(k) ?? 0) + 1); }
        }
        cmd({ action: "close_round" }, minute + 9);
        const rows = fprStandings(state);
        assert.equal(rows.reduce((sum, p) => sum + p.matchesPlayed, 0), 4 * c * r);
        assert.equal(rows.reduce((sum, p) => sum + p.wins, 0), 2 * c * r);
        assert.equal(rows.reduce((sum, p) => sum + p.totalPoints, 0), 50 * c * r);
        assert.ok(Math.max(...rows.map(p => p.matchesPlayed)) - Math.min(...rows.map(p => p.matchesPlayed)) <= 1);
        for (const row of rows) assert.equal(row.pointsFor + row.pointsAgainst, 25 * row.matchesPlayed);
        if (r === 6 || r === 8) snapshots[r] = {
          partnershipRepeats: [...partnership.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
          maxPartnershipCount: Math.max(...partnership.values()),
          minMatches: Math.min(...rows.map(p => p.matchesPlayed)), maxMatches: Math.max(...rows.map(p => p.matchesPlayed)),
          sharedWinnerCount: rows.filter(p => p.rank === 1).length,
        };
        roundsChecked += 1;
      }
      samples.push({ repetition, ...snapshots }); simulations += 1;
    }
    results.push({ seeding, outcomes, samples });
  }
  reports.push({ tournamentId: tournament.tournamentId, date: tournament.createdAt, participants: n, courts: c,
    oldFormat: tournament.type, oldTargetScore: tournament.targetScore, categoryEvidence: tournament.categoryEvidence, audit, counterfactuals: results });
}
const report = {
  engineVersion: FPR_VERSION, generatedAt: new Date().toISOString(), inputSha256: sha(bytes), sourceCapturedAt: input.capturedAt,
  allTournamentRecordsScanned: input.allRecordsScanned, categoryRecords: all.length,
  historicalEventsWithScores: played.length, emptyProtocolsExcluded: empty.map(t => t.tournamentId),
  simulations, roundsChecked, assertionsPassed: true,
  assumptions: [
    "Every stored Time for Friends protocol with scored matches is included; unrecorded historical events cannot be reconstructed.",
    "Historical pre-start League snapshots were not stored in the export; two explicitly synthetic seeding assumptions are tested.",
    "New partnerships change opponents: scores are simulated, not copied from historical matches and not predictions of real winners.",
    "Saved participant levels are used in one outcome model; missing levels use 3 only inside simulation and are counted.",
    "Reserve rounds are exercised with a synthetic sufficient time budget; missing actual timestamps cannot prove historical 90-minute feasibility.",
    "No source tournament, rating, booking or production result is modified.",
  ],
  events: reports,
};
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ engineVersion: FPR_VERSION, categoryRecords: all.length, historicalEventsWithScores: played.length,
  simulations, roundsChecked, assertionsPassed: true, reportSha256: sha(fs.readFileSync(outputPath)),
  non25HistoricalMatches: reports.reduce((n, r) => n + r.audit.non25Matches, 0),
  historicalMatches: reports.reduce((n, r) => n + r.audit.scoredMatches, 0),
}));
