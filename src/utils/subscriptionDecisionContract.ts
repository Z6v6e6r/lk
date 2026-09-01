export type SubscriptionRequestedPaymentMode = "subscription" | "one_time" | null | undefined;

export interface SubscriptionDecisionResultEvidence {
  selectedPaymentMode?: string | null;
  toPay: number;
  toPayMinor?: number | null;
  bookingId?: string | null;
  paymentUrl?: string | null;
  raw?: unknown;
}

const KNOWN_SUBSCRIPTION_RESULT_STATES = new Set([
  "CONFIRMED",
  "FULL_PRICE_WITHOUT_SUBSCRIPTION",
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

const toFiniteNonNegative = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const readExplicitAmountMinor = (raw: unknown): number | null => {
  if (!isRecord(raw)) return null;
  const envelopes = [raw, ...(isRecord(raw.data) ? [raw.data] : [])];
  const candidates: number[] = [];
  for (const envelope of envelopes) {
    for (const key of ["toPayMinor", "amountMinor"] as const) {
      if (!(key in envelope)) continue;
      const value = toFiniteNonNegative(envelope[key]);
      if (value === null || !Number.isSafeInteger(value)) return null;
      candidates.push(value);
    }
    for (const key of ["toPay", "amount"] as const) {
      if (!(key in envelope)) continue;
      const value = toFiniteNonNegative(envelope[key]);
      if (value === null) return null;
      const minor = value > 10_000 ? value : Math.round(value * 100);
      if (!Number.isSafeInteger(minor)) return null;
      candidates.push(minor);
    }
  }
  if (candidates.length === 0 || new Set(candidates).size !== 1) return null;
  return candidates[0];
};

export function readSubscriptionDecisionResultState(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const states = [raw, ...(isRecord(raw.data) ? [raw.data] : [])]
    .map((envelope) => String(envelope.state ?? "").trim().toUpperCase())
    .filter(Boolean);
  if (states.length === 0) return null;
  return new Set(states).size === 1 ? states[0] : "RESULT_STATE_CONFLICT";
}

export function isKnownSubscriptionDecisionResultState(raw: unknown): boolean {
  const state = readSubscriptionDecisionResultState(raw);
  return state === null || KNOWN_SUBSCRIPTION_RESULT_STATES.has(state);
}

export function hasDeterministicSubscriptionDecision(
  result: SubscriptionDecisionResultEvidence,
  requestedPaymentMode: SubscriptionRequestedPaymentMode,
): boolean {
  const selectedMode = String(result.selectedPaymentMode || "").trim().toLowerCase();
  if (!Number.isFinite(result.toPay) || result.toPay < 0) return false;
  if (result.toPayMinor != null && (!Number.isSafeInteger(result.toPayMinor) || result.toPayMinor < 0)) {
    return false;
  }

  const explicitAmountMinor = readExplicitAmountMinor(result.raw);
  if (explicitAmountMinor === null) return false;
  const normalizedAmountMinor = result.toPayMinor ?? Math.round(result.toPay * 100);
  if (explicitAmountMinor !== normalizedAmountMinor) return false;

  if (requestedPaymentMode !== "subscription") {
    if (selectedMode !== "one_time") return false;
    return Boolean(result.bookingId?.trim() || result.paymentUrl?.trim());
  }
  if (selectedMode !== "subscription" && selectedMode !== "one_time") return false;

  const state = readSubscriptionDecisionResultState(result.raw);
  if (state && !KNOWN_SUBSCRIPTION_RESULT_STATES.has(state)) return false;
  if (state === "CONFIRMED" && selectedMode !== "subscription") return false;
  if (state === "FULL_PRICE_WITHOUT_SUBSCRIPTION" && selectedMode !== "one_time") return false;

  return Boolean(result.bookingId?.trim() || result.paymentUrl?.trim());
}
