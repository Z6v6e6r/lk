import { paymentCancellationBlocksAttempt } from "./bookingPaymentCancellation.ts";
// A restored checkout keeps its original deadline. Local time can stop payment,
// but only a server release may authorize a successor booking attempt.
export const PAYMENT_ATTEMPT_TTL_MS = 15 * 60 * 1000;
export const PAYMENT_ATTEMPT_CHECK_MESSAGE = "Срок оплаты истёк или не подтверждён. Проверьте результат текущей попытки перед новой записью.";
export type PaymentAttemptState = "PAYMENT_REQUIRED" | "CLOSING" | "PAID";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const instant = (value: unknown): number | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function sources(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (!root) return [];
  const raw = record(root.raw);
  return [root, record(root.data), raw, record(raw?.data)].filter((v): v is Record<string, unknown> => v !== null);
}
export function paymentAttemptDeadline(value: unknown): number | null {
  const rows = sources(value);
  const ends = rows.flatMap(row => ["paymentExpiresAt", "deadlineAt", "expiresAt", "paymentDueDate"]
    .map(key => instant(row[key])).filter((v): v is number => v !== null));
  const starts = rows.flatMap(row => ["paymentAttemptCreatedAt", "paymentStartedAt", "attemptStartedAt", "transactionAttemptedAt", "createdAt", "createDate"]
    .map(key => instant(row[key])).filter((v): v is number => v !== null));
  if (starts.length) ends.push(Math.min(...starts) + PAYMENT_ATTEMPT_TTL_MS);
  return ends.length ? Math.min(...ends) : null;
}
export function paymentAttemptFields(value: unknown): { paymentExpiresAt: string | null; paymentAttemptState: PaymentAttemptState | null;
  paymentAttemptHeadKey?: string; paymentAttemptCreatedAt?: string; paymentAttemptCancelSupported?: boolean } {
  const deadline = paymentAttemptDeadline(value);
  const state = sources(value).map(row => String(row.paymentAttemptState || "").trim().toUpperCase())
    .find(v => ["PAYMENT_REQUIRED", "CLOSING", "PAID"].includes(v));
  const head = sources(value).map(row => row.paymentAttemptHeadKey).find(v => typeof v === "string" && v.trim());
  const created = sources(value).map(row => instant(row.paymentAttemptCreatedAt)).find(v => v !== null);
  const supported = sources(value).map(row => row.paymentAttemptCancelSupported).filter(v => typeof v === "boolean");
  return { paymentExpiresAt: deadline === null ? null : new Date(deadline).toISOString(),
    paymentAttemptState: state as PaymentAttemptState | undefined || null,
    ...(typeof head === "string" ? { paymentAttemptHeadKey: head } : {}),
    ...(supported.length ? { paymentAttemptCancelSupported: supported.every(v => v === true) } : {}),
    ...(created != null ? { paymentAttemptCreatedAt: new Date(created).toISOString() } : {}) };
}
export function canOpenPaymentAttempt(value: unknown, now = Date.now()): boolean {
  const rows = sources(value);
  if (rows.some(paymentCancellationBlocksAttempt)) return false;
  const blocked = ["PAID", "CLOSING", "EXPIRED", "CANCELLED", "CANCELED", "RELEASED", "FAILED"];
  if (!Number.isFinite(now) || rows.some(row => row.paid === true
    || [row.paymentAttemptState, row.status, row.state].some(state => blocked.includes(String(state || "").trim().toUpperCase()))
    || row.paymentAttemptState != null && !["", "PAYMENT_REQUIRED"].includes(String(row.paymentAttemptState).trim().toUpperCase()))) return false;
  const deadline = paymentAttemptDeadline(value);
  if (deadline === null || deadline <= now) return false;
  const urlValue = rows.map(row => row.paymentUrl).find(v => typeof v === "string" && v.trim());
  try {
    const url = new URL(String(urlValue || ""));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

// A positive historical charge may be settled. Plain paid:true is insufficient:
// the authenticated lifecycle response must name its booking, exercise and bill.
export function isSettledPaymentAttempt(value: unknown): boolean {
  const rows = sources(value);
  if (rows.some(row => typeof row.paymentUrl === "string" && row.paymentUrl.trim())) return false;
  return rows.some(row => String(row.paymentAttemptState || "").trim().toUpperCase() === "PAID"
    && row.paid === true && [row.bookingId, row.exerciseId, row.transactionId]
      .every(id => typeof id === "string" && id.trim()));
}
