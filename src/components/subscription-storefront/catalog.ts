import type { SubscriptionPlanView } from './model';

export const storefrontPlanKeys = ['friendship', 'ra', 'academy', 'energy5'] as const;
export type StorefrontPlanKey = typeof storefrontPlanKeys[number];

/** The training CTA opens the two plans that include group training benefits. */
export function storefrontPlanKeysForSearch(search: string): readonly StorefrontPlanKey[] {
  return new URLSearchParams(search).get('plans') === 'ra,academy'
    ? ['ra', 'academy']
    : storefrontPlanKeys;
}

export interface StorefrontStatus {
  counterKey: string | null;
  priceMinor: number | null;
  canPurchase: boolean;
  bindingReady: boolean;
  unlimited: boolean;
  remainingCount: number;
  totalLimit: number;
}

export function billingFromStatus(status: StorefrontStatus): SubscriptionPlanView['billingOptions'] {
  if (!Number.isSafeInteger(status.priceMinor) || status.priceMinor === null || status.priceMinor <= 0) return [];
  return [{
    id: 'monthly', label: '30 дней', priceSuffix: '/ 30 дней', priceMinor: status.priceMinor,
    ...(!status.unlimited && status.totalLimit > 0 ? {
      progress: { current: Math.max(0, status.remainingCount), total: status.totalLimit, label: 'Доступно' },
    } : {}),
  }];
}

export function canContinue(status: StorefrontStatus, stale = false): boolean {
  return !stale && billingFromStatus(status).length > 0 && status.bindingReady && status.canPurchase
    && (status.unlimited || status.remainingCount > 0);
}

/** Billing option that requires an explicit terms confirmation before payment. */
export const ANNUAL_TERMS_OPTION_ID = 'annual';

/**
 * Annual terms are confirmed at checkout: the confirmation is requested by the
 * «Оформить подписку» press, never before the visitor chooses a plan.
 */
export function requiresAnnualTermsConsent(billingOptionId: string, termsAccepted: boolean): boolean {
  return billingOptionId === ANNUAL_TERMS_OPTION_ID && !termsAccepted;
}

export function friendshipBillingOptions(statuses: readonly StorefrontStatus[], stale = false): SubscriptionPlanView['billingOptions'] {
  const monthly = statuses.find(status => status.counterKey === 'friendship');
  const annual = statuses.find(status => status.counterKey === 'network_friendship');
  function availableOption(status: StorefrontStatus | undefined, id: string, label: string, priceSuffix: string) {
    const billing = status && billingFromStatus(status)[0];
    return {
      id, label, priceMinor: billing?.priceMinor ?? null, priceSuffix,
      progress: billing?.progress,
      ctaDisabled: !status || !canContinue(status, stale),
      ctaLabel: status && canContinue(status, stale) ? 'Оформить подписку' : 'Сейчас недоступно',
      ...(!billing ? { statusMessage: 'Предложение временно недоступно' } : {}),
    };
  }
  return [
    availableOption(monthly, 'monthly', 'месяц', '/ 30 дней'),
    { id: 'monthly-two-hours', label: 'месяц 2 часа', priceMinor: 1980000, priceSuffix: '/ 30 дней',
      ctaDisabled: true, ctaLabel: 'Скоро. Может быть',
      statusMessage: 'Дружба 2.0 скоро появится в продаже' },
    availableOption(annual, 'annual', 'год', '/ год'),
  ];
}

/** Five-visit pass: one priced option, no daily progress counter. */
export function energy5BillingOptions(status: StorefrontStatus | undefined): SubscriptionPlanView['billingOptions'] {
  if (!status) return [];
  const billing = billingFromStatus(status)[0];
  if (!billing) return [];
  return [{
    ...billing,
    id: 'monthly',
    label: '60 дней, 5 занятий',
    priceSuffix: '/ 60 дней, 5 занятий',
    ctaDisabled: !canContinue(status),
    ctaLabel: canContinue(status) ? 'Оформить абонемент' : 'Сейчас недоступно',
  }];
}

/** URL variant that turns the storefront into the single-card «ДРУЖБА.АТЛАНТЫ» page. */
export const ATLANTY_VARIANT = 'atlanty';
export const ATLANTY_PLAN_ID = 'atlanty';
/**
 * Direct Viva product of the club's 30-day plan. It stays out of
 * `TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS`: only this storefront variant
 * resolves it.
 */
export const ATLANTY_MONTHLY_PRODUCT_ID = '3907d127-a6b0-419e-a933-4a2857f26356';
/**
 * Annual «Дружба.Атланты». The operator has not issued the Viva product id yet,
 * so the annual option stays disabled until this exact value is filled in.
 */
export const ATLANTY_ANNUAL_PRODUCT_ID = '';
/** Club prices are operator-owned: the API has no counter for these direct products. */
export const ATLANTY_MONTHLY_PRICE_MINOR = 680000;
export const ATLANTY_MONTHLY_COMPARE_MINOR = 980000;
export const ATLANTY_ANNUAL_PRICE_MINOR = 6800000;
export const ATLANTY_ANNUAL_COMPARE_MINOR = 9800000;

export function normalizeStorefrontVariant(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

/**
 * «ДРУЖБА.АТЛАНТЫ» sells two direct Viva products: a discounted 30-day plan and
 * a discounted annual plan. Both prices are static club prices, so the card is
 * unavailable whenever its product id is missing; the bank stays the price owner.
 * The «месяц 2 часа» placeholder of the shared friendship card is intentionally absent.
 */
export function atlantyBillingOptions(): SubscriptionPlanView['billingOptions'] {
  const annualProductId = String(ATLANTY_ANNUAL_PRODUCT_ID || '').trim();
  return [
    {
      id: 'monthly',
      label: 'месяц',
      priceMinor: ATLANTY_MONTHLY_PRICE_MINOR,
      priceCompareMinor: ATLANTY_MONTHLY_COMPARE_MINOR,
      priceSuffix: '/ 30 дней',
    },
    {
      id: 'annual',
      label: 'год',
      priceMinor: ATLANTY_ANNUAL_PRICE_MINOR,
      priceCompareMinor: ATLANTY_ANNUAL_COMPARE_MINOR,
      priceSuffix: '/ год',
      ctaDisabled: !annualProductId,
      ...(annualProductId ? {} : { ctaLabel: 'Скоро', statusMessage: 'Годовой вариант появится в продаже позже' }),
    },
  ];
}


/** Annual inventory is authoritative only when returned by its explicit request. */
export function scopedStorefrontStatuses<T extends StorefrontStatus>(statuses: T[], counterKey?: string | null): T[] {
  return statuses.filter(status => counterKey
    ? status.counterKey === counterKey
    : status.counterKey !== 'network_friendship');
}
