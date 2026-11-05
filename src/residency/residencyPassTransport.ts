import { getServ2Origin, request } from "../utils/apiClient";
import { RESIDENCY_GATEWAY_BASE_URL } from "./residencyConfig.ts";
import type { ResidencyTransport } from "./residencyPassClient.ts";

/**
 * Browser transport for the residency gateway.
 *
 * The privileged integration token and the CUP base URL stay on the LK gateway: the browser
 * only ever holds its own LK Bearer and calls /lk/residency/*. Non-idempotent pass creation is
 * never retried automatically; a lost response may already have created a pass.
 */
export const residencyGatewayTransport: ResidencyTransport = async ({ method, path, body, signal }) => {
  const baseUrl = (RESIDENCY_GATEWAY_BASE_URL || getServ2Origin() || "").trim();
  if (!baseUrl) {
    return {
      status: null,
      data: { code: "RESIDENT_CLIENT_NOT_CONFIGURED" },
      networkError: true,
    };
  }
  const response = await request<unknown>(path, {
    method,
    baseUrl,
    auth: true,
    retries: 0,
    signal,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: response.data,
    networkError: response.status === null,
  };
};
