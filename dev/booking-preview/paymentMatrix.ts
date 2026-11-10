export type ServiceKind = 'game' | 'training' | 'tournament';
export type PaymentKind = 'full' | 'residency' | 'subscription' | 'pass';
export type Privileges = { residency: boolean; subscription: boolean; pass: boolean };
export type Applicability = { subscription: boolean; pass: boolean };
export type PaymentOption = {
  kind: PaymentKind;
  mode: 'book' | 'offer' | 'unavailable' | 'reference';
  amount: number | null;
};

// Display examples supplied by the owner. This is a local prototype, not an API
// quote or authorization to charge, discount, or debit a production account.
export const SERVICES = {
  game: { name: 'Игра 2×2', price: 4000, residentPrice: 2800, discount: 30 },
  training: { name: 'Групповая тренировка', price: 5500, residentPrice: 2750, discount: 50 },
  tournament: { name: 'Турнир', price: 8000, residentPrice: 4000, discount: 50 },
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
  };
}

export function buildPaymentOptions(service: ServiceKind, privileges: Privileges, fits: Applicability): PaymentOption[] {
  const price = SERVICES[service];
  const hasApplicablePrivilege = privileges.residency || (privileges.subscription && fits.subscription) || (privileges.pass && fits.pass);
  const options: Record<PaymentKind, PaymentOption> = {
    full: { kind: 'full', mode: hasApplicablePrivilege ? 'reference' : 'book', amount: price.price },
    residency: { kind: 'residency', mode: privileges.residency ? 'book' : 'offer', amount: price.residentPrice },
    subscription: { kind: 'subscription', mode: !fits.subscription ? 'unavailable' : privileges.subscription ? 'book' : 'offer', amount: 0 },
    pass: { kind: 'pass', mode: !fits.pass ? 'unavailable' : privileges.pass ? 'book' : 'offer', amount: null },
  };
  const order: PaymentKind[] = privileges.subscription && fits.subscription
    ? (privileges.pass && fits.pass ? ['full', 'subscription', 'pass', 'residency'] : ['full', 'subscription', 'residency', 'pass'])
    : privileges.pass && fits.pass
      ? ['full', 'pass', ...(privileges.residency ? ['residency', 'subscription'] as const : ['subscription', 'residency'] as const)]
      : ['full', 'residency', 'subscription', 'pass'];
  return order.map(kind => options[kind]);
}

export function formatRubles(amount: number) {
  return `${amount.toLocaleString('ru-RU')} ₽`;
}
