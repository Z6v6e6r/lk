// PRO-level trainings stay outside every subscription benefit, on both sides of the
// contour: the advisory price preview quotes nothing for them and the atomic booking
// gateway refuses a subscription booking of any product (managed plan or legacy
// visit pack). A PRO training is paid at its full one-time price; promo codes are not
// part of this rule.
//
// Owner decision 2026-09-18: "Тренировка ПРО уровень …" (5505/5506/5507, exercise type
// 605) and "Игра+Тренер ПРО уровень …" (5502/5503/5504, exercise type 847) must not be
// bookable with a subscription and must not receive the plan discount or the
// free-first-event benefit.
//
// This module is embedded verbatim into the booking gateway by the release composition
// (`hubGatewaySource()` in scripts/lib/eventPaymentSources.mjs) and reached by the
// preview through the canonical helper closure, so the rule has exactly one reviewed
// source. The widget carries the same ids and the same token in
// `src/utils/proTrainingExclusion.ts`; `scripts/tests/proTrainingExclusion.test.ts`
// pins both sides.
export const PRO_TRAINING_DIRECTION_IDS = Object.freeze([5502, 5503, 5504, 5505, 5506, 5507]);

// "ПРО" must be a standalone token: "Профсоюзная", "пробная" and "просто" are ordinary
// directions in the same catalogue and must never match.
const PRO_TRAINING_NAME_TOKEN = /(^|[^a-zа-яё0-9])про([^a-zа-яё0-9]|$)/i;

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
 */
export function isProTrainingExercise(value) {
  if (!proTrainingIsRecord(value)) return false;
  const direction = proTrainingIsRecord(value.direction) ? value.direction : null;
  const directionId = proTrainingNum(direction?.id ?? direction?.directionId ?? value.directionId);
  if (directionId !== null && PRO_TRAINING_DIRECTION_IDS.includes(directionId)) return true;
  return [
    direction?.name,
    direction?.title,
    value.directionName,
    value.title,
    value.name,
  ].some((candidate) => isProTrainingName(candidate));
}
