import React from "react";
import { Modal } from "../UI/Modal";
import type {
  Subscription,
  SubscriptionAvailableStudios,
  SubscriptionAvailableTypes,
} from "../../utils/apiClient";

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

  const getExpirationInfo = () => {
    if (!sub) return null;

    if (sub.expirationDate) {
      const formattedDate = formatDate(sub.expirationDate);
      return formattedDate ? `Действует до: ${formattedDate}` : null;
    }

    if (sub.availableDays) {
      return `Осталось дней: ${sub.availableDays}`;
    }

    return null;
  };

  const getVisitsInfo = () => {
    if (!sub || sub.visitsTotal <= 0) return null;
    return `Посещений: ${sub.visitsLeft} из ${sub.visitsTotal}`;
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

          {getVisitsInfo() && (
            <div className="infoRow">
              <span className="label">Посещения:</span>
              <span
                className="visits"
                style={{
                  color: sub.visitsLeft > 0 ? "#228be6" : "#fa5252",
                }}
              >
                {getVisitsInfo()}
              </span>
            </div>
          )}

          {getExpirationInfo() && (
            <div className="infoRow">
              <span className="label">Срок действия:</span>
              <span className="expirationInfo">
                {getExpirationInfo()}
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
