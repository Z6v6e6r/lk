import { useCallback, useEffect, useMemo, useState } from "react";
import type { ManagedSubscriptionPolicyDecision } from "../../types/managedSubscriptionRuntime";
import "./ManagedSubscriptionDevPage.css";

const API_BASE = "/__dev/managed-subscriptions";

interface DevTarget {
  targetId: string;
  title: string;
  description: string;
  action: string;
  courtPriceMinor?: number | null;
  participantCount?: number;
  target: {
    stationId: string;
    category: string;
    durationMinutes: number;
    startsAt: string;
    basePriceMinor: number | null;
  };
}

interface DevReservation {
  reservationId: string;
  targetId: string;
  title: string;
  status: "ACTIVE" | "RELEASED";
  startsAt: string;
  usageUnits: number;
  finalPriceMinor: number | null;
  source: "SEED" | "USER";
}

interface DevLedgerEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  targetId: string | null;
  reservationId: string | null;
  details: Record<string, unknown>;
}

interface DevSnapshot {
  mode: "DEV_SHADOW";
  testOnly: true;
  providerMode: "FAKE_NO_VIVA";
  evaluatedAt: string;
  tester: { testerRef: string; displayPhone: string };
  policySource: {
    code: string;
    title: string;
    sourceStatus: string;
    runtimeStatus: string;
    sourceModelVersion: number | null;
    version: number;
    digest: string;
    loadedAt: string;
  };
  limits: {
    activeServices: number;
    activeServicesEnabled: boolean;
    maxActiveServices: number | null;
    bookingWindowEnabled: boolean;
    bookingWindowDays: number | null;
    dailyUsageLimit: number;
    dailyUsageActions: string[];
    dailyLimitExceeded: "BLOCK" | "PERCENT_DISCOUNT";
    dailyLimitExceededPercentage: number | null;
  };
  targets: DevTarget[];
  reservations: DevReservation[];
  ledger: DevLedgerEvent[];
}

interface QuoteResult {
  target: DevTarget;
  decision: ManagedSubscriptionPolicyDecision;
  snapshot: DevSnapshot;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: {
      decision?: ManagedSubscriptionPolicyDecision;
    } | null;
  };
}

const operationId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

const apiRequest = async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json() as T & ApiErrorPayload;
  if (!response.ok) {
    const error = new Error(payload.error?.message || "DEV runtime недоступен") as Error & {
      code?: string;
      decision?: ManagedSubscriptionPolicyDecision;
    };
    error.code = payload.error?.code;
    error.decision = payload.error?.details?.decision;
    throw error;
  }
  return payload;
};

const formatMoney = (amountMinor: number | null | undefined) => {
  if (amountMinor === null || amountMinor === undefined) return "Цена не требуется";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
};

const formatDateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(value));

const percentageOf = (discountMinor: number, amountMinor: number | null | undefined) => (
  amountMinor && amountMinor > 0 ? Math.round((discountMinor / amountMinor) * 100) : null
);

const benefitLabel = (decision: ManagedSubscriptionPolicyDecision, target: DevTarget) => {
  const benefit = decision.benefit;
  if (!benefit) return "Льгота не рассчитана";
  const parts: string[] = [];
  const participantShare = target.participantCount && target.participantCount > 1
    ? `доля игрока 1/${target.participantCount}`
    : null;
  if (benefit.kind === "FREE_ENTITLEMENT") parts.push("первые 60 минут бесплатно");
  if (benefit.kind === "PARTIAL_PRICE_PERCENT_DISCOUNT") {
    const calculation = benefit.partialPriceCalculation;
    parts.push("первые 60 минут бесплатно");
    parts.push(`доплата за ${Math.max(0, target.target.durationMinutes - 60)} минут`);
    if (participantShare) parts.push(participantShare);
    if (calculation) {
      const percentage = percentageOf(
        calculation.percentageDiscountMinor,
        calculation.chargeBeforeDiscountMinor,
      );
      parts.push(`скидка ${percentage ?? 0}% на доплату ${formatMoney(calculation.percentageDiscountMinor)}`);
    }
  }
  if (benefit.kind === "PERCENT_DISCOUNT" || benefit.kind === "FIXED_DISCOUNT") {
    if (benefit.ruleId === "daily-usage-limit-exceeded") {
      parts.push("бесплатный час использован");
      if (participantShare) parts.push(participantShare);
    }
    const percentage = percentageOf(benefit.discountMinor, benefit.basePriceMinor);
    parts.push(`${percentage === null ? "скидка" : `скидка ${percentage}%`} ${formatMoney(benefit.discountMinor)}`);
  }
  if (benefit.kind === "NONE") parts.push("Без ценовой льготы");
  if (benefit.surchargeMinor > 0) parts.push(`доплата станции ${formatMoney(benefit.surchargeMinor)}`);
  parts.push(`итого ${formatMoney(benefit.finalPriceMinor)}`);
  return parts.join(" · ");
};

const ledgerLabel: Record<string, string> = {
  POLICY_PINNED: "Закреплена тестовая версия правил",
  TEST_STATE_SEEDED: "Задано начальное состояние",
  ELIGIBILITY_QUOTED: "Ограничения проверены",
  ELIGIBILITY_BLOCKED: "Действие заблокировано",
  RESERVATION_CREATED: "Создан тестовый резерв",
  RESERVATION_RELEASED: "Тестовый резерв освобождён",
};

export function ManagedSubscriptionDevPage() {
  const [snapshot, setSnapshot] = useState<DevSnapshot | null>(null);
  const [quotes, setQuotes] = useState<Record<string, ManagedSubscriptionPolicyDecision>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seedCount, setSeedCount] = useState(2);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await apiRequest<DevSnapshot>("/session"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось открыть DEV runtime");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeReservations = useMemo(
    () => snapshot?.reservations.filter((item) => item.status === "ACTIVE") || [],
    [snapshot],
  );

  const runQuote = async (targetId: string) => {
    setBusyKey(`quote:${targetId}`);
    setError(null);
    try {
      const result = await apiRequest<QuoteResult>("/quote", { targetId });
      setQuotes((current) => ({ ...current, [targetId]: result.decision }));
      setSnapshot(result.snapshot);
    } catch (quoteError) {
      const typedError = quoteError as Error & { decision?: ManagedSubscriptionPolicyDecision };
      if (typedError.decision) {
        setQuotes((current) => ({ ...current, [targetId]: typedError.decision as ManagedSubscriptionPolicyDecision }));
      } else {
        setError(typedError.message);
      }
    } finally {
      setBusyKey(null);
    }
  };

  const reserve = async (targetId: string) => {
    setBusyKey(`reserve:${targetId}`);
    setError(null);
    try {
      const result = await apiRequest<{
        decision: ManagedSubscriptionPolicyDecision;
        snapshot: DevSnapshot;
      }>("/reserve", {
        targetId,
        operationId: operationId("reserve"),
      });
      setQuotes((current) => ({ ...current, [targetId]: result.decision }));
      setSnapshot(result.snapshot);
    } catch (reserveError) {
      const typedError = reserveError as Error & { decision?: ManagedSubscriptionPolicyDecision };
      if (typedError.decision) {
        setQuotes((current) => ({ ...current, [targetId]: typedError.decision as ManagedSubscriptionPolicyDecision }));
      }
      setError(typedError.message);
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const release = async (reservationId: string) => {
    setBusyKey(`release:${reservationId}`);
    setError(null);
    try {
      const result = await apiRequest<{ snapshot: DevSnapshot }>("/release", {
        reservationId,
        operationId: operationId("release"),
      });
      setQuotes({});
      setSnapshot(result.snapshot);
    } catch (releaseError) {
      setError(releaseError instanceof Error ? releaseError.message : "Не удалось освободить резерв");
    } finally {
      setBusyKey(null);
    }
  };

  const seed = async () => {
    setBusyKey("seed");
    setError(null);
    try {
      setSnapshot(await apiRequest<DevSnapshot>("/seed", { activeServices: seedCount }));
      setQuotes({});
    } catch (seedError) {
      setError(seedError instanceof Error ? seedError.message : "Не удалось задать тестовое состояние");
    } finally {
      setBusyKey(null);
    }
  };

  const reset = async () => {
    setBusyKey("reset");
    setError(null);
    try {
      setSnapshot(await apiRequest<DevSnapshot>("/reset", {}));
      setQuotes({});
      setSeedCount(2);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Не удалось обновить правила из DEV ЦУП");
    } finally {
      setBusyKey(null);
    }
  };

  if (loading && !snapshot) {
    return <main className="ms-dev-page"><div className="ms-dev-loading">Загружаем правила из DEV ЦУП…</div></main>;
  }

  if (!snapshot) {
    return (
      <main className="ms-dev-page">
        <section className="ms-dev-error-panel" role="alert">
          <h1>DEV-проверка подписки недоступна</h1>
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>Повторить</button>
        </section>
      </main>
    );
  }

  return (
    <main className="ms-dev-page">
      <header className="ms-dev-hero">
        <div>
          <span className="ms-dev-eyebrow">Личный кабинет · DEV SHADOW</span>
          <h1>Проверка ограничений годовой подписки</h1>
          <p>Сервер применяет правила из DEV ЦУП. Viva, деньги и реальные записи не вызываются.</p>
        </div>
        <div className="ms-dev-badges" aria-label="Безопасность теста">
          <span>Только DEV</span>
          <span>Fake provider</span>
          <span>Без списаний</span>
        </div>
      </header>

      {error && <div className="ms-dev-toast" role="alert">{error}</div>}

      <section className="ms-dev-summary" aria-label="Тестовая подписка">
        <article>
          <span>Тестировщик</span>
          <strong>{snapshot.tester.displayPhone}</strong>
          <small>{snapshot.tester.testerRef}</small>
        </article>
        <article>
          <span>Подписка</span>
          <strong>{snapshot.policySource.title}</strong>
          <small>{snapshot.policySource.code} · версия {snapshot.policySource.version}</small>
        </article>
        <article>
          <span>Активные услуги</span>
          <strong>{snapshot.limits.activeServices} / {snapshot.limits.activeServicesEnabled
            ? snapshot.limits.maxActiveServices
            : "∞"}</strong>
          <small>{snapshot.limits.activeServicesEnabled ? "Ограничение включено" : "Ограничение выключено"}</small>
        </article>
        <article>
          <span>Дневной лимит игр</span>
          <strong>{snapshot.limits.dailyUsageLimit} бесплатно</strong>
          <small>{snapshot.limits.dailyLimitExceeded === "PERCENT_DISCOUNT"
            ? `Далее скидка ${snapshot.limits.dailyLimitExceededPercentage}%`
            : "Далее блокировка"}</small>
        </article>
        <article>
          <span>Окно записи</span>
          <strong>{snapshot.limits.bookingWindowEnabled
            ? `${snapshot.limits.bookingWindowDays} дня`
            : "Без ограничения"}</strong>
          <small>Дата проверки: 15 августа 2026</small>
        </article>
      </section>

      <section className="ms-dev-controls">
        <div>
          <h2>Состояние теста</h2>
          <p>Задайте количество уже активных услуг и проверьте следующую попытку записи.</p>
        </div>
        <label>
          Активных услуг
          <select value={seedCount} onChange={(event) => setSeedCount(Number(event.target.value))}>
            {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void seed()} disabled={busyKey !== null}>
          {busyKey === "seed" ? "Применяем…" : "Задать состояние"}
        </button>
        <button className="secondary" type="button" onClick={() => void reset()} disabled={busyKey !== null}>
          {busyKey === "reset" ? "Обновляем…" : "Обновить правила из ЦУП"}
        </button>
      </section>

      <section className="ms-dev-scenarios">
        <div className="ms-dev-section-heading">
          <div>
            <h2>Сценарии пользователя</h2>
            <p>Цена, станция, дата и тип события подставляются сервером.</p>
          </div>
        </div>
        <div className="ms-dev-grid">
          {snapshot.targets.map((target) => {
            const quote = quotes[target.targetId];
            return (
              <article className="ms-dev-card" key={target.targetId}>
                <div className="ms-dev-card-meta">
                  <span>{target.target.category.replaceAll("_", " ")}</span>
                  <span>{target.target.durationMinutes} мин</span>
                </div>
                <h3>{target.title}</h3>
                <p>{target.description}</p>
                <dl>
                  <div><dt>Дата</dt><dd>{formatDateTime(target.target.startsAt)}</dd></div>
                  {target.courtPriceMinor !== null && target.courtPriceMinor !== undefined && <div><dt>Стоимость корта</dt><dd>{formatMoney(target.courtPriceMinor)}</dd></div>}
                  <div><dt>{target.participantCount && target.participantCount > 1 ? `Доля игрока (1/${target.participantCount})` : "Базовая цена"}</dt><dd>{formatMoney(target.target.basePriceMinor)}</dd></div>
                </dl>
                {quote && (
                  <div className={`ms-dev-decision ${quote.eligible ? "allowed" : "blocked"}`}>
                    <strong>{quote.eligible ? "Разрешено" : "Заблокировано"}</strong>
                    {quote.eligible
                      ? <span>{benefitLabel(quote, target)}</span>
                      : <ul>{quote.blockers.map((blocker) => (
                        <li key={blocker.code}>{blocker.message}<code>{blocker.code}</code></li>
                      ))}</ul>}
                  </div>
                )}
                <div className="ms-dev-card-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void runQuote(target.targetId)}
                    disabled={busyKey !== null}
                  >
                    {busyKey === `quote:${target.targetId}` ? "Проверяем…" : "Проверить"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void reserve(target.targetId)}
                    disabled={busyKey !== null || quote?.eligible !== true}
                  >
                    {busyKey === `reserve:${target.targetId}` ? "Резервируем…" : "Создать DEV-резерв"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="ms-dev-reservations">
        <div className="ms-dev-section-heading">
          <div>
            <h2>Активные услуги</h2>
            <p>Освобождение сразу возвращает возможность использования лимита.</p>
          </div>
          <strong>{activeReservations.length}</strong>
        </div>
        {activeReservations.length === 0 ? (
          <div className="ms-dev-empty">Активных тестовых услуг нет.</div>
        ) : (
          <div className="ms-dev-reservation-list">
            {activeReservations.map((reservation) => (
              <article key={reservation.reservationId}>
                <div>
                  <span>{reservation.source === "SEED" ? "Исходное состояние" : "DEV-резерв"}</span>
                  <strong>{reservation.title}</strong>
                  <small>{formatDateTime(reservation.startsAt)} · {reservation.usageUnits} ед.</small>
                </div>
                <button
                  className="danger"
                  type="button"
                  onClick={() => void release(reservation.reservationId)}
                  disabled={busyKey !== null}
                >
                  {busyKey === `release:${reservation.reservationId}` ? "Освобождаем…" : "Отменить DEV-резерв"}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="ms-dev-ledger">
        <div className="ms-dev-section-heading">
          <div>
            <h2>Журнал решений</h2>
            <p>Только технические DEV-события без ФИО и полного телефона.</p>
          </div>
        </div>
        <ol>
          {snapshot.ledger.map((event) => (
            <li key={event.eventId}>
              <time>{new Date(event.occurredAt).toLocaleTimeString("ru-RU")}</time>
              <span>{ledgerLabel[event.type] || event.type}</span>
              {event.targetId && <code>{event.targetId}</code>}
            </li>
          ))}
        </ol>
      </section>

      <footer className="ms-dev-footer">
        DRAFT {snapshot.policySource.sourceStatus} → теневой {snapshot.policySource.runtimeStatus} только в памяти · digest {snapshot.policySource.digest.slice(0, 12)}
      </footer>
    </main>
  );
}
