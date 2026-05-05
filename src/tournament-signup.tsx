import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import TournamentSignupPage from "./components/tournament-signup/TournamentSignupPage";
import { AuthProvider } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type TournamentSignupMountData = {
  tournamentId?: string | null;
  date?: string | null;
};
type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: TournamentSignupMountData;
};
type TournamentSignupWidgetModule = {
  mount: typeof mount;
  update: typeof update;
  unmount: typeof unmount;
};

let signupRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({
  entry: "tournament-signup",
  bundleFileNames: ["tournament-signup.js", "tournament-signup-dev.js"],
});
mountDevReleaseBadge({ bundleFileNames: ["tournament-signup.js", "tournament-signup-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "tournament-signup" });

function TournamentSignupContent({ data, onClose }: { data?: TournamentSignupMountData; onClose?: () => void }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <TournamentSignupPage
      onBack={() => onClose?.()}
      initialTournamentId={data?.tournamentId ?? null}
      initialDate={data?.date ?? null}
    />
  );
}

function TournamentSignupApp({ data, onClose }: { data?: TournamentSignupMountData; onClose?: () => void }) {
  return (
    <AuthProvider>
      <TournamentSignupContent data={data} onClose={onClose} />
    </AuthProvider>
  );
}

function render(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "tournament_signup.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  signupRoot?.render(
    <StrictMode>
      <OverlayScopeProvider value={isOverlayScope}>
        <AppErrorBoundary module="tournament-signup">
          <TournamentSignupApp data={options.data} onClose={options.onClose} />
        </AppErrorBoundary>
      </OverlayScopeProvider>
    </StrictMode>,
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "tournament_signup.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    signupRoot?.unmount();
    signupRoot = createRoot(container);
    render(options);
    trackAnalyticsEvent("widget_mounted", { entry: "tournament-signup", targetId });
  } catch (error) {
    trackClientError(
      "tournament_signup.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  if (!signupRoot) {
    mount(options);
    return;
  }
  render(options);
}

function unmount() {
  signupRoot?.unmount();
  signupRoot = null;
}

(window as Window & { LKWidgetTournamentSignup?: TournamentSignupWidgetModule }).LKWidgetTournamentSignup = {
  mount,
  update,
  unmount,
};
