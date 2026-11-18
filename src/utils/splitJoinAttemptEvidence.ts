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
const TERMINAL_MARKERS = ["CANCEL", "DECLIN", "FAIL", "ERROR", "EXPIRE", "REFUND", "REJECT", "RELEASED", "VOID"];

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
  if (statuses.every(status => status && TERMINAL_MARKERS.some(marker => status.includes(marker)))) return "terminal";
  return "pending";
}

/** A definitive refusal proves the create did not happen; anything else may have reached the provider. */
export function isDefinitiveSplitJoinRefusal(status: number | null | undefined): boolean {
  return typeof status === "number" && Number.isFinite(status) && status >= 400 && status < 500 && status !== 408;
}
