export type ServiceKind = 'game' | 'training' | 'tournament';
export type PaymentKind = 'full' | 'residency' | 'subscription' | 'pass';
export type Privileges = { residency: boolean; subscription: boolean; pass: boolean };
export type Applicability = { subscription: boolean; pass: boolean };
export type SubscriptionPlan = 'daily-training' | 'daily-hour';
export type DailyQuota = 'available' | 'used';
export type PaymentContext = { subscriptionPlan: SubscriptionPlan; dailyQuota: DailyQuota; excludedGroups: boolean; durationMinutes: number };
export type SubscriptionBenefit = 'free-training' | 'free-hour' | 'partial-hour' | 'discount';
export type PaymentOption = {
  kind: PaymentKind;
  mode: 'book' | 'offer' | 'unavailable' | 'reference' | 'quote';
  amount: number | null;
  benefit?: SubscriptionBenefit;
  reason?: 'excluded-group' | 'not-applicable' | 'training-only' | 'unknown-duration' | 'unknown-price';
  freeMinutes?: number;
  paidMinutes?: number;
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
  return {
    profile: PRIVILEGE_PROFILES.find(profile => profile.id === params.get('privileges')) || PRIVILEGE_PROFILES[0],
    applicability: { subscription: params.get('subscriptionFits') !== '0', pass: params.get('passFits') !== '0' },
    subscriptionPlan: params.get('subscriptionPlan') === 'daily-hour' ? 'daily-hour' as const : 'daily-training' as const,
    dailyQuota: params.get('dailyQuota') === 'used' ? 'used' as const : 'available' as const,
    excludedGroups: params.get('groupCategory') === 'excluded',
  };
}

export function buildPaymentOptions(service: ServiceKind, privileges: Privileges, fits: Applicability, context: Partial<PaymentContext> = {}): PaymentOption[] {
  const price = SERVICES[service];
  const plan = context.subscriptionPlan || 'daily-training';
  const quota = context.dailyQuota || 'available';
  const duration = context.durationMinutes ?? price.durationMinutes;
  const excluded = service === 'training' && context.excludedGroups === true;
  let subscription: PaymentOption;
  if (excluded || !fits.subscription) {
    subscription = { kind: 'subscription', mode: 'unavailable', amount: null, reason: excluded ? 'excluded-group' : 'not-applicable' };
  } else if (quota === 'used') {
    subscription = { kind: 'subscription', mode: privileges.subscription ? 'book' : 'offer', amount: price.residentPrice, benefit: 'discount' };
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
  const residency: PaymentOption = { kind: 'residency', mode: excluded ? 'unavailable' : privileges.residency ? 'book' : 'offer',
    amount: excluded ? null : price.residentPrice, ...(excluded ? { reason: 'excluded-group' as const } : {}) };
  const pass: PaymentOption = { kind: 'pass', mode: !fits.pass ? 'unavailable' : privileges.pass ? 'book' : 'offer', amount: null };
  const hasApplicablePrivilege = [subscription, residency, pass].some(option => option.mode === 'book');
  const options: Record<PaymentKind, PaymentOption> = {
    full: { kind: 'full', mode: hasApplicablePrivilege ? 'reference' : 'book', amount: price.price }, residency, subscription, pass,
  };
  const order: PaymentKind[] = subscription.mode === 'book'
    ? (pass.mode === 'book' ? ['full', 'subscription', 'pass', 'residency'] : ['full', 'subscription', 'residency', 'pass'])
    : pass.mode === 'book'
      ? ['full', 'pass', ...(residency.mode === 'book' ? ['residency', 'subscription'] as const : ['subscription', 'residency'] as const)]
      : ['full', 'residency', 'subscription', 'pass'];
  return order.map(kind => options[kind]);
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
        amount: Math.round(personalAmount * option.paidMinutes / context.durationMinutes * 100) / 100 };
    }
    return { ...option,
      amount: option.amount == null ? null : option.amount === 0 ? 0
        : option.kind === 'full' ? personalAmount : Math.round(personalAmount * 0.7 * 100) / 100 };
  });
  return options.map(option => option.kind === 'full' && options.some(other => other.kind !== 'full' && other.mode === 'book')
    ? { ...option, mode: 'reference' } : option);
}

// A missing product can be purchased for this event. Applicability toggles
// describe existing products; excluded groups still reject subscription offers.
export function buildBookingPaymentOptions(service: ServiceKind, privileges: Privileges, fits: Applicability, context: Partial<PaymentContext> = {}, gameScope?: GamePaymentScope, courtAmount: number | null = null): PaymentOption[] {
  const purchaseFits = { subscription: !privileges.subscription || fits.subscription, pass: !privileges.pass || fits.pass };
  const options = service === 'game' && gameScope
    ? buildGamePaymentOptions(courtAmount, gameScope, privileges, purchaseFits, context)
    : buildPaymentOptions(service, privileges, purchaseFits, context);
  return options.map(option => !privileges.subscription && option.reason === 'training-only'
    ? { ...option, mode: 'offer' } : option);
}
