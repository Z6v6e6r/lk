import { useCallback, useEffect, useMemo, useState } from "react";
import { PHAB_API_BASE } from "../../consts/api_config";
import type { ManagedSubscriptionPolicyDecision } from "../../types/managedSubscriptionRuntime";
import type { SubscriptionUsageTestCredentials } from "./subscriptionUsageTestRoute";
import { subscriptionUsageTestApiPath } from "./subscriptionUsageTestRoute";
import "./ManagedSubscriptionDevPage.css";

interface HostedTarget {
  targetId: string;
  title: string;
  description: string;
  action: "CREATE_GAME" | "JOIN_GAME" | "BOOK_GROUP_TRAINING" | "BOOK_TOURNAMENT";
  courtPriceMinor?: number | null;
  participantCount?: number;
  target: {
    category: string;
    durationMinutes: number;
    startsAt: string;
    basePriceMinor: number | null;
  };
}

interface HostedScenario {
  mode: "HOSTED_DEV_SHADOW";
  testOnly: true;
  providerMode: "FAKE_NO_VIVA";
  evaluatedAt: string;
  offer: { offerId: string; title: string; stationId: string; timeZone: string };
  policySource: {
    sourceStatus: string;
    runtimeStatus: "PUBLISHED";
    sourceModelVersion: number;
    version: number;
    digest: string;
  };
  limits: {
    activeServicesEnabled: boolean;
    maxActiveServices: number | null;
    bookingWindowEnabled: boolean;
    bookingWindowDays: number | null;
    dailyUsageLimit: number;
    dailyUsageActions: string[];
    dailyLimitExceeded: "BLOCK" | "PERCENT_DISCOUNT";
    dailyLimitExceededPercentage: number | null;
  };
  targets: HostedTarget[];
}

interface HostedQuoteResult {
  target: HostedTarget;
  decision: ManagedSubscriptionPolicyDecision;
}

interface LocalReservation {
  reservationId: string;
  targetId: string;
  title: string;
  action: HostedTarget["action"];
  startsAt: string;
  usageUnits: number;
  finalPriceMinor: number | null;
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string; details?: { issues?: string[] } };
}

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

const participantShareLabel = (target: HostedTarget) => (
  (target.participantCount ?? 1) > 1 ? `доля игрока 1/${target.participantCount}` : null
);

const benefitLabel = (decision: ManagedSubscriptionPolicyDecision, target: HostedTarget) => {
  const benefit = decision.benefit;
  if (!benefit) return "Льгота не рассчитана";
  const parts: string[] = [];
  const participantShare = participantShareLabel(target);
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
  if (benefit.kind === "NONE") parts.push("без льготы");
  parts.push(`итого ${formatMoney(benefit.finalPriceMinor)}`);
  return parts.join(" · ");
};

export function HostedSubscriptionUsageTestPage({
  credentials,
}: {
  credentials: SubscriptionUsageTestCredentials | null;
}) {
  const [scenario, setScenario] = useState<HostedScenario | null>(null);
  const [quotes, setQuotes] = useState<Record<string, ManagedSubscriptionPolicyDecision>>({});
  const [reservations, setReservations] = useState<LocalReservation[]>([]);
  const [activeServices, setActiveServices] = useState(0);
  const [dailyGameUsage, setDailyGameUsage] = useState(0);
  const [draftActiveServices, setDraftActiveServices] = useState(0);
  const [draftDailyGameUsage, setDraftDailyGameUsage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiRequest = useCallback(async <T,>(operation: "snapshot" | "quote", body?: object): Promise<T> => {
    if (!credentials) throw new Error("В ссылке отсутствуют offerId или секретный DEV-токен");
    const response = await fetch(`${PHAB_API_BASE}${subscriptionUsageTestApiPath(credentials.offerId, operation)}`, {
      method: body ? "POST" : "GET",
      headers: {
        "X-Subscription-Test-Token": credentials.token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const payload = await response.json() as T & ApiErrorPayload;
    if (!response.ok) {
      const details = payload.error?.details?.issues?.join("; ");
      throw new Error(details || payload.error?.message || "Hosted DEV runtime недоступен");
    }
    return payload;
  }, [credentials]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setScenario(await apiRequest<HostedScenario>("snapshot"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить правила из ЦУП");
    } finally {
      setLoading(false);
    }
  }, [apiRequest]);

  useEffect(() => { void load(); }, [load]);

  const quote = useCallback(async (targetId: string) => apiRequest<HostedQuoteResult>("quote", {
    targetId,
    activeServices,
    dailyGameUsage,
  }), [activeServices, apiRequest, dailyGameUsage]);

  const runQuote = async (targetId: string) => {
    setBusyKey(`quote:${targetId}`);
    setError(null);
    try {
      const result = await quote(targetId);
      setQuotes((current) => ({ ...current, [targetId]: result.decision }));
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : "Не удалось рассчитать ограничения");
    } finally {
      setBusyKey(null);
    }
  };

  const reserve = async (target: HostedTarget) => {
    setBusyKey(`reserve:${target.targetId}`);
    setError(null);
    try {
      const result = await quote(target.targetId);
      setQuotes((current) => ({ ...current, [target.targetId]: result.decision }));
      if (!result.decision.eligible) throw new Error("Повторная проверка заблокировала DEV-резерв");
      setReservations((current) => [...current, {
        reservationId: `browser-only:${crypto.randomUUID()}`,
        targetId: target.targetId,
        title: target.title,
        action: target.action,
        startsAt: target.target.startsAt,
        usageUnits: result.decision.usageUnits ?? 1,
        finalPriceMinor: result.decision.benefit?.finalPriceMinor ?? null,
      }]);
      const nextActiveServices = Math.min(activeLimit, activeServices + 1);
      setActiveServices(nextActiveServices);
      setDraftActiveServices(nextActiveServices);
      if (target.action === "CREATE_GAME" || target.action === "JOIN_GAME") {
        const nextDailyGameUsage = Math.min(4, dailyGameUsage + (result.decision.usageUnits ?? 1));
        setDailyGameUsage(nextDailyGameUsage);
        setDraftDailyGameUsage(nextDailyGameUsage);
      }
      setQuotes({});
    } catch (reserveError) {
      setError(reserveError instanceof Error ? reserveError.message : "DEV-резерв не создан");
    } finally {
      setBusyKey(null);
    }
  };

  const release = (reservation: LocalReservation) => {
    setReservations((current) => current.filter((item) => item.reservationId !== reservation.reservationId));
    const nextActiveServices = Math.max(0, activeServices - 1);
    setActiveServices(nextActiveServices);
    setDraftActiveServices(nextActiveServices);
    if (reservation.action === "CREATE_GAME" || reservation.action === "JOIN_GAME") {
      const nextDailyGameUsage = Math.max(0, dailyGameUsage - reservation.usageUnits);
      setDailyGameUsage(nextDailyGameUsage);
      setDraftDailyGameUsage(nextDailyGameUsage);
    }
    setQuotes({});
  };

  const applyState = () => {
    setActiveServices(draftActiveServices);
    setDailyGameUsage(draftDailyGameUsage);
    setReservations([]);
    setQuotes({});
  };

  const reset = async () => {
    setActiveServices(0);
    setDailyGameUsage(0);
    setDraftActiveServices(0);
    setDraftDailyGameUsage(0);
    setReservations([]);
    setQuotes({});
    await load();
  };

  const activeLimit = scenario?.limits.maxActiveServices ?? 4;
  const stateOptions = useMemo(() => Array.from({ length: activeLimit + 1 }, (_, value) => value), [activeLimit]);

  if (loading && !scenario) {
    return <main className="ms-dev-page"><div className="ms-dev-loading">Загружаем правила тестового оффера из ЦУП…</div></main>;
  }
  if (!scenario) {
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
          <span className="ms-dev-eyebrow">lk_dev · HOSTED DEV SHADOW</span>
          <h1>Ограничения годовой подписки</h1>
          <p>Правила прочитаны из тестового оффера ЦУП. Все резервы ниже живут только в этом браузере.</p>
        </div>
        <div className="ms-dev-badges" aria-label="Безопасность теста">
          <span>Только DEV</span><span>Fake provider</span><span>Без Viva и списаний</span>
        </div>
      </header>

      {error && <div className="ms-dev-toast" role="alert">{error}</div>}

      <section className="ms-dev-summary" aria-label="Тестовая подписка">
        <article><span>Тестовый оффер</span><strong>{scenario.offer.title}</strong><small>{scenario.offer.offerId}</small></article>
        <article><span>Версия ЦУП</span><strong>{scenario.policySource.version}</strong><small>{scenario.policySource.sourceStatus} → in-memory {scenario.policySource.runtimeStatus}</small></article>
        <article><span>Активные услуги</span><strong>{activeServices} / {activeLimit}</strong><small>Четвёртая разрешена, пятая блокируется</small></article>
        <article><span>Игровых услуг сегодня</span><strong>{dailyGameUsage} / {scenario.limits.dailyUsageLimit} бесплатно</strong><small>Далее скидка {scenario.limits.dailyLimitExceededPercentage}%</small></article>
        <article><span>Окно записи</span><strong>{scenario.limits.bookingWindowEnabled ? `${scenario.limits.bookingWindowDays} дня` : "Без ограничения"}</strong><small>Станция {scenario.offer.stationId}</small></article>
      </section>

      <section className="ms-dev-controls">
        <div><h2>Начальное состояние</h2><p>Задайте счётчики перед проверкой. На сервер ничего не записывается.</p></div>
        <label>Активных услуг
          <select value={draftActiveServices} onChange={(event) => setDraftActiveServices(Number(event.target.value))}>
            {stateOptions.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>Игр использовано сегодня
          <select value={draftDailyGameUsage} onChange={(event) => setDraftDailyGameUsage(Number(event.target.value))}>
            {[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" onClick={applyState} disabled={busyKey !== null}>Задать состояние</button>
        <button className="secondary" type="button" onClick={() => void reset()} disabled={busyKey !== null}>Обновить правила из ЦУП</button>
      </section>

      <section className="ms-dev-scenarios">
        <div className="ms-dev-section-heading"><div><h2>Согласованные сценарии</h2><p>Цена, станция, дата и тип события формируются backend, а не браузером.</p></div></div>
        <div className="ms-dev-grid">
          {scenario.targets.map((target) => {
            const decision = quotes[target.targetId];
            return (
              <article className="ms-dev-card" key={target.targetId}>
                <div className="ms-dev-card-meta"><span>{target.target.category.replaceAll("_", " ")}</span><span>{target.target.durationMinutes} мин</span></div>
                <h3>{target.title}</h3><p>{target.description}</p>
                <dl>
                  <div><dt>Дата</dt><dd>{formatDateTime(target.target.startsAt)}</dd></div>
                  {target.courtPriceMinor !== null && target.courtPriceMinor !== undefined && <div><dt>Стоимость корта</dt><dd>{formatMoney(target.courtPriceMinor)}</dd></div>}
                  <div><dt>{(target.participantCount ?? 1) > 1 ? `Доля игрока (1/${target.participantCount})` : "Базовая цена"}</dt><dd>{formatMoney(target.target.basePriceMinor)}</dd></div>
                </dl>
                {decision && (
                  <div className={`ms-dev-decision ${decision.eligible ? "allowed" : "blocked"}`}>
                    <strong>{decision.eligible ? "Разрешено" : "Заблокировано"}</strong>
                    {decision.eligible ? <span>{benefitLabel(decision, target)}</span> : <ul>{decision.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}<code>{blocker.code}</code></li>)}</ul>}
                  </div>
                )}
                <div className="ms-dev-card-actions">
                  <button className="secondary" type="button" onClick={() => void runQuote(target.targetId)} disabled={busyKey !== null}>{busyKey === `quote:${target.targetId}` ? "Проверяем…" : "Проверить"}</button>
                  <button type="button" onClick={() => void reserve(target)} disabled={busyKey !== null || decision?.eligible !== true}>{busyKey === `reserve:${target.targetId}` ? "Проверяем…" : "Создать browser-only резерв"}</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="ms-dev-reservations">
        <div className="ms-dev-section-heading"><div><h2>Резервы этой вкладки</h2><p>Отмена меняет только локальные тестовые счётчики.</p></div><strong>{reservations.length}</strong></div>
        {reservations.length === 0 ? <div className="ms-dev-empty">Browser-only резервов нет.</div> : <div className="ms-dev-reservation-list">{reservations.map((reservation) => (
          <article key={reservation.reservationId}><div><span>Не отправлен в Viva</span><strong>{reservation.title}</strong><small>{formatDateTime(reservation.startsAt)} · итого {formatMoney(reservation.finalPriceMinor)}</small></div><button className="danger" type="button" onClick={() => release(reservation)}>Отменить локально</button></article>
        ))}</div>}
      </section>

      <footer className="ms-dev-footer">TEST ONLY · provider calls 0 · backend writes 0 · digest {scenario.policySource.digest.slice(0, 19)}</footer>
    </main>
  );
}
