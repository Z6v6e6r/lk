import { PartnerProviderError } from "./partner-game-membership-core.mjs";
import { isDeepStrictEqual } from "node:util";

export const PARTNER_VIVA_ADMIN_API_BASE = "https://api.vivacrm.ru/api/v1";
export const PARTNER_VIVA_CONTRACT_REVISION = "padlhub-viva-technical-booking-v1";
export const PARTNER_VIVA_PAYMENT_TYPE = "ON_PLACE";

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,8192}$/;
const TERMINAL_BOOKING_STATES = new Set([
  "CANCELLED",
  "CANCELED",
  "DELETED",
  "REMOVED",
]);
const ACTIVE_BOOKING_STATES = new Set([
  "ACTIVE",
  "BOOKED",
  "CONFIRMED",
  "PAID",
  "PAYMENT_PENDING",
]);

const toText = (value) => (value === null || value === undefined ? "" : String(value).trim());
const asObject = (value) => (
  value && typeof value === "object" && !Array.isArray(value) ? value : null
);
const rowsFromPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  const object = asObject(payload);
  if (!object) return [];
  const containers = ["content", "items", "bookings", "data", "results"]
    .filter((key) => Array.isArray(object[key]))
    .map((key) => ({ key, rows: object[key] }));
  if (!containers.length) return [];
  if (containers.slice(1).some(({ rows }) => !isDeepStrictEqual(rows, containers[0].rows))) {
    throw providerError(
      "VIVA_READBACK_AMBIGUOUS",
      "Viva booking collection aliases conflict",
      { ambiguous: true },
    );
  }
  return containers[0].rows;
};

const providerError = (code, message, options = {}) => {
  const normalized = {
    ambiguous: options.ambiguous === true,
    expose: options.expose === true,
  };
  if (!normalized.ambiguous || options.httpStatus !== undefined) {
    normalized.httpStatus = options.httpStatus || 503;
  }
  if (options.terminal !== undefined) normalized.terminal = options.terminal === true;
  return new PartnerProviderError(code, message, normalized);
};

const exactAlias = (values, label) => {
  const normalized = values.map(toText).filter(Boolean);
  const unique = [...new Set(normalized)];
  if (unique.length > 1) {
    throw providerError(
      "VIVA_READBACK_AMBIGUOUS",
      `Viva booking ${label} aliases conflict`,
      { ambiguous: true },
    );
  }
  return unique[0] || "";
};

const isCompletePage = (payload, rows) => {
  const object = asObject(payload);
  if (!object) return false;
  if (object.last === true) return true;
  const pageNumber = Number(object.number ?? object.page ?? object.pageNumber);
  const totalPages = Number(object.totalPages);
  if (Number.isSafeInteger(pageNumber) && Number.isSafeInteger(totalPages) && totalPages >= 0) {
    return pageNumber + 1 >= totalPages;
  }
  const totalElements = Number(object.totalElements ?? object.total);
  return Number.isSafeInteger(totalElements) && totalElements >= 0 && rows.length >= totalElements;
};

const bookingIdOf = (value) => {
  const object = asObject(value);
  if (!object) return "";
  return exactAlias([object.id, object.bookingId, object.uuid], "identity");
};

const clientIdOf = (value) => {
  const object = asObject(value);
  if (!object) return "";
  return exactAlias([
    object.clientId,
    asObject(object.client)?.id,
    asObject(object.customer)?.id,
  ], "client identity");
};

const exerciseIdOf = (value) => {
  const object = asObject(value);
  if (!object) return "";
  return exactAlias([
    object.exerciseId,
    asObject(object.exercise)?.id,
    asObject(object.service)?.id,
  ], "exercise identity");
};

const bookingIsActive = (value) => {
  const object = asObject(value);
  if (!object) throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva booking read-back is not an object", { ambiguous: true });
  const evidence = [];
  let decisiveEvidence = false;
  if (object.active !== undefined && object.active !== null) {
    if (typeof object.active !== "boolean") {
      throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva booking active flag is not boolean", { ambiguous: true });
    }
    evidence.push(object.active);
    decisiveEvidence = true;
  }
  for (const field of ["cancelled", "canceled"]) {
    if (object[field] === undefined || object[field] === null) continue;
    if (typeof object[field] !== "boolean") {
      throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva booking cancellation flag is not boolean", { ambiguous: true });
    }
    evidence.push(!object[field]);
    if (object[field] === true) decisiveEvidence = true;
  }
  const state = exactAlias(
    [object.status, object.state].map((entry) => toText(entry).toUpperCase()),
    "state",
  );
  if (state) {
    if (TERMINAL_BOOKING_STATES.has(state)) evidence.push(false);
    else if (ACTIVE_BOOKING_STATES.has(state)) evidence.push(true);
    else {
      throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva booking state is not recognized", { ambiguous: true });
    }
    decisiveEvidence = true;
  }
  if (!decisiveEvidence || new Set(evidence).size !== 1) {
    throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva booking lifecycle evidence conflicts", { ambiguous: true });
  }
  return evidence[0];
};

const extractCreatedBooking = (payload) => {
  const direct = asObject(payload);
  const candidates = [
    direct,
    asObject(direct?.data),
    asObject(direct?.booking),
    asObject(direct?.payload),
  ].filter(Boolean);
  const matches = candidates.filter((candidate) => bookingIdOf(candidate));
  if (matches.length !== 1) return null;
  return matches[0];
};

export function validateVivaPartnerRuntimeConfig(options = {}) {
  if (options.mutationsEnabled !== true) {
    throw providerError("VIVA_RUNTIME_NOT_CONFIGURED", "Real Viva mutations are disabled");
  }
  if (toText(options.contractRevision) !== PARTNER_VIVA_CONTRACT_REVISION) {
    throw providerError("VIVA_CONTRACT_NOT_APPROVED", "Viva partner booking contract revision is not approved");
  }
  if (options.idempotencyConfirmed !== true) {
    throw providerError("VIVA_IDEMPOTENCY_NOT_CONFIRMED", "Viva provider idempotency is not confirmed");
  }
  if (options.onPlacePaymentConfirmed !== true) {
    throw providerError("VIVA_PAYMENT_TYPE_NOT_CONFIRMED", "Viva ON_PLACE booking semantics are not confirmed");
  }
  if (toText(options.apiBase || PARTNER_VIVA_ADMIN_API_BASE) !== PARTNER_VIVA_ADMIN_API_BASE) {
    throw providerError("VIVA_API_BASE_INVALID", "Viva API base differs from the pinned contract");
  }
  return true;
}

export class VivaAdminTechnicalUserProvider {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.tokenResolver = options.tokenResolver;
    this.apiBase = toText(options.apiBase || PARTNER_VIVA_ADMIN_API_BASE);
    this.contractRevision = toText(options.contractRevision);
    this.mutationsEnabled = options.mutationsEnabled === true;
    this.idempotencyConfirmed = options.idempotencyConfirmed === true;
    this.onPlacePaymentConfirmed = options.onPlacePaymentConfirmed === true;
    this.timeoutMs = Number(options.timeoutMs || 8_000);
    if (typeof this.fetchImpl !== "function" || typeof this.tokenResolver !== "function") {
      throw new Error("Viva provider requires fetch and token resolver functions");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new Error("Viva provider timeout must be between 1000 and 30000 ms");
    }
  }

  async assertReady() {
    validateVivaPartnerRuntimeConfig(this);
    await this.resolveToken();
    return true;
  }

  async resolveToken() {
    let token;
    try {
      token = toText(await this.tokenResolver());
    } catch {
      throw providerError("VIVA_SERVICE_TOKEN_UNAVAILABLE", "Viva service token is unavailable");
    }
    if (!TOKEN_PATTERN.test(token)) {
      throw providerError("VIVA_SERVICE_TOKEN_UNAVAILABLE", "Viva service token is unavailable");
    }
    return token;
  }

  async request({ method, path, body, idempotencyKey, correlationId, outcomeCode, allowNotFound = false }) {
    validateVivaPartnerRuntimeConfig(this);
    const token = await this.resolveToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(correlationId ? { "X-Correlation-ID": correlationId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw providerError(outcomeCode, "Viva request outcome is ambiguous", { ambiguous: true });
    } finally {
      clearTimeout(timeout);
    }

    if (allowNotFound && response.status === 404) return { status: 404, payload: null };
    let payload = null;
    try {
      const text = await response.text();
      if (text.length > 1_000_000) {
        throw providerError("VIVA_RESPONSE_TOO_LARGE", "Viva response exceeds the accepted limit", { ambiguous: true });
      }
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof PartnerProviderError) throw error;
      throw providerError("VIVA_RESPONSE_INVALID", "Viva response is not valid JSON", {
        ambiguous: method !== "GET",
        httpStatus: 502,
      });
    }
    if (response.status >= 500) {
      throw providerError(outcomeCode, "Viva request outcome is ambiguous", { ambiguous: true });
    }
    if (!response.ok) {
      throw providerError("VIVA_REQUEST_REJECTED", "Viva rejected the partner booking request", {
        ambiguous: false,
        httpStatus: response.status === 401 || response.status === 403 ? 503 : 409,
      });
    }
    return { status: response.status, payload };
  }

  async addTechnicalUser(input) {
    const result = await this.request({
      method: "POST",
      path: `/exercises/${encodeURIComponent(input.exerciseId)}/bookings`,
      body: {
        clientId: input.technicalVivaClientId,
        paymentType: PARTNER_VIVA_PAYMENT_TYPE,
        familyMemberId: "",
        customFields: [],
      },
      idempotencyKey: input.idempotencyKey,
      correlationId: input.operationId,
      outcomeCode: "VIVA_ADD_OUTCOME_UNKNOWN",
    });
    const booking = extractCreatedBooking(result.payload);
    const bookingId = bookingIdOf(booking);
    if (!bookingId) {
      throw providerError("VIVA_ADD_RESPONSE_AMBIGUOUS", "Viva create response has no exact booking ID", {
        ambiguous: true,
      });
    }
    const responseClientId = clientIdOf(booking);
    const responseExerciseId = exerciseIdOf(booking);
    if ((responseClientId && responseClientId !== input.technicalVivaClientId)
      || (responseExerciseId && responseExerciseId !== input.exerciseId)) {
      throw providerError("VIVA_ADD_RESPONSE_MISMATCH", "Viva create response binding is ambiguous", {
        ambiguous: true,
      });
    }
    return { bookingId };
  }

  async readBooking(input) {
    const result = await this.request({
      method: "GET",
      path: `/exercises/${encodeURIComponent(input.exerciseId)}/bookings?showCancelled=true&page=0&size=200`,
      correlationId: input.operationId,
      outcomeCode: "VIVA_READBACK_UNAVAILABLE",
    });
    const rows = rowsFromPayload(result.payload);
    const matches = rows.filter((row) => bookingIdOf(row) === input.bookingId);
    if (matches.length === 0) {
      if (!isCompletePage(result.payload, rows)) {
        throw providerError("VIVA_READBACK_INCOMPLETE", "Viva booking absence is not proven by a complete page", {
          ambiguous: true,
        });
      }
      return {
        bookingId: input.bookingId,
        exerciseId: input.exerciseId,
        clientId: input.technicalVivaClientId,
        active: false,
      };
    }
    if (matches.length !== 1) {
      throw providerError("VIVA_READBACK_AMBIGUOUS", "Viva returned duplicate booking identities", {
        ambiguous: true,
      });
    }
    const row = matches[0];
    const exerciseId = exerciseIdOf(row);
    const clientId = clientIdOf(row);
    if (exerciseId !== input.exerciseId || clientId !== input.technicalVivaClientId) {
      throw providerError("VIVA_READBACK_BINDING_MISMATCH", "Viva booking read-back binding differs", {
        ambiguous: true,
      });
    }
    return {
      bookingId: bookingIdOf(row),
      exerciseId,
      clientId,
      active: bookingIsActive(row),
    };
  }

  async removeTechnicalUser(input) {
    const path = `/clients/${encodeURIComponent(input.technicalVivaClientId)}`
      + `/bookings/${encodeURIComponent(input.bookingId)}/cancel`;
    const probe = await this.request({
      method: "GET",
      path,
      correlationId: input.operationId,
      outcomeCode: "VIVA_REMOVE_PROBE_UNAVAILABLE",
      allowNotFound: true,
    });
    if (probe.status === 404) return { bookingId: input.bookingId };
    const options = asObject(asObject(probe.payload)?.cancellationOptions) || {};
    if (asObject(options.cancellationOnly)?.available !== true) {
      throw providerError("VIVA_CANCEL_CONTRACT_MISMATCH", "Viva does not confirm cancellation-only semantics", {
        ambiguous: false,
        httpStatus: 409,
      });
    }
    await this.request({
      method: "PUT",
      path,
      body: { refundMethod: "NONE", cancelExercise: false },
      idempotencyKey: input.idempotencyKey,
      correlationId: input.operationId,
      outcomeCode: "VIVA_REMOVE_OUTCOME_UNKNOWN",
      allowNotFound: true,
    });
    return { bookingId: input.bookingId };
  }
}
