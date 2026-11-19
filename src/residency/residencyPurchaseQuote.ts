/**
 * First residency purchase from a group training: the server quote (lk#463, ph-admin#134).
 *
 * `POST /lk/subscriptions/game-price-preview` with
 * `{ target: { targetKind: "GROUP_TRAINING_RESIDENCY_PURCHASE", exerciseId } }` returns
 * `{ residencyPurchaseQuote, serverTimeMs }`. The server resolves the exercise tariff, the
 * residency card in Viva and the CUP-published policy; the client sends no money fields and
 * only renders the amounts.
 *
 * Pure, no I/O. The client still refuses a quote that does not belong to the selected
 * exercise, does not add up, or has expired. Expiry is measured on the local clock from
 * the moment the request was sent: `expiresAt - serverTimeMs` is the remaining lifetime, so
 * a skewed device clock cannot extend it.
 */
import { RESIDENCY_PRODUCT_ID } from "./residencyPurchase.ts";

export interface ResidencyPurchaseQuote {
  exerciseId: string;
  participationProductId: string;
  residencyProductId: string;
  existingResidency: "NONE";
  publicationId: string;
  policyVersion: number;
  policyDigest: string;
  participationBaseMinor: number;
  discountPercent: number;
  participationDiscountMinor: number;
  participationToPayMinor: number;
  residencyMinor: number;
  totalMinor: number;
  /** Server epoch ms. */
  expiresAt: number;
  /** Local epoch ms after which the quote must not be shown or consented to. */
  localExpiresAtMs: number;
}

export type ResidencyPurchaseQuoteRefusal =
  | "QUOTE_MISSING"
  | "QUOTE_INVALID"
  | "QUOTE_EXERCISE_MISMATCH"
  | "QUOTE_EXPIRED";

export type ResidencyPurchaseQuoteResult =
  | { ok: true; quote: ResidencyPurchaseQuote }
  | { ok: false; reason: ResidencyPurchaseQuoteRefusal };

const minor = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseResidencyPurchaseQuote(body: unknown, context: {
  /** The exercise the request was sent for, and that is still selected. */
  exerciseId: string;
  /** Local time when the request was sent. */
  requestedAtMs: number;
  /** Local time now. */
  nowMs: number;
}): ResidencyPurchaseQuoteResult {
  if (!isObject(body) || !isObject(body.residencyPurchaseQuote)) return { ok: false, reason: "QUOTE_MISSING" };
  const q = body.residencyPurchaseQuote;
  const serverTimeMs = body.serverTimeMs;
  if (q.schemaVersion !== 1 || q.kind !== "GROUP_TRAINING_RESIDENCY_PURCHASE_QUOTE" || q.currency !== "RUB"
    || !text(q.exerciseId) || !text(q.participationProductId) || !text(q.residencyProductId)
    || String(q.residencyProductId).toLowerCase() !== RESIDENCY_PRODUCT_ID
    || String(q.participationProductId).toLowerCase() === RESIDENCY_PRODUCT_ID
    || q.existingResidency !== "NONE"
    || !text(q.publicationId) || !Number.isSafeInteger(q.policyVersion) || (q.policyVersion as number) < 1
    || !text(q.policyDigest)
    || !minor(q.participationBaseMinor) || q.participationBaseMinor <= 0
    || !Number.isInteger(q.discountPercent) || (q.discountPercent as number) <= 0 || (q.discountPercent as number) > 100
    || !minor(q.participationDiscountMinor) || !minor(q.participationToPayMinor)
    || !minor(q.residencyMinor) || q.residencyMinor <= 0 || !minor(q.totalMinor)
    || !minor(q.expiresAt) || !minor(serverTimeMs)) {
    return { ok: false, reason: "QUOTE_INVALID" };
  }
  // The client renders the server's numbers, but only when they add up exactly.
  const discount = Math.floor((q.participationBaseMinor * (q.discountPercent as number)) / 100);
  if (q.participationDiscountMinor !== discount
    || q.participationToPayMinor !== q.participationBaseMinor - discount
    || q.totalMinor !== q.participationToPayMinor + q.residencyMinor) {
    return { ok: false, reason: "QUOTE_INVALID" };
  }
  if (q.exerciseId !== context.exerciseId) return { ok: false, reason: "QUOTE_EXERCISE_MISMATCH" };
  const lifetimeMs = q.expiresAt - serverTimeMs;
  const localExpiresAtMs = context.requestedAtMs + lifetimeMs;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || !isResidencyPurchaseQuoteFreshAt(localExpiresAtMs, context.nowMs)) {
    return { ok: false, reason: "QUOTE_EXPIRED" };
  }
  return {
    ok: true,
    quote: {
      exerciseId: q.exerciseId,
      participationProductId: q.participationProductId as string,
      residencyProductId: q.residencyProductId as string,
      existingResidency: "NONE",
      publicationId: q.publicationId as string,
      policyVersion: q.policyVersion as number,
      policyDigest: q.policyDigest as string,
      participationBaseMinor: q.participationBaseMinor,
      discountPercent: q.discountPercent as number,
      participationDiscountMinor: q.participationDiscountMinor,
      participationToPayMinor: q.participationToPayMinor,
      residencyMinor: q.residencyMinor,
      totalMinor: q.totalMinor,
      expiresAt: q.expiresAt,
      localExpiresAtMs,
    },
  };
}

function isResidencyPurchaseQuoteFreshAt(localExpiresAtMs: number, nowMs: number) {
  return Number.isFinite(nowMs) && nowMs < localExpiresAtMs;
}

/** A quote is usable for display and consent only for the selected exercise and before expiry. */
export function isResidencyPurchaseQuoteUsable(
  quote: ResidencyPurchaseQuote | null,
  selectedExerciseId: string | null,
  nowMs: number,
): quote is ResidencyPurchaseQuote {
  return Boolean(quote && selectedExerciseId && quote.exerciseId === selectedExerciseId
    && isResidencyPurchaseQuoteFreshAt(quote.localExpiresAtMs, nowMs));
}

/**
 * The exercise to request a first-residency quote for, or null.
 *
 * Only a confirmed NONE owned-residency read asks for a quote. While the read is in flight
 * (null), and on ACTIVE or UNKNOWN, no quote is requested or shown: an UNKNOWN residency
 * refuses the sale (fail closed) and a resident must never see a first-purchase price.
 */
export function residencyQuoteExerciseIdFor(params: {
  compositeEligible: boolean;
  isTournament: boolean;
  selectedExerciseId: string | null;
  ownedResidencyState: "ACTIVE" | "NONE" | "UNKNOWN" | null;
}): string | null {
  return params.compositeEligible && !params.isTournament && params.selectedExerciseId
    && params.ownedResidencyState === "NONE" ? params.selectedExerciseId : null;
}

/** Automatic re-quotes after expiry per opened training; afterwards the player asks for one. */
export const RESIDENCY_PURCHASE_QUOTE_AUTO_REFRESH_LIMIT = 3;
