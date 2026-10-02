import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AuthForm } from '../auth/AuthForm';
import { useAuth } from '../../context/AuthContext';
import { readAuthToken } from '../../utils/authTokenStorage';
import { previewSubscriptionPromoCode, type SubscriptionPromoQuote } from '../../utils/subscriptionPromoCode';
import { resolvePaymentPhone, resolveStorefrontBillingTarget, validateStorefrontDirectPurchase, type StorefrontBillingOptionId } from './payment';
import { createSubscriptionPromoPayment } from './promoCodePayment';
import { withZeroDeadline } from './zeroCheckoutPayment';
import './promo-code.css';

function money(amount: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(amount / 100);
}

export function SubscriptionPromoCodeDialog({ productId, title, planId, billingOptionId, onClose }: {
  productId: string; title: string; planId: string; billingOptionId: StorefrontBillingOptionId; onClose: () => void;
}) {
  const auth = useAuth();
  const authenticated = auth.isAuthenticated && !auth.isRestoringSession && !auth.isLoading && !auth.needsPhoneVerification;
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const paying = useRef(false);
  const [annualTermsAccepted, setAnnualTermsAccepted] = useState(false);
  const [draft, setDraft] = useState('');
  const [quote, setQuote] = useState<{ price: SubscriptionPromoQuote; phone: string; actor: string } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const actor = readAuthToken();
  const currentQuote = authenticated && quote?.actor === actor ? quote : null;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      generation.current += 1;
      document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, []);

  function close() {
    if (paying.current) return;
    generation.current += 1;
    onClose();
  }

  async function apply() {
    if (busy.current || !authenticated) return;
    if (!draft.trim()) { setError('Введите промокод.'); return; }
    const requestGeneration = ++generation.current;
    const requestActor = readAuthToken();
    busy.current = true; setProcessing(true); setQuote(null); setError(null);
    try {
      const { phone, price } = await withZeroDeadline((async () => {
        const phone = await resolvePaymentPhone();
        const target = resolveStorefrontBillingTarget(planId, billingOptionId);
        if (!target || target.directProductId !== productId) throw new Error('Предложение изменилось.');
        await validateStorefrontDirectPurchase(target);
        const price = await previewSubscriptionPromoCode(productId, phone, draft);
        return { phone, price };
      })(), 12_000);
      if (generation.current !== requestGeneration || readAuthToken() !== requestActor) return;
      setQuote({ price, phone, actor: requestActor! });
    } catch (failure) {
      if (generation.current === requestGeneration) setError(failure instanceof Error ? failure.message : 'Не удалось применить промокод.');
    } finally {
      busy.current = false;
      if (generation.current === requestGeneration) setProcessing(false);
    }
  }

  async function pay() {
    if (busy.current || !currentQuote || (billingOptionId === 'annual' && !annualTermsAccepted)) return;
    const selected = currentQuote;
    const requestGeneration = generation.current;
    let operationActive = true;
    busy.current = true; paying.current = true; setProcessing(true); setError(null);
    try {
      const result = await withZeroDeadline((async () => {
        const phone = await resolvePaymentPhone();
        if (phone !== selected.phone) throw new Error('Профиль изменился. Примените промокод снова.');
        const target = resolveStorefrontBillingTarget(planId, billingOptionId);
        if (!target || target.directProductId !== productId) throw new Error('Предложение изменилось.');
        await validateStorefrontDirectPurchase(target);
        return createSubscriptionPromoPayment(selected.price, phone,
          () => operationActive && generation.current === requestGeneration && readAuthToken() === selected.actor);
      })());
      if (generation.current !== requestGeneration) return;
      if (result.status === 'redirect') { window.location.href = result.paymentUrl; return; }
      setSettled(true); setQuote(null);
    } catch (failure) {
      setQuote(null);
      setError(failure instanceof Error ? failure.message : 'Не удалось подтвердить оплату. Проверьте личный кабинет.');
    } finally { operationActive = false; busy.current = false; paying.current = false; setProcessing(false); }
  }

  return createPortal(<div className="subscription-auth-overlay subscription-code-overlay" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <button type="button" className="subscription-auth-backdrop" aria-label="Закрыть промокод" onClick={close} disabled={paying.current} tabIndex={-1} />
    <section ref={panel} className="subscription-auth-block">
      <button type="button" className="subscription-auth-close" aria-label="Закрыть промокод" onClick={close} disabled={paying.current}>×</button>
      <h2 id={`${id}-title`} className="subscription-auth-title">Промокод</h2>
      <p className="subscription-auth-caption">{title}</p>
      {auth.isRestoringSession ? <p role="status">Проверяем вход…</p> : !authenticated ? <><p>Войдите, чтобы проверить промокод.</p><AuthForm onLogin={() => {}} /></>
        : settled ? <p role="status">Оплата подтверждена. Проверьте абонемент в личном кабинете.</p>
          : <>
            <form onSubmit={event => { event.preventDefault(); void apply(); }}>
              <label htmlFor={`${id}-code`}>Промокод</label>
              <div className="subscription-code-controls">
                <input id={`${id}-code`} value={draft} placeholder="Введите промокод" autoComplete="off" disabled={processing}
                  aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
                  onChange={event => { generation.current += 1; setDraft(event.target.value); setQuote(null); setError(null); }} />
                <button type="submit" className="auth-btn" disabled={processing || !draft.trim()}>{processing ? 'Проверяем…' : 'Применить'}</button>
              </div>
            </form>
            {currentQuote && <div className="subscription-code-price" role="status">
              <p>Промокод применён. Скидка {money(currentQuote.price.discountMinor)}.</p>
              <p><s>{money(currentQuote.price.sumMinor)}</s> <strong>К оплате {money(currentQuote.price.toPayMinor)}</strong></p>
              {billingOptionId === 'annual' && <label className="subscription-consent">
                <input type="checkbox" checked={annualTermsAccepted} disabled={processing} onChange={event => setAnnualTermsAccepted(event.target.checked)} />
                <span>Я ознакомился(ась) и согласен(на) с условиями годовой подписки</span>
              </label>}
              <button type="button" className="auth-btn" disabled={processing || (billingOptionId === 'annual' && !annualTermsAccepted)} onClick={() => { void pay(); }}>
                {processing ? 'Создаём оплату…' : `Оформить за ${money(currentQuote.price.toPayMinor)}`}
              </button>
            </div>}
          </>}
      {error && <p id={`${id}-error`} className="auth-error" role="alert">{error}</p>}
    </section>
  </div>, document.body);
}
