/**
 * Browser client for the server-owned residency lifecycle (docs/residency-lifecycle.md).
 *
 * The personal pilot is enforced on the server from the verified Keycloak identity. This
 * module only transports the request; it never decides that an account is allowed and it
 * never computes a price. `expectedTotalMinor` is the exact amount shown to the user.
 */

export const RESIDENCY_LIFECYCLE_PRODUCT_ID = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
export const RESIDENCY_LIFECYCLE_RETURN_TARGET = "lk1pilot";

export type LifecycleOrderState =
  | "PENDING_PAYMENT" | "PAYMENT_FAILED" | "EXPIRED" | "CANCELLED" | "PAID"
  | "PAID_ACTIVATION_PENDING" | "ACTIVE" | "ACTIVATION_FAILED" | "PAID_REQUIRES_REVIEW";
export type LifecyclePaymentStatus = "NONE" | "PENDING" | "PAID" | "FAILED" | "UNKNOWN";
export type LifecycleRecoveryState =
  | "NONE" | "TERMINAL" | "REVIEW_REQUIRED" | "ACTIVATION_PENDING"
  | "UNKNOWN_OUTCOME" | "AWAITING_CONFIRMATION" | "AWAITING_PAYMENT";

export interface LifecycleCatalog {
  schemaVersion: number;
  product: {
    productId: string;
    title: string;
    termDays: number;
    priceMinor: number;
    currency: "RUB";
  };
  renewalEligible: boolean;
  renewal: {
    eligible: boolean;
    reason: string | null;
    eligibleAt: string | null;
    currentValidUntil: string | null;
  };
  checkedAt: string;
}

export interface LifecycleStatus {
  schemaVersion: number;
  state: "ACTIVE" | "EXPIRED" | "NONE" | "UNAVAILABLE";
  validFrom: string | null;
  validUntil: string | null;
  source: string | null;
  observedAt: string;
  reason: string | null;
}

export interface LifecycleRecovery {
  state: LifecycleRecoveryState;
  required: boolean;
  reason: string | null;
  action: string;
  retryable: boolean;
  since: string | null;
}

export interface LifecycleOrder {
  schemaVersion: number;
  orderId: string;
  mode: "NEW" | "RENEWAL";
  state: LifecycleOrderState;
  terminal: boolean;
  terminalReason: string | null;
  product: { productId: string; title: string; termDays: number; currency: "RUB" };
  pricing: { baseAmountMinor: number; totalMinor: number; currency: "RUB" };
  consent: { expectedTotalMinor: number; productId: string; acceptedAt: string };
  payment: {
    status: LifecyclePaymentStatus;
    paymentUrl: string | null;
    expiresAt: string | null;
    overdue: boolean;
    instruction: string | null;
  };
  recovery: LifecycleRecovery;
  residency: { validFrom: string | null; validUntil: string | null } | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface LifecyclePayment {
  schemaVersion: number;
  orderId: string;
  state: LifecycleOrderState;
  paymentStatus: LifecyclePaymentStatus;
  paymentUrl: string | null;
  expiresAt: string | null;
  overdue: boolean;
  instruction: string | null;
  recovery: LifecycleRecovery;
  terminal: boolean;
  terminalReason: string | null;
}

export interface LifecycleFailure {
  code: string;
  status: number | null;
  networkError: boolean;
  retryable: boolean;
}

export type LifecycleResult<T> = { ok: true; value: T } | { ok: false; failure: LifecycleFailure };

export interface LifecycleTransportRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  returnTarget?: string;
  signal?: AbortSignal;
}

export interface LifecycleTransportResult {
  status: number | null;
  data: unknown;
  networkError: boolean;
}

export type LifecycleTransport = (request: LifecycleTransportRequest) => Promise<LifecycleTransportResult>;

const ORDER_STATES = new Set<LifecycleOrderState>([
  "PENDING_PAYMENT", "PAYMENT_FAILED", "EXPIRED", "CANCELLED", "PAID",
  "PAID_ACTIVATION_PENDING", "ACTIVE", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW",
]);
const PAYMENT_STATUSES = new Set<LifecyclePaymentStatus>(["NONE", "PENDING", "PAID", "FAILED", "UNKNOWN"]);
const RECOVERY_STATES = new Set<LifecycleRecoveryState>([
  "NONE", "TERMINAL", "REVIEW_REQUIRED", "ACTIVATION_PENDING",
  "UNKNOWN_OUTCOME", "AWAITING_CONFIRMATION", "AWAITING_PAYMENT",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function money(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readErrorCode(data: unknown): string | null {
  const body = record(data);
  if (!body) return null;
  const code = text(body.code, 128);
  return code ? code.trim() : null;
}

function fallbackCode(status: number | null): string {
  if (status === 401) return "RESIDENCY_CLIENT_AUTH_REQUIRED";
  if (status === 403) return "RESIDENCY_CLIENT_FORBIDDEN";
  if (status === 404) return "RESIDENCY_CLIENT_NOT_FOUND";
  if (status === 409) return "RESIDENCY_CLIENT_CONFLICT";
  if (status === 429) return "RESIDENCY_CLIENT_RATE_LIMITED";
  if (status === 504) return "RESIDENCY_CLIENT_UPSTREAM_TIMEOUT";
  if (typeof status === "number" && status >= 500) return "RESIDENCY_CLIENT_UPSTREAM_UNAVAILABLE";
  return "RESIDENCY_CLIENT_REQUEST_INVALID";
}

function failure(result: LifecycleTransportResult): LifecycleFailure {
  return {
    code: readErrorCode(result.data) || fallbackCode(result.status),
    status: result.status,
    networkError: result.networkError,
    retryable: result.networkError || result.status === null || result.status === 429
      || result.status === 502 || result.status === 503 || result.status === 504,
  };
}

function invalid<T>(result: LifecycleTransportResult): LifecycleResult<T> {
  return { ok: false, failure: {
    code: result.networkError ? "RESIDENCY_CLIENT_UPSTREAM_UNAVAILABLE" : "RESIDENCY_CLIENT_UPSTREAM_INVALID",
    status: result.status,
    networkError: result.networkError,
    retryable: result.networkError || result.status === null,
  } };
}

function okStatus(status: number | null): boolean {
  return typeof status === "number" && status >= 200 && status < 300;
}

function parseRecovery(value: unknown): LifecycleRecovery | null {
  const body = record(value);
  if (!body || !RECOVERY_STATES.has(body.state as LifecycleRecoveryState)) return null;
  return {
    state: body.state as LifecycleRecoveryState,
    required: body.required === true,
    reason: text(body.reason, 128),
    action: text(body.action, 64) || "NONE",
    retryable: body.retryable === true,
    since: iso(body.since),
  };
}

export function parseLifecycleCatalog(payload: unknown): LifecycleCatalog | null {
  const body = record(payload);
  const product = record(body?.product);
  const renewal = record(body?.renewal);
  if (!body || body.schemaVersion !== 1 || !product || !renewal) return null;
  if (product.productId !== RESIDENCY_LIFECYCLE_PRODUCT_ID || product.currency !== "RUB"
    || !text(product.title, 160) || !Number.isSafeInteger(product.termDays) || (product.termDays as number) <= 0
    || !money(product.priceMinor) || (product.priceMinor as number) <= 0 || !iso(body.checkedAt)) return null;
  if (typeof renewal.eligible !== "boolean") return null;
  return {
    schemaVersion: 1,
    product: {
      productId: product.productId,
      title: product.title as string,
      termDays: product.termDays as number,
      priceMinor: product.priceMinor as number,
      currency: "RUB",
    },
    renewalEligible: renewal.eligible,
    renewal: {
      eligible: renewal.eligible,
      reason: text(renewal.reason, 128),
      eligibleAt: iso(renewal.eligibleAt),
      currentValidUntil: iso(renewal.currentValidUntil),
    },
    checkedAt: body.checkedAt as string,
  };
}

export function parseLifecycleStatus(payload: unknown): LifecycleStatus | null {
  const body = record(payload);
  if (!body || body.schemaVersion !== 1 || !["ACTIVE", "EXPIRED", "NONE", "UNAVAILABLE"].includes(body.state as string)) return null;
  return {
    schemaVersion: 1,
    state: body.state as LifecycleStatus["state"],
    validFrom: iso(body.validFrom),
    validUntil: iso(body.validUntil),
    source: text(body.source, 128),
    observedAt: iso(body.observedAt) || new Date(0).toISOString(),
    reason: text(body.reason, 128),
  };
}

export function parseLifecycleOrder(payload: unknown): LifecycleOrder | null {
  const body = record(payload);
  const product = record(body?.product);
  const pricing = record(body?.pricing);
  const consent = record(body?.consent);
  const payment = record(body?.payment);
  if (!body || body.schemaVersion !== 1 || !text(body.orderId, 64) || !UUID.test(body.orderId as string)) return null;
  if (body.mode !== "NEW" && body.mode !== "RENEWAL") return null;
  if (!ORDER_STATES.has(body.state as LifecycleOrderState)) return null;
  if (!product || product.productId !== RESIDENCY_LIFECYCLE_PRODUCT_ID || product.currency !== "RUB") return null;
  if (!pricing || !money(pricing.baseAmountMinor) || !money(pricing.totalMinor) || pricing.currency !== "RUB") return null;
  if (!consent || !money(consent.expectedTotalMinor) || consent.productId !== RESIDENCY_LIFECYCLE_PRODUCT_ID) return null;
  if (!payment || !PAYMENT_STATUSES.has(payment.status as LifecyclePaymentStatus)) return null;
  const recovery = parseRecovery(body.recovery);
  if (!recovery) return null;
  return {
    schemaVersion: 1,
    orderId: body.orderId as string,
    mode: body.mode as LifecycleOrder["mode"],
    state: body.state as LifecycleOrderState,
    terminal: body.terminal === true,
    terminalReason: text(body.terminalReason, 128),
    product: { productId: RESIDENCY_LIFECYCLE_PRODUCT_ID, title: text(product.title, 160) || "Резидентство ПадлхАБ",
      termDays: Number.isSafeInteger(product.termDays) ? product.termDays as number : 30, currency: "RUB" },
    pricing: {
      baseAmountMinor: pricing.baseAmountMinor as number,
      totalMinor: pricing.totalMinor as number,
      currency: "RUB",
    },
    consent: {
      expectedTotalMinor: consent.expectedTotalMinor as number,
      productId: RESIDENCY_LIFECYCLE_PRODUCT_ID,
      acceptedAt: iso(consent.acceptedAt) || "",
    },
    payment: {
      status: payment.status as LifecyclePaymentStatus,
      paymentUrl: text(payment.paymentUrl, 4096),
      expiresAt: iso(payment.expiresAt),
      overdue: payment.overdue === true,
      instruction: text(payment.instruction, 512),
    },
    recovery,
    residency: record(body.residency)
      ? { validFrom: iso((body.residency as Record<string, unknown>).validFrom),
          validUntil: iso((body.residency as Record<string, unknown>).validUntil) }
      : null,
    createdAt: iso(body.createdAt) || "",
    updatedAt: iso(body.updatedAt) || "",
    revision: Number.isSafeInteger(body.revision) ? body.revision as number : 1,
  };
}

export function parseLifecyclePayment(payload: unknown): LifecyclePayment | null {
  const body = record(payload);
  const recovery = parseRecovery(body?.recovery);
  if (!body || body.schemaVersion !== 1 || !text(body.orderId, 64) || !UUID.test(body.orderId as string)
    || !ORDER_STATES.has(body.state as LifecycleOrderState)
    || !PAYMENT_STATUSES.has(body.paymentStatus as LifecyclePaymentStatus) || !recovery) return null;
  return {
    schemaVersion: 1,
    orderId: body.orderId as string,
    state: body.state as LifecycleOrderState,
    paymentStatus: body.paymentStatus as LifecyclePaymentStatus,
    paymentUrl: text(body.paymentUrl, 4096),
    expiresAt: iso(body.expiresAt),
    overdue: body.overdue === true,
    instruction: text(body.instruction, 512),
    recovery,
    terminal: body.terminal === true,
    terminalReason: text(body.terminalReason, 128),
  };
}

function orderEnvelope(payload: unknown): { order: LifecycleOrder; idempotentReplay: boolean } | null {
  const body = record(payload);
  const order = parseLifecycleOrder(body?.order);
  if (!body || body.schemaVersion !== 1 || !order) return null;
  return { order, idempotentReplay: body.idempotentReplay === true };
}

export function createResidencyLifecycleClient(transport: LifecycleTransport) {
  async function call(path: string, options: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string; returnTarget?: string; signal?: AbortSignal }) {
    return transport({ ...options, path });
  }

  return {
    async readCatalog(signal?: AbortSignal): Promise<LifecycleResult<LifecycleCatalog>> {
      const result = await call("/lk/residency/catalog", { method: "GET", signal });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = parseLifecycleCatalog(result.data);
      return parsed ? { ok: true, value: parsed } : invalid(result);
    },

    async readStatus(signal?: AbortSignal): Promise<LifecycleResult<LifecycleStatus>> {
      const result = await call("/lk/residency/status", { method: "GET", signal });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = parseLifecycleStatus(result.data);
      return parsed ? { ok: true, value: parsed } : invalid(result);
    },

    async listUnresolved(signal?: AbortSignal): Promise<LifecycleResult<LifecycleOrder[]>> {
      const result = await call("/lk/residency/orders?state=unresolved", { method: "GET", signal });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const body = record(result.data);
      if (!body || body.schemaVersion !== 1 || !Array.isArray(body.orders)
        || !Number.isSafeInteger(body.count) || body.count !== body.orders.length) return invalid(result);
      const orders: LifecycleOrder[] = [];
      for (const row of body.orders) {
        const parsed = parseLifecycleOrder(row);
        if (!parsed) return invalid(result);
        orders.push(parsed);
      }
      return { ok: true, value: orders };
    },

    async getOrder(orderId: string, signal?: AbortSignal): Promise<LifecycleResult<LifecycleOrder>> {
      const result = await call("/lk/residency/orders/" + encodeURIComponent(orderId), { method: "GET", signal });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = parseLifecycleOrder(result.data);
      return parsed ? { ok: true, value: parsed } : invalid(result);
    },

    async getPayment(orderId: string, signal?: AbortSignal): Promise<LifecycleResult<LifecyclePayment>> {
      const result = await call("/lk/residency/orders/" + encodeURIComponent(orderId) + "/payment", { method: "GET", signal });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = parseLifecyclePayment(result.data);
      return parsed ? { ok: true, value: parsed } : invalid(result);
    },

    async createOrder(input: {
      mode: "NEW" | "RENEWAL";
      expectedTotalMinor: number;
      expectedProductId: string;
      idempotencyKey: string;
      returnTarget?: string;
      signal?: AbortSignal;
    }): Promise<LifecycleResult<{ order: LifecycleOrder; idempotentReplay: boolean }>> {
      const result = await call("/lk/residency/orders", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        returnTarget: input.returnTarget,
        signal: input.signal,
        body: {
          mode: input.mode,
          expectedTotalMinor: input.expectedTotalMinor,
          expectedProductId: input.expectedProductId,
        },
      });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = orderEnvelope(result.data);
      return parsed ? { ok: true, value: parsed } : invalid(result);
    },

    async reconcile(orderId: string, input: { idempotencyKey: string; eventId: string; signal?: AbortSignal }): Promise<LifecycleResult<{ order: LifecycleOrder; retryable: boolean; reviewRequired: boolean }>> {
      const result = await call("/lk/residency/orders/" + encodeURIComponent(orderId) + "/reconcile", {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
        body: { eventId: input.eventId },
      });
      if (!okStatus(result.status)) return { ok: false, failure: failure(result) };
      const parsed = orderEnvelope(result.data);
      if (!parsed) return invalid(result);
      const body = record(result.data);
      return { ok: true, value: {
        order: parsed.order,
        retryable: body?.retryable === true,
        reviewRequired: body?.reviewRequired === true,
      } };
    },
  };
}

