import { useCallback, useMemo, useState } from "react";
import { IS_DEV_RELEASE_CHANNEL, PHAB_API_BASE } from "../../consts/api_config";
import { readSubscriptionUsageTestCredentials } from "./subscriptionUsageTestRoute";
import {
  fetchSubscriptionUsageShadowQuote,
  isSubscriptionUsageShadowMode,
  normalizeSubscriptionUsageShadowCounter,
  presentSubscriptionUsageShadowQuote,
  type SubscriptionUsageShadowAction,
  type SubscriptionUsageShadowPresentation,
} from "./subscriptionUsageShadow";

export interface SubscriptionUsageShadowController {
  enabled: boolean;
  busy: boolean;
  activeServices: number;
  dailyGameUsage: number;
  presentation: SubscriptionUsageShadowPresentation | null;
  error: string | null;
  setActiveServices(value: number): void;
  setDailyGameUsage(value: number): void;
  preview(action: SubscriptionUsageShadowAction, durationMinutes: number | null | undefined): Promise<void>;
  reject(message: string): void;
}

export function useSubscriptionUsageShadow(): SubscriptionUsageShadowController {
  const configuration = useMemo(() => {
    if (typeof window === "undefined") return { enabled: false, credentials: null };
    return {
      enabled: isSubscriptionUsageShadowMode(
        window.location.pathname,
        window.location.search,
        IS_DEV_RELEASE_CHANNEL,
      ),
      credentials: readSubscriptionUsageTestCredentials(window.location.hash),
    };
  }, []);
  const [activeServices, setActiveServicesState] = useState(0);
  const [dailyGameUsage, setDailyGameUsageState] = useState(0);
  const [busy, setBusy] = useState(false);
  const [presentation, setPresentation] = useState<SubscriptionUsageShadowPresentation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActiveServices = useCallback((value: number) => {
    setActiveServicesState(normalizeSubscriptionUsageShadowCounter(value, 4));
    setPresentation(null);
    setError(null);
  }, []);

  const setDailyGameUsage = useCallback((value: number) => {
    setDailyGameUsageState(normalizeSubscriptionUsageShadowCounter(value, 4));
    setPresentation(null);
    setError(null);
  }, []);

  const preview = useCallback(async (
    action: SubscriptionUsageShadowAction,
    durationMinutes: number | null | undefined,
  ) => {
    if (!configuration.enabled) return;
    setBusy(true);
    setError(null);
    setPresentation(null);
    try {
      const quote = await fetchSubscriptionUsageShadowQuote({
        apiBase: PHAB_API_BASE,
        credentials: configuration.credentials,
        action,
        durationMinutes,
        activeServices,
        dailyGameUsage,
      });
      setPresentation(presentSubscriptionUsageShadowQuote(quote));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Не удалось проверить ограничения");
    } finally {
      setBusy(false);
    }
  }, [activeServices, configuration, dailyGameUsage]);

  const reject = useCallback((message: string) => {
    if (!configuration.enabled) return;
    setPresentation(null);
    setError(message);
  }, [configuration.enabled]);

  return {
    enabled: configuration.enabled,
    busy,
    activeServices,
    dailyGameUsage,
    presentation,
    error,
    setActiveServices,
    setDailyGameUsage,
    preview,
    reject,
  };
}

export function SubscriptionUsageShadowPanel({
  controller,
}: {
  controller: SubscriptionUsageShadowController;
}) {
  if (!controller.enabled) return null;
  return (
    <section className="subscription-usage-shadow" aria-label="DEV-shadow ограничений подписки">
      <div className="subscription-usage-shadow__header">
        <div>
          <strong>DEV-shadow годовой подписки</strong>
          <span>Основная кнопка только рассчитывает условия — без бронирования и оплаты.</span>
        </div>
        <span className="subscription-usage-shadow__badge">0 внешних записей</span>
      </div>
      <div className="subscription-usage-shadow__controls">
        <label>
          Активных услуг
          <select
            value={controller.activeServices}
            onChange={(event) => controller.setActiveServices(Number(event.target.value))}
            disabled={controller.busy}
          >
            {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} / 4</option>)}
          </select>
        </label>
        <label>
          Игровых услуг сегодня
          <select
            value={controller.dailyGameUsage}
            onChange={(event) => controller.setDailyGameUsage(Number(event.target.value))}
            disabled={controller.busy}
          >
            {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <div className="subscription-usage-shadow__status" aria-live="polite">
        {controller.busy && <span>Проверяем правила тестового оффера ЦУП…</span>}
        {!controller.busy && !controller.presentation && !controller.error && (
          <span>Выберите состояние и нажмите основную кнопку экрана.</span>
        )}
        {controller.error && (
          <div className="subscription-usage-shadow__result subscription-usage-shadow__result--blocked" role="alert">
            <strong>Проверка не выполнена</strong>
            <span>{controller.error}</span>
          </div>
        )}
        {controller.presentation && (
          <div className={`subscription-usage-shadow__result subscription-usage-shadow__result--${controller.presentation.tone}`}>
            <strong>{controller.presentation.title}</strong>
            <span>{controller.presentation.summary}</span>
            {controller.presentation.reasons.length > 0 && (
              <small>{controller.presentation.reasons.join(" · ")}</small>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
