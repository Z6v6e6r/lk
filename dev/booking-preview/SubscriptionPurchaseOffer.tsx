import { createPreviewOrder } from './bookingCheckout';
import { formatRubles, type PaymentOption } from './paymentMatrix';
import type { subscriptionPurchaseChoices, SubscriptionOffer } from './subscriptionOffers';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';

const planBenefits = {
  friendship: ['До 1 часа игры в день — ваша ¼ корта бесплатно', 'Скидка 30% на время игры сверх часа и после дневного лимита', 'Скидка 50% на групповые тренировки и турниры, кроме ПРО'],
  'friendship-2': ['До 2 часов игры в день — ваша ¼ корта бесплатно', 'Участие в турнире «Время на друзей» входит в подписку', 'Скидка 30% на платное время игры и 50% на групповые и другие турниры, кроме ПРО'],
  ra: ['Одно занятие в день: игра до 1 часа, групповая тренировка или турнир', 'В игре бесплатно только ваше участие — ¼ стоимости корта', 'Скидка 30% на платное время игры и 50% на групповые и турниры после лимита. ПРО не входит'],
};

export function SubscriptionPurchaseOffer({ choices, offer, option, eventDescription, groupId, disabled, onSelect, onContinue }: {
  choices: ReturnType<typeof subscriptionPurchaseChoices>;
  offer?: SubscriptionOffer;
  option?: PaymentOption;
  eventDescription: string;
  groupId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
}) {
  const order = offer && option ? createPreviewOrder(option, null, offer.price) : null;
  const benefits = offer && offer.plan in planBenefits ? planBenefits[offer.plan as keyof typeof planBenefits] : [];
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
      {offer && <section className="matrix-purchase-benefits" aria-label={`Преимущества подписки ${offer.name}`}>
        <h2>{offer.name}</h2>
        <p>{formatRubles(offer.price)} за 30 дней</p>
        <ul>{benefits.map((benefit, index) => <li key={benefit}><span className="matrix-purchase-benefit-icon" aria-hidden="true">{index === 0 ? '01' : index === 1 ? '02' : '03'}</span><span>{benefit}</span></li>)}</ul>
        <p className="matrix-purchase-limits">До 8 активных записей. После лимита сохраняются скидки 30% на игры и 50% на групповые и турниры, кроме ПРО.</p>
      </section>}
      <section className="matrix-purchase-booking" aria-label="Стоимость записи с подпиской">
        <h3>Ваша запись</h3><p>{eventDescription}</p>
        {option?.reason === 'daily-limit' && <p className="matrix-purchase-explanation">Дневной бесплатный лимит использован. В стоимость участия уже включена скидка подписки.</p>}
        {option?.reason === 'active-limit' && <p className="matrix-purchase-explanation">Лимит активных записей превышен. В стоимость участия уже включена скидка подписки.</p>}
        {option?.benefit === 'partial-hour' && <p className="matrix-purchase-explanation">{option.freeMinutes} мин бесплатно. Доплата за {option.paidMinutes} мин со скидкой 30% — {formatRubles(option.amount!)}.</p>}
        <dl className="matrix-order-lines" aria-live="polite"><div><dt>Участие</dt><dd>{order ? formatRubles(order.bookingAmount) : 'Нужен расчёт'}</dd></div>
          <div><dt>Подписка {offer?.name}</dt><dd>{offer ? formatRubles(offer.price) : 'Цена уточняется'}</dd></div>
          {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}</dl>
      </section>
  </PurchaseOfferLayout>;
}
