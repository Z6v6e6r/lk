// Topokraty trainings stay outside every non-club subscription benefit.
//
// Viva scopes a sold subscription to its own directions and exercise types, while the LK1
// contour used to price an event by category alone. A group training of the club directions
// 6180 «Топократы игра» / 6233 «Топократы тренировка» therefore received the free first
// event of the day (0 ₽) or the plan percentage, and the provider then refused the write:
//
//   HTTP 400 BAD_REQUEST «Абонемент «РА» не действует на этом занятии:
//                        другой тип занятия, другое направление»
//
// Owner decision 2026-09-26 (docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md) plus the incident of
// 2026-09-25: a Topokraty event is bookable either by one-off payment at the full price, or
// with the club product «Дружба Топократы» (14692232-12be-4218-9fa1-2d5b79b62035) whose own
// plan rule carries the quarter-of-court co-pay. Any other subscription is refused before the
// provider write — in the atomic booking gateway and in the advisory price preview — and the
// widget does not offer it.
//
// This module is embedded verbatim into the booking gateway by the release composition
// (`hubGatewaySource()` in scripts/lib/eventPaymentSources.mjs) and into the advisory price
// preview's canonical closure, so the rule has exactly one reviewed source. The widget
// carries the same ids and the same token in `src/utils/topokratyExclusion.ts`;
// `scripts/tests/topokratyExclusion.test.ts` pins both sides.
//
// Residual risk (same shape as the PRO-training rule): a browser-side purchase of a
// subscription package for this exercise is created by the widget straight in Viva and is
// not carried by the booking endpoint, so it stays excluded by the widget plus the
// owner-side Viva product configuration only.
export const TOPOKRATY_DIRECTION_IDS = Object.freeze([6180, 6233]);

// «Дружба Топократы» is the only product whose plan rule may price a Topokraty event.
export const TOPOKRATY_CLUB_PRODUCT_IDS = Object.freeze(["14692232-12be-4218-9fa1-2d5b79b62035"]);

// "Топократ" must be a standalone token, so an unrelated direction that merely embeds the
// stem inside a longer word is never captured.
const TOPOKRATY_NAME_TOKEN = /(^|[^a-zа-яё0-9])топократ(?:ы|ов|а|ия|ий)?([^a-zа-яё0-9]|$)/i;

const topokratyIsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const topokratyStr = (value) => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
};

const topokratyNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = topokratyStr(value);
  if (!text) return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

/** True when a direction/training label carries the standalone "Топократ" token. */
export function isTopokratyName(value) {
  const text = topokratyStr(value);
  return Boolean(text && TOPOKRATY_NAME_TOKEN.test(text));
}

/**
 * True for a Topokraty exercise. Accepts the server-resolved Viva exercise record; the
 * direction id is authoritative, the name token is the fallback for a direction created
 * after this list was reviewed. The id is read through the same aliases the PRO-training
 * rule uses (including a scalar `direction`), so the category and this verdict can never
 * disagree about which direction the event belongs to.
 */
export function isTopokratyExercise(value) {
  if (!topokratyIsRecord(value)) return false;
  const rawDirection = value.direction ?? value.exerciseDirection;
  const direction = topokratyIsRecord(rawDirection) ? rawDirection : null;
  const directionId = topokratyNum(direction
    ? (direction.id ?? direction.directionId)
    : rawDirection) ?? topokratyNum(value.directionId ?? value.exerciseDirectionId);
  if (directionId !== null && TOPOKRATY_DIRECTION_IDS.includes(directionId)) return true;
  return [
    direction?.name,
    direction?.title,
    value.directionName,
    value.title,
    value.name,
  ].some((candidate) => isTopokratyName(candidate));
}

/**
 * True for an actor-owned row of the club product «Дружба Топократы». The product id is
 * authoritative; the product name is the fallback for a provider that omits ids. The match
 * stays narrow on purpose: any other owned subscription, including a product that merely
 * mentions the club in its title, must not unlock the club path.
 */
export function isTopokratyClubPack(value) {
  if (!topokratyIsRecord(value)) return false;
  const productIds = [
    value.productId,
    value.subscriptionProductId,
    value.templateId,
    topokratyIsRecord(value.product) ? value.product.id : null,
    topokratyIsRecord(value.product) ? value.product.uuid : null,
    topokratyIsRecord(value.product) ? value.product.productId : null,
    topokratyIsRecord(value.subscription) ? value.subscription.productId : null,
    topokratyIsRecord(value.subscription) ? value.subscription.subscriptionProductId : null,
    // The checkout API wraps the Viva row: a TournamentVivaProduct carries it under `raw`.
    topokratyIsRecord(value.raw) ? value.raw.productId : null,
    topokratyIsRecord(value.raw) ? value.raw.subscriptionProductId : null,
    topokratyIsRecord(value.raw) ? value.raw.templateId : null,
    topokratyIsRecord(value.raw) && topokratyIsRecord(value.raw.product) ? value.raw.product.id : null,
    topokratyIsRecord(value.raw) && topokratyIsRecord(value.raw.product) ? value.raw.product.uuid : null,
    topokratyIsRecord(value.raw) && topokratyIsRecord(value.raw.product) ? value.raw.product.productId : null,
    topokratyIsRecord(value.raw) && topokratyIsRecord(value.raw.subscription) ? value.raw.subscription.productId : null,
    topokratyIsRecord(value.raw) && topokratyIsRecord(value.raw.subscription) ? value.raw.subscription.subscriptionProductId : null,
    topokratyIsRecord(value.clientSubscription) ? value.clientSubscription.productId : null,
    topokratyIsRecord(value.clientSubscription) ? value.clientSubscription.subscriptionProductId : null,
    topokratyIsRecord(value.clientSub) ? value.clientSub.productId : null,
    topokratyIsRecord(value.clientSub) ? value.clientSub.subscriptionProductId : null,
  ]
    .map((candidate) => topokratyStr(candidate)?.toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (productIds.length > 0) {
    return productIds.every((id) => TOPOKRATY_CLUB_PRODUCT_IDS.includes(id));
  }
  const candidates = [
    value.subscriptionName,
    value.productName,
    value.name,
    value.title,
    topokratyIsRecord(value.subscription) ? value.subscription.name : null,
    topokratyIsRecord(value.product) ? value.product.name : null,
    topokratyIsRecord(value.clientSubscription) ? value.clientSubscription.name : null,
    topokratyIsRecord(value.clientSub) ? value.clientSub.name : null,
  ];
  return candidates.some((candidate) => isTopokratyName(candidate));
}
