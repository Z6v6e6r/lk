import { useCallback, useEffect, useState } from "react";
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
}

export function BuySupscription({
  isOpen,
  onClose,
  phone,
}: BuySubscriptionProps) {
  const [subscriptions, setSubscriptions] = useState<apiSubscription[] | null>(
    null,
  );
  const [selectedSub, setSelectedSub] = useState<apiSubscription | null>(null);
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
    if (!targetSub) return;
    try {
      const response = await apiBuySubscroption(targetSub.id, phone);
      if (response.data?.paymentUrl) {
        window.location.href = response.data.paymentUrl;
      }
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Абонементы">
      {loading ? (
        <p>Загрузка абонементов...</p>
      ) : subscriptions && subscriptions.length > 0 ? (
        <>
          <div className="subBuyContainer">
            {subscriptions.map((sub) => (
              <BuySubscroptionCard
                key={sub.id}
                handleSelectSubscription={handleSelectSubscription}
                onBuy={handleBuy}
                sub={sub}
                selectedSub={selectedSub}
              />
            ))}
          </div>
        </>
      ) : (
        <p>Нет доступных абонементов для покупки.</p>
      )}
    </Modal>
  );
}
