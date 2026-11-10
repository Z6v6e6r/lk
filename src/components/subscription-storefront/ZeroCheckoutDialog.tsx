import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCheckoutAuthEvent } from './CheckoutAuthProvider';
import { isCheckoutReturn } from './zeroCheckoutOffers';
import { bindFastQuote, cancelFastIntent, claimFastIntent, readFastIntent } from './zeroCheckoutIntent';
import { checkoutSessionToken, verifyFastCheckoutSession, type FastCheckoutSession } from './zeroCheckoutSession';
import { useAuth } from '../../context/AuthContext';
import { AuthForm } from '../auth/AuthForm';
import { CABINET_URL } from '../../consts/api_config';
import { resolvePaymentPhone, StorefrontPaymentError } from './payment';
import { resolvePromoCabinetUrl } from './promo';
import { PATRIOTS_PLAN_ID } from './catalog';
import { confirmZeroPayment, createZeroPayment, hasZeroAttempt, loadZeroOfferPrice, loadResidencyPurchaseTerms, resolveZeroOffer, withZeroDeadline, ZERO_PENDING_MESSAGE } from './zeroCheckoutPayment';
import { RESIDENCY_OFFER_KEY, type ResidencyPurchaseTerms } from '../../residency/residencyPurchase';
import './zero-checkout.css';

export function ZeroCheckoutDialog({ offerKey, onClose, onBusy, fast }: {
  offerKey: string; onClose: () => void; onBusy: (busy: boolean) => void;
  fast?: FastCheckoutSession;
}) {
  const auth = useAuth();
  const offer = useMemo(() => resolveZeroOffer(offerKey)!, [offerKey]);
  const authEvent = useCheckoutAuthEvent();
  const [fastActive, setFastActive] = useState(Boolean(fast));
  const fastStarted = useRef(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const patriotsPendingBenefits = offerKey === PATRIOTS_PLAN_ID;
  const isResidency = offerKey === RESIDENCY_OFFER_KEY;
  const [residencyTerms, setResidencyTerms] = useState<ResidencyPurchaseTerms | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [blocked, setBlocked] = useState(() => hasZeroAttempt(offerKey) || isCheckoutReturn());
  const [terms, setTerms] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const authenticated = auth.isAuthenticated && !auth.isRestoringSession && !auth.isLoading && !auth.needsPhoneVerification;
  const authReady = useRef(authenticated);
  useEffect(() => { authReady.current = authenticated; }, [authenticated]);

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    const onStorage = () => { if (hasZeroAttempt(offerKey)) setBlocked(true); };
    const visibility = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', onStorage);
    return () => {
      alive.current = false;
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', visibility);
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [offerKey]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let active = true;
    const priceRequest = isResidency ? loadResidencyPurchaseTerms(controller.signal).then(value => {
      if (active) setResidencyTerms(value);
      return value.priceMinor;
    }) : loadZeroOfferPrice(offerKey, controller.signal);
    void priceRequest.then(value => {
      if (active) { setPrice(value); setLoading(false); }
    }).catch(() => {
      if (active) { if (fast) cancelFastIntent(fast.id); setFastActive(false); setError(isResidency ? 'Не удалось подтвердить условия резидентства. Обновите данные.' : 'Не удалось подтвердить цену и доступность. Обновите данные.'); setLoading(false); }
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [offerKey, revision, isResidency, fast]);

  const submit = useCallback(async (checkOnly = false, automatic = false) => {
    if (!authenticated || busy.current || (!checkOnly && (blocked || loading || price === null || ((offer.billingOptionId === 'annual' || patriotsPendingBenefits) && !terms)))) return;
    busy.current = true; onBusy(true); setProcessing(true); setError(null);
    let operationActive = true;
    const session = checkoutSessionToken();
    try {
      if (automatic) {
        if (!session || !fast) throw new StorefrontPaymentError('Войдите в аккаунт перед оплатой.');
        await verifyFastCheckoutSession(fast, authEvent.interactiveIdentity);
        if (checkoutSessionToken() !== session || !alive.current || !authReady.current || document.hidden) {
          throw new StorefrontPaymentError('Аккаунт изменился. Подтвердите покупку в текущем аккаунте.');
        }
        if (!residencyTerms || !claimFastIntent(fast.id, residencyTerms)) throw new StorefrontPaymentError('Подтвердите предложение заново.');
      }
      if (checkOnly) {
        const result = await withZeroDeadline(confirmZeroPayment(offerKey));
        if (alive.current) setMessage(result.message);
        return;
      }
      const phone = await withZeroDeadline(resolvePaymentPhone(), 12_000);
      if (!alive.current || !authReady.current) return;
      const result = await withZeroDeadline(createZeroPayment(offerKey, phone, price!, () => operationActive && alive.current && authReady.current && checkoutSessionToken() === session
        && (!automatic || !!fast && readFastIntent(fast.id)?.phase === 'claimed' && !document.hidden), residencyTerms));
      if (!alive.current) return;
      setBlocked(true);
      if (result.status === 'redirect') window.location.assign(result.paymentUrl);
      else setMessage(result.message);
    } catch (failure) {
      if (fast) cancelFastIntent(fast.id);
      if (alive.current) {
        setFastActive(false);
        setBlocked(hasZeroAttempt(offerKey));
        setError(failure instanceof StorefrontPaymentError ? failure.message : 'Не удалось проверить результат. Попробуйте проверить статус позже.');
      }
    } finally {
      operationActive = false;
      busy.current = false; onBusy(false);
      if (alive.current) setProcessing(false);
    }
  }, [authenticated, blocked, loading, price, offer.billingOptionId, patriotsPendingBenefits, terms, onBusy, offerKey, residencyTerms, fast, authEvent.interactiveIdentity]);

  useEffect(() => {
    if (!fast || !fastActive || fastStarted.current || blocked || loading || !residencyTerms) return;
    try { bindFastQuote(fast.id, residencyTerms); }
    catch (failure) {
      cancelFastIntent(fast.id); setFastActive(false);
      setError(failure instanceof Error ? failure.message : 'Подтвердите предложение заново.'); return;
    }
    if (!authenticated || authEvent.pending || !foreground) return;
    if (!fast.initialIdentity && !fast.sessionBinding && !authEvent.interactiveIdentity) {
      cancelFastIntent(fast.id); setFastActive(false); return;
    }
    fastStarted.current = true;
    void submit(false, true);
  }, [fast, fastActive, blocked, loading, residencyTerms, authenticated, authEvent.pending, authEvent.interactiveIdentity, foreground, submit]);

  return <dialog ref={dialog} className="subscription-auth-block ph-zero-dialog" aria-labelledby="ph-zero-title"
    onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <button type="button" className="subscription-auth-close" aria-label="Закрыть оформление" disabled={processing} onClick={onClose}>×</button>
    <h2 id="ph-zero-title">{fastActive ? authenticated || auth.isRestoringSession ? 'Готовим оплату' : 'Вход для оплаты' : 'Оформление подписки'}</h2>
    <p className="ph-zero-summary">{offer.label} · {offer.period}</p>
    <p className="ph-zero-price">{price === null ? 'Проверяем предложение…' : `${new Intl.NumberFormat('ru-RU').format(price / 100)} ₽`}</p>
    {isResidency && residencyTerms && price !== null && <p>30 записей на 30 дней. Автоматическая активация отключена.</p>}
    {offer.promo && <p>Акционная цена. Применимость предложения проверяется при оформлении.</p>}
    {patriotsPendingBenefits && <p>Подписка содержит 30 посещений на 30 дней. Бесплатный час и скидки при записи пока не действуют; дата запуска не определена. «Время на друзей» не списывает посещения из подписки.</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {(message || blocked) && <p role="status">{message || ZERO_PENDING_MESSAGE}</p>}
    {auth.isRestoringSession ? <p role="status">Проверяем вход…</p> : !authenticated ? (!fastActive || residencyTerms ? <AuthForm onLogin={() => {}} /> : <p role="status">Проверяем предложение…</p>) : <>
      {!blocked && offer.billingOptionId === 'annual' && <label className="ph-zero-consent">
        <input type="checkbox" checked={terms} disabled={processing} onChange={event => setTerms(event.target.checked)} />
        <span>Я ознакомился(ась) и согласен(на) с условиями годовой подписки</span>
      </label>}
      {!blocked && patriotsPendingBenefits && <label className="ph-zero-consent">
        <input type="checkbox" checked={terms} disabled={processing} onChange={event => setTerms(event.target.checked)} />
        <span>Я понимаю, что бесплатный час и скидки пока не действуют, а дата запуска не определена.</span>
      </label>}
      {!blocked && fastActive && <p role="status">{processing ? 'Готовим ссылку банка…' : 'Проверяем предложение и вход…'}</p>}
      {!blocked && !fastActive && <button className="auth-btn" type="button" disabled={loading || price === null || processing || ((offer.billingOptionId === 'annual' || patriotsPendingBenefits) && !terms)} onClick={() => { void submit(); }}>
        {processing ? 'Создаём оплату…' : fast ? `Оплатить ${new Intl.NumberFormat('ru-RU').format((price || 0) / 100)} ₽` : 'Перейти к оплате'}
      </button>}
      {blocked && offer.target && !offer.target.directProductId && <button className="auth-btn" type="button" disabled={processing} onClick={() => { void submit(true); }}>
        {processing ? 'Проверяем статус…' : 'Проверить статус оплаты'}
      </button>}
    </>}
    {!blocked && !loading && !processing && <button className="ph-zero-refresh" type="button" onClick={() => { setError(null); setResidencyTerms(null); setPrice(null); setLoading(true); setRevision(value => value + 1); }}>Обновить данные</button>}
    <p className="ph-zero-caption">{processing ? 'Дождитесь результата. Не закрывайте страницу.' : blocked ? 'Проверка статуса не создаёт новую покупку.' : fastActive ? 'После входа откроется защищённая страница банка для выбранной подписки.' : 'После подтверждения откроется защищённая страница банка.'}</p>
    <a className="ph-zero-cabinet" href={resolvePromoCabinetUrl(window.location.href, CABINET_URL)}>Личный кабинет</a>
  </dialog>;
}
