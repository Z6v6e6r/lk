import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MODES = new Set(["preflight", "observe-before", "observe-after"]);

const DEFAULT_ENDPOINTS = Object.freeze({
  lkRelease: "/lk/release-dev.json",
  cupRelease: "/api/system/release",
  runtimeContext: "/api/internal/subscriptions/runtime-context",
  systemEvidence: "/api/internal/subscriptions/dev-uat/system-evidence",
  observability: "/api/internal/subscriptions/dev-uat/observability",
});

const DEFAULT_PRODUCTION_ORIGINS = Object.freeze([
  "https://padlhub.ru",
  "https://www.padlhub.ru",
  "https://padlhub.su",
  "https://www.padlhub.su",
  "https://cup.padlhub.su",
]);

const READ_ONLY_POST_PATHS = new Set([
  "/api/internal/subscriptions/runtime-context",
  "/internal/subscriptions/runtime-context",
  "/api/internal/subscriptions/dev-uat/observability",
  "/internal/subscriptions/dev-uat/observability",
]);
const EXPECTED_DELTA_METRICS = Object.freeze([
  "entitlementAggregateRevision",
  "dailyUsage",
  "activeUsage",
  "operations",
  "ledgerEntries",
  "outboxEntries",
  "testerGames",
  "providerWriteCounter",
  "paymentWriteCounter",
  "entitlementMutationCounter",
  "rollbackWriteCounter",
]);
const END_TO_END_MUTATION_METRICS = Object.freeze([
  "providerWriteCounter",
  "paymentWriteCounter",
  "entitlementMutationCounter",
  "rollbackWriteCounter",
]);
const ALL_OBSERVATION_METRICS = Object.freeze([
  ...EXPECTED_DELTA_METRICS,
  "orphanReserves",
  "fallbackCounter",
  "productionCupCalls",
  "unrelatedUserChanges",
]);
const SECRET_KEY = /(authorization|token|secret|cookie|password|phone|full.?name|first.?name|last.?name|fio)/i;
const ID_KEY = /(clientSubscriptionId|subscriptionInstanceId|providerBookingId|clientId|userId)$/i;
const SAFE_TOKEN = /^[A-Z][A-Z0-9_]{0,39}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const RELEASE_COMMIT = /^[a-f0-9]{40}$/i;
const RELEASE_SHA256 = /^[a-f0-9]{64}$/i;
const WRITE_SAFETY_DIMENSIONS = Object.freeze([
  "runnerMutationMethodsBlocked",
  "createJoinWritesAbsent",
  "providerBookingWritesAbsent",
  "paymentWritesAbsent",
  "entitlementMutationsAbsent",
  "rollbackWritesAbsent",
]);

export class UatError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "UatError";
    this.code = code;
    this.details = details;
  }
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" ? value.trim() : "";

const finiteDate = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] = match;
  const [year, month, day, hour, minute, second] = [yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59
    || (offsetHourRaw !== undefined && (Number(offsetHourRaw) > 23 || Number(offsetMinuteRaw) > 59))) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

function parseJson(value, label) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new UatError("INPUT_JSON_INVALID", `${label} must contain valid JSON`);
  }
}

function assertPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new UatError("PRIVATE_CONFIG_UNSAFE", "Private config must be a regular non-symlink file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UatError("PRIVATE_CONFIG_PERMISSIONS", "Private config must not be accessible by group or others");
  }
}

function loadPrivateConfig(env) {
  const filePath = text(env.DEV_UAT_CONFIG_FILE);
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  assertPrivateFile(resolved);
  const parsed = parseJson(fs.readFileSync(resolved, "utf8"), "DEV_UAT_CONFIG_FILE");
  if (!isObject(parsed)) throw new UatError("PRIVATE_CONFIG_INVALID", "Private config must contain a JSON object");
  return parsed;
}

function pick(env, config, key, fallback = undefined) {
  if (env[key] !== undefined && env[key] !== "") return env[key];
  if (config[key] !== undefined && config[key] !== "") return config[key];
  return fallback;
}

function requireInput(inputs, key) {
  if (!text(inputs[key])) throw new UatError("INPUT_MISSING", `${key} is required`);
}

export function loadInputs(env = process.env) {
  const config = loadPrivateConfig(env);
  const configuredProductionOrigins = parseJson(
    pick(env, config, "DEV_UAT_PRODUCTION_ORIGINS_JSON"),
    "DEV_UAT_PRODUCTION_ORIGINS_JSON",
  ) || config.productionOrigins || [];
  const allowedDevOrigins = parseJson(
    pick(env, config, "DEV_UAT_ALLOWED_DEV_ORIGINS_JSON"),
    "DEV_UAT_ALLOWED_DEV_ORIGINS_JSON",
  ) || config.allowedDevOrigins || [];
  if (!Array.isArray(configuredProductionOrigins) || !Array.isArray(allowedDevOrigins)) {
    throw new UatError("INPUT_ORIGINS_INVALID", "DEV origin allowlist and production denylist must be JSON arrays");
  }
  const expectedLkRelease = parseJson(
    pick(env, config, "DEV_UAT_EXPECTED_LK_RELEASE_JSON"),
    "DEV_UAT_EXPECTED_LK_RELEASE_JSON",
  ) || config.expectedLkRelease;
  const expectedCupRelease = parseJson(
    pick(env, config, "DEV_UAT_EXPECTED_CUP_RELEASE_JSON"),
    "DEV_UAT_EXPECTED_CUP_RELEASE_JSON",
  ) || config.expectedCupRelease;
  const inputs = {
    DEV_LK_BASE_URL: pick(env, config, "DEV_LK_BASE_URL"),
    DEV_CUP_BASE_URL: pick(env, config, "DEV_CUP_BASE_URL"),
    DEV_TEST_SUBSCRIPTION_A_ID: pick(env, config, "DEV_TEST_SUBSCRIPTION_A_ID"),
    DEV_TEST_SUBSCRIPTION_B_ID: pick(env, config, "DEV_TEST_SUBSCRIPTION_B_ID"),
    DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: pick(env, config, "DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID"),
    DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID: pick(env, config, "DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID"),
    DEV_TEST_AUTH_A: pick(env, config, "DEV_TEST_AUTH_A"),
    DEV_TEST_AUTH_B: pick(env, config, "DEV_TEST_AUTH_B"),
    DEV_CUP_INTEGRATION_TOKEN: pick(env, config, "DEV_CUP_INTEGRATION_TOKEN"),
    EXPECTED_SUBSCRIPTION_TYPE_ID: pick(env, config, "EXPECTED_SUBSCRIPTION_TYPE_ID"),
    EXPECTED_PRODUCT_ID: pick(env, config, "EXPECTED_PRODUCT_ID"),
    EXPECTED_RULE_A_VERSION: pick(env, config, "EXPECTED_RULE_A_VERSION"),
    EXPECTED_RULE_B_VERSION: pick(env, config, "EXPECTED_RULE_B_VERSION"),
    DEV_CONTROL_SUBSCRIPTION_ID: pick(env, config, "DEV_CONTROL_SUBSCRIPTION_ID"),
    DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: pick(env, config, "DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID"),
    DEV_CONTROL_AUTH: pick(env, config, "DEV_CONTROL_AUTH"),
    DEV_UAT_RUN_ID: pick(env, config, "DEV_UAT_RUN_ID"),
    DEV_UAT_EXPECTED_DELTA: parseJson(
      pick(env, config, "DEV_UAT_EXPECTED_DELTA_JSON"),
      "DEV_UAT_EXPECTED_DELTA_JSON",
    ) || config.expectedDelta,
    DEV_UAT_REDACTION_HMAC_KEY: pick(env, config, "DEV_UAT_REDACTION_HMAC_KEY"),
    expectedLkRelease,
    expectedCupRelease,
    allowedDevOrigins,
    productionOrigins: [...new Set([...DEFAULT_PRODUCTION_ORIGINS, ...configuredProductionOrigins])],
    timeoutMs: Number(pick(env, config, "DEV_UAT_TIMEOUT_MS", 8_000)),
    maxEvidenceAgeMs: Number(pick(env, config, "DEV_UAT_MAX_EVIDENCE_AGE_MS", 300_000)),
    beforeMaxAgeMs: Number(pick(env, config, "DEV_UAT_BEFORE_MAX_AGE_MS", 3_600_000)),
    endpoints: { ...DEFAULT_ENDPOINTS, ...(isObject(config.endpoints) ? config.endpoints : {}) },
    artifactRoot: path.resolve(pick(env, config, "DEV_UAT_ARTIFACT_ROOT", "artifacts/subscription-sale-period-dev-uat")),
  };
  for (const key of [
    "DEV_LK_BASE_URL", "DEV_CUP_BASE_URL", "DEV_TEST_SUBSCRIPTION_A_ID", "DEV_TEST_SUBSCRIPTION_B_ID",
    "DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID", "DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID",
    "DEV_TEST_AUTH_A", "DEV_TEST_AUTH_B", "DEV_CUP_INTEGRATION_TOKEN", "EXPECTED_SUBSCRIPTION_TYPE_ID",
    "EXPECTED_PRODUCT_ID", "EXPECTED_RULE_A_VERSION", "EXPECTED_RULE_B_VERSION", "DEV_CONTROL_SUBSCRIPTION_ID",
    "DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID", "DEV_CONTROL_AUTH",
  ]) requireInput(inputs, key);
  if (allowedDevOrigins.length === 0) {
    throw new UatError("DEV_ORIGIN_ALLOWLIST_REQUIRED", "An exact DEV origin allowlist is required");
  }
  if (!releaseBinding(expectedLkRelease) || !releaseBinding(expectedCupRelease)) {
    throw new UatError("EXPECTED_RELEASE_BINDING_REQUIRED", "Frozen LK and CUP release bindings are required");
  }
  if (!versionMatches(inputs.EXPECTED_RULE_A_VERSION, 1) || !versionMatches(inputs.EXPECTED_RULE_B_VERSION, 2)) {
    throw new UatError("EXPECTED_RULE_ASSIGNMENT_INVALID", "The only accepted assignment is A=V1 and B=V2");
  }
  if (!Number.isSafeInteger(inputs.timeoutMs) || inputs.timeoutMs < 100 || inputs.timeoutMs > 60_000) {
    throw new UatError("INPUT_TIMEOUT_INVALID", "DEV_UAT_TIMEOUT_MS must be an integer between 100 and 60000");
  }
  if (!Number.isSafeInteger(inputs.maxEvidenceAgeMs) || inputs.maxEvidenceAgeMs < 1_000 || inputs.maxEvidenceAgeMs > 3_600_000) {
    throw new UatError("INPUT_EVIDENCE_AGE_INVALID", "DEV_UAT_MAX_EVIDENCE_AGE_MS must be an integer between 1000 and 3600000");
  }
  if (!Number.isSafeInteger(inputs.beforeMaxAgeMs) || inputs.beforeMaxAgeMs < 60_000 || inputs.beforeMaxAgeMs > 86_400_000) {
    throw new UatError("INPUT_BEFORE_AGE_INVALID", "DEV_UAT_BEFORE_MAX_AGE_MS must be an integer between 60000 and 86400000");
  }
  return inputs;
}

function originRegistry(values) {
  const origins = new Set();
  const hostnames = new Set();
  for (const value of values) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
      origins.add(parsed.origin.toLowerCase());
      hostnames.add(parsed.hostname.toLowerCase().replace(/\.+$/, ""));
    } catch {
      return null;
    }
  }
  return { origins, hostnames };
}

export function classifyDevUrl(rawUrl, { allowedDevOrigins = [], productionOrigins = DEFAULT_PRODUCTION_ORIGINS } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "URL_INVALID" };
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, code: "URL_BASE_NOT_ORIGIN" };
  }
  const production = originRegistry(productionOrigins);
  const allowed = originRegistry(allowedDevOrigins);
  if (!production || !allowed) return { ok: false, code: "URL_ORIGIN_LIST_INVALID" };
  const origin = url.origin.toLowerCase();
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (production.hostnames.has(hostname)) return { ok: false, code: "URL_PRODUCTION_ORIGIN", origin };
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    return { ok: false, code: "URL_HTTPS_REQUIRED", origin };
  }
  if (!allowed.origins.has(origin)) return { ok: false, code: "URL_DEV_IDENTITY_UNPROVEN", origin };
  return { ok: true, code: "DEV_ORIGIN_CONFIRMED", origin };
}

export function redactRef(value, hmacKey = "") {
  const raw = text(String(value ?? ""));
  if (!raw) return null;
  if (hmacKey) return `hmac:${crypto.createHmac("sha256", hmacKey).update(raw).digest("hex").slice(0, 16)}`;
  const suffix = raw.slice(-6).replace(/[^A-Za-z0-9_-]/g, "_");
  return `redacted:…${suffix}`;
}

export function redact(value, { hmacKey = "", key = "" } = {}) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (ID_KEY.test(key)) return redactRef(value, hmacKey);
  if (Array.isArray(value)) return value.map((item) => redact(item, { hmacKey }));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redact(childValue, { hmacKey, key: childKey }),
  ]));
}

export function assertNoSecrets(value, secretValues = []) {
  const serialized = JSON.stringify(value);
  for (const secret of secretValues.filter((item) => typeof item === "string" && item.length >= 4)) {
    if (serialized.includes(secret)) throw new UatError("SECRET_REDACTION_FAILED", "Generated evidence contains a sensitive input");
  }
  if (/bearer\s+[A-Za-z0-9._~+/-]+/i.test(serialized)) {
    throw new UatError("SECRET_REDACTION_FAILED", "Generated evidence contains bearer material");
  }
}

function safeEndpoint(baseUrl, endpointPath) {
  if (!text(endpointPath) || !endpointPath.startsWith("/") || endpointPath.startsWith("//")) {
    throw new UatError("ENDPOINT_INVALID", "Endpoint paths must be absolute paths on the configured DEV origin");
  }
  const base = new URL(baseUrl);
  const target = new URL(endpointPath, `${base.origin}/`);
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) {
    throw new UatError("ENDPOINT_ORIGIN_MISMATCH", "Endpoint escaped the configured DEV origin");
  }
  return target;
}

function assertDevTargets(inputs) {
  const lk = classifyDevUrl(inputs.DEV_LK_BASE_URL, inputs);
  const cup = classifyDevUrl(inputs.DEV_CUP_BASE_URL, inputs);
  if (!lk.ok) throw new UatError(lk.code, "LK base URL is not a proven DEV origin");
  if (!cup.ok) throw new UatError(cup.code, "CUP base URL is not a proven DEV origin");
  if (lk.origin === cup.origin) throw new UatError("DEV_ORIGINS_MUST_DIFFER", "LK and CUP DEV origins must differ");
  return { lk, cup };
}

export class ReadOnlyHttpClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async json({ baseUrl, endpointPath, method = "GET", auth, integrationToken, body, cacheKey }) {
    const normalizedMethod = method.toUpperCase();
    const target = safeEndpoint(baseUrl, endpointPath);
    if (!["GET", "HEAD", "OPTIONS", "POST"].includes(normalizedMethod)) {
      throw new UatError("WRITE_METHOD_BLOCKED", `Method ${normalizedMethod} is not allowed`);
    }
    if (normalizedMethod === "POST" && !READ_ONLY_POST_PATHS.has(target.pathname)) {
      throw new UatError("WRITE_METHOD_BLOCKED", `POST ${target.pathname} is not an approved read-only endpoint`);
    }
    if (normalizedMethod === "POST") {
      const allowedKeys = target.pathname.endsWith("runtime-context")
        ? new Set(["clientSubscriptionId"])
        : new Set(["clientSubscriptionId", "correlationScope"]);
      if (!isObject(body) || Object.keys(body).some((key) => !allowedKeys.has(key))) {
        throw new UatError("READ_BODY_INVALID", "Read-only POST body contains an unsupported field");
      }
    }
    const logicalKey = cacheKey || `${normalizedMethod}:${target.href}:${JSON.stringify(body || null)}`;
    if (this.cache.has(logicalKey)) return this.cache.get(logicalKey);
    const request = this.#request({ target, method: normalizedMethod, auth, integrationToken, body });
    this.cache.set(logicalKey, request);
    try {
      return await request;
    } catch (error) {
      this.cache.delete(logicalKey);
      throw error;
    }
  }

  async #request({ target, method, auth, integrationToken, body }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { Accept: "application/json", "Cache-Control": "no-store" };
      if (auth) headers.Authorization = auth;
      if (integrationToken) headers["X-Subscriptions-Integration-Token"] = integrationToken;
      if (body) headers["Content-Type"] = "application/json";
      const response = await this.fetchImpl(target, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new UatError("HTTP_REDIRECT_BLOCKED", `Redirect from ${target.pathname} is blocked`);
      }
      if (!response.ok) throw new UatError("HTTP_NOT_OK", `${target.pathname} returned HTTP ${response.status}`);
      const payload = await response.json();
      if (!isObject(payload)) throw new UatError("HTTP_SCHEMA_INVALID", `${target.pathname} did not return an object`);
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new UatError("HTTP_TIMEOUT", `${target.pathname} timed out`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function versionValue(publication) {
  return publication?.version ?? publication?.policyVersion ?? publication?.policy?.policyVersion;
}

function versionMatches(actual, expected) {
  const left = String(actual ?? "").trim().toLowerCase();
  const right = String(expected ?? "").trim().toLowerCase();
  return left === right || `v${left}` === right || left === `v${right}`;
}

export function selectPublication(publications, purchasedAt, {
  expectedVersion,
  pinnedDigest,
  pinnedVersion,
  expectedSubscriptionTypeId,
} = {}) {
  const purchaseDate = finiteDate(purchasedAt);
  if (!purchaseDate) return { ok: false, code: purchasedAt ? "PURCHASED_AT_MALFORMED" : "PURCHASED_AT_MISSING" };
  if (!Array.isArray(publications) || publications.length === 0) return { ok: false, code: "PUBLICATION_HISTORY_MISSING" };
  const normalized = publications.map((publication) => ({
    version: versionValue(publication),
    digest: text(publication?.policyDigest || publication?.digest),
    effectiveAt: finiteDate(publication?.effectiveAt),
    status: text(publication?.status).toUpperCase(),
    disabled: publication?.disabled === true || publication?.enabled === false,
    subscriptionTypeId: text(publication?.subscriptionTypeId || publication?.policy?.subscriptionTypeId),
  }));
  if (normalized.some((item) => !item.effectiveAt || !Number.isSafeInteger(Number(item.version)) || !SHA256.test(item.digest))) {
    return { ok: false, code: "PUBLICATION_HISTORY_INVALID" };
  }
  if (expectedSubscriptionTypeId && normalized.some((item) => item.subscriptionTypeId !== expectedSubscriptionTypeId)) {
    return { ok: false, code: "PUBLICATION_TYPE_MISMATCH" };
  }
  const sorted = [...normalized].sort((left, right) => left.effectiveAt - right.effectiveAt);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].effectiveAt.getTime() === sorted[index].effectiveAt.getTime()) {
      return { ok: false, code: "PUBLICATION_EFFECTIVE_AT_AMBIGUOUS" };
    }
    if (Number(sorted[index].version) <= Number(sorted[index - 1].version)) {
      return { ok: false, code: "PUBLICATION_VERSIONS_NON_MONOTONIC" };
    }
  }
  const selected = sorted.filter((item) => item.effectiveAt <= purchaseDate).at(-1);
  if (!selected) return { ok: false, code: "PURCHASE_BEFORE_FIRST_PUBLICATION" };
  if (selected.disabled) return { ok: false, code: "SELECTED_PUBLICATION_DISABLED" };
  if (!["PUBLISHED", "SUPERSEDED"].includes(selected.status)) return { ok: false, code: "SELECTED_PUBLICATION_NOT_IMMUTABLE" };
  if (expectedVersion !== undefined && !versionMatches(selected.version, expectedVersion)) return { ok: false, code: "POLICY_VERSION_MISMATCH" };
  if (pinnedVersion !== undefined && !versionMatches(selected.version, pinnedVersion)) return { ok: false, code: "POLICY_VERSION_MISMATCH" };
  if (pinnedDigest && selected.digest !== pinnedDigest) return { ok: false, code: "POLICY_DIGEST_MISMATCH" };
  return {
    ok: true,
    code: "POLICY_SELECTED",
    selected: {
      version: selected.version,
      policyDigest: selected.digest,
      effectiveAt: selected.effectiveAt.toISOString(),
      status: selected.status,
    },
  };
}

function resolveEvidence(values, normalizer = text) {
  const normalized = values.map(normalizer).filter((value) => value !== "" && value !== undefined && value !== null);
  const unique = new Set(normalized.map((value) => typeof value === "string" ? value : JSON.stringify(value)));
  return { value: normalized[0] ?? "", present: normalized.length > 0, consistent: unique.size <= 1 };
}

function resolvePublicationHistory(runtime, evidence) {
  const candidates = [runtime.publicationHistory, evidence.publicationHistory, runtime.policyPublications]
    .filter((value) => Array.isArray(value));
  if (candidates.length === 0) return { value: [], consistent: true };
  return { value: candidates[0], consistent: new Set(candidates.map((value) => JSON.stringify(value))).size === 1 };
}

function normalizeRuntime(runtime) {
  const source = isObject(runtime) ? runtime : {};
  const instance = isObject(source.instance) ? source.instance : {};
  const policy = isObject(source.policy) ? source.policy : {};
  const evidence = isObject(source.evidence) ? source.evidence : {};
  const clientSubscription = resolveEvidence([source.clientSubscriptionId, instance.clientSubscriptionId]);
  const subscriptionInstance = resolveEvidence([source.subscriptionInstanceId, instance.subscriptionInstanceId]);
  const product = resolveEvidence([source.productId, instance.productId, instance.providerProductId, evidence.productId]);
  const subscriptionType = resolveEvidence([policy.subscriptionTypeId, instance.subscriptionTypeId, source.subscriptionTypeId]);
  const tenant = resolveEvidence([source.tenantId, instance.tenantId, evidence.tenantId]);
  const purchase = resolveEvidence([source.authoritativePurchasedAt, evidence.authoritativePurchasedAt]);
  const policyVersion = resolveEvidence([policy.policyVersion ?? policy.version, instance.policyVersion], (value) => (
    value === undefined || value === null || value === "" ? "" : String(value)
  ));
  const policyDigest = resolveEvidence([source.policyDigest, instance.policyDigest]);
  const instanceRevision = resolveEvidence([evidence.instanceRevision, instance.revision], (value) => (
    value === undefined || value === null || value === "" ? "" : value
  ));
  const history = resolvePublicationHistory(source, evidence);
  return {
    schemaVersion: source.schemaVersion,
    clientSubscriptionId: clientSubscription.value,
    subscriptionInstanceId: subscriptionInstance.value,
    productId: product.value,
    subscriptionTypeId: subscriptionType.value,
    purchasedAt: purchase.value,
    authoritativePurchasedAtProven: purchase.present && purchase.consistent,
    tenantId: tenant.value,
    policyVersion: policyVersion.value,
    policyDigest: policyDigest.value,
    instancePolicyVersion: instance.policyVersion,
    instancePolicyDigest: text(instance.policyDigest),
    instanceRevision: instanceRevision.value,
    instanceState: text(instance.state),
    publications: history.value,
    evidenceConsistent: [
      clientSubscription, subscriptionInstance, product, subscriptionType, tenant, purchase,
      policyVersion, policyDigest, instanceRevision, history,
    ].every((item) => item.consistent),
  };
}

function check(name, ok, code, details = undefined, status = undefined) {
  return { name, status: status || (ok ? "PASS" : "FAIL"), code, ...(details ? { details } : {}) };
}

function releaseBinding(payload) {
  if (!isObject(payload) || payload.schemaVersion !== 2 || text(payload.environment) !== "DEV"
    || !RELEASE_COMMIT.test(text(payload.sourceCommit))) return null;
  const digestKeys = Object.keys(payload).filter((key) => key.endsWith("Sha256")).sort();
  const lkDigestKeys = [
    "candidateSha256", "hostReadbackSha256", "manifestSha256",
    "servedSha256", "sourceFlowSha256",
  ].sort();
  const cupDigestKeys = [
    "artifactSha256", "hostReadbackSha256", "manifestSha256", "servedSha256",
  ].sort();
  const identityType = JSON.stringify(digestKeys) === JSON.stringify(lkDigestKeys)
    ? "LK" : JSON.stringify(digestKeys) === JSON.stringify(cupDigestKeys) ? "CUP" : null;
  if (!identityType) return null;
  const digests = Object.fromEntries(digestKeys.map((key) => [key, text(payload[key])]));
  if (!Object.values(digests).every((value) => RELEASE_SHA256.test(value))) return null;
  return {
    schemaVersion: 2, environment: "DEV", identityType,
    sourceCommit: text(payload.sourceCommit), ...digests,
  };
}

function inspectRelease(payload, label, expected) {
  const actual = releaseBinding(payload);
  const frozen = releaseBinding(expected);
  const matches = Boolean(actual && frozen) && Object.keys(frozen).every((key) => actual[key] === frozen[key]);
  return check(
    `${label}_RELEASE_BINDING`,
    matches,
    matches ? "RELEASE_BOUND_TO_FROZEN_IDENTITY" : "RELEASE_BINDING_MISMATCH",
    actual && frozen ? { actual, expected: frozen } : undefined,
  );
}

function currentEvidence(value, now, maxAgeMs) {
  const observedAt = finiteDate(value?.observedAt);
  const age = observedAt ? now.getTime() - observedAt.getTime() : Number.POSITIVE_INFINITY;
  return value?.current === true && age >= -5_000 && age <= maxAgeMs;
}

function writeSafetyFromSystem(system, now, maxAgeMs) {
  const evidence = system?.noWriteEvidence;
  return {
    runnerMutationMethodsBlocked: true,
    createJoinWritesAbsent: currentEvidence(evidence, now, maxAgeMs) && evidence?.createJoinWritesAbsent === true,
    providerBookingWritesAbsent: currentEvidence(evidence, now, maxAgeMs) && evidence?.providerBookingWritesAbsent === true,
    paymentWritesAbsent: currentEvidence(evidence, now, maxAgeMs) && evidence?.paymentWritesAbsent === true,
    entitlementMutationsAbsent: currentEvidence(evidence, now, maxAgeMs) && evidence?.entitlementMutationsAbsent === true,
    rollbackWritesAbsent: currentEvidence(evidence, now, maxAgeMs) && evidence?.rollbackWritesAbsent === true,
  };
}

export function hasCompleteNoWriteProof(report) {
  return report?.noWrites === true
    && hasCompleteSetupNoWriteProof(report)
    && report?.endToEndMutationEvidence?.complete === true
    && report?.endToEndMutationEvidence?.authenticated === true
    && report?.endToEndMutationEvidence?.absoluteZeroBefore === true
    && report?.endToEndMutationEvidence?.noMutationDeltas === true
    && report?.endToEndMutationEvidence?.noWritesProven === true;
}

export function hasCompleteSetupNoWriteProof(report) {
  return report?.setupNoWrites === true && WRITE_SAFETY_DIMENSIONS.every((key) => report?.writeSafety?.[key] === true);
}

function validateSystemEvidence(system, inputs, now, maxAgeMs) {
  const checks = [];
  checks.push(check("CUP_ENVIRONMENT", text(system.environment).toUpperCase() === "DEV", "CUP_ENVIRONMENT_NOT_DEV"));
  checks.push(check("SYSTEM_TENANT_PRESENT", Boolean(text(system.tenantId)), "SYSTEM_TENANT_MISSING"));
  checks.push(check(
    "RUNTIME_FLAGS_DEV_ONLY",
    system.runtimeFlags?.enabled === true && system.runtimeFlags?.devOnly === true && system.runtimeFlags?.productionEnabled !== true,
    "RUNTIME_FLAGS_SCOPE_INVALID",
  ));
  checks.push(check(
    "PRODUCTION_STATE_UNCHANGED",
    system.productionState?.unchanged === true && system.productionState?.runtimeFlagsEnabled !== true,
    "PRODUCTION_STATE_NOT_PROVEN",
  ));
  const required = Array.isArray(system.indexes?.required) ? system.indexes.required : [];
  const present = new Set(Array.isArray(system.indexes?.present) ? system.indexes.present : []);
  checks.push(check(
    "REQUIRED_INDEXES",
    required.length > 0 && required.every((item) => present.has(item)) && Array.isArray(system.indexes?.missing)
      && system.indexes.missing.length === 0,
    "REQUIRED_INDEXES_MISSING",
  ));
  checks.push(check("PROJECTION_CHECKPOINT_CURRENT", currentEvidence(system.projectionCheckpoint, now, maxAgeMs), "PROJECTION_CHECKPOINT_STALE"));
  checks.push(check("CANARY_EVIDENCE_CURRENT", currentEvidence(system.canaryEvidence, now, maxAgeMs), "CANARY_EVIDENCE_STALE"));
  const expectedInstances = [inputs.DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID, inputs.DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID];
  const actualInstances = Array.isArray(system.canaryEvidence?.subscriptionInstanceIds)
    ? system.canaryEvidence.subscriptionInstanceIds.map(text)
    : [];
  checks.push(check(
    "CANARY_EXACT_TWO_INSTANCE_ALLOWLIST",
    actualInstances.length === 2 && new Set(actualInstances).size === 2
      && expectedInstances.every((value) => actualInstances.includes(value)),
    "CANARY_INSTANCE_ALLOWLIST_MISMATCH",
  ));
  const writeSafety = writeSafetyFromSystem(system, now, maxAgeMs);
  checks.push(check("NO_WRITE_EVIDENCE_CURRENT", currentEvidence(system.noWriteEvidence, now, maxAgeMs), "NO_WRITE_EVIDENCE_STALE"));
  for (const dimension of WRITE_SAFETY_DIMENSIONS.slice(1)) {
    checks.push(check(`NO_WRITE_${dimension.replace(/([A-Z])/g, "_$1").toUpperCase()}`, writeSafety[dimension], "NO_WRITE_DIMENSION_UNPROVEN"));
  }
  return checks;
}

export function evaluatePreflight({ inputs, lkRelease, cupRelease, systemEvidence, runtimeA, runtimeB, runtimeControl = null, now = new Date() }) {
  const checks = [];
  const lkUrl = classifyDevUrl(inputs.DEV_LK_BASE_URL, inputs);
  const cupUrl = classifyDevUrl(inputs.DEV_CUP_BASE_URL, inputs);
  checks.push(check("LK_URL_DEV", lkUrl.ok, lkUrl.code, { origin: lkUrl.origin }));
  checks.push(check("CUP_URL_DEV", cupUrl.ok, cupUrl.code, { origin: cupUrl.origin }));
  checks.push(check("DEV_ORIGINS_DISTINCT", lkUrl.origin !== cupUrl.origin, "DEV_ORIGINS_MUST_DIFFER"));
  checks.push(inspectRelease(lkRelease, "LK", inputs.expectedLkRelease), inspectRelease(cupRelease, "CUP", inputs.expectedCupRelease));
  checks.push(...validateSystemEvidence(systemEvidence, inputs, now, inputs.maxEvidenceAgeMs));

  const a = normalizeRuntime(runtimeA);
  const b = normalizeRuntime(runtimeB);
  checks.push(check("SUBSCRIPTION_A_IDENTITY", a.clientSubscriptionId === inputs.DEV_TEST_SUBSCRIPTION_A_ID, "SUBSCRIPTION_A_IDENTITY_MISMATCH"));
  checks.push(check("SUBSCRIPTION_B_IDENTITY", b.clientSubscriptionId === inputs.DEV_TEST_SUBSCRIPTION_B_ID, "SUBSCRIPTION_B_IDENTITY_MISMATCH"));
  checks.push(check("SUBSCRIPTIONS_DISTINCT", Boolean(a.clientSubscriptionId && b.clientSubscriptionId && a.clientSubscriptionId !== b.clientSubscriptionId), "SUBSCRIPTIONS_NOT_DISTINCT"));
  checks.push(check("SUBSCRIPTION_A_INSTANCE_IDENTITY", a.subscriptionInstanceId === inputs.DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID, "SUBSCRIPTION_A_INSTANCE_IDENTITY_MISMATCH"));
  checks.push(check("SUBSCRIPTION_B_INSTANCE_IDENTITY", b.subscriptionInstanceId === inputs.DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID, "SUBSCRIPTION_B_INSTANCE_IDENTITY_MISMATCH"));
  checks.push(check("SUBSCRIPTION_INSTANCES_DISTINCT", Boolean(a.subscriptionInstanceId && b.subscriptionInstanceId && a.subscriptionInstanceId !== b.subscriptionInstanceId), "SUBSCRIPTION_INSTANCES_NOT_DISTINCT"));
  checks.push(check("PRODUCT_ID_MATCH", a.productId === inputs.EXPECTED_PRODUCT_ID && b.productId === inputs.EXPECTED_PRODUCT_ID, "PRODUCT_ID_MISMATCH"));
  checks.push(check("SUBSCRIPTION_TYPE_MATCH", a.subscriptionTypeId === inputs.EXPECTED_SUBSCRIPTION_TYPE_ID && b.subscriptionTypeId === inputs.EXPECTED_SUBSCRIPTION_TYPE_ID, "SUBSCRIPTION_TYPE_MISMATCH"));
  checks.push(check("EXPECTED_RULE_ASSIGNMENT", versionMatches(inputs.EXPECTED_RULE_A_VERSION, 1) && versionMatches(inputs.EXPECTED_RULE_B_VERSION, 2), "EXPECTED_RULE_ASSIGNMENT_INVALID"));
  for (const [label, runtime] of [["A", a], ["B", b]]) {
    checks.push(check(
      `RUNTIME_CONTEXT_${label}`,
      runtime.schemaVersion === 1 && runtime.evidenceConsistent && runtime.authoritativePurchasedAtProven
        && Boolean(runtime.subscriptionInstanceId) && Number.isSafeInteger(runtime.instanceRevision)
        && ["ACTIVE", "PENDING_ACTIVATION"].includes(runtime.instanceState),
      "RUNTIME_CONTEXT_INVALID",
    ));
    checks.push(check(
      `IMMUTABLE_INSTANCE_PIN_${label}`,
      SHA256.test(runtime.instancePolicyDigest) && runtime.instancePolicyVersion !== undefined
        && runtime.policyDigest === runtime.instancePolicyDigest,
      "IMMUTABLE_INSTANCE_PIN_MISSING_OR_MISMATCHED",
    ));
  }
  const dateA = finiteDate(a.purchasedAt);
  const dateB = finiteDate(b.purchasedAt);
  checks.push(check("PURCHASED_AT_AUTHORITATIVE", Boolean(dateA && dateB), "PURCHASED_AT_UNRESOLVED"));
  checks.push(check("PURCHASE_ORDER", Boolean(dateA && dateB && dateA < dateB), "PURCHASE_ORDER_INVALID"));
  checks.push(check(
    "CROSS_TENANT",
    Boolean(a.tenantId && systemEvidence.tenantId && a.tenantId === b.tenantId && a.tenantId === systemEvidence.tenantId),
    "CROSS_TENANT_MISMATCH",
  ));

  const selectedA = selectPublication(a.publications, a.purchasedAt, {
    expectedVersion: inputs.EXPECTED_RULE_A_VERSION,
    pinnedDigest: a.instancePolicyDigest,
    pinnedVersion: a.instancePolicyVersion,
    expectedSubscriptionTypeId: inputs.EXPECTED_SUBSCRIPTION_TYPE_ID,
  });
  const selectedB = selectPublication(b.publications, b.purchasedAt, {
    expectedVersion: inputs.EXPECTED_RULE_B_VERSION,
    pinnedDigest: b.instancePolicyDigest,
    pinnedVersion: b.instancePolicyVersion,
    expectedSubscriptionTypeId: inputs.EXPECTED_SUBSCRIPTION_TYPE_ID,
  });
  checks.push(check("PUBLICATION_A", selectedA.ok, selectedA.code));
  checks.push(check("PUBLICATION_B", selectedB.ok, selectedB.code));

  const rangeStart = finiteDate(systemEvidence.managedRange?.startsAt);
  const rangeEnd = finiteDate(systemEvidence.managedRange?.endsAt);
  checks.push(check(
    "MANAGED_RANGE",
    Boolean(dateA && dateB && rangeStart && rangeEnd && dateA >= rangeStart && dateB <= rangeEnd),
    "PURCHASE_OUTSIDE_MANAGED_RANGE",
  ));
  const v2EffectiveAt = finiteDate(selectedB.selected?.effectiveAt);
  checks.push(check(
    "TWO_RULE_BOUNDARY",
    Boolean(selectedA.ok && selectedB.ok && dateA && dateB && v2EffectiveAt && dateA < v2EffectiveAt && v2EffectiveAt <= dateB),
    "TWO_RULE_BOUNDARY_INVALID",
  ));

  if (runtimeControl) {
    const control = normalizeRuntime(runtimeControl);
    checks.push(check(
      "CONTROL_SUBSCRIPTION_EXCLUDED",
      control.schemaVersion === 1 && control.evidenceConsistent
        && control.clientSubscriptionId === inputs.DEV_CONTROL_SUBSCRIPTION_ID
        && control.clientSubscriptionId !== a.clientSubscriptionId
        && control.clientSubscriptionId !== b.clientSubscriptionId
        && control.subscriptionInstanceId === inputs.DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID
        && control.subscriptionInstanceId !== a.subscriptionInstanceId
        && control.subscriptionInstanceId !== b.subscriptionInstanceId
        && control.subscriptionTypeId === inputs.EXPECTED_SUBSCRIPTION_TYPE_ID
        && control.tenantId === systemEvidence.tenantId,
      "CONTROL_SUBSCRIPTION_NOT_EXACTLY_EXCLUDED",
    ));
  } else {
    checks.push(check("CONTROL_SUBSCRIPTION_EXCLUDED", false, "CONTROL_EVIDENCE_REQUIRED"));
  }

  const ok = checks.every((item) => item.status !== "FAIL");
  const writeSafety = writeSafetyFromSystem(systemEvidence, now, inputs.maxEvidenceAgeMs);
  const setupNoWrites = WRITE_SAFETY_DIMENSIONS.every((key) => writeSafety[key] === true);
  return {
    schemaVersion: 1,
    mode: "preflight",
    status: ok ? "READY" : "BLOCKED",
    setupNoWrites,
    noWrites: false,
    writeSafety,
    checks,
    origins: { lk: lkUrl.origin, cup: cupUrl.origin },
    releaseBindings: { lk: releaseBinding(lkRelease), cup: releaseBinding(cupRelease) },
    subjects: {
      A: { ...a, clientSubscriptionId: undefined, publications: undefined, selectedPolicy: selectedA.selected },
      B: { ...b, clientSubscriptionId: undefined, publications: undefined, selectedPolicy: selectedB.selected },
    },
  };
}

function observationSigningPayload(payload) {
  return {
    clientSubscriptionId: text(payload?.clientSubscriptionId),
    subscriptionInstanceId: text(payload?.subscriptionInstanceId),
    correlationScope: text(payload?.correlationScope),
    selectedPolicyVersion: payload?.selectedPolicyVersion,
    selectedPolicyDigest: text(payload?.selectedPolicyDigest),
    instanceRevision: payload?.instanceRevision,
    instanceState: text(payload?.instanceState),
    metrics: Object.fromEntries(ALL_OBSERVATION_METRICS.map((key) => [key, payload?.metrics?.[key]])),
    logicalResults: Array.isArray(payload?.logicalResults) ? payload.logicalResults.map((row) => ({
      step: row?.step,
      action: row?.action,
      result: row?.result,
      policyVersion: row?.policyVersion,
      policyDigest: row?.policyDigest,
      logicalOperationCount: row?.logicalOperationCount,
      providerCalls: row?.providerCalls,
      ledgerEntries: row?.ledgerEntries,
      outboxEntries: row?.outboxEntries,
      orphanReserve: row?.orphanReserve,
      fallback: row?.fallback,
      productionCupCalls: row?.productionCupCalls,
    })) : payload?.logicalResults,
  };
}

export function signObservationEvidence(payload, key) {
  return { ...payload, evidenceHmac: evidenceHmac(observationSigningPayload(payload), key) };
}

export function normalizeObservation(
  payload,
  expectedClientSubscriptionId,
  expectedSubscriptionInstanceId,
  expectedCorrelationScope,
  evidenceKey,
) {
  if (text(payload.clientSubscriptionId) !== expectedClientSubscriptionId) {
    throw new UatError("OBSERVATION_IDENTITY_MISMATCH", "Observability response is for another client subscription");
  }
  if (text(payload.subscriptionInstanceId) !== expectedSubscriptionInstanceId) {
    throw new UatError("OBSERVATION_INSTANCE_IDENTITY_MISMATCH", "Observability response is for another subscription instance");
  }
  if (!expectedCorrelationScope || text(payload.correlationScope) !== expectedCorrelationScope) {
    throw new UatError("OBSERVATION_SCOPE_MISMATCH", "Observability response is for another UAT correlation scope");
  }
  if (!isObject(payload.metrics) || ALL_OBSERVATION_METRICS.some((key) => (
    !Number.isSafeInteger(payload.metrics[key]) || payload.metrics[key] < 0
  ))) throw new UatError("OBSERVATION_SCHEMA_INVALID", "Observability metrics are incomplete or invalid");
  const selectedPolicyDigest = text(payload.selectedPolicyDigest);
  const instanceState = text(payload.instanceState);
  if (payload.selectedPolicyVersion === undefined || !SHA256.test(selectedPolicyDigest)
    || !Number.isSafeInteger(payload.instanceRevision) || !SAFE_TOKEN.test(instanceState)) {
    throw new UatError("OBSERVATION_SCHEMA_INVALID", "Observability policy or instance evidence is incomplete");
  }
  if (!Array.isArray(payload.logicalResults)) throw new UatError("OBSERVATION_SCHEMA_INVALID", "Observability logicalResults are missing");
  const logicalResults = payload.logicalResults.map((row) => {
    const normalized = {
      step: text(row?.step),
      action: text(row?.action),
      result: text(row?.result),
      policyVersion: row?.policyVersion,
      policyDigest: text(row?.policyDigest),
      logicalOperationCount: row?.logicalOperationCount,
      providerCalls: row?.providerCalls,
      ledgerEntries: row?.ledgerEntries,
      outboxEntries: row?.outboxEntries,
      orphanReserve: row?.orphanReserve,
      fallback: row?.fallback,
      productionCupCalls: row?.productionCupCalls,
    };
    const integerFields = ["logicalOperationCount", "providerCalls", "ledgerEntries", "outboxEntries", "productionCupCalls"];
    if (!SAFE_TOKEN.test(normalized.step) || !SAFE_TOKEN.test(normalized.action) || !SAFE_TOKEN.test(normalized.result)
      || normalized.policyVersion === undefined || !SHA256.test(normalized.policyDigest)
      || integerFields.some((key) => !Number.isSafeInteger(normalized[key]) || normalized[key] < 0)
      || typeof normalized.orphanReserve !== "boolean" || typeof normalized.fallback !== "boolean") {
      throw new UatError("OBSERVATION_LOGICAL_RESULT_INVALID", "A logical result is incomplete or unsafe");
    }
    return normalized;
  });
  if (!text(evidenceKey) || !timingSafeHexEqual(
    text(payload.evidenceHmac),
    evidenceHmac(observationSigningPayload(payload), evidenceKey),
  )) {
    throw new UatError("OBSERVATION_INTEGRITY_INVALID", "Observability evidence is not authenticated for the exact subject and scope");
  }
  return {
    selectedPolicyVersion: payload.selectedPolicyVersion,
    selectedPolicyDigest,
    instanceRevision: payload.instanceRevision,
    instanceState,
    metrics: Object.fromEntries(ALL_OBSERVATION_METRICS.map((key) => [key, payload.metrics[key]])),
    correlationScope: expectedCorrelationScope,
    evidenceAuthenticated: true,
    logicalResults,
  };
}

export function evaluateEndToEndMutationEvidence(before, after, runId) {
  const subjects = {};
  let complete = true;
  let authenticated = true;
  let absoluteZeroBefore = true;
  let noMutationDeltas = true;
  for (const subject of ["A", "B"]) {
    const beforeRow = before?.subjects?.[subject];
    const afterRow = after?.subjects?.[subject];
    const expectedScope = `subscription-sale-period:${runId}:${subject}`;
    const bound = Boolean(beforeRow && afterRow)
      && beforeRow.correlationScope === expectedScope && afterRow.correlationScope === expectedScope;
    const subjectAuthenticated = bound
      && beforeRow.evidenceAuthenticated === true && afterRow.evidenceAuthenticated === true;
    const deltas = {};
    let countersComplete = true;
    for (const metric of END_TO_END_MUTATION_METRICS) {
      const beforeValue = beforeRow?.metrics?.[metric];
      const afterValue = afterRow?.metrics?.[metric];
      const valid = Number.isSafeInteger(beforeValue) && beforeValue >= 0
        && Number.isSafeInteger(afterValue) && afterValue >= beforeValue;
      deltas[metric] = valid ? afterValue - beforeValue : null;
      countersComplete &&= valid;
      absoluteZeroBefore &&= valid && beforeValue === 0;
      noMutationDeltas &&= valid && deltas[metric] === 0;
    }
    complete &&= bound && countersComplete;
    authenticated &&= subjectAuthenticated;
    subjects[subject] = { scopeBound: bound, authenticated: subjectAuthenticated, deltas };
  }
  const absoluteZeroBeforeProven = complete && authenticated && absoluteZeroBefore;
  const noMutationDeltasProven = complete && authenticated && noMutationDeltas;
  return {
    runId,
    complete,
    authenticated,
    absoluteZeroBefore: absoluteZeroBeforeProven,
    noMutationDeltas: noMutationDeltasProven,
    noWritesProven: absoluteZeroBeforeProven && noMutationDeltasProven,
    subjects,
  };
}

function expectedLogicalEvidence(expected) {
  if (!Array.isArray(expected.logicalResults)) return { ok: false, rows: [] };
  const rows = expected.logicalResults.map((row) => ({
    step: text(row?.step),
    action: text(row?.action),
    result: text(row?.result),
    providerCalls: row?.providerCalls,
    ledgerEntries: row?.ledgerEntries,
    outboxEntries: row?.outboxEntries,
  }));
  const safe = rows.every((row) => SAFE_TOKEN.test(row.step) && SAFE_TOKEN.test(row.action) && SAFE_TOKEN.test(row.result)
    && ["providerCalls", "ledgerEntries", "outboxEntries"].every((key) => Number.isSafeInteger(row[key]) && row[key] >= 0));
  const unique = new Set(rows.map((row) => row.step)).size === rows.length;
  if (!safe || !unique) return { ok: false, rows: [] };
  const sums = {
    operations: rows.length,
    providerWriteCounter: rows.reduce((sum, row) => sum + row.providerCalls, 0),
    ledgerEntries: rows.reduce((sum, row) => sum + row.ledgerEntries, 0),
    outboxEntries: rows.reduce((sum, row) => sum + row.outboxEntries, 0),
  };
  const covered = Object.entries(sums).every(([key, value]) => expected.metrics[key] === value);
  return { ok: covered, rows };
}

export function reconcileObservations(before, after, expectedDelta) {
  const checks = [];
  for (const subject of ["A", "B"]) {
    const expected = expectedDelta?.[subject];
    const metricsValid = isObject(expected?.metrics) && EXPECTED_DELTA_METRICS.every((metric) => (
      Number.isSafeInteger(expected.metrics[metric]) && expected.metrics[metric] >= 0
    ));
    const logical = metricsValid ? expectedLogicalEvidence(expected) : { ok: false, rows: [] };
    const stateValid = Number.isSafeInteger(expected?.instanceRevisionDelta) && expected.instanceRevisionDelta >= 0
      && SAFE_TOKEN.test(text(expected?.instanceState)) && expected?.policyVersion !== undefined;
    const expectedComplete = metricsValid && logical.ok && stateValid;
    checks.push(check(`EXPECTED_DELTA_${subject}`, expectedComplete, "EXPECTED_DELTA_INCOMPLETE_OR_INCONSISTENT"));
    if (!expectedComplete) continue;
    const beforeRow = before.subjects?.[subject];
    const afterRow = after.subjects?.[subject];
    if (!beforeRow || !afterRow) {
      checks.push(check(`OBSERVATION_${subject}`, false, "OBSERVATION_SUBJECT_MISSING"));
      continue;
    }
    checks.push(check(`POLICY_VERSION_${subject}`, versionMatches(afterRow.selectedPolicyVersion, expected.policyVersion), "POLICY_VERSION_MISMATCH"));
    checks.push(check(`POLICY_DIGEST_${subject}`, beforeRow.selectedPolicyDigest === afterRow.selectedPolicyDigest, "POLICY_DIGEST_CHANGED"));
    checks.push(check(
      `INSTANCE_REVISION_${subject}`,
      afterRow.instanceRevision - beforeRow.instanceRevision === expected.instanceRevisionDelta,
      "INSTANCE_REVISION_DELTA_MISMATCH",
    ));
    checks.push(check(`INSTANCE_STATE_${subject}`, afterRow.instanceState === expected.instanceState, "INSTANCE_STATE_MISMATCH"));
    for (const metric of EXPECTED_DELTA_METRICS) {
      const actual = afterRow.metrics?.[metric] - beforeRow.metrics?.[metric];
      checks.push(check(`${subject}_${metric}`, actual === expected.metrics[metric], "UNEXPECTED_METRIC_DELTA", {
        expected: expected.metrics[metric], actual,
      }));
    }
    checks.push(check(`NO_DUPLICATE_OPERATION_${subject}`, afterRow.metrics.operations - beforeRow.metrics.operations === logical.rows.length, "DUPLICATE_OPERATION_DETECTED"));
    checks.push(check(`NO_ORPHAN_RESERVE_${subject}`, beforeRow.metrics.orphanReserves === 0 && afterRow.metrics.orphanReserves === 0, "ORPHAN_RESERVE_DETECTED"));
    checks.push(check(`NO_FALLBACK_${subject}`, beforeRow.metrics.fallbackCounter === 0 && afterRow.metrics.fallbackCounter === 0, "UNEXPECTED_FALLBACK"));
    checks.push(check(`NO_PRODUCTION_CUP_${subject}`, beforeRow.metrics.productionCupCalls === 0 && afterRow.metrics.productionCupCalls === 0, "PRODUCTION_CUP_CALLED"));
    checks.push(check(`ZERO_UNRELATED_USERS_${subject}`, beforeRow.metrics.unrelatedUserChanges === 0 && afterRow.metrics.unrelatedUserChanges === 0, "UNRELATED_USER_CHANGED"));
    checks.push(check(`CORRELATION_SCOPE_EMPTY_BEFORE_${subject}`, beforeRow.logicalResults?.length === 0, "CORRELATION_SCOPE_NOT_EMPTY_BEFORE"));

    const actualLogical = Array.isArray(afterRow.logicalResults) ? afterRow.logicalResults : [];
    const expectedSteps = logical.rows.map((row) => row.step);
    const actualSteps = actualLogical.map((row) => row.step);
    const stepsMatch = expectedSteps.length === actualSteps.length
      && new Set(actualSteps).size === actualSteps.length
      && expectedSteps.every((step) => actualSteps.includes(step));
    checks.push(check(`LOGICAL_RESULT_SET_${subject}`, stepsMatch, "LOGICAL_RESULT_SET_MISMATCH"));
    const totalsMatch = actualLogical.reduce((sum, row) => sum + row.logicalOperationCount, 0) === expected.metrics.operations
      && actualLogical.reduce((sum, row) => sum + row.providerCalls, 0) === expected.metrics.providerWriteCounter
      && actualLogical.reduce((sum, row) => sum + row.ledgerEntries, 0) === expected.metrics.ledgerEntries
      && actualLogical.reduce((sum, row) => sum + row.outboxEntries, 0) === expected.metrics.outboxEntries;
    checks.push(check(`LOGICAL_RESULT_TOTALS_${subject}`, totalsMatch, "LOGICAL_RESULT_TOTAL_MISMATCH"));
    for (const expectedResult of logical.rows) {
      const actualResult = actualLogical.find((row) => row.step === expectedResult.step);
      const exact = Boolean(actualResult) && actualResult.logicalOperationCount === 1
        && actualResult.action === expectedResult.action && actualResult.result === expectedResult.result
        && versionMatches(actualResult.policyVersion, expected.policyVersion)
        && actualResult.policyDigest === afterRow.selectedPolicyDigest
        && actualResult.providerCalls === expectedResult.providerCalls
        && actualResult.ledgerEntries === expectedResult.ledgerEntries
        && actualResult.outboxEntries === expectedResult.outboxEntries
        && actualResult.orphanReserve === false && actualResult.fallback === false
        && actualResult.productionCupCalls === 0;
      checks.push(check(`${subject}_LOGICAL_${expectedResult.step}`, exact, "LOGICAL_RESULT_MISMATCH"));
    }
  }
  return { ok: checks.every((item) => item.status !== "FAIL"), checks };
}

export function boundaryFixtures() {
  const v1 = { version: 1, subscriptionTypeId: "subscription-type-piter", effectiveAt: "2026-09-01T00:00:00.000Z", status: "SUPERSEDED", policyDigest: "a".repeat(64) };
  const v2 = { version: 2, subscriptionTypeId: "subscription-type-piter", effectiveAt: "2026-09-10T00:00:00.000Z", status: "PUBLISHED", policyDigest: "b".repeat(64) };
  return { v1, v2, publications: [v1, v2] };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "");
}

function validateRunId(runId) {
  if (!/^\d{8}T\d{9}Z$/.test(String(runId || ""))) {
    throw new UatError("RUN_ID_INVALID", "DEV_UAT_RUN_ID must be the exact millisecond timestamp printed by observe-before");
  }
  return runId;
}

function evidenceHmac(value, key) {
  return crypto.createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function timingSafeHexEqual(leftValue, rightValue) {
  if (!/^[a-f0-9]{64}$/i.test(text(leftValue)) || !/^[a-f0-9]{64}$/i.test(text(rightValue))) return false;
  const left = Buffer.from(leftValue, "hex");
  const right = Buffer.from(rightValue, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function addEvidenceIntegrity(report, key) {
  return { ...report, integrityHmac: evidenceHmac(report, key) };
}

function verifyEvidenceIntegrity(report, key) {
  if (!isObject(report) || !text(report.integrityHmac)) return false;
  const { integrityHmac, ...unsigned } = report;
  const expected = evidenceHmac(unsigned, key);
  return timingSafeHexEqual(integrityHmac, expected);
}

function markdown(report) {
  const rows = (report.checks || []).map((item) => `| ${item.name} | ${item.status} | ${item.code} |`).join("\n");
  const setupNoWriteStatus = hasCompleteSetupNoWriteProof(report) ? "PASS" : "FAIL";
  const endToEndNoWriteStatus = hasCompleteNoWriteProof(report) ? "PASS" : "FAIL";
  return `# Subscription sale-period DEV UAT\n\n- Mode: \`${report.mode}\`\n- Status: \`${report.status}\`\n- Setup/default no-write proof: \`${setupNoWriteStatus}\`\n- End-to-end no-write proof: \`${endToEndNoWriteStatus}\`\n- Generated: \`${report.generatedAt}\`\n\n| Check | Status | Code |\n|---|---|---|\n${rows || "| REPORT | PASS | NO_CHECKS |"}\n\nThe report is redacted. Runtime identifiers are represented only by HMAC bindings.\n`;
}

function ensureArtifactDirectory(root, runId) {
  validateRunId(runId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new UatError("ARTIFACT_PATH_UNSAFE", "Artifact root must be a regular directory");
  const directory = path.resolve(root, runId);
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`)) throw new UatError("ARTIFACT_PATH_UNSAFE", "Artifact run escaped the configured root");
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UatError("ARTIFACT_PATH_UNSAFE", "Artifact path is unsafe");
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(root, 0o700);
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function writeEvidence({ inputs, report, runId = safeTimestamp(), basename = "report", integrityKey = "" }) {
  const directory = ensureArtifactDirectory(inputs.artifactRoot, runId);
  const redacted = redact({ ...report, generatedAt: report.generatedAt || new Date().toISOString() }, {
    hmacKey: inputs.DEV_UAT_REDACTION_HMAC_KEY,
  });
  const protectedReport = integrityKey ? addEvidenceIntegrity(redacted, integrityKey) : redacted;
  assertNoSecrets(protectedReport, [
    inputs.DEV_TEST_AUTH_A, inputs.DEV_TEST_AUTH_B, inputs.DEV_CUP_INTEGRATION_TOKEN,
    inputs.DEV_UAT_REDACTION_HMAC_KEY, inputs.DEV_TEST_SUBSCRIPTION_A_ID,
    inputs.DEV_TEST_SUBSCRIPTION_B_ID, inputs.DEV_CONTROL_SUBSCRIPTION_ID,
    inputs.DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID, inputs.DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID,
    inputs.DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID,
  ]);
  const jsonPath = path.join(directory, `${basename}.json`);
  const markdownPath = path.join(directory, `${basename}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(protectedReport, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(markdownPath, markdown(protectedReport), { mode: 0o600, flag: "wx" });
  return { directory, jsonPath, markdownPath, report: protectedReport, runId };
}

function readBeforeEvidence(inputs) {
  const runId = validateRunId(inputs.DEV_UAT_RUN_ID);
  const root = path.resolve(inputs.artifactRoot);
  const beforePath = path.resolve(root, runId, "before.json");
  if (!beforePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(beforePath)) {
    throw new UatError("BEFORE_SNAPSHOT_MISSING", "The matching before snapshot was not found");
  }
  const stat = fs.lstatSync(beforePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new UatError("BEFORE_SNAPSHOT_UNSAFE", "The before snapshot is not a private regular file");
  }
  const before = parseJson(fs.readFileSync(beforePath, "utf8"), "before snapshot");
  if (!verifyEvidenceIntegrity(before, inputs.DEV_CUP_INTEGRATION_TOKEN)) {
    throw new UatError("BEFORE_SNAPSHOT_INTEGRITY", "The before snapshot integrity check failed");
  }
  return before;
}

async function fetchRuntime(inputs, client, subject, id, auth) {
  return client.json({
    baseUrl: inputs.DEV_CUP_BASE_URL,
    endpointPath: inputs.endpoints.runtimeContext,
    method: "POST",
    auth,
    integrationToken: inputs.DEV_CUP_INTEGRATION_TOKEN,
    body: { clientSubscriptionId: id },
    cacheKey: `runtime:${subject}:${id}`,
  });
}

async function collectPreflight(inputs, client, now) {
  const lkRelease = await client.json({ baseUrl: inputs.DEV_LK_BASE_URL, endpointPath: inputs.endpoints.lkRelease });
  const cupRelease = await client.json({ baseUrl: inputs.DEV_CUP_BASE_URL, endpointPath: inputs.endpoints.cupRelease });
  const systemEvidence = await client.json({ baseUrl: inputs.DEV_CUP_BASE_URL, endpointPath: inputs.endpoints.systemEvidence });
  const metadataChecks = [
    inspectRelease(lkRelease, "LK", inputs.expectedLkRelease),
    inspectRelease(cupRelease, "CUP", inputs.expectedCupRelease),
    ...validateSystemEvidence(systemEvidence, inputs, now, inputs.maxEvidenceAgeMs),
  ];
  if (metadataChecks.some((item) => item.status === "FAIL")) {
    throw new UatError("SYSTEM_PREFLIGHT_BLOCKED", "Unauthenticated DEV metadata preflight failed before user-scoped reads");
  }
  const runtimeA = await fetchRuntime(inputs, client, "A", inputs.DEV_TEST_SUBSCRIPTION_A_ID, inputs.DEV_TEST_AUTH_A);
  const runtimeB = await fetchRuntime(inputs, client, "B", inputs.DEV_TEST_SUBSCRIPTION_B_ID, inputs.DEV_TEST_AUTH_B);
  const runtimeControl = await fetchRuntime(inputs, client, "CONTROL", inputs.DEV_CONTROL_SUBSCRIPTION_ID, inputs.DEV_CONTROL_AUTH);
  return evaluatePreflight({ inputs, lkRelease, cupRelease, systemEvidence, runtimeA, runtimeB, runtimeControl, now });
}

function subjectBindings(inputs) {
  const bind = (role, clientSubscriptionId, subscriptionInstanceId) => ({
    clientSubscriptionHmac: evidenceHmac({ role, kind: "client-subscription", value: clientSubscriptionId }, inputs.DEV_CUP_INTEGRATION_TOKEN),
    subscriptionInstanceHmac: evidenceHmac({ role, kind: "subscription-instance", value: subscriptionInstanceId }, inputs.DEV_CUP_INTEGRATION_TOKEN),
  });
  return {
    A: bind("A", inputs.DEV_TEST_SUBSCRIPTION_A_ID, inputs.DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID),
    B: bind("B", inputs.DEV_TEST_SUBSCRIPTION_B_ID, inputs.DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID),
    CONTROL: bind("CONTROL", inputs.DEV_CONTROL_SUBSCRIPTION_ID, inputs.DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID),
  };
}

function observationBindingChecks(subjects, preflight) {
  return ["A", "B"].map((subject) => {
    const observation = subjects[subject];
    const selected = preflight.subjects?.[subject]?.selectedPolicy;
    const matches = Boolean(observation && selected)
      && versionMatches(observation.selectedPolicyVersion, selected.version)
      && observation.selectedPolicyDigest === selected.policyDigest;
    return check(`OBSERVATION_POLICY_PIN_${subject}`, matches, "OBSERVATION_POLICY_PIN_MISMATCH");
  });
}

function assertBeforeBinding(inputs, before, now, targets) {
  const generatedAt = finiteDate(before?.generatedAt);
  const age = generatedAt ? now.getTime() - generatedAt.getTime() : Number.POSITIVE_INFINITY;
  const bindings = subjectBindings(inputs);
  if (before?.schemaVersion !== 1 || before?.mode !== "observe-before" || before?.status !== "READY"
    || before?.runId !== inputs.DEV_UAT_RUN_ID
    || !hasCompleteSetupNoWriteProof(before) || before?.noWrites !== false
    || !generatedAt || age < -5_000 || age > inputs.beforeMaxAgeMs) {
    throw new UatError("BEFORE_SNAPSHOT_STALE_OR_INVALID", "The before snapshot is invalid or stale");
  }
  if (before.context?.origins?.lk !== targets.lk.origin || before.context?.origins?.cup !== targets.cup.origin
    || JSON.stringify(before.context?.subjectBindings) !== JSON.stringify(bindings)
    || before.subjects?.A?.correlationScope !== `subscription-sale-period:${inputs.DEV_UAT_RUN_ID}:A`
    || before.subjects?.B?.correlationScope !== `subscription-sale-period:${inputs.DEV_UAT_RUN_ID}:B`) {
    throw new UatError("BEFORE_SNAPSHOT_CONTEXT_MISMATCH", "The before snapshot belongs to another target or subscription pair");
  }
}

function beforeContinuityChecks(before, current) {
  const checks = [
    check("LK_RELEASE_UNCHANGED", JSON.stringify(before.context?.releaseBindings?.lk) === JSON.stringify(current.releaseBindings?.lk), "LK_RELEASE_CHANGED_SINCE_BEFORE"),
    check("CUP_RELEASE_UNCHANGED", JSON.stringify(before.context?.releaseBindings?.cup) === JSON.stringify(current.releaseBindings?.cup), "CUP_RELEASE_CHANGED_SINCE_BEFORE"),
  ];
  for (const subject of ["A", "B"]) {
    const oldPolicy = before.context?.selectedPolicies?.[subject];
    const newPolicy = current.subjects?.[subject]?.selectedPolicy;
    checks.push(check(
      `PREFLIGHT_POLICY_CONTINUITY_${subject}`,
      Boolean(oldPolicy && newPolicy) && versionMatches(oldPolicy.version, newPolicy.version)
        && oldPolicy.policyDigest === newPolicy.policyDigest,
      "PREFLIGHT_POLICY_CHANGED_SINCE_BEFORE",
    ));
  }
  return checks;
}

async function fetchObservation(inputs, client, subject, id, auth, runId) {
  const correlationScope = `subscription-sale-period:${runId}:${subject}`;
  const payload = await client.json({
    baseUrl: inputs.DEV_CUP_BASE_URL,
    endpointPath: inputs.endpoints.observability,
    method: "POST",
    auth,
    integrationToken: inputs.DEV_CUP_INTEGRATION_TOKEN,
    body: { clientSubscriptionId: id, correlationScope },
    cacheKey: `observation:${runId}:${subject}:${id}`,
  });
  const instanceId = subject === "A" ? inputs.DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID : inputs.DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID;
  return normalizeObservation(payload, id, instanceId, correlationScope, inputs.DEV_CUP_INTEGRATION_TOKEN);
}

export async function executeMode({ mode, inputs, client = new ReadOnlyHttpClient({ timeoutMs: inputs.timeoutMs }), now = new Date() }) {
  if (!MODES.has(mode)) throw new UatError("MODE_INVALID", `Unsupported mode: ${mode}`);
  const targets = assertDevTargets(inputs);
  if (mode === "preflight") {
    const report = await collectPreflight(inputs, client, now);
    return writeEvidence({ inputs, report: { ...report, generatedAt: now.toISOString() }, runId: safeTimestamp(now), integrityKey: inputs.DEV_CUP_INTEGRATION_TOKEN });
  }
  if (mode === "observe-before") {
    const runId = safeTimestamp(now);
    const preflight = await collectPreflight(inputs, client, now);
    if (preflight.status !== "READY") {
      return writeEvidence({
        inputs,
        report: { ...preflight, mode, runId, status: "BLOCKED", generatedAt: now.toISOString() },
        runId,
        basename: "before",
        integrityKey: inputs.DEV_CUP_INTEGRATION_TOKEN,
      });
    }
    const subjects = {
      A: await fetchObservation(inputs, client, "A", inputs.DEV_TEST_SUBSCRIPTION_A_ID, inputs.DEV_TEST_AUTH_A, runId),
      B: await fetchObservation(inputs, client, "B", inputs.DEV_TEST_SUBSCRIPTION_B_ID, inputs.DEV_TEST_AUTH_B, runId),
    };
    const checks = [
      ...preflight.checks,
      ...observationBindingChecks(subjects, preflight),
      ...["A", "B"].flatMap((subject) => {
        const row = subjects[subject];
        const scopedCountersEmpty = [
          "operations", "ledgerEntries", "outboxEntries", ...END_TO_END_MUTATION_METRICS,
          "orphanReserves", "fallbackCounter", "productionCupCalls", "unrelatedUserChanges",
        ].every((metric) => row.metrics[metric] === 0);
        return [
          check(`CORRELATION_SCOPE_EMPTY_BEFORE_${subject}`, row.logicalResults.length === 0, "CORRELATION_SCOPE_NOT_EMPTY_BEFORE"),
          check(`CORRELATION_COUNTERS_ZERO_BEFORE_${subject}`, scopedCountersEmpty, "CORRELATION_COUNTERS_NOT_ZERO_BEFORE"),
        ];
      }),
    ];
    return writeEvidence({
      inputs,
      report: {
        schemaVersion: 1,
        mode,
        runId,
        status: checks.every((item) => item.status !== "FAIL") ? "READY" : "BLOCKED",
        setupNoWrites: preflight.setupNoWrites,
        noWrites: false,
        writeSafety: preflight.writeSafety,
        generatedAt: now.toISOString(),
        checks,
        context: {
          origins: preflight.origins,
          releaseBindings: preflight.releaseBindings,
          selectedPolicies: { A: preflight.subjects.A.selectedPolicy, B: preflight.subjects.B.selectedPolicy },
          subjectBindings: subjectBindings(inputs),
        },
        subjects,
      },
      runId,
      basename: "before",
      integrityKey: inputs.DEV_CUP_INTEGRATION_TOKEN,
    });
  }

  if (!text(inputs.DEV_UAT_RUN_ID)) throw new UatError("RUN_ID_REQUIRED", "DEV_UAT_RUN_ID is required for observe-after");
  if (!isObject(inputs.DEV_UAT_EXPECTED_DELTA)) throw new UatError("EXPECTED_DELTA_REQUIRED", "DEV_UAT_EXPECTED_DELTA_JSON is required for observe-after");
  const before = readBeforeEvidence(inputs);
  assertBeforeBinding(inputs, before, now, targets);
  const currentPreflight = await collectPreflight(inputs, client, now);
  const continuityChecks = beforeContinuityChecks(before, currentPreflight);
  if (currentPreflight.status !== "READY" || continuityChecks.some((item) => item.status === "FAIL")) {
    return writeEvidence({
      inputs,
      report: {
        schemaVersion: 1,
        mode,
        runId: inputs.DEV_UAT_RUN_ID,
        status: "FAIL",
        setupNoWrites: currentPreflight.setupNoWrites,
        noWrites: false,
        writeSafety: currentPreflight.writeSafety,
        generatedAt: now.toISOString(),
        checks: [...currentPreflight.checks, ...continuityChecks],
      },
      runId: inputs.DEV_UAT_RUN_ID,
      integrityKey: inputs.DEV_CUP_INTEGRATION_TOKEN,
    });
  }
  const after = {
    subjects: {
      A: await fetchObservation(inputs, client, "A", inputs.DEV_TEST_SUBSCRIPTION_A_ID, inputs.DEV_TEST_AUTH_A, inputs.DEV_UAT_RUN_ID),
      B: await fetchObservation(inputs, client, "B", inputs.DEV_TEST_SUBSCRIPTION_B_ID, inputs.DEV_TEST_AUTH_B, inputs.DEV_UAT_RUN_ID),
    },
  };
  const reconciliation = reconcileObservations(before, after, inputs.DEV_UAT_EXPECTED_DELTA);
  const mutationEvidence = evaluateEndToEndMutationEvidence(before, after, inputs.DEV_UAT_RUN_ID);
  const checks = [
    ...currentPreflight.checks,
    ...continuityChecks,
    ...observationBindingChecks(after.subjects, currentPreflight),
    ...reconciliation.checks,
  ];
  const ok = currentPreflight.status === "READY" && checks.every((item) => item.status !== "FAIL");
  return writeEvidence({
    inputs,
    report: {
      schemaVersion: 1,
      mode,
      runId: inputs.DEV_UAT_RUN_ID,
      status: ok ? "PASS" : "FAIL",
      setupNoWrites: currentPreflight.setupNoWrites,
      noWrites: currentPreflight.setupNoWrites && mutationEvidence.noWritesProven,
      writeSafety: currentPreflight.writeSafety,
      endToEndMutationEvidence: mutationEvidence,
      generatedAt: now.toISOString(),
      checks,
      context: {
        origins: currentPreflight.origins,
        releaseBindings: currentPreflight.releaseBindings,
        subjectBindings: subjectBindings(inputs),
        beforeIntegrityHmac: before.integrityHmac,
      },
      subjects: after.subjects,
    },
    runId: inputs.DEV_UAT_RUN_ID,
    integrityKey: inputs.DEV_CUP_INTEGRATION_TOKEN,
  });
}

export function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--mode" || !MODES.has(argv[1])) {
    throw new UatError("CLI_INVALID", "Usage: run.mjs --mode preflight|observe-before|observe-after; secrets and identifiers are forbidden in argv");
  }
  return { mode: argv[1] };
}
