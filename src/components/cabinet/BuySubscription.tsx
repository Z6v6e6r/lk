import { useCallback, useEffect, useState, useRef } from "react";
import { Modal } from "../UI/Modal";
import {
  apiBuySubscroption,
  apiGetSubscriptionsForSale,
} from "../../utils/apiClient";
import type { apiSubscription } from "../../utils/apiClient";
import { BuySubscroptionCard } from "./BuySubscroptionCard";

interface BuySubscriptionProps {
  isOpen: boolean;
  onClose: () => void;
  phone: string;
  subscriptionId?: string;
}

export function BuySupscription({
  isOpen,
  onClose,
  phone,
  subscriptionId,
}: BuySubscriptionProps) {
  const [subscriptions, setSubscriptions] = useState<apiSubscription[] | null>(
    null,
  );
  const [selectedSub, setSelectedSub] = useState<apiSubscription | null>(null);
  const purchaseInFlight = useRef(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [loading, setLoading] = useState<boolean>(false);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiGetSubscriptionsForSale();
      if (response.data) {
        setSubscriptions(response.data);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && !subscriptions) {
      void fetchSubscriptions();
    }
  }, [fetchSubscriptions, isOpen, subscriptions]);

  const handleSelectSubscription = (sub: apiSubscription) => {
    setSelectedSub(sub);
  };

  const handleBuy = async (sub?: apiSubscription) => {
    const targetSub = sub ?? selectedSub;
    if (!targetSub || purchaseInFlight.current) return;
    if (subscriptionId && (targetSub.id !== subscriptionId || !subscriptions?.some(item => item.id === subscriptionId))) return;
    purchaseInFlight.current = true; setBuying(true); setPurchaseError(null);
    try {
      const response = await apiBuySubscroption(targetSub.id, phone, subscriptionId ? { retries: 0 } : {});
      if (response.data?.paymentUrl) {
        const url = new URL(response.data.paymentUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Некорректная ссылка на оплату');
        window.location.assign(url.href);
        return;
      }
      throw new Error(response.error?.message || 'Оплата не подтверждена. Проверьте её состояние перед повторной покупкой.');
    } catch (error) {
      setPurchaseError(error instanceof Error ? error.message : 'Не удалось начать оплату');
    } finally {
      purchaseInFlight.current = false; setBuying(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Абонементы">
      {purchaseError && <p role="alert">{purchaseError}</p>}
      {loading ? (
        <p>Загрузка абонементов...</p>
      ) : subscriptions && subscriptions.length > 0 ? (
        <>
          <fieldset disabled={buying} style={{ border: 0, padding: 0 }}>
          <div className="subBuyContainer">
            {subscriptions.filter(sub => !subscriptionId || sub.id === subscriptionId).map((sub) => (
              <BuySubscroptionCard
                key={sub.id}
                handleSelectSubscription={handleSelectSubscription}
                onBuy={handleBuy}
                sub={sub}
                selectedSub={selectedSub}
              />
            ))}
          </div>
          {subscriptionId && !subscriptions.some(sub => sub.id === subscriptionId) && <p>Подписка сейчас недоступна для покупки.</p>}
          </fieldset>
        </>
      ) : (
        <p>Нет доступных абонементов для покупки.</p>
      )}
    </Modal>
  );
}
