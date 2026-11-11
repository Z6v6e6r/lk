import { buildGamePaymentOptions, type PaymentContext, type PaymentOption } from './paymentMatrix.ts';

// A hypothetical comparison at payer selection, never a booking quote.
export function gameSubscriptionComparison(courtAmount: number | null, context: Partial<PaymentContext>): PaymentOption | undefined {
  const option = buildGamePaymentOptions(courtAmount, 'quarter',
    { subscription: false, residency: false, pass: false }, { subscription: true, pass: false }, context)
    .find(option => option.kind === 'subscription');
  if (option?.benefit !== 'partial-hour' || !option.paidMinutes || !context.durationMinutes) return option;
  return { ...option, amount: Math.round((courtAmount! / 4) * option.paidMinutes / context.durationMinutes * 100) / 100 };
}
