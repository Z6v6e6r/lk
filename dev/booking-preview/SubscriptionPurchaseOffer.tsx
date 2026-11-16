import { createPreviewOrder } from './bookingCheckout';
import { formatRubles, type GamePaymentScope, type PaymentOption, type ServiceKind } from './paymentMatrix';
import type { subscriptionPurchaseChoices, SubscriptionOffer } from './subscriptionOffers';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';
import { ProductBadge } from './ProductBadge';
import { bookingEventLines, type BookingEventDetails } from './bookingEventDetails';
import './residency-offer.css';

const planBenefits = {
  friendship: ['До 1 часа игры в день — ваша ¼ корта бесплатно', 'Скидка 30% на время игры сверх часа и после дневного лимита', 'Скидка 50% на групповые тренировки и турниры, кроме ПРО'],
  'friendship-2': ['До 2 часов игры в день — ваша ¼ корта бесплатно', 'Участие в турнире «Время на друзей» входит в подписку', 'Скидка 30% на платное время игры и 50% на групповые и другие турниры, кроме ПРО'],
  ra: ['Одно занятие в день: игра до 1 часа, групповая тренировка или турнир', 'В игре бесплатно только ваше участие — ¼ стоимости корта', 'Скидка 30% на платное время игры и 50% на групповые и турниры после лимита. ПРО не входит'],
};
const benefitLabels = {
  friendship: ['1 ч', '30%', '50%'],
  'friendship-2': ['2 ч', 'ВНД', '30/50%'],
  ra: ['1 в день', '¼', '30/50%'],
};

export function SubscriptionPurchaseOffer({ choices, offer, option, eventName, eventDetails, service, gamePaymentScope, groupId, disabled, onSelect, onContinue }: {
  choices: ReturnType<typeof subscriptionPurchaseChoices>;
  offer?: SubscriptionOffer;
  option?: PaymentOption;
  eventName: string;
  eventDetails?: BookingEventDetails;
  service: ServiceKind;
  gamePaymentScope?: GamePaymentScope;
  groupId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
}) {
  const order = offer && option ? createPreviewOrder(option, null, offer.price) : null;
  const benefits = offer && offer.plan in planBenefits ? planBenefits[offer.plan as keyof typeof planBenefits] : [];
  const labels = offer && offer.plan in benefitLabels ? benefitLabels[offer.plan as keyof typeof benefitLabels] : [];
  const event = bookingEventLines(eventDetails, service, gamePaymentScope);
  return <PurchaseOfferLayout footer={<>
      <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить подписку · ${formatRubles(order.total)}` : 'Нужен расчёт стоимости записи'}</button>
      <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + ${offer?.name} ${formatRubles(order.productAmount)}` : 'Подписка и запись — одной оплатой'}</p>
    </>}>
      <fieldset className="matrix-subscription-plans" disabled={disabled}>
        <legend>Выберите подписку</legend>
        {choices.map(choice => <label key={choice.offer.id} className={`matrix-subscription-plan ${offer?.id === choice.offer.id ? 'is-selected' : ''}`}>
          <input type="radio" name={`${groupId}-subscription`} value={choice.offer.id} checked={offer?.id === choice.offer.id} onChange={() => onSelect(choice.offer.id)} />
          <span className="matrix-subscription-plan-copy"><strong>{choice.offer.name}</strong><span>30 дней · 30 занятий</span></span>
          <span className="matrix-subscription-plan-total"><strong>{formatRubles(choice.offer.price)}</strong><span>{choice.option.amount === 0 ? 'Участие бесплатно' : choice.option.amount != null ? `Участие: ${formatRubles(choice.option.amount)}` : 'Нужен расчёт участия'}</span></span>
        </label>)}
      </fieldset>
      {offer && <section className="matrix-purchase-benefits matrix-residency-card matrix-subscription-card" data-subscription-plan={offer.plan} aria-label={`Преимущества подписки ${offer.name}`}>
        <h2 className="matrix-residency-badge" data-purchase-title tabIndex={-1}><ProductBadge product={offer.plan} name={offer.name} /></h2>
        <p className="matrix-residency-price"><strong>{formatRubles(offer.price)}</strong><span> / 30 дней</span></p>
        <ul className="matrix-residency-discounts">{benefits.map((benefit, index) => <li key={benefit}><strong aria-hidden="true">{labels[index]}</strong><span>{benefit}</span></li>)}</ul>
        <details className="matrix-residency-terms">
          <summary>Условия<span aria-hidden="true">⌄</span></summary>
          <ul className="matrix-residency-limits" aria-label="Условия подписки">
            <li>До 8 активных записей.</li>
            <li>После лимита сохраняются скидки 30% на игры и 50% на групповые и турниры, кроме ПРО.</li>
          </ul>
        </details>
      </section>}
      <section className="matrix-purchase-booking" aria-label="Стоимость записи с подпиской">
        <details className="matrix-purchase-event-details">
          <summary>Ваша запись<span aria-hidden="true">⌄</span></summary>
          <div className="matrix-purchase-event"><strong>{event.when}</strong><span>{event.station}</span><span>{eventName}</span></div>
        </details>
        {option?.reason === 'daily-limit' && <p className="matrix-purchase-explanation">Дневной бесплатный лимит использован. В стоимость участия уже включена скидка подписки.</p>}
        {option?.reason === 'active-limit' && <p className="matrix-purchase-explanation">Лимит активных записей превышен. В стоимость участия уже включена скидка подписки.</p>}
        {option?.benefit === 'partial-hour' && <p className="matrix-purchase-explanation">{option.freeMinutes} мин бесплатно. Доплата за {option.paidMinutes} мин со скидкой 30% — {formatRubles(option.amount!)}.</p>}
        <dl className="matrix-order-lines" aria-live="polite"><div><dt>Участие</dt><dd>{order ? formatRubles(order.bookingAmount) : 'Нужен расчёт'}</dd></div>
          <div><dt>Подписка {offer?.name}</dt><dd>{offer ? formatRubles(offer.price) : 'Цена уточняется'}</dd></div>
          {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}</dl>
      </section>
  </PurchaseOfferLayout>;
}
