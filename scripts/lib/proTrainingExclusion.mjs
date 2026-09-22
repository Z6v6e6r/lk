// PRO-level trainings stay outside every subscription benefit, on both sides of the
// contour: the advisory price preview quotes nothing for them and the atomic booking
// gateway refuses managed plans while allowing only an owned Energy 5/25 visit pack.
// A PRO training is paid at its full one-time price; promo codes are not part of this
// rule.
//
// Owner decision 2026-09-18: "Тренировка ПРО уровень …" (5505/5506/5507, exercise type
// 605) and "Игра+Тренер ПРО уровень …" (5502/5503/5504, exercise type 847) must not be
// bookable with a subscription and must not receive the plan discount or the
// free-first-event benefit.
//
// This module is embedded verbatim into the booking gateway by the release composition
// (`hubGatewaySource()` in scripts/lib/eventPaymentSources.mjs) and into the advisory price
// preview's canonical closure, so the rule has exactly one reviewed source. The widget
// carries the same ids and the same token in `src/utils/proTrainingExclusion.ts`;
// `scripts/tests/proTrainingExclusion.test.ts` pins both sides.
//
// Scope note: the reviewed server guard covers the subscription *booking* endpoint. The
// "buy a subscription package for this exercise" transaction is created by the browser
// straight in Viva and is not carried by that endpoint, so it is currently excluded by the
// widget plus the owner-side Viva product configuration only — see
// docs/LK1_PRO_TRAINING_EXCLUSIONS_20260918.md («Остаточные риски»).
export const PRO_TRAINING_DIRECTION_IDS = Object.freeze([5502, 5503, 5504, 5505, 5506, 5507]);

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
  const visitsLeft = [
    value.visitsLeft,
    value.visitsRemaining,
    value.remainingVisits,
    proTrainingIsRecord(value.raw) ? value.raw.visitsLeft : null,
    proTrainingIsRecord(value.raw) ? value.raw.visitsRemaining : null,
    proTrainingIsRecord(value.raw) ? value.raw.remainingVisits : null,
    proTrainingIsRecord(value.subscription) ? value.subscription.visitsLeft : null,
  ].find((candidate) => candidate !== null && candidate !== undefined);
  if (visitsLeft !== undefined && visitsLeft !== null) {
    const numericVisits = Number(visitsLeft);
    if (!Number.isFinite(numericVisits) || numericVisits <= 0) return false;
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
    return /^(энергия|energy) (5|25)$/.test(normalized || "");
  });
}
