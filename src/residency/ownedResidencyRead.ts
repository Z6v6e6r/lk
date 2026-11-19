/**
 * Owned-residency read for the composite offer (lk#459): ACTIVE / NONE / UNKNOWN.
 *
 * Pure classifier, no I/O. Its input is one fresh GET of the client's own Viva subscriptions
 * (all statuses, one complete page). It never changes an order, a booking or a subscription.
 *
 * - ACTIVE: one row is the exact residency product, owned by this client, ACTIVE and in term.
 *   Selling a second residency is refused (RES-006).
 * - NONE: the read succeeded, the page is complete, every row carries a product identity and
 *   no row is a live, pending or frozen residency. Only this state lets the planner sell.
 * - UNKNOWN: anything else — a failed or partial read, a row without product identity, a
 *   conflicting identity, a foreign owner, a frozen or not-yet-active residency, an unknown
 *   status or a read older than the freshness bound. UNKNOWN refuses the sale (fail closed).
 *
 * The product name never proves or disproves residency; only the exact product id does.
 */
import { RESIDENCY_PRODUCT_ID } from "./residencyPurchase.ts";

/** A NONE answer is only as good as the read behind it; older reads become UNKNOWN. */
export const OWNED_RESIDENCY_READ_MAX_AGE_MS = 60_000;

export type OwnedResidencyState = "ACTIVE" | "NONE" | "UNKNOWN";

export type OwnedResidencyUnknownReason =
  | "READ_FAILED"
  | "READ_INCOMPLETE"
  | "READ_STALE"
  | "ROW_IDENTITY_MISSING"
  | "ROW_IDENTITY_CONFLICT"
  | "OWNER_MISMATCH"
  | "RESIDENCY_FROZEN"
  | "RESIDENCY_PENDING"
  | "RESIDENCY_STATUS_UNKNOWN";

export interface OwnedResidencyRead {
  state: OwnedResidencyState;
  reason: OwnedResidencyUnknownReason | null;
  /** The owned instance when ACTIVE. */
  clientSubscriptionId: string | null;
  observedAtMs: number;
}

/** Terminal provider statuses: the row is history, not a live residency. */
const FINISHED_STATUS_MARKERS = ["CANCEL", "CLOSE", "FINISH", "EXPIRE", "ARCHIVE", "VOID", "DELETE", "REFUND"];
/** Bought but not yet usable: a second purchase would duplicate it. */
const PENDING_STATUS_MARKERS = ["NOT_ACTIVATED", "INACTIVE", "PENDING", "NEW", "WAIT", "CREATED"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

function instant(value: unknown, endOfDay: boolean): number | null {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`);
  }
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}+03:00`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

function productIds(row: Record<string, unknown>): string[] {
  const product = isRecord(row.product) ? row.product : null;
  return [row.productId, row.subscriptionProductId, row.templateId, product?.id, product?.uuid, product?.productId]
    .filter((id) => id !== undefined && id !== null)
    .map((id) => (text(id) ?? "").toLowerCase());
}

const unknown = (reason: OwnedResidencyUnknownReason, observedAtMs: number): OwnedResidencyRead =>
  ({ state: "UNKNOWN", reason, clientSubscriptionId: null, observedAtMs });

export function classifyOwnedResidency(params: {
  /** Raw body of GET /subscriptions?includeFinished=true; null when the read failed. */
  payload: unknown;
  readFailed: boolean;
  /** Verified PadlHub/Viva client id of the signed-in actor. */
  actorId: string | null;
  observedAtMs: number;
  nowMs: number;
}): OwnedResidencyRead {
  const { observedAtMs, nowMs } = params;
  if (params.readFailed || !params.actorId) return unknown("READ_FAILED", observedAtMs);

  const root = isRecord(params.payload) ? params.payload : null;
  const rows = Array.isArray(params.payload) ? params.payload : root?.content;
  if (!Array.isArray(rows)) return unknown("READ_FAILED", observedAtMs);
  if (root && (root.last === false
    || (typeof root.totalElements === "number" && root.totalElements !== rows.length))) {
    return unknown("READ_INCOMPLETE", observedAtMs);
  }

  let active: string | null = null;
  for (const raw of rows) {
    if (!isRecord(raw)) return unknown("ROW_IDENTITY_MISSING", observedAtMs);
    const ids = productIds(raw);
    if (!ids.length || ids.some((id) => !id)) return unknown("ROW_IDENTITY_MISSING", observedAtMs);
    const residencyIds = ids.filter((id) => id === RESIDENCY_PRODUCT_ID);
    if (!residencyIds.length) continue;
    if (residencyIds.length !== ids.length) return unknown("ROW_IDENTITY_CONFLICT", observedAtMs);

    const client = isRecord(raw.client) ? raw.client : null;
    const owners = [raw.clientId, client?.id].filter((id) => id !== undefined && id !== null).map(text);
    if (owners.some((owner) => owner !== params.actorId)) return unknown("OWNER_MISMATCH", observedAtMs);

    const status = (text(raw.status) ?? "").toUpperCase();
    const expiry = instant(raw.expirationDate, true);
    if (FINISHED_STATUS_MARKERS.some((marker) => status.includes(marker))) continue;
    if (expiry !== null && expiry <= nowMs) continue;

    const holdUntil = instant(raw.holdUntil, true) ?? instant(raw.frozenUntil, true);
    if (raw.isFrozen === true || status.includes("FROZEN") || status.includes("HOLD")
      || (holdUntil !== null && holdUntil > nowMs)) {
      return unknown("RESIDENCY_FROZEN", observedAtMs);
    }
    const activation = instant(raw.activationDate, false);
    if (PENDING_STATUS_MARKERS.some((marker) => status === marker || status.startsWith(`${marker}_`))
      || (activation !== null && activation > nowMs)) {
      return unknown("RESIDENCY_PENDING", observedAtMs);
    }
    if (status !== "ACTIVE" || activation === null || expiry === null) {
      return unknown("RESIDENCY_STATUS_UNKNOWN", observedAtMs);
    }
    active = text(raw.clientSubscriptionId) ?? text(raw.subscriptionId) ?? text(raw.id) ?? "";
  }

  // An owned live residency refuses the sale however old the read is.
  if (active !== null) return { state: "ACTIVE", reason: null, clientSubscriptionId: active || null, observedAtMs };
  const age = nowMs - observedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > OWNED_RESIDENCY_READ_MAX_AGE_MS) {
    return unknown("READ_STALE", observedAtMs);
  }
  return { state: "NONE", reason: null, clientSubscriptionId: null, observedAtMs };
}
