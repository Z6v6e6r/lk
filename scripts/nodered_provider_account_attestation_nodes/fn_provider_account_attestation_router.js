// Outputs: [bounded actor-token GET -> http request, result/refusal -> response].
// Only GET profile, subscriptions and (with a target) one exercise. No Mongo, no global
// credential, no provider write.
const ctx = msg._providerAccountAttestation;
const reject = (status, code) => {
  delete msg._providerAccountAttestation;
  return [null, paReject(msg, status, code)];
};
if (!paObject(ctx) || !paObject(ctx.claims) || !paRequest(ctx.body)) {
  return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
}
const c = ctx.claims;
// Re-checked before every hop: a slow provider cannot stretch the 60 s delegation.
if (!(c.exp * 1000 > Date.now()) || !(Date.parse(c.actor_token_expires_at) > Date.now())
  || !paEnabled(env) || !bookedOperationReadConfig(env).ok
  || !bookedOperationTokenBindingMatches(ctx.actorToken, c.actor_token_sha256)) {
  return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
}
const request = (step, path) => {
  ctx.step = step;
  ctx.expectedUrl = PA_VIVA_BASE + PA_VIVA_USER + path;
  msg.url = ctx.expectedUrl;
  msg.method = "GET";
  msg.headers = { Accept: "application/json", Authorization: "Bearer " + ctx.actorToken };
  msg.payload = undefined;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.error;
  delete msg.responseUrl;
  delete msg.statusCode;
  return [msg, null];
};
if (ctx.step === "start") return request("profile", "/profile");
if (!["profile", "subscriptions", "exercise"].includes(ctx.step)) return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
const status = Number(msg.statusCode);
if (msg.error || msg.url !== ctx.expectedUrl || msg.responseUrl !== ctx.expectedUrl) {
  return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
}
// The actor's own Viva token was refused: the account cannot be attested.
if (status === 401 || status === 403) return reject(403, "PROVIDER_ACCOUNT_FORBIDDEN");
if (ctx.step === "exercise" && status === 404) return reject(409, "PROVIDER_ACCOUNT_INVALID");
if (status !== 200) return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
const p = msg.payload;
// `ret: obj` leaves an unparseable body as a string: a provider fault, not account evidence.
if (p === null || typeof p !== "object") return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");

if (ctx.step === "profile") {
  const profile = paSelect.unwrapRecord(p);
  // The client id comes only from this actor-token read, never from the caller.
  const ids = paObject(profile) ? [profile.id, profile.clientId].filter((v) => v !== undefined && v !== null) : [];
  if (!ids.length || !ids.every(paId) || new Set(ids).size !== 1) return reject(409, "PROVIDER_ACCOUNT_INVALID");
  ctx.providerClientId = ids[0];
  return request("subscriptions", "/subscriptions?includeFinished=true&size=1000");
}

if (ctx.step === "subscriptions") {
  const rows = paCompleteList(p);
  if (!rows) return reject(409, "PROVIDER_ACCOUNT_INVALID");
  const nowMs = Date.now();
  const projected = [];
  const seen = new Set();
  for (const row of rows) {
    // Same explicit-id aliases the booking owner accepts in findOwnedSubscriptions.
    const aliases = [row.clientSubscriptionId, row.subscriptionId, row.clientSubId, row.clientSubscription?.id,
      row.clientSubscription?.clientSubscriptionId, row.clientSub?.id].filter((v) => v !== undefined && v !== null);
    if (!aliases.length || !aliases.every(paId) || new Set(aliases.map((v) => v.toLowerCase())).size !== 1) {
      return reject(409, "PROVIDER_ACCOUNT_INVALID");
    }
    const owners = [row.clientId, row.client?.id].filter((v) => v !== undefined && v !== null);
    if (owners.some((v) => String(v).toLowerCase() !== ctx.providerClientId.toLowerCase())) return reject(409, "PROVIDER_ACCOUNT_INVALID");
    const clientSubscriptionId = aliases[0];
    if (seen.has(clientSubscriptionId.toLowerCase())) return reject(409, "PROVIDER_ACCOUNT_INVALID");
    seen.add(clientSubscriptionId.toLowerCase());
    const products = [...new Set(paSelect.collectExactProductIds(row))];
    const productId = products.length === 1 && paUuid(products[0]) ? products[0] : null;
    const visitsLeft = row.visitsLeft;
    const remainingUnits = typeof visitsLeft === "number" && Number.isSafeInteger(visitsLeft) && visitsLeft >= 0
      ? visitsLeft : null;
    const expiryMs = paLifecycleInstant(row.expirationDate, true);
    const validUntil = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null;
    const providerStatus = String(row.status || "").trim().toUpperCase();
    const activation = String(row.activationDate || "").trim();
    // Presentation state only; every command re-verifies lifecycle on LK1 before a Viva write.
    const state = row.holdUntil || row.frozenUntil || row.isFrozen === true ? "PAUSED"
      : providerStatus === "NEW" && !activation ? "NOT_ACTIVATED"
        : providerStatus === "ACTIVE" && validUntil && expiryMs >= nowMs ? "ACTIVE"
          : "FINISHED";
    projected.push({ clientSubscriptionId, productId, title: paTitle(paSelect.pickName(row)), state,
      remainingUnits, validUntil });
    // Private eligibility evidence for the target proof; never returned.
    ctx.eligibility = ctx.eligibility || {};
    ctx.eligibility[clientSubscriptionId.toLowerCase()] = { products, purchase: paSelect.collectSubscriptionPurchaseDateEvidence(row),
      status: row.status, variant: row.variant, visitsLeft, activationMs: paLifecycleInstant(row.activationDate),
      expiryMs, paused: Boolean(row.holdUntil || row.frozenUntil || row.isFrozen === true) };
  }
  const rank = (s) => PA_STATES.indexOf(s.state);
  projected.sort((a, b) => rank(a) - rank(b)
    || (Date.parse(b.validUntil || "") || 0) - (Date.parse(a.validUntil || "") || 0)
    || (a.clientSubscriptionId < b.clientSubscriptionId ? -1 : 1));
  ctx.subscriptions = projected.slice(0, PA_MAX_SUBSCRIPTIONS);
  // The JOIN proof considers every attested subscription, not only the 50 shown.
  ctx.attestedIds = projected.map((s) => s.clientSubscriptionId);
  if (ctx.body.target) return request("exercise", "/exercises/" + encodeURIComponent(ctx.body.target.exerciseId));
  ctx.step = "done";
}

if (ctx.step === "exercise") {
  const exercise = paSelect.unwrapRecord(p);
  const ids = paObject(exercise) ? [exercise.id, exercise.exerciseId, exercise.uuid].filter((v) => v !== undefined && v !== null) : [];
  const startsAt = paSelect.eventStartsAt(exercise);
  const durationMinutes = paSelect.eventDurationMinutes(exercise);
  if (!ids.length || ids.some((v) => String(v).toLowerCase() !== ctx.body.target.exerciseId.toLowerCase()) || !startsAt
    || !Number.isSafeInteger(durationMinutes)) return reject(409, "PROVIDER_ACCOUNT_INVALID");
  const owned = ctx.attestedIds.filter((id) => paSelect.findOwnedSubscriptions(exercise, id).length > 0);
  const startMs = Date.parse(startsAt);
  const endMs = startMs + durationMinutes * 60000;
  const nowMs = Date.now();
  // The HUB JOIN rule (same pins as the LK1 money gate and the managed selector). Every
  // condition must be proved by this Viva read; a missing field is not eligible.
  const eligible = owned.filter((id) => {
    const e = (ctx.eligibility || {})[id.toLowerCase()];
    return Boolean(e) && e.products.length === 1 && e.products[0] === paHub.productId
      && !e.purchase.invalid && e.purchase.dates.length === 1
      && e.purchase.dates[0] >= paSelect.MANAGED_ENFORCEMENT_PURCHASE_FROM
      && e.status === "ACTIVE" && e.variant === "BY_VISITS"
      && Number.isSafeInteger(e.visitsLeft) && e.visitsLeft >= 1
      && Number.isFinite(e.activationMs) && e.activationMs <= nowMs && e.activationMs <= startMs
      && Number.isFinite(e.expiryMs) && e.expiryMs >= nowMs && e.expiryMs >= endMs
      && !e.paused;
  });
  ctx.targetProof = {
    exerciseId: ctx.body.target.exerciseId,
    startsAt,
    durationMinutes,
    ownedClientSubscriptionIds: owned.slice(0, PA_MAX_SUBSCRIPTIONS),
    eligibleClientSubscriptionIds: eligible.slice(0, PA_MAX_SUBSCRIPTIONS),
  };
  delete ctx.eligibility;
  ctx.step = "done";
}

if (ctx.step !== "done") return reject(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
const result = {
  contractVersion: 1,
  operationId: c.operation_id,
  providerTenantKey: PA_TENANT_KEY,
  providerClientId: ctx.providerClientId,
  subscriptions: ctx.subscriptions,
  attestedAt: new Date().toISOString(),
  ...(ctx.targetProof ? { targetProof: ctx.targetProof } : {}),
};
if (Buffer.byteLength(JSON.stringify(result), "utf8") > PA_MAX_BODY_BYTES) return reject(409, "PROVIDER_ACCOUNT_INVALID");
delete msg._providerAccountAttestation;
msg.statusCode = 200;
msg.payload = result;
return [null, msg];
