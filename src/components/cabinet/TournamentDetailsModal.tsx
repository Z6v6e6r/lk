import { useEffect, useMemo, useState } from "react";
import { Modal } from "../UI/Modal";
import { apiFetchPadelLiveRatings, apiFetchTournamentParticipants } from "../../utils/apiClient";
import { getLetterGrade } from "../../utils/customFields";
import type {
  Booking,
  ExerciseBooking,
  PadelLiveRatingItem,
  TournamentHistoryParticipant,
  TournamentHistoryRecord,
  Trainer,
} from "../../utils/apiClient";

type TournamentDetailsTab = "roster" | "rules" | "results";

type TournamentParticipantView = {
  key: string;
  clientId: string | null;
  order: number;
  name: string;
  photo: string | null;
  rating: string | null;
  ratingNumeric?: number | null;
};

type TournamentDisplayMeta = {
  tournamentTypeLabel: string;
  levelLabel: string | null;
  genderLabel: string;
  participantsLabel: string;
  formatLabel: string;
  targetScoreLabel: string;
  courtsLabel: string;
};

type TournamentResultRow = {
  key: string;
  rank: number;
  name: string;
  photo: string | null;
  rating: string | null;
  wins: number | null;
  losses: number | null;
  draws: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  delta: number | null;
};

type TournamentResultSortableRow = Omit<TournamentResultRow, "rank"> & {
  tournamentPoints: number | null;
  sourceRank?: number | null;
};

type TournamentStandingSortableRow = TournamentResultSortableRow & {
  sourceRank: number | null;
};

type TournamentResultsSortMode = "point_diff" | "total_points";

interface TournamentDetailsModalProps {
  isOpen: boolean;
  booking: Booking | null;
  customTournament?: TournamentHistoryRecord | null;
  onClose: () => void;
}

const TABS: Array<{ id: TournamentDetailsTab; label: string }> = [
  { id: "roster", label: "Состав" },
  { id: "rules", label: "Регламент" },
  { id: "results", label: "Результат" },
];

function extractTournamentBookings(data: unknown): ExerciseBooking[] {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];

  const directKeys = ["payload", "content", "data", "result", "items", "records", "participants", "bookings"];
  for (const key of directKeys) {
    const candidate = data[key];
    if (Array.isArray(candidate)) return candidate as ExerciseBooking[];
    if (isRecord(candidate)) {
      const nested = extractTournamentBookings(candidate);
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

function formatTimeValue(value?: string | null): string {
  if (!value) return "";
  const directMatch = value.match(/(\d{2}:\d{2})/);
  if (directMatch?.[1]) return directMatch[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatTimeRange(timeFrom?: string | null, timeTo?: string | null): string {
  const from = formatTimeValue(timeFrom);
  const to = formatTimeValue(timeTo);
  if (from && to) return `${from} – ${to}`;
  return from || to || "Время уточняется";
}

function getTournamentTitle(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const customTitle = customTournament?.title?.trim();
  if (customTitle) return customTitle;
  return booking.exercise?.direction?.name?.trim() || booking.exercise?.type?.name?.trim() || "Турнир";
}

function humanizeTournamentType(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  if (lowered.includes("американо") || lowered.includes("americano")) return "Американо";
  if (lowered.includes("мексикано") || lowered.includes("mexicano")) return "Мексикано";
  if (
    lowered.includes("paired")
    || lowered.includes("парный мексикано")
    || lowered.includes("парное мексикано")
  ) return "Парный мексикано";
  if (lowered.includes("round robin")) return "Round robin";
  if (lowered.includes("олимп")) return "Олимпийка";
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function pickRecord(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    if (isRecord(source[key])) return source[key] as Record<string, unknown>;
  }
  return null;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickStringValue(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) return "";
  for (const key of keys) {
    const value = toTrimmedString(source[key]);
    if (value) return value;
  }
  return "";
}

function pickNumberValue(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace(",", ".").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => toTrimmedString(item)).filter(Boolean)
    : [];
}

function formatAccessLevelRange(value: unknown) {
  const levels = normalizeStringArray(value).map((item) => normalizeLevelValue(item) || item);
  if (levels.length === 0) return null;
  if (levels.length === 1) return levels[0];
  return `${levels[0]}/${levels[levels.length - 1]}`;
}

function normalizeTournamentGenderLabel(value: string | null | undefined): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (["male", "men", "m", "м", "мужской", "мужчины"].includes(normalized)) return "Мужчины";
  if (["female", "women", "f", "ж", "женский", "женщины"].includes(normalized)) return "Женщины";
  if (["mixed", "mix", "микст", "м/ж"].includes(normalized)) return "М/Ж";
  if (["any", "all", "open", "любой", "любой пол", "без ограничений"].includes(normalized)) return "М/Ж";
  return String(value || "").trim();
}

function getBookingExerciseMeta(booking: Booking) {
  const exerciseRecord = (booking.exercise && typeof booking.exercise === "object")
    ? booking.exercise as unknown as Record<string, unknown>
    : null;
  const settings = pickRecord(exerciseRecord, ["settings", "meta", "metadata"]) ?? {};
  const params = pickRecord(exerciseRecord, ["params", "payload", "config"]) ?? {};
  const skin = pickRecord(exerciseRecord, ["skin", "tournamentSkin"])
    ?? pickRecord(settings, ["skin", "tournamentSkin"])
    ?? pickRecord(params, ["skin", "tournamentSkin"])
    ?? {};

  return { exerciseRecord, settings, params, skin };
}

function normalizeLevelToken(value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return "";
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(trimmed)) {
    const numeric = Number.parseFloat(trimmed.replace(",", "."));
    if (Number.isFinite(numeric)) return getLetterGrade(numeric);
  }
  const normalizedSuperscripts = trimmed
    .replace(/¹/g, "1")
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/⁴/g, "4");
  const match = normalizedSuperscripts.match(/^([A-D])\s*([1-4])?\s*(\+)?$/);
  if (match) {
    const [, letter, digit = "1", plus = ""] = match;
    return `${letter}${digit}${plus}`;
  }
  return normalizedSuperscripts;
}

function normalizeLevelValue(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const parts = normalized.split(/([/–-])/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.map((part) => (part === "/" || part === "–" || part === "-" ? (part === "-" ? "–" : part) : normalizeLevelToken(part))).join("");
}

function renderLevelText(value: string | null | undefined) {
  const normalized = normalizeLevelValue(value);
  if (!normalized) return "—";
  return normalized.split(/([/–])/).filter(Boolean).map((token, index) => {
    const match = token.match(/^([A-D])([1-4])?(\+)?$/);
    if (!match) return <span key={`${token}-${index}`}>{token}</span>;
    const superscriptMap: Record<string, string> = {
      "1": "¹",
      "2": "²",
      "3": "³",
      "4": "⁴",
    };
    return (
      <span key={`${token}-${index}`}>
        {match[1]}
        {match[2] ? superscriptMap[match[2]] : null}
        {match[3] || null}
      </span>
    );
  });
}

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isPhoneLikeRatingValue(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10;
}

function sanitizeTournamentParticipant(participant: ExerciseBooking): ExerciseBooking {
  const raw = participant as ExerciseBooking & { ratingSource?: string | null };
  const shouldDropRating =
    String(raw.ratingSource || "").trim().toLowerCase() === "phone"
    || isPhoneLikeRatingValue(raw.rating);

  return {
    ...participant,
    rating: shouldDropRating ? undefined : participant.rating,
    ratingSource: shouldDropRating ? undefined : participant.ratingSource,
    client: participant.client
      ? {
          ...participant.client,
          phone: undefined,
        }
      : participant.client,
  };
}

function buildParticipantIdentityKey(clientId: string | null | undefined, phone: string | null | undefined, name: string) {
  const safeClientId = String(clientId || "").trim();
  if (safeClientId) return `id:${safeClientId}`;
  const safePhone = normalizePhone(phone);
  if (safePhone) return `phone:${safePhone}`;
  return `name:${name.trim().toLowerCase()}`;
}

function resolveParticipantRawRating(participant: ExerciseBooking): { rating: string | null; ratingNumeric: number | null } {
  const raw = participant as ExerciseBooking & {
    ratingNumeric?: number | string | null;
    numericRating?: number | string | null;
    levelNumeric?: number | string | null;
    level?: string | null;
    grade?: string | null;
    ratingSource?: string | null;
  };

  const rating =
    String(raw.ratingSource || "").trim().toLowerCase() === "phone"
      ? null
      : participant.rating
        || (typeof raw.level === "string" ? raw.level : null)
        || (typeof raw.grade === "string" ? raw.grade : null)
        || null;

  const numericCandidate = raw.ratingNumeric ?? raw.numericRating ?? raw.levelNumeric ?? null;
  const ratingNumeric =
    typeof numericCandidate === "number"
      ? (Number.isFinite(numericCandidate) ? numericCandidate : null)
      : typeof numericCandidate === "string"
        ? (() => {
            const parsed = Number.parseFloat(numericCandidate.replace(",", "."));
            return Number.isFinite(parsed) ? parsed : null;
          })()
        : null;

  return {
    rating: isPhoneLikeRatingValue(rating) ? null : rating,
    ratingNumeric,
  };
}

function buildTournamentLevelLabel(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const { exerciseRecord, settings, params, skin } = getBookingExerciseMeta(booking);
  const explicit =
    pickStringValue(skin, ["levelLabel", "ratingLabel", "level", "rating"])
    || formatAccessLevelRange(skin.accessLevels)
    || pickStringValue(settings, ["levelLabel", "ratingLabel", "minRating", "ratingFrom"])
    || formatAccessLevelRange(settings.accessLevels)
    || pickStringValue(params, ["levelLabel", "ratingLabel", "minRating", "ratingFrom"])
    || formatAccessLevelRange(params.accessLevels)
    || pickStringValue(exerciseRecord, ["levelLabel", "ratingLabel", "minRating", "ratingFrom"])
    || formatAccessLevelRange(exerciseRecord?.accessLevels);
  if (explicit) return normalizeLevelValue(explicit) || explicit;

  const min = normalizeLevelValue(customTournament?.minRating ?? null);
  const max = normalizeLevelValue(customTournament?.maxRating ?? null);
  if (min && max) return min === max ? min : `${min}/${max}`;
  if (min || max) return min || max || null;
  const text = `${booking.exercise?.direction?.name || ""} ${booking.exercise?.type?.name || ""}`;
  const rangeMatch = text.match(/\b([A-D]\+?)\s*[–/-]\s*([A-D]\+?)\b/i);
  if (rangeMatch) return `${rangeMatch[1].toUpperCase()}/${rangeMatch[2].toUpperCase()}`;
  const singleMatch = text.match(/\b([A-D]\+?)\b/i);
  if (singleMatch?.[1]) return singleMatch[1].toUpperCase();
  return null;
}

function getTournamentDisplayMeta(
  booking: Booking,
  customTournament: TournamentHistoryRecord | null | undefined,
): TournamentDisplayMeta {
  const { exerciseRecord, settings, params, skin } = getBookingExerciseMeta(booking);
  const joined = Math.max(
    customTournament?.participantsCount ?? 0,
    pickNumberValue(skin, ["participantsCount", "clientsCount", "joinedCount"]) ?? 0,
    pickNumberValue(settings, ["participantsCount", "clientsCount", "joinedCount"]) ?? 0,
    pickNumberValue(params, ["participantsCount", "clientsCount", "joinedCount"]) ?? 0,
    booking.exercise?.clientsCount ?? 0,
  );
  const total =
    customTournament?.maxParticipants
    ?? pickNumberValue(skin, ["maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit"])
    ?? pickNumberValue(settings, ["maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit"])
    ?? pickNumberValue(params, ["maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit"])
    ?? pickNumberValue(exerciseRecord, ["maxPlayers", "maxParticipants", "maxClientsCount", "playersLimit", "limit"])
    ?? booking.exercise?.maxClientsCount
    ?? null;

  const tournamentTypeLabel =
    humanizeTournamentType(
      pickStringValue(skin, ["tournamentTypeLabel", "tournamentType", "formatLabel", "format", "type"])
      || pickStringValue(settings, ["tournamentTypeLabel", "tournamentType", "formatLabel", "format", "type"])
      || pickStringValue(params, ["tournamentTypeLabel", "tournamentType", "formatLabel", "format", "type"])
      || customTournament?.tournamentType
      || booking.exercise?.type?.name
      || booking.exercise?.direction?.name
      || null,
    ) || "Турнир";

  const genderLabel =
    normalizeTournamentGenderLabel(
      pickStringValue(skin, ["genderLabel", "gender", "category"])
      || pickStringValue(settings, ["genderLabel", "gender", "category"])
      || pickStringValue(params, ["genderLabel", "gender", "category"])
      || customTournament?.genderLabel
      || "",
    )
    || (customTournament?.mixed ? "М/Ж" : "")
    || (customTournament?.girlsOnly || booking.exercise?.girlsOnly ? "Женщины" : "")
    || "М/Ж";

  const formatLabel =
    humanizeTournamentType(
      pickStringValue(skin, ["formatLabel", "pairingLabel", "gameFormat"])
      || pickStringValue(settings, ["formatLabel", "pairingLabel", "gameFormat"])
      || pickStringValue(params, ["formatLabel", "pairingLabel", "gameFormat"])
      || "",
    )
    || (
      String(
        pickStringValue(skin, ["pairMode", "teamMode"])
        || pickStringValue(settings, ["pairMode", "teamMode"])
        || pickStringValue(params, ["pairMode", "teamMode"])
        || "",
      ).toLowerCase().includes("single")
        ? "Одиночный"
        : "Парный"
    );

  const targetScoreValue =
    customTournament?.targetScore
    ?? pickNumberValue(skin, ["targetScore", "scoreTarget"])
    ?? pickNumberValue(settings, ["targetScore", "scoreTarget"])
    ?? pickNumberValue(params, ["targetScore", "scoreTarget"])
    ?? null;

  const levelLabel = buildTournamentLevelLabel(booking, customTournament);
  const participantsLabel = total && total > 0 ? `${joined}/${Math.floor(total)} мест` : `${joined} участников`;
  const courtsLabel = customTournament?.courts?.length
    ? customTournament.courts.join(", ")
    : pickStringValue(skin, ["courtsLabel"])
      || pickStringValue(settings, ["courtsLabel"])
      || pickStringValue(params, ["courtsLabel"])
      || booking.exercise?.room?.name
      || "—";

  return {
    tournamentTypeLabel,
    levelLabel,
    genderLabel,
    participantsLabel,
    formatLabel,
    targetScoreLabel: targetScoreValue != null ? String(Math.floor(targetScoreValue)) : "—",
    courtsLabel,
  };
}

function getTournamentDescription(
  booking: Booking,
  customTournament: TournamentHistoryRecord | null | undefined,
): string | null {
  const { exerciseRecord, settings, params, skin } = getBookingExerciseMeta(booking);
  const customParams = isRecord(customTournament?.params) ? customTournament.params : null;
  const customSummary = isRecord(customTournament?.summary) ? customTournament.summary : null;

  return pickStringValue(skin, ["description", "body", "text", "details", "desc"])
    || pickStringValue(settings, ["description", "body", "text", "details", "desc"])
    || pickStringValue(params, ["description", "body", "text", "details", "desc"])
    || pickStringValue(customParams, ["description", "body", "text", "details", "desc"])
    || pickStringValue(customSummary, ["description", "body", "text", "details", "desc"])
    || pickStringValue(exerciseRecord, ["description", "body", "text", "details", "desc"])
    || null;
}

function getTrainerName(trainer: Trainer | null | undefined): string {
  if (!trainer) return "Исполнитель не назначен";
  return [trainer.firstName, trainer.lastName].filter(Boolean).join(" ").trim() || "Исполнитель";
}

function getTrainerPhoto(trainer: Trainer | null | undefined): string | null {
  return trainer?.photo || null;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

function normalizeParticipantKey(id: string | null, phone: string | null, name: string): string {
  if (id) return `id:${id}`;
  if (phone) return `phone:${phone}`;
  return `name:${name.trim().toLowerCase()}`;
}

function buildParticipantList(
  liveParticipants: ExerciseBooking[],
  historyParticipants: TournamentHistoryParticipant[],
  liveRatingsMap: Map<string, PadelLiveRatingItem>,
): TournamentParticipantView[] {
  const map = new Map<string, TournamentParticipantView>();

  liveParticipants
    .filter((participant) => {
      const raw = participant as ExerciseBooking & {
        cancelled?: boolean;
        canceled?: boolean;
        status?: string | null;
        state?: string | null;
      };
      const status = String(raw.status ?? raw.state ?? "").trim().toLowerCase();
      return !(
        participant.isCancelled
        || raw.cancelled
        || raw.canceled
        || status === "cancelled"
        || status === "canceled"
        || status === "cancel"
      );
    })
    .forEach((participant, index) => {
      const firstName = participant.client?.firstName || "";
      const lastName = participant.client?.lastName || "";
      const name = `${firstName} ${lastName}`.trim() || `Участник ${index + 1}`;
      const key = normalizeParticipantKey(participant.client?.id || null, null, name);
      const liveRating = liveRatingsMap.get(
        buildParticipantIdentityKey(participant.client?.id || null, null, name),
      ) || null;
      const rawRating = resolveParticipantRawRating(participant);
      map.set(key, {
        key,
        clientId: participant.client?.id || null,
        order: typeof participant.spot === "number" && Number.isFinite(participant.spot) ? participant.spot : index + 1,
        name,
        photo: participant.client?.photo || null,
        rating: liveRating?.rating || rawRating.rating || null,
        ratingNumeric: liveRating?.ratingNumeric ?? rawRating.ratingNumeric ?? null,
      });
    });

  const fallbackOrderBase = map.size;
  historyParticipants.forEach((participant, index) => {
    const key = normalizeParticipantKey(participant.id, null, participant.name);
    if (map.has(key)) return;
    map.set(key, {
      key,
      clientId: participant.id,
      order: fallbackOrderBase + index + 1,
      name: participant.name,
      photo: participant.photo,
      rating: isPhoneLikeRatingValue(participant.rating) ? null : participant.rating,
      ratingNumeric: null,
    });
  });

  return Array.from(map.values()).sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.name.localeCompare(right.name, "ru");
  });
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTournamentResultsSortMode(
  customTournament: TournamentHistoryRecord | null | undefined,
): TournamentResultsSortMode {
  const params = isRecord(customTournament?.params) ? customTournament.params : null;
  const summary = isRecord(customTournament?.summary) ? customTournament.summary : null;
  const toText = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const toTruthy = (value: unknown) => (
    value === true
    || value === 1
    || value === "1"
    || toText(value) === "true"
  );
  const toMode = (value: unknown): TournamentResultsSortMode | null => {
    const normalized = toText(value).replace(/\s+/g, "_");
    if (!normalized) return null;
    if (
      normalized === "total_points"
      || normalized === "points"
      || normalized === "points_for"
      || normalized === "pointsfor"
      || normalized === "по_очкам"
      || normalized === "набранные_очки"
      || normalized === "набранныеочки"
    ) {
      return "total_points";
    }
    if (
      normalized === "point_diff"
      || normalized === "points_diff"
      || normalized === "difference"
      || normalized === "diff"
      || normalized === "по_разнице"
      || normalized === "разница"
      || normalized === "разница_очков"
    ) {
      return "point_diff";
    }
    return null;
  };

  const winnerModeCandidates = [
    params?.winnerSortMode,
    params?.winnerSortBy,
    params?.winnerBy,
    params?.winnerCriteria,
    params?.winnerMode,
    params?.championBy,
    params?.winnerRankingMode,
    params?.finalRankBy,
    params?.finalStandingsSort,
    summary?.winnerSortMode,
    summary?.winnerSortBy,
    summary?.winnerBy,
    summary?.winnerCriteria,
    summary?.winnerMode,
    summary?.championBy,
    summary?.winnerRankingMode,
    summary?.finalRankBy,
    summary?.finalStandingsSort,
  ];
  for (const candidate of winnerModeCandidates) {
    const mode = toMode(candidate);
    if (mode) return mode;
  }

  const explicitPointsFlag = [
    params?.winnerByTotalPoints,
    params?.sortByTotalPoints,
    params?.useTotalPointsRanking,
    summary?.winnerByTotalPoints,
    summary?.sortByTotalPoints,
    summary?.useTotalPointsRanking,
  ].some((value) => toTruthy(value));
  if (explicitPointsFlag) return "total_points";

  const explicitPointDiffFlag = [
    params?.winnerByPointDiff,
    params?.sortByPointDiff,
    params?.usePointDiffRanking,
    summary?.winnerByPointDiff,
    summary?.sortByPointDiff,
    summary?.usePointDiffRanking,
  ].some((value) => toTruthy(value));
  if (explicitPointDiffFlag) return "point_diff";

  const modeCandidates = [
    params?.resultsSortMode,
    params?.rankingMode,
    params?.rankBy,
    params?.standingsSort,
    summary?.resultsSortMode,
    summary?.rankingMode,
    summary?.rankBy,
    summary?.standingsSort,
  ];
  for (const candidate of modeCandidates) {
    const mode = toMode(candidate);
    if (mode) return mode;
  }

  return "point_diff";
}

function buildResultRows(
  customTournament: TournamentHistoryRecord | null | undefined,
  participants: TournamentParticipantView[],
): TournamentResultRow[] {
  const sortMode = resolveTournamentResultsSortMode(customTournament);
  const participantMap = new Map<string, TournamentParticipantView>();
  participants.forEach((participant) => {
    participantMap.set(participant.key, participant);
    participantMap.set(`name:${participant.name.trim().toLowerCase()}`, participant);
    if (participant.clientId) participantMap.set(participant.clientId, participant);
  });

  const compareResultRows = (
    left: TournamentResultSortableRow,
    right: TournamentResultSortableRow,
  ) => {
    if (sortMode === "total_points") {
      const pointsDiff = (right.tournamentPoints ?? 0) - (left.tournamentPoints ?? 0);
      if (pointsDiff !== 0) return pointsDiff;
    }
    const pointDiff =
      ((right.pointsFor ?? 0) - (right.pointsAgainst ?? 0))
      - ((left.pointsFor ?? 0) - (left.pointsAgainst ?? 0));
    if (pointDiff !== 0) return pointDiff;
    if (sortMode !== "total_points") {
      const pointsDiff = (right.tournamentPoints ?? 0) - (left.tournamentPoints ?? 0);
      if (pointsDiff !== 0) return pointsDiff;
    }
    const winsDiff = (right.wins ?? Number.NEGATIVE_INFINITY) - (left.wins ?? Number.NEGATIVE_INFINITY);
    if (winsDiff !== 0) return winsDiff;
    const deltaDiff = (right.delta ?? Number.NEGATIVE_INFINITY) - (left.delta ?? Number.NEGATIVE_INFINITY);
    if (deltaDiff !== 0) return deltaDiff;
    const leftRank = left.sourceRank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.sourceRank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.name.localeCompare(right.name, "ru");
  };

  const totals = customTournament?.totals;
  if (totals && typeof totals === "object") {
    const rows = Object.entries(totals)
      .map(([key, value]) => {
        if (!isRecord(value)) return null;
        const fallbackParticipant =
          participantMap.get(key)
          || participantMap.get(`name:${key.trim().toLowerCase()}`)
          || participantMap.get(normalizePhone(key) || "")
          || null;
        return {
          key,
          name: fallbackParticipant?.name || key,
          photo: fallbackParticipant?.photo || null,
          rating: fallbackParticipant?.rating || null,
          wins: parseNumber(value.wins),
          losses: parseNumber(value.losses),
          draws: parseNumber(value.draws),
          tournamentPoints: parseNumber(value.tournamentPoints ?? value.playedPoints ?? value.pointsFor),
          pointsFor: parseNumber(value.pointsFor),
          pointsAgainst: parseNumber(value.pointsAgainst),
          delta: parseNumber(value.deltaTotal),
        } satisfies TournamentResultSortableRow;
      })
      .filter((row): row is TournamentResultSortableRow => row !== null)
      .sort((left, right) => compareResultRows(left, right));

    return rows.map(({ tournamentPoints, sourceRank, ...row }, index) => ({ ...row, rank: index + 1 }));
  }

  if (Array.isArray(customTournament?.standings)) {
    const rows = customTournament.standings
      .map((item, index) => {
        if (!isRecord(item)) return null;
        const rawName = String(item.name || item.player || item.title || `Игрок ${index + 1}`).trim();
        const fallbackParticipant = participantMap.get(`name:${rawName.toLowerCase()}`) || null;
        return {
          key: String(item.id || rawName || index),
          sourceRank: parseNumber(item.rank ?? item.place ?? item.position),
          name: rawName,
          photo: typeof item.photo === "string" ? item.photo : fallbackParticipant?.photo || null,
          rating: typeof item.rating === "string" ? item.rating : fallbackParticipant?.rating || null,
          wins: parseNumber(item.wins),
          losses: parseNumber(item.losses),
          draws: parseNumber(item.draws),
          tournamentPoints: parseNumber(item.tournamentPoints ?? item.totalPoints ?? item.playedPoints ?? item.pointsFor ?? item.points),
          pointsFor: parseNumber(item.pointsFor ?? item.points),
          pointsAgainst: parseNumber(item.pointsAgainst),
          delta: parseNumber(item.delta ?? item.deltaTotal),
        } satisfies TournamentStandingSortableRow;
      })
      .filter((row): row is TournamentStandingSortableRow => row !== null)
      .sort((left, right) => compareResultRows(left, right));

    return rows.map(({ sourceRank, tournamentPoints, ...row }, index) => ({ ...row, rank: index + 1 }));
  }

  return [];
}

function formatNumberValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(".", ",");
}

function formatSignedNumberValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumberValue(value)}`;
}

function getResultDeltaClass(value: number | null) {
  if ((value ?? 0) > 0) return "is-positive";
  if ((value ?? 0) < 0) return "is-negative";
  return "is-neutral";
}

function getPointDifference(pointsFor: number | null, pointsAgainst: number | null): number | null {
  if (pointsFor == null || pointsAgainst == null) return null;
  if (!Number.isFinite(pointsFor) || !Number.isFinite(pointsAgainst)) return null;
  return pointsFor - pointsAgainst;
}

function buildRulesRows(meta: TournamentDisplayMeta) {
  return [
    { label: "Тип турнира", value: meta.tournamentTypeLabel },
    { label: "Уровень", value: meta.levelLabel ? renderLevelText(meta.levelLabel) : "—" },
    { label: "Пол", value: meta.genderLabel },
    { label: "Формат", value: meta.formatLabel },
    { label: "Участники", value: meta.participantsLabel },
    { label: "Целевой счёт", value: meta.targetScoreLabel },
    { label: "Корты", value: meta.courtsLabel },
  ];
}

export function TournamentDetailsModal({
  isOpen,
  booking,
  customTournament = null,
  onClose,
}: TournamentDetailsModalProps) {
  const [activeTab, setActiveTab] = useState<TournamentDetailsTab>("roster");
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ExerciseBooking[]>([]);
  const [liveRatingsMap, setLiveRatingsMap] = useState<Map<string, PadelLiveRatingItem>>(new Map());

  useEffect(() => {
    if (!isOpen) {
      setActiveTab("roster");
      return;
    }
    const exerciseId = booking?.exercise?.id;
    if (!exerciseId) {
      setParticipants([]);
      setParticipantsError(null);
      setParticipantsLoading(false);
      return;
    }

    let alive = true;
    setParticipantsLoading(true);
    setParticipantsError(null);
    void apiFetchTournamentParticipants(exerciseId)
      .then(async (result) => {
        if (!alive) return;
        if (result.error) {
          setParticipants([]);
          setLiveRatingsMap(new Map());
          setParticipantsError(result.error.message || "Не удалось загрузить состав");
          return;
        }
        const nextParticipants = extractTournamentBookings(result.data)
          .map((participant) => sanitizeTournamentParticipant(participant));
        setParticipants(nextParticipants);

        const ratingPlayers = nextParticipants.map((participant, index) => {
          const firstName = participant.client?.firstName || "";
          const lastName = participant.client?.lastName || "";
          const name = `${firstName} ${lastName}`.trim() || `Участник ${index + 1}`;
          const rawRating = resolveParticipantRawRating(participant);
          return {
            clientId: participant.client?.id || null,
            phone: null,
            name,
            rating: rawRating.rating,
            ratingNumeric: rawRating.ratingNumeric,
          };
        }).filter((player) => player.clientId);

        if (ratingPlayers.length === 0) {
          setLiveRatingsMap(new Map());
          return;
        }

        const liveRatingsResult = await apiFetchPadelLiveRatings(ratingPlayers);
        const nextRatingsMap = new Map<string, PadelLiveRatingItem>();
        (liveRatingsResult.data ?? []).forEach((item) => {
          const key = buildParticipantIdentityKey(item.clientId, null, item.name || "");
          nextRatingsMap.set(key, item);
        });
        setLiveRatingsMap(nextRatingsMap);
      })
      .catch(() => {
        if (!alive) return;
        setParticipants([]);
        setLiveRatingsMap(new Map());
        setParticipantsError("Не удалось загрузить состав");
      })
      .finally(() => {
        if (alive) {
          setParticipantsLoading(false);
        }
      });

    return () => {
      alive = false;
    };
  }, [booking?.exercise?.id, isOpen]);

  const trainer = booking?.exercise?.trainers?.[0] ?? null;
  const roster = useMemo(
    () => buildParticipantList(participants, customTournament?.participants ?? [], liveRatingsMap),
    [customTournament?.participants, liveRatingsMap, participants],
  );
  const resultRows = useMemo(
    () => buildResultRows(customTournament, roster),
    [customTournament, roster],
  );

  if (!booking) return null;

  const title = getTournamentTitle(booking, customTournament);
  const subtitle = [booking.exercise?.studio?.city, booking.exercise?.studio?.address].filter(Boolean).join(", ");
  const displayMeta = getTournamentDisplayMeta(booking, customTournament);
  const rulesRows = buildRulesRows(displayMeta);
  const tournamentDescription = getTournamentDescription(booking, customTournament);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      variant="fullscreen"
      hideHeader
      bodyClassName="modal-body--tournament-details"
    >
      <div className="tournament-details-screen">
        <div className="tournament-details-header">
          <div className="tournament-details-header-top">
            <h2 className="tournament-details-title">{title}</h2>
            <button type="button" className="tournament-details-close" onClick={onClose} aria-label="Закрыть">
              ✕
            </button>
          </div>
          <div className="tournament-details-meta">
            <span>{formatTimeRange(booking.exercise?.timeFrom, booking.exercise?.timeTo)}</span>
            {booking.exercise?.studio?.name ? <span>{booking.exercise.studio.name}</span> : null}
          </div>
          {subtitle ? <div className="tournament-details-address">г {subtitle}</div> : null}
        </div>

        <div className="tournament-details-tabs" role="tablist" aria-label="Разделы турнира">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tournament-details-tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "roster" && (
          <div className="tournament-details-section">
            <div className="tournament-details-block">
              <div className="tournament-details-block-title">Исполнитель</div>
              <div className="tournament-details-person-card">
                <div className="tournament-details-avatar">
                  {getTrainerPhoto(trainer) ? (
                    <img src={getTrainerPhoto(trainer) || ""} alt={getTrainerName(trainer)} />
                  ) : (
                    <span>{getInitials(getTrainerName(trainer))}</span>
                  )}
                </div>
                <div className="tournament-details-person-main">
                  <div className="tournament-details-person-name">{getTrainerName(trainer)}</div>
                  <div className="tournament-details-person-role">Исполнитель</div>
                </div>
                <div className="tournament-details-person-badge">Тренер</div>
              </div>
              {tournamentDescription ? (
                <div className="details-match-comment tournament-details-description" aria-label="Описание турнира">
                  <span className="details-match-comment-quote" aria-hidden="true">“</span>
                  <span>{tournamentDescription}</span>
                  <span className="details-match-comment-quote" aria-hidden="true">”</span>
                </div>
              ) : null}
            </div>

            <div className="tournament-details-block">
              <div className="tournament-details-block-head">
                <div className="tournament-details-block-title">Участники</div>
                {displayMeta.levelLabel ? (
                  <div className="tournament-details-level-chip">{renderLevelText(displayMeta.levelLabel)}</div>
                ) : null}
              </div>

              {participantsLoading && <div className="tournament-details-empty">Загружаем состав...</div>}
              {!participantsLoading && participantsError && roster.length === 0 && (
                <div className="tournament-details-empty">{participantsError}</div>
              )}
              {!participantsLoading && participantsError && roster.length > 0 && (
                <div className="tournament-details-empty">{participantsError}</div>
              )}
              {!participantsLoading && !participantsError && roster.length === 0 && (
                <div className="tournament-details-empty">Состав пока не сформирован</div>
              )}
              {!participantsLoading && !participantsError && roster.length > 0 && (
                <div className="tournament-details-list">
                  {roster.map((participant) => (
                    <div key={participant.key} className="tournament-details-row">
                      <div className="tournament-details-row-order">{participant.order}</div>
                      <div className="tournament-details-avatar">
                        {participant.photo ? (
                          <img src={participant.photo} alt={participant.name} />
                        ) : (
                          <span>{getInitials(participant.name)}</span>
                        )}
                      </div>
                      <div className="tournament-details-row-name">{participant.name}</div>
                      <div className="tournament-details-rating-pill">{renderLevelText(participant.rating)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "rules" && (
          <div className="tournament-details-section">
            <div className="tournament-details-rules">
              {rulesRows.map((row) => (
                <div key={row.label} className="tournament-details-rule-row">
                  <div className="tournament-details-rule-label">{row.label}</div>
                  <div className="tournament-details-rule-value">{row.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "results" && (
          <div className="tournament-details-section">
            {resultRows.length === 0 ? (
              <div className="tournament-details-empty">Результаты пока не опубликованы</div>
            ) : (
              <div className="tournament-details-results">
                {resultRows.map((row) => {
                  const pointsDiff = getPointDifference(row.pointsFor, row.pointsAgainst);
                  return (
                    <div key={row.key} className="tournament-details-result-row">
                      <div className="tournament-details-result-rank">{row.rank}</div>
                      <div className="tournament-details-result-avatar-wrap">
                        <div className={`tournament-details-avatar-ring${row.rating ? " has-level" : ""}`}>
                          <div className="tournament-details-avatar tournament-details-avatar--result">
                            {row.photo ? (
                              <img src={row.photo} alt={row.name} />
                            ) : (
                              <span>{getInitials(row.name)}</span>
                            )}
                          </div>
                        </div>
                        {row.rating ? (
                          <div className="tournament-details-result-avatar-badge">{renderLevelText(row.rating)}</div>
                        ) : null}
                      </div>
                      <div className="tournament-details-result-main">
                        <div className="tournament-details-result-name">{row.name}</div>
                        <div className="tournament-details-result-stats">
                          <span className="is-win">В {formatNumberValue(row.wins)}</span>
                          <span>Н {formatNumberValue(row.draws)}</span>
                          <span className="is-loss">П {formatNumberValue(row.losses)}</span>
                        </div>
                      </div>
                      <div className="tournament-details-result-side tournament-details-result-side--points">
                        <div className={`tournament-details-result-point-diff ${getResultDeltaClass(pointsDiff)}`}>
                          {formatSignedNumberValue(pointsDiff)}
                        </div>
                        <div className="tournament-details-result-score">
                          <span className="is-for">{formatNumberValue(row.pointsFor)}</span>
                          <span className="tournament-details-result-score-separator">:</span>
                          <span className="is-against">{formatNumberValue(row.pointsAgainst)}</span>
                        </div>
                      </div>
                      <div className="tournament-details-result-side tournament-details-result-side--level">
                        <div className={`tournament-details-result-delta ${getResultDeltaClass(row.delta)}`}>
                          <span className="tournament-details-result-delta-marker" aria-hidden="true">Δ</span>
                          <span>{formatSignedNumberValue(row.delta)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
