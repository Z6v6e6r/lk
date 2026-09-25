/**
 * Топократы (клубные направления 6180 «Топократы игра» и 6233 «Топократы тренировка»)
 * не входят в общие подписки.
 *
 * Viva ограничивает проданный абонемент своими направлениями и типами занятий, поэтому
 * запись на тренировку Топократов по абонементу «РА», «Академия» или «Дружба» провайдер
 * отклоняет: «Абонемент «РА» не действует на этом занятии: другой тип занятия, другое
 * направление». LK1-контур при этом считал скидку по категории и обещал 0 ₽.
 *
 * Решение владельца 2026-09-26 и инцидент 2026-09-25: событие Топократов можно записать
 * разовой оплатой по полной цене либо клубным продуктом «Дружба Топократы»
 * (14692232-12be-4218-9fa1-2d5b79b62035), в правилах которого живёт доплата за 1/4 корта.
 * Любая другая подписка не предлагается в окне записи, а серверный контур отказывает до
 * записи в Viva.
 *
 * То же правило встроено в серверный контур
 * (`scripts/lib/topokratyExclusion.mjs`): шлюз записи отказывает с кодом
 * `TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`, а превью цены не котирует исключённые подписки.
 * Обе стороны пинятся `scripts/tests/topokratyExclusion.test.ts`.
 *
 * Остаточный риск (тот же, что у ПРО-правила): покупка абонемента под это занятие
 * создаётся браузером напрямую в Viva и этим контуром не переносится.
 */
export const TOPOKRATY_DIRECTION_IDS = [6180, 6233] as const;

/** «Дружба Топократы» — единственный продукт, чьё правило может оценивать событие Топократов. */
export const TOPOKRATY_CLUB_PRODUCT_IDS = ["14692232-12be-4218-9fa1-2d5b79b62035"] as const;

/**
 * «Топократ» обязан быть самостоятельным токеном: слово, лишь содержащее этот корень,
 * правилом не захватывается.
 */
const TOPOKRATY_NAME_TOKEN = /(^|[^a-zа-яё0-9])топократ(?:ы|ов|а|ия|ий)?([^a-zа-яё0-9]|$)/i;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);

function readString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = readString(value);
  if (!text) return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/** True when a direction/training label carries the standalone "Топократ" token. */
export function isTopokratyName(value: unknown): boolean {
  const text = readString(value);
  return Boolean(text && TOPOKRATY_NAME_TOKEN.test(text));
}

/**
 * True for a Topokraty exercise, accepting either the normalized GroupTrainingSummary or the
 * raw Viva exercise record. The direction id is authoritative, the name token is the
 * fallback; ids are read through the same aliases the server rule uses.
 */
export function isTopokratyExercise(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const rawDirection = value.direction ?? value.exerciseDirection;
  const direction = isRecord(rawDirection) ? rawDirection : null;
  const directionId = readNumber(direction
    ? (direction.id ?? direction.directionId)
    : rawDirection) ?? readNumber(value.directionId ?? value.exerciseDirectionId);
  if (directionId !== null && (TOPOKRATY_DIRECTION_IDS as readonly number[]).includes(directionId)) {
    return true;
  }
  return [
    direction?.name,
    direction?.title,
    value.directionName,
    value.title,
    value.name,
  ].some(candidate => isTopokratyName(candidate));
}

/**
 * True for an actor-owned row of the club product «Дружба Топократы». The product id is
 * authoritative, the product name is the fallback for a provider that omits ids. The match
 * stays narrow: any other owned subscription, including a product that merely mentions the
 * club in its title, must not unlock the club path.
 */
export function isTopokratyClubPack(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const productIds = [
    value.productId,
    value.subscriptionProductId,
    value.templateId,
    isRecord(value.product) ? value.product.id : null,
    isRecord(value.product) ? value.product.uuid : null,
    isRecord(value.product) ? value.product.productId : null,
    isRecord(value.subscription) ? value.subscription.productId : null,
    isRecord(value.subscription) ? value.subscription.subscriptionProductId : null,
    // The checkout API wraps the Viva row: a TournamentVivaProduct carries it under `raw`.
    isRecord(value.raw) ? value.raw.productId : null,
    isRecord(value.raw) ? value.raw.subscriptionProductId : null,
    isRecord(value.raw) ? value.raw.templateId : null,
    isRecord(value.raw) && isRecord(value.raw.product) ? value.raw.product.id : null,
    isRecord(value.raw) && isRecord(value.raw.product) ? value.raw.product.uuid : null,
    isRecord(value.raw) && isRecord(value.raw.product) ? value.raw.product.productId : null,
    isRecord(value.raw) && isRecord(value.raw.subscription) ? value.raw.subscription.productId : null,
    isRecord(value.raw) && isRecord(value.raw.subscription) ? value.raw.subscription.subscriptionProductId : null,
    isRecord(value.clientSubscription) ? value.clientSubscription.productId : null,
    isRecord(value.clientSubscription) ? value.clientSubscription.subscriptionProductId : null,
    isRecord(value.clientSub) ? value.clientSub.productId : null,
    isRecord(value.clientSub) ? value.clientSub.subscriptionProductId : null,
  ]
    .map(candidate => readString(candidate)?.toLocaleLowerCase("en-US"))
    .filter((candidate): candidate is string => Boolean(candidate));
  if (productIds.length > 0) {
    return productIds.every(id => (TOPOKRATY_CLUB_PRODUCT_IDS as readonly string[]).includes(id));
  }
  const candidates = [
    value.subscriptionName,
    value.productName,
    value.name,
    value.title,
    isRecord(value.subscription) ? value.subscription.name : null,
    isRecord(value.product) ? value.product.name : null,
    isRecord(value.clientSubscription) ? value.clientSubscription.name : null,
    isRecord(value.clientSub) ? value.clientSub.name : null,
  ];
  return candidates.some(candidate => isTopokratyName(candidate));
}

/**
 * True when the Topokraty event must be booked outside the subscription contour for this
 * client: the event belongs to the club directions and none of the owned rows is the club
 * product.
 */
export function isTopokratySubscriptionExcluded(
  exercise: unknown,
  owned: readonly unknown[] | null | undefined,
): boolean {
  if (!isTopokratyExercise(exercise)) return false;
  const rows = Array.isArray(owned) ? owned : [];
  return !rows.some(row => isTopokratyClubPack(row));
}
