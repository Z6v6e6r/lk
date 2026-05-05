import { PHAB_API_BASE, TENANT_KEY } from "../consts/api_config";
import { request, type ApiResult } from "./apiClient";

export type TournamentSignupStatus = "AVAILABLE" | "REGISTERED" | "WAITLIST" | "FULL" | "CLOSED" | "CANCELLED";

export interface TournamentSignupSummary {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  date: string | null;
  timeLabel: string;
  studioName: string | null;
  address: string | null;
  format: string | null;
  levelLabel: string | null;
  priceLabel: string | null;
  participantsCount: number | null;
  maxParticipants: number | null;
  waitlistCount: number | null;
  status: TournamentSignupStatus;
  publicUrl: string | null;
  raw: unknown;
}

export interface TournamentSignupDetail extends TournamentSignupSummary {
  description: string | null;
  rules: string | null;
  trainerName: string | null;
  registration: TournamentRegistrationState | null;
}

export interface TournamentRegistrationState {
  status: "NONE" | "REGISTERED" | "WAITLIST";
  placeNumber: number | null;
  waitlistNumber: number | null;
  canRegister: boolean;
  canCancel: boolean;
  message: string | null;
}

type QueryValue = string | number | boolean | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function normalizeStatus(value: unknown): TournamentSignupStatus {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "REGISTERED") return "REGISTERED";
  if (raw === "WAITLIST" || raw === "WAITLISTED") return "WAITLIST";
  if (raw === "FULL") return "FULL";
  if (raw === "CLOSED" || raw === "FINISHED") return "CLOSED";
  if (raw === "CANCELLED" || raw === "CANCELED") return "CANCELLED";
  return "AVAILABLE";
}

function normalizeRegistration(value: unknown): TournamentRegistrationState | null {
  if (!isRecord(value)) return null;
  const statusRaw = String(pickString(value, ["status", "state", "registrationStatus"]) || "NONE").toUpperCase();
  const status =
    statusRaw === "REGISTERED" || statusRaw === "CONFIRMED"
      ? "REGISTERED"
      : statusRaw === "WAITLIST" || statusRaw === "WAITLISTED"
        ? "WAITLIST"
        : "NONE";

  return {
    status,
    placeNumber: pickNumber(value, ["placeNumber", "position", "participantPosition"]),
    waitlistNumber: pickNumber(value, ["waitlistNumber", "waitlistPosition", "queuePosition"]),
    canRegister: value.canRegister !== false,
    canCancel: value.canCancel !== false && status !== "NONE",
    message: pickString(value, ["message", "reason", "note"]),
  };
}

function formatTimeRange(startsAt: string | null, endsAt: string | null) {
  const start = startsAt ? new Date(startsAt) : null;
  const end = endsAt ? new Date(endsAt) : null;
  const startValid = start && !Number.isNaN(start.getTime());
  const endValid = end && !Number.isNaN(end.getTime());
  if (!startValid) return "Время уточняется";
  const startLabel = start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!endValid) return startLabel;
  const endLabel = end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${startLabel} - ${endLabel}`;
}

function formatDate(startsAt: string | null) {
  if (!startsAt) return null;
  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeTournamentSummary(value: unknown): TournamentSignupSummary | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "tournamentId", "uuid", "exerciseId"]);
  if (!id) return null;

  const studio = pickNestedRecord(value, ["studio", "station", "club", "location"]);
  const startsAt = pickString(value, ["startsAt", "startAt", "timeFrom", "dateTimeFrom", "startTime"]);
  const endsAt = pickString(value, ["endsAt", "endAt", "timeTo", "dateTimeTo", "endTime"]);
  const price = pickNumber(value, ["price", "amount", "cost"]);
  const currency = pickString(value, ["currency", "currencyCode"]) || "RUB";
  const maxParticipants = pickNumber(value, ["maxParticipants", "maxPlayers", "limit", "capacity"]);
  const participantsCount = pickNumber(value, ["participantsCount", "registeredCount", "playersCount", "joinedCount"]);
  const waitlistCount = pickNumber(value, ["waitlistCount", "queueCount"]);

  return {
    id,
    title: pickString(value, ["title", "name", "displayName"]) || "Турнир",
    startsAt,
    endsAt,
    date: pickString(value, ["date", "day"]) || formatDate(startsAt),
    timeLabel: formatTimeRange(startsAt, endsAt),
    studioName: pickString(value, ["studioName", "stationName", "clubName"]) || pickString(studio, ["name", "title"]),
    address: pickString(value, ["address", "studioAddress"]) || pickString(studio, ["address", "fullAddress"]),
    format: pickString(value, ["format", "tournamentType", "type", "category"]),
    levelLabel: pickString(value, ["levelLabel", "level", "ratingRange", "accessLevels"]),
    priceLabel: pickString(value, ["priceLabel", "priceText"]) || (price != null ? `${price.toLocaleString("ru-RU")} ${currency}` : null),
    participantsCount,
    maxParticipants,
    waitlistCount,
    status: normalizeStatus(pickString(value, ["status", "registrationStatus", "state"])),
    publicUrl: pickString(value, ["publicUrl", "url", "link"]),
    raw: value,
  };
}

function normalizeTournamentDetail(value: unknown): TournamentSignupDetail | null {
  const summary = normalizeTournamentSummary(value);
  if (!summary) return null;
  const registration = normalizeRegistration(
    isRecord(value) ? value.registration || value.myRegistration || value.viewerRegistration : null,
  );
  return {
    ...summary,
    description: pickString(value, ["description", "body", "text", "details"]),
    rules: pickString(value, ["rules", "policy"]),
    trainerName: pickString(value, ["trainerName", "coachName", "organizerName"]),
    registration,
  };
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["items", "content", "data", "tournaments", "results"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function buildQuery(params: Record<string, QueryValue>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    query.set(key, String(value));
  });
  const value = query.toString();
  return value ? `?${value}` : "";
}

function phabHeaders() {
  return {
    "X-PadlHub-Auth-Source": "lk-keycloak",
    "X-PadlHub-Tenant-Key": TENANT_KEY,
  };
}

export async function apiFetchTournamentSignupList(params: {
  date?: string | null;
  from?: string | null;
  to?: string | null;
} = {}): Promise<ApiResult<TournamentSignupSummary[]>> {
  const result = await request<unknown>(
    `/tournaments${buildQuery(params)}`,
    {
      baseUrl: PHAB_API_BASE,
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: extractItems(result.data)
      .map((item) => normalizeTournamentSummary(item))
      .filter((item): item is TournamentSignupSummary => item !== null),
  };
}

export async function apiFetchTournamentSignupDetail(
  tournamentId: string,
): Promise<ApiResult<TournamentSignupDetail>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}`,
    {
      baseUrl: PHAB_API_BASE,
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeTournamentDetail(result.data),
  };
}

export async function apiFetchTournamentMyRegistration(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/registration/me`,
    {
      baseUrl: PHAB_API_BASE,
      method: "GET",
      auth: true,
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}

export async function apiRegisterForTournament(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/register`,
    {
      baseUrl: PHAB_API_BASE,
      method: "POST",
      auth: true,
      headers: phabHeaders(),
      body: JSON.stringify({ authProvider: "lk-keycloak", tenantKey: TENANT_KEY }),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}

export async function apiCancelTournamentRegistration(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/register`,
    {
      baseUrl: PHAB_API_BASE,
      method: "DELETE",
      auth: true,
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}
