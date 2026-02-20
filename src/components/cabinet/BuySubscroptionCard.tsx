import { useState } from "react";
import type { apiSubscription, SubscriptionAvailableStudios, SubscriptionAvailableTypes } from "../../utils/apiClient";

interface BuySubscroptionCardProps {
  handleSelectSubscription: (sub: apiSubscription) => void;
  onBuy: (sub: apiSubscription) => void;
  sub: apiSubscription;
  selectedSub: apiSubscription | null;
}

export function BuySubscroptionCard({
  sub,
  selectedSub,
  handleSelectSubscription,
  onBuy,
}: BuySubscroptionCardProps) {
  const [imageLoaded, setImageLoaded] = useState(true);

  const handleImageError = () => {
    setImageLoaded(false);
  };
  return (
    <div
      className="subBuyIMgContainer"
      onClick={() => handleSelectSubscription(sub)}
      style={{
        borderColor: selectedSub?.id === sub.id ? "#7270ff" : "#e9ecef",
      }}
    >
      {sub.imgUrl && imageLoaded ? (
        <>
          <img
            src={sub.imgUrl}
            alt={sub.name}
            className="subImg"
            onError={handleImageError}
          />
          <button
            className="sub-buy-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleSelectSubscription(sub);
              onBuy(sub);
            }}
          >
            Приобрести за {sub.cost / 100} ₽
          </button>
        </>
      ) : (
        <div className="subBuyCard">
          <h3 className="subscription-h3">{sub.name}</h3>
          <p className="label">
            {sub.visits} посещений на {sub.validityDays} дней за{" "}
            {sub.cost / 100} ₽
          </p>

          {sub.hasStudioLimitation && sub.availableStudios.length > 0 && (
            <div>
              <h4 className="sectionTitle">
                Доступные станции ({sub.availableStudios.length})
              </h4>
              <div className="chipsContainer">
                {sub.availableStudios.map(
                  (studio: SubscriptionAvailableStudios) => (
                    <span key={studio.id} className="chip">
                      {studio.name}
                    </span>
                  ),
                )}
              </div>
            </div>
          )}

          {sub.hasTypeLimitation && sub.availableTypes.length > 0 && (
            <div>
              <h4 className="sectionTitle">
                Доступные услуги ({sub.availableTypes.length})
              </h4>
              <div className="chipsContainer">
                {sub.availableTypes.map((type: SubscriptionAvailableTypes) => (
                  <span key={type.id} className="chip">
                    {type.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            className="sub-buy-btn sub-buy-btn--static"
            onClick={(e) => {
              e.stopPropagation();
              handleSelectSubscription(sub);
              onBuy(sub);
            }}
          >
            Приобрести за {sub.cost / 100} ₽
          </button>
        </div>
      )}
    </div>
  );
}
