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

// A refusal releases the held attempt only when the server says, by an exact
// status + code pair, that it stopped before this request dispatched any provider
// write. An HTTP status alone is not evidence: after POST /transactions succeeded,
// the split router forwards a failed GET /transactions/{id} (or a 4xx from the
// create itself) with Viva's own 400/401/403/404/422 and a provider payload.
// Each code below is emitted only at one pre-write point; the contract test
// scripts/tests/splitJoinRefusalContract.test.mjs pins those origins.
const PRE_PROVIDER_REFUSALS = new Map<string, number>([
  // fn_split_join_prepare.js: the stored game cannot address a court; no Viva call yet.
  ["SPLIT_GAME_LOCATION_INCOMPLETE", 400],
  // nodered_split_join_recovery_nodes/checkout.js paidJoinBegin: no user session; before any Viva call.
  ["SPLIT_JOIN_AUTH_REQUIRED", 401],
  // checkout.js paid_join_profile: the Viva profile is not this participant; before the journal and any write.
  ["SPLIT_JOIN_ACTOR_MISMATCH", 403],
]);

function refusalCodes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const top = (raw as { code?: unknown }).code;
  const details = (raw as { details?: unknown }).details;
  const nested = details && typeof details === "object" ? (details as { code?: unknown }).code : undefined;
  return [top, nested].filter((code): code is string => typeof code === "string" && code.trim() !== "").map(code => code.trim());
}

/** True only when the server proved it refused this exact request before any provider write. */
export function isDefinitiveSplitJoinRefusal(status: number | null | undefined, raw?: unknown): boolean {
  if (typeof status !== "number") return false;
  const codes = refusalCodes(raw);
  // Every code the answer carries must be a pre-write code for this exact status:
  // a provider code next to ours, or an in-flight code anywhere, keeps the hold.
  return codes.length > 0 && codes.every(code => PRE_PROVIDER_REFUSALS.get(code) === status);
}
