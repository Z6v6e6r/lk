import { useId } from 'react';
import { buildGamePaymentOptions, formatRubles, readMatrixSettings, type PaymentOption } from './paymentMatrix';
import { gameSubscriptionComparison } from './gameSubscriptionComparison';
import { eligibleSubscriptionOffers, subscriptionOfferQuote } from './subscriptionOffers';
import './matrix.css';

type Props = { value: 'self' | 'split'; onChange: (value: 'self' | 'split') => void; courtAmount: number | null; durationMinutes: number };

export function GamePayerChoice({ value, onChange, courtAmount, durationMinutes }: Props) {
  const name = useId();
  const settings = readMatrixSettings(new URLSearchParams(location.search));
  const options = buildGamePaymentOptions(courtAmount, 'quarter', settings.profile, settings.applicability, { ...settings, durationMinutes });
  const context = { ...settings, durationMinutes };
  const cheapestSubscription = eligibleSubscriptionOffers('game', context)[0];
  const subscription = !settings.profile.subscription && cheapestSubscription
    ? subscriptionOfferQuote(cheapestSubscription, 'game', context, 'quarter', courtAmount)
    : gameSubscriptionComparison(courtAmount, context);
  const residency = options.find(option => option.kind === 'residency');
  const personalBase = courtAmount != null && Number.isFinite(courtAmount) && courtAmount > 0 ? Math.round(courtAmount * 100 / 4) / 100 : null;
  const price = (option: PaymentOption | undefined) => {
    if (personalBase == null) return 'Цена уточняется';
    if (!option || option.mode === 'unavailable') return 'Не действует';
    if (option.mode === 'quote' || option.amount == null) return 'Нужен расчёт';
    return formatRubles(option.amount);
  };
  const subscriptionNote = subscription?.reason === 'training-only' ? 'Тариф даёт бесплатную тренировку; скидка на игру — после использования дневного лимита'
    : subscription?.mode === 'unavailable' ? 'Тариф не подходит к этому событию'
      : subscription?.benefit === 'partial-hour' ? `${subscription.freeMinutes} мин бесплатно · оплачиваются только ${subscription.paidMinutes} мин с подходящей подпиской`
        : subscription?.benefit === 'discount' ? 'Скидка 30% · дневной лимит использован'
          : 'С подходящей подпиской · дневной бесплатный лимит доступен';
  const discount = (option: PaymentOption | undefined) => personalBase != null && option?.amount != null
    && option.amount > 0 && option.amount < personalBase;
  return <fieldset className="matrix-game-payers">
    <legend>Кто оплачивает игру?</legend>
    <label className={`matrix-payer matrix-payer--personal ${value === 'split' ? 'is-selected' : ''}`}>
      <input type="radio" name={name} checked={value === 'split'} onChange={() => onChange('split')} value="split" />
      <span className="matrix-payer-copy"><strong>Плачу за себя</strong><span>1 из 4 игроков · все варианты личной оплаты</span>
        <span className="matrix-quarter-prices" role="group" aria-label="Три варианта стоимости личной доли">
          <span className="matrix-quarter-row matrix-quarter-row--base">
            <span><b>¼ стоимости корта</b><small>Без применения льгот</small></span>
            <span className="matrix-quarter-price"><strong>{personalBase != null ? formatRubles(personalBase) : 'Цена уточняется'}</strong></span>
          </span>
          <span className={`matrix-quarter-row matrix-quarter-row--subscription ${subscription?.mode === 'unavailable' ? 'is-unavailable' : ''}`}>
            <span><b>По подписке</b><small>{personalBase == null ? 'Дождитесь расчёта стоимости корта' : subscriptionNote}</small></span>
            <span className="matrix-quarter-price">{discount(subscription) && <del>{formatRubles(personalBase!)}</del>}<strong>{price(subscription)}</strong></span>
          </span>
          <span className="matrix-quarter-row matrix-quarter-row--residency">
            <span><b>С Резидентством</b><small>{settings.profile.residency ? 'Ваша скидка 30%' : 'Скидка 30% при наличии Резидентства'}</small></span>
            <span className="matrix-quarter-price">{discount(residency) && <del>{formatRubles(personalBase!)}</del>}<strong>{price(residency)}</strong></span>
          </span>
        </span>
      </span>
    </label>
    <label className={`matrix-payer ${value === 'self' ? 'is-selected' : ''}`}>
      <input type="radio" name={name} checked={value === 'self'} onChange={() => onChange('self')} value="self" />
      <span className="matrix-payer-copy"><strong>Плачу за всех</strong><span>Полная оплата за 4 игроков</span><em>Скидки, подписка и абонементы не применяются</em></span>
      <span className="matrix-payer-price"><strong>{courtAmount != null && Number.isFinite(courtAmount) && courtAmount > 0 ? formatRubles(courtAmount) : 'Цена уточняется'}</strong></span>
    </label>
  </fieldset>;
}
