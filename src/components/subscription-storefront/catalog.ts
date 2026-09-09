import type { SubscriptionPlanView } from './model';

export const storefrontPlanKeys = ['friendship', 'ra', 'academy'] as const;
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

/** Navigation only. Authentication, current price and payment remain owned by LK1. */
export function subscriptionCheckoutUrl(planId: string, channel: 'prod' | 'dev'): string | null {
  if (!storefrontPlanKeys.some(key => key === planId)) return null;
  const url = new URL('https://padlhub.ru/ab_leto');
  url.searchParams.set('variant', 'single_artwork');
  url.searchParams.set('artworkKey', planId);
  url.searchParams.set('autoPurchase', '0');
  url.searchParams.set('channel', channel);
  url.searchParams.set('cabinetUrl', `https://padlhub.ru/${channel === 'dev' ? 'lk_dev' : 'lk_new'}`);
  return url.toString();
}
