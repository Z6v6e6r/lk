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
// Media is rendered by public screens. Never forward executable URLs or URL credentials.
export function publicMediaUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw || [...raw].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\")) return null;
  // Node-RED's Function sandbox does not guarantee the Node URL global.
  const absolute = /^\/(?!\/)/.test(raw) ? "https://padlhub.su" + raw : raw;
  const match = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(absolute);
  if (!match || !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(match[1])) return null;
  try {
    const query = absolute.split("#")[0].split("?").slice(1).join("?");
    if (query.split("&").some(pair => /token|secret|password|authorization|signature|credential/i.test(decodeURIComponent(pair.split("=")[0])))) return null;
    return absolute;
  } catch { return null; }
}
const firstText = (records: PublicRecord[], keys: string[]): string | null => records.flatMap(row => keys.map(key => text(row[key]))).find(Boolean) || null;
const firstMedia = (records: PublicRecord[], keys: string[]): string | null => records.flatMap(row => keys.map(key => publicMediaUrl(row[key]))).find(Boolean) || null;
export function publicCommunityHeader(value: unknown) {
  const community = record(value);
  const legacy = /^data:image\//i.test(text(community.logoLegacyDataUrl || community.logo));
  const legacyUrl = legacy && text(community.id) ? publicMediaUrl("/lk/media/community-logo-legacy/" + encodeURIComponent(text(community.id))) : null;
  const communityLogoUrl = firstMedia([community], ["logoUrl", "imageUrl", "logoThumbUrl", "logoThumb", "thumbnailUrl", "logo"]) || legacyUrl;
  return { communityName: text(community.name) || "Сообщество", communityLogoUrl };
}
function publicPlayerName(row: PublicRecord): string {
  const name = firstText([row], ["playerName", "name", "displayName", "fullName"]);
  const identities = ["playerId", "playerPhone", "playerKey", "id", "clientId", "phone", "phoneNorm", "memberKey", "membershipId"];
  return !name || /^[+()\d\s-]{7,}$/.test(name) || identities.some(key => name === text(row[key])) ? "Игрок" : name;
}
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
  const row = record(value), playerName = publicPlayerName(row);
  const lastRatingDelta = row.lastRatingDelta == null ? null : number(row.lastRatingDelta);
  const overallScore = Math.round(number(row.overallScore) * 100) / 100;
  return {
    rank: Math.max(1, Math.floor(number(row.rank))),
    initials: playerName.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || "").join("").toUpperCase(),
    playerName, avatarUrl: firstMedia([row], ["avatarUrl", "avatar", "photo", "imageUrl"]),
    overallScore, scoreDisplay: String(overallScore).replace(".", ","),
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
  return [post, record(details.publicTournament), record(details.sourceTournamentSnapshot), record(details.sourceTournament), record(details.tournament), record(details.customTournament), record(details.exercise), record(details.details), record(details.game), record(details.publicGame), record(details.booking), details, record(post.params), record(post.summary), record(post.booking)];
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
  const cardFields = ["title", "name", "gameTitle", "photo", "photoUrl", "imageUrl", "stationId", "stationName", "stationAddress", "studioId", "studioName", "studioAddress", "locationName", "address", "levelFrom", "levelTo", "minRating", "maxRating", "accessLevels", "spotsTaken", "spotsTotal", "participantsCount", "joinedCount", "clientsCount", "maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit", "directionId", "cardKind"];
  const nested = ["settings.isPrivate", "settings.minRating", "settings.maxRating", "invite.maxPlayers", "metadata.gameFormat", "metadata.gameTitle", "metadata.directionId", "metadata.cardKind", "direction.id", "skin.title", "skin.imageUrl", ...["station", "studio", "location"].flatMap(prefix => ["id", "name", "address", "fullAddress"].map(key => prefix + "." + key))];
  // Identity fields are used only for roster deduplication/name redaction and never serialized.
  const players = ["participants", "organizer"].flatMap(prefix => ["id", "clientId", "memberKey", "membershipId", "phone", "phoneNorm", "name", "playerName", "displayName", "fullName", "photo", "avatarUrl", "avatar", "imageUrl", "status", "isCancelled", "cancelled"].map(key => prefix + "." + key));
  return Object.fromEntries([["_id", 0], ...identityFields.map(key => [key, 1]), ...["", "params.", "summary.", "booking."].flatMap(prefix => [...fields, ...cardFields, ...nested].map(key => [prefix + key, 1])), ...players.map(key => [key, 1])]);
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
  return publicationRecords(post).flatMap(source => [source, record(source.settings)]).every(source => {
    const statuses = [source.status, source.state, source.tournamentStatus].map(value => text(value).toUpperCase());
    return source.archived !== true && source.cancelled !== true && source.canceled !== true
      && source.isPrivate !== true && source.published !== false && source.isPublished !== false
      && !statuses.some(status => ["DRAFT", "CANCELLED", "CANCELED", "DELETED", "HIDDEN", "UNPUBLISHED"].includes(status))
      && !["CLOSED", "PRIVATE", "HIDDEN"].includes(text(source.visibility).toUpperCase());
  });
}
function cardLevel(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
  const label = text(value).toUpperCase().replace(",", ".");
  if (/^(?:[A-D]\+?|D1)$/.test(label)) return label;
  return /^\d(?:\.\d{1,2})?$/.test(label) ? Number(label) : null;
}
function cardLevelRange(records: PublicRecord[]) {
  if (!records.some(row => ["levelFrom", "levelTo", "minRating", "maxRating", "accessLevels"].some(key => Object.hasOwn(row, key)))) return null;
  const allowed = records.find(row => Array.isArray(row.accessLevels));
  const levels = Array.isArray(allowed?.accessLevels) ? allowed.accessLevels.map(cardLevel).filter(value => value != null) : [];
  const order = (value: string | number) => typeof value === "number" ? value : ({ D: 1, D1: 1, "D+": 2, C: 3, "C+": 3.5, B: 4.5, "B+": 5, A: 6, "A+": 7 }[value] ?? 0);
  levels.sort((a, b) => order(a) - order(b));
  const pick = (keys: string[]) => records.flatMap(row => keys.map(key => cardLevel(row[key]))).find(value => value != null) ?? null;
  return { levelFrom: pick(["levelFrom", "minRating"]) ?? levels[0] ?? null, levelTo: pick(["levelTo", "maxRating"]) ?? levels[levels.length - 1] ?? null };
}
function nonnegativeCount(records: PublicRecord[], keys: string[]): number | null {
  for (const row of records) for (const key of keys) {
    const value = row[key];
    if ((typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value)) && Number(value) >= 0) return Math.floor(Number(value));
  }
  return null;
}
function confirmedRoster(records: PublicRecord[]) {
  const owner = records.find(row => Array.isArray(row.participants));
  const raw = owner ? owner.participants as unknown[] : records.map(row => row.organizer).filter(value => Object.keys(record(value)).length).slice(0, 1);
  const seen = new Set<string>(), players: PublicRecord[] = [];
  for (const value of raw) {
    const player = record(value), status = text(player.status).toUpperCase();
    if (!Object.keys(player).length || player.isCancelled === true || player.cancelled === true || !["", "CONFIRMED", "ACTIVE", "JOINED"].includes(status)) continue;
    const keys = ["id", "clientId", "memberKey", "membershipId"].map(key => text(player[key])).filter(Boolean).map(id => "id:" + id);
    let phone = text(player.phone || player.phoneNorm).replace(/\D/g, "");
    if (phone.length === 10) phone = "7" + phone;
    if (phone.length === 11 && phone.startsWith("8")) phone = "7" + phone.slice(1);
    if (phone) keys.push("phone:" + phone);
    const duplicate = keys.some(key => seen.has(key));
    keys.forEach(key => seen.add(key));
    if (!duplicate) players.push(player);
  }
  return { present: Boolean(owner) || raw.length > 0, players };
}
function eventCardFields(post: PublicRecord, source: PublicRecord | undefined, startsTs: number, endsTs: number, kind: string) {
  const sourceRecords = source ? publicationRecords(source) : [], postRecords = publicationRecords(post);
  const records = [...sourceRecords, ...postRecords];
  const expand = (rows: PublicRecord[]) => rows.flatMap(row => [row, record(row.settings), record(row.invite), record(row.metadata), record(row.skin)]);
  const sourceDetails = expand(sourceRecords), postDetails = expand(postRecords), details = [...sourceDetails, ...postDetails];
  const locationValue = (rows: PublicRecord[], keys: string[], nestedKeys: string[]) => firstText(rows, keys) || firstText(rows.flatMap(row => [record(row.station), record(row.studio), record(row.location)]), nestedKeys);
  const date = (ts: number) => new Date(ts + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const time = (ts: number) => new Date(ts).toLocaleTimeString("ru-RU", { timeZone: COMMUNITY_MONTHLY_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  const timeFrom = time(startsTs), timeTo = time(endsTs);
  const direction = details.some(row => String(row.directionId || record(row.direction).id || "") === "5278");
  const cardKind = direction || firstText(details, ["cardKind"]) === "friends" ? "friends" : kind === "TOURNAMENT" ? "tournament" : kind === "GAME" ? "game" : null;
  const roster = kind === "GAME" ? confirmedRoster(records) : { present: false, players: [] };
  const capacityKeys = ["spotsTotal", "maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit"];
  const formatCapacity = (rows: PublicRecord[]) => kind === "GAME" && firstText(rows, ["gameFormat"]) ? (firstText(rows, ["gameFormat"])?.toLowerCase() === "singles" ? 2 : 4) : null;
  const spotsTotal = nonnegativeCount(sourceDetails, capacityKeys) ?? formatCapacity(sourceDetails) ?? nonnegativeCount(postDetails, capacityKeys) ?? formatCapacity(postDetails) ?? (kind === "GAME" ? 4 : null);
  const spotsTaken = roster.present ? roster.players.length : nonnegativeCount(details, ["spotsTaken", "participantsCount", "joinedCount", "clientsCount"]);
  const stationName = locationValue(sourceRecords, ["stationName", "studioName", "locationName"], ["name"]) || locationValue(postRecords, ["stationName", "studioName", "locationName"], ["name"]);
  const stationId = locationValue(sourceRecords, ["stationId", "studioId"], ["id"]) || locationValue(postRecords, ["stationId", "studioId"], ["id"]);
  const address = locationValue(sourceRecords, ["stationAddress", "studioAddress", "address", "fullAddress"], ["address", "fullAddress"]) || locationValue(postRecords, ["stationAddress", "studioAddress", "address", "fullAddress"], ["address", "fullAddress"]);
  const title = firstText(details, ["gameTitle", "title", "name"]) || (cardKind === "friends" ? `${timeFrom}–${timeTo}` : kind === "GAME" ? "Игра" : kind === "TOURNAMENT" ? "Турнир" : "Событие");
  return {
    cardKind, title, photo: firstMedia(details, ["photo", "photoUrl", "imageUrl"]),
    date: date(startsTs), endsDate: date(endsTs), dateLabel: new Date(startsTs).toLocaleDateString("ru-RU", { timeZone: COMMUNITY_MONTHLY_TIME_ZONE, day: "numeric", month: "long" }),
    timeFrom, timeTo, timeDisplay: `${timeFrom}–${timeTo}`, stationId, stationName, address,
    ...(cardLevelRange(sourceDetails) ?? cardLevelRange(postDetails) ?? { levelFrom: null, levelTo: null }), spotsTaken, spotsTotal,
    players: roster.players.slice(0, 4).map(player => ({ playerName: publicPlayerName(player), avatarUrl: firstMedia([player], ["avatarUrl", "photo", "avatar", "imageUrl"]) })),
  };
}
export function publicPublishedEvent(post: PublicRecord, nowTs: number, scope: "upcoming" | "all" = "upcoming", source?: PublicRecord) {
  if (!publicationIsPublic(post) || (source && !publicationIsPublic({ ...source, kind: post.kind }))) return null;
  const eventId = publicationEventId(post), kind = text(post.kind || post.type).toUpperCase();
  const startsTs = (source ? publicationStartTs(source) : null) ?? publicationStartTs(post);
  if (!eventId || startsTs == null) return null;
  const records = [...(source ? publicationRecords(source) : []), ...publicationRecords(post)];
  const endsTs = records.flatMap(item => {
    const end = bookingInstant(item, "timeTo");
    const bookingEnd = end != null && end <= startsTs && bookingInstant(item, "timeFrom") === startsTs ? end + 24 * 60 * 60 * 1000 : end;
    return [eventInstant(item.endsAt), eventInstant(item.endAt), eventInstant(item.timeToIso), eventInstant(item.timeTo), eventInstant(item.dateTimeTo), bookingEnd];
  }).find(ts => ts != null && ts > startsTs)
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
  return { postId: text(post.id), eventId, kind, ...eventCardFields(post, source, startsTs, endsTs, kind), startsAt: new Date(startsTs).toISOString(), endsAt: new Date(endsTs).toISOString(), timeZone: COMMUNITY_MONTHLY_TIME_ZONE, status: finished ? "completed" : endsTs <= nowTs ? "past" : upcoming ? "upcoming" : "in_progress", signupUrl: finished || endsTs <= nowTs ? null : signupUrl, canRegister: !finished && upcoming && Boolean(signupUrl) && !records.some(item => item.registrationClosed === true || item.bookingAllowed === false), availabilitySource: "published_community_data" };
}
