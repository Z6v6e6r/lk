export type SubscriptionRequestedPaymentMode = "subscription" | "one_time" | null | undefined;

export interface SubscriptionDecisionResultEvidence {
  selectedPaymentMode?: string | null;
  toPay: number;
  toPayMinor?: number | null;
  paymentRef?: string | null;
  operationId?: string | null;
  transactionId?: string | null;
  exerciseId?: string | null;
  gameId?: string | null;
  bookingId?: string | null;
  paymentUrl?: string | null;
  settlementState?: string | null;
  raw?: unknown;
}

export interface SubscriptionDecisionExpectedEvidence {
  action?: "create" | "join";
  paymentRef?: string | null;
  operationId?: string | null;
  exerciseId?: string | null;
  gameId?: string | null;
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

const readConsistentText = (raw: unknown, keys: readonly string[]): string | null => {
  if (!isRecord(raw)) return null;
  const envelopes = [raw, ...(isRecord(raw.data) ? [raw.data] : [])];
  const values = envelopes.flatMap((envelope) => keys
    .map((key) => String(envelope[key] ?? "").trim())
    .filter(Boolean));
  if (values.length === 0 || new Set(values).size !== 1) return null;
  return values[0];
};

const hasDeterministicOneTimeDecision = (
  result: SubscriptionDecisionResultEvidence,
  amountMinor: number,
  expected?: SubscriptionDecisionExpectedEvidence,
): boolean => {
  const paymentRef = String(result.paymentRef || "").trim();
  const operationId = String(result.operationId || "").trim();
  const transactionId = String(result.transactionId || "").trim();
  const exerciseId = String(result.exerciseId || "").trim();
  const gameId = String(result.gameId || "").trim();
  const bookingId = String(result.bookingId || "").trim();
  const paymentUrl = String(result.paymentUrl || "").trim();
  const settlementState = String(result.settlementState || "").trim().toUpperCase();
  const action = readConsistentText(result.raw, ["mode", "action"])?.toLowerCase() || null;

  if (!paymentRef || !operationId || !exerciseId || !bookingId) return false;
  if (!action || !["create", "join"].includes(action)) return false;
  if (readConsistentText(result.raw, ["paymentRef", "ref"]) !== paymentRef) return false;
  if (readConsistentText(result.raw, ["operationId"]) !== operationId) return false;
  if (readConsistentText(result.raw, ["exerciseId", "vivaExerciseId"]) !== exerciseId) return false;
  if (readConsistentText(result.raw, ["bookingId"]) !== bookingId) return false;
  if (readConsistentText(result.raw, ["settlementState"])?.toUpperCase() !== settlementState) return false;

  if (expected?.action && action !== expected.action) return false;
  if (expected?.paymentRef?.trim() && paymentRef !== expected.paymentRef.trim()) return false;
  if (expected?.operationId?.trim() && operationId !== expected.operationId.trim()) return false;
  if (expected?.exerciseId?.trim() && exerciseId !== expected.exerciseId.trim()) return false;
  if (expected?.gameId?.trim()) {
    if (!gameId || gameId !== expected.gameId.trim()) return false;
    if (readConsistentText(result.raw, ["gameId"]) !== gameId) return false;
  }

  if (amountMinor > 0) {
    return settlementState === "PAYMENT_REQUIRED" && Boolean(transactionId && paymentUrl);
  }
  return settlementState === "CONFIRMED";
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
  expected?: SubscriptionDecisionExpectedEvidence,
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

  if (selectedMode === "one_time") {
    return hasDeterministicOneTimeDecision(result, normalizedAmountMinor, expected);
  }
  if (requestedPaymentMode !== "subscription") return false;
  if (selectedMode !== "subscription" && selectedMode !== "one_time") return false;

  const state = readSubscriptionDecisionResultState(result.raw);
  if (state && !KNOWN_SUBSCRIPTION_RESULT_STATES.has(state)) return false;
  if (state === "CONFIRMED" && selectedMode !== "subscription") return false;
  if (state === "FULL_PRICE_WITHOUT_SUBSCRIPTION" && selectedMode !== "one_time") return false;

  return Boolean(result.bookingId?.trim() || result.paymentUrl?.trim());
}
