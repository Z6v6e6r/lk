import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import OnboardingPage from "./components/onboarding/OnboardingPage";
import type { UserProfileType } from "./utils/apiClient";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type OnboardingData = {
  profile?: UserProfileType;
  gamesLink?: string;
  trainingLink?: string;
  tournamentsLink?: string;
};

type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: OnboardingData;
};
type OnboardingWidgetModule = { mount: typeof mount; unmount: typeof unmount };

let onboardingRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({ entry: "onboarding", bundleFileNames: ["onboarding.js", "onboarding-dev.js"] });
mountDevReleaseBadge({ bundleFileNames: ["onboarding.js", "onboarding-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "onboarding" });

function OnboardingContent({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: OnboardingData;
}) {
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
    <OnboardingPage
      onBack={() => onClose?.()}
      profile={data?.profile}
      gamesLink={data?.gamesLink || "#"}
      trainingLink={data?.trainingLink || "#"}
      tournamentsLink={data?.tournamentsLink || "#"}
    />
  );
}

function OnboardingApp({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: OnboardingData;
}) {
  return (
    <AuthProvider>
      <OnboardingContent onClose={onClose} data={data} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "onboarding.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    onboardingRoot?.unmount();
    onboardingRoot = createRoot(container);
    onboardingRoot.render(
      <StrictMode>
        <OverlayScopeProvider value={isOverlayScope}>
          <AppErrorBoundary module="onboarding">
            <OnboardingApp onClose={options.onClose} data={options.data} />
          </AppErrorBoundary>
        </OverlayScopeProvider>
      </StrictMode>,
    );
    trackAnalyticsEvent("widget_mounted", { entry: "onboarding", targetId });
  } catch (error) {
    trackClientError(
      "onboarding.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function unmount() {
  onboardingRoot?.unmount();
  onboardingRoot = null;
}

(window as Window & { LKWidgetOnboarding?: OnboardingWidgetModule }).LKWidgetOnboarding = { mount, unmount };
