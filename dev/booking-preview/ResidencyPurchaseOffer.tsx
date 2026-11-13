import { createPreviewOrder } from './bookingCheckout';
import { formatRubles, type GamePaymentScope, type ServiceKind, type PaymentOption } from './paymentMatrix';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';
import { ProductBadge } from './ProductBadge';
import { bookingEventLines, type BookingEventDetails } from './bookingEventDetails';
import './residency-offer.css';

export function ResidencyPurchaseOffer({ option, residencyPrice, referenceAmount, eventName, durationMinutes, eventDetails, service, gamePaymentScope, disabled, onContinue }: {
  option?: PaymentOption;
  residencyPrice: number | null;
  referenceAmount: number | null;
  eventName: string;
  durationMinutes: number;
  eventDetails?: BookingEventDetails;
  service: ServiceKind;
  gamePaymentScope?: GamePaymentScope;
  disabled: boolean;
  onContinue: () => void;
}) {
  const order = option?.kind === 'residency' && option.mode === 'offer' ? createPreviewOrder(option, residencyPrice) : null;
  const participation = option?.amount != null && Number.isFinite(option.amount) && option.amount >= 0 ? formatRubles(option.amount) : 'Нужен расчёт';
  const event = bookingEventLines(eventDetails, service, gamePaymentScope);
  return <PurchaseOfferLayout footer={<>
    <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить Резидентство · ${formatRubles(order.total)}` : residencyPrice == null ? 'Стоимость Резидентства уточняется' : 'Нужен расчёт стоимости записи'}</button>
    <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + Резидентство ${formatRubles(order.productAmount)}` : 'Резидентство и запись — одной оплатой'}</p>
  </>}>
    <section className="matrix-purchase-benefits matrix-residency-card" aria-label="Преимущества Резидентства">
      <h2 className="matrix-residency-badge" data-purchase-title tabIndex={-1}><ProductBadge product="residency" name="Резидентство" /></h2>
      <p className="matrix-residency-price">{residencyPrice != null ? <><strong>{formatRubles(residencyPrice)}</strong><span> / 30 дней</span></> : 'Стоимость Резидентства уточняется'}</p>
      <ul className="matrix-residency-discounts">
        <li><strong>30%</strong><span>Скидка на создание и участие в игре — на вашу ¼ стоимости корта</span></li>
        <li><strong>50%</strong><span>Скидка на форматы: игра + тренер, групповые тренировки, лига «Время на друзей», турниры ПадлхАБ</span></li>
      </ul>
      <div className="matrix-residency-equipment">
        <h3>На время игры:</h3>
        <p>Без оплаты при наличии</p>
        {['Ракетка', 'Полотенце'].map(item => <div key={item}><span>{item}</span><span className="matrix-residency-included" role="img" aria-label="Включено при наличии" /></div>)}
      </div>
      <ul className="matrix-residency-limits" aria-label="Условия скидок">
        <li>Скидки не действуют на ПРО.</li>
        <li>Скидка не применяется к полной оплате корта за всех игроков.</li>
        <li>Скидки Резидентства и подписки не суммируются.</li>
      </ul>
    </section>
    <section className="matrix-purchase-booking" aria-label="Стоимость записи с Резидентством">
      <h3>Ваша запись</h3>
      <div className="matrix-purchase-event">
        <strong>{event.when}</strong><span>{event.where}</span>
        <span>{eventName} · {durationMinutes} мин</span><span>{event.scope}</span>
      </div>
      <dl className="matrix-order-lines">
        {referenceAmount != null && <div><dt>Полная цена участия</dt><dd><del>{formatRubles(referenceAmount)}</del></dd></div>}
        <div><dt>Участие с Резидентством</dt><dd>{participation}</dd></div>
        <div><dt>Резидентство</dt><dd>{residencyPrice != null ? formatRubles(residencyPrice) : 'Цена уточняется'}</dd></div>
        {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}
      </dl>
    </section>
  </PurchaseOfferLayout>;
}
