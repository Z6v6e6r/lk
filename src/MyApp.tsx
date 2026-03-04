import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import { Cabinet } from "./components/cabinet/Cabinet";
import GameJoinPage from "./components/games/GameJoinPage";
import {
  CABINET_URL,
  GAMES_BUNDLE_URL,
  ONBOARDING_BUNDLE_URL,
  PUBLIC_INVITE_PATH,
  TOURNAMENTS_BUNDLE_URL,
} from "./consts/api_config";
import { trackAnalyticsEvent, trackClientError } from "./utils/analytics";
import "./MyApp.css";

type WidgetModule = {
  mount: (options?: { targetId?: string; onClose?: () => void; data?: any }) => void;
  unmount?: (targetId?: string) => void;
};

const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_INVITE_PATH = (PUBLIC_INVITE_PATH || "/game_join").replace(/\/+$/, "") || "/game_join";

const OVERLAY_ID = "lk-overlay";
let overlayRoot: ReturnType<typeof createRoot> | null = null;
let activeOverlayModule: "games" | "tournaments" | "onboarding" | null = null;

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

const scriptPromises: Record<string, Promise<WidgetModule> | undefined> = {};

function loadWidget(src: string, globalName: string): Promise<WidgetModule> {
  if ((window as any)[globalName]) {
    return Promise.resolve((window as any)[globalName] as WidgetModule);
  }
  if (scriptPromises[globalName]) return scriptPromises[globalName]!;

  scriptPromises[globalName] = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const mod = (window as any)[globalName] as WidgetModule | undefined;
      if (!mod) {
        reject(new Error("Module did not register on window"));
        return;
      }
      resolve(mod);
    };
    script.onerror = () => reject(new Error("Failed to load script"));
    document.head.appendChild(script);
  });

  return scriptPromises[globalName];
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet">("auth");
  const [autoOpenFromPaymentHandled, setAutoOpenFromPaymentHandled] = useState(false);
  const joinRouteData = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        enabled: false,
        gameId: null as string | null,
        cabinetUrl: DEFAULT_CABINET_URL,
      };
    }

    const current = new URL(window.location.href);
    const joinConfig =
      (window as typeof window & {
        __PADLHUB_JOIN_CONFIG__?: { gameId?: string | null; cabinetUrl?: string | null };
      }).__PADLHUB_JOIN_CONFIG__ ?? null;
    const gameId = (
      current.searchParams.get("joinGame")
      || current.searchParams.get("gameId")
      || current.searchParams.get("id")
      || joinConfig?.gameId
      || ""
    ).trim();
    const byPath = current.pathname.replace(/\/+$/, "").endsWith(DEFAULT_INVITE_PATH);
    const enabled = byPath || Boolean(gameId);
    const cabinetUrl = (
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || joinConfig?.cabinetUrl
      || DEFAULT_CABINET_URL
    ).trim() || DEFAULT_CABINET_URL;

    return {
      enabled,
      gameId: gameId || null,
      cabinetUrl,
    };
  }, []);

  useEffect(() => {
    (window as typeof window & { __LK_ON_READY?: () => void }).__LK_ON_READY?.();
  }, []);

  const openOverlayModule = async (
    module: "games" | "tournaments" | "onboarding",
    src?: string,
    globalName?: string,
    data?: any,
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
        const mod = module === "games"
          ? await import("./components/games/GamesPage")
          : module === "tournaments"
            ? await import("./components/tournaments/TournamentsPage")
            : await import("./components/onboarding/OnboardingPage");
        const Component = mod.default;
        container.innerHTML = "";
        const currentRoot = overlayRoot as ReturnType<typeof createRoot> | null;
        if (currentRoot) currentRoot.unmount();
        overlayRoot = createRoot(container);
        overlayRoot.render(
          <Component
            onBack={() => {
              hideOverlay();
            }}
            {...(data ?? {})}
          />,
        );
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
      const widget = await loadWidget(src!, globalName!);
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
  };

  useEffect(() => {
    if (isAuthenticated) {
      setView("cabinet");
    } else {
      setView("auth");
      hideOverlay();
      setAutoOpenFromPaymentHandled(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (view !== "cabinet" || autoOpenFromPaymentHandled) return;
    if (typeof window === "undefined") return;

    const search = new URLSearchParams(window.location.search);
    const paymentRef = search.get("phPaymentRef");
    if (!paymentRef) return;

    setAutoOpenFromPaymentHandled(true);
    openOverlayModule("games", GAMES_BUNDLE_URL, "LKWidgetGames");
  }, [view, autoOpenFromPaymentHandled, openOverlayModule]);

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
      <GameJoinPage
        gameId={joinRouteData.gameId}
        cabinetUrl={joinRouteData.cabinetUrl}
      />
    );
  }

  if (view === "cabinet") {
    return (
      <Cabinet
        onOpenGames={(options) =>
          openOverlayModule(
            "games",
            GAMES_BUNDLE_URL,
            "LKWidgetGames",
            options?.gameId
              ? { openGameId: options.gameId, openChat: options.openChat === true }
              : undefined,
          )}
        onOpenTournaments={() =>
          openOverlayModule(
            "tournaments",
            TOURNAMENTS_BUNDLE_URL,
            "LKWidgetTournaments",
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
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
