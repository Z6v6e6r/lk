/**
 * Composite order: participation + residency in ONE payment (owner decision 2026-11-17).
 *
 * Pure planner, no I/O. It never invents a price, a discount or a combination rule:
 * - the residency price comes from a fresh Viva product read (RES-005);
 * - the discount percent comes from the CUP-published residency policy;
 * - the owner rule of 2026-11-17: participation in the same order gets the residency discount;
 * - an existing or unknown residency state refuses the sale (RES-006, fail closed);
 * - no consent, no payable plan (RES-004);
 * - a tournament level decision is taken before payment and kept in the snapshot.
 *
 * The plan is the server's input for a single provider transaction. Clients must not send
 * per-line discounts to Viva; the transaction is created server-side.
 */
import { RESIDENCY_PRODUCT_ID } from "./residencyPurchase.ts";

export const COMPOSITE_RESIDENCY_PRICE_MAX_AGE_MS = 60_000;

export type CompositeCategory = "GROUP_TRAINING" | "TOURNAMENT";

export type CompositeRefusal =
  | "CATEGORY_UNSUPPORTED"
  | "PARTICIPATION_INVALID"
  | "RESIDENCY_PRODUCT_INVALID"
  | "RESIDENCY_PRICE_STALE"
  | "RESIDENCY_POLICY_UNAVAILABLE"
  | "ALREADY_RESIDENT"
  | "RESIDENCY_STATE_UNKNOWN"
  | "LEVEL_DECISION_REQUIRED"
  | "LEVEL_DENIED"
  | "CONSENT_REQUIRED";

export interface CompositeResidencyInput {
  category: string;
  participation: { productId: string; name: string; exerciseId: string; basePriceMinor: number };
  /** Fresh Viva read of the residency product card. */
  residencyProduct: { id: string; name: string; costMinor: number; observedAtMs: number } | null;
  /** CUP-published residency policy for new purchases. */
  policy: {
    publicationId: string;
    policyVersion: number;
    groupTrainingDiscountPercent: number;
    tournamentDiscountPercent: number;
  } | null;
  /** Owned-residency read for this client: NONE only when the read succeeded and found nothing usable. */
  existingResidency: "NONE" | "ACTIVE" | "UNKNOWN";
  /** Required for tournaments; GET {CUP}/api/tournaments/:id/level-decision taken before payment. */
  levelDecision?: { enforced: boolean; allowed: boolean; ruleVersion: string; evaluatedAt: string } | null;
  consentAccepted: boolean;
  nowMs: number;
}

export interface CompositePlanLine {
  role: "PARTICIPATION" | "RESIDENCY";
  productId: string;
  name: string;
  count: 1;
  costMinor: number;
  discountMinor: number;
  toPayMinor: number;
  exerciseId?: string;
}

export interface CompositeResidencyPlan {
  ok: true;
  lines: [CompositePlanLine, CompositePlanLine];
  breakdown: {
    participationBaseMinor: number;
    discountPercent: number;
    participationDiscountMinor: number;
    participationToPayMinor: number;
    residencyMinor: number;
    totalMinor: number;
  };
  snapshot: {
    residencyProductId: string;
    residencyPriceObservedAtMs: number;
    publicationId: string;
    policyVersion: number;
    level: { enforced: boolean; allowed: boolean; ruleVersion: string; evaluatedAt: string } | null;
  };
}

export type CompositeResidencyResult = CompositeResidencyPlan | { ok: false; reason: CompositeRefusal };

const minor = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const percent = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const refuse = (reason: CompositeRefusal): CompositeResidencyResult => ({ ok: false, reason });

/** Same rounding as the existing residency booking preview: base - floor(base * pct / 100). */
export function residencyDiscountedPrice(baseMinor: number, discountPercent: number): number {
  return baseMinor - Math.floor((baseMinor * discountPercent) / 100);
}

/** Payable plan, or the first refusal. Without consent it refuses with CONSENT_REQUIRED (RES-004). */
export function planCompositeResidencyOrder(input: CompositeResidencyInput): CompositeResidencyResult {
  if (input.category !== "GROUP_TRAINING" && input.category !== "TOURNAMENT") return refuse("CATEGORY_UNSUPPORTED");
  const p = input.participation;
  if (!p || !text(p.productId) || !text(p.name) || !text(p.exerciseId) || !minor(p.basePriceMinor) || p.basePriceMinor <= 0) {
    return refuse("PARTICIPATION_INVALID");
  }
  if (p.productId.toLowerCase() === RESIDENCY_PRODUCT_ID) return refuse("PARTICIPATION_INVALID");

  if (input.existingResidency === "ACTIVE") return refuse("ALREADY_RESIDENT");
  if (input.existingResidency !== "NONE") return refuse("RESIDENCY_STATE_UNKNOWN");

  const r = input.residencyProduct;
  if (!r || r.id.toLowerCase() !== RESIDENCY_PRODUCT_ID || !text(r.name) || !minor(r.costMinor) || r.costMinor <= 0) {
    return refuse("RESIDENCY_PRODUCT_INVALID");
  }
  const age = input.nowMs - r.observedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > COMPOSITE_RESIDENCY_PRICE_MAX_AGE_MS) return refuse("RESIDENCY_PRICE_STALE");

  const policy = input.policy;
  const pct = input.category === "TOURNAMENT" ? policy?.tournamentDiscountPercent : policy?.groupTrainingDiscountPercent;
  if (!policy || !text(policy.publicationId) || !Number.isSafeInteger(policy.policyVersion) || !percent(pct)) {
    return refuse("RESIDENCY_POLICY_UNAVAILABLE");
  }

  let level: CompositeResidencyPlan["snapshot"]["level"] = null;
  if (input.category === "TOURNAMENT") {
    const d = input.levelDecision;
    if (!d || typeof d.enforced !== "boolean" || typeof d.allowed !== "boolean" || !text(d.ruleVersion)
      || !Number.isFinite(Date.parse(d.evaluatedAt))) return refuse("LEVEL_DECISION_REQUIRED");
    if (d.enforced && !d.allowed) return refuse("LEVEL_DENIED");
    level = { enforced: d.enforced, allowed: d.allowed, ruleVersion: d.ruleVersion, evaluatedAt: d.evaluatedAt };
  }

  if (input.consentAccepted !== true) return refuse("CONSENT_REQUIRED");

  const participationToPay = residencyDiscountedPrice(p.basePriceMinor, pct);
  const participationDiscount = p.basePriceMinor - participationToPay;
  return {
    ok: true,
    lines: [
      { role: "PARTICIPATION", productId: p.productId, name: p.name, count: 1, exerciseId: p.exerciseId,
        costMinor: p.basePriceMinor, discountMinor: participationDiscount, toPayMinor: participationToPay },
      { role: "RESIDENCY", productId: RESIDENCY_PRODUCT_ID, name: r.name, count: 1,
        costMinor: r.costMinor, discountMinor: 0, toPayMinor: r.costMinor },
    ],
    breakdown: {
      participationBaseMinor: p.basePriceMinor,
      discountPercent: pct,
      participationDiscountMinor: participationDiscount,
      participationToPayMinor: participationToPay,
      residencyMinor: r.costMinor,
      totalMinor: participationToPay + r.costMinor,
    },
    snapshot: {
      residencyProductId: RESIDENCY_PRODUCT_ID,
      residencyPriceObservedAtMs: r.observedAtMs,
      publicationId: policy.publicationId,
      policyVersion: policy.policyVersion,
      level,
    },
  };
}

/** Offer preview for the UI: the same plan with consent assumed, used only to render amounts. */
export function previewCompositeResidencyOffer(input: CompositeResidencyInput): CompositeResidencyResult {
  return planCompositeResidencyOrder({ ...input, consentAccepted: true });
}
