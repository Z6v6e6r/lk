import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { Modal } from "../UI/Modal";
import { BookingCancellationDialog } from "../cabinet/BookingCancellationDialog";
import {
  apiFetchBookings,
  apiCreateAmericanoTournament,
  apiFetchExercisesByPeriod,
  apiFetchExercisesByVisibleDate,
  apiFetchPadelLiveRatings,
  apiFetchProfile,
  apiSearchPadelPlayers,
  apiFetchTournamentHistory,
  apiFetchTournamentParticipants,
  apiRefreshTournamentParticipants,
  apiFetchTournamentBroadcastState,
  isTournamentExerciseCategory,
  apiSaveOnboardingLevel,
  apiSetTournamentBroadcastState,
  apiUpdateAmericanoResults,
  getServ2Origin,
} from "../../utils/apiClient";
import type {
  AmericanoTournamentPayload,
  AmericanoResultsResponse,
  AmericanoResultsPayload,
  Booking,
  Exercise,
  ExerciseBooking,
  PadelPlayerCandidate,
  TournamentTypeKey,
  TournamentHistoryRecord,
  TournamentBroadcastActiveTarget,
  TournamentBroadcastState,
  TournamentBroadcastStatus,
  TournamentBroadcastTarget,
  UserProfileType,
} from "../../utils/apiClient";
import { TENANT_KEY } from "../../consts/api_config";
import {
  apiFetchTournamentMechanicsSourceList,
  apiRefreshTournamentMechanicsFromViva,
} from "../../utils/tournamentSignupApi";
import {
  buildTournamentMechanicsFallbackExercises,
  mergeTournamentMechanicsExercises,
} from "../../utils/tournamentMechanicsExercises";
import { filterVisibleTournamentExercises } from "./tournamentVisibility";
import {
  buildTournamentRatingChangePayload,
  buildTournamentStartRatingChanges,
} from "./tournamentRatingAudit";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  hasTournamentHostingAccess,
  parseNumericLevel,
} from "../../utils/customFields";
import {
  buildAmericanoStandings,
  createAmericanoRounds,
  createPairedAmericanoRounds,
  createPairedMexicanoInitialRounds,
  hydrateAmericanoRounds,
  parseTournamentRatingValue,
  serializeAmericanoRounds,
  type PairedMexicanoPairAssignment,
  type AmericanoLabParticipant as ParticipantEntry,
  type AmericanoLabRound as TournamentRound,
} from "./americanoLab";
import {
  appendMexicanoClassicRoundIfReady,
  buildClassicMexicanoMatchSaveResults,
  buildMexicanoClassicParams,
  createMexicanoClassicInitialRound,
  rebuildMexicanoClassicFutureRounds,
  shouldPreferClassicMexicanoCachedSnapshot,
  shouldPreferClassicMexicanoSnapshot,
  type MexicanoClassicOptions,
} from "./mexicanoClassic";
import {
  buildTournamentFinishConfirmationCopy,
  buildTournamentResumeParams,
  getTournamentProgressState,
  isTournamentManuallyFinished,
  isTournamentMarkedFinished,
} from "./tournamentLifecycle";
import {
  buildPairedTournamentStandingsGroups,
  parseAmericanoStandingsSortMode,
  resolveTournamentParticipantEntries,
  resolveTournamentStandingsSortModeValue,
  type TournamentStandingsSortMode,
} from "./tournamentManagerConfig";
import {
  getPendingTournamentResultSyncCount,
  hasPendingTournamentResultJobs,
  flushPendingTournamentResultSyncJob,
  clearPendingTournamentResultQueueByTournamentId,
  loadPendingTournamentResultQueue,
  loadCachedTournamentHistory,
  loadCachedTournamentProfile,
  loadCachedTournamentSchedule,
  processPendingTournamentResultSyncQueue,
  saveCachedTournamentHistory,
  saveCachedTournamentProfile,
  saveCachedTournamentSchedule,
  submitTournamentResultsWithOfflineFallback,
  type TournamentOfflineResultQueueRecord,
} from "../../utils/tournamentOfflineSync";
import {
  listCachedTournamentDrafts,
  loadCachedTournamentDraft,
  saveCachedTournamentDraft,
  type TournamentDraftSnapshot,
} from "../../utils/tournamentDraftStorage";
import { buildTournamentDraftExercise } from "../../utils/tournamentDraftExercise";
import {
  LK_IDLE_DATA_STALE_EVENT_NAME,
  isLkIdleRequestPaused,
  isLkIdleRequestPausedError,
} from "../../utils/lkIdleDataGuard";
import {
  TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS,
  buildTournamentParticipantRosterFingerprint,
  resolveTournamentParticipantBusyRetryMs,
  resolveTournamentParticipantRefreshDelay,
  resolveVivaLinkedTournamentExerciseId,
  shouldApplyTournamentParticipantRefreshRoster,
  type TournamentParticipantRefreshOutcome,
} from "./tournamentParticipantRefresh";
import {
  getTournamentJsonFileName,
  parseTournamentJson,
  serializeTournamentJson,
} from "../../utils/tournamentJson";
import {
  formatTournamentBroadcastTargets,
  getTournamentBroadcastTargetOptions,
  isTournamentBroadcastTargetSelectionStation,
  isTournamentBroadcastTarget,
  normalizeTournamentBroadcastTargets,
  resolveTournamentBroadcastStationId,
} from "./tournamentBroadcast";

interface TournamentsPageProps {
  onBack: () => void;
  backLabel?: string;
  initialOpenTournamentId?: string | null;
  initialOpenTournamentSlug?: string | null;
  initialOpenDate?: string | null;
}

const DAYS_BEFORE_TODAY = 30;
const DAYS_AFTER_TODAY = 30;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const DEEP_LINK_LOOKUP_DAYS_BEFORE_TODAY = 365;
const DEEP_LINK_LOOKUP_DAYS_AFTER_TODAY = 365;

type TournamentFamilyKey = "americano" | "mexicano";

const TOURNAMENT_FAMILIES: Array<{ id: TournamentFamilyKey; label: string }> = [
  { id: "americano", label: "Американо" },
  { id: "mexicano", label: "Мексикано" },
];

const TOURNAMENT_SUBTYPES: Record<TournamentFamilyKey, Array<{
  id: TournamentTypeKey;
  label: string;
  description?: string;
}>> = {
  americano: [
    {
      id: "americano_classic",
      label: "Классическое",
      description: "Каждый раунд новый напарник и новые соперники, баланс пар по остаточному принципу.",
    },
    {
      id: "americano_flex",
      label: "Флекс",
      description: "Классическое американо с одним bye в раунде (4 × корты + 1 игрок).",
    },
    {
      id: "paired_americano",
      label: "Парное американо",
      description: "Фиксированные пары играют турнир между собой.",
    },
    {
      id: "americano_padelhub",
      label: "ПадлхАБ",
      description: "Текущее американо с мягким балансом повторов и уровней.",
    },
  ],
  mexicano: [
    {
      id: "mexicano",
      label: "Классическое",
      description: "Одиночный формат мексикано.",
    },
    {
      id: "paired_mexicano",
      label: "Парное",
      description: "Фиксированные пары и стартовая сетка по силе пар.",
    },
  ],
};

const HTML_TO_IMAGE_CDN =
  "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.min.js";
const TOURNAMENT_READY_STORAGE_PREFIX = "tournaments:ready";

type HtmlToImageApi = {
  toPng: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
  toJpeg: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
};

const TOURNAMENT_LEVEL_BADGE_COLORS: Record<string, string> = {
  A: "rgb(130, 100, 255)",
  "B+": "rgb(160, 84, 230)",
  B: "rgb(191, 68, 196)",
  "C+": "rgb(216, 58, 149)",
  C: "rgb(226, 67, 99)",
  "D+": "rgb(236, 99, 57)",
  D: "rgb(241, 138, 43)",
};

declare global {
  interface Window {
    htmlToImage?: HtmlToImageApi;
  }
}

function loadHtmlToImage(): Promise<HtmlToImageApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("html-to-image unavailable"));
  }
  if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HTML_TO_IMAGE_CDN;
    script.async = true;
    script.onload = () => {
      if (window.htmlToImage) resolve(window.htmlToImage);
      else reject(new Error("html-to-image not loaded"));
    };
    script.onerror = () => reject(new Error("failed to load html-to-image"));
    document.head.appendChild(script);
  });
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateKeyFromInput(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const isoDate = normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function formatTime(timeStr?: string) {
  return timeStr ? timeStr.slice(11, 16) : "";
}

function formatTournamentDateTimeLine(timeFrom?: string, timeTo?: string) {
  const from = String(timeFrom || "").trim();
  const to = String(timeTo || "").trim();
  const fromTime = formatTime(from);
  const toTime = formatTime(to);
  const parsedFrom = from ? new Date(from) : null;
  const hasDate = Boolean(parsedFrom && !Number.isNaN(parsedFrom.getTime()));

  if (hasDate && parsedFrom) {
    const dayMonth = parsedFrom.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
    });
    if (fromTime && toTime) return `${dayMonth}, ${fromTime}—${toTime}`;
    if (fromTime) return `${dayMonth}, ${fromTime}`;
    return dayMonth;
  }

  if (fromTime && toTime) return `${fromTime}—${toTime}`;
  return fromTime || toTime || "Дата и время не указаны";
}

function formatTournamentAddressLine(studio?: Exercise["studio"] | null) {
  if (!studio) return "";
  const city = String(studio.city || "").trim();
  const address = String(studio.address || "").trim();
  if (city && address) return `г ${city}, ${address}`;
  if (address) return address;
  if (city) return city;
  return String(studio.name || "").trim();
}

function buildTournamentMapUrl(studio?: Exercise["studio"] | null) {
  if (!studio) return null;
  const lat = typeof studio.lat === "number" ? studio.lat : null;
  const lng = typeof studio.lng === "number" ? studio.lng : null;
  if (lat != null && lng != null) {
    return `https://yandex.ru/maps/?ll=${lng}%2C${lat}&mode=whatshere&whatshere%5Bpoint%5D=${lng}%2C${lat}&whatshere%5Bzoom%5D=16`;
  }
  const query = [studio.city, studio.address, studio.name]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ");
  if (!query) return null;
  return `https://yandex.ru/maps/?text=${encodeURIComponent(query)}`;
}

function getExerciseDateKey(exercise?: Exercise | null) {
  if (!exercise?.timeFrom) return null;
  const parsed = new Date(exercise.timeFrom);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function shiftDateByDays(base: Date, delta: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + delta);
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTournamentSlug(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    return decodeURIComponent(raw).trim().toLowerCase() || null;
  } catch {
    return raw.toLowerCase();
  }
}

function extractTournamentSlugFromUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw, "https://padlhub.ru");
    const querySlug =
      parsed.searchParams.get("slug")
      || parsed.searchParams.get("tournamentSlug");
    if (querySlug) return normalizeTournamentSlug(querySlug);

    const parts = parsed.pathname.split("/").filter(Boolean);
    const publicIndex = parts.findIndex((part, index) => (
      part === "public" && parts[index - 1] === "tournaments" && parts[index - 2] === "api"
    ));
    if (publicIndex >= 0) return normalizeTournamentSlug(parts[publicIndex + 1]);
  } catch {
    const match = raw.match(/\/api\/tournaments\/public\/([^/?#]+)/i);
    if (match?.[1]) return normalizeTournamentSlug(match[1]);
  }

  return null;
}

function pickTournamentString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return null;
}

const TOURNAMENT_SLUG_KEYS = [
  "slug",
  "publicSlug",
  "tournamentSlug",
  "linkSlug",
  "shareSlug",
];

const TOURNAMENT_URL_KEYS = [
  "publicUrl",
  "joinUrl",
  "url",
  "link",
];

const TOURNAMENT_NESTED_RECORD_KEYS = [
  "details",
  "metadata",
  "params",
  "publicTournament",
  "sourceTournamentSnapshot",
  "customTournament",
  "tournament",
  "skin",
  "tournamentSkin",
];

function getTournamentSlugCandidates(value: unknown, seen = new Set<unknown>()): string[] {
  if (!isPlainRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const candidates = [
    normalizeTournamentSlug(pickTournamentString(value, TOURNAMENT_SLUG_KEYS)),
    extractTournamentSlugFromUrl(pickTournamentString(value, TOURNAMENT_URL_KEYS)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  TOURNAMENT_NESTED_RECORD_KEYS.forEach((key) => {
    const nested = value[key];
    if (isPlainRecord(nested)) {
      candidates.push(...getTournamentSlugCandidates(nested, seen));
    }
  });

  return Array.from(new Set(candidates));
}

function findTournamentBySlug(list: Exercise[], slug: string | null) {
  if (!slug) return null;
  return list.find((tournament) => getTournamentSlugCandidates(tournament).includes(slug)) ?? null;
}

function findTournamentByDeepLink(
  list: Exercise[],
  options: {
    tournamentId?: string | null;
    tournamentSlug?: string | null;
  },
) {
  const targetTournamentId = String(options.tournamentId || "").trim();
  if (targetTournamentId) {
    const byId = list.find((tournament) => {
      const candidates = new Set([
        String(tournament.id || "").trim(),
        String((tournament as Exercise & Record<string, unknown>).tournamentId || "").trim(),
        String((tournament as Exercise & Record<string, unknown>).exerciseId || "").trim(),
        String((tournament as Exercise & Record<string, unknown>).sourceTournamentId || "").trim(),
      ]);
      return candidates.has(targetTournamentId);
    });
    if (byId) return byId;
  }

  return findTournamentBySlug(list, options.tournamentSlug ?? null);
}

function readTournamentSlugFromLocation() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return normalizeTournamentSlug(
    params.get("slug") || params.get("tournamentSlug"),
  );
}

function mergeTournamentExercises(primary: Exercise[], bookings: Booking[], dateKey: string) {
  const merged = new Map<string, Exercise>();

  primary.forEach((exercise) => {
    const id = String(exercise?.id || "").trim();
    if (!id) return;
    merged.set(id, exercise);
  });

  bookings.forEach((booking) => {
    const exercise = booking.exercise ?? null;
    const id = String(exercise?.id || "").trim();
    if (!exercise || !id) return;
    if (getExerciseDateKey(exercise) !== dateKey) return;
    if (!merged.has(id)) {
      merged.set(id, exercise);
    }
  });

  return Array.from(merged.values()).sort((left, right) => {
    const leftTs = new Date(left.timeFrom || 0).getTime();
    const rightTs = new Date(right.timeFrom || 0).getTime();
    return leftTs - rightTs;
  });
}

function getTournamentBookingItems(result: Awaited<ReturnType<typeof apiFetchBookings>> | null | undefined) {
  return result?.data?.content ?? [];
}

async function fetchTournamentBookingItems(includePastTournaments: boolean): Promise<Booking[]> {
  if (!includePastTournaments) return [];

  const [activeBookingsResult, historyBookingsResult] = await Promise.all([
    apiFetchBookings(false).catch(() => null),
    apiFetchBookings(true).catch(() => null),
  ]);

  return [
    ...getTournamentBookingItems(activeBookingsResult),
    ...getTournamentBookingItems(historyBookingsResult),
  ];
}

async function fetchTournamentMechanicsSourceItems(dateKey: string) {
  return apiFetchTournamentMechanicsSourceList({ from: dateKey, to: dateKey })
    .then((result) => result?.data ?? [])
    .catch(() => []);
}

function getClientName(booking: ExerciseBooking, index: number) {
  const client = booking.client as ExerciseBooking["client"] | undefined;
  const parts = [client?.firstName, client?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return `Участник ${index + 1}`;
}

function isCancelledTournamentBooking(booking: ExerciseBooking) {
  const raw = booking as ExerciseBooking & {
    cancelled?: boolean;
    canceled?: boolean;
    status?: string | null;
    state?: string | null;
  };
  const status = String(raw.status ?? raw.state ?? "").trim().toLowerCase();

  return (
    raw.isCancelled === true
    || raw.cancelled === true
    || raw.canceled === true
    || status === "cancelled"
    || status === "canceled"
    || status === "cancel"
  );
}

function getTournamentBookingClientId(booking: ExerciseBooking) {
  return String(booking.client?.id || "").trim();
}

function getTournamentBookingDedupeKey(booking: ExerciseBooking) {
  const clientId = getTournamentBookingClientId(booking);
  if (clientId) return `client:${clientId}`;

  const bookingId = String(booking.id || "").trim();
  return bookingId ? `booking:${bookingId}` : "";
}

function stripTournamentParticipantPhone(booking: ExerciseBooking): ExerciseBooking {
  if (!booking.client) return booking;
  return {
    ...booking,
    client: {
      ...booking.client,
      phone: undefined,
    },
  };
}

function normalizeTournamentParticipantBookings(list: ExerciseBooking[]) {
  const byKey = new Map<string, ExerciseBooking>();

  list.forEach((booking, index) => {
    if (!booking || isCancelledTournamentBooking(booking)) return;
    if (!getTournamentBookingClientId(booking)) return;

    const key = getTournamentBookingDedupeKey(booking) || `slot:${index}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, stripTournamentParticipantPhone(booking));
      return;
    }

    const existingRating = parseTournamentRatingValue(existing.rating);
    const nextRating = parseTournamentRatingValue(booking.rating);
    if (existingRating == null && nextRating != null) {
      byKey.set(key, stripTournamentParticipantPhone(booking));
    }
  });

  return Array.from(byKey.values());
}

function extractTournamentParticipantBookings(payload: unknown): ExerciseBooking[] | null {
  if (Array.isArray(payload)) return payload as ExerciseBooking[];
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  for (const key of ["participants", "bookings", "payload", "content", "data"]) {
    if (Array.isArray(record[key])) {
      return record[key] as ExerciseBooking[];
    }
  }
  return null;
}

function getInitialsFromName(name?: string | null) {
  if (!name) return "U";
  const parts = name.split(" ").filter(Boolean);
  const initials = parts.map((part) => part[0] || "").join("").slice(0, 2);
  return initials.toUpperCase() || "U";
}

function formatRating(value: number, fractionDigits = 2) {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function normalizeReadyParticipantIdsInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    );
  }
  if (value && typeof value === "object") {
    return Array.from(
      new Set(
        Object.entries(value as Record<string, unknown>)
          .filter(([, flag]) => flag === true)
          .map(([participantId]) => String(participantId || "").trim())
          .filter(Boolean),
      ),
    );
  }
  return [];
}

function readyParticipantIdsToMap(ids: string[]): Record<string, boolean> {
  return ids.reduce<Record<string, boolean>>((acc, participantId) => {
    acc[participantId] = true;
    return acc;
  }, {});
}

function getTournamentReadyStorageKey(tournamentId: string) {
  return `${TOURNAMENT_READY_STORAGE_PREFIX}:${tournamentId}`;
}

function readTournamentReadyState(tournamentId: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(getTournamentReadyStorageKey(tournamentId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return readyParticipantIdsToMap(normalizeReadyParticipantIdsInput(parsed));
  } catch {
    return {};
  }
}

function writeTournamentReadyState(tournamentId: string, readyState: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  const ids = Object.entries(readyState)
    .filter(([, value]) => value === true)
    .map(([participantId]) => participantId)
    .filter(Boolean)
    .sort();
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(getTournamentReadyStorageKey(tournamentId));
      return;
    }
    window.localStorage.setItem(getTournamentReadyStorageKey(tournamentId), JSON.stringify(ids));
  } catch {
    // ignore storage write errors
  }
}

function splitParticipantFullName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return {
      firstName: "Игрок",
      lastName: "",
    };
  }
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "",
    };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function pickTournamentMinRatingSource(
  tournament: Exercise | null,
  historyRecord?: TournamentHistoryRecord | null,
) {
  if (historyRecord?.minRating) return historyRecord.minRating;

  const tournamentRecord = tournament as (Exercise & {
    settings?: {
      minRating?: string | null;
      ratingFrom?: string | null;
      ratingMin?: string | null;
    };
    minRating?: string | null;
    ratingFrom?: string | null;
    ratingMin?: string | null;
  }) | null;

  return (
    tournamentRecord?.settings?.minRating
    ?? tournamentRecord?.settings?.ratingFrom
    ?? tournamentRecord?.settings?.ratingMin
    ?? tournamentRecord?.minRating
    ?? tournamentRecord?.ratingFrom
    ?? tournamentRecord?.ratingMin
    ?? null
  );
}

function resolveTournamentMinRating(
  tournament: Exercise | null,
  historyRecord?: TournamentHistoryRecord | null,
) {
  const rawMinRating = pickTournamentMinRatingSource(tournament, historyRecord);
  const minRatingValue = parseTournamentRatingValue(rawMinRating) ?? 1;

  return {
    raw: rawMinRating,
    value: minRatingValue,
    display: rawMinRating?.trim() || formatRating(minRatingValue),
  };
}

function pickTournamentMaxRatingSource(
  tournament: Exercise | null,
  historyRecord?: TournamentHistoryRecord | null,
) {
  if (historyRecord?.maxRating) return historyRecord.maxRating;

  const tournamentRecord = tournament as (Exercise & {
    settings?: {
      maxRating?: string | null;
      ratingTo?: string | null;
      ratingMax?: string | null;
    };
    maxRating?: string | null;
    ratingTo?: string | null;
    ratingMax?: string | null;
  }) | null;

  return (
    tournamentRecord?.settings?.maxRating
    ?? tournamentRecord?.settings?.ratingTo
    ?? tournamentRecord?.settings?.ratingMax
    ?? tournamentRecord?.maxRating
    ?? tournamentRecord?.ratingTo
    ?? tournamentRecord?.ratingMax
    ?? null
  );
}

function getRatingGradeLabel(value: number | null) {
  if (value == null) return null;
  return formatTournamentRatingGrade(value);
}

function formatTournamentRatingGrade(value: number | null) {
  if (value == null) return null;
  const grade = getLetterGrade(value);
  if (grade === "D") return "D¹";
  if (grade === "D+") return "D¹+";
  return grade;
}

function resolveTournamentLevelRangeLabel(
  tournament: Exercise | null,
  historyRecord: TournamentHistoryRecord | null | undefined,
  participants: Array<{ rating?: string | number | null }>,
) {
  const explicitMin = parseTournamentRatingValue(pickTournamentMinRatingSource(tournament, historyRecord));
  const explicitMax = parseTournamentRatingValue(pickTournamentMaxRatingSource(tournament, historyRecord));

  const participantLevels = participants
    .map((participant) => parseTournamentRatingValue(participant.rating))
    .filter((value): value is number => value != null);
  const fallbackMin = participantLevels.length > 0 ? Math.min(...participantLevels) : null;
  const fallbackMax = participantLevels.length > 0 ? Math.max(...participantLevels) : null;

  const minLevel = explicitMin ?? fallbackMin;
  const maxLevel = explicitMax ?? fallbackMax;
  const minLabel = getRatingGradeLabel(minLevel);
  const maxLabel = getRatingGradeLabel(maxLevel);

  if (minLabel && maxLabel) {
    if (minLabel === maxLabel) return minLabel;
    return `от ${minLabel} до ${maxLabel}`;
  }
  if (minLabel) return `от ${minLabel}`;
  if (maxLabel) return `до ${maxLabel}`;
  return "уровень не указан";
}

function parseBoundedIntegerInput(value: string, min: number, max: number) {
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function formatTournamentNumber(value: number, maximumFractionDigits = 2) {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function formatSignedTournamentNumber(value: number, maximumFractionDigits = 2) {
  const formatted = formatTournamentNumber(Math.abs(value), maximumFractionDigits);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return "0";
}

function formatPendingTournamentSyncNotice(count: number) {
  if (count <= 0) return null;
  const word =
    count % 10 === 1 && count % 100 !== 11
      ? "результат"
      : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)
        ? "результата"
        : "результатов";
  return `${count} ${word} ожидает синхронизации`;
}

function formatStatsRatingBadge(value: number) {
  return getLetterGrade(value);
}

function getTournamentRatingBadgeStyle(value: number | null): CSSProperties | undefined {
  if (value == null) return undefined;
  const grade = getLetterGrade(value);
  const backgroundColor = TOURNAMENT_LEVEL_BADGE_COLORS[grade] ?? "#000000";

  return {
    backgroundColor,
    color: "#FFFFFF",
    borderColor: "rgba(255, 255, 255, 0.28)",
  };
}

function getTournamentRatingRingProgress(value: number | null) {
  if (value == null) return 0;
  return Math.max(0, Math.min(1, value / 7));
}

function getQualityTone(score: number) {
  if (score >= 90) return "high";
  if (score >= 75) return "good";
  if (score >= 60) return "normal";
  return "risk";
}

function applyPartialRoundUpdates(
  currentRounds: TournamentRound[],
  incomingRounds: TournamentRound[],
) {
  const incomingRoundIds = new Set(incomingRounds.map((round) => round.id));
  const hasFullSchedule =
    incomingRounds.length >= currentRounds.length
    && currentRounds.every((round) => {
      if (!incomingRoundIds.has(round.id)) return false;
      const incomingRound = incomingRounds.find((candidate) => candidate.id === round.id);
      if (!incomingRound) return false;
      // Guard against partial server replies that contain only saved matches for a round.
      // In that case we must keep the local schedule shape to avoid dropping unsaved matches.
      return incomingRound.matches.length >= round.matches.length;
    });

  if (hasFullSchedule) {
    return incomingRounds;
  }

  const incomingRoundMap = new Map(incomingRounds.map((round) => [round.id, round]));
  const incomingMatchMap = new Map<string, TournamentRound["matches"][number]>();

  incomingRounds.forEach((round) => {
    round.matches.forEach((match) => {
      incomingMatchMap.set(`${round.id}::${match.id}`, match);
    });
  });

  const mergedRounds = currentRounds.map((round) => {
    const incomingRound = incomingRoundMap.get(round.id);
    const currentMatchIds = new Set(round.matches.map((match) => match.id));
    const nextMatches = round.matches.map((match) => {
      const incomingMatch =
        incomingMatchMap.get(`${round.id}::${match.id}`)
        ?? incomingRound?.matches.find((candidate) => candidate.id === match.id);
      if (!incomingMatch) return match;
      return {
        ...match,
        score1: incomingMatch.score1,
        score2: incomingMatch.score2,
        saved: incomingMatch.score1 != null && incomingMatch.score2 != null,
      };
    });
    const extraIncomingMatches = incomingRound
      ? incomingRound.matches
          .filter((match) => !currentMatchIds.has(match.id))
          .map((match) => ({
            ...match,
            saved: match.score1 != null && match.score2 != null,
          }))
      : [];
    const mergedMatches = [...nextMatches, ...extraIncomingMatches];

    return {
      ...round,
      byes: incomingRound?.byes ?? round.byes,
      quality: incomingRound?.quality ?? round.quality,
      matches: mergedMatches,
      saved: mergedMatches.length > 0 && mergedMatches.every((match) => match.saved),
    };
  });

  const currentRoundIds = new Set(currentRounds.map((round) => round.id));
  const extraIncomingRounds = incomingRounds.filter((round) => !currentRoundIds.has(round.id));

  return [...mergedRounds, ...extraIncomingRounds].sort((left, right) => left.index - right.index);
}

function applyLocalTournamentResultUpdates(
  currentRounds: TournamentRound[],
  results: AmericanoResultsPayload["results"],
) {
  const updateMap = new Map<string, { score1: number; score2: number }>();

  results.forEach((result) => {
    if (!result?.roundId || !result.matchId) return;
    if (result.score1 == null || result.score2 == null) return;
    updateMap.set(getTournamentMatchKey(result.roundId, result.matchId), {
      score1: result.score1,
      score2: result.score2,
    });
  });

  return currentRounds.map((round) => {
    const nextMatches = round.matches.map((match) => {
      const nextScores = updateMap.get(getTournamentMatchKey(round.id, match.id));
      if (!nextScores) return match;
      return {
        ...match,
        score1: nextScores.score1,
        score2: nextScores.score2,
        saved: true,
      };
    });

    return {
      ...round,
      saved: nextMatches.length > 0 && nextMatches.every((match) => match.saved),
      matches: nextMatches,
    };
  });
}

type TournamentQueuedMatchState = {
  jobId: string;
  score1: number | null;
  score2: number | null;
};

function buildTournamentQueuedMatchState(
  queueRecords: TournamentOfflineResultQueueRecord[],
) {
  const matchStateByKey = new Map<string, TournamentQueuedMatchState>();
  const roundJobById = new Map<string, string>();

  queueRecords.forEach((record) => {
    const results = Array.isArray(record.payload?.results) ? record.payload.results : [];
    results.forEach((result) => {
      const roundId = String(result?.roundId || "").trim();
      const matchId = String(result?.matchId || "").trim();
      if (!roundId || !matchId) return;
      const key = getTournamentMatchKey(roundId, matchId);
      matchStateByKey.set(key, {
        jobId: record.jobId,
        score1: result.score1 ?? null,
        score2: result.score2 ?? null,
      });
      roundJobById.set(roundId, record.jobId);
    });
  });

  return {
    matchStateByKey,
    roundJobById,
  };
}

function findTournamentMatch(
  rounds: TournamentRound[],
  roundId: string,
  matchId: string,
) {
  return rounds
    .find((round) => round.id === roundId)
    ?.matches.find((match) => match.id === matchId) ?? null;
}

type TournamentMatchLocation = {
  roundId: string;
  matchId: string;
};

function getTournamentMatchKey(roundId: string, matchId: string) {
  return `${roundId}::${matchId}`;
}

function isTournamentMatchSaved(match: TournamentRound["matches"][number]) {
  return match.score1 != null && match.score2 != null;
}

function findNextIncompleteTournamentMatch(
  rounds: TournamentRound[],
  currentRoundId: string,
  currentMatchId: string,
) {
  const orderedMatches = rounds.flatMap((round) =>
    round.matches.map((match) => ({
      roundId: round.id,
      matchId: match.id,
      saved: isTournamentMatchSaved(match),
    })),
  );

  if (orderedMatches.length === 0) return null;

  const currentMatchIndex = orderedMatches.findIndex((match) => (
    match.roundId === currentRoundId && match.matchId === currentMatchId
  ));

  const findIncompleteFromIndex = (startIndex: number) => {
    for (let index = Math.max(startIndex, 0); index < orderedMatches.length; index += 1) {
      const candidate = orderedMatches[index];
      if (!candidate.saved) {
        return {
          roundId: candidate.roundId,
          matchId: candidate.matchId,
        };
      }
    }
    return null;
  };

  return (
    (currentMatchIndex >= 0 ? findIncompleteFromIndex(currentMatchIndex + 1) : null)
    ?? findIncompleteFromIndex(0)
  );
}

function navigateTournamentAfterMatchSave(
  rounds: TournamentRound[],
  currentRoundId: string,
  currentMatchId: string,
) {
  const nextMatch = findNextIncompleteTournamentMatch(rounds, currentRoundId, currentMatchId);
  if (!nextMatch) {
    return {
      rounds,
      nextMatch: null,
    };
  }

  return {
    nextMatch,
    rounds: rounds.map((round) => {
      if (round.id === nextMatch.roundId) return { ...round, collapsed: false };
      if (round.id === currentRoundId && currentRoundId !== nextMatch.roundId && round.saved) {
        return { ...round, collapsed: true };
      }
      return round;
    }),
  };
}

function toNumberSafe(value: unknown, fallback = 0) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toTimestamp(value?: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickLatestTournamentHistory(records: TournamentHistoryRecord[] | null | undefined) {
  if (!Array.isArray(records) || records.length === 0) return null;
  return [...records].sort((left, right) => {
    const timeGap =
      toTimestamp(right.updatedAt ?? right.createdAt) - toTimestamp(left.updatedAt ?? left.createdAt);
    if (timeGap !== 0) return timeGap;
    return String(right.id).localeCompare(String(left.id), "ru");
  })[0] ?? null;
}

function normalizeTournamentTypeKey(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized.includes("americano_flex")
    || normalized.includes("flex_americano")
    || normalized.includes("flex americano")
    || normalized.includes("americano flex")
    || normalized.includes("флекс американо")
    || normalized.includes("американо флекс")
  ) return "americano_flex";
  if (
    normalized.includes("americano_classic")
    || normalized.includes("classic_americano")
    || normalized.includes("классическое американо")
  ) return "americano_classic";
  if (
    normalized.includes("americano_padelhub")
    || normalized.includes("padelhub")
    || normalized.includes("падлхаб")
  ) return "americano_padelhub";
  if (
    normalized.includes("paired_americano")
    || normalized.includes("americano_pairs")
    || normalized.includes("парный американо")
    || normalized.includes("парное американо")
  ) return "paired_americano";
  if (
    normalized.includes("paired_mexicano")
    || normalized.includes("mexicano_pairs")
    || normalized.includes("парный мексикано")
    || normalized.includes("парное мексикано")
  ) return "paired_mexicano";
  if (normalized.includes("americano") || normalized.includes("американо")) return "americano_padelhub";
  if (normalized.includes("mexicano") || normalized.includes("мексикано")) return "mexicano";
  return normalized;
}

function getTournamentFamilyByType(value: string | null | undefined): TournamentFamilyKey | null {
  const typeKey = normalizeTournamentTypeKey(value);
  if (!typeKey) return null;
  if (
    typeKey === "americano"
    || typeKey === "americano_padelhub"
    || typeKey === "americano_classic"
    || typeKey === "americano_flex"
    || typeKey === "paired_americano"
  ) {
    return "americano";
  }
  if (typeKey === "mexicano" || typeKey === "paired_mexicano") return "mexicano";
  return null;
}

function getTournamentTypeLabel(value: string | null | undefined) {
  const typeKey = normalizeTournamentTypeKey(value);
  if (typeKey === "americano" || typeKey === "americano_padelhub") return "Американо · ПадлхАБ";
  if (typeKey === "americano_classic") return "Американо · Классическое";
  if (typeKey === "americano_flex") return "Американо · Флекс";
  if (typeKey === "paired_americano") return "Американо · Парное";
  if (typeKey === "paired_mexicano") return "Парный мексикано";
  if (typeKey === "mexicano") return "Мексикано · Классическое";
  return String(value || "").trim() || "Турнир";
}

function resolveAmericanoScheduleMode(value: string | null | undefined) {
  const typeKey = normalizeTournamentTypeKey(value);
  if (typeKey === "paired_americano") return "paired" as const;
  if (typeKey === "americano_classic") return "classic" as const;
  if (typeKey === "americano_flex") return "flex" as const;
  return "padelhub" as const;
}

const MEXICANO_RECOMMENDED_ROUNDS = 8;
const MEXICANO_MIN_ROUNDS_BEFORE_FINISH = 5;
const DEFAULT_AMERICANO_STANDINGS_SORT_MODE: TournamentStandingsSortMode = "point_diff";
const DEFAULT_MEXICANO_FIRST_ROUND_MODE: NonNullable<MexicanoClassicOptions["firstRoundMode"]> = "by_level";
const DEFAULT_MEXICANO_TABLE_SORT_MODE: NonNullable<MexicanoClassicOptions["tableSortMode"]> = "total_points";
const DEFAULT_MEXICANO_WINNER_SORT_MODE: NonNullable<MexicanoClassicOptions["winnerSortMode"]> = "point_diff";

function toLowerText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isTruthyValue(value: unknown) {
  const normalized = toLowerText(value);
  return value === true || value === 1 || value === "1" || normalized === "true";
}

function pickFirstDefined(params: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (params[key] != null) return params[key];
  }
  return null;
}

function resolveMexicanoFirstRoundMode(params: Record<string, unknown>): MexicanoClassicOptions["firstRoundMode"] {
  const rawMode = pickFirstDefined(params, [
    "firstRoundMode",
    "firstRoundSortMode",
    "firstRoundOrderMode",
    "round1SortMode",
    "initialRoundMode",
  ]);
  const normalized = toLowerText(rawMode).replace(/\s+/g, "_");

  if (
    normalized === "equal_pairs"
    || normalized === "balanced_pairs"
    || normalized === "равные_пары"
    || normalized.includes("equal_pair")
    || normalized.includes("balanced_pair")
    || normalized.includes("равн")
  ) {
    return "equal_pairs";
  }
  if (
    normalized === "by_level"
    || normalized === "level"
    || normalized === "по_уровню"
    || normalized.includes("уров")
  ) {
    return "by_level";
  }
  if (
    normalized === "random"
    || normalized === "shuffle"
    || normalized === "случайно"
    || normalized.includes("рандом")
    || normalized.includes("случ")
  ) {
    return "random";
  }
  return DEFAULT_MEXICANO_FIRST_ROUND_MODE;
}

function resolveMexicanoStandingsSortMode(
  params: Record<string, unknown>,
  options: {
    modeKeys: string[];
    totalPointsFlagKeys?: string[];
    pointDiffFlagKeys?: string[];
    fallback: "point_diff" | "total_points";
  },
) {
  if ((options.totalPointsFlagKeys ?? []).some((key) => isTruthyValue(params[key]))) {
    return "total_points" as const;
  }
  if ((options.pointDiffFlagKeys ?? []).some((key) => isTruthyValue(params[key]))) {
    return "point_diff" as const;
  }

  for (const key of options.modeKeys) {
    const mode = resolveTournamentStandingsSortModeValue(params[key]);
    if (mode) return mode;
  }

  return options.fallback;
}

function parseMexicanoOptions(value: unknown): MexicanoClassicOptions {
  const params = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const firstRoundMode = resolveMexicanoFirstRoundMode(params);
  const byeModeRaw = String(params.byeMode ?? "").trim().toLowerCase();
  const byeMode = byeModeRaw === "strict" ? "strict" : "rotating_bye";
  const seedRaw = params.seed;
  const seed = typeof seedRaw === "string" || typeof seedRaw === "number"
    ? seedRaw
    : "mexicano";
  const totalRoundsRaw = typeof params.totalRounds === "number"
    ? params.totalRounds
    : Number(params.totalRounds);
  const totalRounds = Number.isFinite(totalRoundsRaw)
    ? Math.max(MEXICANO_MIN_ROUNDS_BEFORE_FINISH, Math.floor(totalRoundsRaw))
    : MEXICANO_RECOMMENDED_ROUNDS;
  const tableSortMode = resolveMexicanoStandingsSortMode(params, {
    modeKeys: [
      "tableSortMode",
      "tableSortBy",
      "roundTableSortMode",
      "roundRankingMode",
      "roundRankBy",
      "roundStandingsSort",
      "standingsSortMode",
      "rankingMode",
      "rankBy",
      "standingsSort",
    ],
    totalPointsFlagKeys: [
      "roundSortByTotalPoints",
      "roundUseTotalPointsRanking",
    ],
    pointDiffFlagKeys: [
      "roundSortByPointDiff",
      "roundUsePointDiffRanking",
    ],
    fallback: DEFAULT_MEXICANO_TABLE_SORT_MODE,
  });
  const winnerSortMode = resolveMexicanoStandingsSortMode(params, {
    modeKeys: [
      "winnerSortMode",
      "winnerSortBy",
      "winnerBy",
      "winnerCriteria",
      "winnerMode",
      "championBy",
      "winnerRankingMode",
      "finalRankBy",
      "finalStandingsSort",
      "resultsSortMode",
      "standingsSortMode",
      "rankingMode",
      "rankBy",
      "standingsSort",
    ],
    totalPointsFlagKeys: [
      "winnerByTotalPoints",
      "sortByTotalPoints",
      "useTotalPointsRanking",
    ],
    pointDiffFlagKeys: [
      "winnerByPointDiff",
      "sortByPointDiff",
      "usePointDiffRanking",
    ],
    fallback: DEFAULT_MEXICANO_WINNER_SORT_MODE,
  });

  return {
    firstRoundMode,
    byeMode,
    tableSortMode,
    winnerSortMode,
    seed,
    totalRounds,
  };
}

function getTournamentProgressLabel(history: TournamentHistoryRecord | null | undefined): string | null {
  if (!history) return null;
  const params = history.params && typeof history.params === "object"
    ? history.params as Record<string, unknown>
    : null;
  const syncStatus = String(params?.syncStatus ?? "").trim().toLowerCase();
  const localStatus = String(params?.localStatus ?? "").trim().toLowerCase();

  if (params?.manualTournament === true && syncStatus === "synced_viva") {
    return "Проведен и синхронизирован";
  }
  if (params?.manualTournament === true && (
    localStatus === "conducted_local"
    || isTournamentMarkedFinished(history.params, history.summary)
  )) {
    return "Проведен локально";
  }

  const progressState = getTournamentProgressState(history);
  if (progressState === "completed") return "Проведен и сохранен";
  if (progressState === "in_progress") return "Не завершен";
  return null;
}

function formatCourtsCountLabel(count: number) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  if (lastDigit === 1 && lastTwoDigits !== 11) return `${count} корт`;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} корта`;
  }
  return `${count} кортов`;
}

function buildTournamentPayloadFromHistory(history: TournamentHistoryRecord): AmericanoTournamentPayload | null {
  const typeKey = normalizeTournamentTypeKey(history.tournamentType);
  if (
    typeKey !== "americano_padelhub"
    && typeKey !== "americano_classic"
    && typeKey !== "americano_flex"
    && typeKey !== "paired_americano"
    && typeKey !== "paired_mexicano"
    && typeKey !== "mexicano"
  ) return null;

  return {
    tournamentId: history.tournamentId,
    tenantKey: TENANT_KEY,
    createdAt: history.createdAt ?? history.updatedAt ?? new Date().toISOString(),
    organizer: {
      id: history.organizer?.id ?? null,
      phone: history.organizer?.phone ?? null,
      tenantKey: TENANT_KEY,
    },
    tournamentType: typeKey,
    targetScore: history.targetScore ?? 21,
    courts: history.courts.length > 0 ? history.courts : ["Корт №1"],
    params: history.params ?? undefined,
    participants: history.participants.map((participant, index) => ({
      id: participant.id ?? `participant-${index}`,
      phone: participant.phone ?? null,
      rating: participant.rating ?? null,
      photo: participant.photo ?? null,
      name: participant.name || `Участник ${index + 1}`,
      spot: participant.spot ?? null,
      isCancelled: participant.isCancelled ?? false,
    })),
    rounds: history.rounds as AmericanoTournamentPayload["rounds"],
  };
}

function buildTournamentComparablePayloadFromHistory(
  history: TournamentHistoryRecord | null | undefined,
): AmericanoTournamentPayload | null {
  return history ? buildTournamentPayloadFromHistory(history) : null;
}

function withTournamentStationContext(
  payload: AmericanoTournamentPayload,
  tournament: Exercise | null | undefined,
): AmericanoTournamentPayload {
  const stationId = String(tournament?.studio?.id || "").trim();
  if (!stationId) return payload;
  const directionId = Number(tournament?.direction?.id);

  return {
    ...payload,
    params: {
      ...(payload.params ?? {}),
      stationId,
      stationName: String(tournament?.studio?.name || "").trim() || null,
      ...(Number.isFinite(directionId) ? { directionId } : {}),
      directionName: String(tournament?.direction?.name || "").trim() || null,
      maxParticipants: Number.isFinite(Number(tournament?.maxClientsCount))
        ? Number(tournament?.maxClientsCount)
        : null,
    },
  };
}

function buildTournamentHistoryRecordFromPayload(
  payload: AmericanoTournamentPayload,
  tournament: Exercise | null,
  previousHistory?: TournamentHistoryRecord | null,
  totals?: AmericanoResultsResponse["totals"] | null,
  playerLogs?: AmericanoResultsResponse["playerLogs"] | null,
): TournamentHistoryRecord {
  const girlsOnly = previousHistory?.girlsOnly ?? tournament?.girlsOnly ?? null;
  const payloadParams = payload.params && typeof payload.params === "object"
    ? payload.params as Record<string, unknown>
    : null;
  const organizerName = String(payloadParams?.organizerName ?? "").trim();

  return {
    id: payload.tournamentId,
    tournamentId: payload.tournamentId,
    title:
      previousHistory?.title
      ?? tournament?.direction?.name
      ?? tournament?.type?.name
      ?? getTournamentTypeLabel(payload.tournamentType),
    tournamentType: payload.tournamentType,
    targetScore: payload.targetScore,
    courts: [...payload.courts],
    participants: payload.participants.map((participant, index) => ({
      id: participant.id ?? `participant-${index}`,
      phone: participant.phone ?? null,
      photo: participant.photo ?? null,
      rating: participant.rating ?? null,
      name: participant.name || `Участник ${index + 1}`,
      spot: participant.spot ?? null,
      isCancelled: participant.isCancelled ?? false,
    })),
    participantsCount: payload.participants.length,
    maxParticipants: previousHistory?.maxParticipants ?? tournament?.maxClientsCount ?? null,
    minRating: previousHistory?.minRating ?? null,
    maxRating: previousHistory?.maxRating ?? null,
    genderLabel: previousHistory?.genderLabel ?? (girlsOnly ? "Женщины" : null),
    girlsOnly,
    mixed: previousHistory?.mixed ?? null,
    organizer: previousHistory?.organizer
      ? {
        ...previousHistory.organizer,
        phone: previousHistory.organizer.phone ?? payload.organizer.phone ?? null,
      }
      : ((payload.organizer.id || payload.organizer.phone || organizerName)
        ? {
          id: payload.organizer.id ?? null,
          phone: payload.organizer.phone ?? null,
          photo: null,
          rating: null,
          name: organizerName || "Организатор",
        }
        : null),
    params: payload.params ?? previousHistory?.params ?? null,
    rounds: payload.rounds ?? [],
    standings: previousHistory?.standings ?? [],
    summary: previousHistory?.summary ?? null,
    totals: totals ?? previousHistory?.totals ?? null,
    playerLogs: playerLogs ?? previousHistory?.playerLogs ?? null,
    startRatingChanges: payload.startRatingChanges ?? previousHistory?.startRatingChanges ?? [],
    publishedCommunities: previousHistory?.publishedCommunities ?? [],
    ratingCommunityId: previousHistory?.ratingCommunityId ?? null,
    ratingCommunityStatus: previousHistory?.ratingCommunityStatus ?? "NOT_PUBLISHED",
    createdAt: previousHistory?.createdAt ?? payload.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

interface TournamentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  tournament: Exercise | null;
  historyRecord?: TournamentHistoryRecord | null;
  sourceDateKey?: string | null;
  canRefreshParticipantsFromViva: boolean;
  onSaved: (data: AmericanoTournamentPayload) => void;
}

type TournamentParticipantEntry = ParticipantEntry & {
  bookingId: string | null;
  clientId: string | null;
  isOrganizerSlot?: boolean;
};

type TournamentRosterMode = "bookings" | "manual";

type TournamentParticipantRefreshUiState = {
  status: "idle" | "pending" | "success" | "cooldown" | "error";
  message: string | null;
  retryBlocked?: boolean;
};

const TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE: TournamentParticipantRefreshUiState = {
  status: "idle",
  message: null,
};

const TOURNAMENT_PARTICIPANTS_LOAD_ERROR = "Не удалось загрузить участников";

type TournamentManualParticipantDraft = {
  id: string;
  name: string;
  phone: string;
  rating: string;
};

type TournamentMissingRatingConfirmation = {
  missingCount: number;
  minRatingDisplay: string;
};

type TournamentSavedRatingChange = {
  previousRating: number | null;
  nextRating: number;
};

function createTournamentManualParticipantId(index: number) {
  const randomSuffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `manual-participant-${index + 1}-${Date.now()}-${randomSuffix}`;
}

function createTournamentDraftId() {
  const randomSuffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `manual-tournament-${Date.now()}-${randomSuffix}`;
}

function createTournamentManualParticipantDraft(
  index: number,
  participant?: {
    id?: string | null;
    name?: string | null;
    phone?: string | null;
    rating?: string | null;
  },
): TournamentManualParticipantDraft {
  return {
    id: String(participant?.id || "").trim() || createTournamentManualParticipantId(index),
    name: String(participant?.name || "").trim(),
    phone: String(participant?.phone || "").trim(),
    rating: String(participant?.rating || "").trim(),
  };
}

function compareTournamentParticipantsByRating(
  left: { rating?: string | null; name?: string | null },
  right: { rating?: string | null; name?: string | null },
) {
  const leftRating = parseTournamentRatingValue(left.rating);
  const rightRating = parseTournamentRatingValue(right.rating);
  if (leftRating == null && rightRating == null) return 0;
  if (leftRating == null) return 1;
  if (rightRating == null) return -1;
  if (leftRating === rightRating) {
    return String(left.name || "").localeCompare(String(right.name || ""));
  }
  return rightRating - leftRating;
}

function TournamentDetailsModal({
  isOpen,
  onClose,
  tournament,
  historyRecord = null,
  sourceDateKey = null,
  canRefreshParticipantsFromViva,
  onSaved,
}: TournamentDetailsModalProps) {
  const [loading, setLoading] = useState(false);
  const [participants, setParticipants] = useState<ExerciseBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedFamily, setSelectedFamily] = useState<TournamentFamilyKey | null>(null);
  const [selectedType, setSelectedType] = useState<TournamentTypeKey | null>(null);
  const [americanoStandingsSortMode, setAmericanoStandingsSortMode] =
    useState<TournamentStandingsSortMode>(DEFAULT_AMERICANO_STANDINGS_SORT_MODE);
  const [mexicanoFirstRoundMode, setMexicanoFirstRoundMode] =
    useState<NonNullable<MexicanoClassicOptions["firstRoundMode"]>>(DEFAULT_MEXICANO_FIRST_ROUND_MODE);
  const [mexicanoTableSortMode, setMexicanoTableSortMode] =
    useState<NonNullable<MexicanoClassicOptions["tableSortMode"]>>(DEFAULT_MEXICANO_TABLE_SORT_MODE);
  const [mexicanoWinnerSortMode, setMexicanoWinnerSortMode] =
    useState<NonNullable<MexicanoClassicOptions["winnerSortMode"]>>(DEFAULT_MEXICANO_WINNER_SORT_MODE);
  const [courtsCountDraft, setCourtsCountDraft] = useState("");
  const [courtNames, setCourtNames] = useState<string[]>([]);
  const [targetScore, setTargetScore] = useState(21);
  const [targetScoreDraft, setTargetScoreDraft] = useState("21");
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [saveWasLocal, setSaveWasLocal] = useState(false);
  const [rosterMode, setRosterMode] = useState<TournamentRosterMode>("bookings");
  const [participantRefreshState, setParticipantRefreshState] =
    useState<TournamentParticipantRefreshUiState>(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
  const [participantLoadNotice, setParticipantLoadNotice] = useState<string | null>(null);
  const [manualParticipants, setManualParticipants] = useState<TournamentManualParticipantDraft[]>([]);
  const [manualStationName, setManualStationName] = useState("");
  const [manualOrganizerName, setManualOrganizerName] = useState("");
  const [manualRatings, setManualRatings] = useState<Record<string, string>>({});
  const [savedStartRatingChanges, setSavedStartRatingChanges] =
    useState<Record<string, TournamentSavedRatingChange>>({});
  const [ratingSaveStateById, setRatingSaveStateById] = useState<Record<string, "idle" | "saving">>({});
  const [ratingSaveErrors, setRatingSaveErrors] = useState<Record<string, string>>({});
  const [ratingEditModeById, setRatingEditModeById] = useState<Record<string, boolean>>({});
  const [refreshingRatings, setRefreshingRatings] = useState(false);
  const [refreshRatingsError, setRefreshRatingsError] = useState<string | null>(null);
  const [missingRatingConfirmation, setMissingRatingConfirmation] =
    useState<TournamentMissingRatingConfirmation | null>(null);
  const [organizerSlotRating, setOrganizerSlotRating] = useState<string | null>(null);
  const [participantLeaveTarget, setParticipantLeaveTarget] = useState<TournamentParticipantEntry | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [autoRefreshedParticipantsKey, setAutoRefreshedParticipantsKey] = useState("");
  const [pairedMexicanoPairs, setPairedMexicanoPairs] = useState<string[][]>([]);
  const [readyParticipantIds, setReadyParticipantIds] = useState<Record<string, boolean>>({});
  const [readyStateHydrated, setReadyStateHydrated] = useState(false);
  const [replacementWaitlist, setReplacementWaitlist] = useState<TournamentParticipantEntry[]>([]);
  const [replaceParticipantId, setReplaceParticipantId] = useState<string | null>(null);
  const [replaceSearchQuery, setReplaceSearchQuery] = useState("");
  const [replaceSearchResults, setReplaceSearchResults] = useState<PadelPlayerCandidate[]>([]);
  const [replaceSearchLoading, setReplaceSearchLoading] = useState(false);
  const [replaceSearchError, setReplaceSearchError] = useState<string | null>(null);
  const [replaceSubmitLoading, setReplaceSubmitLoading] = useState(false);
  const [openTournamentTypeHintId, setOpenTournamentTypeHintId] = useState<TournamentTypeKey | null>(null);
  const isCreationFlow = isOpen && !tournament;
  const draftTournamentId = useMemo(
    () => (isCreationFlow ? createTournamentDraftId() : null),
    [isCreationFlow],
  );
  const ratingLastTapTsRef = useRef<Record<string, number>>({});
  const participantActionControllerRef = useRef<AbortController | null>(null);
  const participantRefreshCooldownTimerRef = useRef<number | null>(null);
  const participantAutoPauseRef = useRef<(() => void) | null>(null);
  const participantAutoRunRef = useRef<(() => void) | null>(null);
  const participantAutoScheduleRef = useRef<(delayMs: number) => void>(() => undefined);
  const participantAutoRescheduleRef = useRef<(
    fingerprint: string | null,
    outcomeOverride?: TournamentParticipantRefreshOutcome,
  ) => void>(() => undefined);

  useEffect(() => {
    if (!selectedFamily && !selectedType && !isCreationFlow) {
      setCourtsCountDraft("");
      setCourtNames([]);
      setTargetScore(21);
      setTargetScoreDraft("21");
      setSaveState("idle");
      setSaveWasLocal(false);
      setRosterMode("bookings");
      setManualParticipants([]);
      setManualStationName("");
      setManualOrganizerName("");
      setManualRatings({});
      setSavedStartRatingChanges({});
      setRatingSaveStateById({});
      setRatingSaveErrors({});
      setRatingEditModeById({});
      setRefreshingRatings(false);
      setRefreshRatingsError(null);
      setMissingRatingConfirmation(null);
      setOrganizerSlotRating(null);
      setParticipantLeaveTarget(null);
      setLeaveError(null);
      setAutoRefreshedParticipantsKey("");
      setPairedMexicanoPairs([]);
      setReadyParticipantIds({});
      setReadyStateHydrated(false);
      setReplacementWaitlist([]);
      setReplaceParticipantId(null);
      setReplaceSearchQuery("");
      setReplaceSearchResults([]);
      setReplaceSearchLoading(false);
      setReplaceSearchError(null);
      setReplaceSubmitLoading(false);
      setOpenTournamentTypeHintId(null);
      setAmericanoStandingsSortMode(DEFAULT_AMERICANO_STANDINGS_SORT_MODE);
      setMexicanoFirstRoundMode(DEFAULT_MEXICANO_FIRST_ROUND_MODE);
      setMexicanoTableSortMode(DEFAULT_MEXICANO_TABLE_SORT_MODE);
      setMexicanoWinnerSortMode(DEFAULT_MEXICANO_WINNER_SORT_MODE);
      ratingLastTapTsRef.current = {};
    }
  }, [isCreationFlow, selectedFamily, selectedType]);

  useEffect(() => {
    if (!isOpen) return;
    if (!tournament) {
      setLoading(false);
      setError(null);
      setSelectedFamily(null);
      setSelectedType(null);
      setCourtsCountDraft("");
      setCourtNames([]);
      setTargetScore(21);
      setTargetScoreDraft("21");
      setSaveState("idle");
      setSaveWasLocal(false);
      setRosterMode("manual");
      setManualParticipants([createTournamentManualParticipantDraft(0)]);
      setManualStationName("");
      setManualOrganizerName("");
      setManualRatings({});
      setSavedStartRatingChanges({});
      setRatingSaveStateById({});
      setRatingSaveErrors({});
      setRatingEditModeById({});
      setRefreshingRatings(false);
      setRefreshRatingsError(null);
      setMissingRatingConfirmation(null);
      setOrganizerSlotRating(null);
      setParticipantLeaveTarget(null);
      setLeaveError(null);
      setAutoRefreshedParticipantsKey("");
      setReadyParticipantIds({});
      setReadyStateHydrated(true);
      setReplacementWaitlist([]);
      setReplaceParticipantId(null);
      setReplaceSearchQuery("");
      setReplaceSearchResults([]);
      setReplaceSearchLoading(false);
      setReplaceSearchError(null);
      setReplaceSubmitLoading(false);
      setOpenTournamentTypeHintId(null);
      setAmericanoStandingsSortMode(DEFAULT_AMERICANO_STANDINGS_SORT_MODE);
      setMexicanoFirstRoundMode(DEFAULT_MEXICANO_FIRST_ROUND_MODE);
      setMexicanoTableSortMode(DEFAULT_MEXICANO_TABLE_SORT_MODE);
      setMexicanoWinnerSortMode(DEFAULT_MEXICANO_WINNER_SORT_MODE);
      ratingLastTapTsRef.current = {};
      setPairedMexicanoPairs([]);
      return;
    }
    const restoredMexicanoOptions = parseMexicanoOptions(historyRecord?.params);
    const restoredAmericanoStandingsSortMode = parseAmericanoStandingsSortMode(
      historyRecord?.params && typeof historyRecord.params === "object"
        ? historyRecord.params as Record<string, unknown>
        : null,
      DEFAULT_AMERICANO_STANDINGS_SORT_MODE,
    );
    const restoredType = normalizeTournamentTypeKey(historyRecord?.tournamentType);
    const restoredFamily = getTournamentFamilyByType(restoredType);
    const restoredCourts = Array.isArray(historyRecord?.courts) ? historyRecord.courts : [];
    const restoredTargetScore = historyRecord?.targetScore ?? 21;
    setSelectedFamily(restoredFamily);
    setSelectedType(restoredType as TournamentTypeKey | null);
    setCourtsCountDraft(restoredCourts.length > 0 ? String(restoredCourts.length) : "");
    setCourtNames(restoredCourts);
    setTargetScore(restoredTargetScore);
    setTargetScoreDraft(String(restoredTargetScore));
    setSaveState("idle");
    setSaveWasLocal(false);
    setRosterMode("bookings");
    setManualParticipants([]);
    setManualStationName("");
    setManualOrganizerName("");
    setManualRatings({});
    setSavedStartRatingChanges({});
    setRatingSaveStateById({});
    setRatingSaveErrors({});
    setRatingEditModeById({});
    setRefreshingRatings(false);
    setRefreshRatingsError(null);
    setMissingRatingConfirmation(null);
    setOrganizerSlotRating(null);
    setParticipantLeaveTarget(null);
    setLeaveError(null);
    setAutoRefreshedParticipantsKey("");
    const tournamentReadyFromHistory = normalizeReadyParticipantIdsInput(
      historyRecord?.params?.readyParticipantIds ?? historyRecord?.params?.participantReadyIds,
    );
    const tournamentIdValue = tournament?.id ? String(tournament.id) : "";
    const tournamentReadyFromStorage = tournamentIdValue
      ? readTournamentReadyState(tournamentIdValue)
      : {};
    setReadyParticipantIds({
      ...readyParticipantIdsToMap(tournamentReadyFromHistory),
      ...tournamentReadyFromStorage,
    });
    setReadyStateHydrated(true);
    setReplacementWaitlist([]);
    setReplaceParticipantId(null);
    setReplaceSearchQuery("");
    setReplaceSearchResults([]);
    setReplaceSearchLoading(false);
    setReplaceSearchError(null);
    setReplaceSubmitLoading(false);
    setOpenTournamentTypeHintId(null);
    setAmericanoStandingsSortMode(restoredAmericanoStandingsSortMode);
    setMexicanoFirstRoundMode(restoredMexicanoOptions.firstRoundMode ?? DEFAULT_MEXICANO_FIRST_ROUND_MODE);
    setMexicanoTableSortMode(restoredMexicanoOptions.tableSortMode ?? DEFAULT_MEXICANO_TABLE_SORT_MODE);
    setMexicanoWinnerSortMode(restoredMexicanoOptions.winnerSortMode ?? DEFAULT_MEXICANO_WINNER_SORT_MODE);
    ratingLastTapTsRef.current = {};
    const restoredPairs = Array.isArray(historyRecord?.params?.pairAssignments)
      ? historyRecord.params.pairAssignments
        .filter((pair): pair is PairedMexicanoPairAssignment => (
          Array.isArray(pair)
          && pair.length === 2
          && typeof pair[0] === "string"
          && typeof pair[1] === "string"
        ))
      : [];
    setPairedMexicanoPairs(restoredPairs);
  }, [historyRecord, isOpen, tournament, tournament?.id]);

  const applyCourtsCount = (count: number) => {
    setCourtNames((prev) =>
      Array.from({ length: count }, (_, idx) => prev[idx] ?? `Корт №${idx + 1}`),
    );
  };

  const handleCourtsCountSave = () => {
    const parsedCount = parseBoundedIntegerInput(courtsCountDraft, 1, 12);
    if (parsedCount == null) return;
    applyCourtsCount(parsedCount);
    setCourtsCountDraft(String(parsedCount));
  };

  const handleTargetScoreSave = () => {
    const parsedScore = parseBoundedIntegerInput(targetScoreDraft, 1, 99);
    if (parsedScore == null) return;
    setTargetScore(parsedScore);
    setTargetScoreDraft(String(parsedScore));
  };

  useEffect(() => {
    if (!isOpen) return;
    apiFetchProfile().then((res) => {
      if (res.data) setProfile(res.data);
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isCreationFlow || !profile) return;
    const profileName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
    if (!profileName) return;
    setManualOrganizerName((current) => (current.trim() ? current : profileName));
  }, [isCreationFlow, isOpen, profile]);

  const handleSaveTournament = async (allowMissingRatings = false) => {
    if (!selectedType) return;
    if (!profile?.id) {
      setSaveState("error");
      setError("Не удалось определить организатора для журнала изменений уровня");
      return;
    }
    const tournamentType = selectedType;
    const resolvedTournamentId = String(tournament?.id || draftTournamentId || createTournamentDraftId());
    const tournamentStartedAt = new Date().toISOString();
    const minRating = resolveTournamentMinRating(tournament, historyRecord);
    const manualOrganizerResolvedName = [manualOrganizerName, profile ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") : ""]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) || "";
    const manualStationResolvedName = manualStationName.trim();
    const localDateKey = String(sourceDateKey || "").trim() || formatDate(new Date());
    const getParticipantDraftRating = (participant: TournamentParticipantEntry) => (
      rosterMode === "manual"
        ? participant.rating
        : manualRatings[participant.id] ?? participant.rating
    );
    const missingParticipants = sortedParticipants.filter((participant) => {
      const ratingValue = parseTournamentRatingValue(getParticipantDraftRating(participant));
      return ratingValue == null;
    });

    if (!allowMissingRatings && missingParticipants.length > 0) {
      setMissingRatingConfirmation({
        missingCount: missingParticipants.length,
        minRatingDisplay: minRating.display,
      });
      return;
    }

    setMissingRatingConfirmation(null);
    setSaveState("loading");
    setSaveWasLocal(false);

    const participantsForRounds: ParticipantEntry[] = sortedParticipants.map((participant, idx) => {
      const ratingValue =
        parseTournamentRatingValue(getParticipantDraftRating(participant))
        ?? (allowMissingRatings ? minRating.value : null);
      return {
        id: participant.id ?? `participant-${idx}`,
        name: participant.name || `Участник ${idx + 1}`,
        photo: participant.photo ?? null,
        phone: String(participant.phone || "").trim() || null,
        rating: ratingValue != null ? String(ratingValue) : null,
      };
    });
    const startRatingChanges = buildTournamentStartRatingChanges({
      tournamentId: resolvedTournamentId,
      changedAt: tournamentStartedAt,
      changedBy: profile,
      participants: sortedParticipants.map((participant, index) => {
        const draftRating = parseTournamentRatingValue(getParticipantDraftRating(participant));
        const savedChange = savedStartRatingChanges[participant.id];
        return {
          participantId: participant.id,
          clientId: participant.clientId,
          name: participant.name,
          phone: participant.phone ?? null,
          previousRating: savedChange?.previousRating ?? parseTournamentRatingValue(participant.rating),
          nextRating: parseTournamentRatingValue(participantsForRounds[index]?.rating),
          reason: draftRating == null ? "MINIMUM_ASSIGNED" : "MANUAL_OVERRIDE",
        };
      }),
    });

    const completedMexicanoPairs = pairedMexicanoPairs
      .filter((pair): pair is PairedMexicanoPairAssignment => pair.length === 2)
      .map((pair) => [pair[0], pair[1]] as PairedMexicanoPairAssignment);
    if ((tournamentType === "paired_mexicano" || tournamentType === "paired_americano") && pairedMexicanoPairError) {
      setSaveState("error");
      return;
    }
    if (tournamentType === "americano_flex" && americanoFlexError) {
      setSaveState("error");
      return;
    }
    const scheduleMode = resolveAmericanoScheduleMode(tournamentType);
    const mexicanoOptionsFromHistory = parseMexicanoOptions(historyRecord?.params);
    const mexicanoOptions = {
      ...mexicanoOptionsFromHistory,
      firstRoundMode: mexicanoFirstRoundMode,
      tableSortMode: mexicanoTableSortMode,
      winnerSortMode: mexicanoWinnerSortMode,
    } satisfies MexicanoClassicOptions;
    const mexicanoParams = buildMexicanoClassicParams(sortedParticipants.length, {
      ...mexicanoOptions,
      seed: mexicanoOptions.seed ?? resolvedTournamentId,
    });

    const roundsForServer = serializeAmericanoRounds(
      tournamentType === "paired_mexicano"
        ? createPairedMexicanoInitialRounds(participantsForRounds, courtNames, completedMexicanoPairs)
        : tournamentType === "paired_americano"
          ? createPairedAmericanoRounds(participantsForRounds, courtNames, completedMexicanoPairs)
          : tournamentType === "mexicano"
            ? createMexicanoClassicInitialRound(
                participantsForRounds,
                courtNames,
                mexicanoParams,
              )
          : createAmericanoRounds(
              participantsForRounds,
              courtNames,
              { mode: scheduleMode },
            ),
    );
    const readyParticipantIdsForPayload = sortedParticipants
      .filter((participant) => readyParticipantIds[participant.id] === true)
      .map((participant) => participant.id);

    const payload: AmericanoTournamentPayload = {
      tournamentId: resolvedTournamentId,
      tenantKey: TENANT_KEY,
      createdAt: tournamentStartedAt,
      organizer: {
        id: profile?.id ?? null,
        phone: profile?.phone ?? null,
        tenantKey: TENANT_KEY,
        name: [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || null,
      },
      tournamentType,
      targetScore,
      courts: courtNames,
      params:
        rosterMode === "manual"
          ? {
              manualTournament: true,
              localStatus: "draft",
              syncStatus: "pending_viva",
              localDateKey,
              stationName: manualStationResolvedName || null,
              organizerName: manualOrganizerResolvedName || null,
              organizerId: profile?.id ?? null,
            }
          : undefined,
      participants: participantsForRounds.map((participant) => ({
        id: participant.id ?? null,
        phone: participant.phone ?? null,
        rating: participant.rating ?? null,
        photo: participant.photo ?? null,
        name: participant.name,
        spot: participant.spot ?? null,
        isCancelled: false,
      })),
      startRatingChanges,
      rounds: roundsForServer,
    };

    const payloadWithTypeSpecificParams: AmericanoTournamentPayload = {
      ...payload,
      params:
        tournamentType === "paired_mexicano"
          ? {
              tournamentFamily: "mexicano",
              tournamentSubtype: "paired",
              mexicanoMode: "paired",
              totalRounds: Math.max(1, completedMexicanoPairs.length - 1),
              pairAssignments: completedMexicanoPairs,
              readyParticipantIds: readyParticipantIdsForPayload,
              ...(rosterMode === "manual"
                ? {
                    manualTournament: true,
                    localStatus: "draft",
                    syncStatus: "pending_viva",
                    localDateKey,
                    stationName: manualStationResolvedName || null,
                    organizerName: manualOrganizerResolvedName || null,
                    organizerId: profile?.id ?? null,
                  }
                : {}),
            }
          : tournamentType === "paired_americano"
            ? {
                tournamentFamily: "americano",
                tournamentSubtype: "paired",
                standingsSortMode: americanoStandingsSortMode,
                pairAssignments: completedMexicanoPairs,
                readyParticipantIds: readyParticipantIdsForPayload,
                ...(rosterMode === "manual"
                  ? {
                      manualTournament: true,
                      localStatus: "draft",
                      syncStatus: "pending_viva",
                      localDateKey,
                      stationName: manualStationResolvedName || null,
                      organizerName: manualOrganizerResolvedName || null,
                      organizerId: profile?.id ?? null,
                    }
                  : {}),
              }
            : tournamentType === "americano_flex"
              ? {
                  tournamentFamily: "americano",
                  tournamentSubtype: "flex",
                  standingsSortMode: americanoStandingsSortMode,
                  readyParticipantIds: readyParticipantIdsForPayload,
                  ...(rosterMode === "manual"
                    ? {
                        manualTournament: true,
                        localStatus: "draft",
                        syncStatus: "pending_viva",
                        localDateKey,
                        stationName: manualStationResolvedName || null,
                        organizerName: manualOrganizerResolvedName || null,
                        organizerId: profile?.id ?? null,
                      }
                    : {}),
                }
              : tournamentType === "americano_classic"
                ? {
                    tournamentFamily: "americano",
                    tournamentSubtype: "classic",
                    standingsSortMode: americanoStandingsSortMode,
                    readyParticipantIds: readyParticipantIdsForPayload,
                    ...(rosterMode === "manual"
                      ? {
                          manualTournament: true,
                          localStatus: "draft",
                          syncStatus: "pending_viva",
                          localDateKey,
                          stationName: manualStationResolvedName || null,
                          organizerName: manualOrganizerResolvedName || null,
                          organizerId: profile?.id ?? null,
                        }
                      : {}),
                  }
                : tournamentType === "mexicano"
                  ? {
                      tournamentFamily: "mexicano",
                      tournamentSubtype: "classic",
                      ...mexicanoParams,
                      readyParticipantIds: readyParticipantIdsForPayload,
                      ...(rosterMode === "manual"
                        ? {
                            manualTournament: true,
                            localStatus: "draft",
                            syncStatus: "pending_viva",
                            localDateKey,
                            stationName: manualStationResolvedName || null,
                            organizerName: manualOrganizerResolvedName || null,
                            organizerId: profile?.id ?? null,
                          }
                        : {}),
                    }
                  : {
                      tournamentFamily: selectedFamily,
                      tournamentSubtype: "padelhub",
                      standingsSortMode: americanoStandingsSortMode,
                      readyParticipantIds: readyParticipantIdsForPayload,
                      ...(rosterMode === "manual"
                        ? {
                            manualTournament: true,
                            localStatus: "draft",
                            syncStatus: "pending_viva",
                            localDateKey,
                            stationName: manualStationResolvedName || null,
                            organizerName: manualOrganizerResolvedName || null,
                            organizerId: profile?.id ?? null,
                          }
                        : {}),
                    },
    };

    const payloadWithStationContext = withTournamentStationContext(
      payloadWithTypeSpecificParams,
      tournament,
    );
    const res = await apiCreateAmericanoTournament(payloadWithStationContext);
    const isSuccess = res.status != null && res.status >= 200 && res.status < 300;
    if (isSuccess) {
      setSaveState("success");
      onSaved(payloadWithStationContext);
      onClose();
      return;
    }

    const shouldSaveLocalDraft =
      rosterMode === "manual"
      && (res.status == null || res.status >= 500);

    if (shouldSaveLocalDraft) {
      const localPayload: AmericanoTournamentPayload = {
        ...payloadWithStationContext,
        params: {
          ...(payloadWithStationContext.params ?? {}),
          createdOffline: true,
        },
      };
      saveCachedTournamentDraft({
        payload: localPayload,
        totals: null,
        playerLogs: null,
        updatedAt: new Date().toISOString(),
      });
      setSaveState("success");
      setSaveWasLocal(true);
      onSaved(localPayload);
      onClose();
      return;
    }

    setSaveState("error");
  };

  const tournamentId = tournament?.id ? String(tournament.id) : null;
  const participantExerciseId = useMemo(
    () => resolveVivaLinkedTournamentExerciseId(tournament, historyRecord),
    [historyRecord, tournament],
  );

  useEffect(() => {
    if (!isOpen || !tournamentId || !readyStateHydrated) return;
    writeTournamentReadyState(tournamentId, readyParticipantIds);
  }, [isOpen, readyParticipantIds, readyStateHydrated, tournamentId]);

  useEffect(() => {
    participantActionControllerRef.current?.abort();
    participantActionControllerRef.current = null;
    if (participantRefreshCooldownTimerRef.current !== null) {
      window.clearTimeout(participantRefreshCooldownTimerRef.current);
      participantRefreshCooldownTimerRef.current = null;
    }
    setParticipantRefreshState(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
    setParticipantLoadNotice(null);
    setParticipants([]);

    if (!isOpen || !participantExerciseId || rosterMode !== "bookings") {
      setLoading(false);
      setError((current) => current === TOURNAMENT_PARTICIPANTS_LOAD_ERROR ? null : current);
      participantAutoPauseRef.current = null;
      participantAutoRunRef.current = null;
      participantAutoScheduleRef.current = () => undefined;
      participantAutoRescheduleRef.current = () => undefined;
      return;
    }
    const activeParticipantExerciseId = participantExerciseId;

    let stopped = false;
    let timerId: number | null = null;
    let activeController: AbortController | null = null;
    let previousFingerprint: string | null = null;
    let currentDelayMs = 0;

    function pauseCurrentRefresh() {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      activeController?.abort();
      activeController = null;
    }

    function stopRefreshCycle() {
      if (stopped) return;
      stopped = true;
      pauseCurrentRefresh();
      participantActionControllerRef.current?.abort();
      participantActionControllerRef.current = null;
    }

    function scheduleRefresh(delayMs: number) {
      if (stopped || isLkIdleRequestPaused()) {
        stopRefreshCycle();
        return;
      }
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      timerId = window.setTimeout(() => {
        timerId = null;
        void runRefresh(false);
      }, delayMs);
    }

    function rescheduleRefresh(
      fingerprint: string | null,
      outcomeOverride?: TournamentParticipantRefreshOutcome,
    ) {
      const outcome = outcomeOverride
        ?? (previousFingerprint === null
          ? "initial"
          : fingerprint === previousFingerprint
            ? "unchanged"
            : "changed");
      if (fingerprint !== null) {
        previousFingerprint = fingerprint;
      }
      currentDelayMs = resolveTournamentParticipantRefreshDelay(outcome, currentDelayMs);
      scheduleRefresh(currentDelayMs);
    }

    async function runRefresh(initialLoad: boolean) {
      if (stopped || isLkIdleRequestPaused()) {
        stopRefreshCycle();
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      if (initialLoad) {
        setLoading(true);
        setError(null);
      }

      const result = await apiFetchTournamentParticipants(activeParticipantExerciseId, {
        retries: 0,
        signal: controller.signal,
      });
      if (stopped || controller.signal.aborted) return;
      activeController = null;

      if (isLkIdleRequestPausedError(result.error?.raw) || isLkIdleRequestPaused()) {
        stopRefreshCycle();
        return;
      }

      if (result.status === 429) {
        setLoading(false);
        setError(null);
        setParticipantLoadNotice(
          "Состав уже обновляется. Покажем актуальные данные через несколько секунд.",
        );
        scheduleRefresh(resolveTournamentParticipantBusyRetryMs(result.error?.raw));
        return;
      }

      const rawParticipants = extractTournamentParticipantBookings(result.data);
      if (result.error || rawParticipants === null) {
        setParticipantLoadNotice(null);
        if (initialLoad) {
          setError(TOURNAMENT_PARTICIPANTS_LOAD_ERROR);
          setLoading(false);
        }
        rescheduleRefresh(null, "error");
        return;
      }

      const nextParticipants = normalizeTournamentParticipantBookings(rawParticipants);
      const fingerprint = buildTournamentParticipantRosterFingerprint(nextParticipants);
      setParticipantLoadNotice(null);
      if (initialLoad || previousFingerprint === null || fingerprint !== previousFingerprint) {
        setParticipants(nextParticipants);
      }
      setError((current) => current === TOURNAMENT_PARTICIPANTS_LOAD_ERROR ? null : current);
      if (initialLoad) {
        setLoading(false);
      }
      rescheduleRefresh(fingerprint);
    }

    participantAutoPauseRef.current = pauseCurrentRefresh;
    participantAutoRunRef.current = () => {
      void runRefresh(false);
    };
    participantAutoScheduleRef.current = scheduleRefresh;
    participantAutoRescheduleRef.current = rescheduleRefresh;
    window.addEventListener(LK_IDLE_DATA_STALE_EVENT_NAME, stopRefreshCycle);
    void runRefresh(true);

    return () => {
      stopRefreshCycle();
      window.removeEventListener(LK_IDLE_DATA_STALE_EVENT_NAME, stopRefreshCycle);
      participantAutoPauseRef.current = null;
      participantAutoRunRef.current = null;
      participantAutoScheduleRef.current = () => undefined;
      participantAutoRescheduleRef.current = () => undefined;
      if (participantRefreshCooldownTimerRef.current !== null) {
        window.clearTimeout(participantRefreshCooldownTimerRef.current);
        participantRefreshCooldownTimerRef.current = null;
      }
    };
  }, [isOpen, participantExerciseId, rosterMode]);

  const loadParticipants = useCallback(async (nextTournamentId: string) => {
    participantAutoPauseRef.current?.();
    participantActionControllerRef.current?.abort();
    const controller = new AbortController();
    participantActionControllerRef.current = controller;
    setLoading(true);
    setError(null);
    setParticipantLoadNotice(null);

    const result = await apiFetchTournamentParticipants(nextTournamentId, {
      retries: 0,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (participantActionControllerRef.current === controller) {
      participantActionControllerRef.current = null;
    }
    if (isLkIdleRequestPausedError(result.error?.raw) || isLkIdleRequestPaused()) {
      return;
    }

    if (result.status === 429) {
      setLoading(false);
      setError(null);
      setParticipantLoadNotice(
        "Состав уже обновляется. Покажем актуальные данные через несколько секунд.",
      );
      participantAutoScheduleRef.current(
        resolveTournamentParticipantBusyRetryMs(result.error?.raw),
      );
      return;
    }

    const rawParticipants = extractTournamentParticipantBookings(result.data);
    if (result.error || rawParticipants === null) {
      setParticipantLoadNotice(null);
      setError(TOURNAMENT_PARTICIPANTS_LOAD_ERROR);
      setLoading(false);
      participantAutoRescheduleRef.current(null, "error");
      return;
    }

    const nextParticipants = normalizeTournamentParticipantBookings(rawParticipants);
    setParticipantLoadNotice(null);
    setParticipants(nextParticipants);
    setLoading(false);
    participantAutoRescheduleRef.current(
      buildTournamentParticipantRosterFingerprint(nextParticipants),
    );
  }, []);

  const handleRefreshParticipantsFromViva = useCallback(async () => {
    if (
      !participantExerciseId
      || !canRefreshParticipantsFromViva
      || rosterMode !== "bookings"
      || participantRefreshState.status === "pending"
      || participantRefreshState.status === "cooldown"
      || participantRefreshState.retryBlocked === true
      || isLkIdleRequestPaused()
    ) {
      return;
    }

    participantAutoPauseRef.current?.();
    participantActionControllerRef.current?.abort();
    if (participantRefreshCooldownTimerRef.current !== null) {
      window.clearTimeout(participantRefreshCooldownTimerRef.current);
      participantRefreshCooldownTimerRef.current = null;
    }

    const requestedExerciseId = participantExerciseId;
    const controller = new AbortController();
    participantActionControllerRef.current = controller;
    setParticipantLoadNotice(null);
    setParticipantRefreshState({
      status: "pending",
      message: "Запрашиваем актуальный состав в Viva…",
    });

    const result = await apiRefreshTournamentParticipants(requestedExerciseId, {
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    if (participantActionControllerRef.current === controller) {
      participantActionControllerRef.current = null;
    }
    if (isLkIdleRequestPausedError(result.error?.raw) || isLkIdleRequestPaused()) {
      return;
    }
    if (result.error || !result.data) {
      setParticipantRefreshState({
        status: "error",
        message: result.error?.message || "Не удалось обновить участников из Viva",
      });
      participantAutoRescheduleRef.current(null, "error");
      return;
    }
    if (result.data.exerciseId !== requestedExerciseId) {
      setParticipantRefreshState({
        status: "error",
        message: "Сервер вернул состав другого турнира. Данные не применены.",
      });
      participantAutoRescheduleRef.current(null, "error");
      return;
    }

    const nextParticipants = normalizeTournamentParticipantBookings(result.data.participants);
    const applyReturnedParticipants = shouldApplyTournamentParticipantRefreshRoster(
      result.data.reason,
      result.data.refreshedAt,
    );
    const nextFingerprint = applyReturnedParticipants
      ? buildTournamentParticipantRosterFingerprint(nextParticipants)
      : null;
    if (applyReturnedParticipants) {
      setParticipants(nextParticipants);
    }

    if (result.data.reason === "refreshed") {
      const retryAfterMs = Math.max(0, result.data.retryAfterMs ?? 0);
      setParticipantRefreshState({
        status: "success",
        message: retryAfterMs > 0
          ? `Участники обновлены: ${nextParticipants.length}. Повторное обновление будет доступно через ${Math.max(1, Math.ceil(retryAfterMs / 1_000))} сек.`
          : `Участники обновлены: ${nextParticipants.length}.`,
        retryBlocked: retryAfterMs > 0,
      });
      if (retryAfterMs > 0) {
        participantRefreshCooldownTimerRef.current = window.setTimeout(() => {
          participantRefreshCooldownTimerRef.current = null;
          setParticipantRefreshState(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
        }, retryAfterMs);
      }
      participantAutoRescheduleRef.current(nextFingerprint);
      return;
    }

    if (result.data.reason === "in_progress") {
      const retryAfterMs = Math.max(
        1_000,
        result.data.retryAfterMs ?? TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.active,
      );
      const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
      setParticipantRefreshState({
        status: "cooldown",
        message: `Обновление уже выполняется. Актуальный состав появится примерно через ${retrySeconds} сек.`,
        retryBlocked: true,
      });
      participantRefreshCooldownTimerRef.current = window.setTimeout(() => {
        participantRefreshCooldownTimerRef.current = null;
        setParticipantRefreshState(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
        participantAutoRunRef.current?.();
      }, retryAfterMs);
      return;
    }

    if (result.data.reason === "cooldown") {
      const retryAfterMs = Math.max(
        1_000,
        result.data.retryAfterMs ?? TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.active,
      );
      const retrySeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
      setParticipantRefreshState({
        status: "cooldown",
        message: `Состав недавно обновлялся. Повторить можно через ${retrySeconds} сек.`,
        retryBlocked: true,
      });
      participantRefreshCooldownTimerRef.current = window.setTimeout(() => {
        participantRefreshCooldownTimerRef.current = null;
        setParticipantRefreshState(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
      }, retryAfterMs);
      participantAutoRescheduleRef.current(nextFingerprint);
      return;
    }

    const retryAfterMs = Math.max(0, result.data.retryAfterMs ?? 0);
    setParticipantRefreshState({
      status: "error",
      message: result.data.reason === "stale_if_error"
        ? "Viva временно недоступна. Показан последний сохранённый состав."
        : "Viva временно не может обновить состав. Попробуйте позже.",
      retryBlocked: retryAfterMs > 0,
    });
    if (retryAfterMs > 0) {
      participantRefreshCooldownTimerRef.current = window.setTimeout(() => {
        participantRefreshCooldownTimerRef.current = null;
        setParticipantRefreshState(TOURNAMENT_PARTICIPANT_REFRESH_IDLE_STATE);
      }, retryAfterMs);
    }
    participantAutoRescheduleRef.current(nextFingerprint, "error");
  }, [
    canRefreshParticipantsFromViva,
    participantExerciseId,
    participantRefreshState.retryBlocked,
    participantRefreshState.status,
    rosterMode,
  ]);

  const trainer = tournament?.trainers?.[0];
  const title = isCreationFlow ? "Создание турнира" : (tournament?.direction?.name || tournament?.type?.name || "Турнир");

  const baseParticipantEntries = useMemo((): TournamentParticipantEntry[] => {
    return normalizeTournamentParticipantBookings(participants).map((participant, idx) => ({
      id: participant.client?.id ?? participant.id ?? `participant-${idx}`,
      bookingId: participant.id ?? null,
      clientId: participant.client?.id ?? null,
      name: getClientName(participant, idx),
      photo: participant.client?.photo ?? null,
      phone: null,
      spot: participant.spot ?? null,
      rating: participant.rating ?? null,
    }));
  }, [participants]);

  const manualParticipantEntries = useMemo((): TournamentParticipantEntry[] => {
    return manualParticipants.map((participant, idx) => ({
      id: participant.id || `manual-participant-${idx}`,
      bookingId: null,
      clientId: null,
      name: participant.name || `Игрок ${idx + 1}`,
      photo: null,
      phone: participant.phone || null,
      spot: null,
      rating: participant.rating || null,
    }));
  }, [manualParticipants]);

  const activeParticipantBaseEntries = rosterMode === "manual"
    ? manualParticipantEntries
    : baseParticipantEntries;

  const organizerSlotParticipant = useMemo<TournamentParticipantEntry | null>(() => {
    if (!profile) return null;

    const profileRatingNumeric = parseNumericLevel(
      getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
    );
    const profileRatingLetter =
      getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel)
      ?? (profileRatingNumeric != null ? getLetterGrade(profileRatingNumeric) : null);
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Организатор";
    const persistedRating =
      organizerSlotRating
      ?? (profileRatingNumeric != null ? profileRatingNumeric.toFixed(5) : profileRatingLetter ?? null);

    return {
      id: profile.id || "organizer-slot-self",
      bookingId: null,
      clientId: profile.id || null,
      name,
      photo: profile.photo ?? null,
      phone: null,
      spot: null,
      rating: persistedRating,
      isOrganizerSlot: true,
    };
  }, [organizerSlotRating, profile]);

  const participantEntries = useMemo((): TournamentParticipantEntry[] => {
    return resolveTournamentParticipantEntries(activeParticipantBaseEntries, organizerSlotParticipant);
  }, [activeParticipantBaseEntries, organizerSlotParticipant]);

  const participantRatingsRefreshKey = useMemo(
    () =>
      participantEntries
        .map((participant) => [
          participant.id,
          participant.clientId ?? "",
          participant.isOrganizerSlot ? "organizer" : "participant",
        ].join(":"))
        .sort()
        .join("|"),
    [participantEntries],
  );

  const isCurrentUserParticipant = (participant: TournamentParticipantEntry) => {
    if (!profile || participant.isOrganizerSlot) return false;
    if (profile.id && participant.clientId && profile.id === participant.clientId) return true;
    return false;
  };

  const handleParticipantRatingInput = (participantId: string, value: string) => {
    setManualRatings((prev) => ({
      ...prev,
      [participantId]: value,
    }));
    setRatingSaveErrors((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
  };

  const handleManualParticipantChange = (
    participantId: string,
    field: keyof Pick<TournamentManualParticipantDraft, "name" | "phone" | "rating">,
    value: string,
  ) => {
    setManualParticipants((prev) => prev.map((participant) => (
      participant.id === participantId
        ? { ...participant, [field]: value }
        : participant
    )));
    setSaveState("idle");
    setSaveWasLocal(false);
    setMissingRatingConfirmation(null);
  };

  const handleAddManualParticipant = () => {
    setManualParticipants((prev) => [
      ...prev,
      createTournamentManualParticipantDraft(prev.length),
    ]);
    setSaveState("idle");
    setSaveWasLocal(false);
    setMissingRatingConfirmation(null);
  };

  const handleRemoveManualParticipant = (participantId: string) => {
    setManualParticipants((prev) => prev.filter((participant) => participant.id !== participantId));
    setReadyParticipantIds((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setManualRatings((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setRatingSaveStateById((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setRatingSaveErrors((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setRatingEditModeById((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setPairedMexicanoPairs((prev) => prev
      .map((pair) => pair.filter((id) => id !== participantId))
      .filter((pair) => pair.length > 0));
    if (replaceParticipantId === participantId) {
      setReplaceParticipantId(null);
    }
    setSaveState("idle");
    setSaveWasLocal(false);
    setMissingRatingConfirmation(null);
  };

  const handleEnableManualRoster = () => {
    setRosterMode("manual");
    setLoading(false);
    setError(null);
    setRefreshRatingsError(null);
    setMissingRatingConfirmation(null);
    setParticipantLeaveTarget(null);
    setLeaveError(null);
    setRatingSaveStateById({});
    setRatingSaveErrors({});
    setRatingEditModeById({});
    setReplaceParticipantId(null);
    setReplaceSearchQuery("");
    setReplaceSearchResults([]);
    setReplaceSearchLoading(false);
    setReplaceSearchError(null);
    setReplaceSubmitLoading(false);
    setAutoRefreshedParticipantsKey("");
    setSaveState("idle");
    setSaveWasLocal(false);
    setManualParticipants((prev) => {
      if (prev.length > 0) return prev;
      const seededParticipants = baseParticipantEntries
        .map((participant) => ({
          id: participant.id,
          name: manualRatings[participant.id] ?? participant.name ?? "",
          phone: participant.phone ?? "",
          rating: manualRatings[participant.id] ?? participant.rating ?? "",
        }))
        .sort(compareTournamentParticipantsByRating)
        .map((participant, index) => createTournamentManualParticipantDraft(index, participant));

      return seededParticipants.length > 0
        ? seededParticipants
        : [createTournamentManualParticipantDraft(0)];
    });
  };

  const handleReturnToBookingRoster = () => {
    setRosterMode("bookings");
    setLoading(false);
    setError(null);
    setRefreshRatingsError(null);
    setMissingRatingConfirmation(null);
    setParticipantLeaveTarget(null);
    setLeaveError(null);
    setRatingSaveStateById({});
    setRatingSaveErrors({});
    setRatingEditModeById({});
    setReplaceParticipantId(null);
    setReplaceSearchQuery("");
    setReplaceSearchResults([]);
    setReplaceSearchLoading(false);
    setReplaceSearchError(null);
    setReplaceSubmitLoading(false);
    setAutoRefreshedParticipantsKey("");
    setSaveState("idle");
    setSaveWasLocal(false);
  };

  const handleRefreshParticipantRatings = async (silent = false) => {
    if (rosterMode === "manual" || participantEntries.length === 0) return;

    setRefreshingRatings(true);
    if (!silent) {
      setRefreshRatingsError(null);
    }

    const liveRatingsResult = await apiFetchPadelLiveRatings(
      participantEntries.map((participant) => ({
        clientId: participant.clientId,
        phone: null,
        name: participant.name,
        rating: participant.rating ?? null,
        ratingNumeric: null,
      })),
    );

    if (liveRatingsResult.error) {
      setRefreshingRatings(false);
      if (!silent) {
        setRefreshRatingsError(liveRatingsResult.error.message || "Не удалось пересчитать рейтинги");
      }
      return;
    }

    const liveByClientId = new Map<string, string | null>();

    (liveRatingsResult.data ?? []).forEach((item) => {
      const clientId = (item.clientId || "").trim();
      const parsedNumeric =
        typeof item.ratingNumeric === "number" && Number.isFinite(item.ratingNumeric)
          ? item.ratingNumeric
          : parseTournamentRatingValue(item.rating);
      const nextRating =
        parsedNumeric != null
          ? parsedNumeric.toFixed(3)
          : (
            typeof item.rating === "string" && item.rating.trim()
              ? item.rating.trim()
              : null
          );

      if (clientId) liveByClientId.set(clientId, nextRating);
    });

    const refreshedPositiveIds = new Set<string>();
    const nextOrganizerRating = organizerSlotParticipant
      ? (organizerSlotParticipant.clientId ? liveByClientId.get(organizerSlotParticipant.clientId) : undefined)
      : undefined;

    setParticipants((prev) =>
      prev.map((participant, idx) => {
        const clientId = (participant.client?.id || "").trim();
        const bookingId = (participant.id || "").trim();
        const nextRating =
          clientId ? liveByClientId.get(clientId) : undefined;

        if (nextRating === undefined) return participant;

        const participantId = clientId || bookingId || `participant-${idx}`;
        if (parseTournamentRatingValue(nextRating) != null) {
          refreshedPositiveIds.add(participantId);
        }

        return {
          ...participant,
          rating: nextRating ?? undefined,
          ratingSource: parseTournamentRatingValue(nextRating) != null ? "level" : participant.ratingSource,
        };
      }),
    );

    if (organizerSlotParticipant && nextOrganizerRating !== undefined) {
      setOrganizerSlotRating(nextOrganizerRating ?? null);
      if (parseTournamentRatingValue(nextOrganizerRating) != null) {
        refreshedPositiveIds.add(organizerSlotParticipant.id);
      }
    }

    setManualRatings((prev) => {
      if (refreshedPositiveIds.size === 0) return prev;
      const next = { ...prev };
      refreshedPositiveIds.forEach((participantId) => {
        delete next[participantId];
      });
      return next;
    });
    setRatingSaveErrors((prev) => {
      if (refreshedPositiveIds.size === 0) return prev;
      const next = { ...prev };
      refreshedPositiveIds.forEach((participantId) => {
        delete next[participantId];
      });
      return next;
    });
    setRefreshingRatings(false);
  };

  useEffect(() => {
    if (rosterMode === "manual") return;
    if (!isOpen || loading || refreshingRatings || participantEntries.length === 0) return;
    if (!participantRatingsRefreshKey || participantRatingsRefreshKey === autoRefreshedParticipantsKey) return;
    setAutoRefreshedParticipantsKey(participantRatingsRefreshKey);
    void handleRefreshParticipantRatings(true);
  }, [
    autoRefreshedParticipantsKey,
    isOpen,
    loading,
    rosterMode,
    participantEntries.length,
    participantRatingsRefreshKey,
    refreshingRatings,
  ]);

  const handleParticipantRatingSave = async (participant: TournamentParticipantEntry) => {
    const rawRating = manualRatings[participant.id] ?? "";
    const parsedRating = parseTournamentRatingValue(rawRating);
    const previousRating = parseTournamentRatingValue(participant.rating);

    if (!participant.clientId) {
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: "Не найден clientId для сохранения рейтинга",
      }));
      return false;
    }

    if (parsedRating == null) {
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: "Введите рейтинг больше 0",
      }));
      return false;
    }

    const ratingChangeTournamentId = String(tournamentId || draftTournamentId || "").trim();
    if (!ratingChangeTournamentId || !profile?.id) {
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: "Не удалось определить турнир или автора изменения",
      }));
      return false;
    }

    setRatingSaveStateById((prev) => ({
      ...prev,
      [participant.id]: "saving",
    }));
    setRatingSaveErrors((prev) => {
      if (!prev[participant.id]) return prev;
      const next = { ...prev };
      delete next[participant.id];
      return next;
    });

    const changedAt = new Date().toISOString();
    const response = await apiSaveOnboardingLevel(buildTournamentRatingChangePayload({
      tournamentId: ratingChangeTournamentId,
      clientId: participant.clientId,
      playerName: participant.name,
      playerPhone: participant.phone,
      previousRating,
      nextRating: parsedRating,
      levelLetter: getLetterGrade(parsedRating),
      changedAt,
      changedBy: profile,
    }));

    if (response.error) {
      setRatingSaveStateById((prev) => ({
        ...prev,
        [participant.id]: "idle",
      }));
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: response.error?.message || "Не удалось сохранить рейтинг",
      }));
      return false;
    }

    if (participant.isOrganizerSlot) {
      setOrganizerSlotRating(parsedRating.toFixed(5));
    } else {
      setParticipants((prev) =>
        prev.map((item, idx) => {
          const itemParticipantId = item.client?.id ?? item.id ?? `participant-${idx}`;
          if (itemParticipantId !== participant.id) return item;
          return {
            ...item,
            rating: parsedRating.toFixed(5),
            ratingSource: "level",
          };
        }),
      );
    }
    setSavedStartRatingChanges((prev) => ({
      ...prev,
      [participant.id]: {
        previousRating: prev[participant.id]?.previousRating ?? previousRating,
        nextRating: parsedRating,
      },
    }));
    setManualRatings((prev) => {
      const next = { ...prev };
      delete next[participant.id];
      return next;
    });
    setRatingSaveStateById((prev) => ({
      ...prev,
      [participant.id]: "idle",
    }));
    return true;
  };

  const handleOpenParticipantRatingEdit = (participant: TournamentParticipantEntry) => {
    if (!participant.clientId) return;
    const parsedRating = parseTournamentRatingValue(participant.rating);
    setRatingEditModeById((prev) => ({
      ...prev,
      [participant.id]: true,
    }));
    if (parsedRating == null) return;
    setManualRatings((prev) => {
      if ((prev[participant.id] || "").trim() !== "") return prev;
      return {
        ...prev,
        [participant.id]: parsedRating.toFixed(3),
      };
    });
  };

  const handleCloseParticipantRatingEdit = (participantId: string) => {
    setRatingEditModeById((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setManualRatings((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
    setRatingSaveErrors((prev) => {
      if (!prev[participantId]) return prev;
      const next = { ...prev };
      delete next[participantId];
      return next;
    });
  };

  const handleParticipantRatingTap = (
    participant: TournamentParticipantEntry,
    eventTimeStamp: number,
  ) => {
    const nowTs = eventTimeStamp;
    const lastTs = ratingLastTapTsRef.current[participant.id] ?? 0;
    ratingLastTapTsRef.current[participant.id] = nowTs;
    if (nowTs - lastTs <= 360) {
      handleOpenParticipantRatingEdit(participant);
    }
  };

  const handleParticipantLeave = async (participant: TournamentParticipantEntry) => {
    if (!participant.bookingId || participantLeaveTarget) return;
    setLeaveError(null);
    setParticipantLeaveTarget(participant);
  };

  const sortedParticipants = useMemo(() => {
    return [...participantEntries].sort((a, b) => {
      const aRating = parseTournamentRatingValue(a.rating);
      const bRating = parseTournamentRatingValue(b.rating);
      if (aRating == null && bRating == null) return 0;
      if (aRating == null) return 1;
      if (bRating == null) return -1;
      return bRating - aRating;
    });
  }, [participantEntries]);

  const sortedParticipantIds = useMemo(
    () => sortedParticipants.map((participant) => participant.id),
    [sortedParticipants],
  );
  const replaceTargetParticipant = useMemo(
    () => sortedParticipants.find((participant) => participant.id === replaceParticipantId) ?? null,
    [replaceParticipantId, sortedParticipants],
  );

  const closeReplaceParticipantPanel = () => {
    setReplaceParticipantId(null);
    setReplaceSearchQuery("");
    setReplaceSearchResults([]);
    setReplaceSearchLoading(false);
    setReplaceSearchError(null);
    setReplaceSubmitLoading(false);
  };

  const handleOpenReplaceParticipant = (participant: TournamentParticipantEntry) => {
    if (participant.isOrganizerSlot) return;
    setReplaceParticipantId(participant.id);
    setReplaceSearchQuery("");
    setReplaceSearchResults([]);
    setReplaceSearchLoading(false);
    setReplaceSearchError(null);
    setReplaceSubmitLoading(false);
  };

  const handleReplaceParticipantWithCandidate = async (candidate: PadelPlayerCandidate) => {
    if (!replaceTargetParticipant || replaceSubmitLoading) return;
    const candidateClientId = String(candidate.id || "").trim();
    if (!candidateClientId) {
      setReplaceSearchError("У выбранного игрока нет clientId.");
      return;
    }
    const duplicateParticipant = participantEntries.find((participant) => {
      const clientId = String(participant.clientId || "").trim();
      if (!clientId) return false;
      if (replaceTargetParticipant.clientId && clientId === replaceTargetParticipant.clientId) return false;
      return clientId === candidateClientId;
    });
    if (duplicateParticipant) {
      setReplaceSearchError("Этот игрок уже есть в составе турнира.");
      return;
    }

    const candidateName = String(candidate.name || "").trim() || "Игрок";
    const nameParts = splitParticipantFullName(candidateName);
    const candidateRatingNumeric =
      typeof candidate.ratingNumeric === "number" && Number.isFinite(candidate.ratingNumeric)
        ? candidate.ratingNumeric
        : null;
    const candidateRating =
      candidateRatingNumeric != null
        ? candidateRatingNumeric.toFixed(3)
        : (candidate.rating?.trim() || null);
    const targetClientId = String(replaceTargetParticipant.clientId || "").trim();
    const targetBookingId = String(replaceTargetParticipant.bookingId || "").trim();
    const targetId = replaceTargetParticipant.id;

    setReplaceSubmitLoading(true);
    setReplaceSearchError(null);

    setParticipants((prev) => {
      let replaced = false;
      const next = prev.map((booking) => {
        const bookingClientId = String(booking.client?.id || "").trim();
        const bookingId = String(booking.id || "").trim();
        const isTarget = (
          (targetClientId && bookingClientId === targetClientId)
          || (targetBookingId && bookingId === targetBookingId)
        );
        if (!isTarget) return booking;
        replaced = true;
        return {
          ...booking,
          client: {
            ...(booking.client ?? {}),
            id: candidateClientId,
            firstName: nameParts.firstName,
            lastName: nameParts.lastName || undefined,
            photo: candidate.photo ?? undefined,
            phone: undefined,
          },
          rating: candidateRating ?? undefined,
          ratingSource: candidateRating != null ? "level" : booking.ratingSource,
        } satisfies ExerciseBooking;
      });
      return replaced ? normalizeTournamentParticipantBookings(next) : prev;
    });

    setReplacementWaitlist((prev) => {
      const waitlistEntry: TournamentParticipantEntry = {
        ...replaceTargetParticipant,
        isOrganizerSlot: false,
      };
      const withoutSame = prev.filter((item) => {
        const sameById = item.id === waitlistEntry.id;
        const sameByClientId = Boolean(item.clientId && waitlistEntry.clientId && item.clientId === waitlistEntry.clientId);
        const isSameCandidate = item.clientId === candidateClientId;
        return !sameById && !sameByClientId && !isSameCandidate;
      });
      return [...withoutSame, waitlistEntry];
    });

    setReadyParticipantIds((prev) => {
      const next = { ...prev };
      const previousReady = prev[targetId] === true;
      delete next[targetId];
      if (previousReady) {
        next[candidateClientId] = true;
      }
      return next;
    });

    setManualRatings((prev) => {
      if (!prev[targetId]) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    setRatingSaveErrors((prev) => {
      if (!prev[targetId]) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    setRatingSaveStateById((prev) => {
      if (!prev[targetId]) return prev;
      const next = { ...prev };
      delete next[targetId];
      return next;
    });

    closeReplaceParticipantPanel();
  };

  useEffect(() => {
    if (!replaceTargetParticipant) return;
    const query = replaceSearchQuery.trim();
    if (query.length < 2) {
      setReplaceSearchResults([]);
      setReplaceSearchLoading(false);
      setReplaceSearchError(null);
      return;
    }

    let cancelled = false;
    setReplaceSearchLoading(true);
    setReplaceSearchError(null);
    const timeoutId = window.setTimeout(() => {
      void apiSearchPadelPlayers(query, 8)
        .then((result) => {
          if (cancelled) return;
          if (result.error) {
            setReplaceSearchResults([]);
            setReplaceSearchError(result.error.message || "Не удалось найти игроков Viva.");
            return;
          }
          const unique = new Map<string, PadelPlayerCandidate>();
          (result.data ?? []).forEach((item, index) => {
            const key =
              String(item.id || "").trim()
              || `${String(item.phone || "").trim()}::${String(item.name || "").trim().toLowerCase()}::${index}`;
            unique.set(key, item);
          });
          setReplaceSearchResults(Array.from(unique.values()));
        })
        .catch(() => {
          if (cancelled) return;
          setReplaceSearchResults([]);
          setReplaceSearchError("Не удалось найти игроков Viva.");
        })
        .finally(() => {
          if (!cancelled) {
            setReplaceSearchLoading(false);
          }
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [replaceSearchQuery, replaceTargetParticipant]);

  useEffect(() => {
    if (!replaceParticipantId) return;
    if (replaceTargetParticipant) return;
    closeReplaceParticipantPanel();
  }, [replaceParticipantId, replaceTargetParticipant]);

  useEffect(() => {
    if (sortedParticipantIds.length === 0) return;
    const allowedIds = new Set(sortedParticipantIds);
    setReadyParticipantIds((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      Object.entries(prev).forEach(([participantId, value]) => {
        if (value !== true) return;
        if (!allowedIds.has(participantId)) {
          changed = true;
          return;
        }
        next[participantId] = true;
      });
      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev;
      }
      return next;
    });
    setRatingEditModeById((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      Object.entries(prev).forEach(([participantId, isOpen]) => {
        if (!isOpen) return;
        if (!allowedIds.has(participantId)) {
          changed = true;
          return;
        }
        next[participantId] = true;
      });
      if (!changed && Object.keys(next).length === Object.keys(prev).length) return prev;
      return next;
    });
    const nextTapTimestamps: Record<string, number> = {};
    Object.entries(ratingLastTapTsRef.current).forEach(([participantId, ts]) => {
      if (allowedIds.has(participantId)) {
        nextTapTimestamps[participantId] = ts;
      }
    });
    ratingLastTapTsRef.current = nextTapTimestamps;
  }, [sortedParticipantIds]);

  const handleToggleParticipantReady = (participantId: string) => {
    setReadyParticipantIds((prev) => ({
      ...prev,
      [participantId]: !(prev[participantId] === true),
    }));
  };

  const selectedPairPlayerIds = useMemo(
    () => new Set(pairedMexicanoPairs.flat()),
    [pairedMexicanoPairs],
  );
  const pairedMexicanoPairCount = Math.floor(sortedParticipants.length / 2);
  const completedPairedMexicanoPairsCount = pairedMexicanoPairs.filter((pair) => pair.length === 2).length;
  const pairedMexicanoMissingPairs = Math.max(0, pairedMexicanoPairCount - completedPairedMexicanoPairsCount);
  const pairedMexicanoPairError = useMemo(() => {
    if (selectedType !== "paired_mexicano" && selectedType !== "paired_americano") return null;
    const formatLabel = selectedType === "paired_americano" ? "парного американо" : "парного мексикано";
    if (sortedParticipants.length < 4) return `Для ${formatLabel} нужно минимум 4 игрока.`;
    if (sortedParticipants.length % 4 !== 0) return `Для ${formatLabel} количество игроков должно делиться на 4.`;
    if (
      pairedMexicanoPairs.length !== pairedMexicanoPairCount
      || pairedMexicanoPairs.some((pair) => pair.length !== 2)
    ) return "Распределите всех игроков по парам.";
    return null;
  }, [pairedMexicanoPairCount, pairedMexicanoPairs, selectedType, sortedParticipants.length]);
  const americanoFlexError = useMemo(() => {
    if (selectedType !== "americano_flex") return null;
    if (courtNames.length === 0) return "Укажите количество кортов.";
    if (sortedParticipants.length < 5) return "Для флекс американо нужно минимум 5 игроков.";
    const expectedPlayers = courtNames.length * 4 + 1;
    if (sortedParticipants.length !== expectedPlayers) {
      return `Для флекс американо на ${formatCourtsCountLabel(courtNames.length)} нужно ${expectedPlayers} игроков (4 × корты + 1). Сейчас: ${sortedParticipants.length}.`;
    }
    return null;
  }, [courtNames.length, selectedType, sortedParticipants.length]);

  useEffect(() => {
    if (selectedType !== "paired_mexicano" && selectedType !== "paired_americano") return;
    const validIds = new Set(sortedParticipantIds);
    setPairedMexicanoPairs((prev) => {
      const usedIds = new Set<string>();
      const next = prev.filter((pair) => {
        const valid = pair.every((playerId) => validIds.has(playerId) && !usedIds.has(playerId));
        if (valid) pair.forEach((playerId) => usedIds.add(playerId));
        return valid;
      });
      return next.length === prev.length && next.every((pair, index) => pair.join(":") === prev[index]?.join(":"))
        ? prev
        : next;
    });
  }, [selectedType, sortedParticipantIds]);

  const handlePairedMexicanoPlayerClick = (participantId: string) => {
    setPairedMexicanoPairs((prev) => {
      const existingPairIndex = prev.findIndex((pair) => pair.includes(participantId));
      if (existingPairIndex >= 0) {
        return prev
          .map((pair, index) => (index === existingPairIndex ? pair.filter((id) => id !== participantId) : pair))
          .filter((pair) => pair.length > 0);
      }

      const next = [...prev];
      const openPairIndex = next.findIndex((pair) => pair.length === 1);
      if (openPairIndex >= 0) {
        next[openPairIndex] = [next[openPairIndex][0], participantId];
        return next;
      }
      if (next.length >= pairedMexicanoPairCount) return prev;
      next.push([participantId]);
      return next;
    });
  };

  const selectedTypeUsesScores =
    selectedType === "americano_padelhub"
    || selectedType === "americano_classic"
    || selectedType === "americano_flex"
    || selectedType === "mexicano"
    || selectedType === "paired_americano"
    || selectedType === "paired_mexicano";
  const manualRosterIsEmpty = rosterMode === "manual" && manualParticipants.length === 0;
  const parsedTargetScoreDraft = selectedTypeUsesScores
    ? parseBoundedIntegerInput(targetScoreDraft, 1, 99)
    : null;
  const parsedCourtsCountDraft = selectedType
    ? parseBoundedIntegerInput(courtsCountDraft, 1, 12)
    : null;
  const canSaveTargetScore =
    selectedTypeUsesScores && parsedTargetScoreDraft != null;
  const canSaveCourtsCount =
    selectedType != null && parsedCourtsCountDraft != null && parsedCourtsCountDraft !== courtNames.length;
  const targetScoreNeedsConfirmation =
    selectedTypeUsesScores
    && (targetScoreDraft.trim() === "" || parsedTargetScoreDraft == null || parsedTargetScoreDraft !== targetScore);
  const courtsCountNeedsConfirmation =
    selectedType != null
    && (courtsCountDraft.trim() === "" || parsedCourtsCountDraft == null || parsedCourtsCountDraft !== courtNames.length);
  const settingsNeedConfirmation = targetScoreNeedsConfirmation || courtsCountNeedsConfirmation;
  const tournamentDateTimeLine = formatTournamentDateTimeLine(tournament?.timeFrom, tournament?.timeTo);
  const tournamentAddressLine = formatTournamentAddressLine(tournament?.studio);
  const tournamentMapUrl = buildTournamentMapUrl(tournament?.studio);
  const tournamentLevelRangeLabel = resolveTournamentLevelRangeLabel(tournament, historyRecord, sortedParticipants);
  const trainerInitials = getInitialsFromName([trainer?.firstName, trainer?.lastName].filter(Boolean).join(" "));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      variant="fullscreen"
      bodyClassName="tournament-settings-modal-body"
    >
      <div className="tournaments-body tournament-settings-screen">
        <div className="tournament-info-block">
          <div className="tournament-info-line">
            <span className="tournament-info-icon" aria-hidden="true">
              <svg viewBox="0 0 12 12" role="presentation">
                <path
                  d="M3.5 1v1M8.5 1v1M2 4h8M2.5 2.5h7a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="tournament-info-text">{tournamentDateTimeLine}</span>
          </div>
          {tournamentAddressLine && (
            <div className="tournament-info-line">
              <span className="tournament-info-icon" aria-hidden="true">
                <svg viewBox="0 0 12 12" role="presentation">
                  <path
                    d="M6 1.5a3 3 0 0 0-3 3c0 2.2 3 5.7 3 5.7s3-3.5 3-5.7a3 3 0 0 0-3-3zm0 4.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z"
                    fill="currentColor"
                  />
                </svg>
              </span>
              <span className="tournament-info-text">{tournamentAddressLine}</span>
              {tournamentMapUrl && (
                <a
                  className="tournament-info-map-link"
                  href={tournamentMapUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  на карте
                </a>
              )}
            </div>
          )}
          <div className="tournament-info-line">
            <span className="tournament-info-icon" aria-hidden="true">
              <svg viewBox="0 0 12 12" role="presentation">
                <path d="M1.5 9.5h2V6h-2v3.5zm3.5 0h2V4.5h-2v5zm3.5 0h2V2.5h-2v7z" fill="currentColor" />
              </svg>
            </span>
            <span className="tournament-info-text">{tournamentLevelRangeLabel}</span>
          </div>
        </div>

        {trainer && (
          <div className="tournament-section">
            <div className="tournament-section-title">Организатор</div>
            <div className="tournament-participant tournament-trainer-card">
              <div className={`tournament-participant-avatar ${trainer.photo ? "" : "no-photo"}`}>
                {trainer.photo ? (
                  <img
                    src={trainer.photo}
                    alt={trainer.firstName}
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = "none";
                      const parent = target.parentElement;
                      if (parent) parent.classList.add("no-photo");
                    }}
                  />
                ) : null}
                <span className="tournament-participant-initials">{trainerInitials}</span>
              </div>
              <div className="tournament-participant-info">
                <div className="tournament-participant-name">
                  {[trainer.firstName, trainer.lastName].filter(Boolean).join(" ") || "Тренер"}
                </div>
                <div className="tournament-participant-spot">Организатор</div>
              </div>
              <div className="tournament-participant-rating trainer">Организатор</div>
            </div>
          </div>
        )}

        <div className="tournament-section">
          <div className="tournament-section-head">
            <div className="tournament-section-title">Участники</div>
            <div className="tournament-section-head-actions">
              {rosterMode === "manual" ? (
                <>
                  <button
                    className="tournament-section-action"
                    type="button"
                    onClick={handleAddManualParticipant}
                    >
                    Добавить игрока
                  </button>
                  {tournament && (
                    <button
                      className="tournament-section-action"
                      type="button"
                      onClick={handleReturnToBookingRoster}
                    >
                      К списку записей
                    </button>
                  )}
                </>
              ) : (
                <>
                  {participantExerciseId && canRefreshParticipantsFromViva && (
                    <button
                      className={`tournament-section-action tournament-participant-refresh-action${participantRefreshState.status === "pending" ? " is-loading" : ""}`}
                      type="button"
                      onClick={() => void handleRefreshParticipantsFromViva()}
                      disabled={
                        loading
                        || participantRefreshState.status === "pending"
                        || participantRefreshState.status === "cooldown"
                        || participantRefreshState.retryBlocked === true
                      }
                      aria-busy={participantRefreshState.status === "pending"}
                    >
                      {participantRefreshState.status === "pending"
                        ? "Обновляем…"
                        : "Обновить участников"}
                    </button>
                  )}
                  <button
                    className="tournament-section-action"
                    type="button"
                    onClick={handleEnableManualRoster}
                  >
                    Создать вручную
                  </button>
                </>
              )}
            </div>
          </div>
          {rosterMode === "bookings" && participantRefreshState.message && (
            <div
              className={`tournament-participant-refresh-status is-${participantRefreshState.status}`}
              role={participantRefreshState.status === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {participantRefreshState.message}
            </div>
          )}
          {rosterMode === "bookings" && participantLoadNotice && (
            <div
              className="tournament-participant-refresh-status"
              role="status"
              aria-live="polite"
            >
              {participantLoadNotice}
            </div>
          )}
          {rosterMode === "manual" ? (
            <>
              <div className="tournament-settings-hint">
                Вручную задайте состав и уровни игроков. Бронирования не подгружаются.
              </div>
              <div className="tournament-manual-meta-grid">
                <div className="tournament-inline-field">
                  <div className="tournament-section-title">Станция</div>
                  <input
                    className="tournament-input tournament-manual-station-input"
                    type="text"
                    placeholder="Например, Ск. ПхАБ"
                    value={manualStationName}
                    onChange={(e) => setManualStationName(e.target.value)}
                  />
                </div>
                <div className="tournament-inline-field">
                  <div className="tournament-section-title">Организатор</div>
                  <input
                    className="tournament-input tournament-manual-organizer-input"
                    type="text"
                    placeholder="ФИО организатора"
                    value={manualOrganizerName}
                    onChange={(e) => setManualOrganizerName(e.target.value)}
                  />
                </div>
              </div>
              {manualParticipants.length === 0 ? (
                <div className="tournaments-muted">Добавьте хотя бы одного игрока.</div>
              ) : (
                <div className="tournament-participants">
                  {manualParticipants.map((participant, idx) => {
                    const initials = getInitialsFromName(participant.name);
                    const manualRatingValue = parseTournamentRatingValue(participant.rating);
                    const isReadyParticipant = readyParticipantIds[participant.id] === true;
                    const hasInvalidRating =
                      participant.rating.trim().length > 0 && manualRatingValue == null;
                    const missingPhone = participant.phone.trim().length === 0;
                    return (
                      <div
                        key={participant.id}
                        className={`tournament-participant${isReadyParticipant ? " is-ready" : ""}`}
                      >
                        <div className="tournament-participant-order">{idx + 1}</div>
                        <div className="tournament-participant-avatar no-photo">
                          <span className="tournament-participant-initials">{initials}</span>
                        </div>
                        <div className="tournament-participant-info tournament-participant-info--manual">
                          <input
                            className="tournament-input tournament-manual-name-input"
                            type="text"
                            placeholder="Имя игрока"
                            value={participant.name}
                            onChange={(e) => handleManualParticipantChange(participant.id, "name", e.target.value)}
                          />
                          <input
                            className="tournament-input tournament-manual-phone-input"
                            type="tel"
                            inputMode="tel"
                            placeholder="Телефон для Viva"
                            value={participant.phone}
                            onChange={(e) => handleManualParticipantChange(participant.id, "phone", e.target.value)}
                          />
                          <div className="tournament-participant-note">
                            Уровень вводится вручную
                          </div>
                          {missingPhone && (
                            <div className="tournament-participant-note">
                              Телефон нужен для синхронизации с Viva
                            </div>
                          )}
                          {hasInvalidRating && (
                            <div className="tournament-participant-note error">
                              Уровень не распознан
                            </div>
                          )}
                        </div>
                        <div className="tournament-participant-actions">
                          <div className="tournament-participant-main-actions">
                            <input
                              className="tournament-participant-rating-input tournament-manual-rating-input"
                              type="text"
                              inputMode="decimal"
                              placeholder="Уровень"
                              value={participant.rating}
                              onChange={(e) => handleManualParticipantChange(participant.id, "rating", e.target.value)}
                            />
                            <button
                              className="tournament-participant-rating-cancel"
                              type="button"
                              onClick={() => handleRemoveManualParticipant(participant.id)}
                              aria-label="Удалить игрока"
                              title="Удалить игрока"
                            >
                              ×
                            </button>
                          </div>
                          <button
                            className={`tournament-participant-ready-toggle${isReadyParticipant ? " is-checked" : ""}`}
                            type="button"
                            aria-label={isReadyParticipant ? "Убрать готовность участника" : "Отметить готовность участника"}
                            title={isReadyParticipant ? "Участник отмечен как готовый" : "Отметить как готовый"}
                            onClick={() => handleToggleParticipantReady(participant.id)}
                          >
                            <span aria-hidden>{isReadyParticipant ? "✓" : ""}</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              {loading && <div className="tournaments-muted">Загрузка...</div>}
              {!loading && error && <div className="tournaments-error">{error}</div>}
              {!loading && !error && refreshRatingsError && (
                <div className="tournaments-error">{refreshRatingsError}</div>
              )}
              {!loading && !error && leaveError && (
                <div className="tournaments-error">{leaveError}</div>
              )}
              {participantLeaveTarget?.bookingId && (
                <BookingCancellationDialog
                  bookingId={participantLeaveTarget.bookingId}
                  isOpen={Boolean(participantLeaveTarget)}
                  onClose={() => setParticipantLeaveTarget(null)}
                  onSuccessClose={() => {
                    const closedTarget = participantLeaveTarget;
                    setParticipantLeaveTarget(null);
                    if (participantExerciseId) {
                      void loadParticipants(participantExerciseId);
                    } else if (closedTarget?.id) {
                      setParticipants((prev) => prev.filter((item) => item.id !== closedTarget.id));
                    }
                  }}
                />
              )}
              {!loading && !error && !participantLoadNotice && participants.length === 0 && (
                <div className="tournaments-muted">Участников пока нет</div>
              )}
              {!loading && !error && sortedParticipants.length > 0 && (
                <div className="tournament-participants">
                  {sortedParticipants.map((participant, idx) => {
                    const initials = participant.name
                      .split(" ")
                      .map((part) => part[0] || "")
                      .join("")
                      .toUpperCase()
                      .slice(0, 2) || "U";
                    const nameParts = participant.name.trim().split(/\s+/).filter(Boolean);
                    const nameLineTop = nameParts[0] ?? participant.name;
                    const nameLineBottom = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;
                    const manualRating = manualRatings[participant.id] ?? "";
                    const savedRatingValue = parseTournamentRatingValue(participant.rating);
                    const hasSavedRating = savedRatingValue != null;
                    const ratingGradeDisplay = formatTournamentRatingGrade(savedRatingValue);
                    const manualParsedRating = parseTournamentRatingValue(manualRating);
                    const isEditingRating = ratingEditModeById[participant.id] === true;
                    const isSavingRating = ratingSaveStateById[participant.id] === "saving";
                    const canLeaveParticipant =
                      Boolean(participant.bookingId)
                      && isCurrentUserParticipant(participant);
                    const isLeavingParticipant = participantLeaveTarget?.id === participant.id;
                    const isReadyParticipant = readyParticipantIds[participant.id] === true;
                    const canReplaceParticipant = !participant.isOrganizerSlot;
                    const showReplacePanel = replaceTargetParticipant?.id === participant.id;

                    return (
                      <div key={participant.id ?? idx}>
                        <div className={`tournament-participant${isReadyParticipant ? " is-ready" : ""}`}>
                          <div className="tournament-participant-order">{idx + 1}</div>
                          <div className={`tournament-participant-avatar ${participant.photo ? "" : "no-photo"}`}>
                            {participant.photo ? (
                              <img
                                src={participant.photo}
                                alt={participant.name}
                                onError={(e) => {
                                  const target = e.currentTarget;
                                  target.style.display = "none";
                                  const parent = target.parentElement;
                                  if (parent) parent.classList.add("no-photo");
                                }}
                              />
                            ) : null}
                            <span className="tournament-participant-initials">{initials}</span>
                          </div>
                          <div className="tournament-participant-info">
                            <div className="tournament-participant-name">
                              <span>{nameLineTop}</span>
                              {nameLineBottom && <span>{nameLineBottom}</span>}
                            </div>
                            {participant.isOrganizerSlot && (
                              <div className="tournament-participant-note">
                                Тренер / организатор занимает свободный слот
                              </div>
                            )}
                            {ratingSaveErrors[participant.id] && (
                              <div className="tournament-participant-note error">
                                {ratingSaveErrors[participant.id]}
                              </div>
                            )}
                          </div>
                          <div className="tournament-participant-actions">
                            <div className="tournament-participant-main-actions">
                              {hasSavedRating && !isEditingRating ? (
                                <button
                                  className="tournament-participant-rating tournament-participant-rating-button"
                                  type="button"
                                  onClick={(event) => handleParticipantRatingTap(participant, event.timeStamp)}
                                  onDoubleClick={() => handleOpenParticipantRatingEdit(participant)}
                                  aria-label="Изменить рейтинг участника"
                                  title="Двойной тап для изменения рейтинга"
                                >
                                  {ratingGradeDisplay && (
                                    <span className="tournament-participant-rating-grade">{ratingGradeDisplay}</span>
                                  )}
                                  <span className="tournament-participant-rating-value">
                                    {formatRating(savedRatingValue, 3)}
                                  </span>
                                </button>
                              ) : (
                                <div className="tournament-participant-rating-editor">
                                  <input
                                    className="tournament-participant-rating-input"
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="Рейтинг"
                                    value={manualRating}
                                    onChange={(e) => handleParticipantRatingInput(participant.id, e.target.value)}
                                  />
                                  {isEditingRating && (
                                    <button
                                      className="tournament-participant-rating-cancel"
                                      type="button"
                                      onClick={() => handleCloseParticipantRatingEdit(participant.id)}
                                      disabled={isSavingRating}
                                      aria-label="Отменить редактирование рейтинга"
                                      title="Отменить редактирование"
                                    >
                                      ×
                                    </button>
                                  )}
                                  <button
                                    className="tournament-participant-rating-save"
                                    type="button"
                                    onClick={async () => {
                                      const saved = await handleParticipantRatingSave(participant);
                                      if (saved) {
                                        handleCloseParticipantRatingEdit(participant.id);
                                      }
                                    }}
                                    disabled={!participant.clientId || manualParsedRating == null || isSavingRating}
                                    aria-label="Сохранить рейтинг"
                                    title="Сохранить рейтинг"
                                  >
                                    {isSavingRating ? "…" : "✓"}
                                  </button>
                                </div>
                              )}
                              <button
                                className={`tournament-participant-ready-toggle${isReadyParticipant ? " is-checked" : ""}`}
                                type="button"
                                aria-label={isReadyParticipant ? "Убрать готовность участника" : "Отметить готовность участника"}
                                title={isReadyParticipant ? "Участник отмечен как готовый" : "Отметить как готовый"}
                                onClick={() => handleToggleParticipantReady(participant.id)}
                              >
                                <span aria-hidden>{isReadyParticipant ? "✓" : ""}</span>
                              </button>
                              {canReplaceParticipant && (
                                <button
                                  className="tournament-participant-replace"
                                  type="button"
                                  onClick={() => handleOpenReplaceParticipant(participant)}
                                  aria-label="Заменить игрока"
                                  title="Заменить игрока"
                                  disabled={replaceSubmitLoading}
                                >
                                  <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
                                    <path d="M6 7h9.2l-1.8-1.8 1.4-1.4L19 8l-4.2 4.2-1.4-1.4L15.2 9H6z" />
                                    <path d="M18 17H8.8l1.8 1.8-1.4 1.4L5 16l4.2-4.2 1.4 1.4L8.8 15H18z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                            {canLeaveParticipant && (
                              <button
                                className="tournament-participant-leave"
                                type="button"
                                onClick={() => void handleParticipantLeave(participant)}
                                disabled={Boolean(participantLeaveTarget)}
                              >
                                {isLeavingParticipant ? "Выходим..." : "Покинуть"}
                              </button>
                            )}
                          </div>
                        </div>
                        {showReplacePanel && (
                          <div className="tournament-replace-panel">
                            <div className="tournament-replace-panel-head">
                              <div className="tournament-replace-panel-title">
                                Замена игрока: {participant.name}
                              </div>
                              <button
                                type="button"
                                className="tournament-replace-panel-cancel"
                                onClick={closeReplaceParticipantPanel}
                              >
                                Отмена
                              </button>
                            </div>
                            <input
                              className="tournament-replace-panel-input"
                              type="text"
                              placeholder="Найти игрока в Viva"
                              value={replaceSearchQuery}
                              onChange={(e) => setReplaceSearchQuery(e.target.value)}
                            />
                            {replaceSearchQuery.trim().length < 2 && (
                              <div className="tournaments-muted">Введите минимум 2 символа для поиска.</div>
                            )}
                            {replaceSearchLoading && <div className="tournaments-muted">Ищем игроков...</div>}
                            {!replaceSearchLoading && replaceSearchError && (
                              <div className="tournament-participant-note error">{replaceSearchError}</div>
                            )}
                            {!replaceSearchLoading
                              && !replaceSearchError
                              && replaceSearchQuery.trim().length >= 2
                              && replaceSearchResults.length === 0 && (
                              <div className="tournaments-muted">Игроки не найдены.</div>
                            )}
                            {!replaceSearchLoading && replaceSearchResults.length > 0 && (
                              <div className="tournament-replace-results">
                                {replaceSearchResults.map((candidate, index) => {
                                  const candidateNumeric = parseTournamentRatingValue(candidate.ratingNumeric ?? candidate.rating ?? null);
                                  return (
                                    <button
                                      key={`${candidate.id ?? "candidate"}-${index}`}
                                      type="button"
                                      className="tournament-replace-result"
                                      onClick={() => void handleReplaceParticipantWithCandidate(candidate)}
                                      disabled={replaceSubmitLoading}
                                    >
                                      <span className="tournament-replace-result-name">{candidate.name || "Игрок"}</span>
                                      <span className="tournament-replace-result-rating">
                                        {candidateNumeric != null ? formatRating(candidateNumeric, 3) : "Без рейтинга"}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!loading && !error && replacementWaitlist.length > 0 && (
                <div className="tournament-waitlist">
                  <div className="tournament-waitlist-title">Лист ожидания</div>
                  <div className="tournament-waitlist-list">
                    {replacementWaitlist.map((participant, index) => {
                      const waitlistRating = parseTournamentRatingValue(participant.rating);
                      return (
                        <div key={`${participant.id}-${index}`} className="tournament-waitlist-item">
                          <span className="tournament-waitlist-name">{participant.name}</span>
                          <span className="tournament-waitlist-rating">
                            {waitlistRating != null ? formatRating(waitlistRating, 3) : "Без рейтинга"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="tournament-section">
          <div className="tournament-section-title">Формат турнира</div>
          <div className="tournament-type-list">
            {TOURNAMENT_FAMILIES.map((type) => (
              <button
                key={type.id}
                className={`tournament-type-option ${selectedFamily === type.id ? "active" : ""}`}
                type="button"
                onClick={() => {
                  setSelectedFamily(type.id);
                  setSelectedType(null);
                  setPairedMexicanoPairs([]);
                  setSaveState("idle");
                  setOpenTournamentTypeHintId(null);
                }}
              >
                {type.label}
              </button>
            ))}
          </div>
        </div>

        {selectedFamily && (
          <div className="tournament-section">
            <div className="tournament-section-title">Тип {selectedFamily === "americano" ? "американо" : "мексикано"}</div>
            <div className="tournament-type-list">
              {TOURNAMENT_SUBTYPES[selectedFamily].map((type) => {
                const isHintOpen = openTournamentTypeHintId === type.id;
                return (
                  <div key={type.id} className="tournament-type-option-row">
                    <button
                      className={`tournament-type-option ${selectedType === type.id ? "active" : ""}`}
                      type="button"
                      onClick={() => {
                        setSelectedType(type.id);
                        setOpenTournamentTypeHintId(null);
                      }}
                    >
                      <span>{type.label}</span>
                    </button>
                    {type.description && (
                      <button
                        type="button"
                        className={`tournament-type-help-trigger${isHintOpen ? " active" : ""}`}
                        aria-label={`Описание типа ${type.label}`}
                        title={`Описание типа ${type.label}`}
                        onClick={() => {
                          setOpenTournamentTypeHintId((prev) => (prev === type.id ? null : type.id));
                        }}
                      >
                        ?
                      </button>
                    )}
                    {type.description && isHintOpen && (
                      <div className="tournament-type-help-popover" role="note">
                        {type.description}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selectedType && (
          <div className="tournament-section">
            {selectedType === "mexicano" && (
              <div className="tournament-settings-hint">
                Классическое Mexicano: стартовый раунд формируется по настройке карточки турнира,
                далее динамическая сетка строится по текущей таблице.
              </div>
            )}
            {selectedFamily === "americano" && (
              <div className="tournament-inline-field">
                <div className="tournament-section-title">Победитель турнира</div>
                <select
                  className="tournament-input"
                  value={americanoStandingsSortMode}
                  onChange={(e) => {
                    setAmericanoStandingsSortMode(
                      e.target.value === "total_points" ? "total_points" : "point_diff",
                    );
                  }}
                >
                  <option value="point_diff">По разнице очков</option>
                  <option value="total_points">По набранным очкам</option>
                </select>
              </div>
            )}
            {selectedType === "mexicano" && (
              <>
                <div className="tournament-inline-field">
                  <div className="tournament-section-title">Сортировка первого раунда</div>
                  <select
                    className="tournament-input"
                    value={mexicanoFirstRoundMode}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === "random" || next === "equal_pairs") {
                        setMexicanoFirstRoundMode(next);
                        return;
                      }
                      setMexicanoFirstRoundMode("by_level");
                    }}
                  >
                    <option value="by_level">По уровню игроков</option>
                    <option value="random">Случайным образом</option>
                    <option value="equal_pairs">Равные пары</option>
                  </select>
                </div>

                <div className="tournament-inline-field">
                  <div className="tournament-section-title">Распределение по кортам</div>
                  <select
                    className="tournament-input"
                    value={mexicanoTableSortMode}
                    onChange={(e) => {
                      setMexicanoTableSortMode(e.target.value === "point_diff" ? "point_diff" : "total_points");
                    }}
                  >
                    <option value="total_points">По набранным очкам</option>
                    <option value="point_diff">По разнице очков</option>
                  </select>
                </div>

                <div className="tournament-inline-field">
                  <div className="tournament-section-title">Победитель турнира</div>
                  <select
                    className="tournament-input"
                    value={mexicanoWinnerSortMode}
                    onChange={(e) => {
                      setMexicanoWinnerSortMode(e.target.value === "total_points" ? "total_points" : "point_diff");
                    }}
                  >
                    <option value="point_diff">По разнице очков</option>
                    <option value="total_points">По набранным очкам</option>
                  </select>
                </div>
              </>
            )}
            {selectedTypeUsesScores && (
              <div className="tournament-inline-field">
                <div className="tournament-section-title">
                  До какого суммарного счета играть матчи
                </div>
                <div className="tournament-inline-save">
                  <input
                    className="tournament-input"
                    type="text"
                    inputMode="numeric"
                    placeholder="21"
                    value={targetScoreDraft}
                    onChange={(e) => setTargetScoreDraft(e.target.value.replace(/[^\d]/g, ""))}
                  />
                  <button
                    className="tournament-inline-save-btn"
                    type="button"
                    onClick={handleTargetScoreSave}
                    disabled={!canSaveTargetScore}
                    aria-label="Сохранить сумму счета"
                    title="Сохранить сумму счета"
                  >
                    ✓
                  </button>
                </div>
              </div>
            )}
            <div className="tournament-section-title">Сколько кортов используем</div>
            <div className="tournament-inline-save">
              <input
                className="tournament-input"
                type="text"
                inputMode="numeric"
                placeholder="Например, 2"
                value={courtsCountDraft}
                onChange={(e) => setCourtsCountDraft(e.target.value.replace(/[^\d]/g, ""))}
              />
              <button
                className="tournament-inline-save-btn"
                type="button"
                onClick={handleCourtsCountSave}
                disabled={!canSaveCourtsCount}
                aria-label="Сохранить количество кортов"
                title="Сохранить количество кортов"
              >
                ✓
              </button>
            </div>

            {courtNames.length > 0 && (
              <div className="tournament-courts">
                {courtNames.map((name, idx) => (
                  <div key={`court-${idx}`} className="tournament-court-row">
                    <input
                      className="tournament-input"
                      type="text"
                      value={name}
                      onChange={(e) => {
                        const next = [...courtNames];
                        next[idx] = e.target.value;
                        setCourtNames(next);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            {selectedType === "americano_flex" && (
              <div className={americanoFlexError ? "tournaments-error" : "tournament-settings-hint"}>
                {americanoFlexError
                  ?? `Флекс американо: ${formatCourtsCountLabel(courtNames.length)} — ${courtNames.length * 4 + 1} игроков (по схеме 4 × корты + 1).`}
              </div>
            )}

            {(selectedType === "paired_mexicano" || selectedType === "paired_americano") && (
              <div className="tournament-pair-builder">
                <div className="tournament-section-head">
                  <div className="tournament-section-title">Пары</div>
                  <button
                    className="tournament-section-action"
                    type="button"
                    onClick={() => setPairedMexicanoPairs([])}
                    disabled={pairedMexicanoPairs.length === 0}
                  >
                    Сбросить
                  </button>
                </div>
                <div className="tournament-pair-grid">
                  {Array.from({ length: pairedMexicanoPairCount }, (_, pairIndex) => {
                    const pair = pairedMexicanoPairs[pairIndex] ?? [];
                    return (
                      <div key={`mexicano-pair-${pairIndex}`} className="tournament-pair-card">
                        <div className="tournament-pair-card-title">Пара {pairIndex + 1}</div>
                        <div className="tournament-pair-slots">
                          {[0, 1].map((slotIndex) => {
                            const participant = sortedParticipants.find((item) => item.id === pair[slotIndex]);
                            return (
                              <button
                                key={`mexicano-pair-${pairIndex}-${slotIndex}`}
                                type="button"
                                className={`tournament-pair-slot ${participant ? "filled" : ""}`}
                                onClick={() => {
                                  if (participant) handlePairedMexicanoPlayerClick(participant.id);
                                }}
                              >
                                {participant ? getInitialsFromName(participant.name) : "+"}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="tournament-pair-pool">
                  {sortedParticipants.map((participant) => {
                    const selected = selectedPairPlayerIds.has(participant.id);
                    const ratingValue = parseTournamentRatingValue(participant.rating);
                    return (
                      <button
                        key={`mexicano-player-${participant.id}`}
                        className={`tournament-pair-player ${selected ? "selected" : ""}`}
                        type="button"
                        onClick={() => handlePairedMexicanoPlayerClick(participant.id)}
                      >
                        <span className="tournament-pair-player-avatar">
                          {participant.photo ? (
                            <img
                              src={participant.photo}
                              alt={participant.name}
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : null}
                          <span>{getInitialsFromName(participant.name)}</span>
                        </span>
                        <span className="tournament-pair-player-name">{participant.name}</span>
                        {ratingValue != null && (
                          <span className="tournament-pair-player-rating">
                            {formatRating(ratingValue, 3)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className={pairedMexicanoPairError ? "tournaments-error" : "tournament-settings-hint"}>
                  {pairedMexicanoPairError
                    ?? (pairedMexicanoMissingPairs > 0
                      ? `Осталось собрать пар: ${pairedMexicanoMissingPairs}.`
                      : selectedType === "paired_americano"
                        ? "Все пары собраны. Сетка будет построена по фиксированным парам."
                        : "Все пары собраны. Первый раунд будет расставлен по уровню пар.")}
                </div>
              </div>
            )}

            <div className="tournament-settings-actions">
              {settingsNeedConfirmation && (
                <div className="tournament-settings-hint">
                  Подтвердите сумму счета и количество кортов кнопками ✓.
                </div>
              )}
              <button
                className="section-cta"
                type="button"
                onClick={selectedTypeUsesScores ? () => void handleSaveTournament() : undefined}
                disabled={
                  saveState === "loading"
                  || !selectedTypeUsesScores
                  || courtNames.length === 0
                  || settingsNeedConfirmation
                  || manualRosterIsEmpty
                  || Boolean(pairedMexicanoPairError)
                  || Boolean(americanoFlexError)
                }
              >
                {saveState === "loading"
                  ? "Сохранение..."
                  : saveState === "success"
                    ? (saveWasLocal ? "Сохранено локально" : "Сохранено")
                    : selectedType === "paired_mexicano" || selectedType === "paired_americano"
                      ? (rosterMode === "manual" ? "Создать турнир" : "Начать турнир")
                      : rosterMode === "manual"
                        ? "Создать турнир"
                        : "Сохранить"}
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={Boolean(missingRatingConfirmation)}
        onClose={() => setMissingRatingConfirmation(null)}
        title="Подтверждение"
        variant="dialog"
      >
        <div className="tournament-confirm-copy">
          Игрокам без уровня будет установлен минимальный уровень согласно настройкам турнира.
        </div>
        <div className="tournament-confirm-note">
          Минимальный уровень: {missingRatingConfirmation?.minRatingDisplay}.
          {" "}
          Игроков без рейтинга: {missingRatingConfirmation?.missingCount ?? 0}.
        </div>
        <div className="tournament-confirm-actions">
          <button
            type="button"
            className="onboarding-btn onboarding-btn--secondary"
            onClick={() => setMissingRatingConfirmation(null)}
          >
            Отмена
          </button>
          <button
            type="button"
            className="onboarding-btn"
            onClick={() => void handleSaveTournament(true)}
          >
            Ок
          </button>
        </div>
      </Modal>
    </Modal>
  );
}

function TournamentManagerModal({
  isOpen,
  onClose,
  data,
  title,
  initialTotals = null,
  initialPlayerLogs = null,
  onDataChange,
  onReplaceData,
  onEditSettings,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: AmericanoTournamentPayload | null;
  title?: string;
  initialTotals?: AmericanoResultsResponse["totals"] | null;
  initialPlayerLogs?: AmericanoResultsResponse["playerLogs"] | null;
  onDataChange?: (
    payload: AmericanoTournamentPayload,
    extras: {
      totals: AmericanoResultsResponse["totals"] | null;
      playerLogs: AmericanoResultsResponse["playerLogs"] | null;
    },
  ) => void;
  onReplaceData?: (
    payload: AmericanoTournamentPayload,
    extras: {
      totals: AmericanoResultsResponse["totals"] | null;
      playerLogs: AmericanoResultsResponse["playerLogs"] | null;
    },
  ) => void;
  onEditSettings?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"tournament" | "table" | "stats">("tournament");
  const [expertMode, setExpertMode] = useState(false);
  const [rounds, setRounds] = useState<TournamentRound[]>([]);
  const statsRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [savingMatchId, setSavingMatchId] = useState<string | null>(null);
  const [sendingQueuedJobId, setSendingQueuedJobId] = useState<string | null>(null);
  const [finishingTournament, setFinishingTournament] = useState(false);
  const [finishConfirmationOpen, setFinishConfirmationOpen] = useState(false);
  const [finishTournamentError, setFinishTournamentError] = useState<string | null>(null);
  const [resumingTournament, setResumingTournament] = useState(false);
  const [resumeTournamentError, setResumeTournamentError] = useState<string | null>(null);
  const [syncingWithViva, setSyncingWithViva] = useState(false);
  const [syncWithVivaError, setSyncWithVivaError] = useState<string | null>(null);
  const [syncWithVivaSuccess, setSyncWithVivaSuccess] = useState<string | null>(null);
  const [broadcastActive, setBroadcastActive] = useState(false);
  const [broadcastServerStationId, setBroadcastServerStationId] = useState<string | null>(null);
  const [broadcastActiveTargets, setBroadcastActiveTargets] = useState<TournamentBroadcastActiveTarget[]>([]);
  const [broadcastSelectionOpen, setBroadcastSelectionOpen] = useState(false);
  const [broadcastSelectedTarget, setBroadcastSelectedTarget] = useState<TournamentBroadcastTarget | null>(null);
  const [broadcastStatus, setBroadcastStatus] = useState<TournamentBroadcastStatus>("inactive");
  const [broadcastPartial, setBroadcastPartial] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState<string | null>(null);
  const [broadcastOperationInProgress, setBroadcastOperationInProgress] = useState(false);
  const [broadcastOperationLeaseUntil, setBroadcastOperationLeaseUntil] = useState<string | null>(null);
  const [broadcastRecoveryRequired, setBroadcastRecoveryRequired] = useState(false);
  const [broadcastLoading, setBroadcastLoading] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [matchSaveErrors, setMatchSaveErrors] = useState<Record<string, string>>({});
  const [serverTotals, setServerTotals] = useState<AmericanoResultsResponse["totals"] | null>(null);
  const [serverLogs, setServerLogs] = useState<AmericanoResultsResponse["playerLogs"] | null>(null);
  const [pendingQueueRecords, setPendingQueueRecords] = useState<TournamentOfflineResultQueueRecord[]>([]);
  const [isOnline, setIsOnline] = useState(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine;
  });
  const matchElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const matchInputRefs = useRef<
    Record<string, { score1: HTMLInputElement | null; score2: HTMLInputElement | null }>
  >({});
  const tournamentJsonInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMatchNavigationRef = useRef<TournamentMatchLocation | null>(null);
  const draftHydratedSignatureRef = useRef<string | null>(null);
  const broadcastRequestGenerationRef = useRef(0);
  const broadcastTournamentIdRef = useRef<string | null>(null);

  const applyBroadcastServerState = useCallback((state: TournamentBroadcastState) => {
    const active = state.active === true;
    const status = state.status ?? (active ? "active" : "inactive");
    const operationLeaseUntil = String(state.operationLeaseUntil ?? "").trim() || null;
    const leaseTs = Date.parse(operationLeaseUntil || "");
    const isTransition = status === "starting" || status === "stopping";
    const operationInProgress = state.operationInProgress !== false
      && isTransition
      && Number.isFinite(leaseTs)
      && leaseTs > Date.now();
    const recoveryRequired = state.recoveryRequired === true
      || (active && isTransition && !operationInProgress);
    const partial = state.partial === true || status === "partial";
    const message = String(state.message ?? "").trim()
      || (partial
        ? "Трансляция запущена не на всех выбранных экранах."
        : status === "starting"
          ? operationInProgress
            ? "Запуск выполняется. Дождитесь подтверждения перед остановкой."
            : "Запуск не подтверждён. Остановите трансляцию, чтобы восстановить безопасное состояние."
          : status === "stopping"
            ? operationInProgress
              ? "Остановка выполняется. Дождитесь подтверждения."
              : "Остановка не подтверждена. Повторите остановку."
            : null);

    setBroadcastActive(active);
    setBroadcastServerStationId(String(state.stationId ?? "").trim() || null);
    setBroadcastActiveTargets(normalizeTournamentBroadcastTargets(state.activeTargets));
    setBroadcastStatus(status);
    setBroadcastPartial(partial);
    setBroadcastMessage(message);
    setBroadcastOperationInProgress(operationInProgress);
    setBroadcastOperationLeaseUntil(operationLeaseUntil);
    setBroadcastRecoveryRequired(recoveryRequired);
  }, []);

  const normalizedParticipants = useMemo<ParticipantEntry[]>(() => {
    if (!data) return [];
    return data.participants.map((p, idx) => ({
      id: p.id ?? `participant-${idx}`,
      name: p.name || `Участник ${idx + 1}`,
      photo: p.photo ?? null,
      phone: p.phone ?? null,
      rating: p.rating ?? null,
    }));
  }, [data]);
  const mexicanoOptions = useMemo(
    () => (data?.tournamentType === "mexicano" ? parseMexicanoOptions(data.params) : null),
    [data?.params, data?.tournamentType],
  );
  const tournamentFinished = useMemo(
    () => isTournamentMarkedFinished(data?.params, null),
    [data?.params],
  );
  const draftDataSignature = useMemo(() => {
    if (!data) return null;
    return JSON.stringify({
      tournamentId: data.tournamentId,
      tenantKey: data.tenantKey,
      createdAt: data.createdAt,
      tournamentType: data.tournamentType,
      targetScore: data.targetScore,
      courts: data.courts,
      participants: data.participants,
      params: data.params ?? null,
      rounds: data.rounds,
    });
  }, [data]);

  useEffect(() => {
    const nextTournamentId = data?.tournamentId ?? null;
    const tournamentChanged = broadcastTournamentIdRef.current !== nextTournamentId;
    if (tournamentChanged) {
      broadcastTournamentIdRef.current = nextTournamentId;
      broadcastRequestGenerationRef.current += 1;
    }
    if (!data) {
      draftHydratedSignatureRef.current = null;
      return;
    }
    const hydratedRounds = hydrateAmericanoRounds(
      data.rounds,
      normalizedParticipants,
      data.courts,
      { mode: resolveAmericanoScheduleMode(data.tournamentType) },
    );
    let nextRounds = hydratedRounds;
    if (data.tournamentType === "mexicano" && !tournamentFinished) {
      const partiallySavedRound = hydratedRounds.find((round) => {
        const savedMatches = round.matches.reduce((sum, match) => sum + (isTournamentMatchSaved(match) ? 1 : 0), 0);
        return savedMatches > 0 && savedMatches < round.matches.length;
      });

      if (partiallySavedRound) {
        nextRounds = rebuildMexicanoClassicFutureRounds(
          normalizedParticipants,
          data.courts,
          hydratedRounds,
          partiallySavedRound.index,
          mexicanoOptions ?? undefined,
        );
      } else {
        const completedRounds = hydratedRounds.filter((round) => (
          round.matches.length > 0 && round.matches.every((match) => isTournamentMatchSaved(match))
        ));
        if (completedRounds.length > 0) {
          const lastCompletedRound = completedRounds[completedRounds.length - 1];
          nextRounds = rebuildMexicanoClassicFutureRounds(
            normalizedParticipants,
            data.courts,
            hydratedRounds,
            lastCompletedRound.index,
            mexicanoOptions ?? undefined,
          );
        } else {
          nextRounds = appendMexicanoClassicRoundIfReady(
            normalizedParticipants,
            data.courts,
            hydratedRounds,
            mexicanoOptions ?? undefined,
          );
        }
      }
    }
    setRounds(nextRounds);
    setActiveTab("tournament");
    setExpertMode(false);
    setServerTotals(initialTotals);
    setServerLogs(initialPlayerLogs);
    setMatchSaveErrors({});
    setFinishingTournament(false);
    setFinishConfirmationOpen(false);
    setFinishTournamentError(null);
    setResumingTournament(false);
    setResumeTournamentError(null);
    if (tournamentChanged) {
      const savedBroadcast = data.params && typeof data.params === "object"
        ? (data.params as Record<string, unknown>).broadcast
        : null;
      const savedBroadcastState = savedBroadcast && typeof savedBroadcast === "object"
        ? savedBroadcast as Record<string, unknown>
        : null;
      applyBroadcastServerState({
        tournamentId: data.tournamentId,
        stationId: String(savedBroadcastState?.stationId ?? "").trim() || null,
        active: savedBroadcastState?.active === true,
        activeTargets: normalizeTournamentBroadcastTargets(savedBroadcastState?.activeTargets),
        status: ["active", "inactive", "partial", "starting", "stopping"].includes(String(savedBroadcastState?.status))
          ? savedBroadcastState?.status as TournamentBroadcastStatus
          : null,
        partial: savedBroadcastState?.partial === true,
        message: String(savedBroadcastState?.message ?? "").trim() || null,
        operationInProgress: typeof savedBroadcastState?.operationInProgress === "boolean"
          ? savedBroadcastState.operationInProgress
          : undefined,
        operationLeaseUntil: String(savedBroadcastState?.operationLeaseUntil ?? "").trim() || null,
        recoveryRequired: savedBroadcastState?.recoveryRequired === true,
      });
      setBroadcastSelectedTarget(null);
      setBroadcastSelectionOpen(false);
      setBroadcastLoading(false);
      setBroadcastError(null);
    }
    draftHydratedSignatureRef.current = draftDataSignature;
  }, [applyBroadcastServerState, data, draftDataSignature, normalizedParticipants, initialTotals, initialPlayerLogs, mexicanoOptions, tournamentFinished]);

  useEffect(() => {
    if (!isOpen || !data?.tournamentId || !isOnline) return;

    let cancelled = false;
    const requestGeneration = broadcastRequestGenerationRef.current;
    const stationId = data.params && typeof data.params === "object"
      ? String((data.params as Record<string, unknown>).stationId ?? "").trim() || null
      : null;
    void apiFetchTournamentBroadcastState(data.tournamentId, stationId).then((result) => {
      if (
        cancelled
        || requestGeneration !== broadcastRequestGenerationRef.current
        || result.error
        || !result.data
      ) return;
      applyBroadcastServerState(result.data);
    });

    return () => {
      cancelled = true;
    };
  }, [applyBroadcastServerState, data?.params, data?.tournamentId, isOnline, isOpen]);

  useEffect(() => {
    if (!broadcastOperationInProgress || !broadcastOperationLeaseUntil) return;
    const leaseTs = Date.parse(broadcastOperationLeaseUntil);
    if (!Number.isFinite(leaseTs)) return;
    const markRecoverable = () => {
      setBroadcastOperationInProgress(false);
      setBroadcastRecoveryRequired(true);
      setBroadcastMessage(broadcastStatus === "stopping"
        ? "Остановка не подтверждена. Повторите остановку трансляции."
        : "Запуск не подтверждён. Остановите трансляцию, чтобы восстановить безопасное состояние.");
    };
    const delay = leaseTs - Date.now();
    if (delay <= 0) {
      markRecoverable();
      return;
    }
    const timeoutId = window.setTimeout(markRecoverable, delay + 50);
    return () => window.clearTimeout(timeoutId);
  }, [broadcastOperationInProgress, broadcastOperationLeaseUntil, broadcastStatus]);

  useEffect(() => {
    if (isOpen) return;
    setBroadcastSelectionOpen(false);
    setBroadcastSelectedTarget(null);
  }, [isOpen]);

  const draftSnapshot = useMemo<TournamentDraftSnapshot | null>(() => {
    if (!data || draftHydratedSignatureRef.current !== draftDataSignature) return null;
    return {
      payload: {
        ...data,
        rounds: serializeAmericanoRounds(rounds),
      },
      totals: serverTotals,
      playerLogs: serverLogs,
      updatedAt: new Date().toISOString(),
    };
  }, [data, draftDataSignature, rounds, serverLogs, serverTotals]);

  useEffect(() => {
    if (!draftSnapshot) return;
    saveCachedTournamentDraft(draftSnapshot);
  }, [draftSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateOnlineState = () => {
      setIsOnline(window.navigator.onLine);
    };
    updateOnlineState();
    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  const refreshPendingTournamentQueue = useCallback(async () => {
    if (!data?.tournamentId) {
      setPendingQueueRecords([]);
      return [];
    }

    const queue = await loadPendingTournamentResultQueue(data.tournamentId);
    setPendingQueueRecords(queue);
    return queue;
  }, [data?.tournamentId]);

  useEffect(() => {
    if (!data?.tournamentId) {
      setPendingQueueRecords([]);
      return;
    }

    void refreshPendingTournamentQueue();
  }, [data, refreshPendingTournamentQueue]);

  useEffect(() => {
    if (activeTab !== "tournament") return;
    const pendingMatch = pendingMatchNavigationRef.current;
    if (!pendingMatch) return;

    const matchKey = getTournamentMatchKey(pendingMatch.roundId, pendingMatch.matchId);
    const matchElement = matchElementRefs.current[matchKey];
    if (!matchElement || typeof window === "undefined") return;

    pendingMatchNavigationRef.current = null;

    window.requestAnimationFrame(() => {
      matchElement.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });

      const inputRefs = matchInputRefs.current[matchKey];
      const targetMatch = findTournamentMatch(rounds, pendingMatch.roundId, pendingMatch.matchId);
      const nextInput =
        targetMatch?.score1 == null
          ? inputRefs?.score1
          : targetMatch.score2 == null
            ? inputRefs?.score2
            : inputRefs?.score1 ?? inputRefs?.score2 ?? null;

      nextInput?.focus();
      nextInput?.select();
    });
  }, [activeTab, rounds]);

  const handleScoreChange = (
    roundId: string,
    matchId: string,
    field: "score1" | "score2",
    value: string,
  ) => {
    if (!data) return;
    const parsed = value === "" ? null : Math.max(0, Math.min(data.targetScore, Number.parseInt(value, 10) || 0));
    setRounds((prev) =>
      prev.map((round) => {
        if (round.id !== roundId) return round;
        const nextMatches = round.matches.map((match) => {
          if (match.id !== matchId) return match;
          if (parsed == null) {
            return { ...match, score1: null, score2: null, saved: false };
          }
          if (field === "score1") {
            return { ...match, score1: parsed, score2: data.targetScore - parsed, saved: false };
          }
          return { ...match, score2: parsed, score1: data.targetScore - parsed, saved: false };
        });
        return {
          ...round,
          saved: nextMatches.every((m) => m.saved),
          matches: nextMatches,
        };
      }),
    );
  };

  const handleMatchSave = async (roundId: string, matchId: string) => {
    if (!data) return;
    if (tournamentFinished) {
      setMatchSaveErrors((prev) => ({
        ...prev,
        [matchId]: "Турнир завершен. Изменение счетов недоступно.",
      }));
      return;
    }
    const round = rounds.find((r) => r.id === roundId);
    const persistedRoundBeforeSave = (data.rounds ?? []).find((item) => item.id === roundId);
    const wasRoundPersistedCompleteBeforeSave =
      Array.isArray(persistedRoundBeforeSave?.matches)
      && persistedRoundBeforeSave.matches.length > 0
      && persistedRoundBeforeSave.matches.every(
        (savedMatch) => savedMatch.score1 != null && savedMatch.score2 != null,
      );
    if (!round) return;
    const match = round.matches.find((m) => m.id === matchId);
    if (!match || match.score1 == null || match.score2 == null) {
      setMatchSaveErrors((prev) => ({
        ...prev,
        [matchId]: "Заполните результаты",
      }));
      return;
    }

    const results = data.tournamentType === "mexicano"
      ? buildClassicMexicanoMatchSaveResults(
          normalizedParticipants,
          data.courts,
          rounds,
          roundId,
          matchId,
          data.rounds,
          mexicanoOptions ?? undefined,
        )
      : [
          {
            roundId,
            matchId,
            score1: match.score1 as number,
            score2: match.score2 as number,
          },
        ];
    const generatedRoundIds = new Set(
      results
        .map((result) => result.roundId)
        .filter((resultRoundId) => resultRoundId !== roundId),
    );

    setSavingMatchId(matchId);
    setMatchSaveErrors((prev) => {
      const next = { ...prev };
      delete next[matchId];
      return next;
    });

    try {
      const submission = await submitTournamentResultsWithOfflineFallback(
        {
          tournamentId: data.tournamentId,
          results,
        },
        {
          tournamentId: data.tournamentId,
          source: "tournament_match_save",
        },
      );

      const applySavedRounds = (baseRounds: TournamentRound[]) => {
        const nextRounds = data.tournamentType === "mexicano" && !tournamentFinished
          ? (() => {
              const partiallySavedRound = baseRounds.find((round) => {
                const savedMatches = round.matches.reduce((sum, roundMatch) => sum + (isTournamentMatchSaved(roundMatch) ? 1 : 0), 0);
                return savedMatches > 0 && savedMatches < round.matches.length;
              });

              if (partiallySavedRound) {
                return rebuildMexicanoClassicFutureRounds(
                  normalizedParticipants,
                  data.courts,
                  baseRounds,
                  partiallySavedRound.index,
                  mexicanoOptions ?? undefined,
                );
              }

              const completedRounds = baseRounds.filter((round) => (
                round.matches.length > 0 && round.matches.every((roundMatch) => isTournamentMatchSaved(roundMatch))
              ));

              if (completedRounds.length > 0) {
                const lastCompletedRound = completedRounds[completedRounds.length - 1];
                return rebuildMexicanoClassicFutureRounds(
                  normalizedParticipants,
                  data.courts,
                  baseRounds,
                  lastCompletedRound.index,
                  mexicanoOptions ?? undefined,
                );
              }

              return appendMexicanoClassicRoundIfReady(
                normalizedParticipants,
                data.courts,
                baseRounds,
                mexicanoOptions ?? undefined,
              );
            })()
          : baseRounds;

        const persistedRound = nextRounds.find((item) => item.id === roundId) ?? null;
        const roundsAfterMexicanoRebuild =
          data.tournamentType === "mexicano" && !tournamentFinished && persistedRound
            ? rebuildMexicanoClassicFutureRounds(
                normalizedParticipants,
                data.courts,
                nextRounds,
                persistedRound.index,
                mexicanoOptions ?? undefined,
              )
            : nextRounds;
        const shouldAdvanceRound =
          !wasRoundPersistedCompleteBeforeSave && Boolean(persistedRound?.saved);
        const {
          rounds: nextRoundsWithCollapse,
          nextMatch,
        } = shouldAdvanceRound
          ? navigateTournamentAfterMatchSave(roundsAfterMexicanoRebuild, roundId, matchId)
          : {
              rounds: roundsAfterMexicanoRebuild,
              nextMatch: findNextIncompleteTournamentMatch(roundsAfterMexicanoRebuild, roundId, matchId),
            };
        const nextRoundsWithNavigation = nextMatch
          ? nextRoundsWithCollapse.map((round) => (
            round.id === nextMatch.roundId ? { ...round, collapsed: false } : round
          ))
          : nextRoundsWithCollapse;

        return {
          nextRoundsWithNavigation,
          nextMatch,
        };
      };

      if (submission.mode === "queued") {
        const localUpdatedRounds = applyLocalTournamentResultUpdates(rounds, results);
        const { nextRoundsWithNavigation, nextMatch } = applySavedRounds(localUpdatedRounds);
        const persistedMatch = findTournamentMatch(nextRoundsWithNavigation, roundId, matchId);
        const persisted =
          persistedMatch?.score1 === match.score1 && persistedMatch?.score2 === match.score2;

        if (!persisted) {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: "Не удалось сохранить результат локально",
          }));
          return;
        }

        pendingMatchNavigationRef.current = nextMatch;
        setRounds(nextRoundsWithNavigation);
        setServerTotals(null);
        setServerLogs(null);
        onDataChange?.(
          {
            ...data,
            rounds: serializeAmericanoRounds(nextRoundsWithNavigation),
          },
          {
            totals: null,
            playerLogs: null,
          },
        );
        await refreshPendingTournamentQueue();
        return;
      }

      const res = submission.response;
      if (res?.data) {
        if (!Array.isArray(res.data.rounds)) {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: "Сервер не подтвердил сохранение результата",
          }));
          return;
        }

        const hydratedServerRounds = hydrateAmericanoRounds(
          res.data.rounds,
          normalizedParticipants,
          data.courts,
          { mode: resolveAmericanoScheduleMode(data.tournamentType) },
        );
        const generatedRoundsPersisted = Array.from(generatedRoundIds).every(
          (generatedRoundId) => hydratedServerRounds.some((serverRound) => (
            serverRound.id === generatedRoundId
            && serverRound.matches.length > 0
            && serverRound.matches.every((serverMatch) => (
              serverMatch.pair1.length === 2 && serverMatch.pair2.length === 2
            ))
          )),
        );
        if (!generatedRoundsPersisted) {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: "Сервер сохранил результат, но не подтвердил следующий раунд. Повторите сохранение.",
          }));
          return;
        }

        const nextRounds = applyPartialRoundUpdates(
          rounds,
          hydratedServerRounds,
        );
        const nextRoundsWithMexicano = data.tournamentType === "mexicano" && !tournamentFinished
          ? appendMexicanoClassicRoundIfReady(
              normalizedParticipants,
              data.courts,
              nextRounds,
              mexicanoOptions ?? undefined,
            )
          : nextRounds;
        const persistedRound = nextRoundsWithMexicano.find((item) => item.id === roundId) ?? null;
        const roundsAfterMexicanoRebuild =
          data.tournamentType === "mexicano" && !tournamentFinished && persistedRound
            ? rebuildMexicanoClassicFutureRounds(
                normalizedParticipants,
                data.courts,
                nextRoundsWithMexicano,
                persistedRound.index,
                mexicanoOptions ?? undefined,
              )
            : nextRoundsWithMexicano;
        const shouldAdvanceRound =
          !wasRoundPersistedCompleteBeforeSave && Boolean(persistedRound?.saved);
        const {
          rounds: nextRoundsWithCollapse,
          nextMatch,
        } = shouldAdvanceRound
          ? navigateTournamentAfterMatchSave(roundsAfterMexicanoRebuild, roundId, matchId)
          : {
              rounds: roundsAfterMexicanoRebuild,
              nextMatch: findNextIncompleteTournamentMatch(roundsAfterMexicanoRebuild, roundId, matchId),
            };
        const nextRoundsWithNavigation = nextMatch
          ? nextRoundsWithCollapse.map((round) => (
            round.id === nextMatch.roundId ? { ...round, collapsed: false } : round
          ))
          : nextRoundsWithCollapse;
        const persistedMatch = findTournamentMatch(nextRoundsWithNavigation, roundId, matchId);
        const persisted =
          persistedMatch?.score1 === match.score1 && persistedMatch?.score2 === match.score2;

        if (!persisted) {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: "Результат не сохранился на сервере",
          }));
          return;
        }

        pendingMatchNavigationRef.current = nextMatch;
        setRounds(nextRoundsWithNavigation);
        const nextTotals = res.data.totals ?? serverTotals ?? null;
        const nextPlayerLogs = res.data.playerLogs ?? serverLogs ?? null;
        const nextParams =
          res.data.params && typeof res.data.params === "object"
            ? res.data.params
            : data.params;
        if (res.data.totals) setServerTotals(res.data.totals);
        if (res.data.playerLogs) setServerLogs(res.data.playerLogs);
        onDataChange?.(
          {
            ...data,
            params: nextParams,
            rounds: serializeAmericanoRounds(nextRoundsWithNavigation),
          },
          {
            totals: nextTotals,
            playerLogs: nextPlayerLogs,
          },
        );
        await refreshPendingTournamentQueue();
        return;
      }

      setMatchSaveErrors((prev) => ({
        ...prev,
        [matchId]: res?.error?.message || "Не удалось сохранить результаты",
      }));
    } catch {
      setMatchSaveErrors((prev) => ({
        ...prev,
        [matchId]: "Не удалось сохранить результаты",
      }));
    } finally {
      setSavingMatchId(null);
    }
  };

  const handleFinishTournament = async () => {
    if (!data || finishingTournament || tournamentFinished || !canFinishTournament) return;

    setFinishingTournament(true);
    setFinishTournamentError(null);

    const finishedAt = new Date().toISOString();
    const currentParams = data.params && typeof data.params === "object" ? data.params as Record<string, unknown> : {};
    const isLocalManualTournament =
      currentParams.manualTournament === true
      || currentParams.createdOffline === true
      || String(currentParams.localStatus ?? "").trim() === "draft";
    const finishParams: Record<string, unknown> = {
      ...currentParams,
      status: "completed",
      finished: true,
      manualFinish: true,
      finishedAt,
      completedAt: finishedAt,
      ...(isLocalManualTournament
        ? {
            localStatus: "conducted_local",
            syncStatus: String(currentParams.syncStatus ?? "").trim() === "synced_viva"
              ? "synced_viva"
              : "pending_viva",
          }
        : {}),
    };

    try {
      const submission = await submitTournamentResultsWithOfflineFallback({
        tournamentId: data.tournamentId,
        results: [],
        params: finishParams,
      }, {
        tournamentId: data.tournamentId,
        source: "tournament_finish",
      });

      const res = submission.response;

      if (submission.mode === "queued") {
        setRounds(rounds);
        setServerTotals(null);
        setServerLogs(null);
        onDataChange?.(
          {
            ...data,
            params: finishParams,
            rounds: serializeAmericanoRounds(rounds),
          },
          {
            totals: null,
            playerLogs: null,
          },
        );
        await refreshPendingTournamentQueue();
        setFinishConfirmationOpen(false);
        onClose();
        return;
      }

      if (!res?.data) {
        setFinishTournamentError(res?.error?.message || "Не удалось завершить турнир");
        return;
      }

      const nextTotals = res.data.totals ?? serverTotals ?? null;
      const nextPlayerLogs = res.data.playerLogs ?? serverLogs ?? null;
      const nextParams: Record<string, unknown> = {
        ...(res.data.params && typeof res.data.params === "object" ? res.data.params : {}),
        ...finishParams,
      };
      const nextRounds = Array.isArray(res.data.rounds)
        ? hydrateAmericanoRounds(
            res.data.rounds,
            normalizedParticipants,
            data.courts,
            { mode: resolveAmericanoScheduleMode(data.tournamentType) },
          )
        : rounds;

      setRounds(nextRounds);
      if (res.data.totals) setServerTotals(res.data.totals);
      if (res.data.playerLogs) setServerLogs(res.data.playerLogs);

      onDataChange?.(
        {
          ...data,
          params: nextParams,
          rounds: serializeAmericanoRounds(nextRounds),
        },
        {
          totals: nextTotals,
          playerLogs: nextPlayerLogs,
        },
      );

      setFinishConfirmationOpen(false);
      onClose();
    } catch {
      setFinishTournamentError("Не удалось завершить турнир");
    } finally {
      setFinishingTournament(false);
    }
  };

  const handleResumeTournament = async () => {
    if (!data || resumingTournament || !canResumeTournament) return;

    setResumingTournament(true);
    setResumeTournamentError(null);
    setFinishTournamentError(null);

    const resumeParams = buildTournamentResumeParams(data.params);

    try {
      const submission = await submitTournamentResultsWithOfflineFallback(
        {
          tournamentId: data.tournamentId,
          results: [],
          params: resumeParams,
        },
        {
          tournamentId: data.tournamentId,
          source: "tournament_resume",
        },
      );

      if (submission.mode === "queued") {
        onDataChange?.(
          {
            ...data,
            params: resumeParams,
            rounds: serializeAmericanoRounds(rounds),
          },
          {
            totals: serverTotals,
            playerLogs: serverLogs,
          },
        );
        await refreshPendingTournamentQueue();
        return;
      }

      const res = submission.response;
      if (!res?.data) {
        setResumeTournamentError(res?.error?.message || "Не удалось возобновить турнир");
        return;
      }

      const nextTotals = res.data.totals ?? serverTotals ?? null;
      const nextPlayerLogs = res.data.playerLogs ?? serverLogs ?? null;
      const nextParams = res.data.params && typeof res.data.params === "object"
        ? res.data.params as Record<string, unknown>
        : resumeParams;
      const nextRounds = Array.isArray(res.data.rounds)
        ? hydrateAmericanoRounds(
            res.data.rounds,
            normalizedParticipants,
            data.courts,
            { mode: resolveAmericanoScheduleMode(data.tournamentType) },
          )
        : rounds;

      setRounds(nextRounds);
      if (res.data.totals) setServerTotals(res.data.totals);
      if (res.data.playerLogs) setServerLogs(res.data.playerLogs);

      onDataChange?.(
        {
          ...data,
          params: nextParams,
          rounds: serializeAmericanoRounds(nextRounds),
        },
        {
          totals: nextTotals,
          playerLogs: nextPlayerLogs,
        },
      );
    } catch {
      setResumeTournamentError("Не удалось возобновить турнир");
    } finally {
      setResumingTournament(false);
    }
  };

  const handleSyncTournamentWithViva = async () => {
    if (
      !data
      || syncingWithViva
      || !canSyncWithViva
      || !isLocalConductedTournament
    ) {
      return;
    }

    setSyncingWithViva(true);
    setSyncWithVivaError(null);
    setSyncWithVivaSuccess(null);

    try {
      const normalizePhoneDigits = (value: string | null | undefined) => String(value ?? "").replace(/\D/g, "");
      const isSyntheticParticipantId = (value: string) => (
        value.startsWith("manual-participant-")
        || value.startsWith("manual-tournament-")
        || value.startsWith("participant-")
      );

      const resolvedParticipants: Array<{
        originalId: string;
        clientId: string;
        phone: string | null;
        name: string;
        photo: string | null;
        rating: string | null;
      }> = [];

      for (const participant of normalizedParticipants) {
        const originalId = String(participant.id || "").trim();
        const trimmedPhone = String(participant.phone || "").trim();
        const participantPhoneDigits = normalizePhoneDigits(trimmedPhone);

        if (originalId && !isSyntheticParticipantId(originalId)) {
          resolvedParticipants.push({
            originalId,
            clientId: originalId,
            phone: trimmedPhone || null,
            name: participant.name,
            photo: participant.photo ?? null,
            rating: participant.rating ?? null,
          });
          continue;
        }

        if (!participantPhoneDigits) {
          throw new Error(`У игрока "${participant.name}" не указан телефон для синхронизации`);
        }

        const lookupQueries = Array.from(new Set([
          trimmedPhone,
          participantPhoneDigits,
        ].filter((value): value is string => Boolean(value))));

        let resolvedCandidate: PadelPlayerCandidate | null = null;
        for (const query of lookupQueries) {
          const searchResult = await apiSearchPadelPlayers(query, 8);
          if (searchResult.error) {
            continue;
          }
          resolvedCandidate = (searchResult.data ?? []).find((candidate) => {
            const candidateDigits = normalizePhoneDigits(candidate.phone);
            return candidateDigits === participantPhoneDigits;
          }) ?? (searchResult.data?.[0] ?? null);
          if (resolvedCandidate?.id) break;
        }

        if (!resolvedCandidate?.id) {
          throw new Error(`Не удалось найти игрока "${participant.name}" в Viva по телефону ${trimmedPhone}`);
        }

        resolvedParticipants.push({
          originalId,
          clientId: resolvedCandidate.id,
          phone: resolvedCandidate.phone ?? (trimmedPhone || null),
          name: resolvedCandidate.name || participant.name,
          photo: resolvedCandidate.photo ?? participant.photo ?? null,
          rating: resolvedCandidate.rating ?? participant.rating ?? null,
        });
      }

      const participantMap = new Map(resolvedParticipants.map((participant) => [participant.originalId, participant]));
      const remappedRounds = rounds.map((round) => ({
        ...round,
        byes: round.byes.map((player) => {
          const resolved = participantMap.get(player.id);
          if (!resolved) return player;
          return {
            ...player,
            id: resolved.clientId,
            phone: resolved.phone ?? player.phone ?? null,
            rating: resolved.rating ?? player.rating ?? null,
            photo: resolved.photo ?? player.photo ?? null,
            name: resolved.name || player.name,
          };
        }),
        matches: round.matches.map((match) => ({
          ...match,
          pair1: match.pair1.map((player) => {
            const resolved = participantMap.get(player.id);
            if (!resolved) return player;
            return {
              ...player,
              id: resolved.clientId,
              phone: resolved.phone ?? player.phone ?? null,
              rating: resolved.rating ?? player.rating ?? null,
              photo: resolved.photo ?? player.photo ?? null,
              name: resolved.name || player.name,
            };
          }),
          pair2: match.pair2.map((player) => {
            const resolved = participantMap.get(player.id);
            if (!resolved) return player;
            return {
              ...player,
              id: resolved.clientId,
              phone: resolved.phone ?? player.phone ?? null,
              rating: resolved.rating ?? player.rating ?? null,
              photo: resolved.photo ?? player.photo ?? null,
              name: resolved.name || player.name,
            };
          }),
        })),
      }));

      const nowIso = new Date().toISOString();
      const { createdOffline: _createdOffline, ...paramsWithoutCreatedOffline } = tournamentParams;
      const syncedParams: Record<string, unknown> = {
        ...paramsWithoutCreatedOffline,
        manualTournament: true,
        localStatus: "conducted_local",
        syncStatus: "synced_viva",
        syncedAt: nowIso,
        syncedToVivaAt: nowIso,
        status: "completed",
        finished: true,
        manualFinish: true,
        finishedAt: String(tournamentParams.finishedAt ?? nowIso),
        completedAt: String(tournamentParams.completedAt ?? nowIso),
      };
      const syncedPayload: AmericanoTournamentPayload = {
        ...data,
        organizer: {
          ...data.organizer,
          phone: data.organizer.phone ?? null,
        },
        participants: resolvedParticipants.map((participant) => ({
          id: participant.clientId,
          phone: participant.phone ?? null,
          rating: participant.rating ?? null,
          photo: participant.photo ?? null,
          name: participant.name,
        })),
        rounds: serializeAmericanoRounds(remappedRounds),
        params: syncedParams,
      };

      const createResponse = await apiCreateAmericanoTournament(syncedPayload);
      if (createResponse.error || createResponse.status == null || createResponse.status >= 400) {
        throw new Error(createResponse.error?.message || "Не удалось сохранить турнир в Viva");
      }

      const resultsPayload: AmericanoResultsPayload = {
        tournamentId: data.tournamentId,
        results: remappedRounds.flatMap((round) => (
          round.matches
            .filter((match) => match.score1 != null && match.score2 != null)
            .map((match) => ({
              roundId: round.id,
              matchId: match.id,
              score1: match.score1,
              score2: match.score2,
              court: match.court,
              courtIndex: match.courtIndex,
              pair1: match.pair1.map((player) => player.id),
              pair2: match.pair2.map((player) => player.id),
            }))
        )),
        params: syncedParams,
      };

      const resultsResponse = await apiUpdateAmericanoResults(resultsPayload);
      if (resultsResponse.error || !resultsResponse.data) {
        throw new Error(resultsResponse.error?.message || "Не удалось сохранить результаты турнира в Viva");
      }

      const nextTotals = resultsResponse.data.totals ?? null;
      const nextPlayerLogs = resultsResponse.data.playerLogs ?? null;
      const participantsById = new Map(resolvedParticipants.map((participant) => [participant.clientId, participant]));

      for (const [clientId, total] of Object.entries(nextTotals ?? {})) {
        const participant = participantsById.get(clientId);
        const nextRating = typeof total.ratingAfter === "number" && Number.isFinite(total.ratingAfter)
          ? total.ratingAfter
          : null;
        if (!participant || nextRating == null) continue;

        const levelSaveResponse = await apiSaveOnboardingLevel({
          clientId,
          phone: participant.phone,
          levelLetter: getLetterGrade(nextRating),
          levelNumeric: nextRating,
          source: "tournaments",
          gameId: data.tournamentId,
          playerName: participant.name,
          previousRating: typeof total.ratingBefore === "number" ? total.ratingBefore : null,
          nextRating,
          confirmedAt: nowIso,
          changedById: String(tournamentParams.organizerId ?? data.organizer.id ?? "").trim() || null,
          changedByName: String(tournamentParams.organizerName ?? "").trim() || null,
          changedByPhone: data.organizer.phone ?? null,
          eventId: data.tournamentId,
        });

        if (levelSaveResponse.error) {
          throw new Error(levelSaveResponse.error.message || `Не удалось обновить уровень игрока ${participant.name}`);
        }
      }

      await clearPendingTournamentResultQueueByTournamentId(data.tournamentId);
      const syncedFinalPayload: AmericanoTournamentPayload = {
        ...syncedPayload,
        params: {
          ...syncedPayload.params,
          syncStatus: "synced_viva",
          syncedAt: nowIso,
          syncedToVivaAt: nowIso,
          localStatus: "conducted_local",
        },
      };

      setRounds(remappedRounds);
      setServerTotals(nextTotals);
      setServerLogs(nextPlayerLogs);
      setSyncWithVivaSuccess("Турнир синхронизирован с Viva");
      onReplaceData?.(syncedFinalPayload, {
        totals: nextTotals,
        playerLogs: nextPlayerLogs,
      });
    } catch (error) {
      setSyncWithVivaError(error instanceof Error ? error.message : "Не удалось синхронизировать турнир с Viva");
    } finally {
      setSyncingWithViva(false);
    }
  };

  const tournamentStandingsSortMode = useMemo(
    () => {
      if (data?.tournamentType === "mexicano") {
        const tableSortMode = mexicanoOptions?.tableSortMode ?? "point_diff";
        const winnerSortMode = mexicanoOptions?.winnerSortMode ?? tableSortMode;
        return tournamentFinished ? winnerSortMode : tableSortMode;
      }

      if (
        data?.tournamentType === "americano_padelhub"
        || data?.tournamentType === "americano_classic"
        || data?.tournamentType === "americano_flex"
        || data?.tournamentType === "paired_americano"
      ) {
        const params = data?.params && typeof data.params === "object"
          ? data.params as Record<string, unknown>
          : null;
        return parseAmericanoStandingsSortMode(params, DEFAULT_AMERICANO_STANDINGS_SORT_MODE);
      }

      return "point_diff" as const;
    },
    [
      data?.params,
      data?.tournamentType,
      mexicanoOptions?.tableSortMode,
      mexicanoOptions?.winnerSortMode,
      tournamentFinished,
    ],
  );
  const pairedAmericanoPairAssignments = useMemo(() => {
    if (data?.tournamentType !== "paired_americano") return null;
    const params = data?.params && typeof data.params === "object"
      ? data.params as Record<string, unknown>
      : null;
    const rawAssignments = params?.pairAssignments;
    if (!Array.isArray(rawAssignments)) return null;

    const normalized = rawAssignments
      .map((pair) => {
        if (!Array.isArray(pair)) return null;
        const leftId = String(pair[0] ?? "").trim();
        const rightId = String(pair[1] ?? "").trim();
        if (!leftId || !rightId || leftId === rightId) return null;
        return [leftId, rightId] as PairedMexicanoPairAssignment;
      })
      .filter((pair): pair is PairedMexicanoPairAssignment => Boolean(pair));

    return normalized.length > 0 ? normalized : null;
  }, [data?.params, data?.tournamentType]);

  const standingsSnapshot = useMemo(
    () => buildAmericanoStandings(
      normalizedParticipants,
      rounds,
      serverTotals,
      {
        byePolicyMode: data?.tournamentType === "mexicano" ? "zero_points" : "round_average_points",
        sortMode: tournamentStandingsSortMode,
        rankByPairs: data?.tournamentType === "paired_americano",
        pairAssignments: pairedAmericanoPairAssignments,
      },
    ),
    [
      data?.tournamentType,
      tournamentStandingsSortMode,
      normalizedParticipants,
      pairedAmericanoPairAssignments,
      rounds,
      serverTotals,
    ],
  );

  const tableRows = standingsSnapshot.rows;
  const roundByePoints = standingsSnapshot.roundByePoints;
  const statsRows = standingsSnapshot.rows;
  const pairedTableGroups = useMemo(
    () => data?.tournamentType === "paired_americano"
      ? buildPairedTournamentStandingsGroups(tableRows, pairedAmericanoPairAssignments)
      : [],
    [data?.tournamentType, pairedAmericanoPairAssignments, tableRows],
  );
  const participantRatingById = useMemo(
    () => new Map(normalizedParticipants.map((participant) => [
      participant.id,
      parseTournamentRatingValue(participant.rating),
    ])),
    [normalizedParticipants],
  );
  const queuedMatchState = useMemo(
    () => buildTournamentQueuedMatchState(pendingQueueRecords),
    [pendingQueueRecords],
  );
  const canEditSettings = useMemo(
    () => rounds.every((round) => round.matches.every((match) => !match.saved)),
    [rounds],
  );
  const hasPartiallyCompletedRound = useMemo(
    () => rounds.some((round) => {
      const savedMatches = round.matches.reduce((sum, match) => sum + (isTournamentMatchSaved(match) ? 1 : 0), 0);
      return savedMatches > 0 && savedMatches < round.matches.length;
    }),
    [rounds],
  );
  const canFinishTournament = useMemo(() => {
    if (tournamentFinished) return false;
    if (standingsSnapshot.totalMatches <= 0) return false;
    return true;
  }, [
    standingsSnapshot.totalMatches,
    tournamentFinished,
  ]);
  const tournamentParams = useMemo(() => (
    data?.params && typeof data.params === "object"
      ? data.params as Record<string, unknown>
      : {}
  ), [data?.params]);
  const broadcastStationId = resolveTournamentBroadcastStationId(
    broadcastServerStationId,
    tournamentParams.stationId,
    broadcastActive
      || broadcastStatus === "starting"
      || broadcastStatus === "stopping"
      || broadcastRecoveryRequired,
  );
  const isManualTournament = tournamentParams.manualTournament === true;
  const isSyncedWithViva = String(tournamentParams.syncStatus ?? "").trim().toLowerCase() === "synced_viva";
  const isLocalConductedTournament =
    isManualTournament
    && (
      String(tournamentParams.localStatus ?? "").trim().toLowerCase() === "conducted_local"
      || tournamentFinished
    );
  const canSyncWithViva =
    isManualTournament
    && isLocalConductedTournament
    && !isSyncedWithViva
    && !syncingWithViva
    && isOnline;
  const canResumeTournament =
    tournamentFinished
    && isTournamentManuallyFinished(tournamentParams, null)
    && !isSyncedWithViva
    && !resumingTournament
    && isOnline;
  const finishConfirmationCopy = useMemo(
    () => buildTournamentFinishConfirmationCopy({
      completedMatches: standingsSnapshot.completedMatches,
      totalMatches: standingsSnapshot.totalMatches,
      hasPartiallyCompletedRound,
    }),
    [
      hasPartiallyCompletedRound,
      standingsSnapshot.completedMatches,
      standingsSnapshot.totalMatches,
    ],
  );
  const finishTournamentNote = useMemo(() => {
    if (tournamentFinished) {
      return canResumeTournament
        ? "Турнир завершен вручную. Возобновление сохранит сетку и уже введенные результаты."
        : "Турнир завершен вручную.";
    }
    if (canFinishTournament) {
      if (hasPartiallyCompletedRound) {
        return "Можно завершить сейчас: частично заполненные матчи не попадут в итоговый счет.";
      }
      if (standingsSnapshot.completedMatches < standingsSnapshot.totalMatches) {
        return "Можно завершить сейчас: незаполненные матчи останутся без результата.";
      }
      return null;
    }
    if (data?.tournamentType !== "mexicano") {
      return "Кнопка станет активной после формирования сетки турнира.";
    }
    return "Кнопка станет активной после формирования сетки турнира.";
  }, [
    canFinishTournament,
    canResumeTournament,
    data?.tournamentType,
    hasPartiallyCompletedRound,
    standingsSnapshot.completedMatches,
    standingsSnapshot.totalMatches,
    tournamentFinished,
  ]);

  const splitName = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return { line1: name, line2: "" };
    }
    return { line1: parts[0], line2: parts.slice(1).join(" ") };
  };

  const renderTournamentTablePlayer = (
    row: typeof tableRows[number],
    options?: { compact?: boolean; showRank?: boolean },
  ) => {
    const compact = options?.compact === true;
    const showRank = options?.showRank !== false;
    const playerRating =
      row.ratingAfter
      ?? participantRatingById.get(row.id)
      ?? row.ratingBefore
      ?? null;
    const playerBadgeStyle = getTournamentRatingBadgeStyle(playerRating);
    const playerRingProgressDeg = `${Math.round(getTournamentRatingRingProgress(playerRating) * 360)}deg`;
    const name = splitName(row.name);

    return (
      <div className={`tournament-table-player${compact ? " tournament-table-player-compact" : ""}`}>
        <div className="tournament-table-avatar-wrap">
          {showRank && <span className="tournament-table-rank">{row.rank}</span>}
          <div
            className={`tournament-table-player-ring${playerRating != null ? " has-level" : ""}`}
            style={{ "--player-ring-progress": playerRingProgressDeg } as CSSProperties}
          >
            <div className={`tournament-participant-avatar ${row.photo ? "" : "no-photo"}`}>
              {row.photo ? (
                <img
                  src={row.photo}
                  alt={row.name}
                  crossOrigin="anonymous"
                  onError={(e) => {
                    const target = e.currentTarget;
                    target.style.display = "none";
                    const parent = target.parentElement;
                    if (parent) parent.classList.add("no-photo");
                  }}
                />
              ) : null}
              <span className="tournament-participant-initials">
                {getInitialsFromName(row.name)}
              </span>
            </div>
          </div>
          {playerRating != null && (
            <span className="tournament-table-level" style={playerBadgeStyle}>
              {formatStatsRatingBadge(playerRating)}
            </span>
          )}
        </div>
        <div className="tournament-table-name">
          <span className="tournament-table-name-line">{name.line1}</span>
          {name.line2 && (
            <span className="tournament-table-name-line secondary">{name.line2}</span>
          )}
        </div>
      </div>
    );
  };

  const historyRows = useMemo(() => {
    if (!serverLogs) return [];
    const rows: Array<{
      playerId: string;
      playerName: string;
      roundId?: string;
      matchId?: string;
      scoreFor?: number;
      scoreAgainst?: number;
      delta?: number;
      ratingBefore?: number;
      ratingAfter?: number;
      expected?: number;
      actual?: number;
    }> = [];
    Object.entries(serverLogs).forEach(([playerId, logs]) => {
      const player = normalizedParticipants.find((p) => p.id === playerId);
      const playerName = player?.name ?? playerId;
      const logList = Array.isArray(logs) ? logs : [];
      logList.forEach((log) => {
        rows.push({
          playerId,
          playerName,
          roundId: log.roundId,
          matchId: log.matchId,
          scoreFor: toNumberSafe(log.scoreFor),
          scoreAgainst: toNumberSafe(log.scoreAgainst),
          delta: toNumberSafe(log.delta),
          ratingBefore: toNumberSafe(log.ratingBefore),
          ratingAfter: toNumberSafe(log.ratingAfter),
          expected: toNumberSafe(log.expected),
          actual: toNumberSafe(log.actual),
        });
      });
    });
    return rows;
  }, [serverLogs, normalizedParticipants]);

  const handleExportHistory = (format: "csv" | "xlsx") => {
    if (!data?.tournamentId) return;
    const base = getServ2Origin();
    const url = `${base}/lk/tournaments/americano/history/export?tournamentId=${encodeURIComponent(
      data.tournamentId,
    )}&format=${format}`;
    window.open(url, "_blank");
  };

  const handleSetTournamentBroadcast = async (
    action: "start" | "stop",
    target?: TournamentBroadcastTarget,
  ) => {
    if (!data?.tournamentId || broadcastLoading || !isOnline) return;

    const stationId = broadcastStationId || null;
    const requestGeneration = broadcastRequestGenerationRef.current + 1;
    broadcastRequestGenerationRef.current = requestGeneration;
    setBroadcastLoading(true);
    setBroadcastError(null);

    try {
      const result = action === "start"
        ? await apiSetTournamentBroadcastState({
          tournamentId: data.tournamentId,
          stationId,
          action,
          ...(target ? { target } : {}),
        })
        : await apiSetTournamentBroadcastState({
          tournamentId: data.tournamentId,
          stationId,
          action,
        });
      if (requestGeneration !== broadcastRequestGenerationRef.current) return;
      if (result.error || !result.data) {
        const stateResult = await apiFetchTournamentBroadcastState(data.tournamentId, stationId);
        if (requestGeneration !== broadcastRequestGenerationRef.current) return;
        if (!stateResult.error && stateResult.data) {
          applyBroadcastServerState(stateResult.data);
          if (stateResult.data.active === true) setBroadcastSelectionOpen(false);
        }
        setBroadcastError(result.error?.message || "Не удалось переключить трансляцию результатов");
        return;
      }

      const active = result.data.active === true;
      const activeTargets = normalizeTournamentBroadcastTargets(result.data.activeTargets);
      const requestedTarget = isTournamentBroadcastTarget(result.data.requestedTarget)
        ? result.data.requestedTarget
        : action === "start" && target
          ? target
          : null;
      const selectionRequired = result.data.selectionRequired === true;
      const partial = result.data.partial === true;
      const message = String(result.data.message ?? "").trim()
        || (partial ? "Трансляция запущена не на всех выбранных экранах." : null);
      const updatedAt = result.data.updatedAt ?? new Date().toISOString();
      applyBroadcastServerState({
        ...result.data,
        active,
        activeTargets,
        partial,
        message,
      });
      if (action === "start") setBroadcastSelectionOpen(false);
      onDataChange?.(
        {
          ...data,
          params: {
            ...tournamentParams,
            broadcast: {
              active,
              stationId: result.data.stationId ?? stationId,
              activeTargets,
              requestedTarget,
              selectionRequired,
              status: result.data.status ?? null,
              partial,
              message,
              operationInProgress: result.data.operationInProgress === true,
              operationLeaseUntil: result.data.operationLeaseUntil ?? null,
              recoveryRequired: result.data.recoveryRequired === true,
              updatedAt,
            },
          },
        },
        {
          totals: serverTotals,
          playerLogs: serverLogs,
        },
      );
    } catch {
      const stateResult = await apiFetchTournamentBroadcastState(data.tournamentId, stationId);
      if (
        requestGeneration === broadcastRequestGenerationRef.current
        && !stateResult.error
        && stateResult.data
      ) {
        applyBroadcastServerState(stateResult.data);
        if (stateResult.data.active === true) setBroadcastSelectionOpen(false);
      }
      if (requestGeneration === broadcastRequestGenerationRef.current) {
        setBroadcastError("Не удалось переключить трансляцию результатов");
      }
    } finally {
      if (requestGeneration === broadcastRequestGenerationRef.current) {
        setBroadcastLoading(false);
      }
    }
  };

  const handleToggleTournamentBroadcast = async () => {
    if (!data?.tournamentId || broadcastLoading || broadcastOperationInProgress || !isOnline) return;

    if (broadcastActive) {
      await handleSetTournamentBroadcast("stop");
      return;
    }

    if (isTournamentBroadcastTargetSelectionStation(broadcastStationId)) {
      setBroadcastSelectedTarget(null);
      setBroadcastError(null);
      setBroadcastSelectionOpen(true);
      return;
    }

    await handleSetTournamentBroadcast("start");
  };

  const handleTournamentManagerClose = () => {
    if (broadcastSelectionOpen) {
      if (!broadcastLoading) {
        setBroadcastSelectionOpen(false);
        setBroadcastSelectedTarget(null);
      }
      return;
    }
    onClose();
  };

  const buildTournamentJsonPayload = (): AmericanoTournamentPayload | null => {
    if (!data) return null;
    return {
      ...data,
      rounds: serializeAmericanoRounds(rounds),
    };
  };

  const handleDownloadTournamentJson = () => {
    const payload = buildTournamentJsonPayload();
    if (!payload) {
      setJsonError("Не удалось подготовить JSON турнира");
      return;
    }

    try {
      const json = serializeTournamentJson(payload);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = getTournamentJsonFileName(payload);
      link.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
      setJsonError(null);
    } catch (error) {
      console.error(error);
      setJsonError("Не удалось скачать JSON турнира");
    }
  };

  const handleTournamentJsonFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;

    setJsonError(null);

    try {
      const parsed = parseTournamentJson(await file.text());
      if (!parsed) {
        setJsonError("JSON не похож на турнирный экспорт");
        return;
      }

      const importedParticipants: ParticipantEntry[] = parsed.participants.map((participant, index) => ({
        id: participant.id ?? `participant-${index}`,
        name: participant.name || `Участник ${index + 1}`,
        photo: participant.photo ?? null,
        phone: participant.phone ?? null,
        rating: participant.rating ?? null,
      }));
      const importedRounds = hydrateAmericanoRounds(
        parsed.rounds ?? [],
        importedParticipants,
        parsed.courts,
        { mode: resolveAmericanoScheduleMode(parsed.tournamentType) },
      );
      const nextPayload: AmericanoTournamentPayload = {
        ...parsed,
        rounds: serializeAmericanoRounds(importedRounds),
      };

      setRounds(importedRounds);
      setServerTotals(null);
      setServerLogs(null);
      setMatchSaveErrors({});
      setFinishTournamentError(null);
      setActiveTab("tournament");
      setExpertMode(false);
      onReplaceData?.(nextPayload, {
        totals: null,
        playerLogs: null,
      });
    } catch (error) {
      console.error(error);
      setJsonError("Не удалось загрузить JSON турнира");
    }
  };

  const handleSendQueuedTournamentResult = async (jobId: string) => {
    if (!data?.tournamentId || !jobId || sendingQueuedJobId) return;
    const queueRecord = pendingQueueRecords.find((record) => record.jobId === jobId) ?? null;
    const affectedMatchIds = new Set(
      (queueRecord?.payload.results ?? [])
        .map((result) => String(result.matchId || "").trim())
        .filter(Boolean),
    );

    if (affectedMatchIds.size > 0) {
      setMatchSaveErrors((prev) => {
        const next = { ...prev };
        affectedMatchIds.forEach((matchId) => {
          delete next[matchId];
        });
        return next;
      });
    }

    setSendingQueuedJobId(jobId);
    setJsonError(null);

    try {
      const result = await flushPendingTournamentResultSyncJob(jobId);
      if (result.failed.length > 0) {
        const message = result.failed[0]?.error || "Не удалось отправить результаты на сервер";
        setMatchSaveErrors((prev) => {
          const next = { ...prev };
          affectedMatchIds.forEach((matchId) => {
            next[matchId] = message;
          });
          return next;
        });
      }

      if (result.resolved.length > 0) {
        const cachedHistory = await loadCachedTournamentHistory(data.tournamentId);
        if (cachedHistory) {
          const restoredPayload = buildTournamentPayloadFromHistory(cachedHistory);
          if (restoredPayload) {
            const nextRounds = hydrateAmericanoRounds(
              restoredPayload.rounds ?? [],
              normalizedParticipants,
              data.courts,
              { mode: resolveAmericanoScheduleMode(data.tournamentType) },
            );
            setRounds(nextRounds);
            setServerTotals(cachedHistory.totals ?? null);
            setServerLogs(cachedHistory.playerLogs ?? null);
            onDataChange?.(
              {
                ...restoredPayload,
                rounds: serializeAmericanoRounds(nextRounds),
              },
              {
                totals: cachedHistory.totals ?? null,
                playerLogs: cachedHistory.playerLogs ?? null,
              },
            );
          }
        }

        setMatchSaveErrors((prev) => {
          const next = { ...prev };
          affectedMatchIds.forEach((matchId) => {
            delete next[matchId];
          });
          return next;
        });
      }
    } catch (error) {
      console.error(error);
      setJsonError("Не удалось отправить локально сохранённый результат");
    } finally {
      await refreshPendingTournamentQueue();
      setSendingQueuedJobId(null);
    }
  };

  const handleExportStats = async (format: "png" | "jpeg") => {
    if (!statsRef.current || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { toPng, toJpeg } = await loadHtmlToImage();
      const node = statsRef.current;
      const commonOptions = {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#fff",
        skipFonts: true,
      };
      const dataUrl =
        format === "png"
          ? await toPng(node, commonOptions)
          : await toJpeg(node, { ...commonOptions, quality: 0.95 });
      const link = document.createElement("a");
      link.download = `americano-stats.${format === "png" ? "png" : "jpg"}`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error(err);
      setExportError("Не удалось сохранить изображение. Проверьте доступ к CDN.");
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen || !data) return null;
  const completedRoundsLabel = `${standingsSnapshot.completedRounds}/${standingsSnapshot.totalRounds}`;
  const completedMatchesLabel = `${standingsSnapshot.completedMatches}/${standingsSnapshot.totalMatches}`;
  const createdOfflineNotice =
    data.params && typeof data.params === "object" && (data.params as Record<string, unknown>).createdOffline === true
      ? "Турнир создан локально без связи. Черновик хранится на устройстве."
      : null;
  const localConductedNotice =
    isLocalConductedTournament && !isSyncedWithViva
      ? "Турнир проведен локально. После появления связи его можно синхронизировать с Viva."
      : null;
  const syncedWithVivaNotice = isSyncedWithViva
    ? "Турнир синхронизирован с Viva."
    : null;
  const offlineNotice = !isOnline
    ? localConductedNotice ?? createdOfflineNotice ?? "Нет связи. Черновик турнира и локально сохраненные результаты остаются на устройстве."
    : syncWithVivaSuccess
      ?? syncedWithVivaNotice
      ?? localConductedNotice
      ?? createdOfflineNotice
      ?? (pendingQueueRecords.length > 0
        ? "Есть локально сохраненные результаты. Они будут отправлены при появлении связи."
        : null);
  const broadcastTargetOptions = getTournamentBroadcastTargetOptions(broadcastStationId);
  const broadcastActiveTargetsLabel = formatTournamentBroadcastTargets(
    broadcastActiveTargets,
    broadcastStationId,
  );
  const broadcastStateNeedsAttention = broadcastPartial
    || broadcastRecoveryRequired
    || broadcastStatus === "starting"
    || broadcastStatus === "stopping";
  const broadcastStateTitle = broadcastStatus === "starting"
    ? broadcastActiveTargetsLabel
      ? `Запуск не подтверждён: ${broadcastActiveTargetsLabel}`
      : "Запуск трансляции не подтверждён"
    : broadcastStatus === "stopping"
      ? broadcastActiveTargetsLabel
        ? `Остановка выполняется: ${broadcastActiveTargetsLabel}`
        : "Остановка трансляции выполняется"
      : broadcastActiveTargetsLabel
        ? `Активные экраны: ${broadcastActiveTargetsLabel}`
        : "Трансляция активна";

  return (
    <Modal isOpen={isOpen} onClose={handleTournamentManagerClose} title={title || "Турнир"} variant="fullscreen">
      <div className="tournament-manager">
        <div className="tournament-manager-meta">
          <span className="tournament-manager-chip strong">{getTournamentTypeLabel(data.tournamentType)}</span>
          <span className="tournament-manager-chip">До {data.targetScore}</span>
          <span className="tournament-manager-chip">{formatCourtsCountLabel(data.courts.length)}</span>
        </div>
        {canEditSettings && onEditSettings && (
          <div className="tournament-manager-top-actions">
            <button
              type="button"
              className="tournament-manager-secondary"
              onClick={onEditSettings}
            >
              Вернуться к редактированию
            </button>
          </div>
        )}
        {data.courts.length > 0 && (
          <div className="tournament-manager-courts">
            {data.courts.map((court, index) => (
              <span key={`${court}-${index}`} className="tournament-manager-court-chip">
                {court}
              </span>
            ))}
          </div>
        )}
        {offlineNotice && <div className="tournaments-sync-notice">{offlineNotice}</div>}
        <div className="tournament-tabs">
          {[
            { key: "tournament", label: "Турнир" },
            { key: "table", label: "Таблица" },
            { key: "stats", label: "Статистика" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={`tournament-tab ${activeTab === tab.key ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab(tab.key as typeof activeTab)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "tournament" && (
          <div className="tournament-mode-toggle">
            <div className="tournament-mode-copy">
              <div className="tournament-mode-title">Экспертный режим</div>
              <div className="tournament-mode-subtitle">
                Показывать качество, bye и служебные параметры сетки
              </div>
            </div>
            <button
              type="button"
              className={`switch ${expertMode ? "on" : ""}`}
              onClick={() => setExpertMode((prev) => !prev)}
              aria-pressed={expertMode}
              aria-label="Переключить экспертный режим"
            >
              <span />
            </button>
          </div>
        )}

        {activeTab === "tournament" && (
          <>
            <div className="tournament-rounds">
              {expertMode && (
                <div className="tournament-summary">
                  <div className="tournament-summary-card">
                    <span className="tournament-summary-label">Раунды</span>
                    <span className="tournament-summary-value">{completedRoundsLabel}</span>
                  </div>
                  <div className="tournament-summary-card">
                    <span className="tournament-summary-label">Матчи</span>
                    <span className="tournament-summary-value">{completedMatchesLabel}</span>
                  </div>
                  <div className="tournament-summary-card wide">
                    <span className="tournament-summary-label">Bye</span>
                    <span className="tournament-summary-value">
                      Среднее очков раунда после завершения всех матчей
                    </span>
                  </div>
                </div>
              )}
              {rounds.map((round) => (
                <div
                  key={round.id}
                  className={`tournament-round ${round.saved ? "saved" : "unsaved"}`}
                >
                  <button
                    type="button"
                    className="tournament-round-header"
                    onClick={() =>
                      setRounds((prev) =>
                        prev.map((r) =>
                          r.id === round.id ? { ...r, collapsed: !r.collapsed } : r,
                        ),
                      )
                    }
                  >
                    <div className="tournament-round-heading">
                      <span className="tournament-round-title">Раунд {round.index}</span>
                      {expertMode && (
                        <div className="tournament-round-meta">
                          <span
                            className={`tournament-quality-badge quality-${getQualityTone(round.quality.score)}`}
                          >
                            {round.quality.label} · {formatTournamentNumber(round.quality.score, 1)}
                          </span>
                          <span className="tournament-round-meta-text">
                            {round.matches.length} матч. · bye {round.byes.length}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="tournament-round-actions">
                      {Object.keys(matchSaveErrors).some((id) =>
                        round.matches.some((m) => m.id === id),
                      ) ? (
                        <span className="tournament-round-status error">Ошибка</span>
                      ) : round.saved ? (
                        <span className="tournament-round-status saved">Сохранено</span>
                      ) : null}
                      {round.saved && (
                        <span className="tournament-round-edit" title="Редактировать">
                          ✎
                        </span>
                      )}
                      <span>{round.collapsed ? "+" : "−"}</span>
                    </div>
                  </button>
                  {!round.collapsed && (
                    <div className="tournament-round-body">
                    {expertMode && (
                      <div className="tournament-round-quality">
                        <div className="tournament-round-quality-item">
                          <span className="tournament-round-quality-label">Среднее качество кортов</span>
                          <span className="tournament-round-quality-value">
                            {formatTournamentNumber(round.quality.averageCourtScore, 1)}
                          </span>
                        </div>
                        <div className="tournament-round-quality-item">
                          <span className="tournament-round-quality-label">Минимальное качество</span>
                          <span className="tournament-round-quality-value">
                            {formatTournamentNumber(round.quality.minCourtScore, 1)}
                          </span>
                        </div>
                        <div className="tournament-round-quality-item">
                          <span className="tournament-round-quality-label">Пояснение</span>
                          <span className="tournament-round-quality-value secondary">
                            {round.quality.explanation}
                          </span>
                        </div>
                      </div>
                    )}
                    {expertMode && round.byes.length > 0 && (
                      <div className="tournament-byes">
                        <div className="tournament-byes-header">
                          <span className="tournament-byes-title">Bye в этом раунде</span>
                          <span className="tournament-byes-points">
                            {roundByePoints[round.id] != null
                              ? `+${formatTournamentNumber(roundByePoints[round.id] ?? 0)} очка каждому`
                              : "Очки появятся после завершения всех матчей раунда"}
                          </span>
                        </div>
                        <div className="tournament-byes-list">
                          {round.byes.map((player) => (
                            <div key={`${round.id}-${player.id}`} className="tournament-bye-chip">
                              <span className="tournament-bye-chip-name">{player.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {round.matches.map((match) => (
                      <div
                        key={match.id}
                        className="tournament-match"
                        ref={(node) => {
                          matchElementRefs.current[getTournamentMatchKey(round.id, match.id)] = node;
                        }}
                      >
                        {(() => {
                          const matchKey = getTournamentMatchKey(round.id, match.id);
                          const queuedState = queuedMatchState.matchStateByKey.get(matchKey) ?? null;
                          const queuedJobId = queuedState?.jobId ?? null;
                          const isQueuedLocally = Boolean(queuedJobId && match.saved);
                          const saveButtonLabel =
                            isQueuedLocally
                              ? sendingQueuedJobId === queuedJobId
                                ? "Отправка..."
                                : "Отправить на сервер"
                              : savingMatchId === match.id
                                ? "Сохранение..."
                                : "Сохранить";
                          return (
                            <>
                        <div className="tournament-match-header">
                          <div className="tournament-match-court">
                            <span className="tournament-match-label">Корт</span>
                            <span className="tournament-match-value">{match.court}</span>
                          </div>
                          {expertMode && (
                            <span
                              className={`tournament-quality-badge quality-${getQualityTone(match.quality.score)}`}
                            >
                              {match.quality.label} · {formatTournamentNumber(match.quality.score, 1)}
                            </span>
                          )}
                        </div>
                        <div className="tournament-match-row">
                          <span className="tournament-match-label">Пара 1</span>
                          <span className="tournament-match-value">
                            {match.pair1.map((p) => p.name).join(" + ")}
                          </span>
                          <input
                            className="tournament-score-input"
                            type="number"
                            min={0}
                            max={data.targetScore}
                            value={match.score1 ?? ""}
                            ref={(node) => {
                              const matchKey = getTournamentMatchKey(round.id, match.id);
                              matchInputRefs.current[matchKey] = {
                                score1: node,
                                score2: matchInputRefs.current[matchKey]?.score2 ?? null,
                              };
                            }}
                            onChange={(e) =>
                              handleScoreChange(round.id, match.id, "score1", e.target.value)
                            }
                          />
                        </div>
                        <div className="tournament-match-row">
                          <span className="tournament-match-label">Пара 2</span>
                          <span className="tournament-match-value">
                            {match.pair2.map((p) => p.name).join(" + ")}
                          </span>
                          <input
                            className="tournament-score-input"
                            type="number"
                            min={0}
                            max={data.targetScore}
                            value={match.score2 ?? ""}
                            ref={(node) => {
                              const matchKey = getTournamentMatchKey(round.id, match.id);
                              matchInputRefs.current[matchKey] = {
                                score1: matchInputRefs.current[matchKey]?.score1 ?? null,
                                score2: node,
                              };
                            }}
                            onChange={(e) =>
                              handleScoreChange(round.id, match.id, "score2", e.target.value)
                            }
                          />
                        </div>
                        {expertMode && (
                          <div className="tournament-match-summary">
                            <span>{match.quality.explanation}</span>
                            <span>
                              Сила пар: {formatTournamentNumber(match.summary.pairPower1, 3)} /{" "}
                              {formatTournamentNumber(match.summary.pairPower2, 3)}
                            </span>
                          </div>
                        )}
                        <div className="tournament-match-actions">
                          <div className="tournament-match-status">
                            {matchSaveErrors[match.id] ? (
                              <span className="tournament-round-status error">Ошибка</span>
                            ) : isQueuedLocally ? (
                              <span className="tournament-round-status saved local">Сохранено локально</span>
                            ) : match.saved ? (
                              <span className="tournament-round-status saved">Сохранено</span>
                            ) : null}
                          </div>
                          <button
                            className={`tournament-round-save${isQueuedLocally ? " tournament-round-save--local" : ""}`}
                            type="button"
                            onClick={() =>
                              void (isQueuedLocally && queuedState
                                ? handleSendQueuedTournamentResult(queuedJobId!)
                                : handleMatchSave(round.id, match.id))
                            }
                            disabled={
                              tournamentFinished
                              || savingMatchId === match.id
                              || (isQueuedLocally && sendingQueuedJobId === queuedJobId)
                            }
                          >
                            {saveButtonLabel}
                          </button>
                        </div>
                        {matchSaveErrors[match.id] && (
                          <div className="tournaments-error">{matchSaveErrors[match.id]}</div>
                        )}
                            </>
                          );
                        })()}
                      </div>
                    ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {activeTab === "table" && (
          <div className="tournament-table">
            {(data.tournamentType === "paired_americano" ? pairedTableGroups : tableRows.map((row) => ({
              pairKey: row.id,
              rank: row.rank,
              members: [row],
            })) ).map((group) => {
              const leadRow = group.members[0];
              if (!leadRow) return null;

              const pointDiffClass =
                leadRow.pointDiff > 0
                  ? "positive"
                  : leadRow.pointDiff < 0
                    ? "negative"
                    : "";

              return (
                <div
                  key={group.pairKey}
                  className={`tournament-table-row${group.members.length > 1 ? " tournament-table-row-pair" : ""}`}
                >
                  {group.members.length > 1 ? (
                    <div className="tournament-table-player-stack">
                      {group.members.map((row, index) => renderTournamentTablePlayer(row, {
                        compact: true,
                        showRank: index === 0,
                      }))}
                    </div>
                  ) : (
                    renderTournamentTablePlayer(leadRow)
                  )}
                  <div className="tournament-table-stat-group">
                    <div className="tournament-table-stat-head">
                      <span>В</span>
                      <span>Н</span>
                      <span>П</span>
                    </div>
                    <div className="tournament-table-stat-values">
                      <span className="positive">{formatTournamentNumber(leadRow.wins, 0)}</span>
                      <span>{formatTournamentNumber(leadRow.draws, 0)}</span>
                      <span className="negative">{formatTournamentNumber(leadRow.losses, 0)}</span>
                    </div>
                  </div>
                  <div className="tournament-table-stat-group">
                    <div className="tournament-table-stat-head">
                      <span>+</span>
                      <span>-</span>
                      <span>Δ</span>
                    </div>
                    <div className="tournament-table-stat-values">
                      <span className="positive">{formatTournamentNumber(leadRow.pointsFor, 0)}</span>
                      <span className="negative">{formatTournamentNumber(leadRow.pointsAgainst, 0)}</span>
                      <span className={pointDiffClass}>
                        {formatSignedTournamentNumber(leadRow.pointDiff, 0)}
                      </span>
                    </div>
                  </div>
                  <div className="tournament-table-rating-group">
                    <span className="tournament-table-rating-label">Δ рейтинга</span>
                    <div className="tournament-table-rating-stack">
                      {group.members.map((row) => {
                        const ratingDeltaClass =
                          row.ratingDelta > 0
                            ? "positive"
                            : row.ratingDelta < 0
                              ? "negative"
                              : "";
                        return (
                          <span
                            key={`${group.pairKey}-${row.id}-rating`}
                            className={`tournament-table-rating-value ${ratingDeltaClass}`}
                          >
                            {formatSignedTournamentNumber(row.ratingDelta, 5)}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "stats" && (
          <div className="tournament-stats">
            <div className="tournament-stats-actions">
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportStats("png")}
                disabled={exporting}
              >
                PNG
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportStats("jpeg")}
                disabled={exporting}
              >
                JPEG
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportHistory("csv")}
              >
                CSV
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportHistory("xlsx")}
              >
                XLSX
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={handleDownloadTournamentJson}
              >
                JSON
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => tournamentJsonInputRef.current?.click()}
              >
                Импорт JSON
              </button>
              {exportError && <span className="tournament-stats-error">{exportError}</span>}
              {jsonError && <span className="tournament-stats-error">{jsonError}</span>}
            </div>
            <input
              ref={tournamentJsonInputRef}
              type="file"
              accept="application/json,.json"
              className="tournament-json-input"
              onChange={(event) => void handleTournamentJsonFileChange(event)}
            />
            <div className="tournament-stats-capture" ref={statsRef}>
              {statsRows.map((row) => {
                const diff = row.pointDiff;
                const playerRating =
                  row.ratingAfter
                  ?? participantRatingById.get(row.id)
                  ?? row.ratingBefore
                  ?? null;
                const playerBadgeStyle = getTournamentRatingBadgeStyle(playerRating);
                const playerRingProgressDeg = `${Math.round(getTournamentRatingRingProgress(playerRating) * 360)}deg`;
                const diffClass =
                  diff > 0
                    ? "positive"
                    : diff < 0
                      ? "negative"
                      : "";
                const ratingDeltaClass =
                  row.ratingDelta > 0
                    ? "positive"
                    : row.ratingDelta < 0
                      ? "negative"
                      : "";
                return (
                  <div key={row.id} className="tournament-stats-row">
                    <div className="tournament-stats-player">
                      <div className="tournament-table-avatar-wrap tournament-stats-avatar-wrap">
                        <div
                          className={`tournament-table-player-ring${playerRating != null ? " has-level" : ""}`}
                          style={{ "--player-ring-progress": playerRingProgressDeg } as CSSProperties}
                        >
                          <div className={`tournament-participant-avatar ${row.photo ? "" : "no-photo"}`}>
                            {row.photo ? (
                              <img
                                src={row.photo}
                                alt={row.name}
                                crossOrigin="anonymous"
                                onError={(e) => {
                                  const target = e.currentTarget;
                                  target.style.display = "none";
                                  const parent = target.parentElement;
                                  if (parent) parent.classList.add("no-photo");
                                }}
                              />
                            ) : null}
                            <span className="tournament-participant-initials">
                              {getInitialsFromName(row.name)}
                            </span>
                          </div>
                        </div>
                        {playerRating != null && (
                          <span
                            className="tournament-table-level tournament-stats-level"
                            style={playerBadgeStyle}
                          >
                            {formatStatsRatingBadge(playerRating)}
                          </span>
                        )}
                      </div>
                      <span className="tournament-stats-name">{row.name}</span>
                    </div>
                    <div className="tournament-stats-block tournament-stats-block-record">
                      <div className="tournament-stats-head">
                        <span>В</span>
                        <span>Н</span>
                        <span>П</span>
                      </div>
                      <div className="tournament-stats-values">
                        <span className="positive">{formatTournamentNumber(row.wins, 0)}</span>
                        <span>{formatTournamentNumber(row.draws, 0)}</span>
                        <span className="negative">{formatTournamentNumber(row.losses, 0)}</span>
                      </div>
                    </div>
                    <div className="tournament-stats-block tournament-stats-block-points">
                      <div className="tournament-stats-head tournament-stats-head-single">
                        <span>Очки</span>
                      </div>
                      <div className="tournament-stats-points-line">
                        <span className="positive">{formatTournamentNumber(row.pointsFor, 0)}</span>
                        <span className="tournament-stats-divider">-</span>
                        <span className="negative">{formatTournamentNumber(row.pointsAgainst, 0)}</span>
                      </div>
                      <div className={`tournament-stats-sum ${diffClass}`}>
                        {formatSignedTournamentNumber(diff, 0)}
                      </div>
                    </div>
                    <div className="tournament-stats-block tournament-stats-block-rating">
                      <div className="tournament-stats-head tournament-stats-head-single">
                        <span>Δ рейтинга</span>
                      </div>
                      <div className={`tournament-stats-rating-change ${ratingDeltaClass}`}>
                        {formatSignedTournamentNumber(row.ratingDelta, 5)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {historyRows.length > 0 && (
              <div className="tournament-history">
                <div className="tournament-history-title">История матчей</div>
                {historyRows.map((row, idx) => (
                  <div key={`${row.playerId}-${row.matchId}-${idx}`} className="tournament-history-row">
                    <span className="tournament-history-name">{row.playerName}</span>
                    <span className="tournament-history-round">
                      {row.roundId} / {row.matchId}
                    </span>
                    <span className="tournament-history-score">
                      {row.scoreFor} - {row.scoreAgainst}
                    </span>
                    <span
                      className={`tournament-history-delta ${
                        (row.delta ?? 0) > 0 ? "positive" : (row.delta ?? 0) < 0 ? "negative" : ""
                      }`}
                    >
                      {row.delta != null ? row.delta.toFixed(5) : "0.00000"}
                    </span>
                    <span className="tournament-history-rating">
                      {row.ratingBefore != null ? row.ratingBefore.toFixed(5) : "0.00000"} →{" "}
                      {row.ratingAfter != null ? row.ratingAfter.toFixed(5) : "0.00000"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="tournament-manager-footer">
          {finishTournamentNote && (
            <div className="tournament-manager-footer-note">
              {finishTournamentNote}
            </div>
          )}
          {syncWithVivaError && (
            <div className="tournaments-error">{syncWithVivaError}</div>
          )}
          {finishTournamentError && (
            <div className="tournaments-error">{finishTournamentError}</div>
          )}
          {resumeTournamentError && (
            <div className="tournaments-error">{resumeTournamentError}</div>
          )}
          {broadcastError && (
            <div className="tournaments-error">{broadcastError}</div>
          )}
          {broadcastActive && (
            <div
              className={`tournament-manager-broadcast-state${broadcastStateNeedsAttention ? " is-partial" : ""}`}
              role={broadcastStateNeedsAttention ? "alert" : "status"}
            >
              <div>{broadcastStateTitle}</div>
              {broadcastMessage && (
                <div className="tournament-manager-broadcast-message">{broadcastMessage}</div>
              )}
            </div>
          )}
          <button
            type="button"
            className={`section-cta tournament-manager-broadcast${broadcastActive ? " is-active" : ""}`}
            onClick={() => void handleToggleTournamentBroadcast()}
            disabled={broadcastLoading || broadcastOperationInProgress || !isOnline}
            aria-pressed={broadcastActive}
          >
            {broadcastLoading
              ? (broadcastActive ? "Останавливаем трансляцию..." : "Запускаем трансляцию...")
              : broadcastOperationInProgress
                ? broadcastStatus === "stopping"
                  ? "Остановка трансляции..."
                  : "Запуск трансляции..."
              : broadcastActive
                ? "Остановить трансляцию результатов"
                : "Трансляция результатов"}
          </button>
          {canResumeTournament && (
            <button
              type="button"
              className="section-cta tournament-manager-resume"
              onClick={() => void handleResumeTournament()}
              disabled={!canResumeTournament}
            >
              <span aria-hidden="true">↻</span>
              {resumingTournament ? "Возобновление..." : "Возобновить турнир"}
            </button>
          )}
          {isManualTournament && (isLocalConductedTournament || isSyncedWithViva) && (
            <button
              type="button"
              className={`section-cta tournament-manager-sync${isSyncedWithViva ? " is-synced" : ""}`}
              onClick={() => void handleSyncTournamentWithViva()}
              disabled={!canSyncWithViva}
            >
              {syncingWithViva
                ? "Синхронизация..."
                : isSyncedWithViva
                  ? "Синхронизировано"
                  : "Синхронизировать с Viva"}
            </button>
          )}
          <button
            type="button"
            className="section-cta tournament-manager-finish"
            onClick={() => {
              setFinishTournamentError(null);
              setFinishConfirmationOpen(true);
            }}
            disabled={!canFinishTournament || finishingTournament || tournamentFinished || resumingTournament}
          >
            {finishingTournament ? "Завершение..." : "Завершить турнир"}
          </button>
        </div>
      </div>
      <Modal
        isOpen={broadcastSelectionOpen}
        onClose={() => {
          if (!broadcastLoading) setBroadcastSelectionOpen(false);
        }}
        title="Где запустить трансляцию?"
        variant="dialog"
        bodyClassName="tournament-broadcast-target-dialog"
      >
        <div className="tournament-broadcast-target-options" role="radiogroup" aria-label="Экран для трансляции">
          {broadcastTargetOptions.map((option) => (
            <label
              key={option.value}
              className={`tournament-broadcast-target-option${broadcastSelectedTarget === option.value ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="tournament-broadcast-target"
                value={option.value}
                checked={broadcastSelectedTarget === option.value}
                onChange={() => setBroadcastSelectedTarget(option.value)}
                disabled={broadcastLoading}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {broadcastError && (
          <div className="tournaments-error" role="alert">{broadcastError}</div>
        )}
        <div className="tournament-broadcast-target-actions">
          <button
            type="button"
            className="onboarding-btn onboarding-btn--secondary"
            onClick={() => setBroadcastSelectionOpen(false)}
            disabled={broadcastLoading}
          >
            Отмена
          </button>
          <button
            type="button"
            className="onboarding-btn"
            onClick={() => {
              if (broadcastSelectedTarget) {
                void handleSetTournamentBroadcast("start", broadcastSelectedTarget);
              }
            }}
            disabled={!broadcastSelectedTarget || broadcastLoading || !isOnline}
          >
            {broadcastLoading ? "Запускаем..." : "Запустить"}
          </button>
        </div>
      </Modal>
      <Modal
        isOpen={finishConfirmationOpen}
        onClose={() => {
          if (!finishingTournament) setFinishConfirmationOpen(false);
        }}
        title={finishConfirmationCopy.title}
        variant="dialog"
      >
        <div className="tournament-finish-confirmation">
          <div className="tournament-confirm-copy">
            {finishConfirmationCopy.progress}
          </div>
          <div className="tournament-finish-confirmation-warning">
            {finishConfirmationCopy.warning}
          </div>
          <div className="tournament-confirm-note">
            {finishConfirmationCopy.reassurance}
          </div>
          {finishTournamentError && (
            <div className="tournaments-error" role="alert">
              {finishTournamentError}
            </div>
          )}
          <div className="tournament-confirm-actions">
            <button
              type="button"
              className="onboarding-btn onboarding-btn--secondary"
              onClick={() => setFinishConfirmationOpen(false)}
              disabled={finishingTournament}
            >
              Отмена
            </button>
            <button
              type="button"
              className="onboarding-btn tournament-confirm-danger"
              onClick={() => void handleFinishTournament()}
              disabled={finishingTournament}
            >
              {finishingTournament ? "Завершаем..." : finishConfirmationCopy.confirmLabel}
            </button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
}

export default function TournamentsPage({
  onBack,
  backLabel = "← Назад",
  initialOpenTournamentId = null,
    initialOpenTournamentSlug = null,
    initialOpenDate = null,
  }: TournamentsPageProps) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [vivaRefreshPending, setVivaRefreshPending] = useState(false);
  const [vivaRefreshNotice, setVivaRefreshNotice] = useState<string | null>(null);
  const [vivaRefreshError, setVivaRefreshError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [localDraftSnapshots, setLocalDraftSnapshots] = useState<TournamentDraftSnapshot[]>([]);
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [selectedTournament, setSelectedTournament] = useState<Exercise | null>(null);
  const [managerData, setManagerData] = useState<AmericanoTournamentPayload | null>(null);
  const [managerTotals, setManagerTotals] = useState<AmericanoResultsResponse["totals"] | null>(null);
  const [managerPlayerLogs, setManagerPlayerLogs] = useState<AmericanoResultsResponse["playerLogs"] | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, TournamentHistoryRecord | null>>({});
  const [openingTournamentId, setOpeningTournamentId] = useState<string | null>(null);
  const [autoOpenNotice, setAutoOpenNotice] = useState<string | null>(null);
  const [deepLinkTournament, setDeepLinkTournament] = useState<Exercise | null>(null);
  const [deepLinkLookupPending, setDeepLinkLookupPending] = useState(false);
  const [manualTournamentCreationOpen, setManualTournamentCreationOpen] = useState(false);
  const [dateIndex, setDateIndex] = useState(TODAY_DATE_INDEX);
  const autoOpenTournamentKeyRef = useRef<string | null>(null);
  const deepLinkLookupKeyRef = useRef<string | null>(null);
  const openingTournamentIdRef = useRef<string | null>(null);
  const activeDateRef = useRef<HTMLDivElement | null>(null);
  const selectedDateKeyRef = useRef<string | null>(null);
  const scheduleRequestGenerationRef = useRef(0);
  const locationTournamentSlug = useMemo(() => readTournamentSlugFromLocation(), []);
  const targetTournamentSlug = useMemo(
    () => normalizeTournamentSlug(initialOpenTournamentSlug) ?? locationTournamentSlug,
    [initialOpenTournamentSlug, locationTournamentSlug],
  );

  const dates = useMemo(() => {
    const base = new Date();
    const totalDays = DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1;
    return Array.from({ length: totalDays }).map((_, i) => {
      const next = new Date(base);
      next.setDate(base.getDate() + (i - DAYS_BEFORE_TODAY));
      return next;
    });
  }, []);

  const selectedDate = dates[dateIndex] ?? dates[0] ?? new Date();
  const selectedDateStr = formatDate(selectedDate);
  const todayDateStr = formatDate(new Date());
  const includePastTournaments = selectedDateStr <= todayDateStr;
  const tournamentMechanicsLookupDate = selectedDateStr;
  selectedDateKeyRef.current = selectedDateStr;

  const refreshPendingSyncCount = useCallback(async () => {
    const count = await getPendingTournamentResultSyncCount();
    setPendingSyncCount(count);
    return count;
  }, []);

  useEffect(() => {
    setLocalDraftSnapshots(listCachedTournamentDrafts());
  }, []);

  useEffect(() => {
    const dateKey = getDateKeyFromInput(initialOpenDate);
    if (!dateKey) return;

    const nextIndex = dates.findIndex((date) => formatDate(date) === dateKey);
    if (nextIndex >= 0) {
      setDateIndex(nextIndex);
    }
  }, [dates, initialOpenDate]);

  useEffect(() => {
    activeDateRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [dateIndex]);

  useEffect(() => {
    setVivaRefreshNotice(null);
    setVivaRefreshError(null);
  }, [selectedDateStr]);

  useEffect(() => {
    let alive = true;
    const requestGeneration = scheduleRequestGenerationRef.current + 1;
    scheduleRequestGenerationRef.current = requestGeneration;
    const isCurrentRequest = () => (
      alive && scheduleRequestGenerationRef.current === requestGeneration
    );
    let appliedFreshItems = false;
    setLoading(true);
    setError(null);
    setCacheNotice(null);

    void loadCachedTournamentSchedule(selectedDateStr).then((cachedItems) => {
      if (!isCurrentRequest() || appliedFreshItems || !cachedItems) return;
      setItems(cachedItems);
      setCacheNotice("Показываем сохраненное расписание. Обновляем список...");
      setLoading(false);
    });

    void (async () => {
      try {
        const bookingItemsPromise = fetchTournamentBookingItems(includePastTournaments);
        const sourceTournamentItemsPromise = fetchTournamentMechanicsSourceItems(tournamentMechanicsLookupDate);
        const exercisesResult = await apiFetchExercisesByVisibleDate(selectedDateStr, {
          includePast: includePastTournaments,
          includeAdjacentDays: false,
        });

        if (!isCurrentRequest()) return;
        if (exercisesResult.error && !exercisesResult.data) {
          throw new Error(exercisesResult.error.message || "Не удалось загрузить упражнения турниров");
        }

        appliedFreshItems = true;
        const baseItems = mergeTournamentMechanicsExercises(
          exercisesResult.data ?? [],
          [],
          selectedDateStr,
        );
        setItems(baseItems);
        setCacheNotice(null);
        setLoading(false);
        void saveCachedTournamentSchedule(selectedDateStr, baseItems);

        const [bookingItems, sourceTournamentItems] = await Promise.all([
          bookingItemsPromise,
          sourceTournamentItemsPromise,
        ]);
        if (!isCurrentRequest()) return;

        const fallbackExercises = buildTournamentMechanicsFallbackExercises(sourceTournamentItems);
        const mergedExercises = mergeTournamentMechanicsExercises(
          exercisesResult.data ?? [],
          fallbackExercises,
          selectedDateStr,
        );
        const finalItems = mergeTournamentExercises(mergedExercises, bookingItems, selectedDateStr);
        setItems(finalItems);
        void saveCachedTournamentSchedule(selectedDateStr, finalItems);
      } catch {
        if (!isCurrentRequest()) return;
        const cachedItems = await loadCachedTournamentSchedule(selectedDateStr);
        if (!isCurrentRequest()) return;
        if (cachedItems) {
          setItems(cachedItems);
          setCacheNotice("Показываем сохраненное расписание. Синхронизация восстановится при появлении связи.");
          setLoading(false);
          return;
        }
        setError("Не удалось загрузить список турниров");
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [includePastTournaments, selectedDateStr, tournamentMechanicsLookupDate]);

  useEffect(() => {
    let alive = true;
    setProfileLoading(true);
    apiFetchProfile()
      .then((res) => {
        if (!alive) return;
        setProfile(res.data ?? null);
        if (res.data) {
          void saveCachedTournamentProfile(res.data);
        }
      })
      .catch(async () => {
        if (!alive) return;
        const cachedProfile = await loadCachedTournamentProfile();
        if (cachedProfile) {
          setProfile(cachedProfile);
          setCacheNotice("Показываем сохраненные данные профиля и расписания.");
          return;
        }
        setProfile(null);
      })
      .finally(() => {
        if (alive) setProfileLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const canHostTournaments = profile ? hasTournamentHostingAccess(profile) : false;
  const handleVivaRefresh = useCallback(async () => {
    if (!canHostTournaments || vivaRefreshPending) return;

    const requestedDate = selectedDateStr;
    const requestGeneration = scheduleRequestGenerationRef.current + 1;
    scheduleRequestGenerationRef.current = requestGeneration;
    setVivaRefreshPending(true);
    setVivaRefreshNotice(null);
    setVivaRefreshError(null);

    try {
      const result = await apiRefreshTournamentMechanicsFromViva(requestedDate);
      if (result.error || !result.data) {
        throw new Error(result.error?.message || "Не удалось обновить турниры из Viva");
      }
      if (result.data.reason === "refresh_failed") {
        throw new Error("Viva временно не вернула расписание. Текущий список сохранён.");
      }
      if (
        selectedDateKeyRef.current !== requestedDate
        || scheduleRequestGenerationRef.current !== requestGeneration
      ) {
        setVivaRefreshNotice("Viva обновлена для ранее выбранной даты.");
        return;
      }
      if (result.data.reason === "cooldown") {
        const retrySeconds = Math.max(1, Math.ceil((result.data.retryAfterMs ?? 0) / 1000));
        setVivaRefreshNotice(`Эта дата уже обновлялась. Повторить можно через ${retrySeconds} сек.`);
        return;
      }

      const freshExercises = buildTournamentMechanicsFallbackExercises(result.data.tournaments);
      setItems(freshExercises);
      setError(null);
      setCacheNotice(null);
      void saveCachedTournamentSchedule(requestedDate, freshExercises);

      const countLabel = `турниров получено: ${result.data.tournaments.length}`;
      setVivaRefreshNotice(
        result.data.persisted === false
          ? `Из Viva ${countLabel}, но серверный снимок не сохранился.`
          : `Данные из Viva обновлены, ${countLabel}.`,
      );
    } catch (refreshError) {
      if (
        selectedDateKeyRef.current !== requestedDate
        || scheduleRequestGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      setVivaRefreshError(
        refreshError instanceof Error
          ? refreshError.message
          : "Не удалось обновить турниры из Viva",
      );
    } finally {
      setVivaRefreshPending(false);
    }
  }, [canHostTournaments, selectedDateStr, vivaRefreshPending]);
  const currentProfileId = profile?.id ?? null;
  const localDraftExercises = useMemo(
    () => localDraftSnapshots
      .map((snapshot) => buildTournamentDraftExercise(snapshot, { currentProfileId }))
      .filter((item): item is Exercise => item !== null),
    [currentProfileId, localDraftSnapshots],
  );
  const localDraftHistoryById = useMemo(() => {
    const next: Record<string, TournamentHistoryRecord | null> = {};
    localDraftSnapshots.forEach((snapshot) => {
      const draftExercise = buildTournamentDraftExercise(snapshot, { currentProfileId });
      const draftHistory = buildTournamentHistoryRecordFromPayload(
        snapshot.payload,
        draftExercise,
        null,
        snapshot.totals,
        snapshot.playerLogs,
      );
      next[snapshot.payload.tournamentId] = draftHistory;
    });
    return next;
  }, [currentProfileId, localDraftSnapshots]);
  const combinedHistoryById = useMemo(
    () => ({ ...historyById, ...localDraftHistoryById }),
    [historyById, localDraftHistoryById],
  );
  const serverTournaments = useMemo(
    () => items.filter((ex) => isTournamentExerciseCategory(ex)),
    [items],
  );
  const serverVisibleTournaments = useMemo(
    () => filterVisibleTournamentExercises(
      serverTournaments,
      currentProfileId,
      canHostTournaments,
      Boolean(profile),
    ),
    [canHostTournaments, currentProfileId, profile, serverTournaments],
  );
  const localVisibleTournaments = useMemo(
    () => filterVisibleTournamentExercises(
      localDraftExercises,
      currentProfileId,
      canHostTournaments,
      Boolean(profile),
    ),
    [canHostTournaments, currentProfileId, localDraftExercises, profile],
  );
  const visibleTournaments = useMemo(
    () => mergeTournamentMechanicsExercises(
      serverVisibleTournaments,
      localVisibleTournaments,
      selectedDateStr,
    ),
    [localVisibleTournaments, selectedDateStr, serverVisibleTournaments],
  );
  const serverTournamentIdsKey = useMemo(
    () => serverVisibleTournaments.map((ex) => String(ex.id)).sort().join("|"),
    [serverVisibleTournaments],
  );
  const noTournamentModuleAccess = Boolean(
    profile
    && !canHostTournaments
    && serverTournaments.length > 0
    && visibleTournaments.length === 0,
  );

  const upsertLocalDraftSnapshot = useCallback((
    payload: AmericanoTournamentPayload,
    extras?: {
      totals: AmericanoResultsResponse["totals"] | null;
      playerLogs: AmericanoResultsResponse["playerLogs"] | null;
    },
  ) => {
    const nextSnapshot: TournamentDraftSnapshot = {
      payload,
      totals: extras?.totals ?? null,
      playerLogs: extras?.playerLogs ?? null,
      updatedAt: new Date().toISOString(),
    };
    saveCachedTournamentDraft(nextSnapshot);
    setLocalDraftSnapshots((prev) => {
      const next = prev.filter((item) => item.payload.tournamentId !== payload.tournamentId);
      next.push(nextSnapshot);
      return next.sort((left, right) => {
        const leftTs = Date.parse(left.updatedAt || left.payload.createdAt || "");
        const rightTs = Date.parse(right.updatedAt || right.payload.createdAt || "");
        const safeLeftTs = Number.isFinite(leftTs) ? leftTs : 0;
        const safeRightTs = Number.isFinite(rightTs) ? rightTs : 0;
        return safeRightTs - safeLeftTs;
      });
    });
  }, []);

  useEffect(() => {
    if (!serverTournamentIdsKey) {
      setHistoryById({});
      return;
    }

    let alive = true;

    void (async () => {
      const cachedEntries = await Promise.all(
        serverVisibleTournaments.map(async (tournament) => {
          const tournamentId = String(tournament.id);
          const cachedHistory = await loadCachedTournamentHistory(tournamentId);
          return [tournamentId, cachedHistory] as const;
        }),
      );

      if (!alive) return;
      const next: Record<string, TournamentHistoryRecord | null> = {};
      cachedEntries.forEach(([tournamentId, historyRecord]) => {
        next[tournamentId] = historyRecord;
      });
      setHistoryById(next);
    })();

    return () => {
      alive = false;
    };
  }, [serverTournamentIdsKey, serverVisibleTournaments]);

  const handleTournamentOpen = async (tournament: Exercise) => {
    const tournamentId = String(tournament.id);
    if (openingTournamentId || openingTournamentIdRef.current) return;
    openingTournamentIdRef.current = tournamentId;
    setAutoOpenNotice(null);
    setManualTournamentCreationOpen(false);
    setOpeningTournamentId(tournamentId);

    try {
      let historyRecord = combinedHistoryById[tournamentId] ?? null;
      const cachedDraft = loadCachedTournamentDraft(tournamentId);
      const cachedHistory = await loadCachedTournamentHistory(tournamentId);
      const hasPendingSync = await hasPendingTournamentResultJobs(tournamentId);

      const currentHistory = historyRecord ?? cachedHistory ?? null;
      const draftUpdatedAt = cachedDraft ? toTimestamp(cachedDraft.updatedAt) : 0;
      const historyUpdatedAt = currentHistory
        ? toTimestamp(currentHistory.updatedAt ?? currentHistory.createdAt)
        : 0;
      const currentHistoryPayload = buildTournamentComparablePayloadFromHistory(currentHistory);
      const shouldPreferDraftBeforeFreshFetch = shouldPreferClassicMexicanoCachedSnapshot(
        cachedDraft?.payload ?? null,
        currentHistoryPayload,
        {
          hasPendingSync,
          candidateUpdatedAt: draftUpdatedAt,
          currentUpdatedAt: historyUpdatedAt,
        },
      );

      if (cachedDraft && hasPendingSync && shouldPreferDraftBeforeFreshFetch) {
        const draftHistory = buildTournamentHistoryRecordFromPayload(
          cachedDraft.payload,
          tournament,
          currentHistory,
          cachedDraft.totals,
          cachedDraft.playerLogs,
        );
        setSelectedTournament(null);
        setManagerTotals(cachedDraft.totals ?? null);
        setManagerPlayerLogs(cachedDraft.playerLogs ?? null);
        setManagerData(withTournamentStationContext(cachedDraft.payload, tournament));
        setHistoryById((prev) => ({
          ...prev,
          [tournamentId]: draftHistory,
        }));
        return;
      }

      if (hasPendingSync && cachedHistory) {
        historyRecord = cachedHistory;
        setHistoryById((prev) => ({
          ...prev,
          [tournamentId]: cachedHistory,
        }));
      } else {
        try {
          const result = await apiFetchTournamentHistory(tournamentId);
          const freshHistory = pickLatestTournamentHistory(result.data);
          const freshHistoryIsNotStructurallyWorse = shouldPreferClassicMexicanoSnapshot(
            buildTournamentComparablePayloadFromHistory(freshHistory),
            buildTournamentComparablePayloadFromHistory(historyRecord ?? cachedHistory),
            { hasPendingSync },
          );
          if (freshHistory && (freshHistoryIsNotStructurallyWorse || !currentHistory)) {
            historyRecord = freshHistory;
          } else if (!historyRecord && cachedHistory) {
            historyRecord = cachedHistory;
          }
          if (freshHistory) {
            void saveCachedTournamentHistory(freshHistory);
          }
          setHistoryById((prev) => ({
            ...prev,
            [tournamentId]: historyRecord,
          }));
        } catch {
          if (!historyRecord && cachedHistory) {
            historyRecord = cachedHistory;
          }
          setHistoryById((prev) => ({
            ...prev,
            [tournamentId]: historyRecord,
          }));
        }
      }

      const shouldUseDraftFallback = Boolean(
        cachedDraft
        && !historyRecord
        && shouldPreferClassicMexicanoCachedSnapshot(
          cachedDraft.payload,
          null,
          {
            hasPendingSync,
            candidateUpdatedAt: draftUpdatedAt,
            currentUpdatedAt: historyUpdatedAt,
          },
        ),
      );
      if (shouldUseDraftFallback && cachedDraft) {
        const draftHistory = buildTournamentHistoryRecordFromPayload(
          cachedDraft.payload,
          tournament,
          currentHistory,
          cachedDraft.totals,
          cachedDraft.playerLogs,
        );
        setSelectedTournament(null);
        setManagerTotals(cachedDraft.totals ?? null);
        setManagerPlayerLogs(cachedDraft.playerLogs ?? null);
        setManagerData(withTournamentStationContext(cachedDraft.payload, tournament));
        setHistoryById((prev) => ({
          ...prev,
          [tournamentId]: draftHistory,
        }));
        return;
      }

      const restoredPayload = historyRecord
        ? buildTournamentPayloadFromHistory(historyRecord)
        : currentHistory
          ? buildTournamentPayloadFromHistory(currentHistory)
          : null;
      if (restoredPayload) {
        setSelectedTournament(null);
        setManagerTotals((historyRecord ?? currentHistory)?.totals ?? null);
        setManagerPlayerLogs((historyRecord ?? currentHistory)?.playerLogs ?? null);
        setManagerData(withTournamentStationContext(restoredPayload, tournament));
        return;
      }

      setSelectedTournament(tournament);
    } finally {
      if (openingTournamentIdRef.current === tournamentId) {
        openingTournamentIdRef.current = null;
      }
      setOpeningTournamentId((current) => (current === tournamentId ? null : current));
    }
  };

  useEffect(() => {
    const targetTournamentId = String(initialOpenTournamentId || "").trim();
    const targetSlug = targetTournamentSlug;
    const targetKey = targetTournamentId || targetSlug || "";
    if (!targetKey || loading || profileLoading || openingTournamentId || deepLinkLookupPending) return;

    const targetTournament =
      findTournamentByDeepLink(visibleTournaments, {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? findTournamentByDeepLink(items, {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? findTournamentByDeepLink(deepLinkTournament ? [deepLinkTournament] : [], {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? null;

    if (targetTournament) return;
    if (deepLinkLookupKeyRef.current === targetKey) return;
    deepLinkLookupKeyRef.current = targetKey;

    let alive = true;
    setDeepLinkLookupPending(true);
    setAutoOpenNotice("Ищем турнир по ссылке...");

    void (async () => {
      try {
        const today = new Date();
        const dateFrom = formatDate(shiftDateByDays(today, -DEEP_LINK_LOOKUP_DAYS_BEFORE_TODAY));
        const dateTo = formatDate(shiftDateByDays(today, DEEP_LINK_LOOKUP_DAYS_AFTER_TODAY));
        const lookupResult = await apiFetchExercisesByPeriod(dateFrom, dateTo, { size: 5000 });
        if (!alive) return;

        let resolvedTournament = findTournamentByDeepLink(lookupResult.data ?? [], {
          tournamentId: targetTournamentId,
          tournamentSlug: targetSlug,
        });

        if (!resolvedTournament) {
          const sourceLookupResult = await apiFetchTournamentMechanicsSourceList({ from: dateFrom, to: dateTo }).catch(() => null);
          if (!alive) return;
          resolvedTournament = findTournamentByDeepLink([
            ...(lookupResult.data ?? []),
            ...buildTournamentMechanicsFallbackExercises(sourceLookupResult?.data ?? []),
          ], {
            tournamentId: targetTournamentId,
            tournamentSlug: targetSlug,
          });
        }

        if (!resolvedTournament) {
          setDeepLinkTournament(null);
          setAutoOpenNotice("Турнир не найден");
          return;
        }

        setDeepLinkTournament(resolvedTournament);
        setAutoOpenNotice(null);

        const tournamentDateKey = getExerciseDateKey(resolvedTournament);
        if (!tournamentDateKey) return;
        const nextIndex = dates.findIndex((date) => formatDate(date) === tournamentDateKey);
        if (nextIndex >= 0) {
          setDateIndex(nextIndex);
        }
      } catch {
        if (!alive) return;
        setAutoOpenNotice("Не удалось открыть турнир по ссылке");
      } finally {
        if (alive) setDeepLinkLookupPending(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [
    dates,
    deepLinkLookupPending,
    deepLinkTournament,
    initialOpenTournamentId,
    items,
    loading,
    openingTournamentId,
    profileLoading,
    targetTournamentSlug,
    visibleTournaments,
  ]);

  useEffect(() => {
    const targetTournamentId = String(initialOpenTournamentId || "").trim();
    const targetSlug = targetTournamentSlug;
    if ((!targetTournamentId && !targetSlug) || loading || profileLoading || openingTournamentId) return;

    const targetTournament =
      findTournamentByDeepLink(visibleTournaments, {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? findTournamentByDeepLink(items, {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? findTournamentByDeepLink(deepLinkTournament ? [deepLinkTournament] : [], {
        tournamentId: targetTournamentId,
        tournamentSlug: targetSlug,
      })
      ?? null;
    const targetKey = targetTournamentId || targetSlug || "";
    const autoOpenKey = `${targetKey}:${selectedDateStr}`;

    if (autoOpenTournamentKeyRef.current === autoOpenKey) return;
    autoOpenTournamentKeyRef.current = autoOpenKey;

    if (!targetTournament) {
      if (deepLinkLookupPending) return;
      setAutoOpenNotice("Турнир не найден");
      return;
    }

    if (deepLinkTournament && String(deepLinkTournament.id) === String(targetTournament.id)) {
      setDeepLinkTournament(null);
    }
    setAutoOpenNotice(null);
    void handleTournamentOpen(targetTournament);
  }, [
    deepLinkLookupPending,
    deepLinkTournament,
    initialOpenTournamentId,
    items,
    loading,
    openingTournamentId,
    profileLoading,
    selectedDateStr,
    targetTournamentSlug,
    visibleTournaments,
  ]);

  const handleTournamentCreated = (payload: AmericanoTournamentPayload) => {
    const previousHistory = combinedHistoryById[payload.tournamentId] ?? null;
    const nextHistory = buildTournamentHistoryRecordFromPayload(
      payload,
      selectedTournament,
      previousHistory,
    );
    void saveCachedTournamentHistory(nextHistory);
    upsertLocalDraftSnapshot(payload, {
      totals: null,
      playerLogs: null,
    });
    setHistoryById((prev) => ({
      ...prev,
      [payload.tournamentId]: nextHistory,
    }));
    setManagerTotals(null);
    setManagerPlayerLogs(null);
    setManagerData(payload);
  };

  const handleCreateManualTournament = () => {
    setSelectedTournament(null);
    setManagerData(null);
    setManagerTotals(null);
    setManagerPlayerLogs(null);
    setManualTournamentCreationOpen(true);
    setAutoOpenNotice(null);
  };

  const handleManagerDataChange = (
    payload: AmericanoTournamentPayload,
    extras: {
      totals: AmericanoResultsResponse["totals"] | null;
      playerLogs: AmericanoResultsResponse["playerLogs"] | null;
    },
  ) => {
    const currentTournament =
      visibleTournaments.find((item) => String(item.id) === payload.tournamentId) ?? selectedTournament ?? null;
    const nextHistory = buildTournamentHistoryRecordFromPayload(
      payload,
      currentTournament,
      combinedHistoryById[payload.tournamentId] ?? null,
      extras.totals,
      extras.playerLogs,
    );
    void saveCachedTournamentHistory(nextHistory);
    upsertLocalDraftSnapshot(payload, extras);
    setHistoryById((prev) => ({
      ...prev,
      [payload.tournamentId]: nextHistory,
    }));
  };

  const handleManagerDataReplace = (
    payload: AmericanoTournamentPayload,
    extras: {
      totals: AmericanoResultsResponse["totals"] | null;
      playerLogs: AmericanoResultsResponse["playerLogs"] | null;
    },
  ) => {
    const replacementTournament =
      visibleTournaments.find((item) => String(item.id) === payload.tournamentId)
      ?? items.find((item) => String(item.id) === payload.tournamentId)
      ?? (selectedTournament && String(selectedTournament.id) === payload.tournamentId
        ? selectedTournament
        : null)
      ?? null;
    const nextHistory = buildTournamentHistoryRecordFromPayload(
      payload,
      replacementTournament,
      combinedHistoryById[payload.tournamentId] ?? null,
      extras.totals,
      extras.playerLogs,
    );
    void saveCachedTournamentHistory(nextHistory);
    upsertLocalDraftSnapshot(payload, extras);
    setHistoryById((prev) => ({
      ...prev,
      [payload.tournamentId]: nextHistory,
    }));
    setSelectedTournament(replacementTournament);
    setManagerTotals(extras.totals);
    setManagerPlayerLogs(extras.playerLogs);
    setManagerData(payload);
  };

  const handleManagerEditSettings = () => {
    if (!managerData?.tournamentId) return;
    const currentTournament =
      visibleTournaments.find((item) => String(item.id) === managerData.tournamentId)
      ?? serverTournaments.find((item) => String(item.id) === managerData.tournamentId)
      ?? null;
    if (!currentTournament) return;

    setManagerData(null);
    setManagerTotals(null);
    setManagerPlayerLogs(null);
    setSelectedTournament(currentTournament);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    let timeoutId: number | null = null;
    const syncDelayMs = 10_000;

    const updatePendingNotice = async () => {
      const count = await refreshPendingSyncCount();
      if (cancelled) return count;
      if (count > 0) {
        setCacheNotice(formatPendingTournamentSyncNotice(count));
      } else {
        setCacheNotice((current) => (
          current && current.startsWith("Показываем сохранен")
            ? current
            : null
        ));
      }
      return count;
    };

    const syncQueuedResults = async (source: string) => {
      if (navigator.onLine === false) {
        await updatePendingNotice();
        return;
      }

      const result = await processPendingTournamentResultSyncQueue({
        source,
        maxItems: 3,
      });

      if (cancelled) return;

      const count = await updatePendingNotice();
      if (cancelled) return;
      setPendingSyncCount(count);

      if (result.resolved.length > 0) {
        const refreshedHistories = await Promise.all(
          result.resolved.map(async (item) => {
            const cachedHistory = await loadCachedTournamentHistory(item.tournamentId);
            return [item.tournamentId, cachedHistory] as const;
          }),
        );

        if (cancelled) return;

        setHistoryById((prev) => {
          const next = { ...prev };
          refreshedHistories.forEach(([tournamentId, history]) => {
            next[tournamentId] = history;
          });
          return next;
        });

        const activeManagerTournamentId = managerData?.tournamentId
          ? String(managerData.tournamentId)
          : null;
        if (activeManagerTournamentId) {
          const activeHistory = refreshedHistories.find(([tournamentId]) => tournamentId === activeManagerTournamentId)?.[1]
            ?? null;
          if (activeHistory) {
            const restoredPayload = buildTournamentPayloadFromHistory(activeHistory);
            if (restoredPayload) {
              setManagerTotals(activeHistory.totals ?? null);
              setManagerPlayerLogs(activeHistory.playerLogs ?? null);
              setManagerData(restoredPayload);
            }
          }
        }
      }
    };

    const scheduleSync = (source: string) => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        void syncQueuedResults(source);
      }, syncDelayMs);
    };

    void updatePendingNotice().then((count) => {
      if (cancelled) return;
      if (navigator.onLine !== false && count > 0) {
        scheduleSync("tournaments_boot");
      }
    });

    const onOnline = () => {
      scheduleSync("tournaments_online");
    };
    const onFocus = () => {
      scheduleSync("tournaments_focus");
    };
    const onVisibility = () => {
      if (!document.hidden) {
        scheduleSync("tournaments_visible");
      }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [managerData?.tournamentId, refreshPendingSyncCount]);

  return (
    <div className="app-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">{backLabel}</button>
        <div className="page-title">Турниры</div>
      </div>

      <div className="section">
        <div className="section-body tournaments-body">
          {cacheNotice && <div className="tournaments-sync-notice">{cacheNotice}</div>}
          {!cacheNotice && pendingSyncCount > 0 && (
            <div className="tournaments-sync-notice">{formatPendingTournamentSyncNotice(pendingSyncCount)}</div>
          )}
          {canHostTournaments && (
            <div className="tournaments-viva-refresh-toolbar">
              <button
                className={`tournaments-viva-refresh${vivaRefreshPending ? " is-loading" : ""}`}
                type="button"
                onClick={() => void handleVivaRefresh()}
                disabled={vivaRefreshPending || loading}
                aria-busy={vivaRefreshPending}
              >
                <span className="tournaments-viva-refresh-icon" aria-hidden="true">↻</span>
                <span>{vivaRefreshPending ? "Обновляем из Viva..." : "Обновить из Viva"}</span>
              </button>
              <span className="tournaments-viva-refresh-hint">
                Только выбранный день
              </span>
            </div>
          )}
          {vivaRefreshNotice && (
            <div className="tournaments-viva-refresh-notice" role="status" aria-live="polite">
              {vivaRefreshNotice}
            </div>
          )}
          {vivaRefreshError && (
            <div className="tournaments-error" role="alert">{vivaRefreshError}</div>
          )}
          <div className="date-row">
            {dates.map((date, idx) => {
              const monthLabel = date
                .toLocaleDateString("ru-RU", { month: "short" })
                .replace(".", "")
                .trim()
                .slice(0, 3)
                .toUpperCase();
              const weekdayLabel = date
                .toLocaleDateString("ru-RU", { weekday: "short" })
                .replace(".", "")
                .toUpperCase();
              const dayLabel = date.toLocaleDateString("ru-RU", { day: "2-digit" });

              return (
                <div
                  key={date.toISOString()}
                  className="date-item"
                  ref={dateIndex === idx ? activeDateRef : null}
                >
                  <div className="date-weekday">{weekdayLabel}</div>
                  <button
                    className={`date-chip ${dateIndex === idx ? "active" : ""}`}
                    onClick={() => setDateIndex(idx)}
                    type="button"
                  >
                    <div className="booking-date-badge">
                      <div className="booking-date-badge-month">{monthLabel}</div>
                      <div className="booking-date-badge-day">{dayLabel}</div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          {loading && <div className="tournaments-muted">Загрузка...</div>}
          {!loading && error && <div className="tournaments-error">{error}</div>}
          {!loading && !error && autoOpenNotice && (
            <div className="tournaments-muted">{autoOpenNotice}</div>
          )}
          {!loading && profileLoading && !error && (
            <div className="tournaments-muted">Уточняем доступ и ваши турниры...</div>
          )}
          {!loading && !error && visibleTournaments.length === 0 && (
            noTournamentModuleAccess ? (
              <div className="tournaments-access-denied">
                <div className="tournaments-access-denied-title">
                  Нет доступа к модулю "Турниры ПхАБ"
                </div>
                <div className="tournaments-access-denied-text">
                  Вход по коду прошёл, но этот профиль не назначен в турнирную механику.
                  Обратитесь к администратору или войдите под другим номером.
                </div>
              </div>
            ) : (
              <div className="tournaments-muted">На выбранную дату турниров нет</div>
            )
          )}
          {!loading && !error && visibleTournaments.length > 0 && (
            <div className="tournaments-list">
              {!canHostTournaments && (
                <div className="tournaments-muted">
                  Показаны турниры, где вы назначены исполнителем.
                </div>
              )}
              {visibleTournaments.map((ex) => {
                const tournamentId = String(ex.id);
                const historyRecord = combinedHistoryById[tournamentId] ?? null;
                const progressState = getTournamentProgressState(historyRecord);
                const progressLabel = getTournamentProgressLabel(historyRecord);

                return (
                  <button
                    className={`tournament-card${
                      progressState !== "not_started" ? ` tournament-card--${progressState}` : ""
                    }${openingTournamentId === tournamentId ? " is-loading" : ""}`}
                    key={ex.id}
                    type="button"
                    onClick={() => void handleTournamentOpen(ex)}
                    aria-busy={openingTournamentId === tournamentId}
                  >
                    <div className="tournament-card-head">
                      <div className="tournament-title">
                        {ex.direction?.name || ex.type?.name || "Турнир"}
                      </div>
                      {progressLabel && (
                        <span
                          className={`tournament-card-status tournament-card-status--${progressState}`}
                        >
                          {progressLabel}
                        </span>
                      )}
                    </div>
                  <div className="tournament-row">
                    <span>{formatTime(ex.timeFrom)} – {formatTime(ex.timeTo)}</span>
                    {ex.studio?.name && <span>{ex.studio.name}</span>}
                  </div>
                  {ex.trainers?.[0] && (
                    <div className="tournament-trainer">
                      Исполнитель: {ex.trainers[0].firstName} {ex.trainers[0].lastName}
                    </div>
                  )}
                  {ex.studio?.address && (
                    <div className="tournament-address">{ex.studio.address}</div>
                  )}
                  {historyRecord?.publishedCommunities && historyRecord.publishedCommunities.length > 0 && (
                    <div className="tournament-community-publications" aria-label="Сообщества публикации">
                      <span className="tournament-community-publications__label">Опубликован:</span>
                      {historyRecord.publishedCommunities.map((publication) => (
                        <span
                          className={`tournament-community-chip${
                            publication.communityId === historyRecord.ratingCommunityId
                              ? " tournament-community-chip--rating"
                              : ""
                          }`}
                          key={publication.communityId}
                          title={`ID сообщества: ${publication.communityId}`}
                        >
                          {publication.communityName || publication.communityId}
                        </span>
                      ))}
                      {historyRecord.ratingCommunityStatus === "AMBIGUOUS" && (
                        <span className="tournament-community-warning">Нужно выбрать рейтинговое сообщество</span>
                      )}
                    </div>
                  )}
                  </button>
                );
              })}
            </div>
          )}
          {!loading && (
            <button
              className="section-cta"
              type="button"
              onClick={handleCreateManualTournament}
            >
              Создать турнир
            </button>
          )}
        </div>
      </div>

      <TournamentDetailsModal
        isOpen={Boolean(selectedTournament) || manualTournamentCreationOpen}
        onClose={() => {
          setSelectedTournament(null);
          setManualTournamentCreationOpen(false);
        }}
        tournament={selectedTournament}
        historyRecord={selectedTournament ? combinedHistoryById[String(selectedTournament.id)] ?? null : null}
        sourceDateKey={selectedDateStr}
        canRefreshParticipantsFromViva={canHostTournaments}
        onSaved={handleTournamentCreated}
      />

      <TournamentManagerModal
        isOpen={Boolean(managerData)}
        onClose={() => {
          setManagerData(null);
          setManagerTotals(null);
          setManagerPlayerLogs(null);
        }}
        data={managerData}
        title={managerData ? getTournamentTypeLabel(managerData.tournamentType) : "Турнир"}
        initialTotals={managerTotals}
        initialPlayerLogs={managerPlayerLogs}
        onDataChange={handleManagerDataChange}
        onReplaceData={handleManagerDataReplace}
        onEditSettings={handleManagerEditSettings}
      />
    </div>
  );
}
