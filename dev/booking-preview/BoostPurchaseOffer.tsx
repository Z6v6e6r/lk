import type { ReactNode } from 'react';
import { createPreviewOrder } from './bookingCheckout';
import { boostBenefits } from './boostOffers';
import { formatRubles, type PaymentContext, type PaymentOption, type Privileges, type ServiceKind, type GamePaymentScope } from './paymentMatrix';
import { SUBSCRIPTION_PLANS } from './privilegeRules';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';
import type { BookingEventDetails } from './bookingEventDetails';
import { PurchaseBookingEvent } from './PurchaseBookingEvent';
import './residency-offer.css';

export function BoostPurchaseOffer({ option, boostPrice, profile, plan, eventName, eventDetails, service, gamePaymentScope, disabled, onContinue, children }: {
  option?: PaymentOption; boostPrice: number | null; profile: Privileges; plan: PaymentContext['subscriptionPlan'];
  eventName: string; eventDetails?: BookingEventDetails; service: ServiceKind; gamePaymentScope?: GamePaymentScope;
  disabled: boolean; onContinue: () => void; children?: ReactNode;
}) {
  const eligible = profile.subscription || profile.residency;
  const order = eligible && option?.kind === 'boost' && option.mode === 'offer' ? createPreviewOrder(option, null, null, boostPrice) : null;
  const base = profile.subscription ? SUBSCRIPTION_PLANS.find(value => value.id === plan)?.name || 'Подписка' : 'Резидентство';
  const benefits = boostBenefits(profile, plan);
  return <PurchaseOfferLayout footer={<>
    <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить РАбуста и записаться · ${formatRubles(order.total)}` : boostPrice == null ? 'Стоимость РАбуста уточняется' : 'Нужен расчёт стоимости записи'}</button>
    <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + РАбуста ${formatRubles(order.productAmount)}` : 'РАбуста и запись — одной оплатой'}</p>
  </>}>
    {children}
    <section className="matrix-purchase-benefits matrix-residency-card" aria-label="Преимущества РАбуста">
      <h2 className="matrix-residency-badge" data-purchase-title tabIndex={-1}>РАбуста</h2>
      <p className="matrix-residency-price">{boostPrice != null ? <><strong>{formatRubles(boostPrice)}</strong><span> / 7 дней</span></> : 'Стоимость РАбуста уточняется'}</p>
      <p>В сочетании с вашим продуктом: {base}</p>
      <ul className="matrix-residency-discounts">{benefits.map(benefit => <li key={benefit}><strong aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg></strong><span>{benefit}</span></li>)}</ul>
      <details className="matrix-residency-terms">
        <summary>Условия<span aria-hidden="true">⌄</span></summary>
        <ul className="matrix-residency-limits" aria-label="Условия РАбуста">
          <li>Нужны действующее Резидентство или подписка.</li>
          <li>Лимиты и уже использованные сегодня занятия учитываются при расчёте.</li>
          <li>После 8 активных записей остаются скидки, кроме ПРО.</li>
        </ul>
      </details>
    </section>
    <section className="matrix-purchase-booking" aria-label="Стоимость записи с РАбуста">
      <PurchaseBookingEvent details={eventDetails} service={service} scope={gamePaymentScope} name={eventName} />
      {option?.benefit === 'partial-hour' && <p className="matrix-purchase-explanation">{option.freeMinutes} мин бесплатно. Доплата за {option.paidMinutes} мин уже учитывает скидку 30%.</p>}
      <dl className="matrix-order-lines"><div><dt>Участие с РАбуста</dt><dd>{option?.amount != null ? formatRubles(option.amount) : 'Нужен расчёт'}</dd></div>
        <div><dt>РАбуста</dt><dd>{boostPrice != null ? formatRubles(boostPrice) : 'Цена уточняется'}</dd></div>
        <div><dt>{base}</dt><dd>Уже есть</dd></div>
        {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}</dl>
    </section>
  </PurchaseOfferLayout>;
}
