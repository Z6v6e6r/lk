// Regulation 1.1, 26 October 2026. This module is also compiled into Node-RED.
// Keep it self-contained: the server and browser must run the same planner/reducer.
export const FPR_VERSION = "fpr-6x25-1.1.0";
export type FprPlayerInput = {
  id: string;
  name: string;
  level: number;
  leaguePoints: number;
  leaguePlace: number | null;
};
export type FprPlayer = FprPlayerInput & { seed: number; restLot: number };
export type FprCommunityRating = {
  policy: "community-tournament-v1";
  communityId: string;
  communityName: string;
  period: "month" | "all";
  snapshotUpdatedAt: string | null;
  sourceExerciseId: string | null;
  publicationId: string | null;
};
export type FprMatch = {
  id: string;
  courtIndex: number;
  pair1: [string, string];
  pair2: [string, string];
  firstServer: string;
  score1: number | null;
  score2: number | null;
  confirmed1: boolean;
  confirmed2: boolean;
  completedAt: string | null;
  deadlineScoreTotal: number | null;
  lastRallyStartedAt?: string;
  lateEntryReason?: string;
};
export type FprAttempt = {
  id: string;
  round: number;
  attempt: number;
  status: "scheduled" | "running" | "closed" | "cancelled";
  startedAt: string | null;
  finishedAt: string | null;
  byes: string[];
  activeIds: string[];
  matches: FprMatch[];
  window: 8 | 12 | null;
  reason?: string;
};
type Pairing = { pair1: [string, string]; pair2: [string, string] };
type PlannedRound = { round: number; byes: string[]; pairings: Pairing[] };
export type FprState = {
  version: typeof FPR_VERSION;
  revision: number;
  tournamentId: string;
  leagueSource: string;
  leagueSnapshotAt: string;
  endsAt: string;
  reserveAllowed: boolean;
  testMode: boolean;
  communityRating?: FprCommunityRating;
  players: FprPlayer[];
  courts: string[];
  attempts: FprAttempt[];
  withdrawals: Array<{ id: string; at: string; reason: string }>;
  singleCourtPlan: PlannedRound[];
  status: "ready" | "in_progress" | "completed" | "incomplete";
  finishedAt: string | null;
  audit: Array<{ id: string; at: string; action: string; detail: string; fingerprint: string }>;
};
export type FprStanding = {
  id: string;
  name: string;
  seed: number;
  leaguePoints: number;
  rank: number | null;
  wins: number;
  matchesPlayed: number;
  totalPoints: number;
  pointsFor: number;
  pointsAgainst: number;
  byeCount: number;
  headToHead: number | null;
  status: "active" | "DNF" | "no_matches";
};
type FprAction =
  | { action: "prepare_round" | "start_round" | "close_round" | "finish" }
  | { action: "set_b1"; matchId: string; playerId: string }
  | { action: "score" | "correct_score"; matchId: string; score1: number; score2: number; confirmed1: boolean; confirmed2: boolean; reason?: string; playedAt?: string; lastRallyStartedAt?: string }
  | { action: "cancel_round"; reason: string }
  | { action: "withdraw"; playerId: string; reason: string };
export type FprCommand = FprAction & { id: string; expectedRevision: number };

function requireFpr(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const validTime = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value));
const pairKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const compareCost = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

// A separate, fixed draw for the two ends of the court. Its input is persisted
// in the protocol; scores, rendering and devices cannot redraw these sides.
export function fprStartingSides(state: Pick<FprState, "tournamentId">, match: Pick<FprMatch, "id">): { sideA: 1 | 2; sideB: 1 | 2 } {
  let draw = hash(`initial-court-side-v1:${state.tournamentId}:${match.id}`);
  // Mix only this independent draw: sequential round/attempt IDs must not
  // inherit FNV's low-bit parity. The planner's existing hash stays unchanged.
  draw = Math.imul(draw ^ (draw >>> 16), 0x7feb352d);
  draw = Math.imul(draw ^ (draw >>> 15), 0x846ca68b);
  draw ^= draw >>> 16;
  const sideA = (draw & 1) === 0 ? 1 : 2;
  return { sideA, sideB: sideA === 1 ? 2 : 1 };
}
const idsInMatch = (match: Pairing) => [...match.pair1, ...match.pair2];
const partnerKeys = (match: Pairing) => [pairKey(...match.pair1), pairKey(...match.pair2)];
const opponentKeys = (match: Pairing) => match.pair1.flatMap(a => match.pair2.map(b => pairKey(a, b)));
const hasPoints = (match: FprMatch) => (match.score1 ?? 0) + (match.score2 ?? 0) > 0;
const finalScore = (match: FprMatch) => Number.isInteger(match.score1) && Number.isInteger(match.score2)
  && (match.score1 ?? -1) >= 0 && (match.score2 ?? -1) >= 0 && (match.score1 ?? 0) + (match.score2 ?? 0) === 25;
const confirmed = (match: FprMatch) => finalScore(match) && match.confirmed1 && match.confirmed2;
export const fprCompletedRounds = (state: FprState) => state.attempts.filter(a => a.status === "closed").length;
export const fprCurrentAttempt = (state: FprState) => state.attempts.find(a => a.status === "scheduled" || a.status === "running") ?? null;
const activePlayers = (state: FprState) => state.players.filter(p => !state.withdrawals.some(w => w.id === p.id));

export function fprStandings(state: FprState): FprStanding[] {
  const rows = state.players.map(p => ({
    id: p.id, name: p.name, seed: p.seed, leaguePoints: p.leaguePoints,
    rank: null as number | null, wins: 0, matchesPlayed: 0, totalPoints: 0,
    pointsFor: 0, pointsAgainst: 0, byeCount: 0, headToHead: null as number | null,
    status: state.withdrawals.some(w => w.id === p.id) ? "DNF" as const : "no_matches" as "active" | "no_matches",
  }));
  const byId = new Map(rows.map(p => [p.id, p]));
  const series = new Map<string, { count: number; wins: Map<string, number> }>();
  for (const attempt of state.attempts) {
    if (attempt.startedAt) for (const id of attempt.byes) byId.get(id)!.byeCount += 1;
    if (attempt.status !== "closed") continue;
    for (const match of attempt.matches) {
      for (const [team, own, other] of [[match.pair1, match.score1!, match.score2!], [match.pair2, match.score2!, match.score1!]] as const) {
        for (const id of team) {
          const row = byId.get(id)!;
          row.matchesPlayed += 1; row.pointsFor += own; row.totalPoints += own;
          row.pointsAgainst += other; row.wins += own > other ? 1 : 0;
        }
      }
      for (const a of match.pair1) for (const b of match.pair2) {
        const key = pairKey(a, b);
        const item = series.get(key) ?? { count: 0, wins: new Map<string, number>() };
        item.count += 1;
        const winner = match.score1! > match.score2! ? a : b;
        item.wins.set(winner, (item.wins.get(winner) ?? 0) + 1);
        series.set(key, item);
      }
    }
  }
  const eligible = rows.filter(r => r.status !== "DNF");
  const groups = new Map<string, FprStanding[]>();
  for (const row of eligible) {
    if (row.matchesPlayed) row.status = "active";
    const key = `${row.wins}:${row.totalPoints}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const complete = group.every((a, i) => group.slice(i + 1).every(b => series.has(pairKey(a.id, b.id))));
    if (!complete) continue;
    for (const row of group) row.headToHead = 0;
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const a = group[i], b = group[j], entry = series.get(pairKey(a.id, b.id))!;
      const aw = entry.wins.get(a.id) ?? 0, bw = entry.wins.get(b.id) ?? 0;
      a.headToHead! += aw > bw ? 2 : aw === bw ? 1 : 0;
      b.headToHead! += bw > aw ? 2 : aw === bw ? 1 : 0;
    }
  }
  const compare = (a: FprStanding, b: FprStanding) => b.wins - a.wins || b.totalPoints - a.totalPoints
    || (b.headToHead ?? 0) - (a.headToHead ?? 0) || a.leaguePoints - b.leaguePoints;
  eligible.sort((a, b) => compare(a, b) || a.seed - b.seed);
  let place = 0, previous: FprStanding | null = null;
  for (const row of eligible) {
    if (!row.matchesPlayed) continue;
    place += 1;
    row.rank = previous && compare(previous, row) === 0 ? previous.rank : place;
    previous = row;
  }
  return [...eligible, ...rows.filter(r => r.status === "DNF").sort((a, b) => a.seed - b.seed)];
}

function restContext(state: FprState) {
  const games = new Map(state.players.map(p => [p.id, 0]));
  const lastRest = new Map(state.players.map(p => [p.id, -1]));
  for (const attempt of state.attempts) {
    if (attempt.startedAt) for (const id of attempt.byes) lastRest.set(id, attempt.attempt);
    if (attempt.status === "closed") for (const match of attempt.matches) for (const id of idsInMatch(match)) games.set(id, games.get(id)! + 1);
  }
  return { games, lastRest };
}
function chooseRest(players: FprPlayer[], games: Map<string, number>, lastRest: Map<string, number>) {
  return [...players].sort((a, b) => games.get(b.id)! - games.get(a.id)!
    || lastRest.get(a.id)! - lastRest.get(b.id)! || a.restLot - b.restLot)
    .slice(0, players.length % 4).map(p => p.id);
}
const threePairings = (p: string[]): Pairing[] => [
  { pair1: [p[0], p[3]], pair2: [p[1], p[2]] },
  { pair1: [p[0], p[1]], pair2: [p[2], p[3]] },
  { pair1: [p[0], p[2]], pair2: [p[1], p[3]] },
];
function actualHistory(state: FprState) {
  return state.attempts.filter(a => a.startedAt).flatMap(a => a.matches.filter(hasPoints));
}
function historyCounts(history: Pairing[]) {
  const partners = new Map<string, number>(), opponents = new Map<string, number>();
  for (const match of history) {
    for (const key of partnerKeys(match)) partners.set(key, (partners.get(key) ?? 0) + 1);
    for (const key of opponentKeys(match)) opponents.set(key, (opponents.get(key) ?? 0) + 1);
  }
  return { partners, opponents };
}
function planLargeRound(state: FprState, ordered: string[], window: 8 | 12): Pairing[] {
  const ranks = new Map(ordered.map((id, i) => [id, i]));
  const history = historyCounts(actualHistory(state));
  const previous = state.attempts.filter(a => a.startedAt).at(-1);
  const previousPartners = new Set(previous?.matches.filter(hasPoints).flatMap(partnerKeys) ?? []);
  const cost = (matches: Pairing[]) => {
    const result = [0, 0, 0, 0, 0, 0, 0];
    for (const match of matches) {
      for (const key of partnerKeys(match)) {
        const count = history.partners.get(key) ?? 0;
        result[0] += count > 0 ? 1 : 0; result[1] += count;
        result[2] += previousPartners.has(key) ? 1 : 0;
      }
      for (const key of opponentKeys(match)) {
        const count = history.opponents.get(key) ?? 0;
        result[3] += count > 0 ? 1 : 0; result[4] += count;
      }
      const places = idsInMatch(match).map(id => ranks.get(id)!);
      result[5] += (Math.max(...places) - Math.min(...places)) ** 2;
      result[6] += (ranks.get(match.pair1[0])! + ranks.get(match.pair1[1])!
        - ranks.get(match.pair2[0])! - ranks.get(match.pair2[1])!) ** 2;
    }
    return result;
  };
  let matches = Array.from({ length: ordered.length / 4 }, (_, court) => {
    const choices = threePairings(ordered.slice(court * 4, court * 4 + 4));
    return choices.reduce((best, next) => compareCost(cost([next]), cost([best])) < 0 ? next : best);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    const indices = Array.from({ length: matches.length - 1 }, (_, i) => i);
    if (pass % 2) indices.reverse();
    let improved = false;
    for (const leftCourt of indices) {
      const pool = [...idsInMatch(matches[leftCourt]), ...idsInMatch(matches[leftCourt + 1])]
        .sort((a, b) => ranks.get(a)! - ranks.get(b)!);
      let best = [matches[leftCourt], matches[leftCourt + 1]], bestCost = cost(best);
      // 35 unordered partitions × 3 × 3 pairings = 315 candidates, fixed order.
      for (let b = 1; b < 6; b += 1) for (let c = b + 1; c < 7; c += 1) for (let d = c + 1; d < 8; d += 1) {
        const group = [pool[0], pool[b], pool[c], pool[d]];
        const other = pool.filter(id => !group.includes(id));
        const sum = (ids: string[]) => ids.reduce((n, id) => n + ranks.get(id)!, 0);
        const groups = sum(group) <= sum(other) ? [group, other] : [other, group];
        const allowed = groups.every((ids, i) => {
          const positions = ids.map(id => ranks.get(id)!);
          return Math.max(...positions) - Math.min(...positions) < window
            && positions.every(pos => Math.abs(Math.floor(pos / 4) - (leftCourt + i)) <= 1);
        });
        if (!allowed) continue;
        for (const one of threePairings(groups[0])) for (const two of threePairings(groups[1])) {
          const candidate = [one, two], nextCost = cost(candidate);
          if (compareCost(nextCost, bestCost) < 0) { best = candidate; bestCost = nextCost; improved = true; }
        }
      }
      matches = matches.map((m, i) => i === leftCourt ? best[0] : i === leftCourt + 1 ? best[1] : m);
    }
    if (!improved) break;
  }
  return matches;
}
function rotationCost(history: Pairing[]) {
  const { partners, opponents } = historyCounts(history);
  const lastPartner = new Map<string, string>();
  let consecutive = 0;
  for (const match of history) for (const team of [match.pair1, match.pair2]) {
    if (lastPartner.get(team[0]) === team[1] || lastPartner.get(team[1]) === team[0]) consecutive += 1;
    lastPartner.set(team[0], team[1]); lastPartner.set(team[1], team[0]);
  }
  const counts = (map: Map<string, number>) => [...map.values()];
  const repeats = (map: Map<string, number>) => counts(map).reduce((n, count) => n + Math.max(0, count - 1), 0);
  return [repeats(partners), Math.max(0, ...counts(partners)), consecutive,
    repeats(opponents), Math.max(0, ...counts(opponents))];
}
function planSingleCourt(state: FprState): PlannedRound[] {
  const players = activePlayers(state), { games, lastRest } = restContext(state);
  const firstRound = fprCompletedRounds(state) + 1;
  const skeleton: Array<{ round: number; byes: string[]; options: Pairing[] }> = [];
  for (let round = firstRound; round <= 8; round += 1) {
    const byes = chooseRest(players, games, lastRest);
    const active = players.filter(p => !byes.includes(p.id)).sort((a, b) => a.seed - b.seed).map(p => p.id);
    const options = threePairings(active);
    skeleton.push({ round, byes, options: round === 1 ? options.slice(0, 1) : options });
    for (const id of active) games.set(id, games.get(id)! + 1);
    for (const id of byes) lastRest.set(id, state.attempts.length + round - firstRound + 1);
  }
  const previous = actualHistory(state);
  let best: PlannedRound[] | null = null, bestCost: number[] | null = null;
  const search = (index: number, plan: PlannedRound[]) => {
    if (index === skeleton.length) {
      const cost = [6, 7, 8].flatMap(limit => rotationCost([...previous,
        ...plan.filter(r => r.round <= limit).flatMap(r => r.pairings)]));
      if (!bestCost || compareCost(cost, bestCost) < 0) { best = clone(plan); bestCost = cost; }
      return;
    }
    const round = skeleton[index];
    for (const pairing of round.options) search(index + 1, [...plan, { round: round.round, byes: round.byes, pairings: [pairing] }]);
  };
  search(0, []);
  return best ?? [];
}
function prepareAttempt(state: FprState): FprAttempt {
  const players = activePlayers(state), round = fprCompletedRounds(state) + 1;
  requireFpr(players.length >= 4, "Для следующего раунда осталось меньше четырёх участников");
  requireFpr(round <= 8, "Все восемь раундов уже сыграны");
  const { games, lastRest } = restContext(state);
  let byes = chooseRest(players, games, lastRest), window: FprAttempt["window"] = null;
  let pairings: Pairing[];
  if (players.length < 8) {
    if (!state.singleCourtPlan.length) state.singleCourtPlan = planSingleCourt(state);
    const planned = state.singleCourtPlan.find(r => r.round === round)!;
    byes = planned.byes; pairings = planned.pairings;
  } else {
    const order = round === 1 ? [...players].sort((a, b) => a.seed - b.seed).map(p => p.id)
      : fprStandings(state).filter(p => p.status !== "DNF").map(p => p.id);
    const ordered = order.filter(id => !byes.includes(id));
    if (round === 1) pairings = Array.from({ length: ordered.length / 4 }, (_, i) => threePairings(ordered.slice(i * 4, i * 4 + 4))[0]);
    else {
      const narrow = planLargeRound(state, ordered, 8);
      const counts = historyCounts(actualHistory(state)).partners;
      const repeats = (matches: Pairing[]) => matches.flatMap(partnerKeys).filter(key => counts.has(key)).length;
      const wide = repeats(narrow) ? planLargeRound(state, ordered, 12) : narrow;
      window = repeats(wide) < repeats(narrow) ? 12 : 8;
      pairings = window === 12 ? wide : narrow;
    }
  }
  const attempt = state.attempts.length + 1, id = `fpr-r${round}-a${attempt}`;
  const firstServes = new Map(state.players.map(p => [p.id, 0]));
  for (const match of actualHistory(state)) firstServes.set(match.firstServer, firstServes.get(match.firstServer)! + 1);
  return {
    id, round, attempt, status: "scheduled", startedAt: null, finishedAt: null, byes,
    activeIds: players.map(p => p.id), window,
    matches: pairings.map((pairing, courtIndex) => {
      const firstServer = idsInMatch(pairing).map(id => players.find(p => p.id === id)!)
        .sort((a, b) => firstServes.get(a.id)! - firstServes.get(b.id)! || a.restLot - b.restLot)[0].id;
      const serverTeam = pairing.pair1.includes(firstServer) ? pairing.pair1 : pairing.pair2;
      const other = serverTeam === pairing.pair1 ? pairing.pair2 : pairing.pair1;
      return {
        id: `${id}-c${courtIndex + 1}`, courtIndex,
        pair1: [firstServer, serverTeam.find(p => p !== firstServer)!], pair2: [...other],
        firstServer, score1: null, score2: null, confirmed1: false, confirmed2: false, completedAt: null, deadlineScoreTotal: null,
      };
    }),
  };
}

export function createFprState(input: {
  tournamentId: string; players: FprPlayerInput[]; courts: string[]; leagueSource: string;
  endsAt: string; reserveAllowed: boolean; testMode?: boolean; communityRating?: FprCommunityRating; now: string;
}): FprState {
  requireFpr(input.players.length >= 4 && input.players.length <= 28, "ФПР рассчитан на 4–28 участников");
  requireFpr(new Set(input.players.map(p => p.id)).size === input.players.length, "В составе есть повторный участник");
  requireFpr(input.leagueSource.trim(), "Укажите одну таблицу Лиги для снимка");
  requireFpr(validTime(input.now) && validTime(input.endsAt) && Date.parse(input.endsAt) > Date.parse(input.now), "Проверьте время окончания события");
  requireFpr(input.courts.length === Math.floor(input.players.length / 4) && input.courts.every(c => c.trim())
    && new Set(input.courts).size === input.courts.length, "Нужен отдельный корт на каждую полную четвёрку");
  for (const p of input.players) {
    requireFpr(p.id && p.name.trim() && Number.isFinite(p.level) && p.level >= 0, "Для каждого участника нужны имя и уровень");
    requireFpr(Number.isFinite(p.leaguePoints) && p.leaguePoints >= 0, "Недоступный рейтинг Лиги нельзя заменять нулём");
    requireFpr(p.leaguePlace === null ? p.leaguePoints === 0 : Number.isInteger(p.leaguePlace) && p.leaguePlace > 0,
      "Укажите место в выбранной таблице Лиги или явно отметьте новичка без очков");
  }
  const lot = (kind: string) => [...input.players].sort((a, b) => hash(`${input.tournamentId}:${kind}:${a.id}`)
    - hash(`${input.tournamentId}:${kind}:${b.id}`) || a.id.localeCompare(b.id)).map(p => p.id);
  const seedLot = lot("seed"), restLot = lot("rest");
  const seeded = [...input.players].sort((a, b) => (a.leaguePlace === null ? 1 : 0) - (b.leaguePlace === null ? 1 : 0)
    || (a.leaguePlace ?? 0) - (b.leaguePlace ?? 0) || b.level - a.level || seedLot.indexOf(a.id) - seedLot.indexOf(b.id));
  const state: FprState = {
    version: FPR_VERSION, revision: 0, tournamentId: input.tournamentId,
    leagueSource: input.leagueSource.trim(), leagueSnapshotAt: input.now, endsAt: input.endsAt,
    reserveAllowed: input.reserveAllowed, testMode: input.testMode ?? true,
    ...(input.communityRating ? { communityRating: clone(input.communityRating) } : {}),
    players: seeded.map((p, i) => ({ ...p, seed: i + 1, restLot: restLot.indexOf(p.id) + 1 })),
    courts: [...input.courts], attempts: [], withdrawals: [], singleCourtPlan: [],
    status: "ready", finishedAt: null, audit: [],
  };
  state.attempts.push(prepareAttempt(state));
  validateFprState(state);
  return state;
}

export function fprReserveThreshold(state: FprState, now: string) {
  const completed = state.attempts.filter(a => a.status === "closed");
  const duration = Math.max(0, ...completed.slice(-2).map(a => Date.parse(a.finishedAt!) - Date.parse(a.startedAt!)));
  const requiredMs = duration + 6 * 60_000; // transition + protocol + safety, §12.3
  const remainingMs = Date.parse(state.endsAt) - Date.parse(now);
  return { allowed: state.reserveAllowed && completed.length >= 6 && completed.length < 8 && remainingMs >= requiredMs, requiredMs, remainingMs };
}
export function applyFprCommand(original: FprState, command: FprCommand, now: string): FprState {
  validateFprState(original);
  requireFpr(typeof command.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(command.id), "Некорректный идентификатор команды");
  const fingerprint = JSON.stringify(Object.keys(command).sort().map(key => [key, (command as Record<string, unknown>)[key]]));
  const previousCommand = original.audit.find(entry => entry.id === command.id);
  if (previousCommand) {
    requireFpr(previousCommand.fingerprint === fingerprint, "FPR_COMMAND_ID_REUSED");
    return original;
  }
  requireFpr(command.expectedRevision === original.revision, "FPR_REVISION_CONFLICT");
  requireFpr(validTime(now) && Date.parse(now) >= Date.parse(original.audit.at(-1)?.at ?? original.leagueSnapshotAt), "Некорректное время команды");
  const state = clone(original), current = fprCurrentAttempt(state);
  const finished = state.status === "completed" || state.status === "incomplete";
  requireFpr(!finished || command.action === "correct_score", "Турнир завершён");
  let detail = "";
  if (command.action === "prepare_round") {
    requireFpr(!current, "Предыдущая попытка ещё не закрыта");
    if (fprCompletedRounds(state) >= 6) requireFpr(fprReserveThreshold(state, now).allowed, "Недостаточно времени для запасного раунда (§12.3)");
    state.attempts.push(prepareAttempt(state));
  } else if (command.action === "set_b1") {
    requireFpr(current?.status === "scheduled", "Порядок подачи фиксируется до общего старта");
    const match = current.matches.find(m => m.id === command.matchId);
    requireFpr(match && match.pair2.includes(command.playerId), "B1 должен быть участником пары B");
    match.pair2 = [command.playerId, match.pair2.find(id => id !== command.playerId)!];
    detail = `${match.id}: B1=${command.playerId}`;
  } else if (command.action === "start_round") {
    requireFpr(current?.status === "scheduled", "Нет подготовленного раунда");
    requireFpr(Date.parse(now) < Date.parse(state.endsAt) - 180_000, "Игровой дедлайн уже наступил");
    if (current.round >= 7) requireFpr(fprReserveThreshold(state, now).allowed, "Недостаточно времени для запасного раунда (§12.3)");
    current.status = "running"; current.startedAt = now; state.status = "in_progress";
  } else if (command.action === "score" || command.action === "correct_score") {
    const attempt = state.attempts.find(a => a.matches.some(m => m.id === command.matchId));
    const match = attempt?.matches.find(m => m.id === command.matchId);
    requireFpr(attempt && match, "Матч не найден");
    requireFpr(command.action === "score" ? attempt.status === "running" : attempt.status === "closed", "Нельзя изменить счёт этой попытки");
    requireFpr(Number.isInteger(command.score1) && Number.isInteger(command.score2) && command.score1 >= 0 && command.score2 >= 0
      && command.score1 + command.score2 <= 25, "Счёт должен состоять из целых неотрицательных очков с суммой не больше 25");
    if (command.confirmed1 || command.confirmed2 || command.action === "correct_score") requireFpr(command.score1 + command.score2 === 25, "Для подтверждения нужны все 25 очков");
    if (command.action === "correct_score") requireFpr(command.reason?.trim() && command.confirmed1 && command.confirmed2, "Для исправления нужны причина и подтверждение обеих пар");
    const total = command.score1 + command.score2;
    const deadline = Date.parse(state.endsAt) - 180_000;
    const afterDeadline = Date.parse(now) >= deadline;
    let completedAt = match.completedAt;
    if (command.action === "score") {
      if (afterDeadline && match.deadlineScoreTotal !== null && total > match.deadlineScoreTotal) {
        requireFpr(match.deadlineScoreTotal === 24 && total === 25 && (command.lastRallyStartedAt || match.lastRallyStartedAt),
          "После игрового дедлайна разрешено доиграть только один уже начатый розыгрыш");
      }
      if (total === 25 && !completedAt) {
        const actual = command.playedAt ?? now;
        requireFpr(validTime(actual) && Date.parse(actual) >= Date.parse(attempt.startedAt!) && Date.parse(actual) <= Date.parse(now), "Проверьте фактическое время окончания матча");
        if (afterDeadline) requireFpr(command.playedAt && command.reason?.trim(), "После дедлайна укажите фактическое окончание и причину позднего ввода");
        if (Date.parse(actual) > deadline) {
          requireFpr(command.lastRallyStartedAt && validTime(command.lastRallyStartedAt)
            && Date.parse(command.lastRallyStartedAt) >= Date.parse(attempt.startedAt!)
            && Date.parse(command.lastRallyStartedAt) <= deadline && Date.parse(command.lastRallyStartedAt) <= Date.parse(actual),
          "После дедлайна мог завершиться только розыгрыш, начатый до него");
          match.lastRallyStartedAt = command.lastRallyStartedAt;
        }
        completedAt = actual;
        if (command.reason) match.lateEntryReason = command.reason.trim();
      }
      if (afterDeadline && match.deadlineScoreTotal === null) match.deadlineScoreTotal = total;
      if (total < 25) { completedAt = null; delete match.lastRallyStartedAt; }
    }
    detail = `${match.id}: ${match.score1 ?? "–"}:${match.score2 ?? "–"} → ${command.score1}:${command.score2}${command.reason ? `; ${command.reason.trim()}` : ""}`;
    match.score1 = command.score1; match.score2 = command.score2;
    match.confirmed1 = command.confirmed1; match.confirmed2 = command.confirmed2;
    match.completedAt = completedAt;
    if (command.action === "correct_score" && current?.status === "scheduled" && activePlayers(state).length >= 8) {
      state.attempts.pop(); state.attempts.push(prepareAttempt(state));
    }
  } else if (command.action === "close_round") {
    requireFpr(current?.status === "running" && current.matches.every(confirmed), "Подтвердите все матчи обеими парами; каждый матч — 25 очков");
    current.status = "closed";
    current.finishedAt = new Date(Math.max(...current.matches.map(m => Date.parse(m.completedAt!)))).toISOString();
    if (current.round < 6) state.attempts.push(prepareAttempt(state));
  } else if (command.action === "cancel_round") {
    requireFpr(current && command.reason.trim(), "Укажите причину отмены раунда");
    current.status = "cancelled"; current.finishedAt = now; current.reason = command.reason.trim();
    state.singleCourtPlan = [];
    detail = current.reason;
  } else if (command.action === "withdraw") {
    requireFpr(activePlayers(state).some(p => p.id === command.playerId) && command.reason.trim(), "Выберите активного игрока и укажите причину DNF");
    if (current) { current.status = "cancelled"; current.finishedAt = now; current.reason = `DNF: ${command.reason.trim()}`; }
    state.withdrawals.push({ id: command.playerId, at: now, reason: command.reason.trim() });
    state.singleCourtPlan = []; detail = `${command.playerId}: ${command.reason.trim()}`;
    if (activePlayers(state).length < 4) { state.status = fprCompletedRounds(state) >= 6 ? "completed" : "incomplete"; state.finishedAt = now; }
  } else if (command.action === "finish") {
    if (current) {
      if (current.status === "running" && current.matches.every(confirmed)) {
        current.status = "closed";
        current.finishedAt = new Date(Math.max(...current.matches.map(m => Date.parse(m.completedAt!)))).toISOString();
      } else { current.status = "cancelled"; current.finishedAt = now; current.reason = "Завершение события; неполный раунд исключён целиком (§13)"; }
    }
    state.status = fprCompletedRounds(state) >= 6 ? "completed" : "incomplete"; state.finishedAt = now;
  } else throw new Error("Неизвестная команда ФПР");
  state.revision += 1;
  state.audit.push({ id: command.id, at: now, action: command.action, detail, fingerprint });
  validateFprState(state);
  return state;
}

export function validateFprState(value: unknown): asserts value is FprState {
  requireFpr(value && typeof value === "object", "Протокол ФПР отсутствует");
  const s = value as FprState;
  requireFpr(s.version === FPR_VERSION, "Версия планировщика ФПР не поддерживается");
  requireFpr(typeof s.tournamentId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s.tournamentId), "Некорректный ID турнира");
  requireFpr(Array.isArray(s.players) && s.players.length >= 4 && s.players.length <= 28, "Некорректный состав ФПР");
  const ids = s.players.map(p => p.id);
  requireFpr(new Set(ids).size === ids.length && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 128), "Повторный или некорректный ID участника");
  for (const p of s.players) requireFpr(typeof p.name === "string" && p.name.trim() && Number.isFinite(p.level) && p.level >= 0
    && Number.isFinite(p.leaguePoints) && p.leaguePoints >= 0
    && (p.leaguePlace === null ? p.leaguePoints === 0 : Number.isInteger(p.leaguePlace) && p.leaguePlace > 0), "Некорректный снимок рейтинга");
  for (const key of ["seed", "restLot"] as const) requireFpr(new Set(s.players.map(p => p[key])).size === ids.length
    && s.players.every(p => Number.isInteger(p[key]) && p[key] >= 1 && p[key] <= ids.length), "Некорректный посев или жребий отдыха");
  requireFpr(Array.isArray(s.courts) && s.courts.length === Math.floor(ids.length / 4) && s.courts.every(c => typeof c === "string" && c.trim())
    && new Set(s.courts).size === s.courts.length, "Некорректные корты");
  requireFpr(typeof s.leagueSource === "string" && s.leagueSource.trim() && validTime(s.leagueSnapshotAt) && validTime(s.endsAt)
    && Date.parse(s.endsAt) > Date.parse(s.leagueSnapshotAt), "Некорректный источник рейтинга или время");
  requireFpr(typeof s.reserveAllowed === "boolean" && typeof s.testMode === "boolean", "Некорректные настройки ФПР");
  if (s.communityRating !== undefined) {
    const c = s.communityRating;
    requireFpr(c && c.policy === "community-tournament-v1"
      && typeof c.communityId === "string" && c.communityId.trim() === c.communityId && c.communityId.length > 0 && c.communityId.length <= 256
      && typeof c.communityName === "string" && c.communityName.trim() && ["month", "all"].includes(c.period)
      && (c.snapshotUpdatedAt === null || validTime(c.snapshotUpdatedAt))
      && [c.sourceExerciseId, c.publicationId].every(v => v === null || typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 256),
    "Некорректный источник рейтинга сообщества");
    requireFpr(!c.sourceExerciseId?.startsWith("fpr-"), "Исходным событием не может быть другой протокол ФПР");
  }
  requireFpr(["ready", "in_progress", "completed", "incomplete"].includes(s.status), "Некорректный статус ФПР");
  requireFpr(Array.isArray(s.audit) && s.audit.length <= 5000 && Number.isInteger(s.revision) && s.revision === s.audit.length,
    "Некорректная версия протокола");
  requireFpr(new Set(s.audit.map(a => a.id)).size === s.audit.length && s.audit.every(a => typeof a.id === "string" && validTime(a.at)
    && typeof a.action === "string" && typeof a.detail === "string" && typeof a.fingerprint === "string"), "Некорректная история изменений");
  requireFpr(Array.isArray(s.withdrawals) && new Set(s.withdrawals.map(w => w.id)).size === s.withdrawals.length
    && s.withdrawals.every(w => ids.includes(w.id) && validTime(w.at) && typeof w.reason === "string" && w.reason.trim()), "Некорректные снятия");
  requireFpr(Array.isArray(s.attempts) && s.attempts.length <= 100 && Array.isArray(s.singleCourtPlan), "Некорректная история попыток");
  const seenIds = new Set<string>();
  let closed = 0, open = 0;
  for (let i = 0; i < s.attempts.length; i += 1) {
    const a = s.attempts[i];
    requireFpr(a.id === `fpr-r${a.round}-a${i + 1}` && a.attempt === i + 1 && a.round === closed + 1 && a.round <= 8
      && ["scheduled", "running", "closed", "cancelled"].includes(a.status), "Нарушен порядок попыток или раундов");
    requireFpr(Array.isArray(a.activeIds) && a.activeIds.length >= 4 && new Set(a.activeIds).size === a.activeIds.length
      && a.activeIds.every(id => ids.includes(id)) && Array.isArray(a.byes) && a.byes.length === a.activeIds.length % 4,
      "Некорректный состав попытки или отдых");
    requireFpr(Array.isArray(a.matches) && a.matches.length === Math.floor(a.activeIds.length / 4), "Неверное число матчей попытки");
    const assigned = [...a.byes];
    for (let court = 0; court < a.matches.length; court += 1) {
      const m = a.matches[court];
      requireFpr(m.id === `${a.id}-c${court + 1}` && !seenIds.has(m.id) && m.courtIndex === court
        && Array.isArray(m.pair1) && m.pair1.length === 2 && Array.isArray(m.pair2) && m.pair2.length === 2, "Некорректный матч или корт");
      seenIds.add(m.id); assigned.push(...idsInMatch(m));
      requireFpr(m.firstServer === m.pair1[0], "Некорректный первый подающий");
      requireFpr((m.score1 === null && m.score2 === null) || (Number.isInteger(m.score1) && Number.isInteger(m.score2)
        && m.score1! >= 0 && m.score2! >= 0 && m.score1! + m.score2! <= 25), "Некорректный счёт");
      requireFpr(typeof m.confirmed1 === "boolean" && typeof m.confirmed2 === "boolean"
        && (!(m.confirmed1 || m.confirmed2) || finalScore(m)) && (!confirmed(m) || validTime(m.completedAt!)), "Некорректное подтверждение счёта");
      requireFpr(m.deadlineScoreTotal === null || Number.isInteger(m.deadlineScoreTotal) && m.deadlineScoreTotal >= 0 && m.deadlineScoreTotal <= 25, "Некорректный снимок счёта на дедлайне");
      if (m.completedAt) {
        requireFpr(validTime(m.completedAt) && validTime(a.startedAt!) && Date.parse(m.completedAt) >= Date.parse(a.startedAt!), "Некорректное время окончания матча");
        if (Date.parse(m.completedAt) > Date.parse(s.endsAt) - 180_000) requireFpr(m.lastRallyStartedAt && validTime(m.lastRallyStartedAt)
          && Date.parse(m.lastRallyStartedAt) >= Date.parse(a.startedAt!) && Date.parse(m.lastRallyStartedAt) <= Date.parse(s.endsAt) - 180_000
          && typeof m.lateEntryReason === "string" && m.lateEntryReason.trim(), "Нет записи о последнем розыгрыше на дедлайне");
      }
      if (a.status === "scheduled") requireFpr(m.score1 === null && m.score2 === null && !m.confirmed1 && !m.confirmed2, "Не начатый матч не может иметь счёт");
      if (a.status === "closed") requireFpr(confirmed(m), "Неполный раунд нельзя включить в зачёт");
    }
    requireFpr(assigned.length === a.activeIds.length && new Set(assigned).size === assigned.length
      && assigned.every(id => a.activeIds.includes(id)), "Игрок назначен дважды или пропущен");
    requireFpr(a.status === "scheduled" ? a.startedAt === null : a.status === "cancelled" || validTime(a.startedAt!), "Некорректный старт попытки");
    if (a.status === "closed" || a.status === "cancelled") requireFpr(validTime(a.finishedAt!)
      && (!a.startedAt || Date.parse(a.finishedAt!) >= Date.parse(a.startedAt)), "Некорректное завершение попытки");
    if (a.status === "closed") closed += 1;
    if (a.status === "running" || a.status === "scheduled") { open += 1; requireFpr(i === s.attempts.length - 1, "Открытая попытка должна быть последней"); }
  }
  requireFpr(open <= 1 && closed <= 8, "Несколько открытых попыток");
  if (s.status === "completed" || s.status === "incomplete") requireFpr(!open && validTime(s.finishedAt!)
    && (s.status === "completed" ? closed >= 6 : closed < 6), "Некорректное завершение турнира");
}

// The community worker reads the official protocol through its publication.
// Legacy level workers must never finalize this separate projection.
// Official results and timestamps stay inside fpr6x25; no level-rating fields.
export function fprProjection(state: FprState, previousParams: Record<string, unknown> = {}) {
  validateFprState(state);
  const standings = fprStandings(state);
  const params = {
    ...previousParams, fpr6x25: state, tournamentFamily: "fpr6x25", tournamentSubtype: "6x25",
    status: "awaiting_league_rules", state: "awaiting_league_rules", tournamentStatus: "awaiting_league_rules",
    finished: false, isFinished: false, tournamentFinished: false, manualFinish: false,
    finishedAt: null, completedAt: null, manualFinishedAt: null, published: false,
    totalRounds: 6, byePointsMode: "zero_points",
    leagueResultStatus: state.testMode || !state.communityRating ? "test_only"
      : state.status === "completed" ? "pending_community_recalculation" : state.status === "incomplete" ? "not_eligible" : "in_progress",
  };
  return {
    // A cached FPR client may still reach the generic handler after rollback.
    // Scored legacy rounds would make that handler finalize and award ratings.
    params, rounds: [], standings, totals: {}, playerLogs: {},
    summary: { status: "awaiting_league_rules", finished: false, totalRounds: 6,
      completedRounds: 0, totalMatches: 0, completedMatches: 0, byePolicy: "zero_points" },
  };
}

export function fprServeAt(match: FprMatch, pointsPlayed: number) {
  requireFpr(Number.isInteger(pointsPlayed) && pointsPlayed >= 0 && pointsPlayed < 25, "Некорректный номер розыгрыша");
  const order = [match.pair1[0], match.pair2[0], match.pair1[1], match.pair2[1]];
  return { playerId: order[Math.floor(pointsPlayed / 2) % 4], side: pointsPlayed % 2 === 0 ? "right" : "left", changeEnds: pointsPlayed === 12 };
}
