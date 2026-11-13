export type ServiceKind = 'game' | 'training' | 'tournament';
import { currentBenefit, DAILY_USAGE, type DailyUsage } from './privilegeRules.ts';
import { readPreviewStage } from './previewStage.ts';

export type PaymentKind = 'full' | 'residency' | 'subscription' | 'pass' | 'boost';
export type Privileges = { residency: boolean; subscription: boolean; pass: boolean };
export type Applicability = { subscription: boolean; pass: boolean };
export type SubscriptionPlan = 'daily-training' | 'daily-hour' | 'friendship' | 'friendship-2' | 'ra';
export type DailyQuota = 'available' | 'used';
export type PaymentContext = { subscriptionPlan: SubscriptionPlan; dailyQuota: DailyQuota; excludedGroups: boolean; durationMinutes: number;
  raFits?: boolean; boost?: boolean; activeLimitExceeded?: boolean; proDirection?: boolean; friendsTournament?: boolean; dailyUsage?: DailyUsage; proQuotaUsed?: boolean };
export type SubscriptionBenefit = 'free-training' | 'free-hour' | 'partial-hour' | 'discount' | 'free-event';
export type PaymentOption = {
  kind: PaymentKind;
  mode: 'book' | 'offer' | 'unavailable' | 'reference' | 'quote';
  amount: number | null;
  benefit?: SubscriptionBenefit;
  subscriptionPlan?: SubscriptionPlan;
  withResidency?: boolean;
  withSubscription?: boolean;
  reason?: 'excluded-group' | 'not-applicable' | 'training-only' | 'unknown-duration' | 'unknown-price' | 'pro-direction' | 'active-limit' | 'daily-limit';
  freeMinutes?: number;
  paidMinutes?: number;
  overtimeDiscount?: number;
};

// Display examples supplied by the owner. This is a local prototype, not an API
// quote or authorization to charge, discount, or debit a production account.
export const SERVICES = {
  game: { name: 'Игра 2×2', price: 4000, residentPrice: 2800, discount: 30, durationMinutes: 90 },
  training: { name: 'Групповая тренировка', price: 5500, residentPrice: 2750, discount: 50, durationMinutes: 90 },
  tournament: { name: 'Турнир', price: 8000, residentPrice: 4000, discount: 50, durationMinutes: 180 },
} as const;

export const PRIVILEGE_PROFILES = [
  { id: 'none', name: 'Нет привилегий', residency: false, subscription: false, pass: false },
  { id: 'residency', name: 'Только Резидентство', residency: true, subscription: false, pass: false },
  { id: 'subscription', name: 'Только подписка', residency: false, subscription: true, pass: false },
  { id: 'subscription-residency', name: 'Подписка + Резидентство', residency: true, subscription: true, pass: false },
  { id: 'pass', name: 'Абонемент', residency: false, subscription: false, pass: true },
  { id: 'pass-residency', name: 'Абонемент + Резидентство', residency: true, subscription: false, pass: true },
  { id: 'subscription-pass', name: 'Подписка + Абонемент', residency: false, subscription: true, pass: true },
  { id: 'all', name: 'Подписка + Абонемент + Резидентство', residency: true, subscription: true, pass: true },
] as const;

export function readMatrixSettings(params: URLSearchParams) {
  const legacy = PRIVILEGE_PROFILES.find(profile => profile.id === params.get('privileges')) || PRIVILEGE_PROFILES[0];
  const owned = (key: keyof Privileges) => params.has(key) ? params.get(key) === '1' : legacy[key];
  const profile = PRIVILEGE_PROFILES.find(profile => profile.subscription === owned('subscription') && profile.residency === owned('residency') && profile.pass === owned('pass'))!;
  const rawPlan = params.get('subscriptionPlan');
  const subscriptionPlan: SubscriptionPlan = rawPlan === 'ra' || rawPlan === 'friendship' || rawPlan === 'friendship-2' || rawPlan === 'daily-hour' ? rawPlan : 'daily-training';
  const dailyUsage = DAILY_USAGE.find(usage => usage.id === params.get('dailyUsage'))?.id;
  return {
    profile,
    applicability: { subscription: params.get('subscriptionFits') !== '0', pass: params.get('passFits') !== '0' },
    subscriptionPlan,
    dailyQuota: params.get('dailyQuota') === 'used' ? 'used' as const : 'available' as const,
    excludedGroups: params.get('groupCategory') === 'excluded',
    raFits: params.get('raFits') !== '0',
    boost: readPreviewStage(params) === 'full' && params.get('boost') === '1' && (profile.residency || profile.subscription),
    activeLimitExceeded: params.get('activeLimitExceeded') === '1',
    proDirection: params.get('groupCategory') === 'pro',
    friendsTournament: params.get('friendsTournament') === '1',
    dailyUsage,
    proQuotaUsed: params.get('proQuotaUsed') === '1',
  };
}

export function buildPaymentOptions(service: ServiceKind, privileges: Privileges, fits: Applicability, context: Partial<PaymentContext> = {}): PaymentOption[] {
  const price = SERVICES[service];
  const plan = context.subscriptionPlan || 'daily-training';
  const quota = context.dailyQuota || 'available';
  const duration = context.durationMinutes ?? price.durationMinutes;
  const excluded = service === 'training' && context.excludedGroups === true;
  const subscriptionFits = plan === 'ra' ? context.raFits ?? fits.subscription : fits.subscription;
  const currentSubscription = currentBenefit(service, privileges, context);
  let subscription: PaymentOption;
  if (excluded || !subscriptionFits) {
    subscription = { kind: 'subscription', mode: 'unavailable', amount: null, reason: excluded ? 'excluded-group' : 'not-applicable' };
  } else if (currentSubscription) {
    subscription = { ...currentSubscription, subscriptionPlan: plan };
  } else if (quota === 'used') {
    subscription = { kind: 'subscription', mode: privileges.subscription ? 'book' : 'offer', amount: price.residentPrice, benefit: 'discount' };
  } else if (plan === 'ra') {
    subscription = { kind: 'subscription', mode: privileges.subscription ? 'book' : 'offer', amount: 0, benefit: 'free-event' };
  } else if (plan === 'daily-training' && service !== 'training') {
    subscription = { kind: 'subscription', mode: 'unavailable', amount: null, reason: 'training-only' };
  } else if (plan === 'daily-hour' && (!Number.isFinite(duration) || duration <= 0)) {
    subscription = { kind: 'subscription', mode: 'unavailable', amount: null, reason: 'unknown-duration' };
  } else if (plan === 'daily-hour' && duration > 60) {
    // The owner confirmed partial coverage, but has not specified the copay
    // formula. Never invent a zero or proportionate price for the remainder.
    subscription = { kind: 'subscription', mode: privileges.subscription ? 'quote' : 'offer', amount: null,
      benefit: 'partial-hour', freeMinutes: 60, paidMinutes: duration - 60 };
  } else {
    subscription = { kind: 'subscription', mode: privileges.subscription ? 'book' : 'offer', amount: 0,
      benefit: plan === 'daily-training' ? 'free-training' : 'free-hour', freeMinutes: plan === 'daily-hour' ? duration : undefined };
  }
  const residencyExcluded = excluded || (service !== 'game' && context.proDirection === true);
  const residency: PaymentOption = { kind: 'residency', mode: residencyExcluded ? 'unavailable' : privileges.residency ? 'book' : 'offer',
    amount: residencyExcluded ? null : price.residentPrice, ...(residencyExcluded ? { reason: excluded ? 'excluded-group' as const : 'pro-direction' as const } : {}) };
  const pass: PaymentOption = { kind: 'pass', mode: privileges.pass && fits.pass ? 'book' : 'unavailable', amount: null };
  const boost = currentBenefit(service, privileges, context, true);
  const hasApplicablePrivilege = [subscription, residency, pass, boost].some(option => option?.mode === 'book');
  const options: Record<Exclude<PaymentKind, 'boost'>, PaymentOption> = {
    full: { kind: 'full', mode: hasApplicablePrivilege ? 'reference' : 'book', amount: price.price }, residency, subscription, pass,
  };
  const order: Exclude<PaymentKind, 'boost'>[] = subscription.mode === 'book'
    ? (pass.mode === 'book' ? ['full', 'subscription', 'pass', 'residency'] : ['full', 'subscription', 'residency', 'pass'])
    : pass.mode === 'book'
      ? ['full', 'pass', ...(residency.mode === 'book' ? ['residency', 'subscription'] as const : ['subscription', 'residency'] as const)]
      : ['full', 'residency', 'subscription', 'pass'];
  const result = order.map(kind => options[kind]);
  if (boost) result.splice(1, 0, boost);
  return result;
}

export function formatRubles(amount: number) {
  return `${amount.toLocaleString('ru-RU')} ₽`;
}

export type GamePaymentScope = 'quarter' | 'court';

export function buildGamePaymentOptions(courtAmount: number | null, scope: GamePaymentScope, privileges: Privileges, fits: Applicability, context: Partial<PaymentContext> = {}): PaymentOption[] {
  if (courtAmount == null || !Number.isFinite(courtAmount) || courtAmount <= 0) {
    return [{ kind: 'full', mode: 'quote', amount: null, reason: 'unknown-price' }];
  }
  // Paying for everybody never consumes a benefit or discounts the court.
  if (scope === 'court') return [{ kind: 'full', mode: 'book', amount: courtAmount }];
  const personalAmount = Math.round(courtAmount * 100 / 4) / 100;
  const options: PaymentOption[] = buildPaymentOptions('game', privileges, fits, context).map(option => {
    if (option.benefit === 'partial-hour' && option.paidMinutes && context.durationMinutes) {
      return { ...option, mode: option.mode === 'quote' ? 'book' : option.mode,
        amount: Math.round(personalAmount * option.paidMinutes / context.durationMinutes * (1 - (option.overtimeDiscount || 0) / 100) * 100) / 100 };
    }
    return { ...option,
      amount: option.amount == null ? null : option.amount === 0 ? 0
        : option.kind === 'full' ? personalAmount : Math.round(personalAmount * 0.7 * 100) / 100 };
  });
  return options.map(option => option.kind === 'full' && options.some(other => other.kind !== 'full' && other.mode === 'book')
    ? { ...option, mode: 'reference' } : option);
}

export function energyPassApplies(service: ServiceKind, fits: boolean, context: Partial<PaymentContext> = {}) {
  return (service === 'tournament' && !context.proDirection) || fits;
}

// Only subscriptions can be purchased with a booking. Energy 5 is an owned
// visit pack, never a purchase offer. Excluded groups reject subscriptions.
export function buildBookingPaymentOptions(service: ServiceKind, privileges: Privileges, fits: Applicability, context: Partial<PaymentContext> = {}, gameScope?: GamePaymentScope, courtAmount: number | null = null): PaymentOption[] {
  const purchaseFits = { subscription: !privileges.subscription || fits.subscription,
    pass: energyPassApplies(service, fits.pass, context) };
  const options = service === 'game' && gameScope
    ? buildGamePaymentOptions(courtAmount, gameScope, privileges, purchaseFits, context)
    : buildPaymentOptions(service, privileges, purchaseFits, context);
  return options.filter(option => option.kind !== 'pass' || option.mode === 'book')
    .map(option => !privileges.subscription && option.reason === 'training-only'
    ? { ...option, mode: 'offer' } : option);
}
