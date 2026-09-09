import type { Subscription, SubscriptionName, SubscriptionResponse } from "./apiClient";

const scalarFields = [
  "subscriptionId", "name", "cost", "type", "status", "purchaseDate", "autoActivationDate",
  "activationDate", "expirationDate", "holdUntil", "validityDays", "totalFreezeDays", "freezingDays",
  "freezeUsed", "hasStudioLimitation", "hasTypeLimitation", "hasDirectionLimitation", "hasDayLimitation",
  "hasTimeRangeLimitation", "variant", "visitsTotal", "visitsLeft", "timeLimitation", "minutes",
  "availableMinutes", "duration", "availableDays",
  // These provider aliases are read by the existing eligibility classifiers.
  "id", "uuid", "clientSubscriptionId", "clientId", "productId", "subscriptionProductId", "templateId",
  "counterKey", "planKey", "title", "label", "productName", "subscriptionName", "subscriptionProductName",
  "purchaseAt", "frozenUntil", "isFrozen",
];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function pickScalars(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => value[key] === null
    || ["string", "number", "boolean"].includes(typeof value[key])).map((key) => [key, value[key]]));
}

function sanitizeSubscriptionRecord(item: Record<string, unknown>, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;
  // Never drop a malformed/conflicting identity or restriction and thereby widen eligibility.
  if (scalarFields.some((key) => item[key] !== undefined && item[key] !== null
    && !["string", "number", "boolean"].includes(typeof item[key]))) return null;
  const subscription = pickScalars(item, scalarFields);
  for (const key of ["raw", "subscription", "clientSubscription", "clientSub", "product"]) {
    if (item[key] === undefined) continue;
    if (item[key] === null) { subscription[key] = null; continue; }
    if (!record(item[key])) return null;
    const nested = sanitizeSubscriptionRecord(item[key], depth + 1);
    if (!nested) return null;
    subscription[key] = nested;
  }
  if (item.client !== undefined) {
    if (item.client === null) subscription.client = null;
    else if (record(item.client) && (item.client.id === undefined || item.client.id === null
      || ["string", "number", "boolean"].includes(typeof item.client.id))) {
      subscription.client = pickScalars(item.client, ["id"]);
    } else return null;
  }
  for (const key of ["availableStudios", "availableTypes", "availableDirections"]) {
    if (item[key] === undefined) continue;
    if (!Array.isArray(item[key]) || !item[key].every((entry) => record(entry)
      && ["id", "name"].every((field) => entry[field] === undefined || entry[field] === null
        || ["string", "number", "boolean"].includes(typeof entry[field])))) return null;
    subscription[key] = item[key].map((entry) => pickScalars(entry, ["id", "name"]));
  }
  return subscription;
}

/** Persist the display and eligibility contract, excluding unrelated personal/provider details. */
export function sanitizeSubscriptionSnapshot(value: unknown): SubscriptionResponse | null {
  if (!record(value) || !Array.isArray(value.content)) return null;
  if (!value.content.every((item) => record(item) && typeof item.subscriptionId === "string")) return null;
  const content = value.content.map((item: Record<string, unknown>) => sanitizeSubscriptionRecord(item));
  if (content.some((item) => item === null)) return null;
  const pageable = record(value.pageable) ? value.pageable : {};
  return {
    ...pickScalars(value, ["last", "totalElements", "totalPages", "first", "size", "number", "numberOfElements", "empty"]),
    content: content as unknown as Subscription[],
    pageable: {
      ...pickScalars(pageable, ["pageNumber", "pageSize", "offset", "paged"]),
      sort: record(pageable.sort) ? pickScalars(pageable.sort, ["empty", "sorted", "unsorted"]) : {},
    },
  } as SubscriptionResponse;
}

export function sanitizeSubscriptionName(value: unknown): SubscriptionName | null {
  return record(value) && typeof value.sertName === "string" && value.sertName.trim()
    ? { sertName: value.sertName } : null;
}
