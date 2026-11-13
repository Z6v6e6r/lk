import type { PaymentContext, PaymentOption, Privileges, ServiceKind } from './paymentMatrix.ts';

export const SUBSCRIPTION_PLANS = [
  { id: 'friendship', name: 'Дружба', description: '30 дней · 30 занятий · 1 час игры в день · только своя ¼ · до 8 активных записей. Сверх часа и после лимита — скидка 30% на игру, 50% на групповые и турниры, кроме ПРО.' },
  { id: 'friendship-2', name: 'Дружба 2.0', description: '30 дней · 30 занятий · 2 часа игры в день · своя ¼ · до 8 активных записей. Входит турнир «Время на друзей». Скидки 30% на игру и 50% на групповые и турниры, кроме ПРО.' },
  { id: 'ra', name: 'РА', description: '30 дней · 30 занятий · 1 занятие в день: игра до 1 часа, групповая тренировка или турнир · до 8 активных записей. Скидки 30% и 50% после лимита. ПРО не входит.' },
] as const;

export const DAILY_USAGE = [
  { id: 'none', name: 'Ничего', gameMinutes: 0, events: 0 },
  { id: 'game-hour', name: 'Игра · 1 час', gameMinutes: 60, events: 0 },
  { id: 'game-two-hours', name: 'Игра · 2 часа', gameMinutes: 120, events: 0 },
  { id: 'training', name: 'Групповая тренировка', gameMinutes: 0, events: 1 },
  { id: 'tournament', name: 'Турнир', gameMinutes: 0, events: 1 },
  { id: 'two-events', name: 'Две тренировки / турнира', gameMinutes: 0, events: 2 },
  { id: 'game-hour-event', name: 'Игра 1 час + тренировка / турнир', gameMinutes: 60, events: 1 },
  { id: 'game-two-hours-event', name: 'Игра 2 часа + тренировка / турнир', gameMinutes: 120, events: 1 },
  { id: 'pro', name: 'ПРО', gameMinutes: 0, events: 1, pro: true },
  { id: 'game-hour-pro', name: 'Игра 1 час + ПРО', gameMinutes: 60, events: 1, pro: true },
  { id: 'game-two-hours-pro', name: 'Игра 2 часа + ПРО', gameMinutes: 120, events: 1, pro: true },
  { id: 'event-pro', name: 'Тренировка / турнир + ПРО', gameMinutes: 0, events: 2, pro: true },
] as const;
export type DailyUsage = typeof DAILY_USAGE[number]['id'];

export function isCurrentPlan(plan: PaymentContext['subscriptionPlan'] | undefined) {
  return plan === 'friendship' || plan === 'friendship-2' || plan === 'ra';
}

// Pure local simulation of the owner's rules. A regular event uses one daily
// slot; game time uses hourly slots. Friendship 2.0 + Boost instead has a
// separate two-hour game allowance and one event. PRO consumes an event in
// this SAME allowance, at most once/day for RA / Friendship 2.0 + Boost.
export function currentBenefit(service: ServiceKind, privileges: Privileges, context: Partial<PaymentContext>, boosted = false): PaymentOption | undefined {
  const plan = context.subscriptionPlan;
  if (!isCurrentPlan(plan) && !boosted) return undefined;
  const kind = boosted ? 'boost' as const : 'subscription' as const;
  const mode = boosted || privileges.subscription ? 'book' as const : 'offer' as const;
  const unavailable = (reason: PaymentOption['reason']): PaymentOption => ({ kind, mode: 'unavailable', amount: null, reason });
  const discount = (): PaymentOption => ({ kind, mode, amount: service === 'game' ? 2800 : service === 'training' ? 2750 : 4000,
    benefit: 'discount', reason: context.activeLimitExceeded ? 'active-limit' : context.dailyQuota === 'used' ? 'daily-limit' : undefined });
  if (boosted && (!context.boost || (!privileges.residency && !privileges.subscription))) return undefined;
  if (service === 'training' && context.excludedGroups) return unavailable('excluded-group');
  const hasPro = boosted && privileges.subscription && (plan === 'ra' || plan === 'friendship-2');
  const usageHasPro = DAILY_USAGE.some(usage => usage.id === context.dailyUsage && 'pro' in usage && usage.pro);
  const proUsed = context.proQuotaUsed || usageHasPro;
  const proEvent = service !== 'game' && context.proDirection;
  if (proEvent && (!hasPro || proUsed || context.activeLimitExceeded)) return unavailable('pro-direction');
  const exhausted = () => proEvent ? unavailable('pro-direction') : discount();
  if (context.activeLimitExceeded) return discount();
  if (!boosted) {
    if (context.dailyQuota === 'used') return discount();
    if (service !== 'game') {
      if (plan === 'ra' || (plan === 'friendship-2' && service === 'tournament' && context.friendsTournament)) {
        return { kind, mode, amount: 0, benefit: 'free-event' };
      }
      return discount();
    }
  }
  let freeMinutes = plan === 'friendship-2' ? 120 : 60;
  if (boosted) {
    const fallback = context.dailyQuota === 'used' ? (plan === 'friendship-2' ? 'game-two-hours' : 'game-hour') : 'none';
    const usageId = context.dailyUsage && context.dailyUsage !== 'none' ? context.dailyUsage : fallback;
    const usage = DAILY_USAGE.find(value => value.id === usageId) || DAILY_USAGE[0];
    // Compatibility for a standalone proQuotaUsed URL flag. New UI presets
    // include PRO in events already, so never count that event twice.
    const eventsUsed = usage.events + (proUsed && !usageHasPro ? 1 : 0);
    if (privileges.subscription && plan === 'friendship-2') {
      if (service !== 'game') return eventsUsed < 1 ? { kind, mode, amount: 0, benefit: 'free-event' } : exhausted();
      freeMinutes = Math.max(0, 120 - usage.gameMinutes);
    } else {
      const slots = privileges.subscription ? 2 : 1;
      const remaining = Math.max(0, slots - eventsUsed - usage.gameMinutes / 60);
      if (service !== 'game') return remaining >= 1 ? { kind, mode, amount: 0, benefit: 'free-event' } : exhausted();
      freeMinutes = remaining * 60;
    }
  }
  if (!freeMinutes) return discount();
  const duration = context.durationMinutes ?? 90;
  if (!Number.isFinite(duration) || duration <= 0) return unavailable('unknown-duration');
  if (duration > freeMinutes) return { kind, mode: mode === 'book' ? 'quote' : mode, amount: null,
    benefit: 'partial-hour', freeMinutes, paidMinutes: duration - freeMinutes, overtimeDiscount: 30 };
  return { kind, mode, amount: 0, benefit: 'free-hour', freeMinutes: duration };
}
