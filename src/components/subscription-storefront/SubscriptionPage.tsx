import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetchTournamentSubscriptionStatus } from '../../utils/apiClient';
import { CABINET_URL } from '../../consts/api_config';
import { useAuth } from '../../context/AuthContext';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { StorefrontLogin } from './StorefrontLogin';
import { summerPlanPresentation, friendshipVariantBenefits } from './presentation';
import {
  billingFromStatus, canContinue, storefrontPlanKeys, friendshipBillingOptions, scopedStorefrontStatuses,
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

/** Billing option that requires an explicit terms confirmation before payment. */
const CONSENT_REQUIRED_OPTION_ID = 'annual';
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

  const handleChoose = useCallback(async (selection: SubscriptionPlanSelection, resumeAuth = false) => {
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
    if (billingOptionId === CONSENT_REQUIRED_OPTION_ID && !annualTermsAccepted) {
      setFailure('Подтвердите согласие с условиями годовой подписки');
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
      if (resumeAuth) setAuthRequested(false);
    } catch (paymentError) {
      setFailure(paymentError instanceof StorefrontPaymentError
        ? paymentError.message
        : 'Не удалось создать оплату. Попробуйте ещё раз.');
    } finally {
      paymentInFlightRef.current = false;
      setProcessing(false);
    }
  }, [annualTermsAccepted, isAuthenticated, previewView]);

  const plans = storefrontPlanKeys.flatMap(key => {
    const status = statuses?.find(item => item.counterKey === key);
    if (!status && key !== 'friendship') return [];
    const billingOptions = key === 'friendship'
      ? friendshipBillingOptions(statuses ?? [], error).map(option => ({
        ...option,
        benefitGroups: friendshipVariantBenefits[option.id],
      }))
      : status ? billingFromStatus(status) : [];
    if (!billingOptions.length) return [];
    return [{
      ...summerPlanPresentation[key], id: key, billingOptions,
      ctaLabel: processing ? 'Создаём оплату…' : 'Оформить подписку',
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
      {!previewView && isAuthenticated && (
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
      )}
      <SubscriptionStorefront view={view} onBack={onBack} onChoose={selection => { void handleChoose(selection); }} />
    </>}
    {!previewView && authRequested && (isAuthenticated ? (
      <div className="subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="subscription-auth-title">
        <button
          type="button"
          className="subscription-auth-overlay__backdrop"
          aria-label="Закрыть окно авторизации"
          onClick={() => setAuthRequested(false)}
        />
        <section className="subscription-auth-overlay__block">
          <h2 id="subscription-auth-title">Вы вошли в личный кабинет</h2>
          <p>Продолжите оформление подписки — мы сразу откроем страницу оплаты банка.</p>
          {failure && <p className="subscription-login__error" role="alert">{failure}</p>}
          <button
            type="button"
            className="subscription-login__submit"
            disabled={processing}
            onClick={() => {
              if (pendingSelection) void handleChoose(pendingSelection, true);
            }}
          >
            {processing ? 'Создаём оплату…' : 'Продолжить оплату'}
          </button>
          <button
            type="button"
            className="subscription-login__resend"
            onClick={() => { setAuthRequested(false); setPendingSelection(null); }}
          >
            Отмена
          </button>
        </section>
      </div>
    ) : (
      <div className="subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="subscription-auth-title">
        <button
          type="button"
          className="subscription-auth-overlay__backdrop"
          aria-label="Закрыть окно авторизации"
          onClick={() => { setAuthRequested(false); setPendingSelection(null); }}
        />
        <section className="subscription-auth-overlay__block">
          <button
            type="button"
            className="subscription-auth-overlay__close"
            aria-label="Закрыть окно авторизации"
            onClick={() => { setAuthRequested(false); setPendingSelection(null); }}
          >
            ×
          </button>
          <h2 id="subscription-auth-title">Оформление подписки</h2>
          <p>Войдите, чтобы перейти к оплате.</p>
          <StorefrontLogin onCancel={() => { setAuthRequested(false); setPendingSelection(null); }} />
        </section>
      </div>
    ))}
  </>;
}
