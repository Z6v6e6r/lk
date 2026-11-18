// Controlled Viva / CUP / Keycloak fixture for the isolated residency pilot.
// No real commercial call is made: every provider endpoint below is synthetic.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const PORT = Number(process.env.FIXTURE_PORT || 9443);
const TENANT = "iSkq6G";
const CLIENT = "00000000-0000-4000-8000-000000000001";
const PRODUCT = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
const CUP_TOKEN = "cup-integration-token-0123456789abcdef";

const state = { txs: [], subs: [], calls: [], raceMode: null };
const nowIso = () => new Date().toISOString();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Correlation-ID, X-Residency-Return-Target",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...CORS, ...extra });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
  });
}

const moscowDate = (iso) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(iso));

function authKind(req) {
  const value = String(req.headers.authorization || "");
  if (!value) return "none";
  const token = value.replace(/^Bearer\s+/i, "");
  if (token === "fixture.admin.token") return "admin";
  if (token.startsWith("eyJ") || token === "pilot.actor.token" || token === "ordinary.actor.token") return "actor";
  return "other";
}

function product() {
  return {
    id: PRODUCT, title: "Резидентство ПадлхАБ", cost: 79000, discountPrice: 79000,
    validityDays: 30, visits: 30, activationDays: 0, type: "GROUP", variant: "BY_VISITS",
    appliesTo: "BOOKING", hasStudioLimitation: false, hasDirectionLimitation: false,
    hasTypeLimitation: true, availableTypes: [{ id: 2572 }], hasDayLimitation: false,
    hasTimeRangeLimitation: false, hasDayTimeLimitation: false, showToUser: true,
    productType: "SUBSCRIPTION",
  };
}

function createTransaction({ source, successUrl }) {
  const created = nowIso();
  const due = new Date(Date.now() + 20 * 60_000).toISOString();
  const tx = {
    id: crypto.randomUUID(), clientId: CLIENT, productId: PRODUCT, source: source || "unknown",
    status: "UNPAID", toPay: 79000, sum: 79000, createDate: created, paymentDueDate: due,
    paymentDate: null, successUrl: successUrl || null,
    paymentUrl: "https://bank.fixture.invalid/pay/" + crypto.randomUUID(),
  };
  state.txs.push(tx);
  return tx;
}

function transactionDetail(tx) {
  return {
    id: tx.id, status: tx.status, toPay: tx.toPay, sum: tx.sum,
    client: { id: tx.clientId }, products: [{ id: PRODUCT, type: "SUBSCRIPTION", count: 1 }],
    refundSum: 0, transactionRefunds: [],
    cardPaymentInfo: { paymentUrl: tx.paymentUrl },
    paymentDueDate: tx.paymentDueDate,
    ...(tx.paymentDate ? { paymentDate: tx.paymentDate } : {}),
    createDate: tx.createDate,
  };
}

function ensureSubscription(tx) {
  const existing = state.subs.find((sub) => sub.transactionId === tx.id);
  if (existing) return existing;
  const purchased = tx.paymentDate || nowIso();
  const sub = {
    subscriptionId: crypto.randomUUID(), transactionId: tx.id, productId: PRODUCT, clientId: CLIENT,
    status: "ACTIVE", purchaseDate: purchased, activationDate: purchased,
    activeFrom: purchased, activeTo: new Date(Date.parse(purchased) + 30 * 86400000).toISOString(),
  };
  state.subs.push(sub);
  return sub;
}

const handler = async (req, res) => {
  const url = new URL(req.url, "https://fixture.invalid");
  const path = url.pathname;
  const method = req.method || "GET";
  if (method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (!path.startsWith("/_control")) {
    state.calls.push({ method, path, query: url.search, at: nowIso(), auth: authKind(req) });
  }

  // ---- control plane ----
  if (path === "/_control/state") return json(res, 200, { txs: state.txs, subs: state.subs, calls: state.calls, raceMode: state.raceMode });
  if (path === "/_control/reset") { state.txs = []; state.subs = []; state.calls = []; state.raceMode = null; return json(res, 200, { ok: true }); }
  if (path === "/_control/race") {
    const body = await readBody(req);
    state.raceMode = body && body.mode === "after_new_create" ? "after_new_create" : null;
    return json(res, 200, { ok: true, raceMode: state.raceMode });
  }
  if (path === "/_control/pay") {
    const body = await readBody(req);
    const tx = state.txs.find((row) => row.id === body.transactionId);
    if (!tx) return json(res, 404, { code: "TX_NOT_FOUND" });
    tx.status = "PAID"; tx.paymentDate = body.paymentDate || nowIso();
    const sub = ensureSubscription(tx);
    return json(res, 200, { ok: true, transaction: tx, subscription: sub });
  }
  if (path === "/_control/settle") {
    const body = await readBody(req);
    const tx = state.txs.find((row) => row.id === body.transactionId);
    if (!tx) return json(res, 404, { code: "TX_NOT_FOUND" });
    tx.status = body.status || "FAILED";
    return json(res, 200, { ok: true, transaction: tx });
  }

  // ---- Keycloak userinfo ----
  if (path === "/kc/realms/clients/protocol/openid-connect/userinfo") {
    const value = String(req.headers.authorization || "");
    const token = value.replace(/^Bearer\s+/i, "");
    if (!token) return json(res, 401, { error: "unauthorized" });
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
      const sub = payload.sub || (payload.role === "ordinary" ? "ordinary.user.0001" : "pilot.user.0001");
      return json(res, 200, { sub, azp: "widget", tenant_key: TENANT, phone: payload.phone });
    } catch {
      return json(res, 401, { error: "unauthorized" });
    }
  }

  // ---- Viva end-user API (old client and new gateway) ----
  if (path.startsWith("/viva/end-user/api/v1/" + TENANT + "/")) {
    const rest = path.slice(("/viva/end-user/api/v1/" + TENANT + "/").length);
    if (rest === "profile") return json(res, 200, { id: CLIENT, phone: "+15550000000" });
    if (rest === "products/subscriptions/" + PRODUCT) return json(res, 200, product());
    if (rest === "transactions" && method === "POST") {
      const body = await readBody(req);
      const successUrl = body && (body.baseRedirectUrl || body.successUrl || body.successRedirectUrl);
      const source = String(successUrl || "").includes("phResidencyLifecycleReturn") ? "new" : "old";
      const tx = createTransaction({ source, successUrl });
      if (source === "new" && state.raceMode === "after_new_create") {
        // Deterministic simulation of the published old client creating its transaction in
        // the window between the gateway's pre-create read and its post-create read.
        state.raceMode = null;
        createTransaction({ source: "old", successUrl: "https://127.0.0.1:8444/lk_new?phCheckoutReturn=residency" });
      }
      return json(res, 200, { paymentUrl: tx.paymentUrl, toPay: tx.toPay, id: tx.id, paymentDueDate: tx.paymentDueDate });
    }
    if (rest === "subscriptions") {
      const size = Number(url.searchParams.get("size") || 200);
      const page = Number(url.searchParams.get("page") || 0);
      const rows = state.subs.map((sub) => ({
        subscriptionId: sub.subscriptionId, productId: sub.productId, clientId: sub.clientId,
        status: sub.status, purchaseDate: sub.purchaseDate, activationDate: sub.activationDate,
      }));
      return json(res, 200, { subscriptions: rows.slice(page * size, page * size + size), total: rows.length });
    }
    return json(res, 404, { code: "END_USER_NOT_FOUND" });
  }

  // ---- Viva admin API ----
  if (path === "/viva/api/v1/transactions" && method === "GET") {
    if (authKind(req) !== "admin") return json(res, 401, { code: "UNAUTHORIZED" });
    const clientIds = url.searchParams.get("clientIds");
    const productIds = url.searchParams.get("productIds");
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const page = Number(url.searchParams.get("page") || 0);
    const size = Number(url.searchParams.get("size") || 100);
    const rows = state.txs
      .filter((tx) => (!clientIds || tx.clientId === clientIds) && (!productIds || tx.productId === productIds))
      .filter((tx) => { const day = moscowDate(tx.createDate); return (!dateFrom || day >= dateFrom) && (!dateTo || day <= dateTo); })
      .sort((a, b) => Date.parse(b.createDate) - Date.parse(a.createDate));
    const totalPages = rows.length === 0 ? 0 : Math.ceil(rows.length / size);
    return json(res, 200, {
      content: rows.slice(page * size, page * size + size).map(transactionDetail),
      number: page, totalPages, totalElements: rows.length,
      numberOfElements: rows.slice(page * size, page * size + size).length,
      last: page >= totalPages - 1,
    });
  }
  if (path.startsWith("/viva/api/v1/transactions/") && method === "GET") {
    if (authKind(req) !== "admin") return json(res, 401, { code: "UNAUTHORIZED" });
    const id = decodeURIComponent(path.slice("/viva/api/v1/transactions/".length));
    const tx = state.txs.find((row) => row.id === id);
    return tx ? json(res, 200, transactionDetail(tx)) : json(res, 404, { code: "TX_NOT_FOUND" });
  }

  // ---- CUP residency context ----
  if (path === "/cup/internal/subscriptions/residency-booking-refresh" || path === "/cup/internal/subscriptions/residency-booking-context") {
    if (req.headers["x-subscriptions-integration-token"] !== CUP_TOKEN) return json(res, 403, { code: "CUP_TOKEN" });
    const body = await readBody(req);
    const sub = state.subs.find((row) => row.subscriptionId === body.clientSubscriptionId);
    if (!sub) return json(res, 404, { code: "INSTANCE_NOT_FOUND" });
    return json(res, 200, {
      providerProductId: PRODUCT, observedAt: nowIso(),
      context: { instance: { state: "ACTIVE", activeFrom: sub.activeFrom, activeTo: sub.activeTo } },
    });
  }

  return json(res, 404, { code: "FIXTURE_NOT_FOUND", path });
};

const TLS_KEY = process.env.TLS_KEY || new URL("./certs/key.pem", import.meta.url);
const TLS_CERT = process.env.TLS_CERT || new URL("./certs/cert.pem", import.meta.url);
https.createServer({
  key: fs.readFileSync(TLS_KEY),
  cert: fs.readFileSync(TLS_CERT),
}, (req, res) => { handler(req, res).catch((error) => json(res, 500, { code: "FIXTURE_ERROR", message: String(error?.message || error) })); })
  .listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "fixture_listening", port: PORT })));