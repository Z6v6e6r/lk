import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import PadelDaySchedulePage from "./components/padel-day/PadelDaySchedulePage";
import { AuthProvider } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import { installGlobalErrorTracking, trackAnalyticsEvent, trackClientError } from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type MountOptions = { targetId?: string; onClose?: () => void };
type PadelDayWidgetModule = { mount: typeof mount; update: typeof update; unmount: typeof unmount };

let root: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({
  entry: "padel-day-schedule",
  bundleFileNames: ["padel-day-schedule.js", "padel-day-schedule-dev.js"],
});
mountDevReleaseBadge({ bundleFileNames: ["padel-day-schedule.js", "padel-day-schedule-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "padel-day-schedule" });

function Content({ onClose }: { onClose?: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? <PadelDaySchedulePage onBack={onClose} /> : <div className="loading">Загрузка...</div>;
}

function render(options: MountOptions = {}) {
  const targetId = options.targetId || "root";
  root?.render(
    <StrictMode>
      <OverlayScopeProvider value={targetId === "lk-overlay"}>
        <AppErrorBoundary module="padel-day-schedule">
          <AuthProvider>
            <Content onClose={options.onClose} />
          </AuthProvider>
        </AppErrorBoundary>
      </OverlayScopeProvider>
    </StrictMode>,
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId || "root";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError("padel_day_schedule.mount_target_missing", new Error("Mount target not found"), { targetId }, { handled: true, severity: "error" });
    return;
  }
  try {
    root?.unmount();
    root = createRoot(container);
    render(options);
    trackAnalyticsEvent("widget_mounted", { entry: "padel-day-schedule", targetId });
  } catch (error) {
    trackClientError("padel_day_schedule.mount_failed", error, { targetId }, { handled: true, severity: "error" });
  }
}

function update(options: MountOptions = {}) {
  if (!root) mount(options);
  else render(options);
}

function unmount() {
  root?.unmount();
  root = null;
}

(window as Window & { LKWidgetPadelDaySchedule?: PadelDayWidgetModule }).LKWidgetPadelDaySchedule = {
  mount,
  update,
  unmount,
};
