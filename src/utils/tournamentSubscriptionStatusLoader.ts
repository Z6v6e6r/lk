import { TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS } from "./tournamentSubscriptionCatalog.ts";

export interface TournamentSubscriptionStatusPlanRequest {
  counterKey?: string | null;
  planId?: string | null;
}

export interface TournamentSubscriptionStatusFetchParams {
  counterKey?: string | null;
  planType?: string | null;
}

export interface TournamentSubscriptionStatusFetchResult<TStatus, TError> {
  data: TStatus[] | null;
  error: TError;
}

export async function loadTournamentSubscriptionStatuses<TStatus, TError = unknown>(
  plans: readonly TournamentSubscriptionStatusPlanRequest[],
  fetchStatus: (
    params?: TournamentSubscriptionStatusFetchParams,
  ) => Promise<TournamentSubscriptionStatusFetchResult<TStatus, TError>>,
) {
  const aggregateResult = await fetchStatus();
  const overrideKeys = new Set<string>(TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS);
  const explicitCounterKeys = Array.from(new Set(
    plans
      .map((plan) => plan.counterKey)
      .filter((counterKey): counterKey is string =>
        typeof counterKey === "string" && overrideKeys.has(counterKey)),
  ));

  const explicitResults = await Promise.all(
    explicitCounterKeys.map(async (counterKey) => {
      const plan = plans.find((candidate) => candidate.counterKey === counterKey) ?? null;
      const result = await fetchStatus({
        counterKey,
        planType: plan?.planId ?? null,
      });
      return {
        counterKey,
        data: result.error || !result.data ? [] : result.data,
        failed: Boolean(result.error || !result.data),
      };
    }),
  );

  return {
    aggregateResult,
    explicitCounterKeys,
    failedExplicitCounterKeys: explicitResults
      .filter((result) => result.failed)
      .map((result) => result.counterKey),
    statuses: [
      // mapStatusesByCounter keeps the first status for each key, so exact
      // per-counter responses must stay ahead of the aggregate response.
      ...explicitResults.flatMap((result) => result.data),
      ...(aggregateResult.data || []),
    ],
  };
}
