import { useMemo, type ReactNode } from "react";
import type { SubscriptionResponse } from "../utils/apiClient";
import { Modal } from "../components/UI/Modal";
import { useResidencyPass } from "./useResidencyPass.ts";
import { ResidencyPassQr } from "./ResidencyPassQr.tsx";
import {
  formatCountdown,
  formatIssueTime,
  formatResidencyTerm,
  type ResidencyViewState,
} from "./residencyPassModel.ts";
import "./residency-pass.css";

interface ResidencyPassPanelProps {
  isOpen: boolean;
  onClose: () => void;
  subscriptions: SubscriptionResponse | null;
  stationId: string | null;
}

const UNAVAILABLE_TEXT =
  "Данные о резидентстве временно недоступны. Это не значит, что абонемента нет — повторите через минуту.";

function renderStateBody(
  state: ResidencyViewState,
  context: {
    qrValue: string | null;
    remainingMs: number;
    onRetry: () => void;
    onShowNewPass: () => void;
  },
): ReactNode {
  switch (state.kind) {
    case "idle":
    case "loading":
      return (
        <div className="lk-residency-state" role="status" aria-live="polite">
          <p className="lk-residency-state-title">Проверяем резидентство…</p>
          <p className="lk-residency-state-text">Это займёт несколько секунд.</p>
        </div>
      );
    case "selecting":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Выберите абонемент</p>
          <p className="lk-residency-state-text">Пропуск можно оформить по действующему резидентскому абонементу.</p>
        </div>
      );
    case "active":
      return (
        <div className="lk-residency-active" aria-live="polite">
          <div className="lk-residency-qr-card">
            <ResidencyPassQr value={context.qrValue} />
            {!context.qrValue && (
              <p className="lk-residency-qr-expired">QR истёк. Покажите новый.</p>
            )}
          </div>
          <p className="lk-residency-countdown" aria-live="polite">
            {context.qrValue ? `Действует ещё ${formatCountdown(context.remainingMs)}` : "Обновляем QR…"}
          </p>
          <p className="lk-residency-state-text">
            Покажите QR сотруднику ресепшн. Код одноразовый и привязан к вашему резидентству.
          </p>
        </div>
      );
    case "issued":
      return (
        <div className="lk-residency-state lk-residency-state--success" role="status" aria-live="polite">
          <p className="lk-residency-state-title">Выдано ✓</p>
          <p className="lk-residency-state-text">
            Сотрудник подтвердил обслуживание{formatIssueTime(state.consumedAt) ? ` в ${formatIssueTime(state.consumedAt)}` : ""}.
          </p>
          <button type="button" className="lk-residency-button" onClick={context.onShowNewPass}>
            Показать новый QR
          </button>
        </div>
      );
    case "expired":
      return (
        <div className="lk-residency-state" role="status" aria-live="polite">
          <p className="lk-residency-state-title">QR истёк</p>
          <p className="lk-residency-state-text">Покажите новый код — резидентство остаётся действующим.</p>
          <button type="button" className="lk-residency-button" onClick={context.onShowNewPass}>
            Показать новый QR
          </button>
        </div>
      );
    case "offline":
      return (
        <div className="lk-residency-state" role="status" aria-live="polite">
          <p className="lk-residency-state-title">Нет соединения</p>
          <p className="lk-residency-state-text">
            {state.pass && context.qrValue
              ? `QR ещё действует ${formatCountdown(context.remainingMs)}. Проверьте интернет — новый код появится автоматически.`
              : "Чтобы получить новый QR, восстановите соединение."}
          </p>
          {context.qrValue && (
            <div className="lk-residency-qr-card lk-residency-qr-card--offline">
              <ResidencyPassQr value={context.qrValue} />
            </div>
          )}
          <button type="button" className="lk-residency-button" onClick={context.onRetry}>
            Повторить
          </button>
        </div>
      );
    case "no_subscription":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Нет активного абонемента</p>
          <p className="lk-residency-state-text">Пропуск резидента доступен по действующему резидентскому абонементу.</p>
        </div>
      );
    case "not_resident":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Резидентство не найдено</p>
          <p className="lk-residency-state-text">Действующий абонемент не подтверждает резидентство.</p>
          <button type="button" className="lk-residency-button lk-residency-button--ghost" onClick={context.onRetry}>
            Проверить снова
          </button>
        </div>
      );
    case "frozen":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Абонемент заморожен</p>
          <p className="lk-residency-state-text">
            {state.holdUntil
              ? `Заморозка действует до ${new Date(state.holdUntil).toLocaleDateString("ru-RU")}.`
              : "Пока абонемент заморожен, пропуск недоступен."}
          </p>
          <button type="button" className="lk-residency-button lk-residency-button--ghost" onClick={context.onRetry}>
            Проверить снова
          </button>
        </div>
      );
    case "term_expired":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Срок резидентства истёк</p>
          <p className="lk-residency-state-text">Продлите резидентский абонемент, чтобы снова пользоваться пропуском.</p>
        </div>
      );
    case "session_expired":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Нужно войти снова</p>
          <p className="lk-residency-state-text">Сессия истекла. Перезагрузите личный кабинет и войдите повторно.</p>
        </div>
      );
    case "rate_limited":
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Слишком часто</p>
          <p className="lk-residency-state-text">Подождите минуту и попробуйте снова.</p>
          <button type="button" className="lk-residency-button lk-residency-button--ghost" onClick={context.onRetry}>
            Повторить
          </button>
        </div>
      );
    case "unavailable":
      return (
        <div className="lk-residency-state" role="status" aria-live="polite">
          <p className="lk-residency-state-title">Резидентство временно недоступно</p>
          <p className="lk-residency-state-text">{UNAVAILABLE_TEXT}</p>
          <button type="button" className="lk-residency-button" onClick={context.onRetry}>
            Повторить
          </button>
        </div>
      );
    case "error":
    default:
      return (
        <div className="lk-residency-state" role="status">
          <p className="lk-residency-state-title">Не удалось показать пропуск</p>
          <p className="lk-residency-state-text">Попробуйте ещё раз. Если ошибка повторяется — обратитесь на ресепшн.</p>
          <button type="button" className="lk-residency-button" onClick={context.onRetry}>
            Повторить
          </button>
        </div>
      );
  }
}

/**
 * Resident pass screen for the existing LK cabinet.
 *
 * Time, validity and residency truth come from the server: the screen never extends a pass on
 * its own and never presents an expired QR as valid.
 */
export function ResidencyPassPanel({ isOpen, onClose, subscriptions, stationId }: ResidencyPassPanelProps) {
  const { enabled, state, remainingMs, qrValue, showNewPass, retry } = useResidencyPass({
    open: isOpen,
    subscriptions: subscriptions?.content ?? null,
    stationId,
  });
  const termLabel = useMemo(() => {
    if (state.kind === "active" || state.kind === "issued") {
      return formatResidencyTerm(state.pass.residency);
    }
    return null;
  }, [state]);

  if (!enabled) return null;

  const title = state.kind === "active" || state.kind === "issued" ? "Пропуск резидента" : "Резидентство";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} variant="dialog" bodyClassName="lk-residency-modal-body">
      <div className="lk-residency">
        <div className="lk-residency-facts">
          {stationId && <span className="lk-residency-fact">Станция выбрана по QR</span>}
          {termLabel && <span className="lk-residency-fact">Резидентство до {termLabel}</span>}
        </div>
        {renderStateBody(state, { qrValue, remainingMs, onRetry: retry, onShowNewPass: showNewPass })}
        <button type="button" className="lk-residency-button lk-residency-button--ghost" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Modal>
  );
}
