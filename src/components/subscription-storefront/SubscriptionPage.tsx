import { useEffect, useState } from 'react';
import { apiFetchTournamentSubscriptionStatus } from '../../utils/apiClient';
import { IS_DEV_RELEASE_CHANNEL } from '../../consts/api_config';
import { SubscriptionStorefront } from './SubscriptionStorefront';
import { summerPlanPresentation } from './presentation';
import { billingFromStatus, canContinue, storefrontPlanKeys, subscriptionCheckoutUrl, type StorefrontStatus } from './catalog';
import type { SubscriptionStorefrontView } from './model';
import markUrl from './assets/brand/подписка.svg';

export function SubscriptionPage({ onBack, previewView }: {
  onBack?: () => void;
  previewView?: SubscriptionStorefrontView;
}) {
  const [statuses, setStatuses] = useState<readonly StorefrontStatus[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (previewView) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    async function refresh() {
      controller = new AbortController();
      const deadline = setTimeout(() => controller?.abort(), 12_000);
      try {
        const result = await apiFetchTournamentSubscriptionStatus({}, { signal: controller.signal });
        if (cancelled) return;
        if (result.error || !result.data) throw new Error('Status unavailable');
        setStatuses(result.data);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        clearTimeout(deadline);
        // A request completes before another is scheduled: responses cannot race.
        if (!cancelled) timer = setTimeout(() => { void refresh(); }, 30_000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [attempt, previewView]);

  const plans = storefrontPlanKeys.flatMap(key => {
    const status = statuses?.find(item => item.counterKey === key);
    if (!status) return [];
    const billingOptions = billingFromStatus(status);
    if (!billingOptions.length) return [];
    return [{
      ...summerPlanPresentation[key], id: key, billingOptions,
      ctaLabel: canContinue(status, error) ? 'Оформить подписку' : 'Сейчас недоступно',
      ctaDisabled: !canContinue(status, error),
    }];
  });
  const view = previewView ?? {
    id: 'lk1-subscriptions', title: 'Играй в падел выгодно',
    description: 'Выберите подписку под свой ритм игры', markUrl, markAlt: 'Подписка',
    sections: [{ id: 'subscriptions-monthly', plans }],
  };

  return <>
    {!previewView && (!statuses || error || !plans.length) && <div className="subscription-storefront" style={{ minHeight: 0 }}>
      <div className="subscription-status-message" role={error ? 'alert' : 'status'}>
        {error ? 'Не удалось обновить подписки. Попробуйте ещё раз.' :
          !statuses ? 'Загружаем подписки…' : 'Сейчас нет доступных предложений.'}
        {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>}
      </div>
    </div>}
    {(previewView || statuses) && <SubscriptionStorefront view={view} onBack={onBack} onChoose={({ planId }) => {
      if (previewView) return;
      const status = statuses?.find(item => item.counterKey === planId);
      if (!status || !canContinue(status, error)) return;
      const target = subscriptionCheckoutUrl(planId, IS_DEV_RELEASE_CHANNEL ? 'dev' : 'prod');
      if (target) window.location.assign(target);
    }} />}
  </>;
}
