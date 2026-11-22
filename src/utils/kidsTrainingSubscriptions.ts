import { GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS } from "./groupScheduleModel.ts";

export const PADEL_KIDS_PRODUCT_ID = "4d43f97e-c71e-450b-8b99-02db47b4a64f";

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

export function isPadelKidsProduct(product: SubscriptionProduct): boolean {
  if (product.source !== "subscription" && product.source !== "client-subscription") return false;
  const ids = subscriptionProductIds(product);
  return ids.length > 0 && ids.every(id =>
    typeof id === "string" && id.trim().toLowerCase() === PADEL_KIDS_PRODUCT_ID);
}

export function needsPadelKidsIdentity(product: SubscriptionProduct): boolean {
  return product.source === "client-subscription" && subscriptionProductIds(product).length === 0;
}

// The caller resolves this catalogue ID for the exact eligible instance via the authenticated gateway.
export function withPadelKidsIdentity<T extends SubscriptionProduct>(product: T, productId: unknown): T {
  if (!needsPadelKidsIdentity(product)
    || typeof productId !== "string" || productId.toLowerCase() !== PADEL_KIDS_PRODUCT_ID) return product;
  return { ...product, raw: { ...asRecord(product.raw), productId: PADEL_KIDS_PRODUCT_ID } };
}
