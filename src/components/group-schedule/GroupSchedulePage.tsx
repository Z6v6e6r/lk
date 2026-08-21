import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { BookingCancellationDialog } from "../cabinet/BookingCancellationDialog";
import {
  ChevronRightIcon,
  GameDateIcon,
  GameLevelIcon,
  GameLocationIcon,
  PeopleIcon,
  TennisRacketIcon,
} from "../cabinet/community-feed/CommunityIcons";
import { CommunityTournamentCard } from "../cabinet/community-feed/CommunityTournamentCard";
import type { CommunityTournamentCard as CommunityTournamentCardData } from "../cabinet/community-feed/feedTypes";
import { useAuth } from "../../context/AuthContext";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import {
  apiFetchGroupTrainingDetail,
  apiFetchGroupTrainingsByDate,
  GROUP_SCHEDULE_BOOKING_DAYS,
  type GroupTrainingSummary,
} from "../../utils/groupScheduleApi";
import { buildGroupScheduleReturnUrl, normalizeGroupScheduleDate } from "../../utils/groupScheduleEntry";
import { isGamePlusTrainerSummary } from "../../utils/groupScheduleModel";
import {
  apiFetchTournamentParticipants,
} from "../../utils/apiClient";
import {
  apiCancelTournamentVivaRegistration,
  apiCreateTournamentVivaTransaction,
  apiFetchTournamentVivaCheckout,
  apiFetchTournamentVivaMyRegistration,
  apiPreviewTournamentVivaTransaction,
  apiResolveTournamentVivaRegistrationBookingId,
  type TournamentRegistrationState,
  type TournamentVivaCheckout,
  type TournamentVivaProduct,
} from "../../utils/tournamentSignupApi";
import {
  getAppliedGroupSchedulePromoPreview,
  isGroupSchedulePromoPreviewApplicable,
  isGroupSchedulePromoProduct,
  normalizeGroupSchedulePromoCode,
  type AppliedGroupSchedulePromo,
} from "../../utils/groupSchedulePromo";
import {
  normalizeTournamentSignupPublicRoster,
  type TournamentSignupPublicRoster,
} from "../../utils/tournamentSignupRoster";
import type {
  BookingCancellationAction,
} from "../../utils/bookingCancellation";
import {
  pickSubscriptionValidityDate,
  resolveSubscriptionUsageDisplay,
} from "../../utils/subscriptionValidity";
import "./GroupSchedulePage.css";

interface GroupSchedulePageProps {
  onBack: () => void;
  initialExerciseId?: string | null;
  initialDate?: string | null;
  initialStudioId?: string | null;
  returnToFindGame?: boolean;
}

const ALL_FILTER_VALUE = "__all__";
const TYPE_FILTER_ALL_LABEL = "Все типы";
const GROUP_SCHEDULE_SUBSCRIPTION_URL = "https://padlhub.ru/ab_leto";
const GROUP_SCHEDULE_PROMO_TRIGGER_TEXT = "у меня есть промокод";
const GAME_PLUS_TRAINER_DEFAULT_DESCRIPTION = {
  heading: "Игровая тренировка с тренером",
  lead: "Совершенствуйте удары и тактику прямо во время игры!",
  bullets: [
    "3 участника + тренер — максимум пользы и внимания",
    "Разбор ударов, постановка техники, игровая тактика",
    "Тренер корректирует ваши действия прямо в игре",
    "Гибкие условия: разовое посещение или абонемент",
  ],
};
function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getInitialDate(value?: string | null) {
  const normalized = normalizeGroupScheduleDate(value);
  if (normalized) return normalized;
  return formatDate(new Date());
}

function buildDateRange(initialDate: string) {
  const start = new Date(`${initialDate}T00:00:00`);
  const safeStart = Number.isNaN(start.getTime()) ? new Date() : start;
  return Array.from({ length: GROUP_SCHEDULE_BOOKING_DAYS }, (_, index) => {
    const next = new Date(safeStart);
    next.setDate(safeStart.getDate() + index);
    return next;
  });
}

function formatClock(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return raw.match(/\d{2}:\d{2}/)?.[0] || "";
}

function formatDateLabel(value: string | null | undefined) {
  const date = normalizeGroupScheduleDate(value);
  if (!date) return "Дата уточняется";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата уточняется";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function formatTimeRange(value: string | null | undefined) {
  return String(value || "").replace(/\s*-\s*/, "–");
}

function formatTrainerDateTimeLabel(training: GroupTrainingSummary) {
  const dateLabel = formatDateLabel(training.date);
  const timeLabel = formatTimeRange(training.timeLabel);
  return timeLabel ? `${dateLabel} · ${timeLabel}` : dateLabel;
}

function formatTrainerStationCourtLabel(training: GroupTrainingSummary) {
  const stationLabel = String(training.studioName || "").trim() || "Уточняется";
  const courtLabel = String(training.roomName || "").trim();
  return courtLabel ? `${stationLabel} · ${courtLabel}` : stationLabel;
}

function formatPlaces(count: number) {
  const safeCount = Math.max(0, Math.floor(count));
  const lastTwo = safeCount % 100;
  const last = safeCount % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${safeCount} мест`;
  if (last === 1) return `${safeCount} место`;
  if (last >= 2 && last <= 4) return `${safeCount} места`;
  return `${safeCount} мест`;
}

function formatAvailabilityLabel(training: GroupTrainingSummary) {
  if (training.status === "FULL") return "Мест нет";
  if (training.status === "CANCELLED") return "Отменено";
  if (training.spotsLeft == null) return "Запись открыта";
  return `Осталось ${formatPlaces(training.spotsLeft)}`;
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "ru-RU"));
}

function getTrainingTypeFilterLabel(training: GroupTrainingSummary) {
  return training.directionName || training.title || training.typeName || "Тренировка";
}

function formatSelectedTypeFilterLabel(values: string[]) {
  if (values.length === 0) return TYPE_FILTER_ALL_LABEL;
  if (values.length === 1) return values[0] || TYPE_FILTER_ALL_LABEL;
  return `${values.length} выбрано`;
}

function formatMoneyMinor(value: number | null) {
  if (value == null) return "Стоимость уточняется";
  return `${(value / 100).toLocaleString("ru-RU")} ₽`;
}

function getProductExpirationDate(product: TournamentVivaProduct) {
  return pickSubscriptionValidityDate(product.raw);
}

function formatProductUsageLabel(product: TournamentVivaProduct) {
  return resolveSubscriptionUsageDisplay({
    subscriptionName: product.name,
    validityDate: getProductExpirationDate(product),
    raw: product.raw,
    validityPrefix: "действует до",
  })?.label ?? "";
}

function formatProductPrice(product: TournamentVivaProduct) {
  return product.priceLabel || formatMoneyMinor(product.cost);
}

function formatProductVisits(product: TournamentVivaProduct) {
  if (product.source === "one-time" || product.source === "client-one-time") return "";
  if (!product.visitsTotal) return "";
  return ` / ${product.visitsTotal} посещ.`;
}

function formatProductValidity(product: TournamentVivaProduct) {
  if (product.source !== "client-subscription") return "";
  return formatProductUsageLabel(product) || "срок уточняется";
}

function getErrorMessage(error: { message?: string | null } | null | undefined, fallback: string) {
  return String(error?.message || "").trim() || fallback;
}

function navigateToExternalUrl(urlRaw: string): boolean {
  if (typeof window === "undefined") return false;
  const target = urlRaw.trim();
  if (!target) return false;

  try {
    if (window.top && window.top !== window) {
      window.top.location.href = target;
      return true;
    }
  } catch {
    // Use current frame below when top navigation is blocked.
  }

  try {
    window.location.assign(target);
    return true;
  } catch {
    // Use an anchor click as a last resort inside embedded pages.
  }

  try {
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.target = "_self";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path d="m6.2 10.1 2.2 2.25 5.25-5.3" stroke="var(--white)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function stripDescriptionBullet(value: string) {
  return value.replace(/^\s*[-—•]\s*/, "").trim();
}

function getNameInitials(value: string | null | undefined) {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "PH";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function buildGamePlusTrainerDescription(training: GroupTrainingSummary) {
  const lines = String(training.directionDescription || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const formatIndex = lines.findIndex((line) => /^формат:?$/i.test(line));
  const formatLines = (formatIndex >= 0 ? lines.slice(formatIndex + 1) : lines)
    .filter((line) => /^[-—•]\s*/.test(line))
    .map(stripDescriptionBullet)
    .filter(Boolean);
  const lead = lines.find((line, index) => (
    index > 0
    && !/^хотите/i.test(line)
    && !/^формат:?$/i.test(line)
    && !/^[-—•]\s*/.test(line)
    && !line.startsWith("—")
  ));

  return {
    heading: lines[0] || GAME_PLUS_TRAINER_DEFAULT_DESCRIPTION.heading,
    lead: lead || GAME_PLUS_TRAINER_DEFAULT_DESCRIPTION.lead,
    bullets: formatLines.length > 0 ? formatLines : GAME_PLUS_TRAINER_DEFAULT_DESCRIPTION.bullets,
  };
}

function buildGroupTrainingDescription(training: GroupTrainingSummary) {
  const description = String(training.directionDescription || "").trim();
  if (!description) return null;
  return {
    heading: training.directionName || training.title,
    lead: description,
    bullets: [] as string[],
  };
}

function getTrainingDetailEyebrow(training: GroupTrainingSummary, isGamePlusTrainer: boolean) {
  if (isGamePlusTrainer) return "ИГРА+ТРЕНЕР";
  return (training.typeName || "Групповая тренировка").toLocaleUpperCase("ru-RU");
}

function getTrainingDetailTitleLines(training: GroupTrainingSummary, isGamePlusTrainer: boolean) {
  if (!isGamePlusTrainer) return [training.title];
  return [
    "Игра+Тренер.",
    training.levelLabel ? `Уровень ${training.levelLabel}` : training.title,
  ];
}

function getTrainingCtaLabel(training: GroupTrainingSummary) {
  if (training.inBooking) return "Открыть";
  if (training.inWaitlist) return "Лист ожидания";
  if (training.status === "FULL") return "В лист ожидания";
  if (training.status === "CANCELLED") return "Отменено";
  return "Записаться";
}

function toTrainingCard(training: GroupTrainingSummary): CommunityTournamentCardData {
  const spotsLeft = training.spotsLeft;
  const stationLabel = training.studioName || "Станция уточняется";
  const startTime = formatClock(training.timeFrom);
  const endTime = formatClock(training.timeTo);

  return {
    id: training.id,
    badgeLabel: training.typeName || "Тренировка",
    title: training.title,
    subtitle: training.studioName || "Станция уточняется",
    metaText: [training.typeName, `Старт ${startTime}`, stationLabel].filter(Boolean).join(" • "),
    progress: training.maxClientsCount > 0 ? training.clientsCount / training.maxClientsCount : 0,
    imageUrl: "",
    media: "",
    isJoined: training.inBooking || training.inWaitlist,
    isFull: training.status === "FULL",
    date: training.date || training.timeFrom,
    level: training.levelLabel || training.typeName || "Уровень из Viva",
    participants: training.clientsCount,
    maxParticipants: Math.max(training.maxClientsCount, training.clientsCount, 1),
    startTime,
    endTime,
    duration: training.timeLabel,
    stationLabel,
    tournamentTypeLabel: training.typeName || "Тренировка",
    ratingLabel: training.levelLabel || training.directionName || undefined,
    genderLabel: training.girlsOnly ? "женская группа" : "М/Ж",
    slotsLabel: training.maxClientsCount > 0
      ? `${training.clientsCount}/${training.maxClientsCount} мест`
      : `${training.clientsCount} записей`,
    ctaLabel: getTrainingCtaLabel(training),
    trainerName: training.trainerName || "PadelHub",
    trainerAvatarUrl: training.trainerAvatarUrl || undefined,
    profileHandle: training.studioName || undefined,
    waitlistCount: training.inWaitlist ? 1 : 0,
    spotsLeft,
    priceLabel: training.status === "FULL"
      ? "мест нет"
      : spotsLeft == null
        ? "запись"
        : `осталось ${spotsLeft}`,
  };
}

function buildPaymentReturnUrls(training: GroupTrainingSummary) {
  if (typeof window === "undefined") return { successUrl: null, failUrl: null };
  const successUrl = buildGroupScheduleReturnUrl(window.location.href, {
    exerciseId: training.id,
    date: training.date,
    paymentStatus: "success",
  });
  const failUrl = buildGroupScheduleReturnUrl(window.location.href, {
    exerciseId: training.id,
    date: training.date,
    paymentStatus: "failed",
  });
  return {
    successUrl: appendCurrentAuthModeToNavigableUrl(successUrl).toString(),
    failUrl: appendCurrentAuthModeToNavigableUrl(failUrl).toString(),
  };
}

export default function GroupSchedulePage({
  onBack,
  initialExerciseId,
  initialDate,
  initialStudioId,
  returnToFindGame = false,
}: GroupSchedulePageProps) {
  const { isAuthenticated, isRestoringSession } = useAuth();
  const baseDate = useMemo(() => getInitialDate(initialDate), [initialDate]);
  const dates = useMemo(() => buildDateRange(baseDate), [baseDate]);
  const [dateIndex, setDateIndex] = useState(0);
  const selectedDate = formatDate(dates[dateIndex] ?? dates[0] ?? new Date());
  const [items, setItems] = useState<GroupTrainingSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedTypeFilters, setSelectedTypeFilters] = useState<string[]>([]);
  const [typeFilterOptions, setTypeFilterOptions] = useState<string[]>([]);
  const [isTypeFilterOpen, setTypeFilterOpen] = useState(false);
  const [stationFilter, setStationFilter] = useState(initialStudioId || ALL_FILTER_VALUE);
  const [selectedId, setSelectedId] = useState<string | null>(initialExerciseId || null);
  const [selectedDetail, setSelectedDetail] = useState<GroupTrainingSummary | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRoster, setDetailRoster] = useState<TournamentSignupPublicRoster | null>(null);
  const [detailRosterLoading, setDetailRosterLoading] = useState(false);
  const [detailRosterError, setDetailRosterError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<TournamentVivaCheckout | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationState | null>(null);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState("");
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [appliedPromo, setAppliedPromo] = useState<AppliedGroupSchedulePromo | null>(null);
  const promoRequestIdRef = useRef(0);
  const [isPurchaseListOpen, setPurchaseListOpen] = useState(true);
  const [isGroupSchedulePromoExpanded, setGroupSchedulePromoExpanded] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelBookingId, setCancelBookingId] = useState<string | null>(null);
  const initialOpenRef = useRef(false);
  const typeFilterRef = useRef<HTMLDivElement | null>(null);
  const typeFilterListboxId = useId();
  const groupSchedulePromoSectionId = useId();

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    const result = await apiFetchGroupTrainingsByDate(selectedDate);
    if (result.error || !result.data) {
      setItems([]);
      setListError(getErrorMessage(result.error, "Не удалось загрузить расписание."));
      setLoadingList(false);
      return;
    }
    setItems(result.data);
    setLoadingList(false);

    if (!initialOpenRef.current && selectedId) {
      const selected = result.data.find((item) => item.id === selectedId) ?? null;
      if (selected) {
        setSelectedDetail(selected);
        initialOpenRef.current = true;
      }
    }
  }, [selectedDate, selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    const nextOptions = uniqueSorted(items.map(getTrainingTypeFilterLabel));
    if (nextOptions.length === 0) return;
    setTypeFilterOptions((previous) => uniqueSorted([...previous, ...nextOptions]));
  }, [items]);

  useEffect(() => {
    if (!isTypeFilterOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && typeFilterRef.current?.contains(target)) return;
      setTypeFilterOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTypeFilterOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTypeFilterOpen]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      setDetailError(null);
      return;
    }
    const fromList = items.find((item) => item.id === selectedId) ?? null;
    if (fromList) {
      setSelectedDetail(fromList);
      setDetailError(null);
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void apiFetchGroupTrainingDetail(selectedId).then((result) => {
      if (cancelled) return;
      setDetailLoading(false);
      if (result.error || !result.data) {
        setSelectedDetail(null);
        setDetailError(getErrorMessage(result.error, "Не удалось открыть тренировку."));
        return;
      }
      setSelectedDetail(result.data);
    });

    return () => {
      cancelled = true;
    };
  }, [items, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetailRoster(null);
      setDetailRosterLoading(false);
      setDetailRosterError(null);
      return;
    }

    const controller = new AbortController();
    setDetailRoster(null);
    setDetailRosterLoading(true);
    setDetailRosterError(null);
    void apiFetchTournamentParticipants(selectedId, {
      auth: false,
      retries: 0,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetailRosterLoading(false);
        if (result.error || !result.data) {
          setDetailRosterError(getErrorMessage(result.error, "Не удалось загрузить состав."));
          return;
        }
        setDetailRoster(normalizeTournamentSignupPublicRoster(result.data));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetailRosterLoading(false);
        setDetailRosterError(error instanceof Error ? error.message : "Не удалось загрузить состав.");
      });

    return () => controller.abort();
  }, [selectedId]);

  const loadRegistrationState = useCallback(async (training: GroupTrainingSummary) => {
    if (!isAuthenticated || isRestoringSession) return;
    setRegistrationLoading(true);
    setDetailError(null);
    const [registrationResult, checkoutResult] = await Promise.all([
      apiFetchTournamentVivaMyRegistration(training.id).catch((error) => ({
        data: null,
        error: { status: null, message: error instanceof Error ? error.message : "Не удалось проверить запись" },
        status: null,
      })),
      apiFetchTournamentVivaCheckout(training.id, { tournament: training.raw }).catch((error) => ({
        data: null,
        error: { status: null, message: error instanceof Error ? error.message : "Не удалось получить способы записи" },
        status: null,
      })),
    ]);

    setRegistration(registrationResult.data ?? null);
    if (checkoutResult.error || !checkoutResult.data) {
      setCheckout(null);
      setDetailError(getErrorMessage(checkoutResult.error, "Не удалось получить способы записи."));
    } else {
      setCheckout(checkoutResult.data);
    }
    setRegistrationLoading(false);
  }, [isAuthenticated, isRestoringSession]);

  useEffect(() => {
    if (!selectedDetail) {
      setCheckout(null);
      setRegistration(null);
      setActionMessage(null);
      return;
    }
    if (!isAuthenticated || isRestoringSession) {
      setCheckout(null);
      setRegistration(null);
      return;
    }
    void loadRegistrationState(selectedDetail);
  }, [isAuthenticated, isRestoringSession, loadRegistrationState, selectedDetail]);

  useEffect(() => {
    promoRequestIdRef.current += 1;
    setPromoInput("");
    setPromoError(null);
    setAppliedPromo(null);
    setPromoLoading(false);
    setGroupSchedulePromoExpanded(false);

    return () => {
      promoRequestIdRef.current += 1;
    };
  }, [isAuthenticated, selectedId]);

  const stationFilterOptions = useMemo(
    () => uniqueSorted(items.map((item) => item.studioName || "Станция уточняется")),
    [items],
  );
  const visibleTypeFilterOptions = useMemo(
    () => uniqueSorted([...typeFilterOptions, ...selectedTypeFilters]),
    [selectedTypeFilters, typeFilterOptions],
  );
  const selectedTypeFilterSet = useMemo(
    () => new Set(selectedTypeFilters),
    [selectedTypeFilters],
  );
  const typeFilterLabel = formatSelectedTypeFilterLabel(selectedTypeFilters);
  const typeFilterTitle = selectedTypeFilters.length > 0
    ? selectedTypeFilters.join(", ")
    : TYPE_FILTER_ALL_LABEL;
  const filteredItems = useMemo(
    () => {
      return items.filter((item) => {
        const typeLabel = getTrainingTypeFilterLabel(item);
        return (
          (selectedTypeFilterSet.size === 0 || selectedTypeFilterSet.has(typeLabel))
          && (stationFilter === ALL_FILTER_VALUE || (item.studioName || "Станция уточняется") === stationFilter)
        );
      });
    },
    [items, selectedTypeFilterSet, stationFilter],
  );

  const selectedTraining = selectedDetail;
  const isRegistered = Boolean(registration && registration.status !== "NONE");
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  const purchasableProducts = checkout ? [...checkout.oneTimes, ...checkout.subscriptions] : [];
  const isGamePlusTrainerDetail = selectedTraining ? isGamePlusTrainerSummary(selectedTraining) : false;
  const detailDescription = selectedTraining
    ? isGamePlusTrainerDetail
      ? buildGamePlusTrainerDescription(selectedTraining)
      : buildGroupTrainingDescription(selectedTraining)
    : null;
  const detailEyebrow = selectedTraining ? getTrainingDetailEyebrow(selectedTraining, isGamePlusTrainerDetail) : "";
  const detailTitleLines = selectedTraining ? getTrainingDetailTitleLines(selectedTraining, isGamePlusTrainerDetail) : [];
  const shouldShowSubscriptionPurchaseLink = Boolean(checkout && checkout.subscriptions.length > 0);
  const shouldShowGroupSchedulePromoSection = Boolean(checkout && checkout.oneTimes.some(isGroupSchedulePromoProduct));
  const shouldExitInitialDetail = Boolean(returnToFindGame && initialExerciseId && selectedId === initialExerciseId);

  const handleBackClick = useCallback(() => {
    if (!selectedId) {
      onBack();
      return;
    }
    if (shouldExitInitialDetail) {
      onBack();
      return;
    }
    setSelectedId(null);
  }, [onBack, selectedId, shouldExitInitialDetail]);

  const applyPromoCode = useCallback(async (
    training: GroupTrainingSummary,
    activeCheckout: TournamentVivaCheckout,
  ) => {
    const code = normalizeGroupSchedulePromoCode(promoInput);
    if (!code) {
      setPromoError("Введите промокод.");
      setAppliedPromo(null);
      return;
    }
    if (!activeCheckout.profile?.phone) {
      setPromoError("Не удалось получить телефон профиля Viva.");
      setAppliedPromo(null);
      return;
    }

    const promoProducts = activeCheckout.oneTimes.filter(isGroupSchedulePromoProduct);
    if (promoProducts.length === 0) {
      setPromoError("Для этой тренировки нет разовой услуги, доступной по промокоду.");
      setAppliedPromo(null);
      return;
    }

    setPromoLoading(true);
    setPromoError(null);
    setAppliedPromo(null);
    setPromoInput(code);
    const requestId = ++promoRequestIdRef.current;

    const previewResults = await Promise.all(promoProducts.map(async (product) => ({
      product,
      result: await apiPreviewTournamentVivaTransaction({
        exerciseId: training.id,
        studioId: activeCheckout.studioId,
        clientPhone: activeCheckout.profile?.phone || "",
        clientId: activeCheckout.profile?.id,
        profile: activeCheckout.profile,
        product,
        exercise: activeCheckout.exercise,
        tournament: training.raw,
        promoCode: code,
      }),
    })));
    if (promoRequestIdRef.current !== requestId) return;

    const previewsByProductId = Object.fromEntries(previewResults.flatMap(({ product, result }) => (
      result.data && isGroupSchedulePromoPreviewApplicable(result.data)
        ? [[product.id, result.data] as const]
        : []
    )));
    setPromoLoading(false);

    if (Object.keys(previewsByProductId).length === 0) {
      const firstError = previewResults.find(({ result }) => result.error)?.result.error;
      setPromoError(getErrorMessage(
        firstError,
        "Промокод не подходит этому клиенту или выбранной тренировке.",
      ));
      return;
    }

    setAppliedPromo({ code, previewsByProductId });
  }, [promoInput]);

  const completeRegistration = useCallback(async (
    training: GroupTrainingSummary,
    activeCheckout: TournamentVivaCheckout,
    product: TournamentVivaProduct,
    promoCode?: string | null,
  ) => {
    if (!activeCheckout.profile?.phone) {
      setDetailError("Не удалось получить телефон профиля Viva.");
      return;
    }

    setActionLoading(true);
    setDetailError(null);
    setActionMessage(null);
    const returnUrls = buildPaymentReturnUrls(training);
    const result = await apiCreateTournamentVivaTransaction({
      exerciseId: training.id,
      studioId: activeCheckout.studioId,
      clientPhone: activeCheckout.profile.phone,
      clientId: activeCheckout.profile.id,
      profile: activeCheckout.profile,
      product,
      exercise: activeCheckout.exercise,
      tournament: training.raw,
      promoCode: promoCode || null,
      successUrl: returnUrls.successUrl,
      failUrl: returnUrls.failUrl,
    });
    setActionLoading(false);

    if (result.error || !result.data) {
      setDetailError(getErrorMessage(result.error, "Не удалось создать запись."));
      return;
    }
    if (result.data.paymentUrl) {
      window.location.href = result.data.paymentUrl;
      return;
    }

    setActionMessage("Запись создана.");
    setRegistration({
      status: "REGISTERED",
      bookingId: result.data.bookingId,
      placeNumber: null,
      waitlistNumber: null,
      canRegister: false,
      canCancel: true,
      message: null,
      paymentUrl: null,
      paymentExpiresAt: null,
    });
    await loadRegistrationState(training);
    await loadList();
  }, [loadList, loadRegistrationState]);

  const openCancelDialog = useCallback(async () => {
    if (!selectedTraining) return;
    setActionLoading(true);
    setDetailError(null);
    const result = await apiResolveTournamentVivaRegistrationBookingId(
      selectedTraining.id,
      registration?.bookingId,
      { placeNumber: registration?.placeNumber },
    );
    setActionLoading(false);
    if (result.error || !result.data) {
      setDetailError(getErrorMessage(result.error, "Не удалось найти запись для отмены."));
      return;
    }
    setCancelBookingId(result.data);
    setCancelDialogOpen(true);
  }, [registration?.bookingId, registration?.placeNumber, selectedTraining]);

  const cancelRegistration = useCallback(async (
    action: BookingCancellationAction,
  ) => {
    if (!selectedTraining) {
      return { ok: false, message: "Тренировка не выбрана." };
    }
    setActionLoading(true);
    setDetailError(null);
    setActionMessage(null);
    const result = await apiCancelTournamentVivaRegistration(
      selectedTraining.id,
      cancelBookingId || registration?.bookingId,
      {
        placeNumber: registration?.placeNumber,
        refundMethod: action.refundMethod,
      },
    );
    setActionLoading(false);
    if (result.error) {
      return { ok: false, message: getErrorMessage(result.error, "Не удалось отменить запись.") };
    }
    const message = result.data?.message || action.successMessage || "Запись отменена.";
    setActionMessage(message);
    setRegistration(result.data ?? null);
    await loadRegistrationState(selectedTraining);
    await loadList();
    return { ok: true, message };
  }, [cancelBookingId, loadList, loadRegistrationState, registration?.bookingId, registration?.placeNumber, selectedTraining]);

  return (
    <div className="group-schedule-page tournament-signup-page">
      <header className="tournament-signup-header">
        <button
          className="page-back"
          onClick={handleBackClick}
          type="button"
        >
          ← Назад
        </button>
        <div className="tournament-signup-header-title">
          <div className="page-title">Групповые тренировки</div>
        </div>
      </header>

      {!selectedId && (
        <section className="tournament-signup-section">
          <div className="date-row">
            {dates.map((date, index) => {
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
                    className={`date-chip ${dateIndex === index ? "active" : ""}`}
                    type="button"
                    onClick={() => {
                      setDateIndex(index);
                      setSelectedId(null);
                    }}
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

          <div className="tournament-signup-filterbar">
            <div className="tournament-signup-filter group-schedule-type-filter" ref={typeFilterRef}>
              <span>Тип</span>
              <button
                type="button"
                className="group-schedule-type-filter-trigger"
                aria-haspopup="listbox"
                aria-expanded={isTypeFilterOpen}
                aria-controls={typeFilterListboxId}
                title={typeFilterTitle}
                onClick={() => setTypeFilterOpen((isOpen) => !isOpen)}
              >
                <span className="group-schedule-type-filter-value">{typeFilterLabel}</span>
                <ChevronDownIcon className={`group-schedule-type-filter-chevron${isTypeFilterOpen ? " is-open" : ""}`} />
              </button>

              {isTypeFilterOpen && (
                <div
                  className="group-schedule-type-filter-menu"
                  id={typeFilterListboxId}
                  role="listbox"
                  aria-multiselectable="true"
                >
                  <button
                    type="button"
                    className={`group-schedule-type-filter-option${selectedTypeFilters.length === 0 ? " is-selected" : ""}`}
                    role="option"
                    aria-selected={selectedTypeFilters.length === 0}
                    onClick={() => setSelectedTypeFilters([])}
                  >
                    <span className="group-schedule-type-filter-check" aria-hidden="true">
                      {selectedTypeFilters.length === 0 ? "✓" : ""}
                    </span>
                    <span>{TYPE_FILTER_ALL_LABEL}</span>
                  </button>
                  {visibleTypeFilterOptions.length === 0 ? (
                    <div className="group-schedule-type-filter-empty">Направления не найдены</div>
                  ) : visibleTypeFilterOptions.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`group-schedule-type-filter-option${selectedTypeFilterSet.has(value) ? " is-selected" : ""}`}
                      role="option"
                      aria-selected={selectedTypeFilterSet.has(value)}
                      onClick={() => {
                        setSelectedTypeFilters((previous) => (
                          previous.includes(value)
                            ? previous.filter((item) => item !== value)
                            : uniqueSorted([...previous, value])
                        ));
                      }}
                    >
                      <span className="group-schedule-type-filter-check" aria-hidden="true">
                        {selectedTypeFilterSet.has(value) ? "✓" : ""}
                      </span>
                      <span>{value}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="tournament-signup-filter">
              <span>Станция</span>
              <select value={stationFilter} onChange={(event) => setStationFilter(event.target.value)}>
                <option value={ALL_FILTER_VALUE}>Все станции</option>
                {stationFilterOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>

            <button
              className="tournament-signup-refresh"
              type="button"
              onClick={() => void loadList()}
              disabled={loadingList}
              aria-label="Обновить расписание"
              title="Обновить"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6v5h-5" />
                <path d="M4 18v-5h5" />
                <path d="M18.2 9A7 7 0 0 0 6.4 6.3L4 8.5" />
                <path d="M5.8 15A7 7 0 0 0 17.6 17.7L20 15.5" />
              </svg>
            </button>
          </div>

          {loadingList && <div className="tournament-signup-muted">Загрузка...</div>}
          {!loadingList && listError && <div className="tournament-signup-error">{listError}</div>}
          {!loadingList && !listError && items.length === 0 && (
            <div className="tournament-signup-muted">На выбранную дату тренировок нет</div>
          )}
          {!loadingList && !listError && items.length > 0 && filteredItems.length === 0 && (
            <div className="tournament-signup-muted">По выбранным фильтрам тренировок нет</div>
          )}

          <div className="tournament-signup-list group-schedule-list">
            {filteredItems.map((training) => (
              <CommunityTournamentCard
                key={training.id}
                card={toTrainingCard(training)}
                variant="groupSchedule"
                onOpen={() => {
                  setSelectedId(training.id);
                  setSelectedDetail(training);
                  setDetailError(null);
                  setActionMessage(null);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {selectedId && (
        <section className="tournament-signup-section tournament-signup-detail group-schedule-detail group-schedule-detail--trainer">
          {detailLoading && <div className="tournament-signup-muted">Загрузка тренировки...</div>}
          {!detailLoading && detailError && <div className="tournament-signup-error">{detailError}</div>}
          {!detailLoading && !selectedTraining && !detailError && (
            <div className="tournament-signup-muted">Тренировка не найдена</div>
          )}
          {selectedTraining && (
            <>
              <div className="details-card group-schedule-details-card group-schedule-details-card--trainer">
                <div className="group-schedule-trainer-hero">
                  <div className="group-schedule-trainer-eyebrow">{detailEyebrow}</div>
                  <div className="group-schedule-trainer-title-row">
                    <h1 className="group-schedule-trainer-title">
                      {detailTitleLines.map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </h1>
                    {selectedTraining.levelLabel && (
                      <span className="group-schedule-level-pill">{selectedTraining.levelLabel}</span>
                    )}
                  </div>
                  <div className="group-schedule-trainer-status-pill">
                    <PeopleIcon className="group-schedule-trainer-status-icon" />
                    <span>{formatAvailabilityLabel(selectedTraining)}</span>
                  </div>
                </div>

                <div className="group-schedule-trainer-info-card" aria-label="Основная информация">
                  <div className="group-schedule-trainer-info-row">
                    <span className="group-schedule-trainer-info-icon"><GameDateIcon /></span>
                    <span className="group-schedule-trainer-info-label">Дата</span>
                    <strong className="group-schedule-trainer-info-value">{formatTrainerDateTimeLabel(selectedTraining)}</strong>
                  </div>
                  <div className="group-schedule-trainer-info-row">
                    <span className="group-schedule-trainer-info-icon"><GameLocationIcon /></span>
                    <span className="group-schedule-trainer-info-label">Станция</span>
                    <strong className="group-schedule-trainer-info-value">{formatTrainerStationCourtLabel(selectedTraining)}</strong>
                  </div>
                  <div className="group-schedule-trainer-info-row group-schedule-trainer-info-row--person">
                    <span className="group-schedule-trainer-avatar" aria-hidden="true">
                      {selectedTraining.trainerAvatarUrl ? (
                        <img src={selectedTraining.trainerAvatarUrl} alt="" />
                      ) : (
                        <span>{getNameInitials(selectedTraining.trainerName)}</span>
                      )}
                    </span>
                    <span className="group-schedule-trainer-person-copy">
                      <span className="group-schedule-trainer-info-label">Тренер</span>
                      <strong className="group-schedule-trainer-info-value group-schedule-trainer-person-name">{selectedTraining.trainerName || "Уточняется"}</strong>
                    </span>
                    <ChevronRightIcon className="group-schedule-trainer-row-arrow" />
                  </div>
                  <div className="group-schedule-trainer-info-row">
                    <span className="group-schedule-trainer-info-icon"><GameLevelIcon /></span>
                    <span className="group-schedule-trainer-info-label">Уровень</span>
                    <strong className="group-schedule-trainer-info-value">{selectedTraining.levelLabel || "Уточняется"}</strong>
                  </div>
                </div>

                {detailDescription && (
                  <div className="group-schedule-trainer-description">
                    <strong>{detailDescription.heading}</strong>
                    {detailDescription.lead && <p>{detailDescription.lead}</p>}
                    {detailDescription.bullets.length > 0 && (
                      <ul>
                        {detailDescription.bullets.map((item) => (
                          <li key={item}>
                            <CheckIcon className="group-schedule-trainer-check" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {isGamePlusTrainerDetail && (
                  <div className="group-schedule-trainer-description" aria-label="Состав игры">
                    <strong>Участники</strong>
                    {detailRosterLoading && <p>Загрузка состава...</p>}
                    {!detailRosterLoading && detailRosterError && <p>{detailRosterError}</p>}
                    {!detailRosterLoading && !detailRosterError && detailRoster?.participants.length === 0 && (
                      <p>Участники пока не указаны.</p>
                    )}
                    {!detailRosterLoading && !detailRosterError && Boolean(detailRoster?.participants.length) && (
                      <ul>
                        {detailRoster?.participants.map((participant) => (
                          <li key={participant.id}>
                            <CheckIcon className="group-schedule-trainer-check" />
                            <span>{participant.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {!detailRosterLoading && !detailRosterError && Boolean(detailRoster?.waitlistCount) && (
                      <p>В листе ожидания: {detailRoster?.waitlistCount}</p>
                    )}
                  </div>
                )}

                {selectedTraining.whatToTake && (
                  <div className="group-schedule-trainer-take-note">
                    <span className="group-schedule-trainer-info-icon"><TennisRacketIcon /></span>
                    <span>Что взять: {selectedTraining.whatToTake}</span>
                  </div>
                )}
              </div>

              <div className="tournament-signup-registration group-schedule-registration group-schedule-registration--trainer">
                {isRestoringSession && <div className="tournament-signup-muted">Проверяем сессию...</div>}
                {!isRestoringSession && !isAuthenticated && (
                  <div className="tournament-signup-auth">
                    <div className="tournament-signup-auth-head">
                      <strong>Вход для записи</strong>
                    </div>
                    <AuthForm onLogin={() => {}} />
                  </div>
                )}

                {!isRestoringSession && isAuthenticated && (
                  <>
                    <div className="tournament-signup-auth-head">
                      <strong>
                        <span className="tournament-signup-auth-title">
                          {isGamePlusTrainerDetail ? "Доступные варианты" : "Способ записи"}
                        </span>
                      </strong>
                    </div>
                    {registrationLoading && <div className="tournament-signup-muted">Проверяем доступные варианты...</div>}
                    {actionMessage && <div className="group-schedule-success">{actionMessage}</div>}
                    {registration?.status === "PAYMENT_PENDING" && registration.paymentUrl && (
                      <div className="tournament-signup-payment-hold">
                        <span>Ожидает оплаты</span>
                        <button
                          type="button"
                          className="section-cta"
                          onClick={() => {
                            window.location.href = registration.paymentUrl || "";
                          }}
                          disabled={actionLoading}
                        >
                          Продолжить оплату
                        </button>
                      </div>
                    )}
                    {isRegistered && registration?.status !== "PAYMENT_PENDING" && (
                      <div className="group-schedule-registered">
                        <strong>{registration?.status === "WAITLIST" ? "Вы в листе ожидания" : "Вы записаны"}</strong>
                        {canCancel && (
                          <button
                            type="button"
                            className="tournament-signup-danger"
                            onClick={() => void openCancelDialog()}
                            disabled={actionLoading}
                          >
                            Отменить запись
                          </button>
                        )}
                      </div>
                    )}

                    {!registrationLoading && !isRegistered && checkout && (
                      <div className="tournament-signup-payment-options">
                        {checkout.clientSubscriptions.length > 0 && (
                          <div className="tournament-signup-payment-group">
                            {!isGamePlusTrainerDetail && (
                              <div className="tournament-signup-payment-title">Доступные абонементы</div>
                            )}
                            {checkout.clientSubscriptions.map((product) => (
                              <button
                                key={`${product.source}-${product.id}`}
                                className="tournament-signup-payment-option tournament-signup-payment-option-subscription"
                                type="button"
                                onClick={() => void completeRegistration(selectedTraining, checkout, product)}
                                disabled={actionLoading}
                              >
                                <span>{product.name}</span>
                                <div className="tournament-signup-payment-option-meta">
                                  <strong>{formatProductValidity(product)}</strong>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}

                        {purchasableProducts.length > 0 && (
                          <div className="tournament-signup-payment-group">
                            <button
                              type="button"
                              className="tournament-signup-payment-purchase-toggle"
                              onClick={() => setPurchaseListOpen((current) => !current)}
                              disabled={actionLoading}
                            >
                              {isPurchaseListOpen ? "Скрыть варианты" : "Записаться разово или по абонементу"}
                            </button>
                            {isPurchaseListOpen && (
                              <div className="tournament-signup-payment-purchase-list">
                                {purchasableProducts.map((product) => {
                                  const promoPreview = getAppliedGroupSchedulePromoPreview(appliedPromo, product);
                                  return (
                                    <button
                                      key={`${product.source}-${product.id}`}
                                      className="tournament-signup-payment-option"
                                      type="button"
                                      onClick={() => void completeRegistration(
                                        selectedTraining,
                                        checkout,
                                        product,
                                        promoPreview ? appliedPromo?.code : null,
                                      )}
                                      disabled={actionLoading || promoLoading}
                                    >
                                      <span>{product.name}</span>
                                      <strong className={promoPreview ? "group-schedule-promo-price" : undefined}>
                                        {promoPreview ? (
                                          <>
                                            <span className="group-schedule-promo-price-old">
                                              {formatMoneyMinor(promoPreview.sumMinor)}
                                            </span>
                                            <span>{formatMoneyMinor(promoPreview.toPayMinor)}</span>
                                          </>
                                        ) : (
                                          <>
                                            {formatProductPrice(product)}
                                            {formatProductVisits(product)}
                                          </>
                                        )}
                                      </strong>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}

                        {shouldShowSubscriptionPurchaseLink && (
                          <div className="tournament-signup-payment-group">
                            <button
                              type="button"
                              className="tournament-signup-payment-subscription-link"
                              onClick={() => {
                                if (!navigateToExternalUrl(GROUP_SCHEDULE_SUBSCRIPTION_URL)) {
                                  setDetailError("Не удалось открыть страницу подписки. Попробуйте снова.");
                                }
                              }}
                              disabled={actionLoading}
                            >
                              Приобрести подписку РА / Академия
                            </button>
                          </div>
                        )}

                        {shouldShowGroupSchedulePromoSection && (
                          <>
                            <button
                              type="button"
                              className="group-schedule-promo-trigger"
                              onClick={() => setGroupSchedulePromoExpanded((current) => !current)}
                              aria-expanded={isGroupSchedulePromoExpanded}
                              aria-controls={groupSchedulePromoSectionId}
                            >
                              {GROUP_SCHEDULE_PROMO_TRIGGER_TEXT}
                            </button>
                            <div
                              className="group-schedule-promo-section"
                              id={groupSchedulePromoSectionId}
                              hidden={!isGroupSchedulePromoExpanded}
                              aria-hidden={!isGroupSchedulePromoExpanded}
                            >
                              <div className="group-schedule-promo" aria-label="Промокод">
                                <label className="group-schedule-promo-label" htmlFor="group-schedule-promo-code">
                                  Промокод
                                </label>
                                <div className="group-schedule-promo-controls">
                                  <input
                                    id="group-schedule-promo-code"
                                    className="group-schedule-promo-input"
                                    type="text"
                                    inputMode="text"
                                    autoComplete="off"
                                    value={promoInput}
                                    placeholder="Введите промокод"
                                    onChange={(event) => {
                                      setPromoInput(event.target.value);
                                      setPromoError(null);
                                      setAppliedPromo(null);
                                    }}
                                    disabled={promoLoading || actionLoading}
                                  />
                                  <button
                                    className="group-schedule-promo-apply"
                                    type="button"
                                    onClick={() => void applyPromoCode(selectedTraining, checkout)}
                                    disabled={promoLoading || actionLoading || !promoInput.trim()}
                                  >
                                    {promoLoading ? "Проверяем..." : "Применить"}
                                  </button>
                                </div>
                                {promoError && <div className="group-schedule-promo-error">{promoError}</div>}
                                {appliedPromo && (
                                  <div className="group-schedule-promo-success">
                                    Промокод применён. Viva подтвердила специальную цену.
                                  </div>
                                )}
                              </div>
                            </div>
                          </>
                        )}

                        {checkout.clientSubscriptions.length === 0 && purchasableProducts.length === 0 && (
                          <div className="tournament-signup-muted">Нет доступных способов записи.</div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {selectedTraining && (
        <BookingCancellationDialog
          isOpen={cancelDialogOpen}
          bookingId={cancelBookingId || registration?.bookingId || ""}
          onClose={() => setCancelDialogOpen(false)}
          executeAction={cancelRegistration}
        />
      )}
    </div>
  );
}
