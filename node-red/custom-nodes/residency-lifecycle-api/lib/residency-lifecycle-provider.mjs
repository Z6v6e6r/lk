// Viva + CUP adapters for the LK1 residency lifecycle.
//
// Reads that must be authoritative use the server Viva Admin credential; the purchase
// itself uses the authenticated actor's short-lived Viva token. CUP remains the
// residency evidence owner: an order becomes ACTIVE only from the CUP verified context.
// No tariff, discount or entitlement is computed here.

import { RESIDENCY_PRODUCT_ID } from "./residency-lifecycle.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 20 * 60 * 1000;

function assertConfig(config) {
  const url = (value, name) => {
    if (typeof value !== "string") throw new Error("RESIDENCY_CONFIG_INVALID:" + name);
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("RESIDENCY_CONFIG_INVALID:" + name); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("RESIDENCY_CONFIG_INVALID:" + name);
    }
    return parsed.toString().replace(/\/$/, "");
  };
  const vivaBaseUrl = url(config.vivaBaseUrl, "VIVA_API_URL");
  const cupBaseUrl = url(config.cupBaseUrl, "CUP_API_URL");
  const tenantKey = String(config.tenantKey || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(tenantKey)) throw new Error("RESIDENCY_CONFIG_INVALID:TENANT");
  const productId = String(config.productId || RESIDENCY_PRODUCT_ID);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) {
    throw new Error("RESIDENCY_CONFIG_INVALID:PRODUCT");
  }
  const cupIntegrationToken = String(config.cupIntegrationToken || "");
  if (cupIntegrationToken.length < 32 || /\s/.test(cupIntegrationToken)) throw new Error("RESIDENCY_CONFIG_INVALID:CUP_TOKEN");
  const successUrl = url(config.successUrl, "SUCCESS_URL");
  const failUrl = url(config.failUrl, "FAIL_URL");
  const paymentTtlMs = Number.isSafeInteger(config.paymentTtlMs) && config.paymentTtlMs > 0 ? config.paymentTtlMs : DEFAULT_TTL_MS;
  return { vivaBaseUrl, cupBaseUrl, tenantKey, productId, cupIntegrationToken, successUrl, failUrl, paymentTtlMs,
    timeoutMs: Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 500 && config.timeoutMs <= 15000 ? config.timeoutMs : 8000 };
}

function stable(value) {
  return JSON.stringify((function sort(input) {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])]));
    return input;
  })(value));
}

function text(value, max = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !Array.from(value).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
}

function iso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isoMillis(value) {
  return iso(value) ? new Date(value).toISOString() : null;
}

function httpsUrl(value) {
  if (!text(value, 4096)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch { return null; }
}

function unwrap(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  if (body.ok === false) return null;
  return body.data && typeof body.data === "object" ? body.data : body;
}

function providerError(code, statusCode = 503) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Only an explicit provider refusal of the request itself proves that no transaction was
// created. Transport errors, timeouts, 5xx and ambiguous statuses never do.
const CREATE_REJECTION_STATUS = [400, 401, 403, 404, 405, 415, 422];

function withOutcome(error, outcome) {
  const resolved = error instanceof Error ? error : providerError(String(error?.code || "RESIDENCY_UPSTREAM_UNAVAILABLE"));
  resolved.outcome = outcome;
  return resolved;
}

function createFailureOutcome(error) {
  return CREATE_REJECTION_STATUS.includes(Number(error?.upstreamStatus)) ? "REJECTED" : "UNKNOWN";
}

async function requestJson(fetchImpl, url, options, config) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), config.timeoutMs) : null;
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      ...(controller ? { signal: controller.signal } : {}),
    });
    const status = response?.status;
    const contentType = response?.headers?.get?.("content-type") || "";
    if (typeof status !== "number") throw providerError("RESIDENCY_UPSTREAM_INVALID");
    if (!/^application\/json\b/i.test(contentType)) throw providerError("RESIDENCY_UPSTREAM_INVALID");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw providerError("RESIDENCY_UPSTREAM_INVALID");
    let body;
    try { body = JSON.parse(raw); } catch { throw providerError("RESIDENCY_UPSTREAM_INVALID"); }
    if (status < 200 || status >= 300) {
      const code = text(body?.code, 64) ? body.code : text(body?.error?.code, 64) ? body.error.code : "RESIDENCY_UPSTREAM_REJECTED";
      const error = providerError(code, status);
      error.upstreamStatus = status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw providerError("RESIDENCY_UPSTREAM_TIMEOUT", 504);
    if (error?.code) throw error;
    throw providerError("RESIDENCY_UPSTREAM_UNAVAILABLE");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateProduct(body, productId) {
  const product = unwrap(body);
  if (!product || product.id !== productId) throw providerError("RESIDENCY_PRODUCT_MISMATCH");
  const price = product.discountPrice ?? product.cost;
  if (!Number.isSafeInteger(product.cost) || product.cost <= 0 || !Number.isSafeInteger(price) || price <= 0 || price > product.cost
    || product.validityDays !== 30 || product.visits !== 30 || product.activationDays !== 0
    || product.type !== "GROUP" || product.variant !== "BY_VISITS" || product.appliesTo !== "BOOKING"
    || product.hasStudioLimitation !== false || product.hasDirectionLimitation !== false
    || product.hasDayLimitation !== false || product.hasTimeRangeLimitation !== false || product.hasDayTimeLimitation !== false
    || product.hasTypeLimitation !== true || !Array.isArray(product.availableTypes) || product.availableTypes.length !== 1
    || product.availableTypes[0]?.id !== 2572) {
    throw providerError("RESIDENCY_PRODUCT_TERMS_MISMATCH");
  }
  return { productId, title: text(product.title, 160) ? product.title : "Резидентство ПадлхАБ", priceMinor: price,
    termDays: product.validityDays, currency: "RUB" };
}

function validateProfile(body) {
  const profile = unwrap(body);
  if (!profile || !text(profile.id, 128) || !text(profile.phone, 32) || !/^\+[1-9][0-9]{7,14}$/.test(profile.phone)) {
    throw providerError("RESIDENCY_PROFILE_UNAVAILABLE", 403);
  }
  return { clientId: profile.id, phone: profile.phone };
}

export function createVivaCupResidencyPorts({
  fetch: fetchImpl,
  config,
  actorToken,
  getAdminToken,
  now = () => new Date(),
}) {
  if (typeof fetchImpl !== "function") throw new Error("RESIDENCY_FETCH_REQUIRED");
  if (!text(actorToken, 8192)) throw new Error("RESIDENCY_ACTOR_TOKEN_REQUIRED");
  if (typeof getAdminToken !== "function") throw new Error("RESIDENCY_ADMIN_TOKEN_REQUIRED");
  const c = assertConfig(config);
  let profilePromise = null;
  const profile = () => (profilePromise ||= requestJson(fetchImpl,
    c.vivaBaseUrl + "/end-user/api/v1/" + encodeURIComponent(c.tenantKey) + "/profile",
    { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + actorToken } }, c)
    .then(validateProfile));

  async function catalogRead() {
    const product = validateProduct(await requestJson(fetchImpl,
      c.vivaBaseUrl + "/end-user/api/v1/" + encodeURIComponent(c.tenantKey) + "/products/subscriptions/" + encodeURIComponent(c.productId),
      { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + actorToken } }, c), c.productId);
    return { ...product, benefits: [], renewalEligible: false, checkedAt: now().toISOString() };
  }

  async function createPayment({ amountMinor, successUrl, failUrl }) {
    const returnSuccess = httpsUrl(successUrl || c.successUrl);
    const returnFail = httpsUrl(failUrl || c.failUrl);
    if (!returnSuccess || !returnFail) throw providerError("RESIDENCY_RETURN_TARGET_INVALID", 400);
    let holder;
    try {
      holder = await profile();
    } catch (error) {
      // The profile read happens before the transaction POST: nothing was created.
      throw withOutcome(error, "REJECTED");
    }
    const body = {
      clientPhone: holder.phone,
      failUrl: returnFail,
      failRedirectUrl: returnFail,
      failureRedirectUrl: returnFail,
      paymentMethod: "WIDGET",
      products: [{ id: c.productId, type: "SUBSCRIPTION", count: 1 }],
      count: 1,
      id: c.productId,
      type: "SUBSCRIPTION",
      baseRedirectUrl: returnSuccess,
      redirectUrl: returnSuccess,
      returnUrl: returnSuccess,
      successRedirectUrl: returnSuccess,
      successUrl: returnSuccess,
    };
    let response;
    try {
      response = unwrap(await requestJson(fetchImpl,
        c.vivaBaseUrl + "/end-user/api/v1/" + encodeURIComponent(c.tenantKey) + "/transactions",
        { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + actorToken }, body: JSON.stringify(body) }, c));
    } catch (error) {
      throw withOutcome(error, createFailureOutcome(error));
    }
    // From here the provider may already own a financial operation. Any doubt is
    // reported as UNCONFIRMED with the transaction id we managed to observe, so the
    // owner can persist it and recover the late result instead of losing it.
    let transactionId = null;
    try {
      if (!response) throw providerError("RESIDENCY_PAYMENT_INVALID");
      const ids = [response.transactionId, response.id].filter((id) => text(id, 128));
      if (new Set(ids).size > 1) throw providerError("RESIDENCY_PAYMENT_INVALID");
      transactionId = ids[0] || null;
      const toPay = Number.isSafeInteger(response.toPay) ? response.toPay : null;
      const paid = response.paid === true;
      if (paid) {
        if (toPay !== null && toPay !== 0 && toPay !== amountMinor) throw providerError("RESIDENCY_PAYMENT_INVALID");
        if (toPay === 0 || toPay === null) {
          return { status: "PAID", providerTransactionId: transactionId, paymentUrl: null, amountMinor,
            paidAt: iso(response.paymentDate) ? isoMillis(response.paymentDate) : now().toISOString() };
        }
        // A paid response with the full amount is not trusted on its own: read the
        // Admin transaction and require the same terminal evidence as a callback.
        if (!transactionId) throw providerError("RESIDENCY_PAYMENT_INVALID");
        const verified = await readPayment({ amountMinor, providerTransactionId: transactionId });
        if (verified?.status !== "PAID") throw providerError("RESIDENCY_PAYMENT_INVALID");
        return verified;
      }
      const paymentUrl = httpsUrl(response.paymentUrl);
      if (!paymentUrl || toPay !== amountMinor) throw providerError("RESIDENCY_PAYMENT_INVALID");
      const due = iso(response.paymentDueDate) ? isoMillis(response.paymentDueDate) : null;
      return { status: "PENDING", providerTransactionId: transactionId, paymentUrl, amountMinor,
        expiresAt: due || new Date(now().getTime() + c.paymentTtlMs).toISOString() };
    } catch (error) {
      return { status: "UNCONFIRMED", providerTransactionId: transactionId, amountMinor, paymentUrl: null,
        reason: text(error?.code, 64) ? error.code : "RESIDENCY_PAYMENT_INVALID" };
    }
  }

  async function readPayment({ amountMinor, providerTransactionId }) {
    if (!text(providerTransactionId, 128)) return { status: "UNKNOWN" };
    const adminToken = getAdminToken();
    if (!text(adminToken, 8192)) throw providerError("RESIDENCY_ADMIN_TOKEN_UNAVAILABLE");
    const transaction = unwrap(await requestJson(fetchImpl,
      c.vivaBaseUrl + "/api/v1/transactions/" + encodeURIComponent(providerTransactionId),
      { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + adminToken } }, c));
    if (!transaction || transaction.id !== providerTransactionId) throw providerError("RESIDENCY_PAYMENT_INVALID");
    const holder = await profile();
    if (transaction.client?.id !== holder.clientId) throw providerError("RESIDENCY_PAYMENT_OWNERSHIP_MISMATCH", 403);
    if (!Array.isArray(transaction.products) || transaction.products.length !== 1
      || transaction.products[0]?.id !== c.productId || transaction.products[0]?.type !== "SUBSCRIPTION"
      || transaction.products[0]?.count !== 1) throw providerError("RESIDENCY_PAYMENT_PRODUCT_MISMATCH");
    if (Number.isInteger(transaction.refundSum) && transaction.refundSum > 0) return { status: "FAILED" };
    if (Array.isArray(transaction.transactionRefunds) && transaction.transactionRefunds.length > 0) return { status: "FAILED" };
    const status = String(transaction.status || transaction.transactionStatus || "").toUpperCase();
    if (["PAID", "COMPLETED"].includes(status)) {
      // A PAID card transaction can carry the charged amount in toPay; a fully
      // discounted/zero issuance carries 0. Anything else is not this order.
      if (!Number.isSafeInteger(transaction.toPay) || (transaction.toPay !== 0 && transaction.toPay !== amountMinor)) {
        throw providerError("RESIDENCY_PAYMENT_AMOUNT_MISMATCH");
      }
      if (!iso(transaction.paymentDate)) return { status: "UNKNOWN" };
      return { status: "PAID", providerTransactionId, amountMinor, paymentUrl: null, paidAt: isoMillis(transaction.paymentDate) };
    }
    if (["UNPAID", "WAITING", "PENDING", "CREATED"].includes(status)) {
      if (transaction.toPay !== amountMinor) throw providerError("RESIDENCY_PAYMENT_AMOUNT_MISMATCH");
      return { status: "PENDING", providerTransactionId, amountMinor,
        paymentUrl: httpsUrl(transaction.cardPaymentInfo?.paymentUrl) || null,
        expiresAt: iso(transaction.paymentDueDate) ? isoMillis(transaction.paymentDueDate) : null };
    }
    if (["REFUND", "REFUNDED", "CANCELLED", "CANCELED", "FAILED", "DECLINED"].includes(status)) return { status: "FAILED" };
    return { status: "UNKNOWN" };
  }

  async function findInstance({ productId, providerTransactionId, paidAt }) {
    const holder = await profile();
    const rows = [];
    let total = null;
    for (let page = 0; page < 5; page += 1) {
      const read = await requestJson(fetchImpl,
        c.vivaBaseUrl + "/end-user/api/v1/" + encodeURIComponent(c.tenantKey)
          + "/subscriptions?includeFinished=true&size=200&page=" + page,
        { method: "GET", headers: { Accept: "application/json", Authorization: "Bearer " + actorToken } }, c);
      const body = unwrap(read);
      const pageRows = Array.isArray(body) ? body : Array.isArray(body?.subscriptions) ? body.subscriptions
        : Array.isArray(body?.items) ? body.items : null;
      if (!pageRows) throw providerError("RESIDENCY_SUBSCRIPTIONS_INVALID");
      if (body && !Array.isArray(body) && Number.isInteger(body.total)) total = body.total;
      rows.push(...pageRows);
      if (rows.length > 2000) throw providerError("RESIDENCY_SUBSCRIPTIONS_PARTIAL");
      if (pageRows.length < 200) break;
      if (page === 4 && pageRows.length === 200) throw providerError("RESIDENCY_SUBSCRIPTIONS_PARTIAL");
    }
    if (total !== null && rows.length !== total) throw providerError("RESIDENCY_SUBSCRIPTIONS_PARTIAL");
    const seen = new Set();
    const matches = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") throw providerError("RESIDENCY_SUBSCRIPTIONS_INVALID");
      const id = row.subscriptionId ?? row.clientSubscriptionId ?? row.id;
      if (!text(id, 128)) throw providerError("RESIDENCY_SUBSCRIPTIONS_INVALID");
      if (seen.has(id)) throw providerError("RESIDENCY_SUBSCRIPTIONS_INVALID");
      seen.add(id);
      const rowProduct = row.productId ?? row.product?.id;
      const rowClient = row.clientId ?? row.client?.id ?? row.clientSubscription?.clientId;
      if (rowProduct !== productId) continue;
      if (rowClient !== holder.clientId) throw providerError("RESIDENCY_SUBSCRIPTION_OWNERSHIP_CONFLICT", 403);
      const state = String(row.status || "").toUpperCase();
      if (!["NEW", "ACTIVE", "HOLD", "FROZEN", "FINISHED", "EXPIRED"].includes(state)) throw providerError("RESIDENCY_SUBSCRIPTIONS_INVALID");
      const frozen = row.holdUntil && iso(row.holdUntil) && Date.parse(row.holdUntil) > now().getTime();
      if (state !== "ACTIVE" && state !== "NEW") continue;
      if (frozen) continue;
      const purchasedAt = iso(row.purchaseDate) ? isoMillis(row.purchaseDate) : iso(row.activationDate) ? isoMillis(row.activationDate) : null;
      if (!purchasedAt) continue;
      matches.push({ clientSubscriptionId: id, purchasedAt });
    }
    if (matches.length === 0) return null;
    matches.sort((left, right) => Date.parse(right.purchasedAt) - Date.parse(left.purchasedAt));
    const newest = matches[0];
    if (providerTransactionId && paidAt && Date.parse(newest.purchasedAt) + 5 * 60 * 1000 < Date.parse(paidAt)) {
      throw providerError("RESIDENCY_SUBSCRIPTION_STALE");
    }
    return newest;
  }

  async function cupContext({ clientSubscriptionId, refresh }) {
    const body = await requestJson(fetchImpl,
      c.cupBaseUrl + "/internal/subscriptions/" + (refresh ? "residency-booking-refresh" : "residency-booking-context"),
      { method: "POST", headers: {
        Accept: "application/json", "Content-Type": "application/json",
        Authorization: "Bearer " + actorToken,
        "X-Subscriptions-Integration-Token": c.cupIntegrationToken,
      }, body: JSON.stringify({ clientSubscriptionId }) }, c);
    if (body?.providerProductId !== c.productId) throw providerError("RESIDENCY_EVIDENCE_PRODUCT_MISMATCH");
    const instance = body?.context?.instance;
    if (!instance || instance.state !== "ACTIVE" || !iso(instance.activeFrom) || !iso(instance.activeTo)
      || Date.parse(instance.activeTo) <= Date.parse(instance.activeFrom)) {
      throw providerError("RESIDENCY_EVIDENCE_INVALID");
    }
    return { state: "ACTIVE", validFrom: isoMillis(instance.activeFrom), validUntil: isoMillis(instance.activeTo),
      source: "CUP_RESIDENCY_POLICY", observedAt: iso(body.observedAt) ? isoMillis(body.observedAt) : now().toISOString() };
  }

  async function activate({ clientSubscriptionId }) {
    try {
      return await cupContext({ clientSubscriptionId, refresh: true });
    } catch (error) {
      if (error?.upstreamStatus === 403 || error?.upstreamStatus === 409) {
        return { state: "REJECTED", reason: typeof error.code === "string" ? error.code : "ACTIVATION_REJECTED" };
      }
      throw error;
    }
  }

  async function statusRead() {
    try {
      const instance = await findInstance({ productId: c.productId });
      if (!instance) return { state: "NONE", source: "VIVA_OWNED_SUBSCRIPTIONS", observedAt: now().toISOString() };
      return await cupContext({ clientSubscriptionId: instance.clientSubscriptionId, refresh: false });
    } catch (error) {
      // Any failure after a partial/absent read is UNAVAILABLE, never absence. A 404
      // from the provider proves nothing about this user's residency.
      return { state: "UNAVAILABLE", source: "VIVA_CUP", reason: typeof error?.code === "string" ? error.code : "SOURCE_UNAVAILABLE" };
    }
  }

  async function discountsQuote({ baseAmountMinor }) {
    // No residency price discount is published today. The confirmed total is the exact
    // product price; the CUP publication remains the only authority for future lines.
    return { discountLines: [], totalMinor: baseAmountMinor };
  }

  return {
    catalog: { read: catalogRead },
    payments: { create: createPayment, read: readPayment },
    activation: { findInstance, activate },
    discounts: { quote: discountsQuote },
    status: { read: statusRead },
    // Test/ops introspection only.
    _config: c,
    _stable: stable,
  };
}