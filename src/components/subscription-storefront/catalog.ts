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
export const FRIENDSHIP_TWO_HOURS_PRODUCT_ID = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
export const FRIENDSHIP_TWO_HOURS_PRICE_MINOR = 1980000;
export const FRIENDSHIP_TWO_HOURS_VALIDITY_DAYS = 30;
/**
 * The plan promises two free hours of open game a day and the 50 % formats on
 * top, so the Viva product has to carry both scopes: the open game
 * (direction `4588`, type `1613`) and «Время на друзей» (direction `5278`,
 * type `839`, the format the club sells under that direction). A card price
 * without that scope is not the product this variant sells.
 */
export const FRIENDSHIP_TWO_HOURS_DIRECTION_IDS = [4588, 5278] as const;
export const FRIENDSHIP_TWO_HOURS_TYPE_IDS = [1613, 839] as const;

/** Provider id lists arrive either as bare ids or as `{ id }` records. */
function productScopeIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown }).id : row))
    .map((id) => (typeof id === 'number' ? id : typeof id === 'string' ? Number(id.trim()) : NaN));
  return ids.every((id) => Number.isSafeInteger(id)) ? ids : null;
}

/**
 * An unlimited scope covers every value; a limited one must name every required
 * id. A missing flag is never read as "unlimited".
 */
function productScopeCovers(limited: unknown, listed: unknown, required: readonly number[]): boolean {
  if (limited === false) return true;
  if (limited !== true) return false;
  const ids = productScopeIds(listed);
  return Boolean(ids) && required.every((id) => (ids as number[]).includes(id));
}

/**
 * Provider price of the exact two-hour plan product, or null when the record is
 * not that product. Availability and the checkout both read it, so a product
 * without «Время на друзей» inside its scope can never be sold as this variant.
 */
export function parseFriendshipTwoHoursProduct(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const product = payload as Record<string, unknown>;
  if (product.id !== FRIENDSHIP_TWO_HOURS_PRODUCT_ID
    || product.cost !== FRIENDSHIP_TWO_HOURS_PRICE_MINOR
    || product.validityDays !== FRIENDSHIP_TWO_HOURS_VALIDITY_DAYS
    || !productScopeCovers(product.hasDirectionLimitation, product.availableDirections, FRIENDSHIP_TWO_HOURS_DIRECTION_IDS)
    || !productScopeCovers(product.hasTypeLimitation, product.availableTypes, FRIENDSHIP_TWO_HOURS_TYPE_IDS)) return null;
  return product.cost;
}

/**
 * Annual terms are confirmed at checkout: the confirmation is requested by the
 * «Оформить подписку» press, never before the visitor chooses a plan.
 */
export function requiresAnnualTermsConsent(billingOptionId: string, termsAccepted: boolean): boolean {
  return billingOptionId === ANNUAL_TERMS_OPTION_ID && !termsAccepted;
}

export function friendshipBillingOptions(
  statuses: readonly StorefrontStatus[], stale = false,
  /** Provider price of the two-hour product, already verified against its scope. */
  twoHourProductPriceMinor?: number | null,
): SubscriptionPlanView['billingOptions'] {
  const monthly = statuses.find(status => status.counterKey === 'friendship');
  const annual = statuses.find(status => status.counterKey === 'network_friendship');
  const twoHourStatus = statuses.find(status => status.counterKey === 'friendship_two_hours');
  // A verified product price alone cannot prove that the booking rules are live.
  const twoHourAvailable = !stale && twoHourProductPriceMinor === FRIENDSHIP_TWO_HOURS_PRICE_MINOR
    && Boolean(twoHourStatus && canContinue(twoHourStatus)
      && twoHourStatus.priceMinor === FRIENDSHIP_TWO_HOURS_PRICE_MINOR);
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
    { id: 'monthly-two-hours', label: 'месяц 2 часа', priceMinor: FRIENDSHIP_TWO_HOURS_PRICE_MINOR, priceSuffix: '/ 30 дней',
      ctaDisabled: !twoHourAvailable, ctaLabel: twoHourAvailable ? 'Оформить подписку' : 'Сейчас недоступно',
      ...(!twoHourAvailable ? { statusMessage: 'Предложение временно недоступно' } : {}) },
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

/**
 * Клубная подписка направления «Топократы игра» (Viva `6180`). Оператор выдал id
 * самой подписки из каталога «Абонементы»: витрина передаёт его в
 * `apiBuySubscroption` как продукт типа `SUBSCRIPTION`, поэтому отдельный product
 * id не нужен. Цена клубная и статичная: счётчика в LK у этой подписки нет.
 */
export const TOPOCRATY_PLAN_ID = 'topocraty';
export const TOPOCRATY_PRODUCT_ID = '14692232-12be-4218-9fa1-2d5b79b62035';
/** 6 800 ₽ / 30 дней, прежняя цена на странице — 9 800 ₽. */
export const TOPOCRATY_MONTHLY_PRICE_MINOR = 680000;

/** Viva Patriots product. Checkout verifies all promised directions before purchase. */
export const PATRIOTS_PLAN_ID = 'patriots';
export const PATRIOTS_PRODUCT_ID = '37ab3713-4431-4815-96ba-d7ece76a9241';
export const PATRIOTS_MONTHLY_PRICE_MINOR = 680000;

/** Annual inventory is authoritative only when returned by its explicit request. */
export function scopedStorefrontStatuses<T extends StorefrontStatus>(statuses: T[], counterKey?: string | null): T[] {
  return statuses.filter(status => counterKey
    ? status.counterKey === counterKey
    : status.counterKey !== 'network_friendship' && status.counterKey !== 'friendship_two_hours');
}
