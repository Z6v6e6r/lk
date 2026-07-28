import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import { CommunitiesSection } from "./components/cabinet/CommunitiesSection";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import type { CommunitiesMountData } from "./types/communitiesWidget";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

type MountOptions = { targetId?: string; onClose?: () => void; data?: CommunitiesMountData };
type CommunitiesWidgetModule = { mount: typeof mount; update: typeof update; unmount: typeof unmount };

let communitiesRoot: ReturnType<typeof createRoot> | null = null;

ensureFreshRelease({ entry: "communities", bundleFileNames: ["communities.js", "communities-dev.js"] });
mountDevReleaseBadge({ bundleFileNames: ["communities.js", "communities-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "communities" });

function CommunitiesApp({ data }: { data?: CommunitiesMountData }) {
  if (!data) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <CommunitiesSection
      profile={data.profile}
      createdGames={data.createdGames}
      activeBookingExerciseIds={data.activeBookingExerciseIds}
      onOpenGames={data.onOpenGames}
      onOpenTournaments={data.onOpenTournaments}
      onOpenLevelsInfo={data.onOpenLevelsInfo}
      onOpenHome={data.onOpenHome}
      onOpenProfile={data.onOpenProfile}
      initialInviteCode={data.initialInviteCode}
      initialInviteLink={data.initialInviteLink}
      inviteEntryCabinetUrl={data.inviteEntryCabinetUrl}
    />
  );
}

function renderIntoRoot(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "communities.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  if (!communitiesRoot) {
    communitiesRoot = createRoot(container);
  }

  communitiesRoot.render(
    <StrictMode>
      <AppErrorBoundary module="communities">
        <CommunitiesApp data={options.data} />
      </AppErrorBoundary>
    </StrictMode>,
  );
}

function mount(options: MountOptions = {}) {
  try {
    renderIntoRoot(options);
    trackAnalyticsEvent("widget_mounted", {
      entry: "communities",
      targetId: options.targetId ?? "root",
    });
  } catch (error) {
    trackClientError(
      "communities.mount_failed",
      error,
      { targetId: options.targetId ?? "root" },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  try {
    renderIntoRoot(options);
  } catch (error) {
    trackClientError(
      "communities.update_failed",
      error,
      { targetId: options.targetId ?? "root" },
      { handled: true, severity: "error" },
    );
  }
}

function unmount() {
  communitiesRoot?.unmount();
  communitiesRoot = null;
}

(window as Window & { LKWidgetCommunities?: CommunitiesWidgetModule }).LKWidgetCommunities = {
  mount,
  update,
  unmount,
};
