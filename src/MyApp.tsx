import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import { RemoteWidgetHost } from "./components/UI/RemoteWidgetHost";
import { Cabinet } from "./components/cabinet/Cabinet";
import CommunityJoinPage from "./components/communities/CommunityJoinPage";
import FindGamePage from "./components/games/FindGamePage";
import GamesPage from "./components/games/GamesPage";
import TournamentsPage from "./components/tournaments/TournamentsPage";
import { ManagedSubscriptionDevPage } from "./components/subscriptions/ManagedSubscriptionDevPage";
import {
  CABINET_URL,
  PUBLIC_COMMUNITY_JOIN_PATH,
  GAMES_BUNDLE_URL,
  LEVELS_INFO_BUNDLE_URL,
  ONBOARDING_BUNDLE_URL,
  PUBLIC_GAME_CREATE_PATH,
  PUBLIC_GAME_FIND_PATH,
  PUBLIC_INVITE_PATH,
  TOURNAMENTS_BUNDLE_URL,
} from "./consts/api_config";
import { loadWidget, type WidgetGlobalName, type WidgetModule } from "./utils/widgetLoader";
import { trackAnalyticsEvent, trackClientError } from "./utils/analytics";
import { PAYMENT_REF_QUERY_KEY, processPendingPaymentSyncQueue } from "./utils/paymentSync";
import { syncGamesCommunityAutopublish } from "./utils/gameCommunityAutopublish";
import { resolveCommunityJoinRouteData } from "./utils/communityJoinRoute";
import { appendCurrentAuthModeToNavigableUrl } from "./utils/authMode";
import type { GamesMountData, OpenGamesOptions } from "./types/gamesOverlay";
import type { LevelsInfoMountData, OpenLevelsInfoOptions } from "./types/levelsInfoOverlay";
import type { OpenTournamentsOptions, TournamentsMountData } from "./types/tournamentsOverlay";
import type { PadelGameRecord, UserProfileType } from "./utils/apiClient";
import "./MyApp.css";

type OnboardingMountData = {
  profile?: UserProfileType;
  gamesLink?: string;
  trainingLink?: string;
  tournamentsLink?: string;
};

type OverlayModuleName = "games" | "tournaments" | "onboarding" | "levels-info";
type OverlayData = GamesMountData | TournamentsMountData | OnboardingMountData | LevelsInfoMountData | undefined;

type AppWindow = Window & Record<WidgetGlobalName, WidgetModule | undefined> & {
  __LK_ON_READY?: () => void;
  __PADLHUB_JOIN_CONFIG__?: { gameId?: string | null; cabinetUrl?: string | null };
  __PADLHUB_COMMUNITY_JOIN_CONFIG__?: {
    inviteCode?: string | null;
    inviteLink?: string | null;
    cabinetUrl?: string | null;
  };
  __PADLHUB_CREATE_CONFIG__?: {
    studioId?: string | null;
    studioName?: string | null;
    stationId?: string | null;
    stationName?: string | null;
    cabinetUrl?: string | null;
  };
  __PADLHUB_FIND_GAME_CONFIG__?: {
    studioId?: string | null;
    studioName?: string | null;
    stationId?: string | null;
    stationName?: string | null;
    cabinetUrl?: string | null;
    includeGamePlusTrainer?: boolean | string | null;
  };
};

const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_INVITE_PATH = (PUBLIC_INVITE_PATH || "/game_join").replace(/\/+$/, "") || "/game_join";
const DEFAULT_GAME_CREATE_PATH =
  (PUBLIC_GAME_CREATE_PATH || "/game_create").replace(/\/+$/, "") || "/game_create";
const DEFAULT_GAME_CREATE_COMPOSITE_PATH = "/game_create_composite";
const DEFAULT_GAME_FIND_PATH =
  (PUBLIC_GAME_FIND_PATH || "/finde_game").replace(/\/+$/, "") || "/finde_game";
const DEFAULT_COMMUNITY_JOIN_PATH =
  (PUBLIC_COMMUNITY_JOIN_PATH || "/community_join").replace(/\/+$/, "") || "/community_join";
const OPEN_GAME_QUERY_KEY = "openGameId";

function notifyGamesUpdated(records: PadelGameRecord[], source: string): void {
  if (typeof window === "undefined" || records.length === 0) return;
  window.dispatchEvent(new CustomEvent("lk-games-updated", {
    detail: {
      records,
      source,
    },
  }));
}

const OVERLAY_ID = "lk-overlay";
let overlayRoot: ReturnType<typeof createRoot> | null = null;
let activeOverlayModule: OverlayModuleName | null = null;

function ensureOverlayContainer() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.className = "lk-overlay";
    document.body.appendChild(el);
  }
  return el;
}

function showOverlay() {
  const el = ensureOverlayContainer();
  el.classList.add("open");
  document.body.classList.add("lk-overlay-open");
  return el;
}

function hideOverlay() {
  if (activeOverlayModule) {
    trackAnalyticsEvent("module_closed", {
      module: activeOverlayModule,
    });
    activeOverlayModule = null;
  }

  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    el.classList.remove("open");
  }
  document.body.classList.remove("lk-overlay-open");

  const root = overlayRoot;
  overlayRoot = null;

  const cleanup = () => {
    if (root) {
      try {
        root.unmount();
      } catch (err) {
        console.warn("Overlay unmount failed", err);
      }
    }
    if (el) {
      el.textContent = "";
    }
  };

  requestAnimationFrame(cleanup);
}

function normalizeInviteCabinetUrl(value: string | null | undefined): string {
  const fallback = (DEFAULT_CABINET_URL || "").trim();
  const raw = (value || "").trim();
  if (!raw) return fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback;

  try {
    return appendCurrentAuthModeToNavigableUrl(
      new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined),
    ).toString();
  } catch {
    return raw || (fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback);
  }
}

function AppContent() {
  const { isAuthenticated, logout, isRestoringSession } = useAuth();
  const isAndroidTournamentMode = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  const [view, setView] = useState<"auth" | "cabinet" | "tournaments">("auth");
  const [autoOpenFromPaymentHandled, setAutoOpenFromPaymentHandled] = useState(false);

  const joinRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        gameId: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
        openChat: false,
      };
    }

    const current = new URL(window.location.href);
    const hashRaw = (current.hash || "").replace(/^#/, "");
    const hashQueryIndex = hashRaw.indexOf("?");
    const hashParams = new URLSearchParams(hashQueryIndex >= 0 ? hashRaw.slice(hashQueryIndex + 1) : "");
    const href = window.location.href || "";
    const regexJoinMatch = href.match(/[?&#]joinGame=([^&#]+)/i);
    const regexJoinGame = (() => {
      if (!regexJoinMatch?.[1]) return null;
      try {
        return decodeURIComponent(regexJoinMatch[1]);
      } catch {
        return regexJoinMatch[1];
      }
    })();
    const joinConfig =
      (window as typeof window & {
        __PADLHUB_JOIN_CONFIG__?: { gameId?: string | null; cabinetUrl?: string | null };
      }).__PADLHUB_JOIN_CONFIG__ ?? null;
    const gameId = (
      current.searchParams.get("joinGame")
      || hashParams.get("joinGame")
      || regexJoinGame
      || current.searchParams.get("gameId")
      || hashParams.get("gameId")
      || current.searchParams.get("id")
      || hashParams.get("id")
      || joinConfig?.gameId
      || ""
    ).trim();
    const openChatRaw = (
      current.searchParams.get("openChat")
      || hashParams.get("openChat")
      || ""
    ).trim();
    const openChat = /^(1|true|yes)$/i.test(openChatRaw);
    const byPath = current.pathname.replace(/\/+$/, "").endsWith(DEFAULT_INVITE_PATH);
    const enabled = byPath || Boolean(gameId);
    const cabinetUrl = normalizeInviteCabinetUrl((
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || joinConfig?.cabinetUrl
      || DEFAULT_CABINET_URL
    ));

    return {
      enabled,
      gameId: gameId || null,
      cabinetUrl,
      openChat,
    };
  }, []);

  useEffect(() => {
    if (!joinRouteData.enabled || !joinRouteData.gameId) return;
    if (typeof window === "undefined") return;

    try {
      const current = new URL(window.location.href);
      if (current.searchParams.get("entry") !== "game_join") return;

      const normalizedInvitePath = DEFAULT_INVITE_PATH.startsWith("/")
        ? DEFAULT_INVITE_PATH
        : `/${DEFAULT_INVITE_PATH}`;
      const currentPath = current.pathname.replace(/\/+$/, "") || "/";
      const targetPath = normalizedInvitePath.replace(/\/+$/, "") || "/";
      if (currentPath === targetPath) return;

      const next = new URL(targetPath, current.origin);
      current.searchParams.forEach((value, key) => {
        if (key.trim().toLowerCase() === "entry") return;
        next.searchParams.append(key, value);
      });
      next.searchParams.set("joinGame", joinRouteData.gameId);

      window.history.replaceState(
        window.history.state,
        "",
        `${next.pathname}${next.search}${current.hash}`,
      );
    } catch {
      // URL cleanup is best-effort only.
    }
  }, [joinRouteData.enabled, joinRouteData.gameId]);

  const createRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        studioId: null as string | null,
        studioName: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
        includeGamePlusTrainer: false,
      };
    }

    const current = new URL(window.location.href);
    const hashRaw = (current.hash || "").replace(/^#/, "");
    const hashQueryIndex = hashRaw.indexOf("?");
    const hashParams = new URLSearchParams(hashQueryIndex >= 0 ? hashRaw.slice(hashQueryIndex + 1) : "");
    const createConfig =
      (window as typeof window & {
        __PADLHUB_CREATE_CONFIG__?: {
          studioId?: string | null;
          studioName?: string | null;
          stationId?: string | null;
          stationName?: string | null;
          cabinetUrl?: string | null;
        };
      }).__PADLHUB_CREATE_CONFIG__ ?? null;
    const studioId = (
      current.searchParams.get("stationId")
      || hashParams.get("stationId")
      || current.searchParams.get("studioId")
      || hashParams.get("studioId")
      || createConfig?.stationId
      || createConfig?.studioId
      || ""
    ).trim();
    const studioName = (
      current.searchParams.get("station")
      || hashParams.get("station")
      || current.searchParams.get("stationName")
      || hashParams.get("stationName")
      || current.searchParams.get("studio")
      || hashParams.get("studio")
      || current.searchParams.get("studioName")
      || hashParams.get("studioName")
      || createConfig?.stationName
      || createConfig?.studioName
      || ""
    ).trim();
    const byPath = current.pathname.replace(/\/+$/, "").endsWith(DEFAULT_GAME_CREATE_PATH);
    const cabinetUrl = (
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || createConfig?.cabinetUrl
      || DEFAULT_CABINET_URL
    ).trim() || DEFAULT_CABINET_URL;

    return {
      enabled: byPath,
      studioId: studioId || null,
      studioName: studioName || null,
      cabinetUrl,
    };
  }, []);

  const compositeCreateRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        studioId: null as string | null,
        studioName: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
      };
    }

    const current = new URL(window.location.href);
    const hashRaw = (current.hash || "").replace(/^#/, "");
    const hashQueryIndex = hashRaw.indexOf("?");
    const hashParams = new URLSearchParams(hashQueryIndex >= 0 ? hashRaw.slice(hashQueryIndex + 1) : "");
    const createConfig =
      (window as typeof window & {
        __PADLHUB_CREATE_CONFIG__?: {
          studioId?: string | null;
          studioName?: string | null;
          stationId?: string | null;
          stationName?: string | null;
          cabinetUrl?: string | null;
        };
      }).__PADLHUB_CREATE_CONFIG__ ?? null;
    const studioId = (
      current.searchParams.get("stationId")
      || hashParams.get("stationId")
      || current.searchParams.get("studioId")
      || hashParams.get("studioId")
      || createConfig?.stationId
      || createConfig?.studioId
      || ""
    ).trim();
    const studioName = (
      current.searchParams.get("station")
      || hashParams.get("station")
      || current.searchParams.get("stationName")
      || hashParams.get("stationName")
      || current.searchParams.get("studio")
      || hashParams.get("studio")
      || current.searchParams.get("studioName")
      || hashParams.get("studioName")
      || createConfig?.stationName
      || createConfig?.studioName
      || ""
    ).trim();
    const byPath = current.pathname.replace(/\/+$/, "").endsWith(DEFAULT_GAME_CREATE_COMPOSITE_PATH);
    const cabinetUrl = (
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || createConfig?.cabinetUrl
      || DEFAULT_CABINET_URL
    ).trim() || DEFAULT_CABINET_URL;

    return {
      enabled: byPath,
      studioId: studioId || null,
      studioName: studioName || null,
      cabinetUrl,
    };
  }, []);

  const findRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        studioId: null as string | null,
        studioName: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
      };
    }

    const current = new URL(window.location.href);
    const hashRaw = (current.hash || "").replace(/^#/, "");
    const hashQueryIndex = hashRaw.indexOf("?");
    const hashParams = new URLSearchParams(hashQueryIndex >= 0 ? hashRaw.slice(hashQueryIndex + 1) : "");
    const findConfig =
      (window as typeof window & {
        __PADLHUB_FIND_GAME_CONFIG__?: {
          studioId?: string | null;
          studioName?: string | null;
          stationId?: string | null;
          stationName?: string | null;
          cabinetUrl?: string | null;
          includeGamePlusTrainer?: boolean | string | null;
        };
      }).__PADLHUB_FIND_GAME_CONFIG__ ?? null;
    const studioId = (
      current.searchParams.get("stationId")
      || hashParams.get("stationId")
      || current.searchParams.get("studioId")
      || hashParams.get("studioId")
      || findConfig?.stationId
      || findConfig?.studioId
      || ""
    ).trim();
    const studioName = (
      current.searchParams.get("station")
      || hashParams.get("station")
      || current.searchParams.get("stationName")
      || hashParams.get("stationName")
      || current.searchParams.get("studio")
      || hashParams.get("studio")
      || current.searchParams.get("studioName")
      || hashParams.get("studioName")
      || findConfig?.stationName
      || findConfig?.studioName
      || ""
    ).trim();
    const byPath = current.pathname.replace(/\/+$/, "").endsWith(DEFAULT_GAME_FIND_PATH);
    const cabinetUrl = (
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || findConfig?.cabinetUrl
      || DEFAULT_CABINET_URL
    ).trim() || DEFAULT_CABINET_URL;
    const includeGamePlusTrainerValue = (
      current.searchParams.get("includeGamePlusTrainer")
      ?? hashParams.get("includeGamePlusTrainer")
      ?? findConfig?.includeGamePlusTrainer
      ?? null
    );
    const includeGamePlusTrainerRaw = String(includeGamePlusTrainerValue ?? "").trim();
    const includeGamePlusTrainer = includeGamePlusTrainerRaw
      ? /^(1|true|yes)$/i.test(includeGamePlusTrainerRaw)
      : byPath;

    return {
      enabled: byPath,
      studioId: studioId || null,
      studioName: studioName || null,
      cabinetUrl,
      includeGamePlusTrainer,
    };
  }, []);

  const communityJoinRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        inviteCode: null as string | null,
        inviteLink: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
      };
    }

    const communityJoinConfig = (
      window as typeof window & {
        __PADLHUB_COMMUNITY_JOIN_CONFIG__?: {
          inviteCode?: string | null;
          inviteLink?: string | null;
          cabinetUrl?: string | null;
        };
      }
    ).__PADLHUB_COMMUNITY_JOIN_CONFIG__ ?? null;

    return resolveCommunityJoinRouteData({
      href: window.location.href,
      defaultCabinetUrl: DEFAULT_CABINET_URL,
      defaultCommunityJoinPath: DEFAULT_COMMUNITY_JOIN_PATH,
      config: communityJoinConfig,
    });
  }, []);

  useEffect(() => {
    (window as unknown as AppWindow).__LK_ON_READY?.();
  }, []);

  const openOverlayModule = useCallback(async (
    module: OverlayModuleName,
    src?: string,
    globalName?: WidgetGlobalName,
    data?: OverlayData,
  ) => {
    trackAnalyticsEvent("module_open_requested", {
      module,
      source: "overlay",
    });

    if (activeOverlayModule) {
      trackAnalyticsEvent("module_closed", {
        module: activeOverlayModule,
        reason: "switch",
      });
      activeOverlayModule = null;
    }

    if (!src || !globalName) {
      console.warn("Overlay module URL is not configured");
      if (!import.meta.env.DEV) {
        trackAnalyticsEvent("module_open_failed", {
          module,
          reason: "bundle_url_not_configured",
        });
        return;
      }
    }
    const container = showOverlay();
    if (overlayRoot) {
      overlayRoot.unmount();
      overlayRoot = null;
    }
    container.innerHTML = '<div class="overlay-loading">Загрузка...</div>';

    if (import.meta.env.DEV) {
      try {
        const onBack = () => {
          hideOverlay();
        };
        container.innerHTML = "";
        overlayRoot = createRoot(container);
        if (module === "games") {
          const mod = await import("./components/games/GamesPage");
          const gamesData = data as GamesMountData | undefined;
          overlayRoot.render(
            <OverlayScopeProvider value>
              <mod.default
                onBack={onBack}
                openGameId={gamesData?.openGameId ?? null}
                openChat={gamesData?.openChat === true}
                createFromBooking={gamesData?.createFromBooking ?? null}
                initialGameRecord={gamesData?.initialGameRecord ?? null}
              />
            </OverlayScopeProvider>,
          );
        } else if (module === "tournaments") {
          const mod = await import("./components/tournaments/TournamentsPage");
          const tournamentsData = data as TournamentsMountData | undefined;
          overlayRoot.render(
            <OverlayScopeProvider value>
              <mod.default
                onBack={onBack}
                initialOpenTournamentId={tournamentsData?.tournamentId ?? null}
                initialOpenTournamentSlug={tournamentsData?.tournamentSlug ?? null}
                initialOpenDate={tournamentsData?.date ?? null}
              />
            </OverlayScopeProvider>,
          );
        } else if (module === "levels-info") {
          const mod = await import("./components/levels-info/LevelsInfoOverlayPage");
          const levelsInfoData = data as LevelsInfoMountData | undefined;
          overlayRoot.render(
            <OverlayScopeProvider value>
              <mod.LevelsInfoOverlayPage
                onBack={onBack}
                data={levelsInfoData}
              />
            </OverlayScopeProvider>,
          );
        } else {
          const mod = await import("./components/onboarding/OnboardingPage");
          const onboardingData = data as OnboardingMountData | undefined;
          overlayRoot.render(
            <OverlayScopeProvider value>
              <mod.default
                onBack={onBack}
                profile={onboardingData?.profile}
                gamesLink={onboardingData?.gamesLink || "#"}
                trainingLink={onboardingData?.trainingLink || "#"}
                tournamentsLink={onboardingData?.tournamentsLink || "#"}
              />
            </OverlayScopeProvider>,
          );
        }
        activeOverlayModule = module;
        trackAnalyticsEvent("module_opened", {
          module,
          mode: "dev_import",
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Ошибка загрузки";
        container.innerHTML = `<div class="overlay-loading">${message}</div>`;
        trackClientError(
          "overlay.module_open_failed.dev_import",
          err,
          { module, globalName: globalName ?? null, src: src ?? null },
          { handled: true, severity: "error" },
        );
        activeOverlayModule = null;
        trackAnalyticsEvent("module_open_failed", {
          module,
          mode: "dev_import",
          reason: message,
        });
        return;
      }
    }

    try {
      const widget = await loadWidget(src!, globalName!, { forceReload: module === "games" });
      widget.mount({
        targetId: OVERLAY_ID,
        onClose: () => {
          widget.unmount?.(OVERLAY_ID);
          hideOverlay();
        },
        data,
      });
      activeOverlayModule = module;
      trackAnalyticsEvent("module_opened", {
        module,
        mode: "remote_bundle",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка загрузки";
      container.innerHTML = `<div class="overlay-loading">${message}</div>`;
      trackClientError(
        "overlay.module_open_failed.remote_bundle",
        err,
        { module, globalName: globalName ?? null, src: src ?? null },
        { handled: true, severity: "error" },
      );
      activeOverlayModule = null;
      trackAnalyticsEvent("module_open_failed", {
        module,
        mode: "remote_bundle",
        reason: message,
      });
    }
  }, []);

  useEffect(() => {
    if (isRestoringSession) return;
    if (isAuthenticated) {
      setView(isAndroidTournamentMode ? "tournaments" : "cabinet");
    } else {
      setView("auth");
      hideOverlay();
      setAutoOpenFromPaymentHandled(false);
    }
  }, [isAndroidTournamentMode, isAuthenticated, isRestoringSession]);

  useEffect(() => {
    if (view !== "cabinet" || autoOpenFromPaymentHandled) return;
    if (typeof window === "undefined") return;

    const search = new URLSearchParams(window.location.search);
    const paymentRef = search.get(PAYMENT_REF_QUERY_KEY)?.trim() || "";
    if (!paymentRef) return;

    setAutoOpenFromPaymentHandled(true);
    void processPendingPaymentSyncQueue({
      forcePaymentRef: paymentRef,
      source: "app_payment_callback",
      keepalive: true,
      maxItems: 1,
    }).then(async (result) => {
      const resolvedRecords = result.resolved.map((item) => item.record);
      notifyGamesUpdated(resolvedRecords, "app_payment_callback");
      await syncGamesCommunityAutopublish(resolvedRecords);
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete(PAYMENT_REF_QUERY_KEY);
      const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      window.history.replaceState({}, "", nextUrl);
    }).catch(() => {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete(PAYMENT_REF_QUERY_KEY);
      const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      window.history.replaceState({}, "", nextUrl);
    });
  }, [view, autoOpenFromPaymentHandled, openOverlayModule]);

  useEffect(() => {
    if (view !== "cabinet") return;
    if (typeof window === "undefined") return;

    const currentUrl = new URL(window.location.href);
    const openGameId = currentUrl.searchParams.get(OPEN_GAME_QUERY_KEY)?.trim() || "";
    if (!openGameId) return;

    currentUrl.searchParams.delete(OPEN_GAME_QUERY_KEY);
    const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    window.history.replaceState({}, "", nextUrl);

    void openOverlayModule("games", GAMES_BUNDLE_URL, "LKWidgetGames", {
      openGameId,
    });
  }, [view, openOverlayModule]);

  useEffect(() => {
    if (view !== "cabinet") return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get(PAYMENT_REF_QUERY_KEY)?.trim()) return;

    let cancelled = false;

    const runSync = async (source: string) => {
      const result = await processPendingPaymentSyncQueue({
        source,
        keepalive: true,
        maxItems: 3,
      });
      const resolvedRecords = result.resolved.map((item) => item.record);
      notifyGamesUpdated(resolvedRecords, source);
      await syncGamesCommunityAutopublish(resolvedRecords);
      if (cancelled) return;
      if (result.resolved.length > 0 || result.failed.length > 0) {
        trackAnalyticsEvent("payment_sync_background", {
          source,
          processed: result.processed,
          resolved: result.resolved.length,
          failed: result.failed.length,
          pending: result.pending,
        });
      }
    };

    void runSync("app_boot");

    const onFocus = () => {
      void runSync("app_focus");
    };
    const onVisibility = () => {
      if (document.hidden) return;
      void runSync("app_visible");
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [view]);

  if (isRestoringSession) {
    return <div className="loading">Проверяем сессию...</div>;
  }

  if (isAndroidTournamentMode) {
    if (!isAuthenticated) {
      return <AuthForm onLogin={() => setView("tournaments")} allowPhoneLogin={false} />;
    }

    return (
      <TournamentsPage
        onBack={() => logout()}
        backLabel="← Выйти"
      />
    );
  }

  if (joinRouteData.enabled) {
    if (!isAuthenticated) {
      return <AuthForm onLogin={() => setView("cabinet")} />;
    }

    if (!joinRouteData.gameId) {
      return (
        <div className="load-error">
          <div className="load-error-title">Не передан идентификатор игры</div>
          <div className="load-error-text">Проверьте ссылку приглашения и попробуйте снова.</div>
        </div>
      );
    }

    return (
      <GamesPage
        onBack={() => {
          window.location.href = appendCurrentAuthModeToNavigableUrl(
            joinRouteData.cabinetUrl || DEFAULT_CABINET_URL,
          ).toString();
        }}
        openGameId={joinRouteData.gameId}
        openChat={joinRouteData.openChat}
        createFromBooking={null}
        publicCreateEntry={false}
        presetStudioId={null}
        presetStudioName={null}
      />
    );
  }

  if (createRouteData.enabled) {
    if (!isAuthenticated) {
      return <AuthForm onLogin={() => setView("cabinet")} />;
    }

    return (
      <RemoteWidgetHost
        src={GAMES_BUNDLE_URL}
        globalName="LKWidgetGames"
        forceReload
        data={{
          publicCreateEntry: true,
          presetStudioId: createRouteData.studioId,
          presetStudioName: createRouteData.studioName,
          cabinetUrl: createRouteData.cabinetUrl || DEFAULT_CABINET_URL,
        } satisfies GamesMountData}
        loadingText="Загружаем создание игры..."
        errorTitle="Не удалось открыть создание игры"
      />
    );
  }

  if (compositeCreateRouteData.enabled) {
    if (!isAuthenticated) {
      return <AuthForm onLogin={() => setView("cabinet")} />;
    }

    return (
      <RemoteWidgetHost
        src={GAMES_BUNDLE_URL}
        globalName="LKWidgetGames"
        forceReload
        data={{
          compositeCreateEntry: true,
          presetStudioId: compositeCreateRouteData.studioId,
          presetStudioName: compositeCreateRouteData.studioName,
          cabinetUrl: compositeCreateRouteData.cabinetUrl || DEFAULT_CABINET_URL,
        } satisfies GamesMountData}
        loadingText="Загружаем составную запись..."
        errorTitle="Не удалось открыть составную запись"
      />
    );
  }

  if (findRouteData.enabled) {
    if (import.meta.env.DEV) {
      return (
        <FindGamePage
          cabinetUrl={findRouteData.cabinetUrl || DEFAULT_CABINET_URL}
          presetStudioId={findRouteData.studioId}
          presetStudioName={findRouteData.studioName}
          includeGamePlusTrainer={findRouteData.includeGamePlusTrainer}
        />
      );
    }

    return (
      <RemoteWidgetHost
        src={GAMES_BUNDLE_URL}
        globalName="LKWidgetGames"
        forceReload
        data={{
          publicFindEntry: true,
          presetStudioId: findRouteData.studioId,
          presetStudioName: findRouteData.studioName,
          cabinetUrl: findRouteData.cabinetUrl || DEFAULT_CABINET_URL,
          includeGamePlusTrainer: findRouteData.includeGamePlusTrainer,
        } satisfies GamesMountData}
        loadingText="Загружаем игры..."
        errorTitle="Не удалось открыть игры"
      />
    );
  }

  if (communityJoinRouteData.enabled) {
    if (!isAuthenticated) {
      return <AuthForm onLogin={() => setView("cabinet")} />;
    }

    if (!communityJoinRouteData.inviteCode && !communityJoinRouteData.inviteLink) {
      return (
        <div className="load-error">
          <div className="load-error-title">Не передана ссылка сообщества</div>
          <div className="load-error-text">Проверьте ссылку приглашения и попробуйте снова.</div>
        </div>
      );
    }

    return (
      <CommunityJoinPage
        inviteCode={communityJoinRouteData.inviteCode}
        inviteLink={communityJoinRouteData.inviteLink}
        cabinetUrl={communityJoinRouteData.cabinetUrl}
      />
    );
  }

  if (view === "cabinet") {
    return (
        <Cabinet
        onOpenGames={(options?: OpenGamesOptions) => {
          const directGameId = (options?.gameId || options?.joinGameId || "").trim();
          if (directGameId && !options?.initialGameRecord && typeof window !== "undefined") {
            const gameWindowUrl = new URL(window.location.href);
            gameWindowUrl.searchParams.set("joinGame", directGameId);
            if (options?.openChat) {
              gameWindowUrl.searchParams.set("openChat", "1");
            } else {
              gameWindowUrl.searchParams.delete("openChat");
            }
            const returnUrl = normalizeInviteCabinetUrl(
              options?.cabinetUrl ?? DEFAULT_CABINET_URL,
            );
            if (returnUrl) {
              gameWindowUrl.searchParams.set("cabinetUrl", returnUrl);
            } else {
              gameWindowUrl.searchParams.delete("cabinetUrl");
            }
            const openedWindow = window.open(gameWindowUrl.toString(), "_blank", "noopener");
            if (openedWindow) {
              return;
            }
          }

          const hasOptions = Boolean(
            options?.gameId
            || options?.joinGameId
            || options?.createFromBooking
            || options?.initialGameRecord,
          );
          const data: GamesMountData | undefined = hasOptions
            ? {
                openGameId: options?.gameId ?? options?.joinGameId ?? null,
                openChat: options?.openChat === true,
                createFromBooking: options?.createFromBooking ?? null,
                initialGameRecord: options?.initialGameRecord ?? null,
                cabinetUrl: options?.cabinetUrl ?? DEFAULT_CABINET_URL,
              }
            : undefined;
          return openOverlayModule(
            "games",
            GAMES_BUNDLE_URL,
            "LKWidgetGames",
            data,
          );
        }}
        onOpenTournaments={(options?: OpenTournamentsOptions) =>
          openOverlayModule(
            "tournaments",
            TOURNAMENTS_BUNDLE_URL,
            "LKWidgetTournaments",
            options?.tournamentId || options?.tournamentSlug || options?.date
              ? {
                  tournamentId: options.tournamentId ?? null,
                  tournamentSlug: options.tournamentSlug ?? null,
                  date: options.date ?? null,
                }
              : undefined,
          )}
        onOpenLevelsInfo={(options?: OpenLevelsInfoOptions) =>
          openOverlayModule(
            "levels-info",
            LEVELS_INFO_BUNDLE_URL,
            "LKWidgetLevelsInfo",
            options ? {
              profile: options.profile,
              ratingBreakdown: options.ratingBreakdown,
            } : undefined,
          )}
        onOpenOnboarding={(data) =>
          openOverlayModule(
            "onboarding",
            ONBOARDING_BUNDLE_URL,
            "LKWidgetOnboarding",
            data,
          )}
      />
    );
  }

  return <AuthForm onLogin={() => setView("cabinet")} />;
}

export default function App() {
  if (
    import.meta.env.DEV
    && typeof window !== "undefined"
    && window.location.pathname.replace(/\/+$/, "") === "/lk_subscription_dev"
  ) {
    return <ManagedSubscriptionDevPage />;
  }

  return (
    <AuthProvider
      authMode={Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" ? "viva" : "auto"}
    >
      <AppContent />
    </AuthProvider>
  );
}
