import { formatRubles, type GamePaymentScope, type ServiceKind } from './paymentMatrix';
import { purchaseChoiceOrder, type PurchaseChoice } from './purchaseChoices';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';
import { ProductBadge } from './ProductBadge';
import type { BookingEventDetails } from './bookingEventDetails';
import type { PaymentContext, Privileges } from './paymentMatrix';
import { PurchaseBookingEvent } from './PurchaseBookingEvent';
import { BoostPurchaseOffer } from './BoostPurchaseOffer';
import './residency-offer.css';

const planBenefits = {
  friendship: ['До 1 часа игры в день — ваша ¼ корта бесплатно', 'Скидка 30% на время игры сверх часа и после дневного лимита', 'Скидка 50% на групповые тренировки и турниры, кроме ПРО'],
  'friendship-2': ['До 2 часов игры в день — ваша ¼ корта бесплатно', 'Участие в турнире «Время на друзей» входит в подписку', 'Скидка на платное время игры', 'Скидка на групповые и другие турниры, кроме ПРО'],
  ra: ['Одно занятие в день: игра до 1 часа, групповая тренировка или турнир', 'В игре бесплатно только ваше участие — ¼ стоимости корта', 'Скидка на платное время игры после лимита', 'Скидка на групповые и турниры после лимита. ПРО не входит'],
};
const benefitLabels = {
  friendship: ['1 ч', '30%', '50%'],
  'friendship-2': ['2 ч', 'ФПР6х25', '30%', '50%'],
  ra: ['1 в день', '¼', '30%', '50%'],
};

export function SubscriptionPurchaseOffer({ choices, choice, profile, plan, eventName, eventDetails, service, gamePaymentScope, groupId, disabled, onSelect, onContinue }: {
  choices: PurchaseChoice[];
  choice?: PurchaseChoice;
  profile: Privileges;
  plan: PaymentContext['subscriptionPlan'];
  eventName: string;
  eventDetails?: BookingEventDetails;
  service: ServiceKind;
  gamePaymentScope?: GamePaymentScope;
  groupId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onContinue: () => void;
}) {
  const offer = choice?.subscription;
  const option = choice?.option;
  const order = purchaseChoiceOrder(choice);
  const benefits = offer && offer.plan in planBenefits ? planBenefits[offer.plan as keyof typeof planBenefits] : [];
  const labels = offer && offer.plan in benefitLabels ? benefitLabels[offer.plan as keyof typeof benefitLabels] : [];
  const picker = <fieldset className="matrix-subscription-plans" disabled={disabled}>
        <legend>Выберите подписку</legend>
        {choices.map(item => <label key={item.id} className={`matrix-subscription-plan ${choice?.id === item.id ? 'is-selected' : ''}`}>
          <input type="radio" name={`${groupId}-subscription`} value={item.id} checked={choice?.id === item.id} onChange={() => onSelect(item.id)} />
          <span className="matrix-subscription-plan-copy"><strong>{item.name}</strong><span>{item.days} дней{item.subscription ? ' · 30 занятий' : ` · Буст ${profile.subscription ? 'подписки' : 'Резидентства'}`}</span></span>
          <span className="matrix-subscription-plan-total"><strong>{item.price != null ? formatRubles(item.price) : 'Цена уточняется'}</strong><span>{item.option.amount === 0 ? 'Участие бесплатно' : item.option.amount != null ? `Участие: ${formatRubles(item.option.amount)}` : 'Нужен расчёт участия'}</span></span>
        </label>)}
      </fieldset>;
  if (choice?.id === 'boost') return <BoostPurchaseOffer option={choice.option} boostPrice={choice.price} profile={profile} plan={plan}
    eventName={eventName} eventDetails={eventDetails} service={service} gamePaymentScope={gamePaymentScope} disabled={disabled} onContinue={onContinue}>{picker}</BoostPurchaseOffer>;
  return <PurchaseOfferLayout footer={<>
      <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить подписку и записаться · ${formatRubles(order.total)}` : 'Нужен расчёт стоимости записи'}</button>
      <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + ${offer?.name} ${formatRubles(order.productAmount)}` : 'Подписка и запись — одной оплатой'}</p>
    </>}>
      {picker}
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
        <PurchaseBookingEvent details={eventDetails} service={service} scope={gamePaymentScope} name={eventName} />
        {option?.reason === 'daily-limit' && <p className="matrix-purchase-explanation">Дневной бесплатный лимит использован. В стоимость участия уже включена скидка подписки.</p>}
        {option?.reason === 'active-limit' && <p className="matrix-purchase-explanation">Лимит активных записей превышен. В стоимость участия уже включена скидка подписки.</p>}
        {option?.benefit === 'partial-hour' && <p className="matrix-purchase-explanation">{option.freeMinutes} мин бесплатно. Доплата за {option.paidMinutes} мин со скидкой 30% — {formatRubles(option.amount!)}.</p>}
        <dl className="matrix-order-lines" aria-live="polite"><div><dt>Участие</dt><dd>{order ? formatRubles(order.bookingAmount) : 'Нужен расчёт'}</dd></div>
          <div><dt>Подписка {offer?.name}</dt><dd>{offer ? formatRubles(offer.price) : 'Цена уточняется'}</dd></div>
          {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}</dl>
      </section>
  </PurchaseOfferLayout>;
}
