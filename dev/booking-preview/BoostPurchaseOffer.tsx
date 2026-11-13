import { createPreviewOrder } from './bookingCheckout';
import { boostBenefits } from './boostOffers';
import { formatRubles, type PaymentContext, type PaymentOption, type Privileges } from './paymentMatrix';
import { SUBSCRIPTION_PLANS } from './privilegeRules';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';

export function BoostPurchaseOffer({ option, boostPrice, profile, plan, eventDescription, disabled, onContinue }: {
  option?: PaymentOption; boostPrice: number | null; profile: Privileges; plan: PaymentContext['subscriptionPlan'];
  eventDescription: string; disabled: boolean; onContinue: () => void;
}) {
  const eligible = profile.subscription || profile.residency;
  const order = eligible && option?.kind === 'boost' && option.mode === 'offer' ? createPreviewOrder(option, null, null, boostPrice) : null;
  const base = profile.subscription ? SUBSCRIPTION_PLANS.find(value => value.id === plan)?.name || 'Подписка' : 'Резидентство';
  const benefits = boostBenefits(profile, plan);
  return <PurchaseOfferLayout footer={<>
    <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить РАбуста · ${formatRubles(order.total)}` : boostPrice == null ? 'Стоимость РАбуста уточняется' : 'Нужен расчёт стоимости записи'}</button>
    <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + РАбуста ${formatRubles(order.productAmount)}` : 'РАбуста и запись — одной оплатой'}</p>
  </>}>
    <section className="matrix-purchase-benefits" aria-label="Преимущества РАбуста">
      <h2 data-purchase-title tabIndex={-1}>РАбуста</h2>
      <p>{boostPrice != null ? `${formatRubles(boostPrice)} · добавляется к записи` : 'Стоимость РАбуста уточняется'}</p>
      <p>В сочетании с вашим продуктом: {base}</p>
      <ul>{benefits.map((benefit, index) => <li key={benefit}><span className="matrix-purchase-benefit-icon" aria-hidden="true">{`0${index + 1}`}</span><span>{benefit}</span></li>)}</ul>
      <p className="matrix-purchase-limits">Нужны действующее Резидентство или подписка. Лимиты и уже использованные сегодня занятия учитываются при расчёте. После 8 активных записей остаются скидки, кроме ПРО.</p>
    </section>
    <section className="matrix-purchase-booking" aria-label="Стоимость записи с РАбуста">
      <h3>Ваша запись</h3><p>{eventDescription}</p>
      {option?.benefit === 'partial-hour' && <p className="matrix-purchase-explanation">{option.freeMinutes} мин бесплатно. Доплата за {option.paidMinutes} мин уже учитывает скидку 30%.</p>}
      <dl className="matrix-order-lines"><div><dt>Участие с РАбуста</dt><dd>{option?.amount != null ? formatRubles(option.amount) : 'Нужен расчёт'}</dd></div>
        <div><dt>РАбуста</dt><dd>{boostPrice != null ? formatRubles(boostPrice) : 'Цена уточняется'}</dd></div>
        <div><dt>{base}</dt><dd>Уже есть</dd></div>
        {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}</dl>
    </section>
  </PurchaseOfferLayout>;
}
