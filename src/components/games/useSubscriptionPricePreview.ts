import { useEffect, useMemo, useState } from "react";
import { apiFetchSubscriptionPricePreview } from "../../utils/apiClient";
import { subscriptionPricePreview, subscriptionPricePreviewsById, subscriptionPriceSelectionKey,
  type SubscriptionPriceQuote, type SubscriptionPriceTarget } from "./subscriptionPricePreview.ts";

export function useSubscriptionPricePreview({ target, subscriptionIds, actorId, enabled, availabilityLoading }: {
  target: SubscriptionPriceTarget | null;
  subscriptionIds: string[];
  actorId: string | null;
  enabled: boolean;
  availabilityLoading: boolean;
}) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectionKey = target ? subscriptionPriceSelectionKey(target) : "";
  const idsKey = JSON.stringify([...new Set(subscriptionIds)].sort());
  const scope = JSON.stringify([actorId, selectionKey, idsKey, enabled, availabilityLoading, refreshVersion]);
  const ids = useMemo<string[]>(() => JSON.parse(idsKey), [idsKey]);
  const [state, setState] = useState<{scope: string; loading: boolean; quotes: SubscriptionPriceQuote[] | null; receivedAt: number}>({
    scope: "", loading: false, quotes: null, receivedAt: 0,
  });
  useEffect(() => {
    if (!enabled || availabilityLoading || !target || !actorId || !ids.length || ids.length > 20) return;
    const controller = new AbortController();
    let current = true;
    setState({scope, loading: true, quotes: null, receivedAt: 0});
    const deadline = setTimeout(() => controller.abort(), 30_000);
    const debounce = setTimeout(() => {
      void apiFetchSubscriptionPricePreview(target, ids, controller.signal).then(result => {
        if (!current) return;
        const quotes = !result.error && Array.isArray(result.data?.quotes) ? result.data.quotes : null;
        // Validate freshness at receipt, then retain this display snapshot for the
        // unchanged selection. CREATE independently checks the chosen subscription;
        // this preview is never sent as authorization or as the amount to charge.
        setState({scope, loading: false, quotes, receivedAt: Date.now()});
      }).catch(() => {
        if (current) setState({scope, loading: false, quotes: null, receivedAt: 0});
      }).finally(() => clearTimeout(deadline));
    }, 300);
    return () => { current = false; clearTimeout(debounce); clearTimeout(deadline); controller.abort(); };
    // Canonical keys include every target, account and subscription identity field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const canCheck = enabled && Boolean(target && actorId && ids.length && ids.length <= 20);
  const input = { selectionKey, durationMinutes: target?.durationMinutes ?? 0,
    subscriptionIds: ids, quotes: state.scope === scope ? state.quotes : null,
    loading: canCheck && (availabilityLoading || state.scope !== scope || state.loading), now: state.receivedAt };
  return { ...subscriptionPricePreview(input), bySubscriptionId: subscriptionPricePreviewsById(input),
    refresh: () => setRefreshVersion(version => version + 1) };
}
