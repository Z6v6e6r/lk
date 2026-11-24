import { GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS, GROUP_SCHEDULE_PITER_STUDIO_ID } from "./groupScheduleModel.ts";

export const PADEL_KIDS_PRODUCT_ID = "4d43f97e-c71e-450b-8b99-02db47b4a64f";
export const PITER_KIDS_PRODUCT_ID = "707b5c25-86e3-4ce7-a509-03fee3d193f1";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export function isKidsAcademyTraining(value: unknown): boolean {
  const exercise = asRecord(value);
  if (!exercise) return false;
  const raw = exercise.direction ?? exercise.exerciseDirection;
  const direction = asRecord(raw);
  const id = (direction ? direction.id ?? direction.directionId : raw)
    ?? exercise.directionId ?? exercise.exerciseDirectionId;
  return GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS.some(directionId =>
    id === directionId || id === String(directionId));
}

export function isPiterKidsAcademyTraining(value: unknown): boolean {
  const exercise = asRecord(value);
  if (!exercise || !isKidsAcademyTraining(exercise)) return false;
  const studioIds = [asRecord(exercise.studio)?.id, exercise.studioId].filter(id => id != null);
  return studioIds.length > 0 && studioIds.every(id => normalizeProductId(id) === GROUP_SCHEDULE_PITER_STUDIO_ID);
}

type SubscriptionProduct = { source: string; id: string; raw?: unknown };

function subscriptionProductIds(product: SubscriptionProduct): unknown[] {
  const raw = asRecord(product.raw);
  const nested = asRecord(raw?.subscription);
  const productShapes = [raw?.product, raw?.template, nested?.product, nested?.template].map(asRecord);
  return [
    product.source === "subscription" ? product.id : null,
    raw?.productId, raw?.subscriptionProductId, raw?.templateId,
    nested?.productId, nested?.subscriptionProductId,
    ...productShapes.flatMap(shape => [shape?.id, shape?.uuid, shape?.productId]),
  ].filter(id => id != null && id !== "");
}

function normalizeProductId(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

function isAllowedKidsProductId(id: string | null, allowPiterKids: boolean): boolean {
  return id === PADEL_KIDS_PRODUCT_ID || (allowPiterKids && id === PITER_KIDS_PRODUCT_ID);
}

export function isKidsTrainingProduct(product: SubscriptionProduct, allowPiterKids = false): boolean {
  if (product.source !== "subscription" && product.source !== "client-subscription") return false;
  const ids = subscriptionProductIds(product).map(normalizeProductId);
  const [id] = ids;
  return id != null && isAllowedKidsProductId(id, allowPiterKids) && ids.every(alias => alias === id);
}

export function needsKidsTrainingIdentity(product: SubscriptionProduct): boolean {
  return product.source === "client-subscription" && subscriptionProductIds(product).length === 0;
}

// The caller resolves this catalogue ID for the exact eligible instance via the authenticated gateway.
export function withKidsTrainingIdentity<T extends SubscriptionProduct>(
  product: T, productId: unknown, allowPiterKids = false,
): T {
  const id = normalizeProductId(productId);
  if (!needsKidsTrainingIdentity(product) || !isAllowedKidsProductId(id, allowPiterKids)) return product;
  return { ...product, raw: { ...asRecord(product.raw), productId: id } };
}
