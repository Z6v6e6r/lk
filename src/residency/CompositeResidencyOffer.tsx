import { useId } from 'react';
import {
  previewCompositeResidencyOffer,
  type CompositeRefusal,
  type CompositeResidencyInput,
  type CompositeResidencyPlan,
} from './compositeResidencyOrder.ts';
import './composite-residency-offer.css';

const rub = (minor: number) => `${(minor / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

const REFUSAL_TEXT: Partial<Record<CompositeRefusal, string>> = {
  ALREADY_RESIDENT: 'У вас уже есть резидентство, покупать его повторно не нужно.',
  RESIDENCY_PRICE_STALE: 'Обновляем цену резидентства. Попробуйте ещё раз через несколько секунд.',
  LEVEL_DENIED: 'Ваш уровень не подходит для этого турнира.',
};

export interface CompositeResidencyOfferProps {
  input: Omit<CompositeResidencyInput, 'consentAccepted'>;
  consentAccepted: boolean;
  onConsentChange: (accepted: boolean) => void;
}

/**
 * Participation + residency in one payment: consent checkbox (RES-004) and a separate
 * participation / residency / total breakdown (RES-005). Renders nothing when the offer
 * is not available, except the refusals a player must see (RES-006, stale price, level).
 * The pay button is owned by the caller and is enabled only by a payable plan.
 */
export function CompositeResidencyOffer({ input, consentAccepted, onConsentChange }: CompositeResidencyOfferProps) {
  const id = useId();
  const offer = previewCompositeResidencyOffer({ ...input, consentAccepted: true });
  if (!offer.ok) {
    const message = REFUSAL_TEXT[offer.reason];
    return message ? <p className="ph-composite-residency-note" role="status">{message}</p> : null;
  }
  return <CompositeResidencyBreakdown id={id} plan={offer} consentAccepted={consentAccepted} onConsentChange={onConsentChange} />;
}

function CompositeResidencyBreakdown({ id, plan, consentAccepted, onConsentChange }: {
  id: string; plan: CompositeResidencyPlan; consentAccepted: boolean; onConsentChange: (accepted: boolean) => void;
}) {
  const b = plan.breakdown;
  return <section className="ph-composite-residency" aria-labelledby={`${id}-title`}>
    <label className="ph-composite-residency-consent">
      <input type="checkbox" checked={consentAccepted} onChange={event => onConsentChange(event.currentTarget.checked)} />
      <span>
        <strong id={`${id}-title`}>Оформить резидентство за {rub(b.residencyMinor)}</strong>
        <span>и получить скидку {b.discountPercent}% на эту запись. Резидентство действует 30 дней с момента оплаты.</span>
      </span>
    </label>
    {consentAccepted && <dl className="ph-composite-residency-lines" aria-label="Состав оплаты">
      <div><dt>Участие</dt><dd><s>{rub(b.participationBaseMinor)}</s> {rub(b.participationToPayMinor)}</dd></div>
      <div><dt>Резидентство, 30 дней</dt><dd>{rub(b.residencyMinor)}</dd></div>
      <div className="ph-composite-residency-total"><dt>Итого одной оплатой</dt><dd>{rub(b.totalMinor)}</dd></div>
    </dl>}
  </section>;
}
