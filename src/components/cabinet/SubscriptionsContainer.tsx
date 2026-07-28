import type { SubscriptionResponse, Subscription } from "../../utils/apiClient";
import { SubscroptionCard } from "./SubscroptionCard";

interface SubscriptionsContainerProps {
  UserSubscriptions: SubscriptionResponse | null;
  phone: string;
  openSubInfo: (sub: Subscription, subName: string) => void;
}

const SUMMER_SUBSCRIPTION_URL = "https://padlhub.ru/ab_leto";

export function SubscriptionsContainer({
  UserSubscriptions,
  phone,
  openSubInfo,
}: SubscriptionsContainerProps) {
  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Абонементы и подписки</span>
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

      <a className="buy-btn" href={SUMMER_SUBSCRIPTION_URL}>
        Абонементы и подписки
      </a>
    </div>
  );
}
