import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { CABINET_URL } from '../../consts/api_config';
import { AuthForm } from '../auth/AuthForm';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { summerPlanPresentation } from './presentation';
import { resolvePaymentPhone, StorefrontPaymentError } from './payment';
import { PROMO_RETURN_QUERY_KEY, resolvePromoCabinetUrl, resolveStorefrontPromo } from './promo';
import { createStorefrontPromoPayment, hasPromoPaymentAttempt, PROMO_PENDING_MESSAGE } from './promoPayment';
import markUrl from './assets/brand/подписка.svg';
import './promo.css';

function PromoAuthDialog({ onClose, onContinue, processing, failure }: {
  onClose: () => void; onContinue: () => void; processing: boolean; failure: string | null;
}) {
  const { isAuthenticated } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className="subscription-auth-block subscription-promo-dialog"
    aria-labelledby="subscription-promo-auth-title" onCancel={onClose}>
    <button className="subscription-auth-close" type="button" aria-label="Закрыть окно авторизации" onClick={onClose}>×</button>
    <h2 id="subscription-promo-auth-title" className="subscription-auth-title">Оформление подписки</h2>
    <p className="subscription-auth-caption">{isAuthenticated ? 'Вы вошли. Продолжите оформление по акционной цене.' : 'Войдите, чтобы продолжить оплату.'}</p>
    {failure && <p role="alert" className="auth-error">{failure}</p>}
    {isAuthenticated
      ? <button className="auth-btn" type="button" disabled={processing} onClick={onContinue}>{processing ? 'Создаём оплату…' : 'Продолжить оплату'}</button>
      : <AuthForm onLogin={() => {}} />}
  </dialog>;
}

export function PromoSubscriptionPage({ offerKey, onBack, cabinetUrl }: {
  offerKey: string; onBack?: () => void; cabinetUrl?: string | null;
}) {
  const { isAuthenticated } = useAuth();
  const offer = resolveStorefrontPromo(offerKey);
  const [authRequested, setAuthRequested] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [blocked, setBlocked] = useState(() => hasPromoPaymentAttempt(offerKey)
    || new URLSearchParams(window.location.search).has(PROMO_RETURN_QUERY_KEY));
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const onStorage = () => { if (hasPromoPaymentAttempt(offerKey)) setBlocked(true); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [offerKey]);

  async function choose() {
    if (!offer || blocked || inFlight.current) return;
    if (!isAuthenticated) { setAuthRequested(true); return; }
    inFlight.current = true;
    setProcessing(true);
    setFailure(null);
    try {
      const phone = await resolvePaymentPhone();
      if (!mounted.current) return;
      const outcome = await createStorefrontPromoPayment(offer.key, phone);
      if (!mounted.current) return;
      setBlocked(true);
      setAuthRequested(false);
      if (outcome.status === 'redirect') window.location.href = outcome.paymentUrl;
      else setNotice(outcome.message);
    } catch (error) {
      if (!mounted.current) return;
      const attempted = hasPromoPaymentAttempt(offer.key);
      setBlocked(attempted);
      if (attempted) setAuthRequested(false);
      setFailure(error instanceof StorefrontPaymentError ? error.message : 'Не удалось загрузить профиль. Попробуйте ещё раз.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setProcessing(false);
    }
  }

  return <div className="subscription-promo-page">
    {!offer ? <div className="subscription-promo-message" role="alert">
      <h1>Акционное предложение не найдено</h1>
      <p>Проверьте ссылку на акцию.</p>
    </div> : <SubscriptionStorefront onBack={onBack} onChoose={selection => {
      if (selection.planId === offer.key && selection.billingOptionId === 'promo') void choose();
    }} view={{
      id: 'lk1-subscription-promo', title: 'Играй в падел по акции',
      description: `Подписка «${summerPlanPresentation[offer.planKey].label}» по специальной цене`, markUrl, markAlt: 'Подписка',
      sections: [{ id: 'subscription-promo', plans: [{
        ...summerPlanPresentation[offer.planKey], id: offer.key, featured: false,
        billingOptions: [{ id: 'promo', label: '30 дней', priceMinor: offer.priceMinor, priceSuffix: '/ 30 дней',
          statusMessage: notice || failure || (blocked ? PROMO_PENDING_MESSAGE : 'Акционное предложение'),
        }],
        ctaLabel: processing ? 'Создаём оплату…' : blocked ? 'Проверьте личный кабинет' : 'Оформить по акции',
        ctaDisabled: processing || blocked,
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
    {authRequested && <PromoAuthDialog onClose={() => setAuthRequested(false)}
      onContinue={() => { void choose(); }} processing={processing || blocked} failure={failure} />}
  </div>;
}
