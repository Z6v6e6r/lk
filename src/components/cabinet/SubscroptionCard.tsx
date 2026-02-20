import { useEffect, useState } from "react";
import { apiFetchSubscriptioName } from "../../utils/apiClient";
import type { Subscription } from "../../utils/apiClient";

interface SubscroptionCardProps {
  subscription: Subscription;
  phone: string;
  openSubInfo: (sub: Subscription, subName: string) => void;
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "";
  const d = new Date(dateString);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function SubscroptionCard({ subscription, phone, openSubInfo }: SubscroptionCardProps) {
  const [name, setName] = useState("Абонемент");

  useEffect(() => {
    apiFetchSubscriptioName(subscription.subscriptionId, phone).then((res) => {
      if (res.data?.sertName) setName(res.data.sertName);
    });
  }, [subscription.subscriptionId, phone]);

  const isActive = subscription.status === "ACTIVE";
  const statusLabel = isActive ? "Активен" : subscription.activationDate == null ? "Не активирован" : "Истёк";

  const expiryStr = subscription.expirationDate
    ? `до ${formatDate(subscription.expirationDate)}`
    : subscription.availableDays
      ? `осталось дней: ${subscription.availableDays}`
      : null;

  const visitsStr = subscription.visitsTotal > 0
    ? `${subscription.visitsLeft} из ${subscription.visitsTotal} занятий`
    : null;

  return (
    <div className="sub-card" onClick={() => openSubInfo(subscription, name)}>
      <div className="sub-card-header">
        <span className="sub-card-name">■ {name}</span>
        {visitsStr && (
          <span className="sub-visits-badge">{visitsStr}</span>
        )}
      </div>

      {expiryStr && <div className="sub-expiry">{expiryStr}</div>}

      <span className={`sub-status-badge ${isActive ? "active" : "inactive"}`}>
        {statusLabel}
      </span>
    </div>
  );
}
