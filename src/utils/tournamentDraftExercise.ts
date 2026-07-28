import type { Exercise, Trainer } from "./apiClient";
import type { TournamentDraftSnapshot } from "./tournamentDraftStorage";

const AMERICANO_DIRECTION_ID = 2617;
const MEXICANO_DIRECTION_ID = 4769;
const MOSCOW_TIME_ZONE = "Europe/Moscow";

function toStringSafe(value: unknown) {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getLocalDateKey(value: string | null | undefined) {
  const normalized = toStringSafe(value);
  if (!normalized) return null;
  const isoDate = normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: MOSCOW_TIME_ZONE,
  }).format(parsed);
}

function formatMoscowTime(value: string | null | undefined, fallback = "09:00") {
  const normalized = toStringSafe(value);
  if (!normalized) return fallback;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function shiftMoscowTime(timeHHMM: string, minutes: number) {
  const [hourRaw, minuteRaw] = timeHHMM.split(":");
  const hour = Number.parseInt(hourRaw || "0", 10);
  const minute = Number.parseInt(minuteRaw || "0", 10);
  const normalizedHour = Number.isFinite(hour) ? Math.max(0, Math.min(23, hour)) : 0;
  const normalizedMinute = Number.isFinite(minute) ? Math.max(0, Math.min(59, minute)) : 0;
  const base = new Date(`2000-01-01T${String(normalizedHour).padStart(2, "0")}:${String(normalizedMinute).padStart(2, "0")}:00+03:00`);
  if (Number.isNaN(base.getTime())) {
    return timeHHMM;
  }
  base.setMinutes(base.getMinutes() + minutes);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(base);
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Организатор",
    lastName: parts.slice(1).join(" ") || "турнира",
  };
}

function getTournamentDirectionId(tournamentType: string) {
  return String(tournamentType).toLowerCase().includes("mex")
    ? MEXICANO_DIRECTION_ID
    : AMERICANO_DIRECTION_ID;
}

function getTournamentTypeName(tournamentType: string) {
  return String(tournamentType).toLowerCase().includes("mex")
    ? "Мексикано"
    : "Американо";
}

function getTournamentStatus(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  const syncStatus = toStringSafe(params.syncStatus).toLowerCase();
  const localStatus = toStringSafe(params.localStatus).toLowerCase();
  if (syncStatus === "synced_viva") return "COMPLETED";
  if (localStatus === "conducted_local") return "COMPLETED";
  if (toStringSafe(params.status).toLowerCase() === "completed") return "COMPLETED";
  if (toStringSafe(params.finishedAt)) return "COMPLETED";
  return null;
}

export function buildTournamentDraftExercise(
  snapshot: TournamentDraftSnapshot,
  options?: {
    currentProfileId?: string | null;
  },
): Exercise | null {
  const payload = snapshot?.payload;
  if (!payload || !toStringSafe(payload.tournamentId)) return null;

  const params = isRecord(payload.params) ? payload.params : null;
  const localDateKey = getLocalDateKey(
    toStringSafe(params?.localDateKey)
    || toStringSafe(payload.createdAt),
  );
  if (!localDateKey) return null;

  const timeSeed = formatMoscowTime(payload.createdAt, "09:00");
  const timeFrom = `${localDateKey}T${timeSeed}:00+03:00`;
  const timeTo = `${localDateKey}T${shiftMoscowTime(timeSeed, 120)}:00+03:00`;
  const stationName = toStringSafe(params?.stationName) || "Локальная площадка";
  const organizerName = toStringSafe(params?.organizerName) || "Организатор";
  const organizerId = toStringSafe(payload.organizer?.id) || options?.currentProfileId || `local-trainer:${payload.tournamentId}`;
  const organizerSplit = splitName(organizerName);
  const firstCourtName = payload.courts?.[0] ? toStringSafe(payload.courts[0]) : "Корт";

  const trainer: Trainer = {
    id: organizerId,
    firstName: organizerSplit.firstName,
    lastName: organizerSplit.lastName,
    photo: undefined,
  };

  return {
    id: payload.tournamentId,
    direction: {
      id: getTournamentDirectionId(payload.tournamentType),
      name: getTournamentTypeName(payload.tournamentType),
    },
    type: {
      id: getTournamentDirectionId(payload.tournamentType),
      name: getTournamentTypeName(payload.tournamentType),
      color: "#1F1F1F",
      format: "TOURNAMENT",
    },
    timeFrom,
    timeTo,
    clientsCount: Array.isArray(payload.participants) ? payload.participants.length : 0,
    maxClientsCount: Array.isArray(payload.participants) ? payload.participants.length : 0,
    girlsOnly: false,
    studio: {
      id: `local-studio:${payload.tournamentId}`,
      name: stationName,
      country: "Россия",
      city: "",
      address: "",
      panoramicCourtsCount: null,
      masterServiceId: null,
      preferredSubServiceId: null,
      subServiceIds: [],
      lat: null,
      lng: null,
    },
    room: {
      id: `local-room:${payload.tournamentId}`,
      name: firstCourtName,
    },
    trainers: [trainer],
    status: getTournamentStatus(params),
    state: getTournamentStatus(params),
    cancellationDeadline: null,
    archived: false,
    ...({
      tournamentId: payload.tournamentId,
      sourceTournamentId: payload.tournamentId,
      raw: snapshot,
    } as Record<string, unknown>),
  } as Exercise;
}
