/** PRO trainings allow a server-confirmed 50% RA/Academy monetary discount.
 * Free-first-event benefits and other plans stay excluded; owned Energy packs
 * retain their visit path. The server mirrors direction detection below.
 */
export const PRO_TRAINING_DIRECTION_IDS = [5502, 5503, 5504, 5505, 5506, 5507] as const;

/**
 * "ПРО" must be a standalone token: "Профсоюзная", "пробная" and "просто" are
 * ordinary trainings in the same catalogue and must never match.
 */
const PRO_TRAINING_NAME_TOKEN = /(^|[^a-zа-яё0-9])про([^a-zа-яё0-9]|$)/i;

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

/** True when a direction/type/training label carries the standalone "ПРО" token. */
export function isProTrainingName(value: unknown): boolean {
  const text = readString(value);
  return Boolean(text && PRO_TRAINING_NAME_TOKEN.test(text));
}

/**
 * True for a PRO training, accepting either a normalized
 * `GroupTrainingSummary` or the raw Viva exercise record.
 */
/**
 * True for a PRO training, accepting either a normalized
 * `GroupTrainingSummary` or the raw Viva exercise record. The id is read through the
 * same aliases the server's `resolveCategory` accepts, including a scalar `direction`,
 * so the category and the PRO verdict never disagree about which direction this is.
 */
export function isProTraining(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const rawDirection = value.direction ?? value.exerciseDirection;
  const direction = isRecord(rawDirection) ? rawDirection : null;
  const directionId = readNumber(direction
    ? (direction.id ?? direction.directionId)
    : rawDirection) ?? readNumber(value.directionId ?? value.exerciseDirectionId);
  if (directionId !== null && (PRO_TRAINING_DIRECTION_IDS as readonly number[]).includes(directionId)) {
    return true;
  }
  return [
    direction?.name,
    direction?.title,
    value.directionName,
    value.title,
    value.name,
  ].some(candidate => isProTrainingName(candidate));
}
