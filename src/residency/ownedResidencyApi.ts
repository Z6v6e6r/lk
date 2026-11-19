import { API_BASE, TENANT_KEY } from "../consts/api_config";
import { request } from "../utils/apiClient";

export interface OwnedResidencyRawRead {
  payload: unknown;
  readFailed: boolean;
  observedAtMs: number;
}

/**
 * One fresh GET of the client's own subscriptions for the owned-residency check (lk#459).
 *
 * Read only: no order, booking or subscription changes. It bypasses the 12-hour subscription
 * session snapshot on purpose: a NONE answer must not come from a cached list that predates a
 * residency bought in another tab. Classification is `classifyOwnedResidency`.
 */
export async function apiReadOwnedResidencyRows(signal?: AbortSignal): Promise<OwnedResidencyRawRead> {
  const url = `${API_BASE}/end-user/api/v1/${TENANT_KEY}/subscriptions?includeFinished=true&size=1000`;
  try {
    const result = await request<unknown>(url, { method: "GET", auth: true, retries: 1, cache: "no-store", signal });
    return { payload: result.error ? null : result.data, readFailed: Boolean(result.error) || result.status === null, observedAtMs: Date.now() };
  } catch {
    return { payload: null, readFailed: true, observedAtMs: Date.now() };
  }
}
