import { useState } from "react";
import { Modal } from "../UI/Modal";

interface A3PayGameCreateDemoProps {
  amountLabel: string;
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
    gap: 3px;
  }

  .a3pay-game-create-demo-button-copy strong {
    font-size: 15px;
    font-weight: 800;
    line-height: 1.25;
  }

  .a3pay-game-create-demo-button-copy span {
    font-size: 12px;
    font-weight: 650;
    line-height: 1.3;
    opacity: 0.72;
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

  @media (prefers-reduced-motion: reduce) {
    .a3pay-game-create-demo-button {
      transition: none;
    }
  }
`;

export function A3PayGameCreateDemo({
  amountLabel,
  stationCourt,
  timeRange,
}: A3PayGameCreateDemoProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <style>{A3_PAY_GAME_CREATE_DEMO_STYLES}</style>
      <button
        className="a3pay-game-create-demo-button"
        data-demo-marker="lk-dev-a3pay-game-create-demo-v1"
        data-testid="a3pay-game-create-demo-button"
        onClick={() => setIsOpen(true)}
        type="button"
      >
        <span className="a3pay-game-create-demo-button-copy">
          <strong>Оплатить через Ozon Банк</strong>
          <span>A3.pay · демо, платёж не выполняется</span>
        </span>
        <span className="a3pay-game-create-demo-button-arrow" aria-hidden="true">→</span>
      </button>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Демо оплаты через A3.pay"
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
            <strong>Запрос на оплату не отправлен</strong>
            <span>Счёт A3.pay, бронь Viva и игра не создаются.</span>
          </div>

          <button
            className="a3pay-game-create-demo-close"
            onClick={() => setIsOpen(false)}
            type="button"
          >
            Вернуться к созданию игры
          </button>
        </div>
      </Modal>
    </>
  );
}
