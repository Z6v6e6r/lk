import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Modal } from "../UI/Modal";
import {
  apiCancelBooking,
  apiFetchBookings,
  apiCreateAmericanoTournament,
  apiFetchExercisesByVisibleDate,
  apiFetchPadelLiveRatings,
  apiFetchProfile,
  apiFetchTournamentHistory,
  apiFetchTournamentParticipants,
  apiSaveOnboardingLevel,
  getServ2Origin,
  apiUpdateAmericanoResults,
} from "../../utils/apiClient";
import type {
  AmericanoTournamentPayload,
  AmericanoResultsResponse,
  Booking,
  Exercise,
  ExerciseBooking,
  TournamentHistoryRecord,
  UserProfileType,
} from "../../utils/apiClient";
import { TENANT_KEY } from "../../consts/api_config";
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
  hydrateAmericanoRounds,
  parseTournamentRatingValue,
  serializeAmericanoRounds,
  type AmericanoLabParticipant as ParticipantEntry,
  type AmericanoLabRound as TournamentRound,
} from "./americanoLab";

interface TournamentsPageProps {
  onBack: () => void;
}

const TOURNAMENT_DIRECTION_ID = 2617;
const DAYS_BEFORE_TODAY = 7;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;

const TOURNAMENT_TYPES = [
  { id: "americano", label: "Американо" },
  { id: "mexicano", label: "Мексикано" },
];

const HTML_TO_IMAGE_CDN =
  "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.min.js";

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

function formatTime(timeStr?: string) {
  return timeStr ? timeStr.slice(11, 16) : "";
}

function getExerciseDateKey(exercise?: Exercise | null) {
  if (!exercise?.timeFrom) return null;
  const parsed = new Date(exercise.timeFrom);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
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

function normalizeTournamentPhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function getClientName(booking: ExerciseBooking, index: number) {
  const client = booking.client as ExerciseBooking["client"] | undefined;
  const parts = [client?.firstName, client?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return `Участник ${index + 1}`;
}

function getInitials(booking: ExerciseBooking) {
  const client = booking.client as ExerciseBooking["client"] | undefined;
  const first = client?.firstName?.[0] || "";
  const last = client?.lastName?.[0] || "";
  return (first + last).toUpperCase() || "U";
}

function getInitialsFromName(name?: string | null) {
  if (!name) return "U";
  const parts = name.split(" ").filter(Boolean);
  const initials = parts.map((part) => part[0] || "").join("").slice(0, 2);
  return initials.toUpperCase() || "U";
}

function formatRating(value: number) {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
    && currentRounds.every((round) => incomingRoundIds.has(round.id));

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

  return currentRounds.map((round) => {
    const incomingRound = incomingRoundMap.get(round.id);
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

    return {
      ...round,
      matches: nextMatches,
      saved: nextMatches.length > 0 && nextMatches.every((match) => match.saved),
    };
  });
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

type TournamentProgressState = "not_started" | "in_progress" | "completed";

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
  if (normalized.includes("americano") || normalized.includes("американо")) return "americano";
  if (normalized.includes("mexicano") || normalized.includes("мексикано")) return "mexicano";
  return normalized;
}

function getTournamentTypeLabel(value: string | null | undefined) {
  const typeKey = normalizeTournamentTypeKey(value);
  if (typeKey === "americano") return "Американо";
  if (typeKey === "mexicano") return "Мексикано";
  return String(value || "").trim() || "Турнир";
}

function isCompletedHistoryMatch(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.score1 != null && record.score2 != null;
}

function getTournamentProgressState(history: TournamentHistoryRecord | null | undefined): TournamentProgressState {
  if (!history) return "not_started";
  const matches = Array.isArray(history.rounds)
    ? history.rounds.flatMap((round) => {
      if (!round || typeof round !== "object") return [];
      const roundMatches = (round as { matches?: unknown[] }).matches;
      return Array.isArray(roundMatches) ? roundMatches : [];
    })
    : [];
  if (matches.length === 0) return "in_progress";
  return matches.every((match) => isCompletedHistoryMatch(match)) ? "completed" : "in_progress";
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

function isTournamentTrainer(exercise: Exercise, currentUserId: string | null) {
  if (!currentUserId) return false;
  return (exercise.trainers ?? []).some((trainer) => (trainer.id || "").trim() === currentUserId);
}

function buildTournamentPayloadFromHistory(history: TournamentHistoryRecord): AmericanoTournamentPayload | null {
  if (normalizeTournamentTypeKey(history.tournamentType) !== "americano") return null;

  return {
    tournamentId: history.tournamentId,
    tenantKey: TENANT_KEY,
    createdAt: history.createdAt ?? history.updatedAt ?? new Date().toISOString(),
    organizer: {
      id: history.organizer?.id ?? null,
      phone: history.organizer?.phone ?? null,
      tenantKey: TENANT_KEY,
    },
    tournamentType: "americano",
    targetScore: history.targetScore ?? 21,
    courts: history.courts.length > 0 ? history.courts : ["Корт №1"],
    participants: history.participants.map((participant, index) => ({
      id: participant.id ?? participant.phone ?? `participant-${index}`,
      phone: participant.phone ?? null,
      rating: participant.rating ?? null,
      photo: participant.photo ?? null,
      name: participant.name || `Участник ${index + 1}`,
    })),
    rounds: history.rounds as AmericanoTournamentPayload["rounds"],
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
      id: participant.id ?? participant.phone ?? `participant-${index}`,
      phone: participant.phone ?? null,
      photo: participant.photo ?? null,
      rating: participant.rating ?? null,
      name: participant.name || `Участник ${index + 1}`,
    })),
    participantsCount: payload.participants.length,
    maxParticipants: previousHistory?.maxParticipants ?? tournament?.maxClientsCount ?? null,
    minRating: previousHistory?.minRating ?? null,
    maxRating: previousHistory?.maxRating ?? null,
    genderLabel: previousHistory?.genderLabel ?? (girlsOnly ? "Женщины" : null),
    girlsOnly,
    mixed: previousHistory?.mixed ?? null,
    organizer:
      previousHistory?.organizer
      ?? (payload.organizer.id || payload.organizer.phone
        ? {
          id: payload.organizer.id ?? null,
          phone: payload.organizer.phone ?? null,
          photo: null,
          rating: null,
          name: "Организатор",
        }
        : null),
    params: previousHistory?.params ?? null,
    rounds: payload.rounds ?? [],
    standings: previousHistory?.standings ?? [],
    summary: previousHistory?.summary ?? null,
    totals: totals ?? previousHistory?.totals ?? null,
    playerLogs: playerLogs ?? previousHistory?.playerLogs ?? null,
    createdAt: previousHistory?.createdAt ?? payload.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

interface TournamentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  tournament: Exercise | null;
  historyRecord?: TournamentHistoryRecord | null;
  onSaved: (data: AmericanoTournamentPayload) => void;
}

type TournamentParticipantEntry = ParticipantEntry & {
  bookingId: string | null;
  clientId: string | null;
  isOrganizerSlot?: boolean;
};

type TournamentMissingRatingConfirmation = {
  missingCount: number;
  minRatingDisplay: string;
};

function TournamentDetailsModal({
  isOpen,
  onClose,
  tournament,
  historyRecord = null,
  onSaved,
}: TournamentDetailsModalProps) {
  const [loading, setLoading] = useState(false);
  const [participants, setParticipants] = useState<ExerciseBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [courtsCountDraft, setCourtsCountDraft] = useState("");
  const [courtNames, setCourtNames] = useState<string[]>([]);
  const [targetScore, setTargetScore] = useState(21);
  const [targetScoreDraft, setTargetScoreDraft] = useState("21");
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [manualRatings, setManualRatings] = useState<Record<string, string>>({});
  const [ratingSaveStateById, setRatingSaveStateById] = useState<Record<string, "idle" | "saving">>({});
  const [ratingSaveErrors, setRatingSaveErrors] = useState<Record<string, string>>({});
  const [refreshingRatings, setRefreshingRatings] = useState(false);
  const [refreshRatingsError, setRefreshRatingsError] = useState<string | null>(null);
  const [missingRatingConfirmation, setMissingRatingConfirmation] =
    useState<TournamentMissingRatingConfirmation | null>(null);
  const [organizerSlotRating, setOrganizerSlotRating] = useState<string | null>(null);
  const [leavingParticipantId, setLeavingParticipantId] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [autoRefreshedParticipantsKey, setAutoRefreshedParticipantsKey] = useState("");

  useEffect(() => {
    if (!selectedType) {
      setCourtsCountDraft("");
      setCourtNames([]);
      setTargetScore(21);
      setTargetScoreDraft("21");
      setSaveState("idle");
      setManualRatings({});
      setRatingSaveStateById({});
      setRatingSaveErrors({});
      setRefreshingRatings(false);
      setRefreshRatingsError(null);
      setMissingRatingConfirmation(null);
      setOrganizerSlotRating(null);
      setLeavingParticipantId(null);
      setLeaveError(null);
      setAutoRefreshedParticipantsKey("");
    }
  }, [selectedType]);

  useEffect(() => {
    if (!isOpen) return;
    const restoredType = normalizeTournamentTypeKey(historyRecord?.tournamentType);
    const restoredCourts = Array.isArray(historyRecord?.courts) ? historyRecord.courts : [];
    const restoredTargetScore = historyRecord?.targetScore ?? 21;
    setSelectedType(restoredType === "americano" || restoredType === "mexicano" ? restoredType : null);
    setCourtsCountDraft(restoredCourts.length > 0 ? String(restoredCourts.length) : "");
    setCourtNames(restoredCourts);
    setTargetScore(restoredTargetScore);
    setTargetScoreDraft(String(restoredTargetScore));
    setSaveState("idle");
    setManualRatings({});
    setRatingSaveStateById({});
    setRatingSaveErrors({});
    setRefreshingRatings(false);
    setRefreshRatingsError(null);
    setMissingRatingConfirmation(null);
    setOrganizerSlotRating(null);
    setLeavingParticipantId(null);
    setLeaveError(null);
    setAutoRefreshedParticipantsKey("");
  }, [isOpen, historyRecord, tournament?.id]);

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

  const handleSaveAmericano = async (allowMissingRatings = false) => {
    if (!tournament) return;
    const minRating = resolveTournamentMinRating(tournament, historyRecord);
    const missingParticipants = sortedParticipants.filter((participant) => {
      const manualRating = manualRatings[participant.id];
      const ratingValue = parseTournamentRatingValue(manualRating ?? participant.rating);
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

    const participantsForRounds: ParticipantEntry[] = sortedParticipants.map((participant, idx) => {
      const manualRating = manualRatings[participant.id];
      const ratingValue =
        parseTournamentRatingValue(manualRating ?? participant.rating)
        ?? (allowMissingRatings ? minRating.value : null);
      return {
        id: participant.id ?? participant.phone ?? `participant-${idx}`,
        name: participant.name || `Участник ${idx + 1}`,
        photo: participant.photo ?? null,
        phone: participant.phone ?? null,
        rating: ratingValue != null ? String(ratingValue) : null,
      };
    });

    const roundsForServer = serializeAmericanoRounds(
      createAmericanoRounds(participantsForRounds, courtNames),
    );

    const payload: AmericanoTournamentPayload = {
      tournamentId: String(tournament.id),
      tenantKey: TENANT_KEY,
      createdAt: new Date().toISOString(),
      organizer: {
        id: profile?.id ?? null,
        phone: profile?.phone ?? null,
        tenantKey: TENANT_KEY,
      },
      tournamentType: "americano" as const,
      targetScore,
      courts: courtNames,
      participants: participantsForRounds.map((participant) => ({
        id: participant.id ?? null,
        phone: participant.phone ?? null,
        rating: participant.rating ?? null,
        photo: participant.photo ?? null,
        name: participant.name,
      })),
      rounds: roundsForServer,
    };

    const res = await apiCreateAmericanoTournament(payload);
    if (res.data) {
      setSaveState("success");
      onSaved(payload);
      onClose();
    } else {
      setSaveState("error");
    }
  };

  const tournamentId = tournament?.id ? String(tournament.id) : null;

  const loadParticipants = async (nextTournamentId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetchTournamentParticipants(nextTournamentId);
      const data = res.data as unknown;
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { payload?: ExerciseBooking[] })?.payload)
          ? (data as { payload: ExerciseBooking[] }).payload
          : Array.isArray((data as { content?: ExerciseBooking[] })?.content)
            ? (data as { content: ExerciseBooking[] }).content
            : [];
      setParticipants(list);
    } catch {
      setError("Не удалось загрузить участников");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !tournamentId) return;
    void loadParticipants(tournamentId);
  }, [isOpen, tournamentId]);

  const title = tournament?.direction?.name || tournament?.type?.name || "Турнир";
  const trainer = tournament?.trainers?.[0];

  const baseParticipantEntries = useMemo((): TournamentParticipantEntry[] => {
    return participants.map((participant, idx) => ({
      id: participant.client?.id ?? participant.id ?? `participant-${idx}`,
      bookingId: participant.id ?? null,
      clientId: participant.client?.id ?? null,
      name: getClientName(participant, idx),
      photo: participant.client?.photo ?? null,
      phone: participant.client?.phone ?? null,
      spot: participant.spot ?? null,
      rating: participant.rating ?? null,
    }));
  }, [participants]);

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
      id: profile.id || `organizer-slot-${normalizeTournamentPhone(profile.phone) || "self"}`,
      bookingId: null,
      clientId: profile.id || null,
      name,
      photo: profile.photo ?? null,
      phone: profile.phone ?? null,
      spot: null,
      rating: persistedRating,
      isOrganizerSlot: true,
    };
  }, [organizerSlotRating, profile]);

  const shouldAutoIncludeOrganizerSlot = useMemo(() => {
    if (!organizerSlotParticipant) return false;
    if (baseParticipantEntries.length === 0 || baseParticipantEntries.length % 2 === 0) return false;

    return !baseParticipantEntries.some((participant) => (
      (participant.clientId && organizerSlotParticipant.clientId && participant.clientId === organizerSlotParticipant.clientId)
      || (
        normalizeTournamentPhone(participant.phone)
        && normalizeTournamentPhone(organizerSlotParticipant.phone)
        && normalizeTournamentPhone(participant.phone) === normalizeTournamentPhone(organizerSlotParticipant.phone)
      )
    ));
  }, [baseParticipantEntries, organizerSlotParticipant]);

  const participantEntries = useMemo((): TournamentParticipantEntry[] => {
    if (!shouldAutoIncludeOrganizerSlot || !organizerSlotParticipant) {
      return baseParticipantEntries;
    }

    return [...baseParticipantEntries, organizerSlotParticipant];
  }, [baseParticipantEntries, organizerSlotParticipant, shouldAutoIncludeOrganizerSlot]);

  const participantRatingsRefreshKey = useMemo(
    () =>
      participantEntries
        .map((participant) => [
          participant.id,
          participant.clientId ?? "",
          normalizeTournamentPhone(participant.phone) ?? "",
          participant.isOrganizerSlot ? "organizer" : "participant",
        ].join(":"))
        .sort()
        .join("|"),
    [participantEntries],
  );

  const isCurrentUserParticipant = (participant: TournamentParticipantEntry) => {
    if (!profile || participant.isOrganizerSlot) return false;
    if (profile.id && participant.clientId && profile.id === participant.clientId) return true;

    const participantPhone = normalizeTournamentPhone(participant.phone);
    const profilePhone = normalizeTournamentPhone(profile.phone);
    return Boolean(participantPhone && profilePhone && participantPhone === profilePhone);
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

  const handleRefreshParticipantRatings = async (silent = false) => {
    if (participantEntries.length === 0) return;

    setRefreshingRatings(true);
    if (!silent) {
      setRefreshRatingsError(null);
    }

    const liveRatingsResult = await apiFetchPadelLiveRatings(
      participantEntries.map((participant) => ({
        clientId: participant.clientId,
        phone: participant.phone ?? null,
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
    const liveByPhone = new Map<string, string | null>();

    (liveRatingsResult.data ?? []).forEach((item) => {
      const clientId = (item.clientId || "").trim();
      const phoneNorm = normalizeTournamentPhone(item.phoneNorm);
      const parsedNumeric =
        typeof item.ratingNumeric === "number" && Number.isFinite(item.ratingNumeric)
          ? item.ratingNumeric
          : parseTournamentRatingValue(item.rating);
      const nextRating =
        typeof item.rating === "string" && item.rating.trim()
          ? item.rating.trim()
          : parsedNumeric != null
            ? parsedNumeric.toFixed(5)
            : null;

      if (clientId) liveByClientId.set(clientId, nextRating);
      if (phoneNorm) liveByPhone.set(phoneNorm, nextRating);
    });

    const refreshedPositiveIds = new Set<string>();
    const organizerPhoneNorm = normalizeTournamentPhone(organizerSlotParticipant?.phone);
    const nextOrganizerRating = organizerSlotParticipant
      ? (organizerSlotParticipant.clientId ? liveByClientId.get(organizerSlotParticipant.clientId) : undefined)
        ?? (organizerPhoneNorm ? liveByPhone.get(organizerPhoneNorm) : undefined)
      : undefined;

    setParticipants((prev) =>
      prev.map((participant, idx) => {
        const clientId = (participant.client?.id || "").trim();
        const bookingId = (participant.id || "").trim();
        const phoneNorm = normalizeTournamentPhone(participant.client?.phone);
        const nextRating =
          (clientId ? liveByClientId.get(clientId) : undefined)
          ?? (phoneNorm ? liveByPhone.get(phoneNorm) : undefined);

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
    if (!isOpen || loading || refreshingRatings || participantEntries.length === 0) return;
    if (!participantRatingsRefreshKey || participantRatingsRefreshKey === autoRefreshedParticipantsKey) return;
    setAutoRefreshedParticipantsKey(participantRatingsRefreshKey);
    void handleRefreshParticipantRatings(true);
  }, [
    autoRefreshedParticipantsKey,
    isOpen,
    loading,
    participantEntries.length,
    participantRatingsRefreshKey,
    refreshingRatings,
  ]);

  const handleParticipantRatingSave = async (participant: TournamentParticipantEntry) => {
    const rawRating = manualRatings[participant.id] ?? "";
    const parsedRating = parseTournamentRatingValue(rawRating);

    if (!participant.clientId) {
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: "Не найден clientId для сохранения рейтинга",
      }));
      return;
    }

    if (parsedRating == null) {
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: "Введите рейтинг больше 0",
      }));
      return;
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

    const response = await apiSaveOnboardingLevel({
      clientId: participant.clientId,
      phone: participant.phone ?? null,
      levelLetter: getLetterGrade(parsedRating),
      levelNumeric: parsedRating,
    });

    if (response.error) {
      setRatingSaveStateById((prev) => ({
        ...prev,
        [participant.id]: "idle",
      }));
      setRatingSaveErrors((prev) => ({
        ...prev,
        [participant.id]: response.error?.message || "Не удалось сохранить рейтинг",
      }));
      return;
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
    setManualRatings((prev) => {
      const next = { ...prev };
      delete next[participant.id];
      return next;
    });
    setRatingSaveStateById((prev) => ({
      ...prev,
      [participant.id]: "idle",
    }));
  };

  const handleParticipantLeave = async (participant: TournamentParticipantEntry) => {
    if (!participant.bookingId || leavingParticipantId) return;
    const accepted = window.confirm("Покинуть турнир? Вы потеряете место в записи.");
    if (!accepted) return;

    setLeavingParticipantId(participant.id);
    setLeaveError(null);

    try {
      const response = await apiCancelBooking(participant.bookingId);
      const ok = response.status != null && response.status >= 200 && response.status < 300;

      if (!ok) {
        setLeaveError(response.error?.message || "Не удалось покинуть турнир");
        return;
      }

      if (tournamentId) {
        await loadParticipants(tournamentId);
      } else {
        setParticipants((prev) => prev.filter((item) => item.id !== participant.bookingId));
      }
    } catch {
      setLeaveError("Не удалось покинуть турнир");
    } finally {
      setLeavingParticipantId(null);
    }
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

  const parsedTargetScoreDraft = selectedType === "americano"
    ? parseBoundedIntegerInput(targetScoreDraft, 1, 99)
    : null;
  const parsedCourtsCountDraft = selectedType
    ? parseBoundedIntegerInput(courtsCountDraft, 1, 12)
    : null;
  const canSaveTargetScore =
    selectedType === "americano" && parsedTargetScoreDraft != null && parsedTargetScoreDraft !== targetScore;
  const canSaveCourtsCount =
    selectedType != null && parsedCourtsCountDraft != null && parsedCourtsCountDraft !== courtNames.length;
  const targetScoreNeedsConfirmation =
    selectedType === "americano"
    && (targetScoreDraft.trim() === "" || parsedTargetScoreDraft == null || parsedTargetScoreDraft !== targetScore);
  const courtsCountNeedsConfirmation =
    selectedType != null
    && (courtsCountDraft.trim() === "" || parsedCourtsCountDraft == null || parsedCourtsCountDraft !== courtNames.length);
  const settingsNeedConfirmation = targetScoreNeedsConfirmation || courtsCountNeedsConfirmation;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      variant="fullscreen"
      bodyClassName="tournament-settings-modal-body"
    >
      <div className="tournaments-body tournament-settings-screen">
        <div className="tournament-row">
          <span>{formatTime(tournament?.timeFrom)} – {formatTime(tournament?.timeTo)}</span>
          {tournament?.studio?.name && <span>{tournament.studio.name}</span>}
        </div>
        {tournament?.studio?.address && (
          <div className="tournament-address">{tournament.studio.address}</div>
        )}

        {trainer && (
          <div className="tournament-section">
            <div className="tournament-section-title">Исполнитель</div>
            <div className="tournament-participant tournament-trainer-card">
              <div className="tournament-participant-avatar">
                {trainer.photo ? (
                  <img
                    src={trainer.photo}
                    alt={trainer.firstName}
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <span>{getInitials({ client: { firstName: trainer.firstName, lastName: trainer.lastName } } as ExerciseBooking)}</span>
                )}
                <span className="tournament-participant-initials">
                  {getInitials({ client: { firstName: trainer.firstName, lastName: trainer.lastName } } as ExerciseBooking)}
                </span>
              </div>
              <div className="tournament-participant-info">
                <div className="tournament-participant-name">
                  {[trainer.firstName, trainer.lastName].filter(Boolean).join(" ") || "Тренер"}
                </div>
                <div className="tournament-participant-spot">Исполнитель</div>
              </div>
              <div className="tournament-participant-rating trainer">Тренер</div>
            </div>
          </div>
        )}

        <div className="tournament-section">
          <div className="tournament-section-head">
            <div className="tournament-section-title">Участники</div>
            <button
              className="tournament-section-action"
              type="button"
              onClick={() => void handleRefreshParticipantRatings()}
              disabled={refreshingRatings || loading || sortedParticipants.length === 0}
            >
              {refreshingRatings ? "Пересчет..." : "Пересчитать"}
            </button>
          </div>
          {loading && <div className="tournaments-muted">Загрузка...</div>}
          {!loading && error && <div className="tournaments-error">{error}</div>}
          {!loading && !error && refreshRatingsError && (
            <div className="tournaments-error">{refreshRatingsError}</div>
          )}
          {!loading && !error && leaveError && (
            <div className="tournaments-error">{leaveError}</div>
          )}
          {!loading && !error && participants.length === 0 && (
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
                const manualRating = manualRatings[participant.id] ?? "";
                const savedRatingValue = parseTournamentRatingValue(participant.rating);
                const hasSavedRating = savedRatingValue != null;
                const manualParsedRating = parseTournamentRatingValue(manualRating);
                const isSavingRating = ratingSaveStateById[participant.id] === "saving";
                const canLeaveParticipant =
                  Boolean(participant.bookingId)
                  && isCurrentUserParticipant(participant);
                const isLeavingParticipant = leavingParticipantId === participant.id;

                return (
                  <div key={participant.id ?? idx} className="tournament-participant">
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
                      <div className="tournament-participant-name">{participant.name}</div>
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
                      {hasSavedRating ? (
                        <div className="tournament-participant-rating">
                          {formatRating(savedRatingValue!)}
                        </div>
                      ) : (
                        <div className="tournament-participant-rating-editor">
                          <input
                            className="tournament-participant-rating-input"
                            type="text"
                            inputMode="decimal"
                            placeholder={participant.phone || "Рейтинг"}
                            value={manualRating}
                            onChange={(e) => handleParticipantRatingInput(participant.id, e.target.value)}
                          />
                          {participant.clientId && manualParsedRating != null && (
                            <button
                              className="tournament-participant-rating-save"
                              type="button"
                              onClick={() => void handleParticipantRatingSave(participant)}
                              disabled={isSavingRating}
                              aria-label="Сохранить рейтинг"
                              title="Сохранить рейтинг"
                            >
                              {isSavingRating ? "…" : "✓"}
                            </button>
                          )}
                        </div>
                      )}
                      {canLeaveParticipant && (
                        <button
                          className="tournament-participant-leave"
                          type="button"
                          onClick={() => void handleParticipantLeave(participant)}
                          disabled={isLeavingParticipant}
                        >
                          {isLeavingParticipant ? "Выходим..." : "Покинуть"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!loading && !error && shouldAutoIncludeOrganizerSlot && (
            <div className="tournament-organizer-slot">
              <div className="tournament-organizer-slot-copy">
                <div className="tournament-organizer-slot-title">
                  Нечетное количество игроков
                </div>
                <div className="tournament-organizer-slot-text">
                  Тренер или организатор автоматически добавлен в свободный четный слот.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="tournament-section">
          <div className="tournament-section-title">Тип турнира</div>
          <div className="tournament-type-list">
            {TOURNAMENT_TYPES.map((type) => (
              <button
                key={type.id}
                className={`tournament-type-option ${selectedType === type.id ? "active" : ""}`}
                type="button"
                onClick={() => setSelectedType(type.id)}
              >
                {type.label}
              </button>
            ))}
          </div>
        </div>

        {selectedType && (
          <div className="tournament-section">
            {selectedType === "americano" && (
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

            <div className="tournament-settings-actions">
              {settingsNeedConfirmation && (
                <div className="tournament-settings-hint">
                  Подтвердите сумму счета и количество кортов кнопками ✓.
                </div>
              )}
              <button
                className="section-cta"
                type="button"
                onClick={selectedType === "americano" ? () => void handleSaveAmericano() : undefined}
                disabled={
                  saveState === "loading"
                  || selectedType !== "americano"
                  || courtNames.length === 0
                  || settingsNeedConfirmation
                }
              >
                {saveState === "loading"
                  ? "Сохранение..."
                  : saveState === "success"
                    ? "Сохранено"
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
            onClick={() => void handleSaveAmericano(true)}
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
  onEditSettings?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"tournament" | "table" | "stats">("tournament");
  const [expertMode, setExpertMode] = useState(false);
  const [rounds, setRounds] = useState<TournamentRound[]>([]);
  const statsRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [savingMatchId, setSavingMatchId] = useState<string | null>(null);
  const [matchSaveErrors, setMatchSaveErrors] = useState<Record<string, string>>({});
  const [serverTotals, setServerTotals] = useState<AmericanoResultsResponse["totals"] | null>(null);
  const [serverLogs, setServerLogs] = useState<AmericanoResultsResponse["playerLogs"] | null>(null);
  const matchElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const matchInputRefs = useRef<
    Record<string, { score1: HTMLInputElement | null; score2: HTMLInputElement | null }>
  >({});
  const pendingMatchNavigationRef = useRef<TournamentMatchLocation | null>(null);

  const normalizedParticipants = useMemo<ParticipantEntry[]>(() => {
    if (!data) return [];
    return data.participants.map((p, idx) => ({
      id: p.id ?? p.phone ?? `participant-${idx}`,
      name: p.name || `Участник ${idx + 1}`,
      photo: p.photo ?? null,
      phone: p.phone ?? null,
      rating: p.rating ?? null,
    }));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setRounds(hydrateAmericanoRounds(data.rounds, normalizedParticipants, data.courts));
    setActiveTab("tournament");
    setExpertMode(false);
    setServerTotals(initialTotals);
    setServerLogs(initialPlayerLogs);
    setMatchSaveErrors({});
  }, [data, normalizedParticipants, initialTotals, initialPlayerLogs]);

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

  const handleMatchSave = (roundId: string, matchId: string) => {
    if (!data) return;
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

    const results = [
      {
        roundId,
        matchId,
        score1: match.score1 as number,
        score2: match.score2 as number,
        court: match.court,
        pair1: match.pair1.map((p) => p.id),
        pair2: match.pair2.map((p) => p.id),
      },
    ];

    setSavingMatchId(matchId);
    setMatchSaveErrors((prev) => {
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
    apiUpdateAmericanoResults({
      tournamentId: data.tournamentId,
      results,
    })
      .then((res) => {
        if (res.data) {
          if (!Array.isArray(res.data.rounds)) {
            setMatchSaveErrors((prev) => ({
              ...prev,
              [matchId]: "Сервер не подтвердил сохранение результата",
            }));
            return;
          }

          const nextRounds = applyPartialRoundUpdates(
            rounds,
            hydrateAmericanoRounds(res.data.rounds, normalizedParticipants, data.courts),
          );
          const persistedRound = nextRounds.find((item) => item.id === roundId) ?? null;
          const shouldAdvanceRound =
            !wasRoundPersistedCompleteBeforeSave && Boolean(persistedRound?.saved);
          const {
            rounds: nextRoundsWithCollapse,
            nextMatch,
          } = shouldAdvanceRound
            ? navigateTournamentAfterMatchSave(nextRounds, roundId, matchId)
            : {
                rounds: nextRounds,
                nextMatch: findNextIncompleteTournamentMatch(nextRounds, roundId, matchId),
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
          if (res.data.totals) setServerTotals(res.data.totals);
          if (res.data.playerLogs) setServerLogs(res.data.playerLogs);
          onDataChange?.(
            {
              ...data,
              rounds: serializeAmericanoRounds(nextRoundsWithNavigation),
            },
            {
              totals: nextTotals,
              playerLogs: nextPlayerLogs,
            },
          );
        } else {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: res.error?.message || "Не удалось сохранить результаты",
          }));
        }
      })
      .catch(() =>
        setMatchSaveErrors((prev) => ({
          ...prev,
          [matchId]: "Не удалось сохранить результаты",
        })),
      )
      .finally(() => setSavingMatchId(null));
  };

  const standingsSnapshot = useMemo(
    () => buildAmericanoStandings(normalizedParticipants, rounds, serverTotals),
    [normalizedParticipants, rounds, serverTotals],
  );

  const tableRows = standingsSnapshot.rows;
  const roundByePoints = standingsSnapshot.roundByePoints;
  const statsRows = standingsSnapshot.rows;
  const participantRatingById = useMemo(
    () => new Map(normalizedParticipants.map((participant) => [
      participant.id,
      parseTournamentRatingValue(participant.rating),
    ])),
    [normalizedParticipants],
  );
  const canEditSettings = useMemo(
    () => rounds.every((round) => round.matches.every((match) => !match.saved)),
    [rounds],
  );
  const canFinishTournament =
    standingsSnapshot.totalMatches > 0 && standingsSnapshot.completedMatches === standingsSnapshot.totalMatches;

  const splitName = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return { line1: name, line2: "" };
    }
    return { line1: parts[0], line2: parts.slice(1).join(" ") };
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title || "Турнир"} variant="fullscreen">
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
                            ) : match.saved ? (
                              <span className="tournament-round-status saved">Сохранено</span>
                            ) : null}
                          </div>
                          <button
                            className="tournament-round-save"
                            type="button"
                            onClick={() => handleMatchSave(round.id, match.id)}
                            disabled={savingMatchId === match.id}
                          >
                            {savingMatchId === match.id ? "Сохранение..." : "Сохранить"}
                          </button>
                        </div>
                        {matchSaveErrors[match.id] && (
                          <div className="tournaments-error">{matchSaveErrors[match.id]}</div>
                        )}
                      </div>
                    ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="tournament-manager-footer">
              {!canFinishTournament && (
                <div className="tournament-manager-footer-note">
                  Кнопка станет активной после сохранения всех результатов.
                </div>
              )}
              <button
                type="button"
                className="section-cta tournament-manager-finish"
                onClick={onClose}
                disabled={!canFinishTournament}
              >
                Завершить турнир
              </button>
            </div>
          </>
        )}

        {activeTab === "table" && (
          <div className="tournament-table">
            {tableRows.map((row) => {
              const playerRating =
                row.ratingAfter
                ?? participantRatingById.get(row.id)
                ?? row.ratingBefore
                ?? null;
              const playerBadgeStyle = getTournamentRatingBadgeStyle(playerRating);
              const playerRingProgressDeg = `${Math.round(getTournamentRatingRingProgress(playerRating) * 360)}deg`;
              const name = splitName(row.name);
              const pointDiffClass =
                row.pointDiff > 0
                  ? "positive"
                  : row.pointDiff < 0
                    ? "negative"
                    : "";
              const ratingDeltaClass =
                row.ratingDelta > 0
                  ? "positive"
                  : row.ratingDelta < 0
                    ? "negative"
                    : "";
              return (
                <div key={row.id} className="tournament-table-row">
                  <div className="tournament-table-player">
                    <div className="tournament-table-avatar-wrap">
                      <span className="tournament-table-rank">{row.rank}</span>
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
                  <div className="tournament-table-stat-group">
                    <div className="tournament-table-stat-head">
                      <span>В</span>
                      <span>Н</span>
                      <span>П</span>
                    </div>
                    <div className="tournament-table-stat-values">
                      <span className="positive">{formatTournamentNumber(row.wins, 0)}</span>
                      <span>{formatTournamentNumber(row.draws, 0)}</span>
                      <span className="negative">{formatTournamentNumber(row.losses, 0)}</span>
                    </div>
                  </div>
                  <div className="tournament-table-stat-group">
                    <div className="tournament-table-stat-head">
                      <span>+</span>
                      <span>-</span>
                      <span>Δ</span>
                    </div>
                    <div className="tournament-table-stat-values">
                      <span className="positive">{formatTournamentNumber(row.pointsFor, 0)}</span>
                      <span className="negative">{formatTournamentNumber(row.pointsAgainst, 0)}</span>
                      <span className={pointDiffClass}>
                        {formatSignedTournamentNumber(row.pointDiff, 0)}
                      </span>
                    </div>
                  </div>
                  <div className="tournament-table-rating-group">
                    <span className="tournament-table-rating-label">Δ рейтинга</span>
                    <span className={`tournament-table-rating-value ${ratingDeltaClass}`}>
                      {formatSignedTournamentNumber(row.ratingDelta, 5)}
                    </span>
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
              {exportError && <span className="tournament-stats-error">{exportError}</span>}
            </div>
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
      </div>
    </Modal>
  );
}

export default function TournamentsPage({ onBack }: TournamentsPageProps) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [selectedTournament, setSelectedTournament] = useState<Exercise | null>(null);
  const [managerData, setManagerData] = useState<AmericanoTournamentPayload | null>(null);
  const [managerTotals, setManagerTotals] = useState<AmericanoResultsResponse["totals"] | null>(null);
  const [managerPlayerLogs, setManagerPlayerLogs] = useState<AmericanoResultsResponse["playerLogs"] | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, TournamentHistoryRecord | null>>({});
  const [openingTournamentId, setOpeningTournamentId] = useState<string | null>(null);
  const [dateIndex, setDateIndex] = useState(TODAY_DATE_INDEX);

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
  const selectedDateLabel = selectedDate.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [exercisesResult, activeBookingsResult, historyBookingsResult] = await Promise.all([
          apiFetchExercisesByVisibleDate(selectedDateStr, {
            includePast: includePastTournaments,
            includeAdjacentDays: selectedDateStr === todayDateStr,
          }),
          includePastTournaments ? apiFetchBookings(false) : Promise.resolve(null),
          includePastTournaments ? apiFetchBookings(true) : Promise.resolve(null),
        ]);

        if (!alive) return;

        const exerciseItems = exercisesResult.data ?? [];
        const bookingItems = [
          ...(activeBookingsResult?.data?.content ?? []),
          ...(historyBookingsResult?.data?.content ?? []),
        ];

        setItems(mergeTournamentExercises(exerciseItems, bookingItems, selectedDateStr));
      } catch {
        if (!alive) return;
        setError("Не удалось загрузить список турниров");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [includePastTournaments, selectedDateStr]);

  useEffect(() => {
    let alive = true;
    setProfileLoading(true);
    apiFetchProfile()
      .then((res) => {
        if (!alive) return;
        setProfile(res.data ?? null);
      })
      .finally(() => {
        if (alive) setProfileLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const canHostTournaments = profile ? hasTournamentHostingAccess(profile) : false;
  const tournaments = useMemo(
    () =>
      items.filter((ex) =>
        ex.direction?.id === TOURNAMENT_DIRECTION_ID || ex.type?.id === TOURNAMENT_DIRECTION_ID,
      ),
    [items],
  );
  const visibleTournaments = useMemo(
    () =>
      tournaments.filter((exercise) => (
        canHostTournaments || isTournamentTrainer(exercise, profile?.id ?? null)
      )),
    [canHostTournaments, profile?.id, tournaments],
  );
  const tournamentIdsKey = useMemo(
    () => visibleTournaments.map((ex) => String(ex.id)).sort().join("|"),
    [visibleTournaments],
  );

  useEffect(() => {
    if (!tournamentIdsKey) {
      setHistoryById({});
      return;
    }

    let alive = true;

    void Promise.all(
      visibleTournaments.map(async (tournament) => {
        const tournamentId = String(tournament.id);
        const result = await apiFetchTournamentHistory(tournamentId);
        return [tournamentId, pickLatestTournamentHistory(result.data)] as const;
      }),
    ).then((entries) => {
      if (!alive) return;
      const next: Record<string, TournamentHistoryRecord | null> = {};
      entries.forEach(([tournamentId, historyRecord]) => {
        next[tournamentId] = historyRecord;
      });
      setHistoryById(next);
    }).catch(() => {
      if (!alive) return;
      const next: Record<string, TournamentHistoryRecord | null> = {};
      visibleTournaments.forEach((tournament) => {
        next[String(tournament.id)] = null;
      });
      setHistoryById(next);
    });

    return () => {
      alive = false;
    };
  }, [tournamentIdsKey, visibleTournaments]);

  const handleTournamentOpen = async (tournament: Exercise) => {
    const tournamentId = String(tournament.id);
    if (openingTournamentId) return;
    setOpeningTournamentId(tournamentId);

    try {
      let historyRecord = historyById[tournamentId] ?? null;

      try {
        const result = await apiFetchTournamentHistory(tournamentId);
        const freshHistory = pickLatestTournamentHistory(result.data);
        if (freshHistory || !historyRecord) {
          historyRecord = freshHistory;
        }
        setHistoryById((prev) => ({
          ...prev,
          [tournamentId]: historyRecord,
        }));
      } catch {
        if (!historyRecord) {
          setHistoryById((prev) => ({
            ...prev,
            [tournamentId]: null,
          }));
        }
      }

      const restoredPayload = historyRecord ? buildTournamentPayloadFromHistory(historyRecord) : null;
      if (restoredPayload) {
        setSelectedTournament(null);
        setManagerTotals(historyRecord?.totals ?? null);
        setManagerPlayerLogs(historyRecord?.playerLogs ?? null);
        setManagerData(restoredPayload);
        return;
      }

      setSelectedTournament(tournament);
    } finally {
      setOpeningTournamentId((current) => (current === tournamentId ? null : current));
    }
  };

  const handleTournamentCreated = (payload: AmericanoTournamentPayload) => {
    const previousHistory = historyById[payload.tournamentId] ?? null;
    const nextHistory = buildTournamentHistoryRecordFromPayload(
      payload,
      selectedTournament,
      previousHistory,
    );
    setHistoryById((prev) => ({
      ...prev,
      [payload.tournamentId]: nextHistory,
    }));
    setManagerTotals(null);
    setManagerPlayerLogs(null);
    setManagerData(payload);
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
    setHistoryById((prev) => ({
      ...prev,
      [payload.tournamentId]: buildTournamentHistoryRecordFromPayload(
        payload,
        currentTournament,
        prev[payload.tournamentId] ?? null,
        extras.totals,
        extras.playerLogs,
      ),
    }));
  };

  const handleManagerEditSettings = () => {
    if (!managerData?.tournamentId) return;
    const currentTournament =
      visibleTournaments.find((item) => String(item.id) === managerData.tournamentId)
      ?? items.find((item) => String(item.id) === managerData.tournamentId)
      ?? null;
    if (!currentTournament) return;

    setManagerData(null);
    setManagerTotals(null);
    setManagerPlayerLogs(null);
    setSelectedTournament(currentTournament);
  };

  return (
    <div className="app-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">← Назад</button>
        <div className="page-title">Турниры</div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Турниры на {selectedDateLabel}</span>
        </div>
        <div className="section-body tournaments-body">
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
                <div key={date.toISOString()} className="date-item">
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

          {(loading || profileLoading) && <div className="tournaments-muted">Загрузка...</div>}
          {!loading && error && <div className="tournaments-error">{error}</div>}
          {!loading && !profileLoading && !error && visibleTournaments.length === 0 && (
            <div className="tournaments-muted">На выбранную дату турниров нет</div>
          )}
          {!loading && !profileLoading && !error && visibleTournaments.length > 0 && (
            <div className="tournaments-list">
              {!canHostTournaments && (
                <div className="tournaments-muted">
                  Показаны турниры, где вы назначены исполнителем.
                </div>
              )}
              {visibleTournaments.map((ex) => {
                const tournamentId = String(ex.id);
                const historyRecord = historyById[tournamentId] ?? null;
                const progressState = getTournamentProgressState(historyRecord);
                const progressLabel =
                  progressState === "completed"
                    ? "Проведен и сохранен"
                    : progressState === "in_progress"
                      ? "Не завершен"
                      : null;

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
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <TournamentDetailsModal
        isOpen={Boolean(selectedTournament)}
        onClose={() => setSelectedTournament(null)}
        tournament={selectedTournament}
        historyRecord={selectedTournament ? historyById[String(selectedTournament.id)] ?? null : null}
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
        onEditSettings={handleManagerEditSettings}
      />
    </div>
  );
}
