import crypto from "node:crypto";

export const PARTNER_API_VERSION = "PADLHUB-PARTNER-GAME-V1";
export const PARTNER_API_BASE_PATH = "/lk/integrations/v1";
export const PARTNER_API_DEFAULT_MAX_SKEW_SECONDS = 90;
export const PARTNER_API_NONCE_TTL_SECONDS = 86_400;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE_PATTERN = /^v1=([A-Za-z0-9_-]{43})$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class PartnerApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PartnerApiError";
    this.code = code;
    this.httpStatus = Number(options.httpStatus || 500);
    this.expose = options.expose !== false;
    this.terminal = options.terminal !== false;
    this.details = options.details || null;
  }
}

export class PartnerProviderError extends PartnerApiError {
  constructor(code, message, options = {}) {
    super(code, message, {
      httpStatus: options.ambiguous ? 202 : (options.httpStatus || 502),
      terminal: !options.ambiguous,
      expose: false,
      ...options,
    });
    this.ambiguous = options.ambiguous === true;
  }
}

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
);

const hasControlCharacter = (value) => [...String(value || "")].some((character) => {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
});

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new PartnerApiError("INVALID_JSON_NUMBER", "Only safe integer JSON numbers are accepted", { httpStatus: 400 });
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) {
    throw new PartnerApiError("INVALID_JSON_VALUE", "Request body contains an unsupported JSON value", { httpStatus: 400 });
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hmacBase64Url = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("base64url");

const canonicalHeaderValue = (headers, name, strict = false) => {
  const matches = Object.entries(headers || {}).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  const raw = Array.isArray(matches[0]?.[1]) ? matches[0][1][0] : matches[0]?.[1];
  const invalidMultiplicity = matches.length !== 1
    || (Array.isArray(matches[0]?.[1]) && matches[0][1].length !== 1);
  const value = typeof raw === "string" ? raw.trim() : "";
  if (strict && (invalidMultiplicity || !value || value.includes(",") || hasControlCharacter(value))) {
    throw new PartnerApiError("AMBIGUOUS_AUTH_HEADER", `${name} must occur exactly once`, { httpStatus: 400 });
  }
  return hasControlCharacter(value) ? "" : value;
};

const assertToken = (value, field) => {
  if (!TOKEN_PATTERN.test(value)) {
    throw new PartnerApiError("INVALID_AUTH_HEADER", `${field} is missing or invalid`, { httpStatus: 401 });
  }
  return value;
};

const normalizePath = (rawPath) => {
  let parsed;
  try {
    parsed = new URL(String(rawPath || ""), "https://partner.invalid");
  } catch {
    throw new PartnerApiError("INVALID_REQUEST_PATH", "Request path is invalid", { httpStatus: 400 });
  }
  if (parsed.search || parsed.hash || !parsed.pathname.startsWith(`${PARTNER_API_BASE_PATH}/`)) {
    throw new PartnerApiError("INVALID_REQUEST_PATH", "Signed API requests must not contain query or fragment data", { httpStatus: 400 });
  }
  return parsed.pathname;
};

export function buildPartnerSignatureInput(input) {
  const method = String(input.method || "").trim().toUpperCase();
  const path = normalizePath(input.path);
  const clientId = assertToken(String(input.clientId || "").trim(), "client id");
  const keyId = assertToken(String(input.keyId || "").trim(), "key id");
  const timestamp = String(input.timestamp || "").trim();
  const nonce = String(input.nonce || "").trim();
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  const correlationId = String(input.correlationId || "").trim();
  const bodyHash = input.bodyHash || sha256Hex(canonicalJson(input.body ?? {}));
  return [
    PARTNER_API_VERSION,
    clientId,
    keyId,
    timestamp,
    nonce,
    method,
    path,
    bodyHash,
    idempotencyKey,
    correlationId,
  ].join("\n");
}

export function signPartnerRequest(input, secret) {
  return `v1=${hmacBase64Url(secret, buildPartnerSignatureInput(input))}`;
}

const requestIdentityFromHeaders = (request, strict = false) => ({
  clientId: canonicalHeaderValue(request.headers, "x-padlhub-client-id", strict),
  keyId: canonicalHeaderValue(request.headers, "x-padlhub-key-id", strict),
  timestamp: canonicalHeaderValue(request.headers, "x-padlhub-timestamp", strict),
  nonce: canonicalHeaderValue(request.headers, "x-padlhub-nonce", strict),
  signature: canonicalHeaderValue(request.headers, "x-padlhub-signature", strict),
  idempotencyKey: canonicalHeaderValue(request.headers, "idempotency-key", strict),
  correlationId: canonicalHeaderValue(request.headers, "x-correlation-id", strict),
});

const decodePathToken = (value, field, pattern = TOKEN_PATTERN) => {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch {
    throw new PartnerApiError("INVALID_REQUEST_PATH", `${field} path parameter is invalid`, { httpStatus: 400 });
  }
  if (!pattern.test(decoded)) {
    throw new PartnerApiError("INVALID_REQUEST_PATH", `${field} path parameter is invalid`, { httpStatus: 400 });
  }
  return decoded;
};

export function parsePartnerRoute(methodRaw, pathRaw) {
  const method = String(methodRaw || "").trim().toUpperCase();
  const path = normalizePath(pathRaw);
  let match = path.match(/^\/lk\/integrations\/v1\/open-games\/([^/]+)\/members$/);
  if (match && method === "POST") {
    return { action: "ADD_MEMBER", requiredScope: "members:add", gameId: decodePathToken(match[1], "gameId") };
  }
  match = path.match(/^\/lk\/integrations\/v1\/open-games\/([^/]+)\/members\/([^/]+)$/);
  if (match && method === "DELETE") {
    return {
      action: "REMOVE_MEMBER",
      requiredScope: "members:remove",
      gameId: decodePathToken(match[1], "gameId"),
      membershipId: decodePathToken(match[2], "membershipId", UUID_PATTERN),
    };
  }
  match = path.match(/^\/lk\/integrations\/v1\/operations\/([^/]+)$/);
  if (match && method === "GET") {
    return { action: "READ_OPERATION", requiredScope: "operations:read", operationId: decodePathToken(match[1], "operationId", UUID_PATTERN) };
  }
  throw new PartnerApiError("ROUTE_NOT_FOUND", "Integration route not found", { httpStatus: 404 });
}

const assertExactKeys = (value, allowed, field) => {
  if (!isPlainObject(value)) {
    throw new PartnerApiError("INVALID_REQUEST_BODY", `${field} must be a JSON object`, { httpStatus: 400 });
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new PartnerApiError("UNKNOWN_REQUEST_FIELD", `${field} contains unsupported fields`, {
      httpStatus: 400,
      details: { fields: unexpected.sort() },
    });
  }
};

export function validateAddMemberBody(body) {
  assertExactKeys(body, ["externalPlayerId", "displayName", "payment"], "body");
  assertExactKeys(body.payment, ["reference", "paidAt", "amountMinor", "currency"], "body.payment");
  const externalPlayerId = String(body.externalPlayerId || "").trim();
  const displayName = String(body.displayName || "").trim();
  const reference = String(body.payment.reference || "").trim();
  const paidAt = String(body.payment.paidAt || "").trim();
  const currency = String(body.payment.currency || "").trim().toUpperCase();
  const amountMinor = body.payment.amountMinor;
  if (!EXTERNAL_ID_PATTERN.test(externalPlayerId)) {
    throw new PartnerApiError("INVALID_EXTERNAL_PLAYER_ID", "externalPlayerId is invalid", { httpStatus: 400 });
  }
  if (displayName.length < 1 || displayName.length > 120 || hasControlCharacter(displayName)) {
    throw new PartnerApiError("INVALID_DISPLAY_NAME", "displayName is invalid", { httpStatus: 400 });
  }
  if (!EXTERNAL_ID_PATTERN.test(reference)) {
    throw new PartnerApiError("INVALID_PAYMENT_REFERENCE", "payment.reference is invalid", { httpStatus: 400 });
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > 100_000_000) {
    throw new PartnerApiError("INVALID_PAYMENT_AMOUNT", "payment.amountMinor is invalid", { httpStatus: 400 });
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new PartnerApiError("INVALID_PAYMENT_CURRENCY", "payment.currency is invalid", { httpStatus: 400 });
  }
  const paidAtDate = new Date(paidAt);
  if (!paidAt || Number.isNaN(paidAtDate.getTime()) || paidAtDate.toISOString() !== paidAt) {
    throw new PartnerApiError("INVALID_PAYMENT_TIME", "payment.paidAt must be a canonical UTC ISO timestamp", { httpStatus: 400 });
  }
  return {
    externalPlayerId,
    displayName,
    payment: { reference, paidAt, amountMinor, currency },
  };
}

export async function verifyPartnerRequestProof(request, options) {
  const identity = requestIdentityFromHeaders(request, true);
  const method = String(request.method || "").trim().toUpperCase();
  const path = normalizePath(request.path);
  const body = request.body ?? {};
  assertToken(identity.clientId, "client id");
  assertToken(identity.keyId, "key id");
  if (!/^\d{10}$/.test(identity.timestamp)) {
    throw new PartnerApiError("INVALID_TIMESTAMP", "Request timestamp is invalid", { httpStatus: 401 });
  }
  if (!NONCE_PATTERN.test(identity.nonce)) {
    throw new PartnerApiError("INVALID_NONCE", "Request nonce is invalid", { httpStatus: 401 });
  }
  if (!UUID_PATTERN.test(identity.idempotencyKey)) {
    throw new PartnerApiError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be a lowercase UUID", { httpStatus: 400 });
  }
  if (!UUID_PATTERN.test(identity.correlationId)) {
    throw new PartnerApiError("INVALID_CORRELATION_ID", "X-Correlation-ID must be a lowercase UUID", { httpStatus: 400 });
  }
  const signatureMatch = identity.signature.match(SIGNATURE_PATTERN);
  if (!signatureMatch) {
    throw new PartnerApiError("INVALID_SIGNATURE", "Request signature is invalid", { httpStatus: 401 });
  }
  const nowMs = Number(options.nowMs ?? Date.now());
  const timestampMs = Number(identity.timestamp) * 1000;
  const maxSkewMs = Number(options.maxSkewSeconds || PARTNER_API_DEFAULT_MAX_SKEW_SECONDS) * 1000;
  if (!Number.isFinite(nowMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
    throw new PartnerApiError("REQUEST_EXPIRED", "Request timestamp is outside the accepted window", { httpStatus: 401 });
  }

  const credential = await options.keyResolver(identity.clientId, identity.keyId);
  if (!credential || credential.enabled !== true) {
    throw new PartnerApiError("CLIENT_DISABLED", "Integration client or key is disabled", { httpStatus: 403 });
  }
  const secret = Buffer.isBuffer(credential.secret)
    ? credential.secret
    : Buffer.from(String(credential.secret || ""), "base64url");
  if (secret.length < 32) {
    throw new PartnerApiError("KEY_CONFIGURATION_INVALID", "Integration key configuration is invalid", { httpStatus: 503, expose: false });
  }
  const bodyHash = sha256Hex(canonicalJson(body));
  const signatureInput = buildPartnerSignatureInput({
    method,
    path,
    bodyHash,
    ...identity,
  });
  const expected = Buffer.from(hmacBase64Url(secret, signatureInput));
  const received = Buffer.from(signatureMatch[1]);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    throw new PartnerApiError("INVALID_SIGNATURE", "Request signature is invalid", { httpStatus: 401 });
  }

  await options.nonceStore.consumeNonce({
    clientId: identity.clientId,
    keyId: identity.keyId,
    nonce: identity.nonce,
    timestamp: identity.timestamp,
    correlationId: identity.correlationId,
    expiresAt: new Date(timestampMs + PARTNER_API_NONCE_TTL_SECONDS * 1000),
  });

  return {
    ...identity,
    method,
    path,
    bodyHash,
    proofHash: sha256Hex(signatureInput),
    requestHash: sha256Hex([
      PARTNER_API_VERSION,
      identity.clientId,
      method,
      path,
      bodyHash,
    ].join("\n")),
    scopes: Array.isArray(credential.scopes) ? [...credential.scopes] : [],
    stationIds: Array.isArray(credential.stationIds) ? [...credential.stationIds] : [],
  };
}

const safeIdHash = (auditKey, value) => (
  value ? hmacBase64Url(auditKey, String(value)) : null
);

const safeAuditToken = (value, pattern) => {
  const text = String(value || "").trim();
  return pattern.test(text) ? text : null;
};

const publicOperation = (operation) => ({
  operationId: operation.operationId,
  action: operation.action,
  state: operation.state,
  gameId: operation.gameId || null,
  membershipId: operation.membershipId || null,
  createdAt: operation.createdAt,
  updatedAt: operation.updatedAt,
  error: operation.publicError || null,
});

export class PartnerGameMembershipApiService {
  constructor(options) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.keyResolver = options.keyResolver;
    this.technicalVivaClientId = String(options.technicalVivaClientId || "").trim();
    this.auditKey = Buffer.isBuffer(options.auditKey)
      ? options.auditKey
      : Buffer.from(String(options.auditKey || ""), "base64url");
    this.now = options.now || (() => new Date());
    this.maxSkewSeconds = options.maxSkewSeconds || PARTNER_API_DEFAULT_MAX_SKEW_SECONDS;
    if (this.auditKey.length < 32) throw new Error("Partner API audit HMAC key must contain at least 32 bytes");
  }

  async auditIngress(request, auth, outcome, code) {
    const headers = requestIdentityFromHeaders(request);
    const bodyHash = (() => {
      try { return safeIdHash(this.auditKey, canonicalJson(request.body ?? {})); } catch { return null; }
    })();
    const entry = {
      type: "PARTNER_API_INGRESS",
      at: this.now(),
      method: String(request.method || "").toUpperCase().slice(0, 16),
      path: (() => { try { return normalizePath(request.path).slice(0, 512); } catch { return "INVALID"; } })(),
      clientId: safeAuditToken(auth?.clientId || headers.clientId, TOKEN_PATTERN),
      keyId: safeAuditToken(auth?.keyId || headers.keyId, TOKEN_PATTERN),
      correlationId: safeAuditToken(auth?.correlationId || headers.correlationId, UUID_PATTERN),
      idempotencyKey: safeAuditToken(auth?.idempotencyKey || headers.idempotencyKey, UUID_PATTERN),
      nonceHash: safeIdHash(this.auditKey, headers.nonce),
      remoteAddressHash: safeIdHash(this.auditKey, request.remoteAddress),
      bodyHash,
      outcome,
      code,
    };
    try {
      await this.repository.appendAudit(entry);
    } catch (error) {
      throw new PartnerApiError("AUDIT_UNAVAILABLE", "Durable request audit is unavailable", {
        httpStatus: 503,
        expose: false,
        terminal: false,
        details: { cause: String(error?.message || error) },
      });
    }
  }

  async handle(request) {
    let auth;
    try {
      auth = await verifyPartnerRequestProof(request, {
        keyResolver: this.keyResolver,
        nonceStore: this.repository,
        nowMs: this.now().getTime(),
        maxSkewSeconds: this.maxSkewSeconds,
      });
    } catch (error) {
      try {
        await this.auditIngress(request, null, "REJECTED", error?.code || "AUTH_FAILED");
      } catch (auditError) {
        if (error instanceof PartnerApiError && error.httpStatus < 500) throw error;
        throw auditError;
      }
      throw error;
    }
    let route;
    try {
      route = parsePartnerRoute(auth.method, auth.path);
    } catch (error) {
      await this.auditIngress(request, auth, "REJECTED", error?.code || "ROUTE_NOT_FOUND");
      throw error;
    }
    if (!auth.scopes.includes(route.requiredScope)) {
      await this.auditIngress(request, auth, "REJECTED", "SCOPE_DENIED");
      throw new PartnerApiError("SCOPE_DENIED", "Integration client lacks the required scope", { httpStatus: 403 });
    }
    if (route.action === "READ_OPERATION") {
      await this.auditIngress(request, auth, "ACCEPTED", "SIGNATURE_VERIFIED");
      return this.readOperation(auth, route);
    }
    if (!this.technicalVivaClientId) {
      await this.auditIngress(request, auth, "REJECTED", "VIVA_TECHNICAL_CLIENT_NOT_CONFIGURED");
      throw new PartnerApiError("VIVA_TECHNICAL_CLIENT_NOT_CONFIGURED", "Viva technical client is not configured", {
        httpStatus: 503,
        expose: false,
      });
    }
    try {
      if (typeof this.provider?.assertReady !== "function") {
        throw new PartnerProviderError("VIVA_RUNTIME_NOT_CONFIGURED", "Viva provider readiness contract is missing", {
          ambiguous: false,
          httpStatus: 503,
          expose: false,
          terminal: false,
        });
      }
      await this.provider.assertReady({ action: route.action });
    } catch (error) {
      await this.auditIngress(request, auth, "REJECTED", error?.code || "VIVA_RUNTIME_NOT_CONFIGURED");
      throw error;
    }
    await this.auditIngress(request, auth, "ACCEPTED", "SIGNATURE_VERIFIED");
    if (route.action === "ADD_MEMBER") return this.addMember(request.body, auth, route);
    return this.removeMember(request.body, auth, route);
  }

  async beginOperation(auth, route, body) {
    const operation = await this.repository.beginOperation({
      operationId: crypto.randomUUID(),
      clientId: auth.clientId,
      keyId: auth.keyId,
      idempotencyKey: auth.idempotencyKey,
      correlationId: auth.correlationId,
      requestHash: auth.requestHash,
      action: route.action,
      gameId: route.gameId || null,
      membershipId: route.membershipId || null,
      requestBody: body,
      createdAt: this.now(),
    });
    if (operation.requestHash !== auth.requestHash) {
      throw new PartnerApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another request", { httpStatus: 409 });
    }
    return operation;
  }

  async addMember(rawBody, auth, route) {
    const body = validateAddMemberBody(rawBody);
    const operation = await this.beginOperation(auth, route, body);
    if (operation.state === "COMPLETED") return { statusCode: 200, body: operation.response };
    if (operation.state === "UNKNOWN") return { statusCode: 202, body: { operation: publicOperation(operation) } };
    if (operation.replayed === true) return { statusCode: 202, body: { operation: publicOperation(operation) } };
    if (operation.state !== "RECEIVED") {
      return { statusCode: 202, body: { operation: publicOperation(operation) } };
    }
    try {
      const reservation = await this.repository.reserveAdd({
        operationId: operation.operationId,
        clientId: auth.clientId,
        gameId: route.gameId,
        externalPlayerId: body.externalPlayerId,
        displayName: body.displayName,
        payment: body.payment,
        allowedStationIds: auth.stationIds,
        now: this.now(),
      });
      let providerResult;
      try {
        providerResult = await this.provider.addTechnicalUser({
          operationId: operation.operationId,
          idempotencyKey: auth.idempotencyKey,
          gameId: route.gameId,
          exerciseId: reservation.exerciseId,
          technicalVivaClientId: this.technicalVivaClientId,
        });
      } catch (error) {
        if (error instanceof PartnerProviderError) throw error;
        throw new PartnerProviderError("VIVA_ADD_OUTCOME_UNKNOWN", "Viva add outcome is ambiguous", { ambiguous: true });
      }
      try {
        const booking = await this.provider.readBooking({
          operationId: operation.operationId,
          exerciseId: reservation.exerciseId,
          bookingId: providerResult.bookingId,
          technicalVivaClientId: this.technicalVivaClientId,
        });
        if (!booking?.active
          || booking.bookingId !== providerResult.bookingId
          || booking.exerciseId !== reservation.exerciseId
          || booking.clientId !== this.technicalVivaClientId) {
          throw new PartnerProviderError("VIVA_ADD_READBACK_MISMATCH", "Viva add read-back is ambiguous", { ambiguous: true });
        }
        const completed = await this.repository.completeAdd({
          operationId: operation.operationId,
          membershipId: reservation.membershipId,
          bookingId: booking.bookingId,
          technicalVivaClientId: this.technicalVivaClientId,
          now: this.now(),
        });
        return { statusCode: 201, body: completed.response };
      } catch (error) {
        if (error instanceof PartnerProviderError && error.ambiguous) throw error;
        throw new PartnerProviderError("LOCAL_COMMIT_AFTER_VIVA_ADD_UNKNOWN", "Local commit after Viva add is ambiguous", { ambiguous: true });
      }
    } catch (error) {
      return this.handleMutationError(operation, error);
    }
  }

  async removeMember(rawBody, auth, route) {
    assertExactKeys(rawBody ?? {}, [], "body");
    const operation = await this.beginOperation(auth, route, {});
    if (operation.state === "COMPLETED") return { statusCode: 200, body: operation.response };
    if (operation.state === "UNKNOWN") return { statusCode: 202, body: { operation: publicOperation(operation) } };
    if (operation.replayed === true) return { statusCode: 202, body: { operation: publicOperation(operation) } };
    if (operation.state !== "RECEIVED") return { statusCode: 202, body: { operation: publicOperation(operation) } };
    try {
      const owned = await this.repository.prepareRemove({
        operationId: operation.operationId,
        clientId: auth.clientId,
        gameId: route.gameId,
        membershipId: route.membershipId,
        allowedStationIds: auth.stationIds,
        now: this.now(),
      });
      try {
        await this.provider.removeTechnicalUser({
          operationId: operation.operationId,
          idempotencyKey: auth.idempotencyKey,
          exerciseId: owned.exerciseId,
          bookingId: owned.bookingId,
          technicalVivaClientId: owned.technicalVivaClientId,
        });
      } catch (error) {
        if (error instanceof PartnerProviderError) throw error;
        throw new PartnerProviderError("VIVA_REMOVE_OUTCOME_UNKNOWN", "Viva removal outcome is ambiguous", { ambiguous: true });
      }
      try {
        const booking = await this.provider.readBooking({
          operationId: operation.operationId,
          exerciseId: owned.exerciseId,
          bookingId: owned.bookingId,
          technicalVivaClientId: owned.technicalVivaClientId,
          includeCancelled: true,
        });
        if (booking?.active
          || booking?.bookingId !== owned.bookingId
          || booking?.exerciseId !== owned.exerciseId
          || booking?.clientId !== owned.technicalVivaClientId) {
          throw new PartnerProviderError("VIVA_REMOVE_READBACK_MISMATCH", "Viva removal read-back is ambiguous", { ambiguous: true });
        }
        const completed = await this.repository.completeRemove({
          operationId: operation.operationId,
          membershipId: owned.membershipId,
          bookingId: owned.bookingId,
          now: this.now(),
        });
        return { statusCode: 200, body: completed.response };
      } catch (error) {
        if (error instanceof PartnerProviderError && error.ambiguous) throw error;
        throw new PartnerProviderError("LOCAL_COMMIT_AFTER_VIVA_REMOVE_UNKNOWN", "Local commit after Viva removal is ambiguous", { ambiguous: true });
      }
    } catch (error) {
      return this.handleMutationError(operation, error);
    }
  }

  async handleMutationError(operation, error) {
    if (error instanceof PartnerProviderError && error.ambiguous) {
      const unknown = await this.repository.markUnknown({
        operationId: operation.operationId,
        code: error.code,
        now: this.now(),
      });
      return { statusCode: 202, body: { operation: publicOperation(unknown) } };
    }
    await this.repository.failOperation({
      operationId: operation.operationId,
      code: error?.code || "MUTATION_FAILED",
      now: this.now(),
    });
    throw error;
  }

  async readOperation(auth, route) {
    const operation = await this.repository.readOperation({
      operationId: route.operationId,
      clientId: auth.clientId,
    });
    if (!operation) throw new PartnerApiError("OPERATION_NOT_FOUND", "Operation not found", { httpStatus: 404 });
    return { statusCode: 200, body: { operation: publicOperation(operation) } };
  }
}

export class DisabledVivaProvider {
  async assertReady() {
    throw new PartnerProviderError("VIVA_RUNTIME_NOT_CONFIGURED", "Real Viva mutations are disabled", {
      ambiguous: false,
      httpStatus: 503,
      expose: false,
      terminal: false,
    });
  }

  async addTechnicalUser() {
    return this.assertReady();
  }

  async removeTechnicalUser() { return this.addTechnicalUser(); }
  async readBooking() { return this.addTechnicalUser(); }
}

export class SyntheticVivaProvider {
  constructor() { this.bookings = new Map(); }

  async assertReady() { return true; }

  async addTechnicalUser(input) {
    const bookingId = `synthetic_${sha256Hex(`${input.operationId}:${input.exerciseId}`).slice(0, 24)}`;
    this.bookings.set(bookingId, {
      bookingId,
      exerciseId: input.exerciseId,
      clientId: input.technicalVivaClientId,
      active: true,
    });
    return { bookingId };
  }

  async removeTechnicalUser(input) {
    const booking = this.bookings.get(input.bookingId);
    if (booking) this.bookings.set(input.bookingId, { ...booking, active: false });
    return { bookingId: input.bookingId };
  }

  async readBooking(input) {
    return this.bookings.get(input.bookingId) || {
      bookingId: input.bookingId,
      exerciseId: input.exerciseId,
      clientId: input.technicalVivaClientId,
      active: false,
    };
  }
}
