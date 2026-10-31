// Read-only owner bridge. Only configured CUP context/preflight endpoints can receive a Bearer.
// No database output, provider business write, journal, reservation or synthetic usage reference.
const context = msg._bookedOperationPreflight;
const fail = (status, code) => {
  delete msg._bookedOperationPreflight;
  delete msg.error;
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  msg.payload = { error: code, code };
  return [null, msg];
};
if (!context || !["start", "profile", "exercise", "context", "preflight"].includes(context.step)
  || !context.claims || !managedJoinV2Request(context.body, true)
  || typeof context.actorToken !== "string") return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
const get = name => { try { return global.get(name); } catch { return null; } };
const environment = get("subscriptions_runtime_environment");
// Same existing owner environment binding: DEV is intentionally unbound.
const base = environment === "PROD" && get("subscriptions_runtime_api_base_url") === "https://padlhub.su/api"
  ? "https://padlhub.su/api" : null;
const token = get(context.step === "exercise" ? "subscriptions_runtime_context_integration_token"
  : "subscriptions_entitlement_integration_token");
const request = (step, suffix, payload, integrationToken) => {
  context.step = step;
  context.expectedUrl = base + suffix;
  msg.method = "POST"; msg.url = context.expectedUrl;
  msg.payload = payload;
  msg.headers = { Authorization: `Bearer ${context.actorToken}`,
    "X-Subscriptions-Integration-Token": integrationToken,
    "X-Correlation-ID": context.claims.correlation_id,
    "Content-Type": "application/json", Accept: "application/json" };
  msg.followRedirects = false; msg.maxRedirects = 0; msg.requestTimeout = 10000;
  delete msg.error; delete msg.statusCode; delete msg.responseUrl;
  return [msg, null];
};
if (!base || context.claims.exp * 1000 <= Date.now() || Date.parse(context.claims.actor_token_expires_at) <= Date.now()
  || context.claims.target_admissible !== true) {
  return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
}
const providerGet = (step, suffix) => {
  context.step = step;
  context.expectedUrl = `https://api.vivacrm.ru/end-user/api/v1/${context.claims.tenant_key}/${suffix}`;
  msg.method = "GET"; msg.url = context.expectedUrl; msg.payload = undefined;
  msg.headers = { Authorization: `Bearer ${context.actorToken}`, Accept: "application/json" };
  msg.followRedirects = false; msg.maxRedirects = 0; msg.requestTimeout = 10000;
  delete msg.error; delete msg.statusCode; delete msg.responseUrl;
  return [msg, null];
};
if (context.step === "start") return providerGet("profile", "profile");
if (msg.error || Number(msg.statusCode) !== 200 || msg.responseUrl !== context.expectedUrl
  || !managedJoinV2Object(msg.payload)) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
if (context.step === "profile") {
  const profile = ownerSelection.unwrapRecord(msg.payload);
  if (!profile || (profile.id || profile.clientId) !== context.claims.provider_client_id) {
    return fail(403, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  }
  return providerGet("exercise", `exercises/${encodeURIComponent(context.claims.provider_exercise_id)}`);
}
if (context.step === "exercise") {
  const exercise = ownerSelection.unwrapRecord(msg.payload);
  if (!exercise || (exercise.id || exercise.exerciseId || exercise.uuid) !== context.claims.provider_exercise_id
    || ownerSelection.resolveCategory(exercise) !== "open_game"
    || Date.parse(ownerSelection.eventStartsAt(exercise)) !== Date.parse(context.claims.target_starts_at)
    || ownerSelection.eventDurationMinutes(exercise) !== context.claims.target_duration_minutes) {
    return fail(409, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  }
  const owned = ownerSelection.findOwnedSubscriptions(exercise, context.claims.provider_client_subscription_id);
  // The canonical selector's historical missing-config default is not positive legacy evidence.
  const configured = get("subscriptions_managed_enforcement_product_ids");
  if (owned.length !== 1 || configured === undefined || configured === null || configured === "") {
    return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  }
  const selected = ownerSelection.resolveManagedEnforcementDecision(owned, context.claims.provider_client_subscription_id);
  if (!selected.ok || !selected.exactProductId) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  if (!selected.enabled) {
    const result = { contractVersion: 2, nonBinding: true, operationId: context.claims.operation_id,
      action: "JOIN_GAME", target: context.body.target, management: "LEGACY" };
    fail(200, ""); msg.payload = result; return [null, msg];
  }
  if (typeof token !== "string" || Buffer.byteLength(token.trim(), "utf8") < 32) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  return request("context", "/internal/subscriptions/runtime-context",
    { clientSubscriptionId: context.claims.provider_client_subscription_id }, token);
}
if (typeof token !== "string" || Buffer.byteLength(token.trim(), "utf8") < 32) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
if (context.step === "context") {
  const r = msg.payload;
  if (r.schemaVersion !== 1 || r.clientSubscriptionId !== context.claims.provider_client_subscription_id
    || !managedJoinV2Id(r.subscriptionInstanceId) || r.instance?.subscriptionInstanceId !== r.subscriptionInstanceId
    || !managedJoinV2Positive(r.instance?.policyVersion) || r.policy?.policyVersion !== r.instance.policyVersion
    || !managedJoinV2Digest(r.policyDigest)) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
  context.instanceId = r.subscriptionInstanceId;
  context.policyVersion = r.instance.policyVersion;
  context.policyDigest = r.policyDigest;
  return request("preflight", "/internal/subscriptions/entitlements/preflight",
    { subscriptionInstanceId: context.instanceId, action: "JOIN_GAME",
      target: { targetId: context.claims.provider_exercise_id } }, token);
}
const r = msg.payload;
const entitlement = managedJoinV2Entitlement({ subscriptionInstanceId: r.subscriptionInstanceId, expectations: r.expectations });
if (!managedJoinV2Keys(r, "schemaVersion,nonBinding,subscriptionInstanceId,action,target,expectations")
  || r.schemaVersion !== 1 || r.nonBinding !== true || r.action !== "JOIN_GAME"
  || !managedJoinV2Keys(r.target, "targetId") || r.target.targetId !== context.claims.provider_exercise_id
  || !entitlement || entitlement.subscriptionInstanceId !== context.instanceId
  || entitlement.expectations.policyVersion !== context.policyVersion
  || entitlement.expectations.policyDigest !== context.policyDigest) return fail(503, "BOOKED_OPERATION_PREFLIGHT_UNAVAILABLE");
const result = { contractVersion: 2, nonBinding: true, operationId: context.claims.operation_id,
  action: "JOIN_GAME", target: context.body.target, entitlement };
fail(200, "");
msg.payload = result;
return [null, msg];
