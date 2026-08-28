import { useState } from "react";
import { Modal } from "../UI/Modal";
import type {
  A3PayDevVivaBookingResponse,
  A3PayDevVivaBookingResult,
} from "./a3PayDevVivaBookingApi";
import {
  clearA3PayDevVivaOperationId,
  getOrCreateA3PayDevVivaOperationId,
} from "./a3PayDevVivaBookingApi";

interface A3PayGameCreateDemoProps {
  amountLabel: string;
  canCreateBooking: boolean;
  onCancelBooking: (operationId: string) => Promise<A3PayDevVivaBookingResult>;
  onCreateBooking: (operationId: string) => Promise<A3PayDevVivaBookingResult>;
  onGetBookingStatus: (operationId: string) => Promise<A3PayDevVivaBookingResult>;
  selectionKey: string;
  stationCourt: string;
  timeRange: string;
}

const A3_PAY_GAME_CREATE_DEMO_STYLES = `
  .a3pay-game-create-demo-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    min-height: 56px;
    padding: 12px 16px;
    border: 0;
    border-radius: 12px;
    background: linear-gradient(135deg, #8ae24e, #53be6c);
    box-shadow: 0 12px 20px rgba(25, 58, 18, 0.28);
    color: #10200f;
    cursor: pointer;
    text-align: left;
    transition: transform 140ms ease, box-shadow 140ms ease;
  }

  .a3pay-game-create-demo-button:active {
    transform: translateY(1px);
    box-shadow: 0 8px 14px rgba(25, 58, 18, 0.24);
  }

  .a3pay-game-create-demo-button:focus-visible,
  .a3pay-game-create-demo-close:focus-visible {
    outline: 3px solid rgba(83, 190, 108, 0.42);
    outline-offset: 3px;
  }

  .a3pay-game-create-demo-button-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .a3pay-game-create-demo-button-copy strong {
    font-size: 15px;
    font-weight: 800;
    line-height: 1.25;
  }

  .a3pay-game-create-demo-button-arrow {
    display: grid;
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    place-items: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.55);
    font-size: 20px;
    line-height: 1;
  }

  .a3pay-game-create-demo-modal {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .a3pay-game-create-demo-card {
    overflow: hidden;
    border: 1px solid rgba(83, 190, 108, 0.25);
    border-radius: 18px;
    background: linear-gradient(155deg, #f6fff0 0%, #e8fbdc 100%);
    box-shadow: 0 16px 32px rgba(25, 58, 18, 0.12);
  }

  .a3pay-game-create-demo-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid rgba(83, 190, 108, 0.2);
  }

  .a3pay-game-create-demo-brand {
    font-size: 18px;
    font-weight: 900;
    letter-spacing: -0.02em;
  }

  .a3pay-game-create-demo-badge {
    padding: 5px 8px;
    border-radius: 999px;
    background: #10200f;
    color: #fff;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }

  .a3pay-game-create-demo-card-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 16px;
  }

  .a3pay-game-create-demo-caption {
    color: #52604f;
    font-size: 12px;
    line-height: 1.35;
  }

  .a3pay-game-create-demo-amount {
    color: #10200f;
    font-size: 30px;
    font-weight: 900;
    line-height: 1;
  }

  .a3pay-game-create-demo-details {
    display: grid;
    gap: 8px;
    margin: 0;
  }

  .a3pay-game-create-demo-details div {
    display: grid;
    grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
    gap: 12px;
  }

  .a3pay-game-create-demo-details dt,
  .a3pay-game-create-demo-details dd {
    margin: 0;
    font-size: 13px;
    line-height: 1.4;
  }

  .a3pay-game-create-demo-details dt {
    color: #687765;
  }

  .a3pay-game-create-demo-details dd {
    color: #243123;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .a3pay-game-create-demo-safety {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border: 1px solid #e4e7eb;
    border-radius: 12px;
    background: #f7f8fa;
    color: #344054;
  }

  .a3pay-game-create-demo-safety strong {
    font-size: 13px;
    line-height: 1.35;
  }

  .a3pay-game-create-demo-safety span {
    font-size: 12px;
    line-height: 1.45;
  }

  .a3pay-game-create-demo-close {
    width: 100%;
    min-height: 48px;
    border: 0;
    border-radius: 12px;
    background: #10200f;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
    font-weight: 800;
  }

  .a3pay-game-create-demo-actions {
    display: grid;
    gap: 10px;
  }

  .a3pay-game-create-demo-create,
  .a3pay-game-create-demo-cancel-booking {
    width: 100%;
    min-height: 48px;
    border-radius: 12px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 800;
  }

  .a3pay-game-create-demo-create {
    border: 0;
    background: #53be6c;
    color: #10200f;
  }

  .a3pay-game-create-demo-cancel-booking {
    border: 1px solid #d92d20;
    background: #fff;
    color: #b42318;
  }

  .a3pay-game-create-demo-create:disabled,
  .a3pay-game-create-demo-cancel-booking:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .a3pay-game-create-demo-result {
    padding: 12px;
    border-radius: 12px;
    background: #f2f4f7;
    color: #344054;
    font-size: 12px;
    line-height: 1.45;
  }

  .a3pay-game-create-demo-result.error {
    background: #fef3f2;
    color: #b42318;
  }

  @media (prefers-reduced-motion: reduce) {
    .a3pay-game-create-demo-button {
      transition: none;
    }
  }
`;

export function A3PayGameCreateDemo({
  amountLabel,
  canCreateBooking,
  onCancelBooking,
  onCreateBooking,
  onGetBookingStatus,
  selectionKey,
  stationCourt,
  timeRange,
}: A3PayGameCreateDemoProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<A3PayDevVivaBookingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<NonNullable<ReturnType<typeof getOrCreateA3PayDevVivaOperationId>> | null>(null);
  const [phase, setPhase] = useState<"idle" | "create" | "booking" | "cancel" | "cancelled">("idle");
  const bookingRequiresCancellation = phase === "booking" || phase === "cancel";

  const applyStatus = (
    nextOperation: NonNullable<ReturnType<typeof getOrCreateA3PayDevVivaOperationId>>,
    next: A3PayDevVivaBookingResult,
  ) => {
    if (next.error || !next.data) {
      setError(next.error || "Не удалось восстановить состояние тестовой операции");
      return;
    }
    if (next.data.operationId !== nextOperation.operationId) {
      setError("Сервер вернул состояние другой операции; восстановление заблокировано.");
      return;
    }
    setResult(next.data);
    if (next.data.state === "VIVA_BOOKING_CREATED") setPhase("booking");
    else if (next.data.state === "CANCEL_PENDING") setPhase("cancel");
    else if (next.data.state === "CANCELLED") {
      setPhase("cancelled");
      clearA3PayDevVivaOperationId(nextOperation.operationId);
    } else setPhase("create");
  };

  const replaceSafeUnstartedOperation = (
    previousOperation: NonNullable<ReturnType<typeof getOrCreateA3PayDevVivaOperationId>>,
  ) => {
    clearA3PayDevVivaOperationId(previousOperation.operationId);
    const replacement = getOrCreateA3PayDevVivaOperationId(selectionKey);
    setOperation(replacement);
    setResult(null);
    setPhase("idle");
    setError(replacement
      ? null
      : "Не удалось сохранить новый operationId. Создание брони заблокировано.");
  };

  const handleOpen = () => {
    const nextOperation = getOrCreateA3PayDevVivaOperationId(selectionKey);
    setOperation(nextOperation);
    setResult(null);
    setPhase("idle");
    setError(nextOperation
      ? null
      : "Без устойчивого operationId создание реальной брони заблокировано. Разрешите localStorage и откройте окно снова.");
    setIsOpen(true);
    if (nextOperation?.restored) {
      setLoading(true);
      void onGetBookingStatus(nextOperation.operationId).then((next) => {
        setLoading(false);
        if (next.status === 404) {
          replaceSafeUnstartedOperation(nextOperation);
          return;
        }
        if (next.data?.state === "PREPARED" && nextOperation.selectionKey !== selectionKey) {
          replaceSafeUnstartedOperation(nextOperation);
          return;
        }
        applyStatus(nextOperation, next);
      });
    }
  };

  const handleClose = () => {
    if (bookingRequiresCancellation || loading) return;
    setIsOpen(false);
    setOperation(null);
    setResult(null);
    setPhase("idle");
    setError(null);
  };

  const handleCreateBooking = async () => {
    if (!operation || !canCreateBooking || loading) return;
    setPhase("create");
    setLoading(true);
    setError(null);
    const next = await onCreateBooking(operation.operationId);
    setLoading(false);
    if (next.error || !next.data) {
      setError(next.error || "Viva не подтвердила создание брони");
      return;
    }
    if (next.data.operationId !== operation.operationId) {
      setError("Сервер вернул результат другой операции; состояние брони не принято.");
      return;
    }
    setResult(next.data);
    if (next.data.state === "VIVA_BOOKING_CREATED") setPhase("booking");
  };

  const handleCancelBooking = async () => {
    if (!operation || !bookingRequiresCancellation || loading) return;
    setPhase("cancel");
    setLoading(true);
    setError(null);
    const next = await onCancelBooking(operation.operationId);
    setLoading(false);
    if (next.error || !next.data) {
      setError(next.error || "Viva не подтвердила отмену брони");
      return;
    }
    if (next.data.operationId !== operation.operationId) {
      setError("Сервер вернул результат другой операции; отмена не подтверждена.");
      return;
    }
    setResult(next.data);
    if (next.data.state === "CANCELLED") {
      setPhase("cancelled");
      clearA3PayDevVivaOperationId(operation.operationId);
    }
  };

  return (
    <>
      <style>{A3_PAY_GAME_CREATE_DEMO_STYLES}</style>
      <button
        className="a3pay-game-create-demo-button"
        data-demo-marker="lk-dev-a3pay-game-create-demo-v1"
        data-testid="a3pay-game-create-demo-button"
        onClick={handleOpen}
        type="button"
      >
        <span className="a3pay-game-create-demo-button-copy">
          <strong>Оплатить через Ozon Банк</strong>
        </span>
        <span className="a3pay-game-create-demo-button-arrow" aria-hidden="true">→</span>
      </button>

      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Тестовая бронь Viva для A3.pay"
        variant="dialog"
      >
        <div
          className="a3pay-game-create-demo-modal"
          data-demo-marker="lk-dev-a3pay-game-create-demo-modal-v1"
        >
          <div className="a3pay-game-create-demo-card">
            <div className="a3pay-game-create-demo-card-head">
              <span className="a3pay-game-create-demo-brand">A3.pay</span>
              <span className="a3pay-game-create-demo-badge">DEMO</span>
            </div>
            <div className="a3pay-game-create-demo-card-body">
              <span className="a3pay-game-create-demo-caption">Оплата игры через Ozon Банк</span>
              <strong className="a3pay-game-create-demo-amount">{amountLabel}</strong>
              <dl className="a3pay-game-create-demo-details">
                <div>
                  <dt>Площадка</dt>
                  <dd>{stationCourt}</dd>
                </div>
                <div>
                  <dt>Время</dt>
                  <dd>{timeRange}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="a3pay-game-create-demo-safety" role="status">
            <strong>Счёт A3.pay и игра пока не создаются</strong>
            <span>
              Кнопка ниже создаёт настоящую неоплаченную бронь в Viva только через выключенный
              по умолчанию серверный шлюз lk_dev. Платёжная ссылка Viva не открывается.
            </span>
          </div>

          {result && (
            <div className="a3pay-game-create-demo-result" role="status">
              {result.message || (result.state === "CANCELLED"
                ? "Бронь отменена и проверена в Viva."
                : "Бронь создана и проверена в Viva. Счёт A3.pay ещё не создавался.")}
            </div>
          )}
          {error && (
            <div className="a3pay-game-create-demo-result error" role="alert">{error}</div>
          )}

          <div className="a3pay-game-create-demo-actions">
            {!bookingRequiresCancellation && phase !== "cancelled" && (
              <button
                className="a3pay-game-create-demo-create"
                disabled={!operation || !canCreateBooking || loading}
                onClick={() => { void handleCreateBooking(); }}
                type="button"
              >
                {loading ? "Проверяем Viva…" : "Создать тестовую бронь в Viva"}
              </button>
            )}
            {bookingRequiresCancellation && (
              <button
                className="a3pay-game-create-demo-cancel-booking"
                disabled={loading}
                onClick={() => { void handleCancelBooking(); }}
                type="button"
              >
                {loading
                  ? "Проверяем отмену…"
                  : phase === "cancel"
                    ? "Проверить отмену в Viva"
                    : "Отменить тестовую бронь"}
              </button>
            )}

            {!bookingRequiresCancellation && (
              <button
                className="a3pay-game-create-demo-close"
                disabled={loading}
                onClick={handleClose}
                type="button"
              >
                Вернуться к созданию игры
              </button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
