// Evidence about one exact one-time split-join attempt, read from the game record.
//
// Only the split-payment item carrying the attempt's own paymentRef counts. Other
// items of the same user (an older CANCELLED attempt, another generation) never
// prove the outcome of this attempt. Local clocks are not evidence: a pending item
// stays "pending" even after a client-side payment window has passed.

export type SplitJoinAttemptEvidence =
  /** The exact item is paid: the attempt succeeded. */
  | "paid"
  /** The exact item reached a server-terminal non-paid status: a new attempt may start. */
  | "terminal"
  /** The exact item exists and is not terminal (including an expired local window). */
  | "pending"
  /** No item with this paymentRef in the record: the outcome stays unknown. */
  | "absent";

const PAID_MARKERS = ["PAID", "CONFIRMED", "SUCCEEDED", "SUCCESS", "COMPLETED"];
// Only exact provider-confirmed refusal statuses end an attempt. Anything in
// progress (CANCELLING, CANCEL_REQUESTED, PENDING_CANCEL, VOID_PENDING), any
// deadline-driven value (EXPIRED, RELEASED, CANCELLED_EXPIRED) and anything that
// does not prove that no money moved (ERROR, REFUND*) stays "pending".
const TERMINAL_STATUSES = new Set(["CANCELLED", "CANCELED", "DECLINED", "FAILED", "REJECTED", "VOIDED", "VOID"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function itemPaymentRef(item: Record<string, unknown>): string {
  const ref = item.paymentRef;
  return typeof ref === "string" ? ref.trim() : "";
}

export function classifySplitJoinAttempt(record: unknown, paymentRef: string): SplitJoinAttemptEvidence {
  const expected = paymentRef.trim();
  if (!expected || !isRecord(record)) return "absent";
  const metadata = isRecord(record.metadata) ? record.metadata : null;
  const splitPayment = metadata && isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
  const payments = splitPayment && Array.isArray(splitPayment.payments) ? splitPayment.payments : [];
  const matches = payments.filter((item): item is Record<string, unknown> => isRecord(item) && itemPaymentRef(item) === expected);
  if (matches.length === 0) return "absent";
  // Several projections of one attempt: any non-terminal one keeps it pending;
  // paid wins over terminal, because a late PAID is real money.
  const statuses = matches.map(item => normalizeStatus(item.status));
  if (statuses.some(status => PAID_MARKERS.some(marker => status === marker || status.startsWith(`${marker}_`)))) return "paid";
  if (statuses.every(status => TERMINAL_STATUSES.has(status))) return "terminal";
  return "pending";
}

// Statuses the split JOIN rejects before any provider call (validation, auth,
// actor mismatch, unknown game). 409/423/429 are NOT here: the paid-join pilot
// answers 409 SPLIT_JOIN_CHECKOUT_PENDING after provider steps, and a 409 can
// mean an earlier attempt is still in flight.
const PRE_PROVIDER_REFUSAL_STATUSES = new Set([400, 401, 403, 404, 422]);
const IN_FLIGHT_CODES = new Set(["SPLIT_JOIN_CHECKOUT_PENDING"]);

/** True only when the server refused this exact request before reaching the provider. */
export function isDefinitiveSplitJoinRefusal(status: number | null | undefined, raw?: unknown): boolean {
  if (typeof status !== "number" || !PRE_PROVIDER_REFUSAL_STATUSES.has(status)) return false;
  const code = raw && typeof raw === "object" ? (raw as { code?: unknown }).code : undefined;
  return !(typeof code === "string" && IN_FLIGHT_CODES.has(code));
}
