// Must match the server catalogue identifiers in trialGroupEligibility.mjs.
export const TRIAL_GROUP_TYPE_ID = 1755;
export const TRIAL_GROUP_DIRECTION_ID = 4971;

export function isTrialGroupTraining(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const id = (item: unknown) => item && typeof item === "object"
    ? (item as Record<string, unknown>).id : item;
  return [id(row.type), id(row.exerciseType), row.typeId, row.exerciseTypeId]
    .some(item => String(item ?? "") === String(TRIAL_GROUP_TYPE_ID))
    || [id(row.direction), id(row.exerciseDirection), row.directionId, row.exerciseDirectionId]
      .some(item => String(item ?? "") === String(TRIAL_GROUP_DIRECTION_ID));
}

const attempts = new Map<string, string>();
const attemptPrefix = (exerciseId: string) => `lk-trial-checkout:${exerciseId}:`;
export function trialGroupCheckoutOperationId(exerciseId: string, actorId: string, productId: string, promoCode: string | null, source: string = "one-time"): string {
  const key = attemptPrefix(exerciseId) + JSON.stringify([actorId, productId, promoCode, source]);
  let operationId = attempts.get(key);
  try { operationId ||= globalThis.sessionStorage?.getItem(key) || undefined; } catch { /* In-memory fallback. */ }
  if (!operationId) operationId = `trial-${globalThis.crypto.randomUUID()}`;
  attempts.set(key, operationId);
  try { globalThis.sessionStorage?.setItem(key, operationId); } catch { /* Preserve the same in-memory attempt. */ }
  return operationId;
}
// Only a confirmed cancellation starts a new attempt for this target.
export function clearTrialGroupCheckoutOperations(exerciseId: string): void {
  const prefix = attemptPrefix(exerciseId);
  for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key);
  try {
    const keys = Object.keys(globalThis.sessionStorage ?? {});
    for (const key of keys) if (key.startsWith(prefix)) globalThis.sessionStorage.removeItem(key);
  } catch { /* Storage may be disabled. */ }
}
