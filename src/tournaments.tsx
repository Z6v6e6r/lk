import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import TournamentsPage from "./components/tournaments/TournamentsPage";
import type { TournamentsMountData } from "./types/tournamentsOverlay";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type MountOptions = { targetId?: string; onClose?: () => void; data?: TournamentsMountData };
type TournamentsWidgetModule = { mount: typeof mount; unmount: typeof unmount };

let tournamentsRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({ entry: "tournaments", bundleFileNames: ["tournaments.js", "tournaments-dev.js"] });
mountDevReleaseBadge({ bundleFileNames: ["tournaments.js", "tournaments-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "tournaments" });

function firstNonEmpty(...values: Array<string | null | undefined>) {
  return values.map((value) => String(value || "").trim()).find(Boolean) ?? null;
}

function readTournamentsDataFromLocation(): TournamentsMountData {
  if (typeof window === "undefined") return {};

  const params = new URLSearchParams(window.location.search);
  return {
    tournamentId: firstNonEmpty(
      params.get("tournamentId"),
      params.get("id"),
      params.get("exerciseId"),
    ),
    tournamentSlug: firstNonEmpty(
      params.get("slug"),
      params.get("tournamentSlug"),
    ),
    date: firstNonEmpty(params.get("date")),
  };
}

function TournamentsContent({ data, onClose }: { data?: TournamentsMountData; onClose?: () => void }) {
  const { isAuthenticated } = useAuth();
  const [ready, setReady] = useState(false);
  const locationData = readTournamentsDataFromLocation();

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
    <TournamentsPage
      onBack={() => onClose?.()}
      initialOpenTournamentId={data?.tournamentId ?? locationData.tournamentId ?? null}
      initialOpenTournamentSlug={data?.tournamentSlug ?? locationData.tournamentSlug ?? null}
      initialOpenDate={data?.date ?? locationData.date ?? null}
    />
  );
}

function TournamentsApp({ data, onClose }: { data?: TournamentsMountData; onClose?: () => void }) {
  return (
    <AuthProvider>
      <TournamentsContent data={data} onClose={onClose} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
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
        <OverlayScopeProvider value={isOverlayScope}>
          <AppErrorBoundary module="tournaments">
            <TournamentsApp data={options.data} onClose={options.onClose} />
          </AppErrorBoundary>
        </OverlayScopeProvider>
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

(window as Window & { LKWidgetTournaments?: TournamentsWidgetModule }).LKWidgetTournaments = { mount, unmount };
