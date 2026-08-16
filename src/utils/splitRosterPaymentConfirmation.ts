const STORAGE_KEY = "padlhub.split-roster-payment-confirmations.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PendingSplitRosterPaymentConfirmation {
  gameId: string;
  paymentRef: string;
  reservationId: string;
  operationType: "TRANSACTION" | "SUBSCRIPTION_BOOKING";
  operationId: string;
  bookingId: string;
  clientId: string | null;
  createdAt: string;
}

function readAll(): Record<string, PendingSplitRosterPaymentConfirmation> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, PendingSplitRosterPaymentConfirmation] => {
        const value = entry[1] as Partial<PendingSplitRosterPaymentConfirmation> | null;
        const createdAt = value?.createdAt ? Date.parse(value.createdAt) : Number.NaN;
        return Boolean(
          value
          && typeof value.gameId === "string"
          && typeof value.paymentRef === "string"
          && typeof value.reservationId === "string"
          && ["TRANSACTION", "SUBSCRIPTION_BOOKING"].includes(String(value.operationType))
          && typeof value.operationId === "string"
          && typeof value.bookingId === "string"
          && Number.isFinite(createdAt)
          && now - createdAt <= MAX_AGE_MS,
        );
      }),
    );
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, PendingSplitRosterPaymentConfirmation>): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    // A blocked storage backend leaves the caller on the fail-closed recovery path.
    return false;
  }
}

export function savePendingSplitRosterPaymentConfirmation(
  value: PendingSplitRosterPaymentConfirmation,
): boolean {
  const paymentRef = value.paymentRef.trim();
  if (!paymentRef) return false;
  return writeAll({ ...readAll(), [paymentRef]: { ...value, paymentRef } });
}

export function getPendingSplitRosterPaymentConfirmation(
  paymentRefRaw: string,
): PendingSplitRosterPaymentConfirmation | null {
  const paymentRef = paymentRefRaw.trim();
  return paymentRef ? readAll()[paymentRef] ?? null : null;
}

export function removePendingSplitRosterPaymentConfirmation(paymentRefRaw: string): void {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const records = readAll();
  if (!records[paymentRef]) return;
  delete records[paymentRef];
  writeAll(records);
}
