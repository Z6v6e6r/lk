import type { Subscription } from "../utils/apiClient";
import { isSplitSubscriptionValidForGameDate } from "../components/games/splitSubscriptionAvailability.ts";
import { RESIDENCY_LIFECYCLE_PRODUCT_ID } from "../residency/residencyLifecycleClient.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxQuoteCandidates = 20;

type ProductAliases = {
  productId?: unknown;
  subscriptionProductId?: unknown;
  templateId?: unknown;
  product?: { id?: unknown; uuid?: unknown; productId?: unknown };
};

type GameSubscriptionIdentity = Pick<Subscription, "subscriptionId"> & ProductAliases & {
  subscription?: ProductAliases;
  clientSubscription?: ProductAliases;
  clientSub?: ProductAliases;
  raw?: ProductAliases;
};

function readProductAliases(subscription: GameSubscriptionIdentity) {
  return [subscription, subscription.subscription, subscription.clientSubscription,
    subscription.clientSub, subscription.raw].flatMap(value => [
    value?.productId, value?.subscriptionProductId, value?.templateId,
    value?.product?.id, value?.product?.uuid, value?.product?.productId,
  ]).filter(value => value != null);
}

function hasResidencyProduct(productIds: unknown[]): boolean {
  return productIds.length > 0 && productIds.every(value =>
    typeof value === "string" && value.toLowerCase() === RESIDENCY_LIFECYCLE_PRODUCT_ID);
}

function isVivaId(value: unknown, id: number): boolean {
  return value === id || value === id.toString();
}

export function isPilotGameResidencyProduct(subscription: GameSubscriptionIdentity | undefined): boolean {
  return subscription !== undefined && hasResidencyProduct(readProductAliases(subscription));
}

export function addPilotGameResidencyCandidates(
  eligible: Subscription[],
  owned: readonly (Subscription & GameSubscriptionIdentity)[],
  gameDate: string | null,
  now = Date.now(),
): Subscription[] {
  const remaining = maxQuoteCandidates - eligible.length;
  if (remaining <= 0) return eligible;
  const seen = new Set(eligible.map(subscription => subscription.subscriptionId.trim()));
  const verified: Subscription[] = [];
  const unidentified: Subscription[] = [];
  for (const subscription of owned) {
    const id = subscription.subscriptionId.trim();
    if (seen.has(id) || !uuid.test(id) || subscription.status !== "ACTIVE"
      || (subscription.holdUntil && Date.parse(subscription.holdUntil) > now)
      || !isSplitSubscriptionValidForGameDate(subscription, gameDate)) continue;

    const productIds = readProductAliases(subscription);
    if (hasResidencyProduct(productIds)) {
      verified.push({ ...subscription, name: "Резидентство ПадлхАБ" });
      seen.add(id);
      continue;
    }
    const types = Array.isArray(subscription.availableTypes) ? subscription.availableTypes : [];
    const directions = Array.isArray(subscription.availableDirections) ? subscription.availableDirections : [];
    const hasTournamentType = types.some(type => isVivaId(type?.id, 839));
    const hasResidencyType = types.some(type => isVivaId(type?.id, 2572)
      && typeof type.name === "string" && /^резидентство$/iu.test(type.name.trim()));
    const hasResidencyDirection = subscription.hasDirectionLimitation === true && directions.length === 1
      && isVivaId(directions[0]?.id, 7291);
    const matchesLegacyResidency = hasTournamentType && (types.length === 1
      || types.length === 2 && hasResidencyType && hasResidencyDirection);
    const name = typeof subscription.name === "string" ? subscription.name.trim() : "";
    if (!productIds.length && subscription.hasTypeLimitation === true
      && matchesLegacyResidency
      && (!name || /^(?:абонемент|резидентство(?:\s+падлхаб)?)$/iu.test(name))) {
      unidentified.push(subscription);
      seen.add(id);
    }
  }
  if (verified.length) return [...eligible, ...verified.slice(0, remaining)];
  // A single legacy row may need an advisory quote. Keep ambiguity out of quote batches
  // that already have an active option; the server still verifies the actual product.
  if (unidentified.length === 1 && !eligible.some(subscription =>
    subscription.status === "ACTIVE" && isSplitSubscriptionValidForGameDate(subscription, gameDate))) {
    return [...eligible, unidentified[0]];
  }
  return eligible;
}
