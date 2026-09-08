import { useEffect, useMemo, useState } from "react";
import { apiFetchSubscriptionPricePreview } from "../../utils/apiClient";
import { subscriptionPricePreview, subscriptionPriceSelectionKey,
  type SubscriptionPriceQuote, type SubscriptionPriceTarget } from "./subscriptionPricePreview.ts";

export function useSubscriptionPricePreview({ target, subscriptionIds, actorId, enabled, availabilityLoading }: {
  target: SubscriptionPriceTarget | null;
  subscriptionIds: string[];
  actorId: string | null;
  enabled: boolean;
  availabilityLoading: boolean;
}) {
  const selectionKey = target ? subscriptionPriceSelectionKey(target) : "";
  const idsKey = JSON.stringify([...new Set(subscriptionIds)].sort());
  const scope = JSON.stringify([actorId, selectionKey, idsKey, enabled, availabilityLoading]);
  const ids = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const [state, setState] = useState<{scope: string; loading: boolean; quotes: SubscriptionPriceQuote[] | null}>({
    scope: "", loading: false, quotes: null,
  });
  useEffect(() => {
    if (!enabled || availabilityLoading || !target || !actorId || !ids.length || ids.length > 20) return;
    const controller = new AbortController();
    let current = true;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    setState({scope, loading: true, quotes: null});
    const deadline = setTimeout(() => controller.abort(), 30_000);
    const debounce = setTimeout(() => {
      void apiFetchSubscriptionPricePreview(target, ids, controller.signal).then(result => {
        if (!current) return;
        const quotes = !result.error && Array.isArray(result.data?.quotes) ? result.data.quotes : null;
        setState({scope, loading: false, quotes});
        if (quotes?.length && quotes.every(q => q && typeof q === "object" && Number.isFinite(q.expiresAt))) {
          const remaining = Math.min(...quotes.map(q => q.expiresAt)) - Date.now();
          if (Number.isFinite(remaining)) expiryTimer = setTimeout(() => {
            if (current) setState({scope, loading: false, quotes: null});
          }, Math.max(0, Math.min(remaining, 60_000)));
        }
      }).catch(() => {
        if (current) setState({scope, loading: false, quotes: null});
      }).finally(() => clearTimeout(deadline));
    }, 300);
    return () => { current = false; clearTimeout(debounce); clearTimeout(deadline); clearTimeout(expiryTimer); controller.abort(); };
    // Canonical keys include every target, account and subscription identity field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const canCheck = enabled && Boolean(target && actorId && ids.length && ids.length <= 20);
  return subscriptionPricePreview({ selectionKey, durationMinutes: target?.durationMinutes ?? 0,
    subscriptionIds: ids, quotes: state.scope === scope ? state.quotes : null,
    loading: canCheck && (availabilityLoading || state.scope !== scope || state.loading), now: Date.now() });
}
