// A durable attempt per athlete and exercise protects retries across processes and product changes.
const TC_VIVA = "https://api.vivacrm.ru";
const tcId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const tcObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const tcString = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
};
const tcProductId = (row) => tcString(row, [
  "id", "productId", "subscriptionId", "clientSubscriptionId", "oneTimeId", "clientOneTimeId", "uuid",
]);

function tcEmit(index) {
  const out = [null, null, null, null, null];
  out[index] = msg;
  return out;
}
function tcResponse(status, payload) {
  delete msg._lkTournamentCheckout;
  delete msg.error;
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  msg.payload = payload;
  return tcEmit(4);
}
function tcReject(status, code, message) {
  return tcResponse(status, { code, message });
}
function tcPending() {
  return tcResponse(202, { state: "PENDING_CONFIRMATION", code: "TOURNAMENT_CHECKOUT_OUTCOME_UNRESOLVED",
    message: "Результат записи уточняется. Повторная оплата заблокирована." });
}
function tcHttp(ctx, step, path, method = "GET", payload, authorization = ctx.auth) {
  ctx.step = step;
  ctx.url = path;
  ctx.method = method;
  msg._lkTournamentCheckout = ctx;
  msg.url = path;
  msg.method = method;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  msg.headers = { Authorization: authorization, Accept: "application/json",
    ...(method === "POST" ? { "Content-Type": "application/json" } : {}) };
  msg.payload = payload;
  delete msg.responseUrl;
  delete msg.statusCode;
  delete msg.error;
  return tcEmit(0);
}
function tcVerified(ctx) {
  return !msg.error && msg.method === ctx.method && msg.url === ctx.url
    && msg.followRedirects === false && msg.maxRedirects === 0
    && (msg.responseUrl === undefined || msg.responseUrl === ctx.url)
    && Number.isInteger(msg.statusCode) && msg.statusCode >= 200 && msg.statusCode < 300;
}
function tcMongo(ctx, step, output, payload) {
  ctx.step = step;
  msg._lkTournamentCheckout = ctx;
  msg.payload = payload;
  delete msg.error;
  return tcEmit(output);
}
function tcEnrollmentEffect(ctx, effect) {
  if (effect.kind === "http") {
    const token = global.get("vivacrm_access_token");
    if (typeof token !== "string" || !token.trim()) return tcEnrollmentEffect(ctx, teStep(ctx.enrollment, { error: true }));
    return tcHttp(ctx, "enrollment", effect.url, "GET", undefined, "Bearer " + token);
  }
  if (effect.kind !== "result") {
    const outputs = { find: 1, insert: 2, update: 3 };
    return tcMongo(ctx, "enrollment", outputs[effect.kind], effect.payload);
  }
  delete ctx.enrollment;
  switch (effect.outcome) {
    case "open": return tcHttp(ctx, "exercise", tcExercise(ctx));
    case "acquired":
      ctx.claim = effect.row;
      return tcPost(ctx);
    case "replay": return tcResponse(200, { transactionId: effect.transactionId });
    case "closed": return tcReject(409, "TOURNAMENT_PREVIOUS_ATTEMPT_CLOSED",
      "Предыдущая попытка закрыта. Выберите тариф и запишитесь снова.");
    case "locked": return tcReject(409, "TOURNAMENT_ENROLLMENT_HELD", "На турнир уже есть запись или незавершённая попытка.");
    default: return tcPending();
  }
}
function tcBeginEnrollment(ctx, mode) {
  const result = teBegin(ctx.tenant, ctx.actor, ctx.exerciseId, mode,
    { mode: "checkout", selection: ctx.selection, productType: ctx.product?.type ?? null, admission: ctx.admission ?? null });
  ctx.enrollment = result.state;
  return tcEnrollmentEffect(ctx, result.effect);
}
function tcExercise(ctx) {
  return ctx.v1 + "/exercises/" + encodeURIComponent(ctx.exerciseId);
}
function tcTransaction(ctx) {
  return ctx.v2 + "/transactions";
}
function tcCatalog(payload) {
  if (Array.isArray(payload)) return payload;
  if (!tcObject(payload) || payload.last === false) return null;
  const rows = ["items", "content", "data", "results"].map(key => payload[key]).find(Array.isArray);
  return rows && (!Number.isFinite(payload.totalElements) || payload.totalElements === rows.length) ? rows : null;
}
function tcReturnUrl(value, exerciseId, success) {
  // The widget may use different pages on these application origins.
  try {
    const url = new URL(value);
    if (!["https://padlhub.ru", "https://www.padlhub.ru", "https://padlhub.su", "https://www.padlhub.su"].includes(url.origin)
      || url.username || url.password) return null;
    url.searchParams.set("TorneosPADL_exercise", exerciseId);
    url.searchParams.delete(success ? "TorneosPADL_paymentfailed" : "TorneosPADL_paymentsuccess");
    url.searchParams.set(success ? "TorneosPADL_paymentsuccess" : "TorneosPADL_paymentfailed", "true");
    return url.toString();
  } catch {
    return null;
  }
}
function tcProduct(ctx, rows) {
  const matches = rows?.filter(row => tcProductId(row) === ctx.productId) || [];
  if (matches.length !== 1) return null;
  const row = matches[0];
  const types = ["SERVICE", "GOODS", "INSTANT_SUB_SERVICE", "ADVANCE_SUB_SERVICE",
    "COMMISSION", "FULL_PAYMENT_SERVICE", "SUBSCRIPTION", "DEPOSIT"];
  const rawType = tcString(row, ["productType", "type"])?.toUpperCase();
  const type = types.includes(rawType) ? rawType : ctx.source === "subscription" ? "SUBSCRIPTION" : "SERVICE";
  if ((type === "SUBSCRIPTION") !== (ctx.source === "subscription")) return null;
  const product = { id: ctx.productId, name: tcString(row, ["name", "title", "displayName"]) || "Продукт Viva",
    type, count: 1, bookingRequests: [{ exerciseId: ctx.exerciseId, client: null, comment: null, marketingAttribution: {} }] };
  if (type === "SUBSCRIPTION") {
    const clientSubscriptionId = tcString(row, ["clientSubscriptionId", "subscriptionId"]);
    const subscriptionId = tcString(row, ["subscriptionId"]);
    if (clientSubscriptionId) product.clientSubscriptionId = clientSubscriptionId;
    if (subscriptionId) product.subscriptionId = subscriptionId;
  }
  return product;
}

const tcCtx = msg._lkTournamentCheckout;
if (!tcCtx) {
  const body = msg.payload;
  const auth = msg.req?.headers?.authorization;
  const tenant = env.get("VIVA_TENANT_KEY");
  if (typeof auth !== "string" || !/^Bearer\s+\S+$/i.test(auth)) return tcReject(401, "AUTH_REQUIRED", "Войдите для записи.");
  if (tenant !== teTenant) {
    return tcReject(503, "TOURNAMENT_CHECKOUT_NOT_CONFIGURED", "Запись временно недоступна.");
  }
  if (!tcObject(body) || !tcId(body.exerciseId) || !tcId(body.productId)
    || !["one-time", "client-one-time", "subscription"].includes(body.source)
    || (body.promoCode != null && (typeof body.promoCode !== "string" || body.promoCode.length > 100))
    || [body.successUrl, body.failUrl].some(value => value != null && (typeof value !== "string" || value.length > 2000))) {
    return tcReject(400, "TOURNAMENT_CHECKOUT_INVALID", "Обновите варианты записи.");
  }
  const successUrl = tcReturnUrl(body.successUrl, body.exerciseId, true);
  const failUrl = tcReturnUrl(body.failUrl, body.exerciseId, false);
  if ((body.successUrl && !successUrl) || (body.failUrl && !failUrl)) {
    return tcReject(400, "TOURNAMENT_CHECKOUT_REDIRECT_INVALID", "Не удалось подтвердить страницу возврата.");
  }
  const ctx = { auth, tenant, exerciseId: body.exerciseId, productId: body.productId, source: body.source,
    promoCode: body.promoCode ?? null, successUrl, failUrl,
    v1: TC_VIVA + "/end-user/api/v1/" + tenant, v2: TC_VIVA + "/end-user/api/v2/" + tenant };
  return tcHttp(ctx, "profile", ctx.v1 + "/profile");
}

const ctx = tcCtx;
if (ctx.step === "profile") {
  const actor = msg.payload;
  const phone = typeof actor?.phone === "string" ? actor.phone.replace(/\D/g, "") : "";
  if (!tcVerified(ctx) || !tcId(actor?.id) || !/^[0-9]{8,15}$/.test(phone)) {
    return tcReject(401, "TOURNAMENT_CHECKOUT_ACTOR_UNVERIFIED", "Не удалось подтвердить профиль Viva.");
  }
  ctx.actor = actor.id;
  ctx.phone = phone;
  if (phone.length === 10) ctx.phone = "7" + phone;
  if (phone.length === 11 && phone[0] === "8") ctx.phone = "7" + phone.slice(1);
  ctx.selection = [ctx.source, ctx.productId, ctx.promoCode];
  return tcBeginEnrollment(ctx, "inspect");
}
if (ctx.step === "enrollment") {
  return tcEnrollmentEffect(ctx, teStep(ctx.enrollment, msg));
}
if (ctx.step === "exercise") {
  const exercise = msg.payload;
  const studioId = tcString(exercise?.studio, ["id"]) || tcString(exercise, ["studioId"]);
  const startsAt = tcString(exercise, ["timeFrom", "startsAt"]);
  const start = startsAt && Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(startsAt) ? startsAt : startsAt + "+03:00");
  if (!tcVerified(ctx) || exercise?.id !== ctx.exerciseId || !tcId(studioId)
    || !Number.isFinite(start) || start <= Date.now()
    || exercise.cancelled === true || exercise.canceled === true || exercise.isCancelled === true
    || exercise.archived === true || /CANCEL|DELETE|ARCHIVE/.test(String(exercise.status || "").toUpperCase())) {
    return tcReject(409, "TOURNAMENT_CHECKOUT_TARGET_UNVERIFIED", "Турнир недоступен для записи.");
  }
  if (exercise.inBooking === true) {
    return tcReject(409, "ALREADY_REGISTERED", "На этот турнир уже есть запись Viva.");
  }
  ctx.studioId = studioId;
  if (ctx.source === "client-one-time") {
    ctx.product = tcProduct(ctx, tcCatalog(exercise.availableClientOneTimes));
    if (!ctx.product) return tcReject(409, "TOURNAMENT_CHECKOUT_PRODUCT_UNAVAILABLE", "Тариф недоступен.");
    return tcHttp(ctx, "admission", cupTournamentDecisionUrl(ctx.exerciseId));
  }
  const catalog = ctx.source === "subscription" ? "subscriptions" : "one-times";
  return tcHttp(ctx, "catalog", ctx.v2 + "/products/" + catalog + "?exerciseId=" + encodeURIComponent(ctx.exerciseId));
}
if (ctx.step === "catalog") {
  if (!tcVerified(ctx)) return tcReject(503, "TOURNAMENT_CHECKOUT_CATALOG_UNAVAILABLE", "Не удалось подтвердить тариф Viva.");
  ctx.product = tcProduct(ctx, tcCatalog(msg.payload));
  if (!ctx.product) return tcReject(409, "TOURNAMENT_CHECKOUT_PRODUCT_UNAVAILABLE", "Тариф недоступен.");
  return tcHttp(ctx, "admission", cupTournamentDecisionUrl(ctx.exerciseId));
}
if (ctx.step === "admission") {
  const decision = readCupTournamentDecision(msg, ctx.actor, ctx.exerciseId);
  if (!decision.admission) return tcReject(decision.status, decision.code, decision.message);
  ctx.admission = decision.admission;
  return tcBeginEnrollment(ctx, "acquire");
}

function tcPost(ctx) {
  const { successUrl, failUrl } = ctx;
  return tcHttp(ctx, "post", tcTransaction(ctx), "POST", {
    products: [ctx.product], clientPhone: ctx.phone, paymentMethod: "WIDGET",
    exerciseId: ctx.exerciseId, studioId: ctx.studioId, promoCode: ctx.promoCode,
    ...(successUrl ? { successUrl, baseRedirectUrl: successUrl, redirectUrl: successUrl,
      returnUrl: successUrl, successRedirectUrl: successUrl } : {}),
    ...(failUrl ? { failUrl, failRedirectUrl: failUrl, failureRedirectUrl: failUrl } : {}),
  });
}
if (ctx.step === "post") {
  const transactionId = tcString(msg.payload, ["transactionId", "transaction_id", "id", "uuid"])
    || tcString(msg.payload?.transaction, ["transactionId", "id"])
    || tcString(msg.payload?.data, ["transactionId", "id"]);
  if (!tcVerified(ctx) || !tcId(transactionId)) return tcPending();
  ctx.transactionId = transactionId;
  ctx.providerResponse = msg.payload;
  return tcMongo(ctx, "save", 3, [teFilter(ctx.claim),
    { $set: { transactionId, updatedAt: new Date().toISOString() } }, teWrite]);
}
if (ctx.step === "save") {
  if (msg.error || !teMatch(msg.payload)) return tcPending();
  return tcResponse(200, { ...ctx.providerResponse, transactionId: ctx.transactionId });
}
return tcPending();
