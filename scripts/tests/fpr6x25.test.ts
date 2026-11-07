import test from "node:test";
import assert from "node:assert/strict";
import {
  createFprState, applyFprCommand, fprCurrentAttempt, fprCompletedRounds, fprStandings,
  fprProjection, fprReserveThreshold, fprServeAt, fprStartingSides, validateFprState,
  type FprState, type FprCommand,
} from "../../src/components/tournaments/fpr6x25.ts";

const start = Date.parse("2026-10-28T18:00:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const players = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `p${i + 1}`, name: `Player ${i + 1}`, level: 4 - i / 20, leaguePlace: i + 1, leaguePoints: 1000 - i * 10,
}));
function event(n = 8, seed = "test"): FprState {
  return createFprState({ tournamentId: `fpr-${seed}-${n}`, players: players(n),
    courts: Array.from({ length: Math.floor(n / 4) }, (_, i) => `Court ${i + 1}`),
    leagueSource: "League all time", endsAt: at(180), reserveAllowed: true, now: at(0) });
}
test("starting court sides use a separate fixed draw across reloads, scores and B1 choices", () => {
  const state = event(), match = state.attempts[0].matches[0];
  const before = JSON.stringify(state), sides = fprStartingSides(state, match);
  assert.deepEqual([sides.sideA, sides.sideB].sort(), [1, 2]);
  assert.deepEqual(fprStartingSides(JSON.parse(before), { ...match, score1: 13, score2: 12 }), sides);
  const changed = command(state, { action: "set_b1", matchId: match.id, playerId: match.pair2[1] }, 1);
  assert.deepEqual(fprStartingSides(changed, changed.attempts[0].matches[0]), sides);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(new Set(Array.from({ length: 30 }, (_, i) => fprStartingSides({ tournamentId: `draw-${i}` }, match).sideA)), new Set([1, 2]));
  const normalIds = Array.from({ length: 6 }, (_, i) => ({ id: `fpr-r${i + 1}-a${i + 1}-c1` }));
  assert.deepEqual(new Set(normalIds.map(m => fprStartingSides(state, m).sideA)), new Set([1, 2]));
});
type Action = FprCommand extends infer T ? T extends FprCommand ? Omit<T, "id" | "expectedRevision"> : never : never;
function command(s: FprState, action: Action, minute: number): FprState {
  return applyFprCommand(s, { ...action, id: `cmd-${s.revision + 1}`, expectedRevision: s.revision } as FprCommand, at(minute));
}
function play(s: FprState, round: number, minute = round * 12): FprState {
  if (!fprCurrentAttempt(s)) s = command(s, { action: "prepare_round" }, minute);
  s = command(s, { action: "start_round" }, minute);
  for (const [i, m] of fprCurrentAttempt(s)!.matches.entries()) {
    const score1 = (round * 7 + i * 3) % 26;
    s = command(s, { action: "score", matchId: m.id, score1, score2: 25 - score1, confirmed1: true, confirmed2: true }, minute + 8);
  }
  return command(s, { action: "close_round" }, minute + 9);
}

test("all 75 Appendix A combinations and protocol conservation, N=4..28, R=6..8", () => {
  for (let n = 4; n <= 28; n += 1) {
    let state = event(n);
    for (let r = 1; r <= 8; r += 1) {
      state = play(state, r);
      const rows = fprStandings(state), c = Math.floor(n / 4);
      assert.equal(fprCompletedRounds(state), r);
      assert.equal(rows.reduce((sum, p) => sum + p.matchesPlayed, 0), 4 * c * r);
      assert.equal(rows.reduce((sum, p) => sum + p.wins, 0), 2 * c * r);
      assert.equal(rows.reduce((sum, p) => sum + p.totalPoints, 0), 50 * c * r);
      assert.ok(Math.max(...rows.map(p => p.matchesPlayed)) - Math.min(...rows.map(p => p.matchesPlayed)) <= 1, `${n} players, ${r} rounds`);
      for (const p of rows) assert.equal(p.pointsFor + p.pointsAgainst, 25 * p.matchesPlayed);
      if (r >= 6) {
        const q = Math.floor(4 * c * r / n), h = 4 * c * r % n;
        assert.equal(rows.filter(p => p.matchesPlayed === q).length, h ? n - h : n);
        if (h) assert.equal(rows.filter(p => p.matchesPlayed === q + 1).length, h);
      }
    }
  }
});

test("ranked League members seed above an unrated high-level newcomer; lower League points break result ties", () => {
  const input = players(4);
  input[0] = { ...input[0], level: 7, leaguePlace: null as unknown as number, leaguePoints: 0 };
  let state = createFprState({ tournamentId: "fpr-seeding", players: input, courts: ["Court"], leagueSource: "October",
    endsAt: at(90), reserveAllowed: true, now: at(0) });
  assert.equal(state.players.at(-1)!.id, "p1");
  state = play(state, 1);
  const round = state.attempts[0], winning = round.matches[0].score1! > 12 ? round.matches[0].pair1 : round.matches[0].pair2;
  const tied = fprStandings(state).filter(p => winning.includes(p.id));
  assert.ok(tied[0].leaguePoints < tied[1].leaguePoints);
});

test("unfinished courts and unconfirmed 25-point results never enter the table; no conditional bye points", () => {
  let state = command(event(9), { action: "start_round" }, 1);
  const [first, second] = fprCurrentAttempt(state)!.matches;
  state = command(state, { action: "score", matchId: first.id, score1: 16, score2: 9, confirmed1: true, confirmed2: true }, 8);
  assert.equal(fprStandings(state).reduce((n, p) => n + p.totalPoints, 0), 0);
  assert.throws(() => command(state, { action: "close_round" }, 9), /Подтвердите/);
  state = command(state, { action: "score", matchId: second.id, score1: 13, score2: 12, confirmed1: true, confirmed2: false }, 9);
  assert.throws(() => command(state, { action: "close_round" }, 10), /Подтвердите/);
  assert.throws(() => command(state, { action: "score", matchId: second.id, score1: 13, score2: 0, confirmed1: true, confirmed2: true }, 10), /25 очков/);
  assert.throws(() => command(state, { action: "score", matchId: second.id, score1: 12.5, score2: 12.5, confirmed1: false, confirmed2: false }, 10), /целых/);
  state = command(state, { action: "finish" }, 10);
  assert.equal(state.status, "incomplete");
  assert.ok(fprStandings(state).every(p => p.totalPoints === 0 && p.wins === 0 && p.matchesPlayed === 0 && p.rank === null));
});

test("a cancelled attempt retains played partnership history, rest history, and official round number", () => {
  let state = play(event(9), 1);
  state = command(state, { action: "start_round" }, 25);
  const current = fprCurrentAttempt(state)!;
  state = command(state, { action: "score", matchId: current.matches[0].id, score1: 4, score2: 3, confirmed1: false, confirmed2: false }, 26);
  const before = fprStandings(state).map(p => [p.id, p.wins, p.totalPoints, p.matchesPlayed]);
  state = command(state, { action: "cancel_round", reason: "Court unavailable" }, 27);
  assert.equal(fprCompletedRounds(state), 1);
  assert.deepEqual(fprStandings(state).map(p => [p.id, p.wins, p.totalPoints, p.matchesPlayed]), before);
  state = command(state, { action: "prepare_round" }, 28);
  assert.equal(fprCurrentAttempt(state)!.round, 2);
  assert.equal(fprCurrentAttempt(state)!.attempt, 3);
  assert.equal(state.attempts[1].matches[0].score1, 4);
});

test("DNF cancels the whole current round, preserves earlier results, and removes final placement", () => {
  let state = play(event(8), 1);
  const before = fprStandings(state).reduce((n, p) => n + p.totalPoints, 0);
  state = command(state, { action: "start_round" }, 25);
  const current = fprCurrentAttempt(state)!;
  state = command(state, { action: "score", matchId: current.matches[0].id, score1: 25, score2: 0, confirmed1: true, confirmed2: true }, 27);
  state = command(state, { action: "withdraw", playerId: "p1", reason: "Injury" }, 28);
  assert.equal(state.attempts[1].status, "cancelled");
  assert.equal(fprStandings(state).reduce((n, p) => n + p.totalPoints, 0), before);
  assert.equal(fprStandings(state).find(p => p.id === "p1")!.rank, null);
  assert.equal(fprStandings(state).find(p => p.id === "p1")!.status, "DNF");
  state = command(state, { action: "prepare_round" }, 29);
  assert.equal(fprCurrentAttempt(state)!.round, 2);
  assert.equal(fprCurrentAttempt(state)!.matches.length, 1);
  assert.equal(fprCurrentAttempt(state)!.byes.length, 3);
});

test("same command is idempotent; stale revision fails; a closed score correction preserves an already running draw", () => {
  const initial = event();
  const cmd: FprCommand = { action: "start_round", id: "a-stable-command", expectedRevision: 0 };
  let state = applyFprCommand(initial, cmd, at(1));
  assert.strictEqual(applyFprCommand(state, cmd, at(2)), state);
  assert.throws(() => applyFprCommand(state, { ...cmd, action: "finish" }, at(2)), /FPR_COMMAND_ID_REUSED/);
  assert.throws(() => applyFprCommand(state, { ...cmd, id: "a-different-command" }, at(2)), /FPR_REVISION_CONFLICT/);
  state = event(); state = play(state, 1);
  state = command(state, { action: "start_round" }, 25);
  const draw = JSON.stringify(fprCurrentAttempt(state));
  state = command(state, { action: "correct_score", matchId: state.attempts[0].matches[0].id,
    score1: 25, score2: 0, confirmed1: true, confirmed2: true, reason: "Confirmed input error" }, 26);
  assert.equal(JSON.stringify(fprCurrentAttempt(state)), draw);
  assert.match(state.audit.at(-1)!.detail, /Confirmed input error/);
});

test("six required rounds; reserve start uses the slowest of the last two plus six minutes", () => {
  let state = event();
  for (let round = 1; round <= 6; round += 1) state = play(state, round);
  assert.equal(fprReserveThreshold(state, at(166)).allowed, true);
  assert.equal(fprReserveThreshold(state, at(166)).requiredMs, 14 * 60_000);
  assert.equal(fprReserveThreshold(state, at(167)).allowed, false);
  assert.throws(() => command(state, { action: "prepare_round" }, 167), /Недостаточно времени/);
  state = command(state, { action: "finish" }, 167);
  assert.equal(state.status, "completed");
  assert.equal(fprProjection(state).summary.status, "awaiting_league_rules");
  assert.equal(fprProjection(state).params.published, false);
  assert.ok(fprProjection(state).standings.every(row => !("ratingAfter" in row) && !("ratingDelta" in row)));
});

test("planner is deterministic and a one-court draw does not depend on match outcomes", () => {
  for (const n of [4, 5, 6, 7, 12, 28]) {
    assert.deepEqual(event(n), event(n));
    if (n < 8) {
      const first = event(n), other = structuredClone(first);
      const a = play(first, 1);
      let b = command(other, { action: "start_round" }, 12);
      const match = fprCurrentAttempt(b)!.matches[0];
      b = command(b, { action: "score", matchId: match.id, score1: 25, score2: 0, confirmed1: true, confirmed2: true }, 20);
      b = command(b, { action: "close_round" }, 21);
      assert.deepEqual(a.singleCourtPlan, b.singleCourtPlan);
      assert.deepEqual(fprCurrentAttempt(a), fprCurrentAttempt(b));
    }
  }
});

test("serve cycle has 7/6/6/6 points, alternates right/left, changes sides after point 12", () => {
  const m = event(4).attempts[0].matches[0], counts = new Map<string, number>();
  for (let i = 0; i < 25; i += 1) {
    const serve = fprServeAt(m, i);
    counts.set(serve.playerId, (counts.get(serve.playerId) ?? 0) + 1);
    assert.equal(serve.side, i % 2 ? "left" : "right");
    assert.equal(serve.changeEnds, i === 12);
  }
  assert.equal(counts.get(m.firstServer), 7);
  assert.deepEqual([...counts.values()].sort(), [6, 6, 6, 7]);
});

test("one-court optimization counts a repeated partner after only one player rested", () => {
  const state = createFprState({ tournamentId: "fpr-review-1", players: players(5).map((p, i) => ({ ...p, level: 3, leaguePoints: 100 - i })),
    courts: ["Court"], leagueSource: "League", now: at(0), endsAt: at(90), reserveAllowed: true });
  const previousPartner = new Map<string, string>();
  let repeats = 0;
  for (const round of state.singleCourtPlan.filter(r => r.round <= 6)) for (const match of round.pairings) {
    for (const [a, b] of [match.pair1, match.pair2]) {
      if (previousPartner.get(a) === b || previousPartner.get(b) === a) repeats += 1;
      previousPartner.set(a, b); previousPartner.set(b, a);
    }
  }
  assert.equal(repeats, 0);
});

test("malformed snapshots, duplicate participants, fake complete rounds and missing ratings fail closed", () => {
  const state = event();
  const bad = structuredClone(state); bad.attempts[0].status = "closed";
  assert.throws(() => validateFprState(bad));
  const duplicate = structuredClone(state); duplicate.players[1].id = duplicate.players[0].id;
  assert.throws(() => validateFprState(duplicate), /Повторный/);
  const missing = structuredClone(state); missing.players[0].leaguePoints = Number.NaN;
  assert.throws(() => validateFprState(missing), /снимок/);
});

function standingsFixture(spec: string[][][]) {
  let state = event(8);
  for (let r = 0; r < spec.length; r += 1) {
    const current = fprCurrentAttempt(state)!;
    current.matches = current.matches.map((m, court) => {
      const one = spec[r][court * 2] as [string, string], two = spec[r][court * 2 + 1] as [string, string];
      return { ...m, pair1: one, pair2: two, firstServer: one[0] };
    });
    state = command(state, { action: "start_round" }, r * 12 + 1);
    for (const m of fprCurrentAttempt(state)!.matches) state = command(state, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true }, r * 12 + 8);
    state = command(state, { action: "close_round" }, r * 12 + 9);
  }
  return fprStandings(state);
}

test("a whole-group H2H mini-table handles A>B>C>A and unequal series lengths once", () => {
  const rows = standingsFixture([
    [["p1", "p4"], ["p2", "p5"], ["p3", "p6"], ["p7", "p8"]],
    [["p2", "p4"], ["p3", "p5"], ["p6", "p7"], ["p1", "p8"]],
    [["p3", "p4"], ["p1", "p5"], ["p2", "p6"], ["p7", "p8"]],
    [["p1", "p4"], ["p5", "p6"], ["p7", "p8"], ["p2", "p3"]],
  ]);
  // B beats C in their series, but the complete mini-table ties them at 3.
  // Do not recurse into that subgroup: C's lower League points put C above B.
  assert.deepEqual(rows.filter(p => p.wins === 2).map(p => [p.id, p.headToHead]), [["p7", 4], ["p3", 3], ["p2", 3], ["p1", 2]]);
});

test("one missing opposing series skips H2H for the entire equal group", () => {
  const rows = standingsFixture([
    [["p1", "p4"], ["p2", "p5"], ["p3", "p6"], ["p7", "p8"]],
    [["p2", "p4"], ["p3", "p5"], ["p1", "p7"], ["p6", "p8"]],
    [["p3", "p4"], ["p1", "p5"], ["p2", "p6"], ["p7", "p8"]],
    [["p5", "p6"], ["p1", "p4"], ["p7", "p8"], ["p2", "p3"]],
  ]);
  assert.deepEqual(rows.filter(p => p.wins === 2).map(p => [p.id, p.headToHead]), [["p7", null], ["p3", null], ["p2", null], ["p1", null]]);
});

test("post-deadline partial 7:5 cannot grow into a final 13:12; whole round is excluded", () => {
  let state = event(); state.endsAt = at(90);
  for (let r = 1; r <= 5; r += 1) state = play(state, r);
  state = command(state, { action: "start_round" }, 72);
  const match = fprCurrentAttempt(state)!.matches[0];
  state = command(state, { action: "score", matchId: match.id, score1: 7, score2: 5, confirmed1: false, confirmed2: false }, 88);
  assert.throws(() => command(state, { action: "score", matchId: match.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true }, 95), /один уже начатый/);
  state = command(state, { action: "finish" }, 96);
  assert.equal(state.status, "incomplete"); assert.equal(fprCompletedRounds(state), 5);
});

test("late data entry requires actual timely completion; a last rally started before deadline may finish later", () => {
  let state = event(); state.endsAt = at(90);
  for (let r = 1; r <= 5; r += 1) state = play(state, r);
  state = command(state, { action: "start_round" }, 72);
  for (const m of fprCurrentAttempt(state)!.matches) {
    assert.throws(() => command(state, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true }, 88), /фактическое окончание/);
    state = command(state, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true,
      playedAt: at(86), reason: "Both pairs reported at 86, organizer entered late" }, 88);
  }
  state = command(state, { action: "close_round" }, 89);
  assert.equal(state.attempts.find(a => a.round === 6)!.finishedAt, at(86));
  state = command(state, { action: "finish" }, 90);
  assert.equal(state.status, "completed");

  let rally = event(4); rally.endsAt = at(90);
  for (let r = 1; r <= 5; r += 1) rally = play(rally, r);
  rally = command(rally, { action: "start_round" }, 72);
  const m = fprCurrentAttempt(rally)!.matches[0];
  rally = command(rally, { action: "score", matchId: m.id, score1: 12, score2: 12, confirmed1: false, confirmed2: false }, 88);
  rally = command(rally, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true,
    playedAt: at(89), lastRallyStartedAt: at(86.9), reason: "Only the last rally continued" }, 89);
  rally = command(rally, { action: "close_round" }, 90);
  assert.equal(fprCompletedRounds(rally), 6);
});

test("a second pair can confirm a saved last-rally result without re-entering its valid timing proof", () => {
  let state = event(4); state.endsAt = at(90);
  state = command(state, { action: "start_round" }, 72);
  const m = fprCurrentAttempt(state)!.matches[0];
  state = command(state, { action: "score", matchId: m.id, score1: 12, score2: 12, confirmed1: false, confirmed2: false }, 88);
  state = command(state, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: false,
    playedAt: at(89), lastRallyStartedAt: at(86.9), reason: "Last rally already started" }, 89);
  state = command(state, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true }, 90);
  assert.equal(fprCurrentAttempt(state)!.matches[0].lastRallyStartedAt, at(86.9));
  state = command(state, { action: "close_round" }, 91);
  assert.equal(fprCompletedRounds(state), 1);
});

test("first saved score starts the prepared round atomically and replay never resets its clock", () => {
  for (const score1 of [7, 13]) {
    const original = event(), before = JSON.stringify(original), match = original.attempts[0].matches[0];
    const cmd: FprCommand = { id: 'first-score', expectedRevision: 0, action: 'score', matchId: match.id,
      score1, score2: score1 === 7 ? 5 : 12, confirmed1: score1 === 13, confirmed2: score1 === 13, startIfScheduled: true };
    const state = applyFprCommand(original, cmd, at(1));
    assert.equal(state.revision, 1); assert.equal(state.audit.length, 1);
    assert.equal(state.attempts[0].status, 'running'); assert.equal(state.attempts[0].startedAt, at(1));
    assert.equal(state.attempts[0].matches[0].score1, score1);
    assert.equal(JSON.stringify(original), before);
    assert.deepEqual(applyFprCommand(state, cmd, at(5)), state);
    assert.throws(() => applyFprCommand(state, { ...cmd, startIfScheduled: false }, at(5)), /FPR_COMMAND_ID_REUSED/);
    assert.throws(() => applyFprCommand(state, { ...cmd, id: 'stale-score' }, at(5)), /FPR_REVISION_CONFLICT/);
    const second = state.attempts[0].matches[1];
    const next = command(state, { action: 'score', matchId: second.id, score1: 13, score2: 12,
      confirmed1: true, confirmed2: true, startIfScheduled: true }, 6);
    assert.equal(next.attempts[0].startedAt, at(1));
  }
});

test("invalid, legacy and late first scores never partially start a scheduled round", () => {
  const state = event(), before = JSON.stringify(state);
  const cmd: FprCommand = { id: 'rejected-first-score', expectedRevision: 0, action: 'score',
    matchId: state.attempts[0].matches[0].id, score1: 13, score2: 12, confirmed1: true, confirmed2: true, startIfScheduled: true };
  for (const change of [{ score1: -1 }, { score2: 13 }, { score1: 1.5 }, { matchId: 'missing' },
    { startIfScheduled: false }, { score1: 2, score2: 3 }]) {
    assert.throws(() => applyFprCommand(state, { ...cmd, ...change }, at(1)));
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => applyFprCommand(state, { ...cmd, playedAt: at(170), reason: 'late entry' }, at(177)), /дедлайн/);
  assert.equal(JSON.stringify(state), before);
});

test("first save rechecks reserve time after a reserve draw was prepared", () => {
  let state = event();
  for (let round = 1; round <= 6; round++) state = play(state, round);
  state.endsAt = at(100);
  state = command(state, { action: 'prepare_round' }, 82);
  const before = JSON.stringify(state);
  assert.throws(() => command(state, { action: 'score', matchId: fprCurrentAttempt(state)!.matches[0].id,
    score1: 13, score2: 12, confirmed1: true, confirmed2: true, startIfScheduled: true }, 88), /запасного раунда/);
  assert.equal(JSON.stringify(state), before);
});

test("only the exact reducer rejection can release a pending command", async () => {
  const { isRejectedFprCommand } = await import('../../src/components/tournaments/fprCommandRecovery.ts');
  assert.equal(isRejectedFprCommand({ status: 422, error: { raw: { error: 'FPR_COMMAND_INVALID' } } }), true);
  for (const status of [null, 200, 409, 500, 502]) {
    assert.equal(isRejectedFprCommand({ status, error: { raw: { error: 'FPR_COMMAND_INVALID' } } }), false);
  }
  for (const raw of [null, undefined, 'FPR_COMMAND_INVALID', {}, { error: 'OTHER_ERROR' }]) {
    assert.equal(isRejectedFprCommand({ status: 422, error: { raw } }), false);
  }
});

function autoRound(state: FprState, minute: number): FprState {
  const attempt = fprCurrentAttempt(state)!;
  for (const [i, match] of attempt.matches.entries()) {
    state = command(state, { action: "score", matchId: match.id, score1: 13, score2: 12,
      confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true }, minute + i);
  }
  return state;
}

test("only the final saved court atomically closes a round, updates standings and prepares one next draw", () => {
  let state = event();
  const matches = state.attempts[0].matches;
  state = command(state, { action: "score", matchId: matches[0].id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true }, 1);
  assert.equal(fprCompletedRounds(state), 0);
  assert.equal(fprStandings(state).reduce((n, row) => n + row.matchesPlayed, 0), 0);
  const beforeLast = JSON.stringify(state);
  const last: FprCommand = { id: "last-court", expectedRevision: 1, action: "score", matchId: matches[1].id,
    score1: 15, score2: 10, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true };
  assert.throws(() => applyFprCommand(state, { ...last, score2: 11 }, at(2)), /Счёт/);
  assert.equal(JSON.stringify(state), beforeLast);
  state = applyFprCommand(state, last, at(2));
  assert.equal(state.revision, 2); assert.equal(state.audit.length, 2);
  assert.equal(fprCompletedRounds(state), 1); assert.equal(state.attempts[0].finishedAt, at(2));
  assert.equal(fprCurrentAttempt(state)?.round, 2); assert.equal(fprCurrentAttempt(state)?.status, "scheduled");
  assert.equal(state.attempts.length, 2);
  assert.equal(fprStandings(state).reduce((n, row) => n + row.matchesPlayed, 0), 8);
  assert.equal(fprStandings(state).reduce((n, row) => n + row.wins, 0), 4);
  assert.equal(applyFprCommand(state, last, at(3)), state, "replay must not append another draw");
  assert.throws(() => applyFprCommand(state, { ...last, autoCloseRound: false }, at(3)), /FPR_COMMAND_ID_REUSED/);
  assert.throws(() => applyFprCommand(state, { ...last, id: "stale-last" }, at(3)), /FPR_REVISION_CONFLICT/);
  assert.throws(() => applyFprCommand(state, { id: "old-close", expectedRevision: 1, action: "close_round" }, at(3)), /FPR_REVISION_CONFLICT/);
});

test("auto-close conserves all N=4..28 protocols through eight rounds, including single-court start+score+close", () => {
  for (let n = 4; n <= 28; n++) {
    let state = event(n, "auto-close");
    const courts = Math.floor(n / 4);
    for (let round = 1; round <= 8; round++) {
      assert.equal(fprCurrentAttempt(state)?.round, round);
      state = autoRound(state, round * 12);
      assert.equal(state.revision, round * courts, `${n} players: one revision per score`);
      assert.equal(fprCompletedRounds(state), round);
      const standings = fprStandings(state);
      assert.equal(standings.reduce((sum, p) => sum + p.matchesPlayed, 0), 4 * courts * round);
      assert.equal(standings.reduce((sum, p) => sum + p.wins, 0), 2 * courts * round);
      assert.equal(standings.reduce((sum, p) => sum + p.totalPoints, 0), 50 * courts * round);
      assert.equal(state.attempts.length, Math.min(round + 1, 8));
      if (round < 8) assert.equal(fprCurrentAttempt(state)?.status, "scheduled");
    }
    assert.equal(fprCurrentAttempt(state), null);
    assert.equal(state.status, "in_progress", "completion of the event still requires explicit finish");
  }
});

test("auto-close waits for both pairs and preserves legacy fully-saved rounds until an explicit new Save", () => {
  let state = event();
  const [first, second] = state.attempts[0].matches;
  state = command(state, { action: "score", matchId: first.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: false, startIfScheduled: true, autoCloseRound: true }, 1);
  state = command(state, { action: "score", matchId: second.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, autoCloseRound: true }, 2);
  assert.equal(fprCompletedRounds(state), 0);
  state = command(state, { action: "score", matchId: first.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true }, 3);
  assert.equal(fprCompletedRounds(state), 0, "old command has no auto-close flag");
  assert.equal(fprCurrentAttempt(state)?.status, "running");
  state = command(state, { action: "score", matchId: first.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, autoCloseRound: true }, 4);
  assert.equal(fprCompletedRounds(state), 1);
  assert.equal(state.attempts[0].finishedAt, at(2), "confirmation time must not replace actual completedAt");
});

test("reserve draws are automatic only when enabled and the newly closed duration still fits", () => {
  let disabled = event(); disabled.reserveAllowed = false;
  for (let round = 1; round <= 6; round++) disabled = autoRound(disabled, round * 12);
  assert.equal(fprCompletedRounds(disabled), 6); assert.equal(fprCurrentAttempt(disabled), null);
  let slow = event(); slow.endsAt = at(110);
  for (let round = 1; round <= 5; round++) slow = autoRound(slow, round * 12);
  const [first, second] = fprCurrentAttempt(slow)!.matches;
  slow = command(slow, { action: "score", matchId: first.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true }, 72);
  slow = command(slow, { action: "score", matchId: second.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, autoCloseRound: true }, 95);
  assert.equal(fprCompletedRounds(slow), 6); assert.equal(fprCurrentAttempt(slow), null);
  assert.equal(fprReserveThreshold(slow, at(95)).requiredMs, 29 * 60_000);
});

test("valid late last scores close and count the round without preparing an unplayable next draw", () => {
  let state = event();
  const [first, second] = state.attempts[0].matches;
  state = command(state, { action: "score", matchId: first.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true }, 1);
  state = command(state, { action: "score", matchId: second.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, autoCloseRound: true, playedAt: at(170), reason: "Timely finish, late entry" }, 178);
  assert.equal(fprCompletedRounds(state), 1); assert.equal(state.attempts[0].finishedAt, at(170));
  assert.equal(fprCurrentAttempt(state), null); assert.equal(state.attempts.length, 1);
  assert.equal(fprStandings(state).reduce((sum, p) => sum + p.matchesPlayed, 0), 8);
});

test("auto-close saves the final court at the attempt limit without creating an invalid next draw", () => {
  let state = event();
  for (let i = 0; i < 99; i++) {
    state = command(state, { action: "cancel_round", reason: "Court unavailable" }, 1);
    state = command(state, { action: "prepare_round" }, 1);
  }
  assert.equal(state.attempts.length, 100);
  state = autoRound(state, 12);
  validateFprState(state);
  assert.equal(state.attempts.length, 100);
  assert.equal(fprCompletedRounds(state), 1);
  assert.equal(fprCurrentAttempt(state), null);
  assert.equal(state.attempts[99].matches.every(m => m.score1 === 13 && m.score2 === 12), true);
  assert.equal(fprStandings(state).reduce((sum, p) => sum + p.matchesPlayed, 0), 8);
  state = command(state, { action: "finish" }, 15);
  assert.equal(state.status, "incomplete");
});

test("correction of a closed score never auto-closes or duplicates the next scheduled or running round", () => {
  let state = autoRound(event(), 12);
  const oldMatch = state.attempts[0].matches[0];
  state = command(state, { action: "correct_score", matchId: oldMatch.id, score1: 10, score2: 15,
    confirmed1: true, confirmed2: true, reason: "Corrected score", autoCloseRound: true }, 14);
  assert.equal(state.attempts.length, 2); assert.equal(fprCompletedRounds(state), 1);
  assert.equal(fprCurrentAttempt(state)?.status, "scheduled");
  const currentMatch = fprCurrentAttempt(state)!.matches[0];
  state = command(state, { action: "score", matchId: currentMatch.id, score1: 13, score2: 12,
    confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true }, 15);
  const draw = JSON.stringify(fprCurrentAttempt(state));
  state = command(state, { action: "correct_score", matchId: oldMatch.id, score1: 12, score2: 13,
    confirmed1: true, confirmed2: true, reason: "Second correction", autoCloseRound: true }, 16);
  assert.equal(JSON.stringify(fprCurrentAttempt(state)), draw);
  assert.equal(state.attempts.length, 2); assert.equal(fprCompletedRounds(state), 1);
});
