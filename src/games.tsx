import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import FindGamePage from "./components/games/FindGamePage";
import GameJoinPage from "./components/games/GameJoinPage";
import GamesPage from "./components/games/GamesPage";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { PUBLIC_GAME_FIND_PATH } from "./consts/api_config";
import type { GamesMountData } from "./types/gamesOverlay";
import { ensureFreshRelease } from "./utils/releaseGuard";

type MountOptions = { targetId?: string; onClose?: () => void; data?: GamesMountData };
type GamesWidgetModule = { mount: typeof mount; update: typeof update; unmount: typeof unmount };

let gamesRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({ entry: "games", bundleFileNames: ["games.js", "games-dev.js"] });
mountDevReleaseBadge({ bundleFileNames: ["games.js", "games-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "games" });

function normalizePath(value: string) {
  return (`/${String(value || "").trim()}`).replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}

function isPublicFindRoute() {
  if (typeof window === "undefined") return false;
  const currentPath = normalizePath(window.location.pathname);
  const configuredPath = normalizePath(PUBLIC_GAME_FIND_PATH || "/finde_game");
  return currentPath.endsWith(configuredPath) || currentPath.endsWith("/find_game");
}

function GamesContent({ onClose, data }: { onClose?: () => void; data?: GamesMountData }) {
  const { isAuthenticated } = useAuth();
  const [ready, setReady] = useState(false);
  const isFindEntry = data?.publicFindEntry === true || isPublicFindRoute();

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!isAuthenticated) {
    return <AuthForm onLogin={() => {}} />;
  }

  if (data?.joinGameId) {
    return (
      <GameJoinPage
        gameId={data.joinGameId}
        cabinetUrl={data.cabinetUrl}
      />
    );
  }

  if (isFindEntry) {
    return (
      <FindGamePage
        onBack={() => onClose?.()}
        cabinetUrl={data?.cabinetUrl}
        presetStudioId={data?.presetStudioId ?? null}
        presetStudioName={data?.presetStudioName ?? null}
      />
    );
  }

  return (
    <GamesPage
      onBack={() => onClose?.()}
      openGameId={data?.openGameId ?? null}
      openChat={data?.openChat === true}
      createFromBooking={data?.createFromBooking ?? null}
      publicCreateEntry={data?.publicCreateEntry === true}
      presetStudioId={data?.presetStudioId ?? null}
      presetStudioName={data?.presetStudioName ?? null}
    />
  );
}

function GamesApp({ onClose, data }: { onClose?: () => void; data?: GamesMountData }) {
  return (
    <AuthProvider>
      <GamesContent onClose={onClose} data={data} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "games.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    gamesRoot?.unmount();
    gamesRoot = createRoot(container);
    gamesRoot.render(
      <StrictMode>
        <OverlayScopeProvider value={isOverlayScope}>
          <AppErrorBoundary module="games">
            <GamesApp onClose={options.onClose} data={options.data} />
          </AppErrorBoundary>
        </OverlayScopeProvider>
      </StrictMode>,
    );
    trackAnalyticsEvent("widget_mounted", { entry: "games", targetId });
  } catch (error) {
    trackClientError(
      "games.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  if (!gamesRoot) {
    mount(options);
    return;
  }

  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";

  gamesRoot.render(
    <StrictMode>
      <OverlayScopeProvider value={isOverlayScope}>
        <AppErrorBoundary module="games">
          <GamesApp onClose={options.onClose} data={options.data} />
        </AppErrorBoundary>
      </OverlayScopeProvider>
    </StrictMode>,
  );
}

function unmount() {
  gamesRoot?.unmount();
  gamesRoot = null;
}

(window as Window & { LKWidgetGames?: GamesWidgetModule }).LKWidgetGames = { mount, update, unmount };
