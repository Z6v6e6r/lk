import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import GamesPage from "./components/games/GamesPage";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";

type GamesMountData = {
  openGameId?: string | null;
  openChat?: boolean;
};

type MountOptions = { targetId?: string; onClose?: () => void; data?: GamesMountData };

let gamesRoot: ReturnType<typeof createRoot> | null = null;

installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "games" });

function GamesContent({ onClose, data }: { onClose?: () => void; data?: GamesMountData }) {
  const { isAuthenticated } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!isAuthenticated) {
    return <AuthForm onLogin={() => {}} />;
  }

  return (
    <GamesPage
      onBack={() => onClose?.()}
      openGameId={data?.openGameId ?? null}
      openChat={data?.openChat === true}
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
        <AppErrorBoundary module="games">
          <GamesApp onClose={options.onClose} data={options.data} />
        </AppErrorBoundary>
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

function unmount() {
  gamesRoot?.unmount();
  gamesRoot = null;
}

(window as any).LKWidgetGames = { mount, unmount };
