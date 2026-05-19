import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { AuthForm } from "./components/auth/AuthForm";
import LevelsInfoPage from "./components/levels-info/LevelsInfoPage";
import type { LevelsInfoMountData } from "./types/levelsInfoOverlay";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: LevelsInfoMountData;
};

type LevelsInfoWidgetModule = {
  mount: typeof mount;
  unmount: typeof unmount;
};

let levelsInfoRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({ entry: "levels-info", bundleFileNames: ["levels-info.js", "levels-info-dev.js"] });
mountDevReleaseBadge({ bundleFileNames: ["levels-info.js", "levels-info-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "levels-info" });

function LevelsInfoContent({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: LevelsInfoMountData;
}) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <AuthForm onLogin={() => {}} />;
  }

  return (
    <LevelsInfoPage
      onBack={() => onClose?.()}
      profile={data?.profile}
    />
  );
}

function LevelsInfoApp({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: LevelsInfoMountData;
}) {
  return (
    <AuthProvider>
      <LevelsInfoContent onClose={onClose} data={data} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "levels_info.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    levelsInfoRoot?.unmount();
    levelsInfoRoot = createRoot(container);
    levelsInfoRoot.render(
      <StrictMode>
        <OverlayScopeProvider value={isOverlayScope}>
          <AppErrorBoundary module="levels-info">
            <LevelsInfoApp onClose={options.onClose} data={options.data} />
          </AppErrorBoundary>
        </OverlayScopeProvider>
      </StrictMode>,
    );
    trackAnalyticsEvent("widget_mounted", { entry: "levels-info", targetId });
  } catch (error) {
    trackClientError(
      "levels_info.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function unmount() {
  levelsInfoRoot?.unmount();
  levelsInfoRoot = null;
}

(window as Window & { LKWidgetLevelsInfo?: LevelsInfoWidgetModule }).LKWidgetLevelsInfo = { mount, unmount };
