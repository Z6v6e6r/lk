import { useEffect, useState } from "react";
import type { SubscriptionResponse } from "../utils/apiClient";
import { trackAnalyticsEvent } from "../utils/analytics";
import { RESIDENCY_PASS_ENABLED } from "./residencyConfig.ts";
import { consumeResidencyEntryContext, clearPersistedResidencyEntryContext } from "./residencyStationContext.ts";
import { ResidencyPassPanel } from "./ResidencyPassPanel.tsx";

interface ResidencySectionProps {
  subscriptions: SubscriptionResponse | null;
}

/**
 * Cabinet entry point for the resident pass.
 *
 * Opened from the profile/subscriptions area ("Показать QR") or automatically after a station
 * QR login (residency=1 with stationId): the station context is persisted before login and
 * consumed once the authenticated cabinet mounts.
 */
export function ResidencySection({ subscriptions }: ResidencySectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [stationId, setStationId] = useState<string | null>(null);

  useEffect(() => {
    if (!RESIDENCY_PASS_ENABLED) return;
    if (typeof window === "undefined") return;
    const { entry, consumed } = consumeResidencyEntryContext(window.location.search);
    if (!consumed || !entry.requested) return;
    setStationId(entry.stationId);
    setIsOpen(true);
    clearPersistedResidencyEntryContext();
    trackAnalyticsEvent("residency_pass_entry", {
      source: "station_link",
      hasStationId: Boolean(entry.stationId),
    });
  }, []);

  if (!RESIDENCY_PASS_ENABLED) return null;

  const openPanel = () => {
    trackAnalyticsEvent("residency_pass_entry", { source: "cabinet_button" });
    setIsOpen(true);
  };

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Резидентство</span>
      </div>
      <div className="section-body">
        <p className="section-text">
          Пропуск резидента — это одноразовый QR для получения услуг на станции. Он действует
          меньше двух минут, поэтому код всегда создаётся заново.
        </p>
        <button type="button" className="section-cta" onClick={openPanel}>
          Показать QR
        </button>
      </div>
      <ResidencyPassPanel
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        subscriptions={subscriptions}
        stationId={stationId}
      />
    </div>
  );
}
