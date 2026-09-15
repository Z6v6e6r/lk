import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { AuthForm } from '../auth/AuthForm';
import { CABINET_URL } from '../../consts/api_config';
import { resolvePaymentPhone, StorefrontPaymentError } from './payment';
import { resolvePromoCabinetUrl } from './promo';
import { confirmZeroPayment, createZeroPayment, hasZeroAttempt, loadZeroOfferPrice, resolveZeroOffer, withZeroDeadline, ZERO_PENDING_MESSAGE } from './zeroCheckoutPayment';
import './zero-checkout.css';

export function ZeroCheckoutDialog({ offerKey, onClose, onBusy }: {
  offerKey: string; onClose: () => void; onBusy: (busy: boolean) => void;
}) {
  const auth = useAuth();
  const offer = resolveZeroOffer(offerKey)!;
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [blocked, setBlocked] = useState(() => hasZeroAttempt(offerKey));
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
    window.addEventListener('storage', onStorage);
    return () => {
      alive.current = false;
      window.removeEventListener('storage', onStorage);
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [offerKey]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let active = true;
    void loadZeroOfferPrice(offerKey, controller.signal).then(value => {
      if (active) { setPrice(value); setLoading(false); }
    }).catch(() => {
      if (active) { setError('Не удалось подтвердить цену и доступность. Обновите данные.'); setLoading(false); }
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; controller.abort(); clearTimeout(timeout); };
  }, [offerKey, revision]);

  async function submit(checkOnly = false) {
    if (!authenticated || busy.current || (!checkOnly && (blocked || loading || price === null || (offer.billingOptionId === 'annual' && !terms)))) return;
    busy.current = true; onBusy(true); setProcessing(true); setError(null);
    let operationActive = true;
    try {
      if (checkOnly) {
        const result = await withZeroDeadline(confirmZeroPayment(offerKey));
        if (alive.current) setMessage(result.message);
        return;
      }
      const phone = await withZeroDeadline(resolvePaymentPhone(), 12_000);
      if (!alive.current || !authReady.current) return;
      const result = await withZeroDeadline(createZeroPayment(offerKey, phone, price!, () => operationActive && alive.current && authReady.current));
      if (!alive.current) return;
      setBlocked(true);
      if (result.status === 'redirect') window.location.assign(result.paymentUrl);
      else setMessage(result.message);
    } catch (failure) {
      if (alive.current) {
        setBlocked(hasZeroAttempt(offerKey));
        setError(failure instanceof StorefrontPaymentError ? failure.message : 'Не удалось проверить результат. Попробуйте проверить статус позже.');
      }
    } finally {
      operationActive = false;
      busy.current = false; onBusy(false);
      if (alive.current) setProcessing(false);
    }
  }

  return <dialog ref={dialog} className="subscription-auth-block ph-zero-dialog" aria-labelledby="ph-zero-title"
    onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <button type="button" className="subscription-auth-close" aria-label="Закрыть оформление" disabled={processing} onClick={onClose}>×</button>
    <h2 id="ph-zero-title">Оформление подписки</h2>
    <p className="ph-zero-summary">{offer.label} · {offer.period}</p>
    <p className="ph-zero-price">{price === null ? 'Проверяем предложение…' : `${new Intl.NumberFormat('ru-RU').format(price / 100)} ₽`}</p>
    {offer.promo && <p>Акционная цена. Применимость предложения проверяется при оформлении.</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {(message || blocked) && <p role="status">{message || ZERO_PENDING_MESSAGE}</p>}
    {auth.isRestoringSession ? <p role="status">Проверяем вход…</p> : !authenticated ? <AuthForm onLogin={() => {}} /> : <>
      {!blocked && offer.billingOptionId === 'annual' && <label className="ph-zero-consent">
        <input type="checkbox" checked={terms} disabled={processing} onChange={event => setTerms(event.target.checked)} />
        <span>Я ознакомился(ась) и согласен(на) с условиями годовой подписки</span>
      </label>}
      {!blocked && <button className="auth-btn" type="button" disabled={loading || price === null || processing || (offer.billingOptionId === 'annual' && !terms)} onClick={() => { void submit(); }}>
        {processing ? 'Создаём оплату…' : 'Перейти к оплате'}
      </button>}
      {blocked && offer.target && !offer.target.directProductId && <button className="auth-btn" type="button" disabled={processing} onClick={() => { void submit(true); }}>
        {processing ? 'Проверяем статус…' : 'Проверить статус оплаты'}
      </button>}
    </>}
    {!blocked && !loading && !processing && <button className="ph-zero-refresh" type="button" onClick={() => { setError(null); setPrice(null); setLoading(true); setRevision(value => value + 1); }}>Обновить данные</button>}
    <p className="ph-zero-caption">{processing ? 'Дождитесь результата. Не закрывайте страницу.' : blocked ? 'Проверка статуса не создаёт новую покупку.' : 'После подтверждения откроется защищённая страница банка.'}</p>
    <a className="ph-zero-cabinet" href={resolvePromoCabinetUrl(window.location.href, CABINET_URL)}>Личный кабинет</a>
  </dialog>;
}
