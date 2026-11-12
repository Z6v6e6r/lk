import type { ApiResult } from "./apiClient.ts";
import { isLkIdleRequestPausedError } from "./lkIdleDataGuard.ts";

const BUSY_DELAYS_MS = [750, 1_500, 3_000] as const;

function cancelled<T>(reason?: unknown): ApiResult<T> {
  return {
    status: null,
    data: null,
    error: {
      status: null,
      message: "Запрос отменён",
      raw: reason ?? new DOMException("Participant read cancelled", "AbortError"),
    },
  };
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const finish = (active: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(active);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type ReadOptions<T> = {
  key: string;
  signal?: AbortSignal;
  isCurrentSession: () => boolean;
  run: (signal: AbortSignal) => Promise<ApiResult<T>>;
};

// In-flight only, per API module instance. No settled roster is cached here.
export function createTournamentParticipantReader<T>() {
  type Flight = {
    controller: AbortController;
    subscribers: Set<(result: ApiResult<T>) => void>;
  };
  const flights = new Map<string, Flight>();

  return (options: ReadOptions<T>): Promise<ApiResult<T>> => {
    if (options.signal?.aborted || !options.isCurrentSession()) {
      return Promise.resolve(cancelled(options.signal?.reason));
    }
    let flight = flights.get(options.key);
    const isNew = !flight;
    if (!flight) {
      flight = { controller: new AbortController(), subscribers: new Set() };
      flights.set(options.key, flight);
    }
    const shared = flight;
    const removeFlight = () => {
      if (flights.get(options.key) === shared) flights.delete(options.key);
    };
    const result = new Promise<ApiResult<T>>((resolve) => {
      const settle = (value: ApiResult<T>) => {
        options.signal?.removeEventListener("abort", onAbort);
        shared.subscribers.delete(settle);
        resolve(options.isCurrentSession() ? value : cancelled());
      };
      const onAbort = () => {
        settle(cancelled(options.signal?.reason));
        if (shared.subscribers.size === 0) {
          removeFlight();
          shared.controller.abort();
        }
      };
      shared.subscribers.add(settle);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });

    if (isNew) {
      const execute = async (): Promise<ApiResult<T>> => {
        for (let attempt = 0; ; attempt += 1) {
          if (shared.controller.signal.aborted || !options.isCurrentSession()) return cancelled();
          const response = await options.run(shared.controller.signal);
          if (shared.controller.signal.aborted || !options.isCurrentSession()) return cancelled();
          const payload = response.error?.raw;
          const busyKey = response.status === 429
            && payload !== null && typeof payload === "object"
            && "code" in payload && payload.code === "PARTICIPANTS_BUSY_KEY";
          // Unknown/edge/global 429, idle, auth, transport and provider errors stop here.
          // The remaining owner lease stays in retryAfterMs for the UI's slow fallback.
          if (!busyKey || isLkIdleRequestPausedError(payload) || attempt >= BUSY_DELAYS_MS.length) {
            return response;
          }
          const active = await waitForRetry(
            BUSY_DELAYS_MS[attempt] + Math.floor(Math.random() * 251),
            shared.controller.signal,
          );
          if (!active) return cancelled();
        }
      };
      const finish = (value: ApiResult<T>) => {
        removeFlight();
        for (const subscriber of shared.subscribers) subscriber(value);
      };
      void execute().then(finish, (error: unknown) => finish({
        status: null,
        data: null,
        error: { status: null, message: "Не удалось загрузить участников", raw: error },
      }));
    }
    return result;
  };
}
