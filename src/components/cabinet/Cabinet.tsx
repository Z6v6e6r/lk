import { useState, useEffect, useRef, useMemo } from "react";
import { UserProfile } from "./UserProfile";
import {
  apiFetchProfile,
  apiFetchBookings,
  apiFetchSubscriptions,
  apiFetchPadelGamesByPhone,
} from "../../utils/apiClient";
import type {
  UserProfileType,
  BookingsResponse,
  SubscriptionResponse,
  Subscription,
  PadelGameRecord,
  PadelGamePlayer,
} from "../../utils/apiClient";
import { useAuth } from "../../context/AuthContext";
import { ButtonModule } from "./ButtonModele";
import { ProfileEditForm } from "./ProfileEditForm";
import { BookingsContainer } from "./BookingsContainer";
import { BookingHistory } from "./BookingHistory";
import { SubscriptionsContainer } from "./SubscriptionsContainer";
import { SubscriptionInformation } from "./SubscriptionInformation";
import { BuySupscription } from "./BuySubscription";
import { Advertisement } from "./Advertisement";
import { CUSTOM_FIELD_IDS, getCustomField, getCustomFieldValue } from "../../utils/customFields";
import {
  identifyAnalyticsUser,
  trackAnalyticsEvent,
  trackCabinetVisit,
  trackClientError,
} from "../../utils/analytics";
import {
  GAMES_BUNDLE_URL,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";

const QUICK_ACTIONS = [
  { icon: "🎾", label: "Играть", href: "https://padlhub.ru/locations_lk" },
  { icon: "👥", label: "Групповые тренировки", href: "#9Rzqf" },
  { icon: "🏆", label: "Турниры", href: "https://padlhub.ru/padel_torneos" },
  { icon: "🎯", label: "Индивидуальные тренировки", href: "https://padlhub.ru/indi_lk" },
];

const CABINET_LOAD_ERROR_TEXT =
  "Не удалось загрузить личный кабинет, попробуйте подключиться к WiFi сети и загрузить кабинет повторно.";
const MAX_GAME_PLAYERS = 4;
const INVITE_JOIN_PATH = PUBLIC_INVITE_PATH;

interface CabinetProps {
  onOpenGames: (options?: { gameId?: string | null; openChat?: boolean }) => void;
  onOpenTournaments: () => void;
  onOpenOnboarding: (data: {
    profile: UserProfileType;
    gamesLink: string;
    trainingLink: string;
    tournamentsLink: string;
  }) => void;
}

type ProfileUpdatedEventDetail = {
  levelLetter?: string;
  levelNumeric?: string;
};

function getPlayerInitials(name: string | null | undefined): string {
  const value = (name || "").trim();
  if (!value) return "";
  return value
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function getDateBadge(dateValue: string | null | undefined) {
  if (!dateValue) return { month: "—", day: "—" };
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return { month: "—", day: "—" };
  return {
    month: parsed
      .toLocaleDateString("ru-RU", { month: "short" })
      .replace(".", "")
      .toUpperCase(),
    day: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
  };
}

function formatGameCardDate(dateValue: string | null | undefined): string {
  if (!dateValue) return "Дата не указана";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата не указана";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function toGameTimestamp(game: PadelGameRecord): number {
  const date = game.booking?.date || "9999-12-31";
  const fromTime = game.booking?.timeFrom || "23:59";
  const parsed = new Date(`${date}T${fromTime.length === 5 ? `${fromTime}:00` : fromTime}`);
  if (Number.isNaN(parsed.getTime())) return Number.MAX_SAFE_INTEGER;
  return parsed.getTime();
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

function resolvePublicGamesOrigin(current: URL): string {
  if (!isLocalHostname(current.hostname)) {
    return current.origin;
  }

  const fromBundle = (GAMES_BUNDLE_URL || "").trim();
  if (fromBundle) {
    try {
      const parsed = new URL(fromBundle);
      if (!isLocalHostname(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // fallback below
    }
  }

  return "https://padlhub.su";
}

function normalizePublicGamesUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (typeof window === "undefined") return raw;

  try {
    const current = new URL(window.location.href);
    const parsed = new URL(raw, current.origin);
    const hasJoinGame = Boolean(parsed.searchParams.get("joinGame")?.trim());

    if (hasJoinGame) {
      const normalized = new URL(INVITE_JOIN_PATH, PUBLIC_INVITE_ORIGIN);
      parsed.searchParams.forEach((paramValue, key) => {
        normalized.searchParams.set(key, paramValue);
      });
      return normalized.toString();
    }

    if (!isLocalHostname(parsed.hostname)) {
      return parsed.toString();
    }
    const publicOrigin = resolvePublicGamesOrigin(current);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return normalized.toString();
  } catch {
    return raw;
  }
}

function buildInviteFallbackUrl(gameId: string): string | null {
  const id = gameId.trim();
  if (!id) return null;
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(INVITE_JOIN_PATH, PUBLIC_INVITE_ORIGIN);
    url.searchParams.set("joinGame", id);
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

function resolveGameInviteUrl(game: PadelGameRecord): string | null {
  return (
    normalizePublicGamesUrl(game.inviteUrl) ??
    buildInviteFallbackUrl(game.id)
  );
}

export function Cabinet({ onOpenGames, onOpenTournaments, onOpenOnboarding }: CabinetProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [historyBookings, setHistoryBookings] = useState<BookingsResponse | null>(null);
  const [activeBookings, setActiveBookings] = useState<BookingsResponse | null>(null);
  const [userSubscriptions, setUserSubscriptions] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isBookingHistoryOpen, setIsBookingHistoryOpen] = useState(false);
  const [isSubscriptionInfoOpen, SetSubscriptionInfoOpen] = useState(false);
  const [currenSub, SetCurrenSub] = useState<Subscription | null>(null);
  const [currenSubName, SetCurrenSubName] = useState<string>("Абонемент");
  const [isOpenBuySub, setOpenBuySub] = useState<boolean>(false);
  const [createdGames, setCreatedGames] = useState<PadelGameRecord[]>([]);
  const [loadingCreatedGames, setLoadingCreatedGames] = useState(false);
  const [createdGamesError, setCreatedGamesError] = useState<string | null>(null);
  const [copiedGameInviteId, setCopiedGameInviteId] = useState<string | null>(null);
  const cabinetVisitTrackedRef = useRef(false);
  const onboardingStatusRef = useRef<boolean | null>(null);
  const { logout } = useAuth();

  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [profileRes, activeRes, historyRes, subsRes] = await Promise.all([
          apiFetchProfile(),
          apiFetchBookings(false),
          apiFetchBookings(true),
          apiFetchSubscriptions(),
        ]);
        if (!isMounted) return;
        if (!profileRes?.data) {
          if (profileRes?.status === 401) {
            trackClientError(
              "cabinet.load_unauthorized",
              new Error("Profile request unauthorized"),
              { status: 401 },
              { handled: true, severity: "warning" },
            );
            trackAnalyticsEvent("cabinet_load_failed", {
              reason: "unauthorized",
              status: 401,
            });
            logout();
            return;
          }
          trackAnalyticsEvent("cabinet_load_failed", {
            reason: "profile_not_loaded",
            status: profileRes?.status ?? null,
          });
          trackClientError(
            "cabinet.profile_not_loaded",
            new Error("Profile payload is empty"),
            { status: profileRes?.status ?? null, message: profileRes?.error?.message ?? null },
            { handled: true, severity: "error" },
          );
          setLoadError(CABINET_LOAD_ERROR_TEXT);
          setLoading(false);
          return;
        }
        setProfile(profileRes.data);
        setActiveBookings(activeRes?.data || null);
        setHistoryBookings(historyRes?.data || null);
        setUserSubscriptions(subsRes?.data || null);
        trackAnalyticsEvent("cabinet_data_loaded", {
          activeBookingsCount: activeRes?.data?.content?.length ?? 0,
          historyBookingsCount: historyRes?.data?.content?.length ?? 0,
          subscriptionsCount: subsRes?.data?.content?.length ?? 0,
        });
      } catch (error) {
        if (isMounted) {
          console.error("Ошибка загрузки:", error);
          trackClientError(
            "cabinet.load_exception",
            error,
            { reloadKey },
            { handled: true, severity: "error" },
          );
          trackAnalyticsEvent("cabinet_load_failed", {
            reason: "network_error",
            error: error instanceof Error ? error.message : String(error),
          });
          setLoadError(CABINET_LOAD_ERROR_TEXT);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    loadData();
    return () => { isMounted = false; };
  }, [logout, reloadKey]);

  const applyOnboardingLevels = (
    source: UserProfileType,
    detail: ProfileUpdatedEventDetail,
  ): UserProfileType => {
    const nextCustomFields = [...(source.customFields || [])];

    const upsertField = (fieldId: string, value: string | undefined) => {
      if (!value) return;
      const index = nextCustomFields.findIndex((field) => field.id === fieldId);
      if (index >= 0) {
        nextCustomFields[index] = { ...nextCustomFields[index], value: [value] };
        return;
      }
      nextCustomFields.push({
        id: fieldId,
        name: "",
        value: [value],
      });
    };

    upsertField(CUSTOM_FIELD_IDS.lkPadelLevel, detail.levelLetter);
    upsertField(CUSTOM_FIELD_IDS.lkPadelLevelNumeric, detail.levelNumeric);

    return { ...source, customFields: nextCustomFields };
  };

  const loadProfile = async (fallbackDetail?: ProfileUpdatedEventDetail) => {
    const data = await apiFetchProfile();
    if (!data?.data) return;

    if (fallbackDetail?.levelLetter || fallbackDetail?.levelNumeric) {
      setProfile(applyOnboardingLevels(data.data, fallbackDetail));
      return;
    }

    setProfile(data.data);
  };

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProfileUpdatedEventDetail>).detail;
      if (detail?.levelLetter || detail?.levelNumeric) {
        setProfile((prev) => (prev ? applyOnboardingLevels(prev, detail) : prev));
        void loadProfile(detail);
        return;
      }
      void loadProfile();
    };
    window.addEventListener("lk-profile-updated", handler);
    return () => {
      window.removeEventListener("lk-profile-updated", handler);
    };
  }, []);

  useEffect(() => {
    if (!profile) return;

    const numericLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
    const letterLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
    const onboardingCompleted = Boolean(numericLevelValue);

    identifyAnalyticsUser({
      clientId: profile.id,
      phone: profile.phone,
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      middleName: profile.middleName,
      sex: profile.sex,
      birthDate: profile.birthDate,
      onboardingCompleted,
      levelLetter: letterLevelValue,
      levelNumeric: numericLevelValue,
    });

    if (!cabinetVisitTrackedRef.current) {
      const visitCount = trackCabinetVisit({
        clientId: profile.id,
        onboardingCompleted,
      });
      cabinetVisitTrackedRef.current = true;
      trackAnalyticsEvent("cabinet_opened", {
        clientId: profile.id,
        visitCount,
        onboardingCompleted,
      });
    }

    if (onboardingStatusRef.current !== onboardingCompleted) {
      onboardingStatusRef.current = onboardingCompleted;
      trackAnalyticsEvent("onboarding_status_detected", {
        clientId: profile.id,
        onboardingCompleted,
        levelLetter: letterLevelValue ?? null,
        levelNumeric: numericLevelValue ?? null,
      });
    }
  }, [profile]);

  useEffect(() => {
    const phone = profile?.phone?.trim();
    if (!phone) {
      setCreatedGames([]);
      return;
    }

    let alive = true;
    setLoadingCreatedGames(true);
    setCreatedGamesError(null);

    apiFetchPadelGamesByPhone(phone, profile?.id ?? null)
      .then((result) => {
        if (!alive) return;
        setCreatedGames(Array.isArray(result.data) ? result.data : []);
        if (result.error) {
          setCreatedGamesError(result.error.message || "Не удалось загрузить игры");
        }
      })
      .catch(() => {
        if (!alive) return;
        setCreatedGames([]);
        setCreatedGamesError("Не удалось загрузить игры");
      })
      .finally(() => {
        if (alive) setLoadingCreatedGames(false);
      });

    return () => {
      alive = false;
    };
  }, [profile?.phone, profile?.id]);

  const gamesForFeed = useMemo(() => {
    return [...createdGames].sort((left, right) => toGameTimestamp(left) - toGameTimestamp(right));
  }, [createdGames]);

  const loadBookings = async () => {
    const [activeBookingsData, historyBookingsData, userSubscriptionsData] = await Promise.all([
      apiFetchBookings(false),
      apiFetchBookings(true),
      apiFetchSubscriptions(),
    ]);
    if (activeBookingsData) setActiveBookings(activeBookingsData.data);
    if (historyBookingsData) setHistoryBookings(historyBookingsData.data);
    if (userSubscriptionsData.data) setUserSubscriptions(userSubscriptionsData.data);
    trackAnalyticsEvent("cabinet_data_refreshed", {
      activeBookingsCount: activeBookingsData?.data?.content?.length ?? 0,
      historyBookingsCount: historyBookingsData?.data?.content?.length ?? 0,
      subscriptionsCount: userSubscriptionsData?.data?.content?.length ?? 0,
    });
  };

  const openSubInfo = (sub: Subscription, subName: string) => {
    SetCurrenSub(sub);
    SetCurrenSubName(subName);
    SetSubscriptionInfoOpen(true);
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (loadError) {
    return (
      <div className="load-error">
        <div className="load-error-title">Не удалось загрузить личный кабинет</div>
        <div className="load-error-text">Попробуйте подключиться к WiFi сети и загрузить кабинет повторно.</div>
        <button
          className="section-cta"
          type="button"
          onClick={() => {
            trackAnalyticsEvent("cabinet_reload_clicked");
            setReloadKey((v) => v + 1);
          }}
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!profile) return <div className="load-error">{CABINET_LOAD_ERROR_TEXT}</div>;
  const numericLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
  const hasLevel = numericLevelValue !== undefined && numericLevelValue !== null && numericLevelValue !== "";
  const onboardingLabel = "Определи свой уровень";
  const tournamentsField = getCustomField(profile, CUSTOM_FIELD_IDS.tournamentsAccess);
  const tournamentsAccessValue = tournamentsField?.value?.[0];
  const canHostTournaments = tournamentsAccessValue === "проводит турниры"
    || Boolean(
      tournamentsField?.attributes?.options?.some(
        (opt) => opt.id === tournamentsAccessValue && opt.name.toLowerCase() === "проводит турниры",
      ),
    );

  const openOnboarding = () => {
    trackAnalyticsEvent("onboarding_open_requested", {
      source: "cabinet",
      clientId: profile.id,
    });
    onOpenOnboarding({
      profile,
      gamesLink: QUICK_ACTIONS.find((action) => action.label === "Играть")?.href || "#",
      trainingLink: QUICK_ACTIONS.find((action) => action.label === "Групповые тренировки")?.href || "#",
      tournamentsLink: QUICK_ACTIONS.find((action) => action.label === "Турниры")?.href || "#",
    });
  };

  const handleOpenGames = () => {
    trackAnalyticsEvent("module_open_requested", {
      module: "games",
      source: "cabinet",
      clientId: profile.id,
    });
    onOpenGames();
  };

  const handleCopyInviteFromFeed = async (game: PadelGameRecord) => {
    const url = resolveGameInviteUrl(game) || "";
    if (!url) return;
    try {
      await navigator.clipboard?.writeText(url);
      setCopiedGameInviteId(game.id);
      window.setTimeout(() => {
        setCopiedGameInviteId((prev) => (prev === game.id ? null : prev));
      }, 1600);
    } catch {
      setCopiedGameInviteId(null);
    }
  };

  const handleOpenGameChat = (game: PadelGameRecord) => {
    onOpenGames({ gameId: game.id, openChat: true });
  };

  const handleOpenTournaments = () => {
    trackAnalyticsEvent("module_open_requested", {
      module: "tournaments",
      source: "cabinet",
      clientId: profile.id,
    });
    onOpenTournaments();
  };

  const renderActionIcon = (label: string, fallback: string) => {
    if (label === "Играть") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10.9801 5.82995C10.3851 5.45495 9.69512 5.24995 8.98512 5.24995C6.91512 5.24995 5.23512 6.92995 5.23512 8.99995C5.23512 9.70995 5.43512 10.3949 5.81012 10.9899C5.58012 10.9849 5.34512 10.9599 5.10512 10.9249C3.05012 10.5749 1.39512 8.90995 1.05512 6.84995C0.490117 3.42495 3.41012 0.504949 6.83512 1.06995C8.89512 1.40995 10.5601 3.06495 10.9101 5.11995C10.9501 5.35995 10.9751 5.59995 10.9801 5.82995Z" fill="white"/>
              <path d="M6.68999 10.93C6.24999 10.41 5.98499 9.735 5.98499 9C5.98499 7.345 7.32998 6 8.98498 6C9.71999 6 10.395 6.265 10.915 6.705" fill="white"/>
              <path d="M6.68999 10.93C6.24999 10.41 5.98499 9.735 5.98499 9C5.98499 7.345 7.32998 6 8.98498 6C9.71999 6 10.395 6.265 10.915 6.705C10.7499 9 8.74988 10.75 6.68999 10.93Z" fill="white"/>
            </svg>
          </svg>
        </span>
      );
    }

    if (label === "Турниры") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <path d="M13.625 17.125H12.5C11.95 17.125 11.5 17.575 11.5 18.125V18.25H11C10.795 18.25 10.625 18.42 10.625 18.625C10.625 18.83 10.795 19 11 19H17C17.205 19 17.375 18.83 17.375 18.625C17.375 18.42 17.205 18.25 17 18.25H16.5V18.125C16.5 17.575 16.05 17.125 15.5 17.125H14.375V15.98C14.25 15.995 14.125 16 14 16C13.875 16 13.75 15.995 13.625 15.98V17.125Z" fill="white"/>
            <path d="M17.24 13.82C17.57 13.695 17.86 13.49 18.09 13.26C18.555 12.745 18.86 12.13 18.86 11.41C18.86 10.69 18.295 10.125 17.575 10.125H17.295C16.97 9.46 16.29 9 15.5 9H12.5C11.71 9 11.03 9.46 10.705 10.125H10.425C9.705 10.125 9.14 10.69 9.14 11.41C9.14 12.13 9.445 12.745 9.91 13.26C10.14 13.49 10.43 13.695 10.76 13.82C11.28 15.1 12.53 16 14 16C15.47 16 16.72 15.1 17.24 13.82ZM15.42 12.225L15.11 12.605C15.06 12.66 15.025 12.77 15.03 12.845L15.06 13.335C15.08 13.635 14.865 13.79 14.585 13.68L14.13 13.5C14.06 13.475 13.94 13.475 13.87 13.5L13.415 13.68C13.135 13.79 12.92 13.635 12.94 13.335L12.97 12.845C12.975 12.77 12.94 12.66 12.89 12.605L12.58 12.225C12.385 11.995 12.47 11.74 12.76 11.665L13.235 11.545C13.31 11.525 13.4 11.455 13.44 11.39L13.705 10.98C13.87 10.725 14.13 10.725 14.295 10.98L14.56 11.39C14.6 11.455 14.69 11.525 14.765 11.545L15.24 11.665C15.53 11.74 15.615 11.995 15.42 12.225Z" fill="white"/>
          </svg>
        </span>
      );
    }

    if (label === "Индивидуальные тренировки") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12">
              <rect x="3.6252" y="1.0000" width="4.7496" height="4.7496" rx="2.3748" fill="white"/>
              <rect x="2.4804" y="6.3780" width="7.0392" height="4.6224" rx="2.3112" fill="white"/>
              <rect x="0" y="0" width="12" height="12" fill="white" opacity="0" transform="rotate(-180 6 6)"/>
            </svg>
          </svg>
        </span>
      );
    }

    if (label === "Групповые тренировки") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.50012 0.999939C3.19012 0.999939 2.12512 2.06494 2.12512 3.37494C2.12512 4.65994 3.13012 5.69994 4.44012 5.74494C4.48012 5.73994 4.52012 5.73994 4.55012 5.74494C4.56012 5.74494 4.56512 5.74494 4.57512 5.74494C4.58012 5.74494 4.58012 5.74494 4.58512 5.74494C5.86512 5.69994 6.87012 4.65994 6.87512 3.37494C6.87512 2.06494 5.81012 0.999939 4.50012 0.999939Z" fill="white"/>
              <path d="M7.03998 7.07488C5.64498 6.14488 3.36998 6.14488 1.96498 7.07488C1.32998 7.49988 0.97998 8.07488 0.97998 8.68988C0.97998 9.30488 1.32998 9.87488 1.95998 10.2949C2.65998 10.7649 3.57998 10.9999 4.49998 10.9999C5.41998 10.9999 6.33998 10.7649 7.03998 10.2949C7.66998 9.86988 8.01998 9.29988 8.01998 8.67988C8.01498 8.06488 7.66998 7.49488 7.03998 7.07488Z" fill="white"/>
              <path d="M9.99505 3.66999C10.0751 4.63999 9.38505 5.48999 8.43005 5.60499C8.42505 5.60499 8.42505 5.60499 8.42005 5.60499H8.40505C8.37505 5.60499 8.34505 5.60499 8.32005 5.61499C7.83505 5.63999 7.39005 5.48499 7.05505 5.19999C7.57005 4.73999 7.86505 4.04999 7.80505 3.29999C7.77005 2.89499 7.63005 2.52499 7.42005 2.20999C7.61005 2.11499 7.83005 2.05499 8.05505 2.03499C9.03505 1.94999 9.91005 2.67999 9.99505 3.66999Z" fill="white"/>
              <path d="M10.995 8.29495C10.955 8.77995 10.645 9.19995 10.125 9.48495C9.625 9.75995 8.995 9.88995 8.37 9.87495C8.73 9.54995 8.93999 9.14495 8.97999 8.71495C9.02999 8.09495 8.735 7.49995 8.145 7.02495C7.81 6.75995 7.42 6.54995 6.995 6.39495C8.1 6.07495 9.49 6.28995 10.345 6.97995C10.805 7.34995 11.04 7.81495 10.995 8.29495Z" fill="white"/>
            </svg>
          </svg>
        </span>
      );
    }

    return <span className="quick-action-icon">{fallback}</span>;
  };

  return (
    <div className="app-container">

      {/* Шапка с профилем */}
      <UserProfile
        profile={profile}
        openEditForm={() => setIsEditOpen(true)}
      />

      {/* Онбординг */}
      {!hasLevel && (
        <div className="onboarding-section">
          <button
            className="onboarding-btn"
            onClick={openOnboarding}
          >
            {onboardingLabel}
          </button>
        </div>
      )}

      {/* Быстрые действия */}
      <div className="quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <a
            key={action.label}
            href={action.href}
            target="_blank"
            rel="noopener noreferrer"
            className="quick-action-card"
            onClick={() =>
              trackAnalyticsEvent("quick_action_click", {
                label: action.label,
                href: action.href,
                clientId: profile.id,
              })}
          >
            {renderActionIcon(action.label, action.icon)}
            <span className="quick-action-label">{action.label}</span>
          </a>
        ))}
      </div>

      {/* Игры */}
      <div className="section">
        <div className="section-header">
          <span className="section-title">Игры</span>
        </div>
        <div className="section-body cabinet-games-feed">
          {loadingCreatedGames && <div className="section-text">Загружаем созданные игры...</div>}
          {!loadingCreatedGames && createdGamesError && (
            <div className="section-text">{createdGamesError}</div>
          )}
          {!loadingCreatedGames && !createdGamesError && gamesForFeed.length === 0 && (
            <div className="section-text">У вас пока нет созданных игр</div>
          )}

          {!loadingCreatedGames && !createdGamesError && gamesForFeed.length > 0 && (
            <div className="game-created-list">
              {gamesForFeed.map((game) => {
                const dateTitle = formatGameCardDate(game.booking?.date);
                const badge = getDateBadge(game.booking?.date);
                const timeFrom = game.booking?.timeFrom ?? "—:—";
                const timeTo = game.booking?.timeTo ?? "—:—";
                const ratingTag = game.settings?.ratingGame ? "Рейтинговый" : "Без рейтинга";
                const durationTag = game.booking?.durationMinutes
                  ? `${game.booking.durationMinutes} мин`
                  : null;
                const ratingRangeTag =
                  game.settings?.minRating && game.settings?.maxRating
                    ? `${game.settings.minRating}/${game.settings.maxRating}`
                    : null;
                const organizerPlayer: PadelGamePlayer | null = game.organizer
                  ? {
                      id: game.organizer.id ?? null,
                      name: game.organizer.name || "Организатор",
                      phone: game.organizer.phone ?? null,
                      photo: game.organizer.photo ?? null,
                      rating: game.organizer.rating ?? null,
                      source: "ORGANIZER",
                      status: "CONFIRMED",
                    }
                  : null;
                const participants = game.participants && game.participants.length > 0
                  ? game.participants
                  : (organizerPlayer ? [organizerPlayer] : []);
                const playerSlots = Array.from({ length: MAX_GAME_PLAYERS }, (_, index) => (
                  participants[index] ?? null
                ));

                return (
                  <div key={game.id} className="game-created-card">
                    <div className="game-created-head">
                      <div className="game-created-date">{dateTitle}</div>
                      <div className="booking-date-badge game-created-date-badge">
                        <div className="booking-date-badge-month">{badge.month}</div>
                        <div className="booking-date-badge-day">{badge.day}</div>
                      </div>
                    </div>
                    <div className="game-created-time">{`${timeFrom} • ${timeTo}`}</div>
                    <div className="game-created-tags">
                      <span className="game-created-tag">{ratingTag}</span>
                      {durationTag && <span className="game-created-tag">{durationTag}</span>}
                      {ratingRangeTag && <span className="game-created-tag">{ratingRangeTag}</span>}
                    </div>
                    <div className="game-created-players">
                      {playerSlots.map((player, index) => {
                        const initials = getPlayerInitials(player?.name);
                        const isConfirmed = player?.status === "CONFIRMED" || !player?.status;
                        return (
                          <div key={`${game.id}-slot-${index}`} className="game-created-player">
                            <span className="game-created-player-mark">
                              {isConfirmed ? "●" : "◷"}
                            </span>
                            {player?.photo ? (
                              <img
                                src={player.photo}
                                alt={player.name}
                                className="game-created-player-avatar"
                              />
                            ) : (
                              <div className="game-created-player-avatar game-created-player-fallback">
                                {initials}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="game-created-actions">
                      <button
                        className="game-created-action game-created-action-secondary"
                        type="button"
                        disabled={!resolveGameInviteUrl(game)}
                        onClick={() => {
                          void handleCopyInviteFromFeed(game);
                        }}
                      >
                        {copiedGameInviteId === game.id ? "Скопировано" : "Пригласить в игру"}
                      </button>
                      <button
                        className="game-created-action"
                        type="button"
                        onClick={() => {
                          handleOpenGameChat(game);
                        }}
                      >
                        Чат
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <button className="section-cta" onClick={handleOpenGames} type="button">
            Перейти в игры
          </button>
        </div>
      </div>

      {/* Турниры */}
      {canHostTournaments && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Турниры</span>
          </div>
          <div className="section-body">
            <p className="section-text">Управляйте турнирами в отдельном модуле.</p>
            <button className="section-cta" onClick={handleOpenTournaments} type="button">
              Перейти в турниры
            </button>
          </div>
        </div>
      )}

      {/* Записи */}
      <BookingsContainer
        activeBookings={activeBookings}
        historyBookings={historyBookings}
        openHistory={() => setIsBookingHistoryOpen(true)}
        loadBookings={loadBookings}
      />

      {/* Реклама */}
      <div className="section section--ads">
        <div className="section-header">
          <span className="section-title">Акции</span>
        </div>
        <Advertisement />
      </div>

      {/* Абонементы */}
      <SubscriptionsContainer
        UserSubscriptions={userSubscriptions}
        phone={profile.phone}
        openSubInfo={openSubInfo}
        openBuy={() => setOpenBuySub(true)}
      />

      {/* Соцсети */}
      <ButtonModule />

      {/* Модалки */}
      <ProfileEditForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        initialData={{
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          middleName: profile.middleName,
          sex: profile.sex,
          photo: profile.photo,
        }}
        onSaveSuccess={loadProfile}
        showVerifyLevel={hasLevel}
        onVerifyLevel={openOnboarding}
      />
      <BookingHistory
        isOpen={isBookingHistoryOpen}
        onClose={() => setIsBookingHistoryOpen(false)}
        historyBookings={historyBookings}
      />
      <SubscriptionInformation
        isOpen={isSubscriptionInfoOpen}
        onClose={() => SetSubscriptionInfoOpen(false)}
        sub={currenSub}
        subName={currenSubName}
      />
      <BuySupscription
        isOpen={isOpenBuySub}
        onClose={() => setOpenBuySub(false)}
        phone={profile.phone}
      />
    </div>
  );
}
