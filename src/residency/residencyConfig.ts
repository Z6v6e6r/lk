const ENV = import.meta.env as Record<string, string | undefined>;

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

/**
 * Residency pass build-time configuration.
 *
 * The screen is off by default: the LK gateway flow has to be imported, configured and its
 * CUP upstream enabled before residents see it (see docs/residency-client.md).
 */
export const RESIDENCY_PASS_ENABLED = readBoolean(ENV.VITE_RESIDENCY_PASS_ENABLED, false);

/** Staff check screen base URL. The pass token is appended as a URL fragment, never a query. */
export const RESIDENCY_CHECK_URL =
  (ENV.VITE_RESIDENCY_CHECK_URL || "").trim() || "https://padlhub.su/admin/residency/check";

/** Optional gateway origin override; by default the gateway lives on the SERV2 origin. */
export const RESIDENCY_GATEWAY_BASE_URL = (ENV.VITE_RESIDENCY_PASS_API_BASE || "").trim();
