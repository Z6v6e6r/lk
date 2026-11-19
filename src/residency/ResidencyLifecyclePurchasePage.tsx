import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthForm } from "../components/auth/AuthForm";
import { useAuth } from "../context/authShared";
import { hasZeroAttempt } from "../components/subscription-storefront/zeroCheckoutPayment";
import {
  RESIDENCY_LIFECYCLE_RETURN_TARGET,
  type LifecycleCatalog,
  type LifecycleExternalCheck,
  type LifecycleFailure,
  type LifecycleOrder,
  type LifecycleStatus,
} from "./residencyLifecycleClient.ts";
import { residencyLifecycleClient } from "./residencyLifecycleTransport.ts";
import {
  clearResidencyLifecycleAttempt,
  newResidencyLifecycleKey,
  readResidencyLifecycleAttempt,
  saveResidencyLifecycleAttempt,
} from "./residencyLifecycleAttempt.ts";
import { readResidencyLifecycleRoute, residencyLifecycleLegacyUrl } from "./residencyLifecycleRoute.ts";
import {
  formatResidencyDate,
  formatResidencyMoney,
  resolveResidencyLifecycleDecision,
} from "./residencyLifecyclePurchase.ts";
import "./residency-purchase.css";
import "./residency-lifecycle-purchase.css";

type Phase = "idle" | "loading" | "auth" | "ready" | "creating" | "recovery" | "payment" | "active" | "blocked" | "error";

function safePaymentUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function failureMessage(failure: LifecycleFailure): string {
  if (failure.code === "RESIDENCY_CREATE_NOT_ALLOWED") return "Персональный доступ к новому оформлению не включён для этого аккаунта.";
  if (failure.code === "RESIDENCY_ORDERS_DISABLED") return "Создание новых заказов приостановлено. Уже начатые заказы можно проверить.";
  if (failure.code === "RESIDENCY_CREATE_POLICY_INVALID") return "Персональный доступ не настроен. Оформление недоступно.";
  if (failure.code === "RESIDENCY_EXTERNAL_PURCHASE_PENDING") return "Уже есть покупка резидентства в прежнем оформлении. Не оплачивайте повторно — проверьте её.";
  if (failure.code === "RESIDENCY_EXTERNAL_CHECK_UNAVAILABLE") return "Не удалось проверить наличие другой покупки. Новый заказ не создан; повторите позже.";
  if (failure.code === "RESIDENCY_CLIENT_AUTH_REQUIRED" || failure.status === 401) return "Сессия истекла. Войдите снова.";
  if (failure.networkError) return "Нет связи с сервером. Если оплата уже отправлена, не повторяйте её — сначала проверьте заказ.";
  if (failure.code === "RESIDENCY_PRICE_CHANGED") return "Цена или условия изменились. Прочитайте новую цену и подтвердите её снова.";
  return "Не удалось выполнить запрос. Повторите позже.";
}

export function ResidencyLifecyclePurchasePage() {
  const auth = useAuth();
  const route = useMemo(() => readResidencyLifecycleRoute(typeof window === "undefined" ? "" : window.location.search), []);
  const mounted = useRef(true);
  const busy = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [catalog, setCatalog] = useState<LifecycleCatalog | null>(null);
  const [status, setStatus] = useState<LifecycleStatus | null>(null);
  const [order, setOrder] = useState<LifecycleOrder | null>(null);
  const [externalCheck, setExternalCheck] = useState<LifecycleExternalCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const setSafe = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    if (mounted.current) setter(value);
  }, []);

  const loadOrder = useCallback(async (orderId: string, reconcile: boolean) => {
    const read = await residencyLifecycleClient.getOrder(orderId);
    if (!read.ok) {
      setSafe(setError, failureMessage(read.failure));
      setSafe(setPhase, "error");
      return;
    }
    setSafe(setOrder, read.value);
    if (read.value.state === "ACTIVE") { setSafe(setPhase, "active"); return; }
    if (read.value.recovery.required) {
      setSafe(setPhase, read.value.recovery.state === "AWAITING_PAYMENT" ? "payment" : "recovery");
      return;
    }
    if (reconcile) {
      const attempt = readResidencyLifecycleAttempt();
      const reconcileKey = attempt?.reconcileKey || newResidencyLifecycleKey();
      if (attempt) saveResidencyLifecycleAttempt({ ...attempt, orderId, reconcileKey });
      const result = await residencyLifecycleClient.reconcile(orderId, {
        idempotencyKey: reconcileKey,
        eventId: "lk1-return-" + orderId,
      });
      if (!result.ok) {
        setSafe(setError, failureMessage(result.failure));
        setSafe(setPhase, "recovery");
        return;
      }
      setSafe(setOrder, result.value.order);
      setSafe(setPhase, result.value.order.state === "ACTIVE" ? "active"
        : result.value.order.recovery.state === "AWAITING_PAYMENT" ? "payment" : "recovery");
      return;
    }
    setSafe(setPhase, read.value.state === "PENDING_PAYMENT" ? "payment" : "recovery");
  }, [setSafe]);

  const load = useCallback(async () => {
    if (!auth.isAuthenticated) { setSafe(setPhase, "auth"); return; }
    if (route === null) { setSafe(setPhase, "blocked"); setSafe(setError, "Маршрут нового оформления не распознан."); return; }
    setSafe(setPhase, "loading");
    setSafe(setError, null);
    const unresolved = await residencyLifecycleClient.listUnresolvedDetailed();
    if (!unresolved.ok) {
      if (unresolved.failure.status === 401) { setSafe(setPhase, "auth"); return; }
      setSafe(setError, failureMessage(unresolved.failure));
      setSafe(setPhase, "error");
      return;
    }
    setSafe(setExternalCheck, unresolved.value.externalCheck);
    if (route === "return") {
      const attempt = readResidencyLifecycleAttempt();
      const orderId = unresolved.value.orders[0]?.orderId || attempt?.orderId || null;
      if (!orderId) {
        // A completed activation is no longer "unresolved" and the bank return does not
        // carry an order id. The authoritative status is the only safe proof here.
        const current = await residencyLifecycleClient.readStatus();
        if (current.ok && current.value.state === "ACTIVE") {
          setSafe(setStatus, current.value);
          setSafe(setPhase, "active");
          return;
        }
        setSafe(setPhase, "recovery");
        setSafe(setError, "Заказ не найден. Если оплата была, обратитесь в поддержку клуба — не создавайте новую покупку.");
        return;
      }
      await loadOrder(orderId, true);
      return;
    }
    if (unresolved.value.orders.length) { setSafe(setOrder, unresolved.value.orders[0]); setSafe(setPhase, "recovery"); return; }
    const [nextCatalog, nextStatus] = await Promise.all([
      residencyLifecycleClient.readCatalog(),
      residencyLifecycleClient.readStatus(),
    ]);
    if (!nextCatalog.ok) { setSafe(setError, failureMessage(nextCatalog.failure)); setSafe(setPhase, "error"); return; }
    if (!nextStatus.ok) { setSafe(setError, failureMessage(nextStatus.failure)); setSafe(setPhase, "error"); return; }
    setSafe(setCatalog, nextCatalog.value);
    setSafe(setStatus, nextStatus.value);
    setSafe(setPhase, "ready");
  }, [auth.isAuthenticated, loadOrder, route, setSafe]);

  useEffect(() => { void load(); }, [load]);

  let oldCheckoutPending = false;
  try { oldCheckoutPending = typeof window !== "undefined" && hasZeroAttempt("residency"); } catch { oldCheckoutPending = false; }

  const decision = useMemo(
    () => resolveResidencyLifecycleDecision({ catalog, status, unresolved: order, oldCheckoutPending,
      externalReview: externalCheck?.requiresReview === true }),
    [catalog, status, order, oldCheckoutPending, externalCheck],
  );

  const refreshUnresolved = useCallback(async () => {
    const unresolved = await residencyLifecycleClient.listUnresolvedDetailed();
    if (!unresolved.ok) { setSafe(setError, failureMessage(unresolved.failure)); setSafe(setPhase, "error"); return; }
    setSafe(setExternalCheck, unresolved.value.externalCheck);
    if (unresolved.value.orders.length) { setSafe(setOrder, unresolved.value.orders[0]); setSafe(setPhase, "recovery"); return; }
    setSafe(setNotice, "Сервер не нашёл незавершённый заказ. Если оплата была, обратитесь в поддержку клуба — не создавайте новую покупку.");
  }, [setSafe]);

  const restartAfterTerminal = useCallback(() => {
    // Only a confirmed terminal provider refusal releases the slot. A new purchase is a
    // new user-confirmed operation with a new key; it is never created automatically.
    clearResidencyLifecycleAttempt();
    setSafe(setOrder, null);
    setSafe(setError, null);
    setSafe(setNotice, null);
    setSafe(setPhase, "loading");
    void load();
  }, [load, setSafe]);

  const reconcile = useCallback(async () => {
    if (!order || busy.current) return;
    busy.current = true;
    setSafe(setError, null);
    try {
      const attempt = readResidencyLifecycleAttempt();
      const reconcileKey = attempt?.reconcileKey || newResidencyLifecycleKey();
      if (attempt) saveResidencyLifecycleAttempt({ ...attempt, orderId: order.orderId, reconcileKey });
      const result = await residencyLifecycleClient.reconcile(order.orderId, {
        idempotencyKey: reconcileKey,
        eventId: "lk1-check-" + order.orderId,
      });
      if (!result.ok) { setSafe(setError, failureMessage(result.failure)); return; }
      setSafe(setOrder, result.value.order);
      setSafe(setPhase, result.value.order.state === "ACTIVE" ? "active"
        : result.value.order.recovery.state === "AWAITING_PAYMENT" ? "payment" : "recovery");
    } finally { busy.current = false; }
  }, [order, setSafe]);

  const start = useCallback(async () => {
    if (!catalog || !decision || decision.kind !== "READY" || busy.current) return;
    busy.current = true;
    setSafe(setError, null);
    setSafe(setPhase, "creating");
    const mode = decision.mode;
    const expectedTotalMinor = catalog.product.priceMinor;
    const existing = readResidencyLifecycleAttempt();
    const idempotencyKey = existing && existing.mode === mode && existing.expectedTotalMinor === expectedTotalMinor
      ? existing.idempotencyKey : newResidencyLifecycleKey();
    saveResidencyLifecycleAttempt({ idempotencyKey, mode, expectedTotalMinor, orderId: null, reconcileKey: null, startedAt: Date.now() });
    try {
      const result = await residencyLifecycleClient.createOrder({
        mode,
        expectedTotalMinor,
        expectedProductId: catalog.product.productId,
        idempotencyKey,
        returnTarget: RESIDENCY_LIFECYCLE_RETURN_TARGET,
      });
      if (!result.ok) {
        const code = result.failure.code;
        if (code === "RESIDENCY_ORDER_ALREADY_PENDING" || code === "RESIDENCY_IDEMPOTENCY_CONFLICT") {
          const unresolved = await residencyLifecycleClient.listUnresolvedDetailed();
          if (unresolved.ok && unresolved.value.orders.length) {
            setSafe(setOrder, unresolved.value.orders[0]);
            setSafe(setExternalCheck, unresolved.value.externalCheck);
            setSafe(setPhase, "recovery");
            return;
          }
          setSafe(setError, "Похоже, заказ уже создан. Не создавайте новый — проверьте заказ.");
          setSafe(setPhase, "recovery");
          return;
        }
        if (code === "RESIDENCY_EXTERNAL_PURCHASE_PENDING") {
          // The server found a purchase started outside this checkout. No new order and
          // no provider POST happened; show the existing operation instead of retrying.
          clearResidencyLifecycleAttempt();
          setSafe(setExternalCheck, { state: "OK", openCount: 1, paidAfterOrderCount: 0,
            requiresReview: true, reason: null, retryable: false });
          setSafe(setError, failureMessage(result.failure));
          setSafe(setPhase, "ready");
          return;
        }
        if (code === "RESIDENCY_PRICE_CHANGED") {
          clearResidencyLifecycleAttempt();
          const fresh = await residencyLifecycleClient.readCatalog();
          if (fresh.ok) setSafe(setCatalog, fresh.value);
          setSafe(setNotice, failureMessage(result.failure));
          setSafe(setPhase, "ready");
          return;
        }
        if (result.failure.status === 403 || code === "RESIDENCY_CREATE_NOT_ALLOWED"
          || code === "RESIDENCY_ORDERS_DISABLED" || code === "RESIDENCY_CREATE_POLICY_INVALID") {
          clearResidencyLifecycleAttempt();
          setSafe(setError, failureMessage(result.failure));
          setSafe(setPhase, "blocked");
          return;
        }
        // A lost/unknown create may already own a financial operation. Keep the same key.
        setSafe(setError, failureMessage(result.failure));
        setSafe(setPhase, "recovery");
        return;
      }
      setSafe(setOrder, result.value.order);
      const attempt = readResidencyLifecycleAttempt();
      if (attempt) saveResidencyLifecycleAttempt({ ...attempt, orderId: result.value.order.orderId });
      if (result.value.order.state === "ACTIVE") { setSafe(setPhase, "active"); return; }
      const paymentUrl = safePaymentUrl(result.value.order.payment.paymentUrl);
      if (paymentUrl) { window.location.assign(paymentUrl); return; }
      setSafe(setPhase, result.value.order.recovery.state === "AWAITING_PAYMENT" ? "payment" : "recovery");
    } finally { busy.current = false; }
  }, [catalog, decision, setSafe]);

  if (auth.isRestoringSession || auth.isLoading) {
    return <main className="ph-residency-purchase ph-residency-pilot"><p role="status">Проверяем сессию…</p></main>;
  }
  if (!auth.isAuthenticated) {
    return <main className="ph-residency-purchase ph-residency-pilot">
      <article className="ph-residency-card">
        <h1 className="ph-residency-badge"><span className="ph-residency-plus" aria-hidden="true">+</span><span>Резидент</span></h1>
        <p>Новое оформление резидентства доступно после входа в личный кабинет.</p>
        <AuthForm onLogin={() => { window.location.reload(); }} />
      </article>
    </main>;
  }

  const totalMinor = catalog?.product.priceMinor ?? 79000;
  const modeLabel = decision?.kind === "READY" && decision.mode === "RENEWAL" ? "Продлить резидентство" : "Стать резидентом";
  const paymentUrl = safePaymentUrl(order?.payment.paymentUrl ?? null);

  return <main className="ph-residency-purchase ph-residency-pilot" data-pilot-old-checkout={String(oldCheckoutPending)}
    aria-busy={phase === "loading" || phase === "creating"}>
    <article className="ph-residency-card" aria-labelledby="ph-residency-pilot-title">
      <p className="ph-residency-pilot-badge">Персональный пилот · ЛК1</p>
      <h1 id="ph-residency-pilot-title" className="ph-residency-badge">
        <span className="ph-residency-plus" aria-hidden="true">+</span>
        <span>Резидент</span>
      </h1>
      <p className="ph-residency-price"><strong>{formatResidencyMoney(totalMinor)}</strong><span>/ 30 дней</span></p>
      <hr className="ph-residency-divider" />
      <ul className="ph-residency-benefits">
        <li><strong>30%</strong><span>Скидка на создание / участие в игре</span></li>
        <li><strong>50%</strong><span>Скидка на форматы: игра + тренер, групповые тренировки, лига «Время на друзей», турниры ПадлхАБ</span></li>
      </ul>

      {phase === "loading" && <p role="status">Проверяем доступ и условия…</p>}
      {phase === "creating" && <p role="status">Создаём заказ. Не закрывайте страницу.</p>}

      {externalCheck?.state === "UNAVAILABLE" && <p role="status" className="ph-residency-pilot-notice">Не удалось проверить прежнее оформление на сервере. Новый заказ сервер не создаст до успешной проверки.</p>}
      {notice && <p role="status" className="ph-residency-pilot-notice">{notice}</p>}
      {error && <p role="alert" className="ph-residency-pilot-error">{error}</p>}

      {phase === "blocked" && <>
        <p>Оформление недоступно для этого аккаунта или приостановлено.</p>
        <a className="ph-residency-pilot-link" href={residencyLifecycleLegacyUrl()}>Открыть прежнее оформление</a>
      </>}

      {phase === "ready" && decision?.kind === "BLOCKED" && <>
        <p role="status">{decision.message}</p>
        {(decision.code === "LEGACY_CHECKOUT_PENDING" || decision.code === "EXTERNAL_CHECKOUT_PENDING")
          && <a className="ph-residency-pilot-link" href={residencyLifecycleLegacyUrl()}>Проверить прежнее оформление</a>}
        {decision.eligibleAt && <p className="ph-residency-pilot-muted">Доступно с {formatResidencyDate(decision.eligibleAt)}</p>}
      </>}

      {phase === "ready" && decision?.kind === "READY" && <>
        <p className="ph-residency-pilot-muted">Цена и условия прочитаны с сервера. Нажимая кнопку, вы подтверждаете итоговую сумму {formatResidencyMoney(totalMinor)}.</p>
        <button className="ph-residency-cta" type="button" onClick={() => { void start(); }}>
          {modeLabel} · {formatResidencyMoney(totalMinor)}
        </button>
      </>}

      {phase === "recovery" && !order && <>
        <p role="status">Заказ не подтверждён в этой сессии. Проверьте его на сервере — не создавайте новую покупку.</p>
        <button className="ph-residency-pilot-secondary" type="button" onClick={() => { void refreshUnresolved(); }}>Проверить мой заказ</button>
      </>}

      {phase === "active" && !order && status && <>
        <section className="ph-residency-pilot-order" aria-label="Состояние резидентства">
          <p><strong>Резидентство активно</strong>{status.validUntil ? " до " + formatResidencyDate(status.validUntil) : ""}</p>
          <p className="ph-residency-pilot-muted">Скидки 30% на игры и 50% на групповые тренировки и турниры действуют в оплаченный период.</p>
        </section>
      </>}

      {(phase === "payment" || phase === "recovery" || phase === "active" || phase === "error") && order && <>
        <section className="ph-residency-pilot-order" aria-label="Состояние заказа">
          <p><strong>Заказ:</strong> {order.state === "ACTIVE" ? "резидентство активно"
            : order.state === "PAID_REQUIRES_REVIEW" ? "оплата требует проверки"
            : order.state === "PAYMENT_FAILED" ? "оплата не прошла"
            : order.payment.status === "UNKNOWN" ? "результат оплаты неизвестен"
            : order.payment.status === "PENDING" ? "ожидает оплаты" : "обрабатывается"}</p>
          {order.residency?.validUntil && <p>Действует до {formatResidencyDate(order.residency.validUntil)}</p>}
          {order.payment.instruction && <p className="ph-residency-pilot-muted">{order.payment.instruction}</p>}
        </section>
        {phase !== "active" && paymentUrl && <a className="ph-residency-cta" href={paymentUrl} rel="noopener noreferrer">Открыть ссылку на оплату</a>}
        {phase !== "active" && <button className="ph-residency-pilot-secondary" type="button" onClick={() => { void reconcile(); }}>Проверить оплату</button>}
        {phase === "recovery" && <button className="ph-residency-pilot-secondary" type="button" onClick={() => { void refreshUnresolved(); }}>Найти мой незавершённый заказ</button>}
        {order && ["PAYMENT_FAILED", "EXPIRED", "CANCELLED"].includes(order.state)
          && <button className="ph-residency-pilot-secondary" type="button" onClick={restartAfterTerminal}>Начать новую покупку</button>}
        {order.state === "PAID_REQUIRES_REVIEW" || order.state === "ACTIVATION_FAILED" ? <p role="alert">Оплата получена, но резидентство требует проверки. Обратитесь в поддержку клуба.</p> : null}
        {phase === "active" && <p role="status">Резидентство активно. Скидки 30% на игры и 50% на групповые тренировки и турниры действуют в оплаченный период.</p>}
      </>}

      <p className="ph-residency-pilot-muted">Новое оформление. Условия и цена проверяются на сервере; повторная оплата при неизвестном результате не создаётся.</p>
    </article>
  </main>;
}
