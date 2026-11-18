import { useId, useRef, useState } from "react";
import { SubscriptionOptionPrice } from "../games/SubscriptionOptionPrice";
import type { SubscriptionPricePreview } from "../games/subscriptionPricePreview";
import {
  confirmLabel,
  resolveSelectedOption,
  resolveStorefrontJoinView,
  type StorefrontJoinInput,
  type StorefrontJoinMethod,
} from "./storefrontJoinView";
import "./storefront-checkout.css";

const formatRubles = (value: number) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ₽`;

export interface StorefrontJoinCheckoutProps extends StorefrontJoinInput {
  shareLabel: string;
  pricePreviewById: Record<string, SubscriptionPricePreview>;
  onRefreshPrices: () => void;
  onRetrySubscriptions: () => void;
  onJoin: (method: StorefrontJoinMethod) => void;
  onPay: () => void;
  onLeave: () => void;
  onRecheck: () => void;
}

/**
 * Storefront-design join block wired to the existing GamesPage handlers.
 * It renders only server-derived states and never shows a local "paid" result.
 */
export function StorefrontJoinCheckout(props: StorefrontJoinCheckoutProps) {
  const groupId = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const view = resolveStorefrontJoinView(props);
  // Several clicks dispatched in one task reach the handler before React
  // re-renders the disabled button; each would create a new paymentRef.
  // The guard closes that window until the next task.
  const inFlight = useRef(false);
  const once = (action: () => void) => () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTimeout(() => { inFlight.current = false; }, 0);
    action();
  };
  const errorNode = (message: string | null) => message
    ? <p className="sf-checkout-error" role="alert">{message}</p>
    : null;

  if (view.kind === "awaiting-payment") {
    return <section className="sf-checkout" aria-label="Оплата участия" data-sf-state="awaiting-payment">
      <h2>Ожидаем оплату участия</h2>
      <p className="sf-checkout-status" role="status">
        {view.countdownLabel ? `Место удерживается · осталось ${view.countdownLabel}` : "Место удерживается до решения по оплате"}
      </p>
      <p className="sf-checkout-hint">Статус обновится после подтверждения банком. Возврат со страницы банка не означает оплату.</p>
      {errorNode(view.error)}
      <button type="button" className="sf-checkout-confirm" disabled={!view.paymentUrl} onClick={once(props.onPay)}>Перейти к оплате</button>
      <button type="button" className="sf-checkout-secondary" data-lk-leave-action="GAME_LEAVE"
        disabled={!view.canLeave || view.leaving} onClick={once(props.onLeave)}>
        {view.leaving ? "Покидаем игру…" : "Покинуть игру"}
      </button>
    </section>;
  }

  if (view.kind === "leave-only") {
    return <section className="sf-checkout" aria-label="Участие в игре" data-sf-state="leave-only">
      {errorNode(view.error)}
      <button type="button" className="sf-checkout-secondary" data-lk-leave-action="GAME_LEAVE"
        disabled={!view.canLeave || view.leaving} onClick={once(props.onLeave)}>
        {view.leaving ? "Покидаем игру…" : "Покинуть игру"}
      </button>
    </section>;
  }

  const selected = resolveSelectedOption(view.options, selectedKey);
  const locked = !view.canJoin || view.busy;
  return <section className="sf-checkout" aria-label="Запись на игру" data-sf-state="choose" aria-busy={view.busy || view.loading}>
    <h2>Запись на игру</h2>
    {view.loading && <p className="sf-checkout-status" role="status">Проверяем доступные абонементы…</p>}
    {view.loadError && <div className="sf-checkout-error" role="alert">
      {view.loadError}
      <button type="button" className="sf-checkout-link" disabled={view.busy} onClick={props.onRetrySubscriptions}>Проверить снова</button>
    </div>}
    <fieldset className="sf-checkout-options" disabled={locked}>
      <legend className="sf-checkout-sr-only">Способ записи</legend>
      {view.options.map(option => {
        const isSelected = selected?.key === option.key;
        const price = option.method.kind === "subscription"
          ? <SubscriptionOptionPrice preview={props.pricePreviewById[option.method.subscriptionId]} shareLabel={props.shareLabel} />
          : <strong>{option.amount != null ? formatRubles(option.amount) : "Стоимость не подтверждена"}</strong>;
        return <label key={option.key} className={`sf-checkout-option${isSelected ? " is-selected" : ""}${option.selectable ? "" : " is-unavailable"}`}>
          <input type="radio" name={`${groupId}-method`} value={option.key} checked={isSelected}
            disabled={!option.selectable} onChange={() => setSelectedKey(option.key)} />
          <span className="sf-checkout-option-copy">
            <strong>{option.title}</strong>
            <span>{option.method.kind === "one_time" ? `Моя доля ${props.shareLabel} · ${option.detail}` : option.detail}</span>
          </span>
          <span className="sf-checkout-option-value">{price}</span>
        </label>;
      })}
    </fieldset>
    {view.options.some(option => option.method.kind === "subscription") && <button type="button" className="sf-checkout-link"
      disabled={locked} onClick={props.onRefreshPrices}>Обновить стоимость по подпискам</button>}
    {!view.loading && !view.loadError && !view.options.some(option => option.method.kind === "subscription")
      && <p className="sf-checkout-hint">Подходящий абонемент не найден.</p>}
    {errorNode(view.error)}
    {view.outcomeUnknown && <button type="button" className="sf-checkout-secondary" disabled={view.busy}
      onClick={once(props.onRecheck)}>Проверить статус оплаты</button>}
    <button type="button" className="sf-checkout-confirm" data-lk-leave-action="GAME_JOIN"
      disabled={locked || !selected} onClick={once(() => { if (selected && !locked) props.onJoin(selected.method); })}>
      {confirmLabel(selected, view.busy, formatRubles)}
    </button>
  </section>;
}
