export { COMMUNITY_RATING_CALCULATION_VERSION } from "./contract.ts";
export const COMMUNITY_MONTHLY_SCHEMA = "community-monthly-v1";
export const COMMUNITY_MONTHLY_COLLECTION = "community_monthly_reports";
export const COMMUNITY_MONTHLY_TIME_ZONE = "Europe/Moscow";
export const COMMUNITY_MONTHLY_COLUMNS = [
  { key: "rank", label: "Место" }, { key: "initials", label: "Инициалы" },
  { key: "playerName", label: "Игрок" }, { key: "overallScore", label: "Общий балл" },
  { key: "levelDirection", label: "Уровень ↑↓" }, { key: "tournamentsPlayed", label: "Турниры" },
  { key: "tournamentMatchesWon", label: "Победы в матчах" },
  { key: "tournamentPointsScored", label: "Очки за" }, { key: "tournamentPointsDiff", label: "Разница очков" },
] as const;
export type PublicRecord = Record<string, unknown>;
export const record = (value: unknown): PublicRecord => value && typeof value === "object" && !Array.isArray(value) ? value as PublicRecord : {};
export const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
export const number = (value: unknown): number => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
export function eventInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  let iso = value.trim();
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!dateParts || Number(dateParts[2]) < 1 || Number(dateParts[2]) > 12 || Number(dateParts[3]) < 1 || Number(dateParts[3]) > new Date(Date.UTC(Number(dateParts[1]), Number(dateParts[2]), 0)).getUTCDate()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00+03:00";
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(iso)) iso = iso.replace(" ", "T") + "+03:00";
  else if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}
export function communityMonthWindow(nowTs = Date.now()) {
  if (!Number.isFinite(nowTs)) throw new Error("INVALID_REPORT_TIME");
  const moscow = new Date(nowTs + 3 * 60 * 60 * 1000);
  const year = moscow.getUTCFullYear(), month = moscow.getUTCMonth();
  const fromTs = Date.UTC(year, month, 1) - 3 * 60 * 60 * 1000;
  const untilTs = Date.UTC(year, month + 1, 1) - 3 * 60 * 60 * 1000;
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { month: monthKey, timeZone: COMMUNITY_MONTHLY_TIME_ZONE, from: new Date(fromTs).toISOString(), until: new Date(untilTs).toISOString(), fromTs, untilTs };
}
export function monthlyReportId(communityId: string, month: string): string {
  return `${COMMUNITY_MONTHLY_SCHEMA}:${encodeURIComponent(communityId)}:${month}`;
}
export function publicRankingRow(value: unknown) {
  const row = record(value), rawName = text(row.playerName);
  const playerName = !rawName || /^[+()\d\s-]{7,}$/.test(rawName) || rawName === text(row.playerId) || rawName === text(row.playerPhone) || rawName === text(row.playerKey) ? "Игрок" : rawName;
  const lastRatingDelta = row.lastRatingDelta == null ? null : number(row.lastRatingDelta);
  const overallScore = Math.round(number(row.overallScore) * 100) / 100;
  return {
    rank: Math.max(1, Math.floor(number(row.rank))),
    initials: playerName.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || "").join("").toUpperCase(),
    playerName, overallScore, scoreDisplay: String(overallScore).replace(".", ","),
    currentLevel: number(row.currentLevel),
    levelDirection: lastRatingDelta == null || lastRatingDelta === 0 ? "flat" : lastRatingDelta > 0 ? "up" : "down",
    lastRatingDelta,
    tournamentsPlayed: Math.max(0, Math.floor(number(row.tournamentsPlayed))),
    tournamentMatchesWon: Math.max(0, Math.floor(number(row.tournamentMatchesWon))),
    tournamentPointsScored: number(row.tournamentPointsScored), tournamentPointsDiff: number(row.tournamentPointsDiff),
  };
}
export function publicationRecords(post: PublicRecord): PublicRecord[] {
  const details = record(post.details);
  return [post, record(details.publicTournament), record(details.sourceTournamentSnapshot), record(details.sourceTournament), record(details.exercise), record(details.details), record(details.game), record(details.publicGame), record(details.booking), details, record(post.params), record(post.summary), record(post.booking)];
}
function bookingInstant(source: PublicRecord, clockKey: "timeFrom" | "timeTo"): number | null {
  const date = text(source.date), clock = text(source[clockKey]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(clock)) return null;
  return eventInstant(date + "T" + clock + "+03:00");
}
export function publishedEventStartTs(post: PublicRecord, source?: PublicRecord): number | null {
  return publicationStartTs(post) ?? (source ? publicationStartTs(source) : null);
}
export function publicEventSourceProjection(identityFields: string[]): Record<string, 0 | 1> {
  const fields = ["archived", "status", "state", "tournamentStatus", "visibility", "isPrivate", "published", "isPublished", "cancelled", "canceled", "startsAt", "startAt", "endsAt", "endAt", "datetime", "date", "timeFrom", "timeTo", "timeFromIso", "timeToIso", "dateTimeFrom", "dateTimeTo", "finished", "finishedAt", "completedAt", "registrationClosed", "bookingAllowed"];
  return Object.fromEntries([["_id", 0], ...identityFields.map(key => [key, 1]), ...["", "params.", "summary.", "booking."].flatMap(prefix => fields.map(key => [prefix + key, 1]))]);
}
export function publicationStartTs(post: PublicRecord): number | null {
  for (const source of publicationRecords(post)) {
    const bookingStart = bookingInstant(source, "timeFrom");
    if (bookingStart != null) return bookingStart;
    for (const key of ["startsAt", "startAt", "timeFromIso", "timeFrom", "dateTimeFrom", "datetime", "eventAt", "eventDate", "date"]) {
      const ts = eventInstant(source[key]);
      if (ts != null) return ts;
    }
  }
  return null;
}
export function publicationEventId(post: PublicRecord): string {
  const kind = text(post.kind || post.type).toUpperCase();
  const direct = text(kind === "GAME" ? post.relatedGameId || post.gameId : post.relatedTournamentId || post.relatedExerciseId || post.exerciseId);
  if (direct && !/^[a-f0-9]{24}$/i.test(direct)) return direct;
  for (const source of publicationRecords(post).slice(1)) {
    const candidate = text(source.relatedTournamentId || source.exerciseId || source.sourceTournamentId || source.tournamentId || source.id);
    if (candidate && !/^[a-f0-9]{24}$/i.test(candidate)) return candidate;
  }
  return "";
}
export function publicationIsPublic(post: PublicRecord): boolean {
  const kind = text(post.kind || post.type).toUpperCase();
  if (!["GAME", "TOURNAMENT", "TRAINING", "GROUP_TRAINING", "EXERCISE", "EVENT"].includes(kind)) return false;
  return publicationRecords(post).every(source => {
    const statuses = [source.status, source.state, source.tournamentStatus].map(value => text(value).toUpperCase());
    return source.archived !== true && source.cancelled !== true && source.canceled !== true
      && source.isPrivate !== true && source.published !== false && source.isPublished !== false
      && !statuses.some(status => ["DRAFT", "CANCELLED", "CANCELED", "DELETED", "HIDDEN", "UNPUBLISHED"].includes(status))
      && !["CLOSED", "PRIVATE", "HIDDEN"].includes(text(source.visibility).toUpperCase());
  });
}
export function publicPublishedEvent(post: PublicRecord, nowTs: number, scope: "upcoming" | "all" = "upcoming", source?: PublicRecord) {
  if (!publicationIsPublic(post) || (source && !publicationIsPublic({ ...source, kind: post.kind }))) return null;
  const eventId = publicationEventId(post), kind = text(post.kind || post.type).toUpperCase();
  const startsTs = publishedEventStartTs(post, source);
  if (!eventId || startsTs == null) return null;
  const records = [...publicationRecords(post), ...(source ? publicationRecords(source) : [])];
  const endsTs = records.flatMap(item => [eventInstant(item.endsAt), eventInstant(item.endAt), eventInstant(item.timeToIso), eventInstant(item.timeTo), eventInstant(item.dateTimeTo), bookingInstant(item, "timeTo")]).find(ts => ts != null && ts > startsTs)
    ?? startsTs + (kind === "TOURNAMENT" ? 3 : 1) * 60 * 60 * 1000;
  const finished = records.some(item => [item.status, item.state, item.tournamentStatus].some(value => ["COMPLETED", "FINISHED", "CLOSED", "DONE"].includes(text(value).toUpperCase())) || item.finished === true || Boolean(text(item.finishedAt || item.completedAt)));
  if (scope === "upcoming" && (endsTs <= nowTs || finished)) return null;
  const paths: Record<string, string> = { TOURNAMENT: "/tournaments?tournamentId=", GAME: "/game_join?gameId=", TRAINING: "/group_schedule?exerciseId=", GROUP_TRAINING: "/group_schedule?exerciseId=", EXERCISE: "/group_schedule?exerciseId=" };
  let signupUrl = paths[kind] ? "https://padlhub.ru" + paths[kind] + encodeURIComponent(eventId) : null;
  if (!signupUrl && kind === "EVENT") {
    // Canonicalize known public routes rather than forwarding arbitrary query/credential data.
    const raw = records.map(item => text(item.signupUrl || item.registrationUrl)).find(Boolean) || "";
    const match = /^https:\/\/padlhub\.ru\/(tournaments|game_join|group_schedule)\?([^#\s]+)$/i.exec(raw);
    if (match) {
      const pairs = match[2].split("&").map(pair => pair.split("="));
      const expected = match[1].toLowerCase() === "tournaments" ? "tournamentId" : match[1].toLowerCase() === "game_join" ? "gameId" : "exerciseId";
      try {
        if (pairs.length === 1 && decodeURIComponent(pairs[0][0]) === expected) signupUrl = `https://padlhub.ru/${match[1].toLowerCase()}?${expected}=${encodeURIComponent(decodeURIComponent(pairs[0][1] || ""))}`;
      } catch { signupUrl = null; }
    }
  }
  const upcoming = startsTs > nowTs;
  return { postId: text(post.id), eventId, kind, title: text(post.title) || "Событие", startsAt: new Date(startsTs).toISOString(), endsAt: new Date(endsTs).toISOString(), timeZone: COMMUNITY_MONTHLY_TIME_ZONE, status: finished ? "completed" : endsTs <= nowTs ? "past" : upcoming ? "upcoming" : "in_progress", signupUrl: finished || endsTs <= nowTs ? null : signupUrl, canRegister: !finished && upcoming && Boolean(signupUrl) && !records.some(item => item.registrationClosed === true || item.bookingAllowed === false), availabilitySource: "published_community_data" };
}
