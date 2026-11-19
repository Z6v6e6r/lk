import { getServ2Origin, request } from "../utils/apiClient";

export interface ResidencyPurchaseQuoteRawRead {
  body: unknown;
  failed: boolean;
  /** 422: the selected training is not covered by the published residency policy. */
  notCovered: boolean;
  requestedAtMs: number;
}

/**
 * Read-only server quote for buying residency together with a group training (lk#463).
 * Sends only the exercise id: no prices, discounts or subscription ids. It creates no
 * reservation, order or payment. Parsing and expiry: `parseResidencyPurchaseQuote`.
 */
export async function apiFetchResidencyPurchaseQuote(exerciseId: string, signal?: AbortSignal): Promise<ResidencyPurchaseQuoteRawRead> {
  const requestedAtMs = Date.now();
  try {
    const result = await request<unknown>("/lk/subscriptions/game-price-preview", {
      method: "POST", baseUrl: getServ2Origin(), auth: true, retries: 0, cache: "no-store", signal,
      body: JSON.stringify({ target: { targetKind: "GROUP_TRAINING_RESIDENCY_PURCHASE", exerciseId } }),
    });
    return {
      body: result.error ? null : result.data,
      failed: Boolean(result.error) || result.status === null,
      notCovered: result.status === 422,
      requestedAtMs,
    };
  } catch {
    return { body: null, failed: true, notCovered: false, requestedAtMs };
  }
}
