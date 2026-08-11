export interface SubscriptionBookingGatewayAttemptResult {
  data: unknown | null;
  error: unknown | null;
  status: number | null;
}

interface PollSubscriptionBookingConfirmationOptions {
  delaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export const SUBSCRIPTION_BOOKING_CONFIRMATION_DELAYS_MS = [
  1_200,
  2_200,
  3_500,
  5_000,
  7_000,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

export function isSubscriptionBookingPending(
  result: SubscriptionBookingGatewayAttemptResult,
): boolean {
  if (result.error) return false;
  const state = pickString(result.data, ["state"]);
  const bookingId = pickString(result.data, ["bookingId", "id"]);
  return state === "PENDING_CONFIRMATION" && !bookingId;
}

const waitForDelay = (delayMs: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, delayMs);
});

export async function pollSubscriptionBookingConfirmation<
  TResult extends SubscriptionBookingGatewayAttemptResult,
>(
  attempt: () => Promise<TResult>,
  options: PollSubscriptionBookingConfirmationOptions = {},
): Promise<TResult> {
  const delaysMs = options.delaysMs ?? SUBSCRIPTION_BOOKING_CONFIRMATION_DELAYS_MS;
  const wait = options.wait ?? waitForDelay;
  let result = await attempt();

  for (const delayMs of delaysMs) {
    if (!isSubscriptionBookingPending(result)) return result;
    await wait(Math.max(0, delayMs));
    result = await attempt();
  }

  return result;
}
