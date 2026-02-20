import type { SubscriptionResponse, Subscription } from "../../utils/apiClient";
import { SubscroptionCard } from "./SubscroptionCard";

interface SubscriptionsContainerProps {
  UserSubscriptions: SubscriptionResponse | null;
  phone: string;
  openSubInfo: (sub: Subscription, subName: string) => void;
  openBuy: () => void;
}

export function SubscriptionsContainer({
  UserSubscriptions,
  phone,
  openSubInfo,
  openBuy,
}: SubscriptionsContainerProps) {
  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Абонементы</span>
      </div>

      {UserSubscriptions?.content && UserSubscriptions.content.length > 0 ? (
        UserSubscriptions.content.map((sub) => (
          <SubscroptionCard
            key={sub.subscriptionId}
            subscription={sub}
            phone={phone}
            openSubInfo={openSubInfo}
          />
        ))
      ) : (
        <div style={{ padding: "16px", fontSize: 14, color: "var(--text-secondary)" }}>
          У вас пока нет абонементов
        </div>
      )}

      <button className="buy-btn" onClick={openBuy}>
        Приобрести абонемент
      </button>
    </div>
  );
}
