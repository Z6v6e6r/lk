import { useEffect, useMemo, useRef, useState } from "react";
import { trackClientError } from "../../utils/analytics";
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
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled || availabilityLoading || !target || !actorId || !ids.length || ids.length > 20) return;
    const scopeGeneration = ++generation.current;
    const started = performance.now();
    const controller = new AbortController();
    let current = true;
    let settled = false;
    setState({scope, loading: true, quotes: null, receivedAt: 0});
    const deadline = setTimeout(() => controller.abort("deadline"), 30_000);
    const debounce = setTimeout(() => {
      const requestStartedAt = performance.now();
      void apiFetchSubscriptionPricePreview(target, ids, controller.signal).then(result => {
        if (!current) return;
        const elapsedMs = performance.now() - requestStartedAt;
        const serverTimeMs = result.data?.serverTimeMs;
        const hasServerTime = typeof serverTimeMs === "number" && Number.isSafeInteger(serverTimeMs)
          && serverTimeMs > 0 && Number.isFinite(elapsedMs) && elapsedMs >= 0
          && serverTimeMs + elapsedMs <= Number.MAX_SAFE_INTEGER;
        // The whole request duration conservatively covers response transit, including
        // a sequential fallback. Never consult the device wall clock for quote age.
        const receivedAt = hasServerTime ? serverTimeMs + elapsedMs : 0;
        const quotes = !result.error && hasServerTime && Array.isArray(result.data?.quotes)
          && result.data.quotes.every(quote => typeof quote?.evaluatedAt === "number"
            && quote.evaluatedAt <= serverTimeMs + 5000) ? result.data.quotes : null;
        // Validate freshness against the server clock at receipt, then retain this display snapshot for the
        // unchanged selection. CREATE/JOIN independently checks the chosen subscription;
        // this preview is never sent as authorization or as the amount to charge.
        setState({scope, loading: false, quotes, receivedAt});
      }).catch(() => {
        if (current) setState({scope, loading: false, quotes: null, receivedAt: 0});
      }).finally(() => { settled = true; clearTimeout(deadline); });
    }, 300);
    return () => {
      current = false; clearTimeout(debounce); clearTimeout(deadline);
      if (settled) return;
      if (!controller.signal.aborted) controller.abort("scope_disposed");
      trackClientError("preview.scope", null, { stage: "preview_scope", code: "ABORT", scopeGeneration,
        abortCause: controller.signal.reason, durationMs: performance.now() - started });
    };
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
