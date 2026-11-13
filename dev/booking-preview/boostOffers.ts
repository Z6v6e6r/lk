import { buildBookingPaymentOptions, type Applicability, type GamePaymentScope, type PaymentContext, type PaymentOption, type Privileges, type ServiceKind } from './paymentMatrix.ts';
import type { PreviewStage } from './previewStage.ts';

// A purchase needs an already-owned base product. Do not sell Boost when the
// event is already covered for the same (or a lower) price by that product.
export function boostPurchaseOption(service: ServiceKind, profile: Privileges, fits: Applicability, context: Partial<PaymentContext>, stage: PreviewStage, scope?: GamePaymentScope, courtAmount: number | null = null): PaymentOption | undefined {
  if (stage !== 'full' || context.boost || (!profile.subscription && !profile.residency)) return undefined;
  const quote = buildBookingPaymentOptions(service, profile, fits, { ...context, boost: true }, scope, courtAmount)
    .find(option => option.kind === 'boost' && option.mode === 'book' && option.amount != null && Number.isFinite(option.amount) && option.amount >= 0);
  if (!quote) return undefined;
  const base = buildBookingPaymentOptions(service, profile, fits, { ...context, boost: false }, scope, courtAmount)
    .find(option => option.kind === (profile.subscription ? 'subscription' : 'residency') && option.mode === 'book');
  if (base?.amount != null && Number.isFinite(base.amount) && base.amount >= 0 && base.amount <= quote.amount!) return undefined;
  return { ...quote, mode: 'offer', ...(profile.subscription ? { withSubscription: true } : { withResidency: true }) };
}

export function boostBenefits(profile: Privileges, plan: PaymentContext['subscriptionPlan']): readonly string[] {
  if (!profile.subscription) return ['Одно бесплатное занятие в день: игра до часа, групповая тренировка или турнир', 'В игре покрывается ваша ¼ стоимости корта', 'Скидки 30% на платное время игры и 50% на групповые и турниры после лимита. ПРО не входит'];
  if (plan === 'friendship-2') return ['До 2 часов игры и одна групповая тренировка, турнир или ПРО в день', 'ПРО входит в общий дневной лимит — не более одного события в день', 'В игре покрывается ваша ¼ корта. После лимита сохраняются скидки 30% и 50%, кроме ПРО'];
  return ['До 2 часов игры или две групповые тренировки / турнира в день', 'Можно совместить час игры с групповой тренировкой или турниром', plan === 'ra' ? 'ПРО входит в общий дневной лимит — не более одного события в день' : 'ПРО не входит. После лимита сохраняются скидки 30% на игры и 50% на групповые и турниры'];
}
