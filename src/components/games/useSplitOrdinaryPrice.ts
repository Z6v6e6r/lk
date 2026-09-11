import { useEffect, useState } from "react";
import type { PadelGameRecord } from "../../utils/apiClient";
import {
  hasCanonicalSplitSharePrice,
  type SplitOrdinaryPrice,
  type SplitOrdinaryPriceState,
} from "./splitOrdinaryPricing";
import { resolveSplitOrdinaryPrice } from "./resolveSplitOrdinaryPrice";

/**
 * Display-only resolution of the ordinary split share for game records that do
 * not carry a canonical server-derived price. The server remains the pricing
 * authority on join; this hook only keeps the quoted amount honest so a legacy
 * nominal fallback (10 000 / share count) is never shown as the participant price.
 */
export function useSplitOrdinaryPrice(params: {
  booking: PadelGameRecord["booking"] | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  splitPayment: Record<string, unknown> | null | undefined;
  shareCount: number;
  enabled: boolean;
}): SplitOrdinaryPriceState {
  const { booking, metadata, splitPayment, shareCount, enabled } = params;
  const storedIsCanonical = hasCanonicalSplitSharePrice(splitPayment);
  const scope = JSON.stringify([
    enabled,
    storedIsCanonical,
    booking?.studioId ?? null,
    booking?.roomId ?? null,
    booking?.masterServiceId ?? null,
    booking?.subServiceIds ?? null,
    booking?.date ?? null,
    booking?.timeFrom ?? null,
    booking?.timeTo ?? null,
    metadata?.masterServiceId ?? null,
    metadata?.subServiceIds ?? null,
    shareCount,
  ]);
  const [state, setState] = useState<{
    scope: string;
    price: SplitOrdinaryPrice | null;
    settled: boolean;
  }>({ scope: "", price: null, settled: false });

  useEffect(() => {
    if (!enabled || storedIsCanonical) return;
    let current = true;
    void resolveSplitOrdinaryPrice({ booking, metadata, shareCount })
      .then((price) => {
        if (current) setState({ scope, price, settled: true });
      })
      .catch(() => {
        if (current) setState({ scope, price: null, settled: true });
      });
    return () => {
      current = false;
    };
    // `scope` carries every identity and contract field the lookup depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  if (!enabled || storedIsCanonical) return { price: null, settled: true };
  return state.scope === scope ? state : { price: null, settled: false };
}
