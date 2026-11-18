import { useEffect, useState } from 'react';
import { startCheckout } from './zeroCheckoutMount';
import { CABINET_URL } from '../../consts/api_config';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { summerPlanPresentation } from './presentation';
import { PROMO_RETURN_QUERY_KEY, resolvePromoCabinetUrl, resolveStorefrontPromo } from './promo';
import { hasPromoPaymentAttempt, PROMO_PENDING_MESSAGE } from './promoPayment';
import markUrl from './assets/brand/подписка.svg';
import './promo.css';

export function PromoSubscriptionPage({ offerKey, onBack, cabinetUrl }: {
  offerKey: string; onBack?: () => void; cabinetUrl?: string | null;
}) {
  const offer = resolveStorefrontPromo(offerKey);
  const [blocked, setBlocked] = useState(() => hasPromoPaymentAttempt(offerKey)
    || new URLSearchParams(window.location.search).has(PROMO_RETURN_QUERY_KEY));
  const [failure, setFailure] = useState<string | null>(null);
  const [notice] = useState<string | null>(null);
  useEffect(() => {
    const onStorage = () => { if (hasPromoPaymentAttempt(offerKey)) setBlocked(true); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [offerKey]);

  return <div className="subscription-promo-page">
    {!offer ? <div className="subscription-promo-message" role="alert">
      <h1>Акционное предложение не найдено</h1>
      <p>Проверьте ссылку на акцию.</p>
    </div> : <SubscriptionStorefront onBack={onBack} onChoose={(selection, gesture) => {
      if (selection.planId !== offer.key || selection.billingOptionId !== 'promo' || !gesture || blocked) return;
      try { startCheckout(offer.key, offer.priceMinor, gesture); }
      catch (failure) { setFailure(failure instanceof Error ? failure.message : 'Не удалось открыть оформление.'); }
    }} view={{
      id: 'lk1-subscription-promo', title: 'Играй в падел по акции',
      description: `Подписка «${summerPlanPresentation[offer.planKey].label}» по специальной цене`, markUrl, markAlt: 'Подписка',
      sections: [{ id: 'subscription-promo', plans: [{
        ...summerPlanPresentation[offer.planKey], id: offer.key, featured: false,
        billingOptions: [{ id: 'promo', label: '30 дней', priceMinor: offer.priceMinor, priceSuffix: '/ 30 дней',
          statusMessage: notice || failure || (blocked ? PROMO_PENDING_MESSAGE : 'Акционное предложение'),
        }],
        ctaLabel: blocked ? 'Проверьте личный кабинет' : 'Оплатить по акции',
        ctaDisabled: blocked,
      }] }],
    }} />}
    <nav className="subscription-promo-links" aria-label="Другие подписки и личный кабинет">
      <a href={resolvePromoCabinetUrl(window.location.href, cabinetUrl || CABINET_URL)}>Личный кабинет</a>
      <a href={(() => {
        const url = new URL(window.location.href);
        for (const key of ['offer', 'offerKey', 'autoPurchase', PROMO_RETURN_QUERY_KEY, 'summerPaymentRef']) url.searchParams.delete(key);
        return url.toString();
      })()}>Все подписки</a>
    </nav>
  </div>;
}
