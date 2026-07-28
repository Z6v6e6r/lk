import { useEffect, useState } from "react";
import { apiFetchSubscriptioName } from "../../utils/apiClient";
import type { Subscription } from "../../utils/apiClient";
import {
  resolveSubscriptionStatusTone,
  resolveSubscriptionUsageDisplay,
} from "../../utils/subscriptionValidity";

interface SubscroptionCardProps {
  subscription: Subscription;
  phone: string;
  openSubInfo: (sub: Subscription, subName: string) => void;
}

export function SubscroptionCard({ subscription, phone, openSubInfo }: SubscroptionCardProps) {
  const [name, setName] = useState(() => subscription.name?.trim() || "Абонемент");

  useEffect(() => {
    apiFetchSubscriptioName(subscription.subscriptionId, phone).then((res) => {
      if (res.data?.sertName) setName(res.data.sertName);
    });
  }, [subscription.subscriptionId, phone]);

  const isActive = subscription.status === "ACTIVE";
  const statusLabel = isActive ? "Активен" : subscription.activationDate == null ? "Не активирован" : "Истёк";
  const displayName = name || subscription.name || "Абонемент";
  const statusTone = resolveSubscriptionStatusTone(displayName);
  const statusClassName = [
    "sub-status-badge",
    isActive ? "active" : "inactive",
    statusTone ? `sub-status-badge--${statusTone}` : "",
  ].filter(Boolean).join(" ");

  const usageDisplay = resolveSubscriptionUsageDisplay({
    subscriptionName: displayName,
    validityDate: subscription.expirationDate,
    visitsLeft: subscription.visitsLeft,
  });

  return (
    <div className="sub-card" onClick={() => openSubInfo(subscription, name)}>
      <div className="sub-card-header">
        <span className="sub-card-name">■ {name}</span>
        {usageDisplay && (
          <span className="sub-validity-badge">{usageDisplay.label}</span>
        )}
      </div>

      <span className={statusClassName}>
        {statusLabel}
      </span>
    </div>
  );
}
