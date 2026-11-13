import { createPreviewOrder } from './bookingCheckout';
import { formatRubles, type PaymentOption } from './paymentMatrix';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';

const benefits = ['Скидка 30% на вашу ¼ стоимости игры', 'Скидка 50% на групповые тренировки', 'Скидка 50% на участие в турнирах'];

export function ResidencyPurchaseOffer({ option, residencyPrice, referenceAmount, eventDescription, disabled, onContinue }: {
  option?: PaymentOption;
  residencyPrice: number | null;
  referenceAmount: number | null;
  eventDescription: string;
  disabled: boolean;
  onContinue: () => void;
}) {
  const order = option?.kind === 'residency' && option.mode === 'offer' ? createPreviewOrder(option, residencyPrice) : null;
  const participation = option?.amount != null && Number.isFinite(option.amount) && option.amount >= 0 ? formatRubles(option.amount) : 'Нужен расчёт';
  return <PurchaseOfferLayout footer={<>
    <button type="button" className="matrix-confirm" disabled={disabled || !order} onClick={onContinue}>{order ? `Добавить Резидентство · ${formatRubles(order.total)}` : residencyPrice == null ? 'Стоимость Резидентства уточняется' : 'Нужен расчёт стоимости записи'}</button>
    <p>{order ? `Участие ${formatRubles(order.bookingAmount)} + Резидентство ${formatRubles(order.productAmount)}` : 'Резидентство и запись — одной оплатой'}</p>
  </>}>
    <section className="matrix-purchase-benefits" aria-label="Преимущества Резидентства">
      <h2 data-purchase-title tabIndex={-1}>Резидентство</h2>
      <p>{residencyPrice != null ? `${formatRubles(residencyPrice)} · добавляется к записи` : 'Стоимость Резидентства уточняется'}</p>
      <ul>{benefits.map((benefit, index) => <li key={benefit}><span className="matrix-purchase-benefit-icon" aria-hidden="true">{`0${index + 1}`}</span><span>{benefit}</span></li>)}</ul>
      <p className="matrix-purchase-limits">Скидки не действуют на ПРО и полную оплату корта за всех игроков. Скидки Резидентства и подписки не суммируются.</p>
    </section>
    <section className="matrix-purchase-booking" aria-label="Стоимость записи с Резидентством">
      <h3>Ваша запись</h3><p>{eventDescription}</p>
      <dl className="matrix-order-lines">
        {referenceAmount != null && <div><dt>Полная цена участия</dt><dd><del>{formatRubles(referenceAmount)}</del></dd></div>}
        <div><dt>Участие с Резидентством</dt><dd>{participation}</dd></div>
        <div><dt>Резидентство</dt><dd>{residencyPrice != null ? formatRubles(residencyPrice) : 'Цена уточняется'}</dd></div>
        {order && <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(order.total)}</dd></div>}
      </dl>
    </section>
  </PurchaseOfferLayout>;
}
