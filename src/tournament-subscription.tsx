import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import TournamentSubscriptionPage, {
  type TournamentSubscriptionPageConfig,
} from "./components/tournament-subscription/TournamentSubscriptionPage";
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
import { readAbLetoTrainerQrCode } from "./utils/abLetoTrainerQr";

type TournamentSubscriptionMountData = {
  artworkKey?: TournamentSubscriptionPageConfig["artworkKey"];
  autoPurchase?: boolean | null;
  cabinetUrl?: string | null;
  variant?: TournamentSubscriptionPageConfig["variant"];
  campaignKey?: string | null;
  offerKey?: string | null;
  planKey?: TournamentSubscriptionPageConfig["planKey"];
  priceLabel?: string | null;
  totalLimit?: number | null;
  trainerQrCode?: string | null;
};

type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: TournamentSubscriptionMountData;
};

type TournamentSubscriptionWidgetModule = {
  mount: typeof mount;
  update: typeof update;
  unmount: typeof unmount;
};

let subscriptionRoot: ReturnType<typeof createRoot> | null = null;
let subscriptionPageOpenTracked = false;

ensureFreshRelease({
  entry: "tournament-subscription",
  bundleFileNames: ["tournament-subscription.js", "tournament-subscription-dev.js"],
});
mountDevReleaseBadge({ bundleFileNames: ["tournament-subscription.js", "tournament-subscription-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bundle_loaded", { entry: "tournament-subscription" });

function readPromoLinkConfig(): Pick<TournamentSubscriptionPageConfig, "autoPurchase" | "offerKey" | "trainerQrCode"> {
  if (typeof window === "undefined") {
    return { autoPurchase: false, offerKey: null, trainerQrCode: null };
  }

  const url = new URL(window.location.href);
  const offerKey = String(url.searchParams.get("offer") || url.searchParams.get("offerKey") || "").trim() || null;
  const autoPurchaseRaw = String(url.searchParams.get("autoPurchase") || "").trim().toLowerCase();
  const autoPurchase = autoPurchaseRaw
    ? autoPurchaseRaw !== "0" && autoPurchaseRaw !== "false" && autoPurchaseRaw !== "no" && autoPurchaseRaw !== "off"
    : Boolean(offerKey);

  return { autoPurchase, offerKey, trainerQrCode: readAbLetoTrainerQrCode(url.search) };
}

function TournamentSubscriptionContent({ data, onClose }: { data?: TournamentSubscriptionMountData; onClose?: () => void }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  const fallbackCabinetUrl = (data?.cabinetUrl || CABINET_URL || "/lk_new").trim();
  const promoLinkConfig = readPromoLinkConfig();
  const pageConfig: TournamentSubscriptionPageConfig | undefined = data || promoLinkConfig.offerKey || promoLinkConfig.trainerQrCode
      ? {
        artworkKey: data?.artworkKey ?? undefined,
        autoPurchase: data?.autoPurchase ?? promoLinkConfig.autoPurchase,
        variant: data?.variant ?? undefined,
        campaignKey: data?.campaignKey ?? undefined,
        offerKey: data?.offerKey ?? promoLinkConfig.offerKey,
        planKey: data?.planKey ?? undefined,
        priceLabel: data?.priceLabel ?? undefined,
        totalLimit: data?.totalLimit ?? undefined,
        trainerQrCode: data?.trainerQrCode ?? promoLinkConfig.trainerQrCode,
      }
    : undefined;

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  return (
    <TournamentSubscriptionPage
      pageConfig={pageConfig}
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

function TournamentSubscriptionApp({ data, onClose }: { data?: TournamentSubscriptionMountData; onClose?: () => void }) {
  return (
    <AuthProvider>
      <TournamentSubscriptionContent data={data} onClose={onClose} />
    </AuthProvider>
  );
}

function render(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const isOverlayScope = targetId === "lk-overlay";
  const container = document.getElementById(targetId);
  if (!container) {
    trackClientError(
      "tournament_subscription.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  subscriptionRoot?.render(
    <StrictMode>
      <OverlayScopeProvider value={isOverlayScope}>
        <AppErrorBoundary module="tournament-subscription">
          <TournamentSubscriptionApp data={options.data} onClose={options.onClose} />
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
      "tournament_subscription.mount_target_missing",
      new Error("Mount target not found"),
      { targetId },
      { handled: true, severity: "error" },
    );
    return;
  }

  try {
    subscriptionRoot?.unmount();
    subscriptionRoot = createRoot(container);
    render(options);
    trackAnalyticsEvent("widget_mounted", { entry: "tournament-subscription", targetId });
    if (!subscriptionPageOpenTracked) {
      subscriptionPageOpenTracked = true;
      trackAnalyticsEvent("subscription_page_opened", {
        entry: "tournament-subscription",
        storefront: options.data?.variant === "piter_friendship" ? "piter_friendship" : "ab_leto",
        targetId,
        trainerQrCode: readAbLetoTrainerQrCode(),
      });
    }
  } catch (error) {
    trackClientError(
      "tournament_subscription.mount_failed",
      error,
      { targetId },
      { handled: true, severity: "error" },
    );
  }
}

function update(options: MountOptions = {}) {
  if (!subscriptionRoot) {
    mount(options);
    return;
  }
  render(options);
}

function unmount() {
  subscriptionRoot?.unmount();
  subscriptionRoot = null;
}

(window as Window & { LKWidgetTournamentSubscription?: TournamentSubscriptionWidgetModule }).LKWidgetTournamentSubscription = {
  mount,
  update,
  unmount,
};
