import React from "react";
import { Modal } from "../UI/Modal";
import type {
  Subscription,
  SubscriptionAvailableStudios,
  SubscriptionAvailableTypes,
} from "../../utils/apiClient";
import { resolveSubscriptionUsageDisplay } from "../../utils/subscriptionValidity";

interface SubscriptionInformationProps {
  isOpen: boolean;
  onClose: () => void;
  sub: Subscription | null;
  subName: string;
}

export const SubscriptionInformation: React.FC<
  SubscriptionInformationProps
> = ({ isOpen, onClose, sub, subName }) => {
  const formatDate = (dateString: string | null): string | null => {
    if (!dateString) return null;
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return null;
    }
  };

  const getUsageInfo = () => {
    if (!sub) return null;
    return resolveSubscriptionUsageDisplay({
      subscriptionName: subName || sub.name,
      validityDate: sub.expirationDate,
      visitsLeft: sub.visitsLeft,
    });
  };

  if (!sub) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={subName}>
        <div className="errorMessage">Информация об абонементе недоступна</div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={subName}>
      <div className="modalContent">
        <div className="infoCard">
          <div className="infoRow">
            <span className="label">Статус:</span>
            <span
              style={{
                color: sub.status === "ACTIVE" ? "#28a745" : "#dc3545",
              }}
              className="status"
            >
              {sub.status === "ACTIVE" ? "Активен" : sub.activationDate == null ? "Не активирован" : "Истек"}
            </span>
          </div>

          {getUsageInfo() && (
            <div className="infoRow">
              <span className="label">
                {getUsageInfo()?.kind === "visits" ? "Осталось:" : "Срок действия:"}
              </span>
              <span className="expirationInfo">
                {getUsageInfo()?.label}
              </span>
            </div>
          )}
        </div>

        <div className="datesGrid">
          <div className="dateCard">
            <div className="dateLabel">Дата покупки</div>
            <div className="dateValue">
              {formatDate(sub.purchaseDate) || "—"}
            </div>
          </div>

          <div className="dateCard">
            <div className='dateLabel'>Дата активации</div>
            <div className="dateValue">
              {formatDate(sub.activationDate) || "Не активирован"}
            </div>
          </div>
        </div>

        {sub.hasStudioLimitation && sub.availableStudios?.length > 0 && (
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

        {sub.hasTypeLimitation && sub.availableTypes?.length > 0 && (
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
      </div>
    </Modal>
  );
};
