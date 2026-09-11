import type { SubscriptionPlanView } from './model';

export const storefrontPlanKeys = ['friendship', 'ra', 'academy', 'energy5'] as const;
export type StorefrontPlanKey = typeof storefrontPlanKeys[number];

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
    label: '5 занятий',
    priceSuffix: '/ 5 занятий',
    ctaDisabled: !canContinue(status),
    ctaLabel: canContinue(status) ? 'Оформить абонемент' : 'Сейчас недоступно',
  }];
}


/** Annual inventory is authoritative only when returned by its explicit request. */
export function scopedStorefrontStatuses<T extends StorefrontStatus>(statuses: T[], counterKey?: string | null): T[] {
  return statuses.filter(status => counterKey
    ? status.counterKey === counterKey
    : status.counterKey !== 'network_friendship');
}
