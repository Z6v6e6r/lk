import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import CompositeGameCreatePage from "./components/games/composite/CompositeGameCreatePage";
import FindGamePage from "./components/games/FindGamePage";
import GamesPage, {
  type SelfLeavePreviewOptions,
  type SelfLeaveRequest,
} from "./components/games/GamesPage";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { appendCurrentAuthModeToNavigableUrl } from "./utils/authMode";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { CABINET_URL, PUBLIC_GAME_FIND_PATH } from "./consts/api_config";
import type { GamesMountData } from "./types/gamesOverlay";
import { ensureFreshRelease } from "./utils/releaseGuard";
import type { PadelGameRecord } from "./utils/apiClient";

type MountOptions = { targetId?: string; onClose?: () => void; data?: GamesMountData };
type GamesWidgetModule = { mount: typeof mount; update: typeof update; unmount: typeof unmount };

let gamesRoot: ReturnType<typeof createRoot> | null = null;

const SELF_LEAVE_PREVIEW_GAME_ID = "dev-self-leave-preview";
const SELF_LEAVE_PREVIEW_PLAYER_ID = "dev-self-leave-current-player";

function buildSelfLeavePreviewGame(): PadelGameRecord {
  const previewDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    id: SELF_LEAVE_PREVIEW_GAME_ID,
    inviteUrl: null,
    status: "PAID",
    organizer: {
      id: "dev-self-leave-organizer",
      name: "Тестовый организатор",
      phone: null,
      photo: null,
      rating: "D+",
    },
    settings: {
      ratingGame: true,
      minRating: "D",
      maxRating: "C+",
      isPrivate: false,
      payMode: "self",
    },
    participants: [
      {
        id: SELF_LEAVE_PREVIEW_PLAYER_ID,
        name: "Тестовый участник",
        phone: null,
        photo: null,
        rating: "D+",
        source: "INVITE_LINK",
        status: "CONFIRMED",
      },
    ],
    waitlist: [],
    invite: {
      waitlistEnabled: true,
      maxPlayers: 4,
    },
    chatUrl: null,
    metadata: {
      source: "cabinet_booking_synthetic",
      synthetic: true,
      organizerInMatch: true,
      gameTitle: "Безопасная проверка выхода",
    },
    booking: {
      studioName: "Терехово",
      roomName: "Корт №3",
      date: previewDate,
      timeFrom: "11:00",
      timeTo: "12:00",
      durationMinutes: 60,
    },
    payment: {
      amount: 2000,
      paymentUrl: null,
      paid: true,
    },
  };
}

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
  const { isAuthenticated, isRestoringSession } = useAuth();
  const [ready, setReady] = useState(false);
  const isFindEntry = data?.publicFindEntry === true || isPublicFindRoute();
  const includeGamePlusTrainer = isFindEntry && data?.includeGamePlusTrainer !== false;
  const isCompositeCreateEntry = data?.compositeCreateEntry === true;
  const selfLeavePreviewMode = typeof window !== "undefined"
    && ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)
    && new URL(window.location.href).searchParams.get("leavePreview") === "1";
  const selfLeavePreviewAttemptRef = useRef(0);
  const requestedOpenGameId = (data?.openGameId || data?.joinGameId || "").trim() || null;
  const openGameId = selfLeavePreviewMode ? SELF_LEAVE_PREVIEW_GAME_ID : requestedOpenGameId;
  const selfLeavePreviewGame = useMemo(
    () => (selfLeavePreviewMode ? buildSelfLeavePreviewGame() : null),
    [selfLeavePreviewMode],
  );
  const selfLeavePreviewRequest = useCallback<SelfLeaveRequest>(async (gameId) => {
    if (!selfLeavePreviewMode || gameId !== SELF_LEAVE_PREVIEW_GAME_ID) {
      return {
        data: null,
        error: {
          status: 400,
          message: "Локальный preview выхода не активен",
        },
        status: 400,
      };
    }

    selfLeavePreviewAttemptRef.current += 1;
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    if (selfLeavePreviewAttemptRef.current < 3) {
      return {
        data: {
          ok: false,
          state: "IN_PROGRESS",
          operationId: "dev-self-leave-operation",
          gameId,
          message: "Viva ещё подтверждает отмену. Место пока остаётся занятым.",
        },
        error: null,
        status: 202,
      };
    }

    return {
      data: {
        ok: true,
        state: "DONE",
        operationId: "dev-self-leave-operation",
        gameId,
        message: "Проверка завершена: Viva подтверждена, место и дневной лимит освобождены.",
      },
      error: null,
      status: 200,
    };
  }, [selfLeavePreviewMode]);
  const selfLeavePreview = useMemo<SelfLeavePreviewOptions | null>(() => (
    selfLeavePreviewMode
      ? {
          playerId: SELF_LEAVE_PREVIEW_PLAYER_ID,
          request: selfLeavePreviewRequest,
        }
      : null
  ), [selfLeavePreviewMode, selfLeavePreviewRequest]);
  const handleBack = () => {
    if (onClose) {
      onClose();
      return;
    }
    const fallbackUrl = String(data?.cabinetUrl || CABINET_URL || "/lk_new").trim();
    if (typeof window !== "undefined" && fallbackUrl) {
      window.location.href = appendCurrentAuthModeToNavigableUrl(fallbackUrl).toString();
    }
  };

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  if (isFindEntry) {
    return (
      <FindGamePage
        onBack={handleBack}
        cabinetUrl={data?.cabinetUrl}
        presetStudioId={data?.presetStudioId ?? null}
        presetStudioName={data?.presetStudioName ?? null}
        includeGamePlusTrainer={includeGamePlusTrainer}
      />
    );
  }

  if (isRestoringSession) {
    return <div className="loading">Проверяем сессию...</div>;
  }

  if (!isAuthenticated) {
    return <AuthForm onLogin={() => {}} />;
  }

  if (isCompositeCreateEntry) {
    return (
      <CompositeGameCreatePage
        onBack={handleBack}
        cabinetUrl={data?.cabinetUrl}
        presetStudioId={data?.presetStudioId ?? null}
        presetStudioName={data?.presetStudioName ?? null}
      />
    );
  }

  return (
    <>
      {selfLeavePreviewMode && (
        <div className="self-leave-preview-banner" role="status">
          Локальная проверка · запросы выхода не отправляются в Viva
        </div>
      )}
      <GamesPage
        onBack={handleBack}
        openGameId={openGameId}
        openChat={data?.openChat === true}
        createFromBooking={data?.createFromBooking ?? null}
        initialGameRecord={selfLeavePreviewGame ?? data?.initialGameRecord ?? null}
        publicCreateEntry={data?.publicCreateEntry === true}
        presetStudioId={data?.presetStudioId ?? null}
        presetStudioName={data?.presetStudioName ?? null}
        selfLeavePreview={selfLeavePreview}
      />
    </>
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
