import { hasZeroAttempt, resolveZeroOffer } from './zeroCheckoutPayment';
import { startCheckout } from './zeroCheckoutMount';
import { fastOfferKey } from './zeroCheckoutOffers';
import { SubscriptionPromoCodeDialog } from './SubscriptionPromoCodeDialog';
import { useEffect, useRef, useState } from 'react';
import { apiFetchTournamentSubscriptionStatus, apiGetSubscriptionProduct } from '../../utils/apiClient';
import { CABINET_URL } from '../../consts/api_config';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { summerPlanPresentation, friendshipVariantBenefits, atlantyPlanPresentation } from './presentation';
import {
  billingFromStatus, canContinue, energy5BillingOptions, storefrontPlanKeysForSearch,
  friendshipBillingOptions, scopedStorefrontStatuses,
  ATLANTY_PLAN_ID, ATLANTY_VARIANT, FRIENDSHIP_TWO_HOURS_PRODUCT_ID, atlantyBillingOptions, normalizeStorefrontVariant,
  parseFriendshipTwoHoursProduct, type StorefrontStatus,
} from './catalog';
import type { SubscriptionPlanSelection, SubscriptionStorefrontView } from './model';
import { loadTournamentSubscriptionStatuses } from '../../utils/tournamentSubscriptionStatusLoader';
import {
  StorefrontPaymentError,
  clearStorefrontPaymentRef,
  confirmStorefrontPayment,
  readPendingPaymentEntries,
  readStorefrontPaymentRef,
  resolveStorefrontPromoTarget,
  type PendingPaymentEntry,
  type StorefrontBillingOptionId,
} from './payment';
import markUrl from './assets/brand/подписка.svg';

const PAYMENT_CONFIRM_ATTEMPTS = 3;
const PAYMENT_CONFIRM_RETRY_MS = 4000;

export function SubscriptionPage({ onBack, cabinetUrl, previewView, variant }: {
  onBack?: () => void;
  cabinetUrl?: string | null;
  previewView?: SubscriptionStorefrontView;
  /** Variant requested by the hosting Tilda block; URL `variant` is the fallback. */
  variant?: string | null;
}) {
  const searchVariant = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('variant');
  // An empty host value (a Tilda block whose data prop is blank) must not shadow
  // the documented `?variant=` fallback.
  const isAtlantyVariant = (normalizeStorefrontVariant(variant) ?? normalizeStorefrontVariant(searchVariant)) === ATLANTY_VARIANT;
  const [statuses, setStatuses] = useState<readonly StorefrontStatus[] | null>(null);
  /** Provider price of the two-hour product, verified together with its direction scope. */
  const [twoHourProductPriceMinor, setTwoHourProductPriceMinor] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [promoSelection, setPromoSelection] = useState<{ productId: string; title: string; planId: string; billingOptionId: StorefrontBillingOptionId } | null>(null);
  const [notice, setNotice] = useState<string | null>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('subscriptionPromoReturn') === '1'
    ? 'Покупка отправлена в Viva. Проверьте абонементы в личном кабинете; если результат неясен, обратитесь в поддержку.' : null);
  const [failure, setFailure] = useState<string | null>(null);
  const confirmationStartedRef = useRef(false);

  useEffect(() => {
    // The club page sells direct products, so it has no counter to poll.
    if (previewView || isAtlantyVariant) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function refresh() {
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 12_000);
      try {
        const signal = controller.signal;
        const [result, twoHourProduct, twoHourStatus] = await Promise.all([loadTournamentSubscriptionStatuses(
          [{ counterKey: 'network_friendship' }],
          async params => {
            const response = await apiFetchTournamentSubscriptionStatus(params ?? {}, { signal });
            return { ...response, data: response.data ? scopedStorefrontStatuses(response.data, params?.counterKey) : null };
          },
        ), apiGetSubscriptionProduct(FRIENDSHIP_TWO_HOURS_PRODUCT_ID, { signal }).catch(() => null),
        apiFetchTournamentSubscriptionStatus({ counterKey: 'friendship_two_hours' }, { signal }).catch(() => null)]);
        if (cancelled) return;
        setTwoHourProductPriceMinor(twoHourProduct && !twoHourProduct.error
          ? parseFriendshipTwoHoursProduct(twoHourProduct.data) : null);
        if (result.aggregateResult.error || !result.aggregateResult.data) throw new Error('Status unavailable');
        setStatuses([
          ...result.statuses.filter(status => !result.failedExplicitCounterKeys.includes(status.counterKey ?? '')),
          ...(!twoHourStatus?.error && Array.isArray(twoHourStatus?.data)
            ? scopedStorefrontStatuses(twoHourStatus.data, 'friendship_two_hours') : []),
        ]);
        setError(false);
      } catch {
        if (!cancelled) { setTwoHourProductPriceMinor(null); setError(true); }
      } finally {
        clearTimeout(deadline);
        // A request completes before another is scheduled: responses cannot race.
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 30_000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [previewView, isAtlantyVariant]);

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

  useEffect(() => {
    const onCheckoutNotice = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail;
      if (typeof message === 'string') setNotice(message);
    };
    window.addEventListener('padlhub:checkout-notice', onCheckoutNotice);
    return () => window.removeEventListener('padlhub:checkout-notice', onCheckoutNotice);
  }, []);

  function handleChoose(selection: SubscriptionPlanSelection, gesture?: Event) {
    if (previewView || !gesture) return;
    const key = fastOfferKey(selection.planId, selection.billingOptionId);
    const option = plans.find(p => p.id === selection.planId)?.billingOptions.find(b => b.id === selection.billingOptionId);
    try {
      if (!key || !option || option.ctaDisabled || !option.canResume && option.priceMinor === null) throw new StorefrontPaymentError('Этот вариант подписки пока недоступен для оплаты');
      startCheckout(key, option.priceMinor ?? 0, gesture);
    } catch (failure) { setFailure(failure instanceof Error ? failure.message : 'Не удалось открыть оформление.'); }
  }

  const planKeys = storefrontPlanKeysForSearch(typeof window === 'undefined' ? '' : window.location.search);
  const basePlans = isAtlantyVariant
    ? [{
      ...atlantyPlanPresentation,
      id: ATLANTY_PLAN_ID,
      billingOptions: atlantyBillingOptions(),
      ctaLabel: 'Оплатить',
      ctaDisabled: false,
    }]
    : planKeys.flatMap(key => {
      const status = statuses?.find(item => item.counterKey === key);
      if (!status && key !== 'friendship' && !hasZeroAttempt(key)) return [];
      const billingOptions = key === 'friendship'
        ? friendshipBillingOptions(statuses ?? [], error, twoHourProductPriceMinor).map(option => ({
          ...option,
          benefitGroups: friendshipVariantBenefits[option.id],
        }))
        : key === 'energy5'
          ? (status ? energy5BillingOptions(status) : [{ id: 'monthly', label: '60 дней, 5 занятий', priceMinor: null }])
          : status ? billingFromStatus(status) : [{ id: 'monthly', label: resolveZeroOffer(key)?.period ?? '30 дней', priceMinor: null }];
      if (!billingOptions.length) return [];
      return [{
        ...summerPlanPresentation[key], id: key, billingOptions,
        ctaLabel: 'Оплатить',
        ctaDisabled: (key === 'friendship' ? error : !status || !canContinue(status, error)),
      }];
    });
  const plans = basePlans.map(plan => {
    const pending = plan.billingOptions.some(option => {
      const key = fastOfferKey(plan.id, option.id);
      return key && hasZeroAttempt(key);
    });
    if (!pending) return plan;
    return { ...plan, ctaDisabled: false, billingOptions: plan.billingOptions.map(option => {
      const key = fastOfferKey(plan.id, option.id);
      const canResume = Boolean(key && hasZeroAttempt(key));
      return { ...option, canResume, ctaDisabled: canResume ? false : plan.ctaDisabled || option.ctaDisabled,
        ...(canResume ? { ctaLabel: 'Продолжить оплату', statusMessage: undefined } : {}) };
    }) };
  });
  const view = previewView ?? (isAtlantyVariant
    ? {
      id: 'lk1-subscription-atlanty', title: 'ДРУЖБА.АТЛАНТЫ',
      description: 'Подписка клуба «Атланты»', markUrl, markAlt: 'Подписка',
      sections: [{ id: 'subscription-atlanty', plans }],
    }
    : {
      id: 'lk1-subscriptions', title: 'Играй в падел выгодно',
      description: 'Выберите подписку под свой ритм игры', markUrl, markAlt: 'Подписка',
      sections: [{ id: 'subscriptions-monthly', plans }],
    });

  /**
   * A failed status refresh stays silent: the cards keep the last known data and
   * the 30-second loop retries on its own. Only first load and the genuinely
   * empty catalogue talk to the visitor. The club page needs no status at all.
   */
  const statusNotice = isAtlantyVariant ? null
    : error ? null
      : !statuses && !plans.some(plan => plan.billingOptions.some(option => option.canResume)) ? 'Загружаем подписки…'
        : !plans.length ? 'Сейчас нет доступных предложений.' : null;

  return <>
    {promoSelection && <SubscriptionPromoCodeDialog key={promoSelection.productId} {...promoSelection} onClose={() => setPromoSelection(null)} />}
    {!previewView && statusNotice && <div className="subscription-storefront" style={{ minHeight: 0 }}>
      <div className="subscription-status-message" role="status">
        {!statuses ? <div className="subscription-loading" aria-label={statusNotice}>
          <span className="subscription-loading-ball" aria-hidden="true" />
          <span className="subscription-loading-ball" aria-hidden="true" />
          <span className="subscription-loading-ball" aria-hidden="true" />
          <span className="subscription-loading-label">{statusNotice}</span>
        </div> : statusNotice}
      </div>
    </div>}
    {(previewView || statuses || isAtlantyVariant || plans.some(plan => plan.billingOptions.some(option => option.canResume))) && <>
      {notice && <p className="subscription-status-message" role="status">{notice}</p>}
      {failure && <p className="subscription-status-message subscription-status-message--error" role="alert">{failure}</p>}
      <SubscriptionStorefront view={view} onBack={onBack} onChoose={handleChoose}
        renderCheckoutAddon={previewView ? undefined : (selection, disabled) => {
          const target = resolveStorefrontPromoTarget(selection.planId, selection.billingOptionId as StorefrontBillingOptionId);
          if (!target?.directProductId) return null;
          const plan = plans.find(item => item.id === selection.planId);
          const option = plan?.billingOptions.find(item => item.id === selection.billingOptionId);
          return <button type="button" className="subscription-card__promo-trigger" disabled={disabled}
            onClick={() => setPromoSelection({ planId: selection.planId, billingOptionId: selection.billingOptionId as StorefrontBillingOptionId, productId: target.directProductId!, title: `${plan?.label ?? ''} · ${option?.label ?? ''}` })}>
            у меня есть промокод
          </button>;
        }} />
    </>}
  </>;
}
