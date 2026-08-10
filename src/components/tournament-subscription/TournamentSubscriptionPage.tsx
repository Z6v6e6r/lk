import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import {
  apiBuySubscroption,
  apiConfirmTournamentSubscriptionPurchase,
  apiCreateTournamentSubscriptionPurchase,
  apiFetchProfile,
  apiFetchTournamentSubscriptionStatus,
  type TournamentSubscriptionStatus,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS,
  isTournamentSubscriptionStorefrontPlanRetired,
  resolveTournamentSubscriptionCounterDisplayText,
  resolveTournamentSubscriptionCounterDisplayTotalLimit,
  resolveTournamentSubscriptionDirectProductId,
  resolveTournamentSubscriptionPromoOffer,
} from "../../utils/tournamentSubscriptionCatalog";
import {
  formatTournamentSubscriptionDropCountdown,
  resolveNextTournamentSubscriptionDailyDropAt,
} from "../../utils/tournamentSubscriptionDailyDrop";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import logoHabWhite from "../../assets/logo hab white.svg";
import summerSubscriptionAcademyImage from "../../assets/summer-subscription-academy.webp";
import summerSubscriptionEnergy5Image from "../../assets/summer-subscription-energy5.webp";
import summerSubscriptionFriendshipImage from "../../assets/summer-subscription-friendship.webp";
import summerSubscriptionRaImage from "../../assets/summer-subscription-ra.webp";
import summerSubscriptionSportImage from "../../assets/summer-subscription-sport.webp";

export type SubscriptionPlanId = "friendship" | "sport";
export type SubscriptionCounterKey = "academy" | "energy5" | "friendship" | "ra" | "sirius_friendship" | "sport";
export type SubscriptionArtworkKey = "academy" | "energy5" | "friendship" | "ra" | "sport";
export type TournamentSubscriptionPageVariant = "default" | "single_artwork" | "sirius_friendship";

export interface TournamentSubscriptionPageConfig {
  artworkKey?: SubscriptionArtworkKey | null;
  variant?: TournamentSubscriptionPageVariant | null;
  campaignKey?: string | null;
  planKey?: SubscriptionPlanId | null;
  priceLabel?: string | null;
  totalLimit?: number | null;
  offerKey?: string | null;
  autoPurchase?: boolean | null;
  trainerQrCode?: string | null;
}

interface TournamentSubscriptionPageProps {
  onBack: () => void;
  pageConfig?: TournamentSubscriptionPageConfig;
}

interface DisplayFeatureConfig {
  label: string;
  enabled: boolean;
}

type DisplayPlanPurchaseMode = "catalog_subscription" | "summer_campaign";

interface DisplayPlanConfig {
  id: string;
  counterKey?: SubscriptionCounterKey | null;
  planId?: SubscriptionPlanId | null;
  cardClassName?: string;
  artworkAlt?: string;
  artworkSrc?: string;
  buttonDisabled?: boolean;
  buttonLabel?: string;
  directSubscriptionProductId?: string | null;
  hideRemainingBlock?: boolean;
  purchaseBindingError?: string | null;
  purchaseMode?: DisplayPlanPurchaseMode;
  remainingValueText?: string | null;
  headClassName: string;
  accent: string;
  titleLines: [string, string];
  priceLabel: string;
  metaLabel?: string | null;
  bodyHeadline?: string | null;
  fallbackTotalLimit: number;
  remainingLabel: string;
  featureStatusAppearance: "badge" | "toggle";
  featureListClassName?: string;
  featureItemClassName?: string;
  featureLabelClassName?: string;
  features: DisplayFeatureConfig[];
}

interface PageViewConfig {
  pageClassName?: string;
  headerClassName?: string;
  plansClassName?: string;
  backgroundClassName?: string;
  showBackButton: boolean;
  plans: DisplayPlanConfig[];
  pageError?: string | null;
  singlePlanRequest?: {
    counterKey: SubscriptionCounterKey;
    planId: SubscriptionPlanId | null;
    campaignKey: string | null;
  };
}

interface PendingPaymentEntry {
  counterKey: SubscriptionCounterKey | null;
  paymentRef: string;
  planId: SubscriptionPlanId | null;
  campaignKey: string | null;
  createdAt: string;
}

interface PendingPurchaseRequest {
  displayId: string;
}

const EMPTY_PLAN_STATUSES: Record<SubscriptionCounterKey, TournamentSubscriptionStatus | null> = {
  academy: null,
  energy5: null,
  friendship: null,
  ra: null,
  sirius_friendship: null,
  sport: null,
};

const PAYMENT_REF_QUERY_KEY = "summerPaymentRef";
const DEFAULT_PLAN_LIMIT = 50;
const SIRIUS_PLAN_LIMIT = 100;
const SIRIUS_FRIENDSHIP_CAMPAIGN_KEY = "summer_padel_sirius_friendship_2026";
const PENDING_PAYMENT_STORAGE_KEY = "padlhub_tournament_subscription_pending_refs";
const PENDING_PAYMENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_PLAN_FEATURES = [
  { label: "создание игры", friendship: true, sport: true },
  { label: "присоединение к игре", friendship: true, sport: true },
  { label: "участие в турнирах ПадлхАБ", friendship: false, sport: true },
  { label: "участие в сторонних турнирах", friendship: false, sport: false },
] as const;

const SIRIUS_FRIENDSHIP_FEATURES = [
  { label: "создание игры", enabled: true },
  { label: "участие в играх", enabled: true },
  { label: "игра+тренер", enabled: false },
  { label: "групповые тренировки", enabled: false },
  { label: "сплит-тренировки", enabled: false },
  { label: "участие в турнирах ПадлхАБ", enabled: true },
  { label: "участие в сторонних турнирах", enabled: false },
] as const;

const SUBSCRIPTION_ARTWORKS: Record<SubscriptionArtworkKey, { alt: string; priceLabel: string; src: string }> = {
  academy: {
    alt: "Абонемент Лето.Падел.Академия за 23 800 ₽",
    priceLabel: "23 800 ₽",
    src: summerSubscriptionAcademyImage,
  },
  energy5: {
    alt: "Абонемент Энергия-5 за 19 800 ₽",
    priceLabel: "19 800 ₽",
    src: summerSubscriptionEnergy5Image,
  },
  friendship: {
    alt: "Абонемент Лето.Падел.Дружба за 9 800 ₽",
    priceLabel: "9 800 ₽",
    src: summerSubscriptionFriendshipImage,
  },
  ra: {
    alt: "Абонемент Лето.Падел.РА за 23 800 ₽",
    priceLabel: "23 800 ₽",
    src: summerSubscriptionRaImage,
  },
  sport: {
    alt: "Абонемент Лето.Падел.Спорт за 19 800 ₽",
    priceLabel: "19 800 ₽",
    src: summerSubscriptionSportImage,
  },
};

function buildPaymentRef() {
  return `summer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePlanTypeToken(value: string | null | undefined): SubscriptionPlanId | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  if (compact.includes("friend") || compact.includes("druzh") || compact.includes("друж")) {
    return "friendship";
  }
  if (compact.includes("sport") || compact.includes("спорт")) {
    return "sport";
  }
  return null;
}

function normalizeCounterKey(value: string | null | undefined): SubscriptionCounterKey | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "academy" || raw === "energy5" || raw === "friendship" || raw === "ra" || raw === "sirius_friendship" || raw === "sport") {
    return raw;
  }
  return null;
}

function normalizePositiveInt(value: number | string | null | undefined, fallback: number) {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

function normalizeOptionalText(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeArtworkKey(value: string | null | undefined): SubscriptionArtworkKey | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "academy" || normalized === "energy5" || normalized === "friendship" || normalized === "ra" || normalized === "sport") {
    return normalized;
  }
  return null;
}

function buildDefaultFeatures(planId: SubscriptionPlanId): DisplayFeatureConfig[] {
  return DEFAULT_PLAN_FEATURES.map((feature) => ({
    label: feature.label,
    enabled: Boolean(feature[planId]),
  }));
}

function buildDefaultPageViewConfig(): PageViewConfig {
  return {
    showBackButton: true,
    plans: [
      {
        id: "academy",
        counterKey: "academy",
        planId: null,
        cardClassName: "tournament-subscription-plan--image",
        artworkAlt: "Абонемент Лето.Падел.Академия за 23 800 ₽",
        artworkSrc: summerSubscriptionAcademyImage,
        directSubscriptionProductId: resolveTournamentSubscriptionDirectProductId("academy"),
        headClassName: "tournament-subscription-plan-head--sport",
        purchaseMode: "catalog_subscription",
        accent: "АКАДЕМИЯ",
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel: "23 800 ₽",
        metaLabel: "30 ДНЕЙ",
        fallbackTotalLimit: DEFAULT_PLAN_LIMIT,
        remainingLabel: "Доступно",
        remainingValueText: resolveTournamentSubscriptionCounterDisplayText("academy"),
        hideRemainingBlock: true,
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures("sport"),
      },
      {
        id: "ra",
        counterKey: "ra",
        planId: null,
        cardClassName: "tournament-subscription-plan--image",
        artworkAlt: "Абонемент Лето.Падел.РА за 23 800 ₽",
        artworkSrc: summerSubscriptionRaImage,
        directSubscriptionProductId: resolveTournamentSubscriptionDirectProductId("ra"),
        headClassName: "tournament-subscription-plan-head--sport",
        purchaseMode: "catalog_subscription",
        accent: "РА",
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel: "23 800 ₽",
        metaLabel: "30 ДНЕЙ",
        fallbackTotalLimit: DEFAULT_PLAN_LIMIT,
        remainingLabel: "Доступно",
        remainingValueText: resolveTournamentSubscriptionCounterDisplayText("ra"),
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures("sport"),
      },
      {
        id: "friendship",
        counterKey: "friendship",
        planId: "friendship",
        cardClassName: "tournament-subscription-plan--image",
        artworkAlt: "Абонемент Лето.Падел.Дружба за 9 800 ₽",
        artworkSrc: summerSubscriptionFriendshipImage,
        headClassName: "tournament-subscription-plan-head--friendship",
        purchaseMode: "summer_campaign",
        accent: "ДРУЖБА",
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel: "9 800 ₽",
        metaLabel: "30 ДНЕЙ",
        fallbackTotalLimit: DEFAULT_PLAN_LIMIT,
        remainingLabel: "Доступно",
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures("friendship"),
      },
      {
        id: "energy5",
        counterKey: "energy5",
        planId: null,
        cardClassName: "tournament-subscription-plan--image tournament-subscription-plan--showcase-featured",
        artworkAlt: "Абонемент Энергия-5 за 19 800 ₽",
        artworkSrc: summerSubscriptionEnergy5Image,
        directSubscriptionProductId: resolveTournamentSubscriptionDirectProductId("energy5"),
        headClassName: "tournament-subscription-plan-head--sport",
        purchaseMode: "catalog_subscription",
        buttonLabel: "Оформить абонемент",
        accent: "ЭНЕРГИЯ-5",
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel: "19 800 ₽",
        metaLabel: "5 ТРЕНИРОВОК",
        fallbackTotalLimit: DEFAULT_PLAN_LIMIT,
        remainingLabel: "Доступно",
        hideRemainingBlock: true,
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures("sport"),
      },
    ],
  };
}

function buildPromoOfferPageViewConfig(
  config?: TournamentSubscriptionPageConfig,
): PageViewConfig {
  const offerKey = normalizeOptionalText(config?.offerKey);
  const offer = resolveTournamentSubscriptionPromoOffer(offerKey);

  if (!offer || !offerKey) {
    return {
      pageClassName: "tournament-subscription-page--single",
      plansClassName: "tournament-subscription-plans--single",
      showBackButton: true,
      plans: [],
      pageError: "Ссылка на акционный абонемент недействительна.",
    };
  }

  const displayPlanId: SubscriptionPlanId = offer.planStyle === "friendship" ? "friendship" : "sport";

  return {
    pageClassName: "tournament-subscription-page--single",
    plansClassName: "tournament-subscription-plans--single",
    showBackButton: true,
    plans: [
      {
        id: offerKey,
        counterKey: null,
        planId: null,
        directSubscriptionProductId: offer.productId,
        purchaseMode: "catalog_subscription",
        headClassName: displayPlanId === "friendship"
          ? "tournament-subscription-plan-head--friendship"
          : "tournament-subscription-plan-head--sport",
        accent: "АКЦИЯ",
        titleLines: ["ЛЕТО.ПАДЕЛ.", offer.accent],
        priceLabel: offer.priceLabel,
        metaLabel: "30 ДНЕЙ",
        fallbackTotalLimit: DEFAULT_PLAN_LIMIT,
        remainingLabel: "Доступно",
        hideRemainingBlock: true,
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures(displayPlanId),
      },
    ],
  };
}

function buildSingleArtworkPageViewConfig(
  config?: TournamentSubscriptionPageConfig,
): PageViewConfig {
  const explicitPlanId = config?.planKey === "friendship" || config?.planKey === "sport"
    ? config.planKey
    : null;
  const artworkKey = normalizeArtworkKey(config?.artworkKey) || (explicitPlanId === "sport" ? "sport" : "friendship");
  if (
    isTournamentSubscriptionStorefrontPlanRetired(explicitPlanId)
    || isTournamentSubscriptionStorefrontPlanRetired(artworkKey)
  ) {
    return {
      pageClassName: "tournament-subscription-page--single",
      plansClassName: "tournament-subscription-plans--single",
      showBackButton: true,
      plans: [],
      pageError: "Этот абонемент больше не продаётся на странице.",
    };
  }
  const implicitPlanId = artworkKey === "friendship"
    ? "friendship"
    : artworkKey === "sport"
      ? "sport"
      : null;
  const directSubscriptionProductId = resolveTournamentSubscriptionDirectProductId(artworkKey);
  const usesCatalogSubscription = Boolean(directSubscriptionProductId);
  const boundPlanId = explicitPlanId || implicitPlanId;
  const statusCounterKey = directSubscriptionProductId
    ? (artworkKey === "academy" || artworkKey === "energy5" || artworkKey === "ra" ? artworkKey : null)
    : (config?.campaignKey === SIRIUS_FRIENDSHIP_CAMPAIGN_KEY ? "sirius_friendship" : boundPlanId);
  const statusPlanId = directSubscriptionProductId ? null : boundPlanId;
  const displayPlanId = boundPlanId || implicitPlanId || (artworkKey === "friendship" ? "friendship" : "sport");
  const artwork = SUBSCRIPTION_ARTWORKS[artworkKey];
  const fallbackTotalLimit = normalizePositiveInt(
    config?.totalLimit,
    config?.campaignKey === SIRIUS_FRIENDSHIP_CAMPAIGN_KEY ? SIRIUS_PLAN_LIMIT : DEFAULT_PLAN_LIMIT,
  );
  const priceLabel = normalizeOptionalText(config?.priceLabel) || artwork.priceLabel;
  const remainingValueText = resolveTournamentSubscriptionCounterDisplayText(artworkKey);
  const purchaseBindingError = boundPlanId || usesCatalogSubscription
    ? null
    : "Для этой карточки укажите planKey и при необходимости campaignKey в Tilda-ссылке.";
  const purchaseMode = usesCatalogSubscription ? "catalog_subscription" : "summer_campaign";

  return {
    plansClassName: "tournament-subscription-plans--single",
    showBackButton: true,
    singlePlanRequest: statusPlanId
      ? {
        counterKey: statusCounterKey || statusPlanId,
        planId: statusPlanId,
        campaignKey: normalizeOptionalText(config?.campaignKey),
      }
      : statusCounterKey
        ? {
          counterKey: statusCounterKey,
          planId: null,
          campaignKey: normalizeOptionalText(config?.campaignKey),
        }
      : undefined,
    plans: [
      {
        id: displayPlanId,
        counterKey: statusCounterKey,
        planId: statusPlanId,
        cardClassName: "tournament-subscription-plan--image",
        artworkAlt: artwork.alt,
        artworkSrc: artwork.src,
        directSubscriptionProductId,
        buttonLabel: artworkKey === "energy5" ? "Оформить абонемент" : undefined,
        hideRemainingBlock: artworkKey === "academy" || artworkKey === "energy5" || artworkKey === "sport",
        purchaseBindingError,
        purchaseMode,
        remainingValueText,
        headClassName: displayPlanId === "sport" ? "tournament-subscription-plan-head--sport" : "tournament-subscription-plan-head--friendship",
        accent: artworkKey.toUpperCase(),
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel,
        fallbackTotalLimit,
        remainingLabel: "Доступно",
        featureStatusAppearance: "badge",
        features: buildDefaultFeatures(displayPlanId),
      },
    ],
  };
}

function buildSiriusFriendshipPageViewConfig(
  config?: TournamentSubscriptionPageConfig,
): PageViewConfig {
  const campaignKey = normalizeOptionalText(config?.campaignKey) || SIRIUS_FRIENDSHIP_CAMPAIGN_KEY;
  const fallbackTotalLimit = normalizePositiveInt(config?.totalLimit, SIRIUS_PLAN_LIMIT);
  const priceLabel = normalizeOptionalText(config?.priceLabel) || "9 800 ₽";

  return {
    pageClassName: "tournament-subscription-page--single",
    headerClassName: "tournament-subscription-header--single",
    plansClassName: "tournament-subscription-plans--single",
    backgroundClassName: "tournament-subscription-background--sirius",
    showBackButton: true,
    singlePlanRequest: {
      counterKey: "sirius_friendship",
      planId: "friendship",
      campaignKey,
    },
    plans: [
      {
        id: "friendship",
        counterKey: "sirius_friendship",
        planId: "friendship",
        cardClassName: "tournament-subscription-plan--single tournament-subscription-plan--sirius",
        hideRemainingBlock: true,
        headClassName: "tournament-subscription-plan-head--sirius",
        accent: "СИРИУС",
        titleLines: ["ЛЕТО.", "ПАДЕЛ."],
        priceLabel,
        bodyHeadline: "30 ДНЕЙ ИГР",
        fallbackTotalLimit,
        remainingLabel: "Осталось",
        featureStatusAppearance: "toggle",
        featureListClassName: "tournament-subscription-feature-list--single",
        featureItemClassName: "tournament-subscription-feature-item--single",
        featureLabelClassName: "tournament-subscription-feature-label--single",
        features: SIRIUS_FRIENDSHIP_FEATURES.map((feature) => ({
          label: feature.label,
          enabled: feature.enabled,
        })),
      },
    ],
  };
}

function resolvePageViewConfig(
  config?: TournamentSubscriptionPageConfig,
): PageViewConfig {
  if (config?.offerKey) {
    return buildPromoOfferPageViewConfig(config);
  }
  if (config?.variant === "sirius_friendship") {
    return buildSiriusFriendshipPageViewConfig(config);
  }
  if (config?.variant === "single_artwork") {
    return buildSingleArtworkPageViewConfig(config);
  }
  return buildDefaultPageViewConfig();
}

function mapStatusesByCounter(
  statuses: TournamentSubscriptionStatus[] | null,
): Record<SubscriptionCounterKey, TournamentSubscriptionStatus | null> {
  const mapped: Record<SubscriptionCounterKey, TournamentSubscriptionStatus | null> = {
    academy: null,
    energy5: null,
    friendship: null,
    ra: null,
    sirius_friendship: null,
    sport: null,
  };

  if (!statuses || statuses.length === 0) return mapped;

  statuses.forEach((status) => {
    const resolvedCounterKey = normalizeCounterKey(
      status.counterKey
      || (status.campaignKey === SIRIUS_FRIENDSHIP_CAMPAIGN_KEY ? "sirius_friendship" : null)
      || status.planType,
    );
    if (resolvedCounterKey && !mapped[resolvedCounterKey]) {
      mapped[resolvedCounterKey] = status;
      return;
    }
  });

  return mapped;
}

function buildReturnUrl(options: { disableAutoPurchase?: boolean } = {}) {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  if (options.disableAutoPurchase) {
    url.searchParams.set("autoPurchase", "0");
  }
  return appendCurrentAuthModeToNavigableUrl(url).toString();
}

function readPaymentRefFromUrl() {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const value = url.searchParams.get(PAYMENT_REF_QUERY_KEY);
  return value?.trim() || null;
}

function clearPaymentRefInUrl() {
  if (typeof window === "undefined") return;
  const current = new URL(window.location.href);
  if (!current.searchParams.has(PAYMENT_REF_QUERY_KEY)) return;
  current.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  window.history.replaceState(window.history.state, document.title, `${current.pathname}${current.search}${current.hash}`);
}

function readPendingPaymentEntries(): PendingPaymentEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    const deduped = new Map<string, PendingPaymentEntry>();
    parsed.forEach((candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const paymentRef = normalizeOptionalText(String((candidate as PendingPaymentEntry).paymentRef || ""));
      if (!paymentRef) return;

      const createdAt = normalizeOptionalText(String((candidate as PendingPaymentEntry).createdAt || "")) || new Date(now).toISOString();
      const createdAtTs = Date.parse(createdAt);
      if (Number.isFinite(createdAtTs) && createdAtTs < now - PENDING_PAYMENT_MAX_AGE_MS) {
        return;
      }

      deduped.set(paymentRef, {
        paymentRef,
        counterKey: normalizeCounterKey(String((candidate as PendingPaymentEntry).counterKey || "")),
        planId: normalizePlanTypeToken(String((candidate as PendingPaymentEntry).planId || "")),
        campaignKey: normalizeOptionalText(String((candidate as PendingPaymentEntry).campaignKey || "")),
        createdAt,
      });
    });

    return Array.from(deduped.values());
  } catch {
    return [];
  }
}

function writePendingPaymentEntries(entries: PendingPaymentEntry[]) {
  if (typeof window === "undefined") return;

  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(PENDING_PAYMENT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage write errors
  }
}

function upsertPendingPaymentEntry(entry: PendingPaymentEntry) {
  const current = readPendingPaymentEntries().filter((item) => item.paymentRef !== entry.paymentRef);
  current.unshift(entry);
  writePendingPaymentEntries(current.slice(0, 12));
}

function removePendingPaymentEntry(paymentRef: string | null | undefined) {
  const normalizedPaymentRef = normalizeOptionalText(paymentRef || "");
  if (!normalizedPaymentRef) return;
  const current = readPendingPaymentEntries().filter((item) => item.paymentRef !== normalizedPaymentRef);
  writePendingPaymentEntries(current);
}

function FeatureStatus({
  enabled,
  appearance = "badge",
}: {
  enabled: boolean;
  appearance?: "badge" | "toggle";
}) {
  return (
    <span
      className={[
        "tournament-subscription-feature-status",
        `tournament-subscription-feature-status--${appearance}`,
        enabled ? "tournament-subscription-feature-status--on" : "tournament-subscription-feature-status--off",
      ].join(" ")}
      aria-hidden="true"
    />
  );
}

function DailyDropCountdown({ onDrop }: { onDrop: () => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [nextDropAtMs, setNextDropAtMs] = useState(() =>
    resolveNextTournamentSubscriptionDailyDropAt().getTime(),
  );

  useEffect(() => {
    let didRefreshStatus = false;
    const intervalId = window.setInterval(() => {
      const currentMs = Date.now();
      setNowMs(currentMs);

      if (!didRefreshStatus && currentMs >= nextDropAtMs) {
        didRefreshStatus = true;
        onDrop();
        setNextDropAtMs(
          resolveNextTournamentSubscriptionDailyDropAt(new Date(currentMs + 1000)).getTime(),
        );
      }
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [nextDropAtMs, onDrop]);

  return (
    <div
      className="tournament-subscription-drop-countdown"
      role="timer"
      aria-label={`До обновления счетчика ${formatTournamentSubscriptionDropCountdown(nextDropAtMs, nowMs)}`}
    >
      <span className="tournament-subscription-drop-countdown-label">До обновления счетчика</span>
      <strong className="tournament-subscription-drop-countdown-value">
        {formatTournamentSubscriptionDropCountdown(nextDropAtMs, nowMs)}
      </strong>
    </div>
  );
}

export default function TournamentSubscriptionPage({
  onBack,
  pageConfig,
}: TournamentSubscriptionPageProps) {
  const { isAuthenticated } = useAuth();
  const pageViewConfig = useMemo(() => resolvePageViewConfig(pageConfig), [pageConfig]);
  const singlePlanRequest = pageViewConfig.singlePlanRequest;
  const planByDisplayId = useMemo(
    () => new Map(pageViewConfig.plans.map((plan) => [plan.id, plan])),
    [pageViewConfig.plans],
  );

  const [statusByCounterKey, setStatusByCounterKey] = useState<Record<SubscriptionCounterKey, TournamentSubscriptionStatus | null>>(
    EMPTY_PLAN_STATUSES,
  );
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [buyingDisplayId, setBuyingDisplayId] = useState<string | null>(null);
  const [buyingPlanId, setBuyingPlanId] = useState<SubscriptionPlanId | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [buyErrorByDisplayId, setBuyErrorByDisplayId] = useState<Record<string, string | null>>({});
  const [buyInfo, setBuyInfo] = useState<string | null>(null);
  const [authRequestedDisplayId, setAuthRequestedDisplayId] = useState<string | null>(null);
  const [pendingPurchaseRequest, setPendingPurchaseRequest] = useState<PendingPurchaseRequest | null>(null);
  const statusRequestIdRef = useRef(0);
  const autoPurchaseStartedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const requestId = statusRequestIdRef.current + 1;
    statusRequestIdRef.current = requestId;
    setLoadingStatus(true);
    setStatusError(null);

    if (pageViewConfig.plans.every((plan) => !plan.counterKey)) {
      setStatusByCounterKey(EMPTY_PLAN_STATUSES);
      setLoadingStatus(false);
      return;
    }

    if (singlePlanRequest) {
      const result = await apiFetchTournamentSubscriptionStatus({
        counterKey: singlePlanRequest.counterKey,
        planType: singlePlanRequest.planId,
        campaignKey: singlePlanRequest.campaignKey,
      });

      if (requestId !== statusRequestIdRef.current) return;

      if (result.error || !result.data) {
        setStatusError(result.error?.message || "Не удалось получить остаток абонементов");
        setLoadingStatus(false);
        return;
      }

      if (singlePlanRequest.campaignKey) {
        const hasCampaignMatch = result.data.some((status) => {
          const campaignKey = normalizeOptionalText(status.campaignKey);
          const counterKey = normalizeCounterKey(status.counterKey);
          return campaignKey === singlePlanRequest.campaignKey && counterKey === singlePlanRequest.counterKey;
        });

        if (!hasCampaignMatch) {
          setStatusByCounterKey(EMPTY_PLAN_STATUSES);
          setStatusError("Не найден отдельный счётчик Sirius-подписки. Проверьте campaignKey и лимит в Node-RED.");
          setLoadingStatus(false);
          return;
        }
      }

      setStatusByCounterKey(mapStatusesByCounter(result.data));
      setLoadingStatus(false);
      return;
    }

    const aggregateResult = await apiFetchTournamentSubscriptionStatus();
    const explicitCounterKeys = Array.from(new Set(
      pageViewConfig.plans
        .map((plan) => plan.counterKey)
        .filter((counterKey): counterKey is SubscriptionCounterKey =>
          Boolean(counterKey)
          && TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS.includes(
            counterKey as typeof TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS[number],
          )),
    ));

    const explicitResults = await Promise.all(
      explicitCounterKeys.map(async (counterKey) => {
        const plan = pageViewConfig.plans.find((candidate) => candidate.counterKey === counterKey) ?? null;
        const result = await apiFetchTournamentSubscriptionStatus({
          counterKey,
          planType: plan?.planId ?? null,
        });
        return result.error || !result.data ? [] : result.data;
      }),
    );

    if (requestId !== statusRequestIdRef.current) return;

    const mergedStatuses = [
      ...explicitResults.flat(),
      ...(aggregateResult.data || []),
    ];

    if (mergedStatuses.length === 0) {
      setStatusError(aggregateResult.error?.message || "Не удалось получить остаток абонементов");
      setLoadingStatus(false);
      return;
    }

    setStatusByCounterKey(mapStatusesByCounter(mergedStatuses));
    setLoadingStatus(false);
  }, [pageViewConfig.plans, singlePlanRequest]);

  const loadProfile = useCallback(async () => {
    if (!isAuthenticated) {
      setProfile(null);
      setProfileLoaded(false);
      return;
    }
    setProfileLoaded(false);
    setLoadingProfile(true);

    const result = await apiFetchProfile();
    if (!result.error && result.data) {
      setProfile(result.data);
    } else {
      setProfile(null);
    }

    setProfileLoaded(true);
    setLoadingProfile(false);
  }, [isAuthenticated]);

  const confirmPendingPayments = useCallback(async () => {
    const urlPaymentRef = readPaymentRefFromUrl();
    const queuedEntries = readPendingPaymentEntries().filter((entry) => {
      if (!singlePlanRequest?.campaignKey) return true;
      return (!entry.campaignKey || entry.campaignKey === singlePlanRequest.campaignKey)
        && (!entry.counterKey || entry.counterKey === singlePlanRequest.counterKey);
    });

    const entriesByRef = new Map<string, PendingPaymentEntry>();
    queuedEntries.forEach((entry) => {
      entriesByRef.set(entry.paymentRef, entry);
    });

    if (urlPaymentRef && !entriesByRef.has(urlPaymentRef)) {
      entriesByRef.set(urlPaymentRef, {
        counterKey: singlePlanRequest?.counterKey ?? null,
        paymentRef: urlPaymentRef,
        planId: singlePlanRequest?.planId ?? null,
        campaignKey: singlePlanRequest?.campaignKey ?? null,
        createdAt: new Date().toISOString(),
      });
    }

    const entriesToConfirm = Array.from(entriesByRef.values());
    if (entriesToConfirm.length === 0) return;

    let cancelled = false;
    const runConfirm = async () => {
      let sawPaid = false;
      let sawFailed = false;
      let sawPending = false;
      let sawError = false;
      let hasStatusUpdates = false;

      for (const entry of entriesToConfirm) {
        const result = await apiConfirmTournamentSubscriptionPurchase(entry.paymentRef, {
          counterKey: entry.counterKey ?? singlePlanRequest?.counterKey ?? null,
          planType: entry.planId ?? singlePlanRequest?.planId ?? null,
          campaignKey: entry.campaignKey ?? singlePlanRequest?.campaignKey ?? null,
        });

        if (cancelled) return;

        if (result.error || !result.data) {
          sawError = true;
          if (result.error?.status === 404) {
            removePendingPaymentEntry(entry.paymentRef);
          }
          continue;
        }

        hasStatusUpdates = true;
        const normalizedPaymentRef = result.data.paymentRef || entry.paymentRef;

        if (result.data.paid) {
          sawPaid = true;
          removePendingPaymentEntry(normalizedPaymentRef);
          continue;
        }

        if (result.data.failed) {
          sawFailed = true;
          removePendingPaymentEntry(normalizedPaymentRef);
          continue;
        }

        sawPending = true;
        upsertPendingPaymentEntry({
          counterKey: normalizeCounterKey(result.data.counterKey) || entry.counterKey || singlePlanRequest?.counterKey || null,
          paymentRef: normalizedPaymentRef,
          planId: normalizePlanTypeToken(result.data.planType) || entry.planId || singlePlanRequest?.planId || null,
          campaignKey: result.data.campaignKey || entry.campaignKey || singlePlanRequest?.campaignKey || null,
          createdAt: entry.createdAt,
        });
      }

      if (urlPaymentRef) {
        clearPaymentRefInUrl();
      }

      if (cancelled) return;

      if (sawPaid) {
        setBuyInfo("Оплата подтверждена. Абонемент забронирован за вами.");
      } else if (sawFailed) {
        setBuyInfo("Оплата не прошла. Вы можете попробовать снова.");
      } else if (sawError) {
        setBuyInfo("Статус оплаты обновится автоматически через несколько минут.");
      } else if (sawPending) {
        setBuyInfo("Платеж еще обрабатывается банком. Обновите страницу через минуту.");
      }

      if (hasStatusUpdates || sawError || sawPending) {
        await loadStatus();
      }
    };

    void runConfirm();
    return () => {
      cancelled = true;
    };
  }, [loadStatus, singlePlanRequest]);

  useEffect(() => {
    void loadStatus();
    if (isAuthenticated) {
      void loadProfile();
    } else {
      setProfile(null);
      setProfileLoaded(false);
    }
  }, [isAuthenticated, loadProfile, loadStatus]);

  useEffect(() => {
    let teardown: (() => void) | undefined;
    const maybePromise = confirmPendingPayments();
    if (typeof maybePromise === "function") {
      teardown = maybePromise;
    } else if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then((cleanup) => {
        if (typeof cleanup === "function") {
          teardown = cleanup;
        }
      }).catch(() => {
        // ignore confirm bootstrap errors here, UI state is updated in the callback
      });
    }
    return () => {
      teardown?.();
    };
  }, [confirmPendingPayments]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 30000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  const startPurchase = useCallback(async (plan: DisplayPlanConfig) => {
    const boundPlanId = plan.planId ?? null;
    const counterKey = plan.counterKey ?? null;
    if (!profile?.phone) {
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Не удалось определить номер телефона в профиле" }));
      return;
    }

    if (plan.purchaseMode === "catalog_subscription") {
      const directSubscriptionProductId = plan.directSubscriptionProductId ?? null;
      if (!directSubscriptionProductId) {
        setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Для этой карточки не настроен продукт покупки." }));
        return;
      }

      const trackedStatus = counterKey ? statusByCounterKey[counterKey] : null;
      if (trackedStatus && !trackedStatus.unlimited && (trackedStatus.remainingCount <= 0 || !trackedStatus.canPurchase)) {
        setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Лимит абонементов уже исчерпан" }));
        return;
      }

      setBuyingDisplayId(plan.id);
      setBuyingPlanId(null);
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: null }));
      setBuyInfo(null);

      const returnUrl = buildReturnUrl({ disableAutoPurchase: Boolean(pageConfig?.offerKey) });
      if (counterKey) {
        const paymentRef = `${counterKey}-${buildPaymentRef()}`;
        const result = await apiCreateTournamentSubscriptionPurchase({
          clientPhone: profile.phone,
          clientId: profile.id ?? null,
          counterKey,
          productId: directSubscriptionProductId,
          paymentRef,
          baseRedirectUrl: returnUrl,
          successUrl: returnUrl,
          failUrl: returnUrl,
          trainerQrCode: pageConfig?.trainerQrCode ?? null,
        });

        if (result.error || !result.data) {
          setBuyErrorByDisplayId((prev) => ({
            ...prev,
            [plan.id]: result.error?.message || "Не удалось создать оплату абонемента.",
          }));
          setBuyingDisplayId(null);
          await loadStatus();
          return;
        }

        const resolvedPaymentRef = result.data.paymentRef || paymentRef;
        if (!result.data.paymentUrl && (result.data.toPayMinor ?? 0) > 0) {
          setBuyErrorByDisplayId((prev) => ({
            ...prev,
            [plan.id]: "Банк не вернул ссылку на оплату.",
          }));
          setBuyingDisplayId(null);
          removePendingPaymentEntry(resolvedPaymentRef);
          await loadStatus();
          return;
        }

        if (result.data.paymentUrl) {
          upsertPendingPaymentEntry({
            counterKey,
            paymentRef: resolvedPaymentRef,
            planId: boundPlanId,
            campaignKey: result.data.campaignKey || trackedStatus?.campaignKey || null,
            createdAt: new Date().toISOString(),
          });
          window.location.href = result.data.paymentUrl;
          return;
        }

        removePendingPaymentEntry(resolvedPaymentRef);
        setBuyInfo("Оплата подтверждена без перехода в банк.");
        setBuyingDisplayId(null);
        await loadStatus();
        return;
      }

      const result = await apiBuySubscroption(directSubscriptionProductId, profile.phone, {
        baseRedirectUrl: returnUrl,
        successUrl: returnUrl,
        failUrl: returnUrl,
      });

      if (result.error || !result.data) {
        setBuyErrorByDisplayId((prev) => ({
          ...prev,
          [plan.id]: result.error?.message || "Не удалось создать оплату абонемента.",
        }));
        setBuyingDisplayId(null);
        return;
      }

      if (result.data.paymentUrl) {
        window.location.href = result.data.paymentUrl;
        return;
      }

      if (result.data.paid === true || result.data.toPay <= 0) {
        setBuyInfo("Оплата подтверждена без перехода в банк.");
        setBuyingDisplayId(null);
        return;
      }

      setBuyErrorByDisplayId((prev) => ({
        ...prev,
        [plan.id]: "Банк не вернул ссылку на оплату.",
      }));
      setBuyingDisplayId(null);
      return;
    }

    if (!boundPlanId) {
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Для этой карточки не настроен summer-plan." }));
      return;
    }

    const targetStatus = statusByCounterKey[counterKey || boundPlanId];
    if (targetStatus && !targetStatus.unlimited && (targetStatus.remainingCount <= 0 || !targetStatus.canPurchase)) {
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Лимит абонементов уже исчерпан" }));
      return;
    }

    setBuyingDisplayId(plan.id);
    setBuyingPlanId(boundPlanId);
    setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: null }));
    setBuyInfo(null);

    const paymentRef = `${counterKey || boundPlanId}-${buildPaymentRef()}`;
    const returnUrl = buildReturnUrl({ disableAutoPurchase: Boolean(pageConfig?.offerKey) });
    const result = await apiCreateTournamentSubscriptionPurchase({
      clientPhone: profile.phone,
      clientId: profile.id ?? null,
      counterKey: counterKey || null,
      planType: boundPlanId,
      campaignKey: targetStatus?.campaignKey || singlePlanRequest?.campaignKey || null,
      paymentRef,
      baseRedirectUrl: returnUrl,
      successUrl: returnUrl,
      failUrl: returnUrl,
      trainerQrCode: pageConfig?.trainerQrCode ?? null,
    });

    if (result.error || !result.data) {
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: result.error?.message || "Не удалось создать оплату абонемента" }));
      setBuyingDisplayId(null);
      setBuyingPlanId(null);
      await loadStatus();
      return;
    }

    const resolvedPaymentRef = result.data.paymentRef || paymentRef;

    if (!result.data.paymentUrl && (result.data.toPayMinor ?? 0) > 0) {
      setBuyErrorByDisplayId((prev) => ({ ...prev, [plan.id]: "Банк не вернул ссылку на оплату" }));
      setBuyingDisplayId(null);
      setBuyingPlanId(null);
      removePendingPaymentEntry(resolvedPaymentRef);
      await loadStatus();
      return;
    }

    if (result.data.paymentUrl) {
      upsertPendingPaymentEntry({
        counterKey: counterKey || normalizeCounterKey(result.data.counterKey) || null,
        paymentRef: resolvedPaymentRef,
        planId: boundPlanId,
        campaignKey: result.data.campaignKey || targetStatus?.campaignKey || singlePlanRequest?.campaignKey || null,
        createdAt: new Date().toISOString(),
      });
      window.location.href = result.data.paymentUrl;
      return;
    }

    removePendingPaymentEntry(resolvedPaymentRef);
    setBuyInfo("Оплата подтверждена без перехода в банк.");
    setBuyingDisplayId(null);
    setBuyingPlanId(null);
    await loadStatus();
  }, [loadStatus, pageConfig?.offerKey, pageConfig?.trainerQrCode, profile, singlePlanRequest?.campaignKey, statusByCounterKey]);

  const handleBuy = useCallback((plan: DisplayPlanConfig) => {
    if (!isAuthenticated) {
      setAuthRequestedDisplayId(plan.id);
      setPendingPurchaseRequest({ displayId: plan.id });
      setBuyInfo(null);
      return;
    }
    void startPurchase(plan);
  }, [isAuthenticated, startPurchase]);

  useEffect(() => {
    autoPurchaseStartedRef.current = false;
  }, [pageConfig?.autoPurchase, pageConfig?.offerKey]);

  useEffect(() => {
    if (!pageConfig?.autoPurchase || autoPurchaseStartedRef.current || pageViewConfig.pageError) return;
    const targetPlan = pageViewConfig.plans[0] ?? null;
    if (!targetPlan?.directSubscriptionProductId) return;

    autoPurchaseStartedRef.current = true;
    setPendingPurchaseRequest({ displayId: targetPlan.id });
    setAuthRequestedDisplayId(targetPlan.id);
    setBuyInfo(null);
  }, [pageConfig?.autoPurchase, pageViewConfig.pageError, pageViewConfig.plans]);

  useEffect(() => {
    if (!isAuthenticated || !pendingPurchaseRequest || loadingProfile || !profileLoaded) return;
    if (!profile?.phone) {
      setBuyErrorByDisplayId((prev) => ({
        ...prev,
        [pendingPurchaseRequest.displayId]: "В профиле не найден номер телефона, оплата недоступна.",
      }));
      setPendingPurchaseRequest(null);
      return;
    }

    const request = pendingPurchaseRequest;
    const targetPlan = planByDisplayId.get(request.displayId) ?? null;
    setPendingPurchaseRequest(null);
    setAuthRequestedDisplayId(null);
    if (!targetPlan) return;
    void startPurchase(targetPlan);
  }, [isAuthenticated, loadingProfile, pendingPurchaseRequest, planByDisplayId, profile?.phone, profileLoaded, startPurchase]);

  const hasProfilePhone = Boolean(profile?.phone);
  const authPlanAccent = useMemo(() => {
    if (!authRequestedDisplayId) return null;
    return pageViewConfig.plans.find((plan) => plan.id === authRequestedDisplayId)?.accent ?? null;
  }, [authRequestedDisplayId, pageViewConfig.plans]);
  const showMobileScrollHint = pageViewConfig.plans.length > 1;

  const closeAuthOverlay = useCallback(() => {
    setAuthRequestedDisplayId(null);
    setPendingPurchaseRequest(null);
  }, []);

  return (
    <div className={`tournament-subscription-page ${pageViewConfig.pageClassName || ""}`}>
      {pageViewConfig.backgroundClassName && (
        <div className={`tournament-subscription-background ${pageViewConfig.backgroundClassName}`} aria-hidden="true" />
      )}
      <div className="tournament-subscription-pattern" aria-hidden="true" />
      <header className={`tournament-subscription-header ${pageViewConfig.headerClassName || ""}`}>
        {pageViewConfig.showBackButton && (
          <button type="button" className="tournament-subscription-back" onClick={onBack}>Назад</button>
        )}
        <img src={logoHabWhite} alt="ПадлхАБ" className="tournament-subscription-logo" />
      </header>

      <section className={`tournament-subscription-plans ${pageViewConfig.plansClassName || ""}`}>
        {showMobileScrollHint && (
          <div className="tournament-subscription-mobile-scroll-hint">
            <span className="tournament-subscription-mobile-scroll-hint-arrow" aria-hidden="true">↓</span>
            <span>Листайте вниз</span>
          </div>
        )}
        {pageViewConfig.pageError && (
          <div className="tournament-subscription-global-message tournament-subscription-error">
            {pageViewConfig.pageError}
          </div>
        )}
        {statusError && <div className="tournament-subscription-global-message tournament-subscription-error">{statusError}</div>}
        {buyInfo && <div className="tournament-subscription-global-message tournament-subscription-info">{buyInfo}</div>}

        {pageViewConfig.plans.map((plan) => {
          const boundPlanId = plan.planId ?? null;
          const status = plan.counterKey ? statusByCounterKey[plan.counterKey] : null;
          const usesSummerCampaignPurchase = plan.purchaseMode !== "catalog_subscription";
          const usesTrackedCounter = Boolean(plan.counterKey);
          const isBuying = buyingDisplayId === plan.id;
          const isPlanBusy = usesSummerCampaignPurchase && boundPlanId ? buyingPlanId === boundPlanId : false;
          const totalLimit = Math.max(0, status?.totalLimit ?? plan.fallbackTotalLimit);
          const displayTotalLimit = Math.max(
            0,
            plan.counterKey
              ? (resolveTournamentSubscriptionCounterDisplayTotalLimit(plan.counterKey) ?? totalLimit)
              : totalLimit,
          );
          const remainingCount = Math.max(0, status?.remainingCount ?? displayTotalLimit);
          const hideTemporaryUnlimitedCounter = (
            (plan.counterKey === "ra" || plan.counterKey === "friendship")
            && status?.unlimited !== false
          );
          const remainingValueText = plan.remainingValueText
            || (
              status
                ? `${remainingCount} из ${displayTotalLimit}`
                : usesTrackedCounter && loadingStatus
                  ? "Проверяем..."
                  : `${remainingCount} из ${displayTotalLimit}`
            );
          const isOutOfStock = usesTrackedCounter
            && Boolean(status && !status.unlimited && (!status.canPurchase || status.remainingCount <= 0));
          const disableForProfile = isAuthenticated && !loadingProfile && !hasProfilePhone;
          const hasPurchaseBinding = usesSummerCampaignPurchase
            ? Boolean(boundPlanId)
            : Boolean(plan.directSubscriptionProductId);
          const buttonDisabled = Boolean(
            plan.buttonDisabled
            || !hasPurchaseBinding
            || isPlanBusy
            || isOutOfStock
            || disableForProfile
            || plan.purchaseBindingError,
          );

          return (
            <article key={plan.id} className={`tournament-subscription-plan ${plan.cardClassName || ""}`}>
              {plan.artworkSrc ? (
                <div className="tournament-subscription-plan-image-wrap">
                  <img
                    src={plan.artworkSrc}
                    alt={plan.artworkAlt || `Абонемент ${plan.accent}`}
                    className="tournament-subscription-plan-image"
                  />
                </div>
              ) : (
                <>
                  <div className={`tournament-subscription-plan-head ${plan.headClassName}`}>
                    <h2 className="tournament-subscription-plan-title">
                      {plan.titleLines[0]}<br />
                      {plan.titleLines[1]}<br />
                      <span>{plan.accent}</span>
                    </h2>
                    <div className="tournament-subscription-plan-meta" aria-label={plan.metaLabel ? `${plan.priceLabel}, ${plan.metaLabel}` : plan.priceLabel}>
                      <span className="tournament-subscription-plan-price">{plan.priceLabel}</span>
                      {plan.metaLabel && <span className="tournament-subscription-plan-duration">{plan.metaLabel}</span>}
                    </div>
                  </div>

                  {plan.bodyHeadline && (
                    <div className="tournament-subscription-plan-body-headline">{plan.bodyHeadline}</div>
                  )}

                  <ul className={`tournament-subscription-feature-list ${plan.featureListClassName || ""}`}>
                    {plan.features.map((feature) => (
                      <li
                        key={`${plan.id}-${feature.label}`}
                        className={`tournament-subscription-feature-item ${plan.featureItemClassName || ""}`}
                      >
                        <span className={`tournament-subscription-feature-label ${plan.featureLabelClassName || ""}`}>{feature.label}</span>
                        <FeatureStatus enabled={feature.enabled} appearance={plan.featureStatusAppearance} />
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className={`tournament-subscription-purchase-block ${plan.artworkSrc ? "tournament-subscription-purchase-block--image" : ""}`}>
                {!plan.hideRemainingBlock && !hideTemporaryUnlimitedCounter && (
                  <div className="tournament-subscription-remaining-wrap">
                    <span className="tournament-subscription-remaining-label">{plan.remainingLabel}</span>
                    <span className="tournament-subscription-remaining-value">{remainingValueText}</span>
                  </div>
                )}

                {!hideTemporaryUnlimitedCounter
                  && (plan.counterKey === "ra" || plan.counterKey === "friendship")
                  && status
                  && status.releasePhase !== "launch"
                  && remainingCount === 0 && (
                  <DailyDropCountdown onDrop={loadStatus} />
                )}

                <button
                  type="button"
                  className="tournament-subscription-buy"
                  onClick={() => { handleBuy(plan); }}
                  disabled={buttonDisabled}
                >
                  {isBuying
                    ? "Создаем оплату..."
                    : isOutOfStock
                      ? "Лимит исчерпан"
                      : (plan.buttonLabel || "Оформить подписку")}
                </button>

                {!isAuthenticated && authRequestedDisplayId === plan.id && (
                  <div className="tournament-subscription-info">Для оформления нужна авторизация.</div>
                )}

                {disableForProfile && (
                  <div className="tournament-subscription-warning">
                    В профиле не найден номер телефона, оплата недоступна.
                  </div>
                )}

                {plan.purchaseBindingError && (
                  <div className="tournament-subscription-warning">
                    {plan.purchaseBindingError}
                  </div>
                )}

                {buyErrorByDisplayId[plan.id] && <div className="tournament-subscription-error">{buyErrorByDisplayId[plan.id]}</div>}
              </div>
            </article>
          );
        })}
      </section>

      {!isAuthenticated && authRequestedDisplayId && (
        <div className="tournament-subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="tournament-subscription-auth-title">
          <button
            type="button"
            className="tournament-subscription-auth-backdrop"
            aria-label="Закрыть окно авторизации"
            onClick={closeAuthOverlay}
          />
          <section className="tournament-subscription-auth-block">
            <button
              type="button"
              className="tournament-subscription-auth-close"
              aria-label="Закрыть окно авторизации"
              onClick={closeAuthOverlay}
            >
              ×
            </button>
            <h1 id="tournament-subscription-auth-title" className="tournament-subscription-auth-title">
              Оформление подписки {authPlanAccent ? `«${authPlanAccent}»` : ""}
            </h1>
            <p className="tournament-subscription-auth-caption">Войдите, чтобы продолжить оплату.</p>
            <AuthForm onLogin={() => {}} />
          </section>
        </div>
      )}
    </div>
  );
}
