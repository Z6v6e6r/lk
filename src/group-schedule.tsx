import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import GroupSchedulePage from "./components/group-schedule/GroupSchedulePage";
import { AuthProvider } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";
import { readGroupScheduleEntryDataFromHref } from "./utils/groupScheduleEntry";

type GroupScheduleMountData = {
  exerciseId?: string | null;
  date?: string | null;
  studioId?: string | null;
  returnToFindGame?: boolean;
};
type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: GroupScheduleMountData;
};
type GroupScheduleWidgetModule = {
  mount: typeof mount;
  update: typeof update;
  unmount: typeof unmount;
};

let groupScheduleRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({
  entry: "group-schedule",
  bundleFileNames: ["group-schedule.js", "group-schedule-dev.js"],
});
mountDevReleaseBadge({ bundleFileNames: ["group-schedule.js", "group-schedule-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "group-schedule" });

function readGroupScheduleDataFromLocation(): GroupScheduleMountData {
  if (typeof window === "undefined") return {};
  return readGroupScheduleEntryDataFromHref(window.location.href);
}

function GroupScheduleContent({ data, onClose }: { data?: GroupScheduleMountData; onClose?: () => void }) {
  const [ready, setReady] = useState(false);
  const locationData = readGroupScheduleDataFromLocation();

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <GroupSchedulePage
      onBack={() => onClose?.()}
      initialExerciseId={data?.exerciseId ?? locationData.exerciseId ?? null}
      initialDate={data?.date ?? locationData.date ?? null}
      initialStudioId={data?.studioId ?? locationData.studioId ?? null}
      returnToFindGame={data?.returnToFindGame ?? locationData.returnToFindGame}
    />
  );
}

function GroupScheduleApp({ data, onClose }: { data?: GroupScheduleMountData; onClose?: () => void }) {
  return (
    <AuthProvider>
      <GroupScheduleContent data={data} onClose={onClose} />
    </AuthProvider>
  );
}

function render(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "group_schedule.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  groupScheduleRoot?.render(
    <StrictMode>
      <OverlayScopeProvider value={isOverlayScope}>
        <AppErrorBoundary module="group-schedule">
          <GroupScheduleApp data={options.data} onClose={options.onClose} />
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
      "group_schedule.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    groupScheduleRoot?.unmount();
    groupScheduleRoot = createRoot(container);
    render(options);
    trackAnalyticsEvent("widget_mounted", { entry: "group-schedule", targetId });
  } catch (error) {
    trackClientError(
      "group_schedule.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  if (!groupScheduleRoot) {
    mount(options);
    return;
  }
  render(options);
}

function unmount() {
  groupScheduleRoot?.unmount();
  groupScheduleRoot = null;
}

(window as Window & { LKWidgetGroupSchedule?: GroupScheduleWidgetModule }).LKWidgetGroupSchedule = {
  mount,
  update,
  unmount,
};
