/**
 * Group schedule → composite residency offer input (#459, built on #441).
 *
 * Pure adapter, no I/O. Every source the planner needs must be server-proven; whatever is
 * missing stays null/UNKNOWN so `planCompositeResidencyOrder` refuses (fail closed) and the
 * schedule keeps its ordinary single-product checkout:
 * - participation price: the ordinary one-time product of the selected training (Viva checkout);
 * - residency price: the residency product card, only when the same checkout read returned it;
 * - existing residency: ACTIVE when the checkout shows an owned residency; otherwise only a
 *   dedicated owned-residency read may say NONE, because Viva may omit a discount-only product
 *   from the client's available subscriptions (no such read is wired yet → UNKNOWN);
 * - CUP policy for a residency not yet bought: no source yet (Б1, lk#457) → null.
 */
import type { CompositeResidencyInput } from "./compositeResidencyOrder.ts";
import { RESIDENCY_PRODUCT_ID } from "./residencyPurchase.ts";

export interface GroupScheduleCompositeProduct {
  id: string;
  name: string;
  cost: number | null;
  source: string;
}

export interface GroupScheduleCompositeCheckout {
  exerciseId: string;
  oneTimes: GroupScheduleCompositeProduct[];
  subscriptions: GroupScheduleCompositeProduct[];
  clientSubscriptions: GroupScheduleCompositeProduct[];
  purchasedProducts: GroupScheduleCompositeProduct[];
}

export type GroupScheduleCompositeInput = Omit<CompositeResidencyInput, "consentAccepted">;

const isResidency = (product: GroupScheduleCompositeProduct) =>
  String(product.id || "").toLowerCase() === RESIDENCY_PRODUCT_ID;

const isPositiveMinor = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

export function buildGroupScheduleCompositeInput(params: {
  isTournament: boolean;
  checkout: GroupScheduleCompositeCheckout;
  /** When the checkout read finished; the residency price is as fresh as this read. */
  checkoutObservedAtMs: number;
  policy?: CompositeResidencyInput["policy"];
  levelDecision?: CompositeResidencyInput["levelDecision"];
  /** A dedicated owned-residency read; without one the state stays UNKNOWN. */
  existingResidency?: CompositeResidencyInput["existingResidency"];
  nowMs: number;
}): GroupScheduleCompositeInput | null {
  const { checkout } = params;
  const participation = checkout.oneTimes.find(product => product.source === "one-time"
    && !isResidency(product) && isPositiveMinor(product.cost));
  if (!participation || !isPositiveMinor(participation.cost)) return null;

  const residency = [...checkout.subscriptions, ...checkout.oneTimes]
    .find(product => isResidency(product) && isPositiveMinor(product.cost));
  const owned = [...checkout.clientSubscriptions, ...checkout.purchasedProducts].some(isResidency);

  return {
    category: params.isTournament ? "TOURNAMENT" : "GROUP_TRAINING",
    participation: {
      productId: participation.id,
      name: participation.name,
      exerciseId: checkout.exerciseId,
      basePriceMinor: participation.cost,
    },
    residencyProduct: residency && isPositiveMinor(residency.cost)
      ? { id: residency.id, name: residency.name, costMinor: residency.cost, observedAtMs: params.checkoutObservedAtMs }
      : null,
    policy: params.policy ?? null,
    existingResidency: owned ? "ACTIVE" : params.existingResidency ?? "UNKNOWN",
    levelDecision: params.levelDecision ?? null,
    nowMs: params.nowMs,
  };
}
