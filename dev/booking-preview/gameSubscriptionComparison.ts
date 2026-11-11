import { buildGamePaymentOptions, type PaymentContext, type PaymentOption } from './paymentMatrix.ts';

// A hypothetical comparison at payer selection, never a booking quote.
export function gameSubscriptionComparison(courtAmount: number | null, context: Partial<PaymentContext>): PaymentOption | undefined {
  return buildGamePaymentOptions(courtAmount, 'quarter',
    { subscription: false, residency: false, pass: false }, { subscription: true, pass: false }, context)
    .find(option => option.kind === 'subscription');
}
