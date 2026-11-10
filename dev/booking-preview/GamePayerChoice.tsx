import { useId } from 'react';
import { buildGamePaymentOptions, formatRubles, readMatrixSettings, type PaymentOption } from './paymentMatrix';
import './matrix.css';

type Props = { value: 'self' | 'split'; onChange: (value: 'self' | 'split') => void; courtAmount: number | null; durationMinutes: number };

export function GamePayerChoice({ value, onChange, courtAmount, durationMinutes }: Props) {
  const name = useId();
  const settings = readMatrixSettings(new URLSearchParams(location.search));
  const options = buildGamePaymentOptions(courtAmount, 'quarter', settings.profile, settings.applicability, { ...settings, durationMinutes });
  const subscription = options.find(option => option.kind === 'subscription');
  const selectedBenefit = subscription?.mode === 'quote' ? subscription : options.find(option => option.mode === 'book');
  const personalBase = courtAmount != null && Number.isFinite(courtAmount) && courtAmount > 0 ? Math.round(courtAmount * 100 / 4) / 100 : null;
  const label = (option: PaymentOption | undefined) => {
    if (option?.benefit === 'partial-hour') return `${option.freeMinutes} мин бесплатно + ${option.paidMinutes} мин с доплатой`;
    if (option?.kind === 'subscription') return option.benefit === 'discount' ? 'Скидка 30% по подписке · дневной лимит использован' : 'По подписке · дневной бесплатный лимит доступен';
    if (option?.kind === 'residency') return 'С Резидентством · скидка 30%';
    if (option?.kind === 'pass') return 'По абонементу Энергия 5';
    return 'Ваша доля — ¼ стоимости корта';
  };
  const price = selectedBenefit?.mode === 'quote' || !selectedBenefit ? 'Нужен расчёт'
    : selectedBenefit.kind === 'pass' ? '1 посещение' : formatRubles(selectedBenefit.amount!);
  const discounted = personalBase != null && selectedBenefit?.amount != null && selectedBenefit.amount < personalBase;
  const residency = options.find(option => option.kind === 'residency' && option.mode === 'book');
  return <fieldset className="matrix-game-payers">
    <legend>Кто оплачивает игру?</legend>
    <label className={`matrix-payer ${value === 'split' ? 'is-selected' : ''}`}>
      <input type="radio" name={name} checked={value === 'split'} onChange={() => onChange('split')} value="split" />
      <span className="matrix-payer-copy"><strong>Плачу за себя</strong><span>¼ стоимости · 1 из 4 игроков</span><em>{label(selectedBenefit)}</em>
        {selectedBenefit?.mode === 'quote' && residency?.amount != null && <span>Или с Резидентством — {formatRubles(residency.amount)}</span>}
      </span>
      <span className="matrix-payer-price">{discounted && <del>{formatRubles(personalBase!)}</del>}<strong>{price}</strong></span>
    </label>
    <label className={`matrix-payer ${value === 'self' ? 'is-selected' : ''}`}>
      <input type="radio" name={name} checked={value === 'self'} onChange={() => onChange('self')} value="self" />
      <span className="matrix-payer-copy"><strong>Плачу за всех</strong><span>Полная оплата за 4 игроков</span><em>Скидки, подписка и абонементы не применяются</em></span>
      <span className="matrix-payer-price"><strong>{courtAmount != null && Number.isFinite(courtAmount) && courtAmount > 0 ? formatRubles(courtAmount) : 'Цена уточняется'}</strong></span>
    </label>
  </fieldset>;
}
