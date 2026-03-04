import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import TournamentsPage from "./components/tournaments/TournamentsPage";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";

type MountOptions = { targetId?: string; onClose?: () => void };

let tournamentsRoot: ReturnType<typeof createRoot> | null = null;

installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "tournaments" });

function TournamentsContent({ onClose }: { onClose?: () => void }) {
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

  return <TournamentsPage onBack={() => onClose?.()} />;
}

function TournamentsApp({ onClose }: { onClose?: () => void }) {
  return (
    <AuthProvider>
      <TournamentsContent onClose={onClose} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "tournaments.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    tournamentsRoot?.unmount();
    tournamentsRoot = createRoot(container);
    tournamentsRoot.render(
      <StrictMode>
        <AppErrorBoundary module="tournaments">
          <TournamentsApp onClose={options.onClose} />
        </AppErrorBoundary>
      </StrictMode>,
    );
    trackAnalyticsEvent("widget_mounted", { entry: "tournaments", targetId });
  } catch (error) {
    trackClientError(
      "tournaments.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function unmount() {
  tournamentsRoot?.unmount();
  tournamentsRoot = null;
}

(window as any).LKWidgetTournaments = { mount, unmount };
