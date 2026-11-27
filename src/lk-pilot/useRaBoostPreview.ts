import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { readAuthToken } from "../utils/authTokenStorage";
import { pilotOfferSelectionKey, readRaBoostPreview, type PilotOfferTarget, type RaBoostPreview } from "./raBoostPreview";

const previewUrl = "https://padlhub.su/lk/subscriptions/game-price-preview?pilotOffer=ra-boost";

export function useRaBoostPreview(target: PilotOfferTarget | null, accountScope: string | null) {
  const scope = target && accountScope ? JSON.stringify([accountScope, pilotOfferSelectionKey(target)]) : null;
  // A -> B -> A is a new request even if the canonical target key is the same.
  const requestId = useMemo(() => Symbol(scope ?? ""), [scope]);
  const [state, setState] = useState<{ requestId: symbol; offer: RaBoostPreview | null } | null>(null);

  useEffect(() => {
    const token = readAuthToken();
    if (!target || !scope || !token) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    const start = setTimeout(async () => {
      const startedAt = performance.now();
      try {
        const response = await fetch(previewUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ target }),
          signal: controller.signal,
        });
        const offer = response.ok
          ? readRaBoostPreview(await response.json(), pilotOfferSelectionKey(target), performance.now() - startedAt)
          : null;
        if (controller.signal.aborted || token !== readAuthToken()) return;
        setState({ requestId, offer });
      } catch {
        if (!controller.signal.aborted) setState({ requestId, offer: null });
      } finally {
        clearTimeout(deadline);
      }
    }, 300);

    return () => {
      controller.abort();
      clearTimeout(start);
      clearTimeout(deadline);
    };
    // The selection key contains all target fields, with canonical service-id ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, requestId]);

  if (!scope || requestId !== state?.requestId || !state.offer) return null;
  return state.offer;
}

export function useUnexpiredRaBoost(offer: RaBoostPreview | null | undefined) {
  const deadline = offer?.expiresAt ?? 0;
  const subscribe = useCallback((notify: () => void) => {
    if (!deadline) return () => {};
    const timer = window.setTimeout(notify, Math.max(0, deadline - Date.now()));
    window.addEventListener("focus", notify);
    document.addEventListener("visibilitychange", notify);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", notify);
      document.removeEventListener("visibilitychange", notify);
    };
  }, [deadline]);
  const isCurrent = useSyncExternalStore(subscribe, () => deadline > Date.now(), () => false);
  return isCurrent ? offer : null;
}
