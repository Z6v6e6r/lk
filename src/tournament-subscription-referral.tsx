import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import ReferralTournamentSubscriptionPage from "./components/tournament-subscription/ReferralTournamentSubscriptionPage";
import { AuthProvider } from "./context/AuthContext";
import { OverlayScopeProvider } from "./context/OverlayScopeContext";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { appendCurrentAuthModeToNavigableUrl } from "./utils/authMode";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";
import { CABINET_URL } from "./consts/api_config";
import { normalizeReferralPhone, type ReferralSubscriptionFlowType } from "./utils/referralSubscription";

type ReferralTournamentSubscriptionMountData = {
  cabinetUrl?: string | null;
  inviteId?: string | null;
  ownerPhone?: string | null;
  ownerSubscriptionId?: string | null;
  mode?: ReferralSubscriptionFlowType | null;
};

type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: ReferralTournamentSubscriptionMountData;
};

type ReferralTournamentSubscriptionWidgetModule = {
  mount: typeof mount;
  update: typeof update;
  unmount: typeof unmount;
};

let referralSubscriptionRoot: ReturnType<typeof createRoot> | null = null;

function runBootstrapTask(name: string, task: () => void) {
  try {
    task();
  } catch (error) {
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(`[tournament-subscription-referral] bootstrap task failed: ${name}`, error);
    }
  }
}

runBootstrapTask("ensureFreshRelease", () => {
  ensureFreshRelease({
    entry: "tournament-subscription-referral",
    bundleFileNames: ["tournament-subscription-referral.js", "tournament-subscription-referral-dev.js"],
  });
});
runBootstrapTask("mountDevReleaseBadge", () => {
  mountDevReleaseBadge({ bundleFileNames: ["tournament-subscription-referral.js", "tournament-subscription-referral-dev.js"] });
});
runBootstrapTask("installGlobalErrorTracking", () => {
  installGlobalErrorTracking();
});
runBootstrapTask("trackWidgetBundleLoaded", () => {
  trackAnalyticsEvent("widget_bundle_loaded", { entry: "tournament-subscription-referral" });
});

function readSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get(name)?.trim() || null;
}

function normalizeMode(value: string | null | undefined): ReferralSubscriptionFlowType {
  return String(value || "").trim().toLowerCase() === "renewal" ? "renewal" : "share";
}

function ReferralTournamentSubscriptionContent({
  data,
  onClose,
}: {
  data?: ReferralTournamentSubscriptionMountData;
  onClose?: () => void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  const fallbackCabinetUrl = (data?.cabinetUrl || CABINET_URL || "/lk_new").trim();
  const inviteId = useMemo(
    () => (data?.inviteId || readSearchParam("inviteId") || "").trim(),
    [data?.inviteId],
  );
  const ownerPhone = useMemo(
    () => normalizeReferralPhone(data?.ownerPhone || readSearchParam("ownerPhone")),
    [data?.ownerPhone],
  );
  const ownerSubscriptionId = useMemo(
    () => (data?.ownerSubscriptionId || readSearchParam("ownerSubscriptionId") || "").trim(),
    [data?.ownerSubscriptionId],
  );
  const mode = useMemo(
    () => normalizeMode(data?.mode || readSearchParam("mode")),
    [data?.mode],
  );

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!inviteId && (!ownerPhone || !ownerSubscriptionId)) {
    return (
      <div className="load-error">
        <div className="load-error-title">Не удалось открыть реферальную страницу</div>
        <div className="load-error-text">В ссылке не хватает inviteId или legacy-пары владельца подписки.</div>
      </div>
    );
  }

  return (
    <ReferralTournamentSubscriptionPage
      inviteId={inviteId || null}
      mode={mode}
      ownerPhone={ownerPhone}
      ownerSubscriptionId={ownerSubscriptionId}
      onBack={() => {
        if (onClose) {
          onClose();
          return;
        }
        if (typeof window !== "undefined" && fallbackCabinetUrl) {
          window.location.href = appendCurrentAuthModeToNavigableUrl(fallbackCabinetUrl).toString();
        }
      }}
    />
  );
}

function ReferralTournamentSubscriptionApp({ data, onClose }: { data?: ReferralTournamentSubscriptionMountData; onClose?: () => void }) {
  return (
    <AuthProvider>
      <ReferralTournamentSubscriptionContent data={data} onClose={onClose} />
    </AuthProvider>
  );
}

function render(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "tournament_subscription_referral.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  referralSubscriptionRoot?.render(
    <StrictMode>
      <OverlayScopeProvider value={isOverlayScope}>
        <AppErrorBoundary module="tournament-subscription-referral">
          <ReferralTournamentSubscriptionApp data={options.data} onClose={options.onClose} />
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
      "tournament_subscription_referral.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    referralSubscriptionRoot?.unmount();
    referralSubscriptionRoot = createRoot(container);
    render(options);
    trackAnalyticsEvent("widget_mounted", { entry: "tournament-subscription-referral", targetId });
  } catch (error) {
    trackClientError(
      "tournament_subscription_referral.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  if (!referralSubscriptionRoot) {
    mount(options);
    return;
  }
  render(options);
}

function unmount() {
  referralSubscriptionRoot?.unmount();
  referralSubscriptionRoot = null;
}

(window as Window & {
  LKWidgetTournamentSubscriptionReferral?: ReferralTournamentSubscriptionWidgetModule;
}).LKWidgetTournamentSubscriptionReferral = {
  mount,
  update,
  unmount,
};
