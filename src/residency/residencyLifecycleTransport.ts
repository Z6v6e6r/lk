import { getServ2Origin, request } from "../utils/apiClient";
import { RESIDENCY_GATEWAY_BASE_URL } from "./residencyConfig.ts";
import {
  createResidencyLifecycleClient,
  type LifecycleTransport,
} from "./residencyLifecycleClient.ts";

/**
 * Browser transport for the server-owned lifecycle. The client only calls /lk/residency/*;
 * the Viva/CUP credentials never leave the gateway.
 */
export const residencyLifecycleTransport: LifecycleTransport = async ({ method, path, body, idempotencyKey, returnTarget, signal }) => {
  const baseUrl = (RESIDENCY_GATEWAY_BASE_URL || getServ2Origin() || "").trim();
  if (!baseUrl) return { status: null, data: { code: "RESIDENCY_CLIENT_NOT_CONFIGURED" }, networkError: true };
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (returnTarget) headers["X-Residency-Return-Target"] = returnTarget;
  const response = await request<unknown>(path, {
    method,
    baseUrl,
    auth: true,
    retries: 0,
    signal,
    cache: "no-store",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // apiClient puts an error body in error.raw (data is null on non-2xx); the stable
  // RESIDENCY_* code lives there, so the screen can distinguish a denied pilot from a
  // network failure without treating the refusal as success.
  return { status: response.status, data: response.data ?? response.error?.raw ?? null, networkError: response.status === null };
};

export const residencyLifecycleClient = createResidencyLifecycleClient(residencyLifecycleTransport);
