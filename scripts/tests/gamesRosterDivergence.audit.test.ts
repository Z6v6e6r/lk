import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGame,
  extractGames,
  parseArgs,
  parseArgsOrThrow,
  toVivaPlayers,
} from "../audit_games_roster_divergence.ts";

// Shaped after the reported game: an imported ADMIN participant stays in the LK
// roster while the provider holds no active booking for the exercise.
const game = {
  id: "pay_5a974d14-0b71-45d0-816c-3541de378532",
  archived: false,
  status: "PAID",
  booking: { date: "2026-09-28", timeFrom: "07:00", exerciseId: "exercise-1" },
  organizer: { id: "organizer-1", name: "Organizer", phone: "79990000003" },
  participants: [
    { id: "organizer-1", name: "Organizer", phone: "79990000003", source: "ORGANIZER", status: "CONFIRMED" },
    { id: "client-1", name: "Alexey Sergeev", phone: null, source: "ADMIN", status: "CONFIRMED" },
  ],
  waitlist: [],
} as never;

test("audit flags a participant the provider no longer holds", () => {
  const finding = evaluateGame(game, "exercise-1", [{
    id: "organizer-1", name: "Organizer", phone: "79990000003", photo: null, rating: null, ratingNumeric: null,
  }]);
  assert.equal(finding.verdict, "phantom_participant");
  assert.deepEqual(finding.lkOnlyParticipants.map((player) => player.id), ["client-1"]);
  assert.equal(finding.sourceParticipantsCount, 2);
  assert.equal(finding.vivaParticipantsCount, 1);
  assert.equal(finding.lkOnlyParticipants[0].phone, null);
});

test("audit redaction removes personal names but keeps identifiers", () => {
  const finding = evaluateGame(game, "exercise-1", [], { redact: true });
  assert.equal(finding.verdict, "phantom_participant");
  assert.equal(finding.lkOnlyParticipants[0].name, null);
  assert.equal(finding.lkOnlyParticipants[0].id, "client-1");
});

test("audit reports an aligned roster without findings", () => {
  const finding = evaluateGame(game, "exercise-1", [
    { id: "organizer-1", name: "Organizer", phone: "79990000003", photo: null, rating: null, ratingNumeric: null },
    { id: "client-1", name: "Alexey Sergeev", phone: null, photo: null, rating: null, ratingNumeric: null },
  ]);
  assert.equal(finding.verdict, "aligned");
  assert.deepEqual(finding.lkOnlyParticipants, []);
});

test("audit keeps only cancelled-free rows of the requested exercise", () => {
  const players = toVivaPlayers([
    { id: "b-1", exercise: { id: "exercise-1" }, client: { id: "client-1", firstName: "A" } },
    { id: "b-2", exercise: { id: "exercise-1" }, client: { id: "client-2" }, isCancelled: true },
    { id: "b-3", exercise: { id: "exercise-2" }, client: { id: "client-3" } },
    { id: "b-4", exercise: { id: "exercise-1" }, client: { id: "client-4" }, status: "WAITLIST" },
  ], "exercise-1");
  assert.deepEqual(players.map((player) => player.id), ["client-1"]);
});

test("audit argument parsing requires a target and keeps game ids", () => {
  // The pure parser throws; the CLI wrapper is what turns a failure into usage.
  assert.throws(() => parseArgsOrThrow([]));
  assert.throws(() => parseArgsOrThrow(["--spacing", "-1", "--game", "pay_1"]));
  assert.throws(() => parseArgsOrThrow(["--nope"]));
  const args = parseArgsOrThrow(["--game", "pay_1", "--game", "pay_2", "--redact", "--spacing", "10"]);
  assert.deepEqual(args.gameIds, ["pay_1", "pay_2"]);
  assert.equal(args.redact, true);
  assert.equal(args.spacingMs, 10);
  assert.equal(parseArgsOrThrow(["--phone", "+7 (910) 430-31-90"]).phone, "79104303190");
  assert.equal(parseArgs(["--game", "pay_1"]).gameIds.length, 1);
});

test("audit reads the games envelope and ignores non-object entries", () => {
  assert.deepEqual(extractGames({ total: 1, games: [{ id: "a" }] } as never).map((item) => item.id), ["a"]);
  assert.deepEqual(extractGames({ games: [] } as never), []);
  assert.deepEqual(extractGames(null), []);
});
