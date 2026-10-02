// PRO trainings allow exactly 50% monetary discounts for managed RA/Academy
// subscriptions, including promo variants. Free-first-event visits stay excluded.
// Energy 5/25 keeps its existing visit-pack path; other plans stay unavailable.
// Embedded in booking and preview from this single source.
export const PRO_TRAINING_DIRECTION_IDS = Object.freeze([5502, 5503, 5504, 5505, 5506, 5507]);

const PRO_TRAINING_DISCOUNT_PRODUCT_IDS = Object.freeze([
  "b91e14d1-fe6e-4d0b-be39-3e45ad86b759", // RA
  "3b4806f1-6f9a-46df-a7d7-45075b4e7274", // promo RA
  "9eb8a7a4-c195-492a-95e4-3fb82899ac10", // Academy
  "6bda152b-0a9c-4308-82d0-3cd4e6aa680d", // promo Academy
]);
export function isProTrainingDiscountRule(rule) {
  return rule !== null && typeof rule === "object"
    && typeof rule.productId === "string"
    && PRO_TRAINING_DISCOUNT_PRODUCT_IDS.includes(rule.productId.toLowerCase())
    && rule.groupTrainingDiscountPercent === 50;
}

// "ПРО" must be a standalone token: "Профсоюзная", "пробная" and "просто" are ordinary
// directions in the same catalogue and must never match.
const PRO_TRAINING_NAME_TOKEN = /(^|[^a-zа-яё0-9])про([^a-zа-яё0-9]|$)/i;
const PRO_TRAINING_ENERGY_PRODUCT_IDS = new Set([
  "dfa72adf-233b-4285-8d69-e5eab4234fbe",
  // The live subscription-media flow carries this Energy 25 catalog id alongside
  // the exact product name; keep the name fallback for providers that omit product ids.
  "9fb759fd-f70c-4395-84e7-57716df97e14",
]);

const proTrainingIsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const proTrainingStr = (value) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const proTrainingNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = proTrainingStr(value);
  if (!text) return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

/** True when a direction/type/training label carries the standalone "ПРО" token. */
export function isProTrainingName(value) {
  const text = proTrainingStr(value);
  return Boolean(text && PRO_TRAINING_NAME_TOKEN.test(text));
}

/**
 * True for a PRO training. Accepts the server-resolved Viva exercise record; the
 * direction id is authoritative, the name token is the fallback for a direction
 * created after this list was reviewed.
 *
 * The id is read through the same aliases `resolveCategory` accepts, including a
 * scalar `direction` (Viva sometimes carries the bare direction id there), so the
 * category and the PRO verdict can never disagree about which direction this is.
 */
export function isProTrainingExercise(value) {
  if (!proTrainingIsRecord(value)) return false;
  const rawDirection = value.direction ?? value.exerciseDirection;
  const direction = proTrainingIsRecord(rawDirection) ? rawDirection : null;
  const directionId = proTrainingNum(direction
    ? (direction.id ?? direction.directionId)
    : rawDirection) ?? proTrainingNum(value.directionId ?? value.exerciseDirectionId);
  if (directionId !== null && PRO_TRAINING_DIRECTION_IDS.includes(directionId)) return true;
  return [
    direction?.name,
    direction?.title,
    value.directionName,
    value.title,
    value.name,
  ].some((candidate) => isProTrainingName(candidate));
}

// Energy visit packs are the only subscription-like product that may consume a
// visit for a PRO group training. Keep the match narrow: RA, Academy, Friendship,
// and arbitrary products that merely contain an energy marker must remain blocked.
export function isProTrainingEnergyPack(value) {
  if (!proTrainingIsRecord(value)) return false;
  const visitRecords = [
    value,
    value.raw,
    value.product,
    proTrainingIsRecord(value.raw) ? value.raw.product : null,
    value.subscription,
    value.clientSubscription,
    value.clientSub,
    value.subscriptionProduct,
    value.clientSubscriptionProduct,
  ].filter(proTrainingIsRecord);
  const visitValues = visitRecords.flatMap((record) => [
    record.visitsLeft,
    record.visitsRemaining,
    record.remainingVisits,
    record.availableVisits,
    record.balance,
    record.left,
  ]).filter((candidate) => candidate !== null && candidate !== undefined);
  if (visitValues.length > 0 && visitValues.some((candidate) => {
    const numericVisits = Number(candidate);
    return !Number.isFinite(numericVisits) || numericVisits <= 0;
  })) {
    return false;
  }
  const productIds = [
    value.productId,
    value.subscriptionProductId,
    value.templateId,
    proTrainingIsRecord(value.product) ? value.product.id : null,
    proTrainingIsRecord(value.product) ? value.product.uuid : null,
    proTrainingIsRecord(value.product) ? value.product.productId : null,
    proTrainingIsRecord(value.subscription) ? value.subscription.productId : null,
    proTrainingIsRecord(value.subscription) ? value.subscription.subscriptionProductId : null,
    proTrainingIsRecord(value.raw) && proTrainingIsRecord(value.raw.product) ? value.raw.product.id : null,
    proTrainingIsRecord(value.raw) && proTrainingIsRecord(value.raw.product) ? value.raw.product.uuid : null,
    proTrainingIsRecord(value.raw) && proTrainingIsRecord(value.raw.product) ? value.raw.product.productId : null,
    proTrainingIsRecord(value.clientSubscription) ? value.clientSubscription.productId : null,
    proTrainingIsRecord(value.clientSubscription) ? value.clientSubscription.subscriptionProductId : null,
    proTrainingIsRecord(value.clientSub) ? value.clientSub.productId : null,
    proTrainingIsRecord(value.clientSub) ? value.clientSub.subscriptionProductId : null,
  ]
    .map((candidate) => proTrainingStr(candidate)?.toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (productIds.length > 0) return productIds.every((id) => PRO_TRAINING_ENERGY_PRODUCT_IDS.has(id));
  const candidates = [
    value.subscriptionName,
    value.productName,
    value.name,
    value.title,
    proTrainingIsRecord(value.subscription) ? value.subscription.name : null,
    proTrainingIsRecord(value.product) ? value.product.name : null,
    proTrainingIsRecord(value.clientSubscription) ? value.clientSubscription.name : null,
    proTrainingIsRecord(value.clientSub) ? value.clientSub.name : null,
  ];
  return candidates.some((candidate) => {
    const normalized = proTrainingStr(candidate)
      ?.toLocaleLowerCase("ru-RU")
      .replace(/[^a-zа-яё0-9]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return /^(энергия|energy) (5|25)(?: |$)/.test(normalized || "");
  });
}
