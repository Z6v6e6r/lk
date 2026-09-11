import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetchTournamentSubscriptionStatus } from '../../utils/apiClient';
import { CABINET_URL } from '../../consts/api_config';
import { useAuth } from '../../context/AuthContext';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { AuthForm } from '../auth/AuthForm';
import { summerPlanPresentation, friendshipVariantBenefits } from './presentation';
import {
  billingFromStatus, canContinue, energy5BillingOptions, requiresAnnualTermsConsent, storefrontPlanKeys,
  friendshipBillingOptions, scopedStorefrontStatuses,
  type StorefrontStatus,
} from './catalog';
import type { SubscriptionPlanSelection, SubscriptionStorefrontView } from './model';
import { loadTournamentSubscriptionStatuses } from '../../utils/tournamentSubscriptionStatusLoader';
import {
  StorefrontPaymentError,
  clearStorefrontPaymentRef,
  confirmStorefrontPayment,
  createStorefrontSubscriptionPayment,
  readPendingPaymentEntries,
  readStorefrontPaymentRef,
  resolvePaymentPhone,
  resolveStorefrontBillingTarget,
  type PendingPaymentEntry,
  type StorefrontBillingOptionId,
} from './payment';
import markUrl from './assets/brand/подписка.svg';

const PAYMENT_CONFIRM_ATTEMPTS = 3;
const PAYMENT_CONFIRM_RETRY_MS = 4000;

export function SubscriptionPage({ onBack, cabinetUrl, previewView }: {
  onBack?: () => void;
  cabinetUrl?: string | null;
  previewView?: SubscriptionStorefrontView;
}) {
  const { isAuthenticated } = useAuth();
  const [statuses, setStatuses] = useState<readonly StorefrontStatus[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [annualTermsAccepted, setAnnualTermsAccepted] = useState(false);
  const [authRequested, setAuthRequested] = useState(false);
  const [consentRequested, setConsentRequested] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<SubscriptionPlanSelection | null>(null);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const paymentInFlightRef = useRef(false);
  const confirmationStartedRef = useRef(false);

  useEffect(() => {
    if (previewView) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function refresh() {
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 12_000);
      try {
        const signal = controller.signal;
        const result = await loadTournamentSubscriptionStatuses(
          [{ counterKey: 'network_friendship' }],
          async params => {
            const response = await apiFetchTournamentSubscriptionStatus(params ?? {}, { signal });
            return { ...response, data: response.data ? scopedStorefrontStatuses(response.data, params?.counterKey) : null };
          },
        );
        if (cancelled) return;
        if (result.aggregateResult.error || !result.aggregateResult.data) throw new Error('Status unavailable');
        setStatuses(result.statuses.filter(status => !result.failedExplicitCounterKeys.includes(status.counterKey ?? '')));
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        clearTimeout(deadline);
        // A request completes before another is scheduled: responses cannot race.
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 30_000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [attempt, previewView]);

  /**
   * Confirms a payment created by this widget once the bank returns the visitor
   * to this page: the bank redirect carries the payment reference in the URL.
   * Only a confirmed payment sends the visitor to the cabinet.
   */
  useEffect(() => {
    if (previewView || confirmationStartedRef.current) return;
    const urlPaymentRef = readStorefrontPaymentRef(window.location.search);
    if (!urlPaymentRef) return;
    confirmationStartedRef.current = true;

    const stored = readPendingPaymentEntries().find(entry => entry.paymentRef === urlPaymentRef);
    const entry: PendingPaymentEntry = stored ?? {
      paymentRef: urlPaymentRef,
      counterKey: null,
      planId: null,
      campaignKey: null,
      createdAt: new Date().toISOString(),
    };

    let cancelled = false;
    void (async () => {
      for (let attemptIndex = 0; attemptIndex < PAYMENT_CONFIRM_ATTEMPTS; attemptIndex += 1) {
        const result = await confirmStorefrontPayment(entry);
        if (cancelled) return;
        setNotice(result.message);
        if (result.status !== 'pending') {
          clearStorefrontPaymentRef();
          const target = (cabinetUrl || CABINET_URL || '').trim();
          if (result.status === 'paid' && target && typeof window !== 'undefined') {
            window.setTimeout(() => { window.location.href = target; }, 1200);
          }
          return;
        }
        await new Promise(resolve => setTimeout(resolve, PAYMENT_CONFIRM_RETRY_MS));
        if (cancelled) return;
      }
      if (!cancelled) {
        setNotice('Платёж ещё обрабатывается банком. Статус обновится автоматически.');
        clearStorefrontPaymentRef();
      }
    })();

    return () => { cancelled = true; };
  }, [cabinetUrl, previewView]);

  const handleChoose = useCallback(async (selection: SubscriptionPlanSelection, resumeFlow = false) => {
    if (previewView || paymentInFlightRef.current) return;
    setFailure(null);
    setNotice(null);

    const billingOptionId = selection.billingOptionId as StorefrontBillingOptionId;
    const target = resolveStorefrontBillingTarget(selection.planId, billingOptionId);
    if (!target) {
      setFailure('Этот вариант подписки пока недоступен для оплаты');
      return;
    }
    if (!isAuthenticated) {
      setPendingSelection(selection);
      setAuthRequested(true);
      return;
    }
    if (requiresAnnualTermsConsent(billingOptionId, annualTermsAccepted)) {
      // Условия годовой подписки показываем только после нажатия «Оформить подписку».
      setPendingSelection(selection);
      setConsentRequested(true);
      if (resumeFlow) setAuthRequested(false);
      return;
    }

    paymentInFlightRef.current = true;
    setProcessing(true);
    try {
      const phone = await resolvePaymentPhone();
      const outcome = await createStorefrontSubscriptionPayment({
        planId: selection.planId,
        billingOptionId,
        phone,
      });
      if (outcome.status === 'redirect') {
        setPendingSelection(null);
        window.location.href = outcome.paymentUrl;
        return;
      }
      setNotice(outcome.message);
      setAttempt(value => value + 1);
      if (resumeFlow) {
        setAuthRequested(false);
        setConsentRequested(false);
      }
    } catch (paymentError) {
      setFailure(paymentError instanceof StorefrontPaymentError
        ? paymentError.message
        : 'Не удалось создать оплату. Попробуйте ещё раз.');
    } finally {
      paymentInFlightRef.current = false;
      setProcessing(false);
    }
  }, [annualTermsAccepted, isAuthenticated, previewView]);

  const closeConsentDialog = useCallback(() => {
    setConsentRequested(false);
    setPendingSelection(null);
    setFailure(null);
  }, []);

  const plans = storefrontPlanKeys.flatMap(key => {
    const status = statuses?.find(item => item.counterKey === key);
    if (!status && key !== 'friendship') return [];
    const billingOptions = key === 'friendship'
      ? friendshipBillingOptions(statuses ?? [], error).map(option => ({
        ...option,
        benefitGroups: friendshipVariantBenefits[option.id],
      }))
      : key === 'energy5'
        ? energy5BillingOptions(status)
        : status ? billingFromStatus(status) : [];
    if (!billingOptions.length) return [];
    return [{
      ...summerPlanPresentation[key], id: key, billingOptions,
      ctaLabel: processing
        ? 'Создаём оплату…'
        : (key === 'energy5' ? 'Оформить абонемент' : 'Оформить подписку'),
      ctaDisabled: processing || (key === 'friendship' ? error : !status || !canContinue(status, error)),
    }];
  });
  const view = previewView ?? {
    id: 'lk1-subscriptions', title: 'Играй в падел выгодно',
    description: 'Выберите подписку под свой ритм игры', markUrl, markAlt: 'Подписка',
    sections: [{ id: 'subscriptions-monthly', plans }],
  };

  return <>
    {!previewView && (!statuses || error || !plans.length) && <div className="subscription-storefront" style={{ minHeight: 0 }}>
      <div className="subscription-status-message" role={error ? 'alert' : 'status'}>
        {error ? 'Не удалось обновить подписки. Попробуйте ещё раз.' :
          !statuses ? 'Загружаем подписки…' : 'Сейчас нет доступных предложений.'}
        {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>}
      </div>
    </div>}
    {(previewView || statuses) && <>
      {notice && <p className="subscription-status-message" role="status">{notice}</p>}
      {failure && <p className="subscription-status-message subscription-status-message--error" role="alert">{failure}</p>}
      <SubscriptionStorefront view={view} onBack={onBack} onChoose={selection => { void handleChoose(selection); }} />
    </>}
    {!previewView && authRequested && (
      <div className="subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="subscription-auth-title">
        <button
          type="button"
          className="subscription-auth-backdrop"
          aria-label="Закрыть окно авторизации"
          onClick={() => { setAuthRequested(false); setPendingSelection(null); }}
        />
        <section className="subscription-auth-block">
          <button
            type="button"
            className="subscription-auth-close"
            aria-label="Закрыть окно авторизации"
            onClick={() => { setAuthRequested(false); setPendingSelection(null); }}
          >
            ×
          </button>
          <h2 id="subscription-auth-title" className="subscription-auth-title">
            {isAuthenticated ? 'Вы вошли в личный кабинет' : 'Оформление подписки'}
          </h2>
          <p className="subscription-auth-caption">
            {isAuthenticated
              ? 'Продолжите оформление — мы сразу откроем страницу оплаты банка.'
              : 'Войдите, чтобы продолжить оплату.'}
          </p>
          {isAuthenticated ? (
            <>
              {failure && <p className="auth-error" role="alert">{failure}</p>}
              <button
                type="button"
                className="auth-btn"
                disabled={processing}
                onClick={() => {
                  if (pendingSelection) void handleChoose(pendingSelection, true);
                }}
              >
                {processing ? 'Создаём оплату…' : 'Продолжить оплату'}
              </button>
            </>
          ) : (
            <AuthForm onLogin={() => {}} />
          )}
        </section>
      </div>
    )}
    {!previewView && consentRequested && isAuthenticated && (
      <div className="subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="subscription-consent-title">
        <button
          type="button"
          className="subscription-auth-backdrop"
          aria-label="Закрыть подтверждение условий годовой подписки"
          onClick={closeConsentDialog}
        />
        <section className="subscription-auth-block">
          <button
            type="button"
            className="subscription-auth-close"
            aria-label="Закрыть подтверждение условий годовой подписки"
            onClick={closeConsentDialog}
          >
            ×
          </button>
          <h2 id="subscription-consent-title" className="subscription-auth-title">
            Оформление годовой подписки
          </h2>
          <p className="subscription-auth-caption">
            Подтвердите согласие с условиями годовой подписки — и мы сразу откроем страницу оплаты банка.
          </p>
          {failure && <p className="auth-error" role="alert">{failure}</p>}
          <label className="subscription-consent">
            <input
              type="checkbox"
              checked={annualTermsAccepted}
              onChange={event => {
                const checked = event.target.checked;
                setAnnualTermsAccepted(checked);
                if (checked) setFailure(null);
              }}
            />
            <span>Я ознакомился(ась) и согласен(на) с условиями годовой подписки</span>
          </label>
          <button
            type="button"
            className="auth-btn"
            disabled={!annualTermsAccepted || processing}
            onClick={() => { if (pendingSelection) void handleChoose(pendingSelection, true); }}
          >
            {processing ? 'Создаём оплату…' : 'Продолжить оплату'}
          </button>
        </section>
      </div>
    )}
  </>;
}
