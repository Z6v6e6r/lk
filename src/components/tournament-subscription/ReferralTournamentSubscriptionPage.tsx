import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import {
  apiConfirmReferralSubscriptionPurchase,
  apiCreateReferralSubscriptionPurchase,
  apiFetchProfile,
  apiFetchReferralSubscriptionStatus,
  type ReferralSubscriptionPlanStatus,
  type ReferralSubscriptionStatusPayload,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  normalizeReferralPhone,
  type ReferralSubscriptionFlowType,
  type ReferralSubscriptionPlanKey,
} from "../../utils/referralSubscription";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import logoHabWhite from "../../assets/logo hab white.svg";
import referralSubscriptionAcademyImage from "../../assets/referral-subscription-academy.webp";
import referralSubscriptionFriendshipImage from "../../assets/referral-subscription-friendship.webp";
import referralSubscriptionRaImage from "../../assets/referral-subscription-ra.webp";
import referralSubscriptionSportImage from "../../assets/referral-subscription-sport.webp";

interface ReferralTournamentSubscriptionPageProps {
  onBack: () => void;
  inviteId: string | null;
  ownerPhone: string | null;
  ownerSubscriptionId: string | null;
  mode: ReferralSubscriptionFlowType;
}

interface DisplayPlanConfig {
  id: ReferralSubscriptionPlanKey;
  artworkAlt: string;
  artworkSrc: string;
}

interface PendingReferralPaymentEntry {
  inviteId: string | null;
  ownerPhone: string | null;
  ownerSubscriptionId: string | null;
  mode: ReferralSubscriptionFlowType;
  paymentRef: string;
  planKey: ReferralSubscriptionPlanKey;
  createdAt: string;
}

interface PendingPurchaseRequest {
  planKey: ReferralSubscriptionPlanKey;
}

const REFERRAL_PAYMENT_REF_QUERY_KEY = "referralPaymentRef";
const PENDING_REFERRAL_PAYMENT_STORAGE_KEY = "padlhub_referral_subscription_pending_refs";
const PENDING_REFERRAL_PAYMENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const DISPLAY_PLANS: DisplayPlanConfig[] = [
  {
    id: "friendship",
    artworkAlt: "Реферальный абонемент Лето.Падел.Дружба",
    artworkSrc: referralSubscriptionFriendshipImage,
  },
  {
    id: "sport",
    artworkAlt: "Реферальный абонемент Лето.Падел.Спорт",
    artworkSrc: referralSubscriptionSportImage,
  },
  {
    id: "academy",
    artworkAlt: "Реферальный абонемент Лето.Падел.Академия",
    artworkSrc: referralSubscriptionAcademyImage,
  },
  {
    id: "ra",
    artworkAlt: "Реферальный абонемент Лето.Падел.РА",
    artworkSrc: referralSubscriptionRaImage,
  },
];

function trimText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizePlanKey(value: unknown): ReferralSubscriptionPlanKey | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "academy" || normalized === "friendship" || normalized === "ra" || normalized === "sport") {
    return normalized;
  }
  return null;
}

function normalizeFlowType(value: unknown): ReferralSubscriptionFlowType {
  return String(value || "").trim().toLowerCase() === "renewal" ? "renewal" : "share";
}

function buildPaymentRef() {
  return `referral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildReturnUrl() {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  url.searchParams.delete(REFERRAL_PAYMENT_REF_QUERY_KEY);
  return appendCurrentAuthModeToNavigableUrl(url).toString();
}

function readPaymentRefFromUrl() {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  return trimText(url.searchParams.get(REFERRAL_PAYMENT_REF_QUERY_KEY));
}

function clearPaymentRefInUrl() {
  if (typeof window === "undefined") return;
  const current = new URL(window.location.href);
  if (!current.searchParams.has(REFERRAL_PAYMENT_REF_QUERY_KEY)) return;
  current.searchParams.delete(REFERRAL_PAYMENT_REF_QUERY_KEY);
  window.history.replaceState(window.history.state, document.title, `${current.pathname}${current.search}${current.hash}`);
}

function readPendingPaymentEntries(): PendingReferralPaymentEntry[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(PENDING_REFERRAL_PAYMENT_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    return parsed
      .map((candidate) => {
        if (!candidate || typeof candidate !== "object") return null;
        const paymentRef = trimText((candidate as PendingReferralPaymentEntry).paymentRef);
        const inviteId = trimText((candidate as PendingReferralPaymentEntry).inviteId);
        const ownerPhone = normalizeReferralPhone((candidate as PendingReferralPaymentEntry).ownerPhone);
        const ownerSubscriptionId = trimText((candidate as PendingReferralPaymentEntry).ownerSubscriptionId);
        const mode = normalizeFlowType((candidate as PendingReferralPaymentEntry).mode);
        const planKey = normalizePlanKey((candidate as PendingReferralPaymentEntry).planKey);
        const createdAt = trimText((candidate as PendingReferralPaymentEntry).createdAt) || new Date(now).toISOString();

        if (!paymentRef || !planKey || (!inviteId && (!ownerPhone || !ownerSubscriptionId))) return null;
        const createdAtTs = Date.parse(createdAt);
        if (Number.isFinite(createdAtTs) && createdAtTs < now - PENDING_REFERRAL_PAYMENT_MAX_AGE_MS) {
          return null;
        }

        return {
          inviteId,
          paymentRef,
          ownerPhone,
          ownerSubscriptionId,
          mode,
          planKey,
          createdAt,
        };
      })
      .filter((entry): entry is PendingReferralPaymentEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function writePendingPaymentEntries(entries: PendingReferralPaymentEntry[]) {
  if (typeof window === "undefined") return;

  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(PENDING_REFERRAL_PAYMENT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_REFERRAL_PAYMENT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage write errors
  }
}

function upsertPendingPaymentEntry(entry: PendingReferralPaymentEntry) {
  const current = readPendingPaymentEntries().filter((item) => item.paymentRef !== entry.paymentRef);
  current.unshift(entry);
  writePendingPaymentEntries(current.slice(0, 12));
}

function removePendingPaymentEntry(paymentRef: string | null | undefined) {
  const normalizedPaymentRef = trimText(paymentRef);
  if (!normalizedPaymentRef) return;
  const current = readPendingPaymentEntries().filter((item) => item.paymentRef !== normalizedPaymentRef);
  writePendingPaymentEntries(current);
}

function mapStatusesByPlanKey(
  payload: ReferralSubscriptionStatusPayload | null,
): Record<ReferralSubscriptionPlanKey, ReferralSubscriptionPlanStatus | null> {
  const mapped: Record<ReferralSubscriptionPlanKey, ReferralSubscriptionPlanStatus | null> = {
    academy: null,
    friendship: null,
    ra: null,
    sport: null,
  };

  payload?.plans.forEach((status) => {
    const planKey = normalizePlanKey(status.planKey);
    if (!planKey || mapped[planKey]) return;
    mapped[planKey] = status;
  });

  return mapped;
}

export default function ReferralTournamentSubscriptionPage({
  onBack,
  inviteId,
  ownerPhone,
  ownerSubscriptionId,
  mode,
}: ReferralTournamentSubscriptionPageProps) {
  const { isAuthenticated } = useAuth();
  const normalizedInviteId = useMemo(() => trimText(inviteId), [inviteId]);
  const normalizedOwnerPhone = useMemo(() => normalizeReferralPhone(ownerPhone), [ownerPhone]);
  const normalizedOwnerSubscriptionId = useMemo(() => trimText(ownerSubscriptionId), [ownerSubscriptionId]);

  const [statusPayload, setStatusPayload] = useState<ReferralSubscriptionStatusPayload | null>(null);
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [buyingPlanKey, setBuyingPlanKey] = useState<ReferralSubscriptionPlanKey | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [buyErrorByPlanKey, setBuyErrorByPlanKey] = useState<Record<string, string | null>>({});
  const [buyInfo, setBuyInfo] = useState<string | null>(null);
  const [authRequestedPlanKey, setAuthRequestedPlanKey] = useState<ReferralSubscriptionPlanKey | null>(null);
  const [pendingPurchaseRequest, setPendingPurchaseRequest] = useState<PendingPurchaseRequest | null>(null);
  const [useLegacyOwnerFallback, setUseLegacyOwnerFallback] = useState(false);

  const statusByPlanKey = useMemo(() => mapStatusesByPlanKey(statusPayload), [statusPayload]);
  const visiblePlans = useMemo(() => {
    if (mode !== "renewal") return DISPLAY_PLANS;
    const renewalPlanKey = normalizePlanKey(statusPayload?.plans?.[0]?.planKey);
    return renewalPlanKey
      ? DISPLAY_PLANS.filter((plan) => plan.id === renewalPlanKey)
      : [];
  }, [mode, statusPayload?.plans]);
  const hasLegacyOwnerFallback = Boolean(normalizedOwnerPhone && normalizedOwnerSubscriptionId);
  const effectiveInviteId = useLegacyOwnerFallback ? null : normalizedInviteId;
  const effectiveOwnerPhone = effectiveInviteId ? null : normalizedOwnerPhone;
  const effectiveOwnerSubscriptionId = effectiveInviteId ? null : normalizedOwnerSubscriptionId;

  const loadStatus = useCallback(async () => {
    if (!normalizedInviteId && (!normalizedOwnerPhone || !normalizedOwnerSubscriptionId)) {
      setStatusError("В ссылке не хватает inviteId или данных владельца подписки.");
      return;
    }

    setLoadingStatus(true);
    setStatusError(null);
    try {
      const result = await apiFetchReferralSubscriptionStatus({
        inviteId: normalizedInviteId,
        ownerPhone: normalizedInviteId ? null : normalizedOwnerPhone,
        ownerSubscriptionId: normalizedInviteId ? null : normalizedOwnerSubscriptionId,
        mode,
      });
      if (!result.data && normalizedInviteId && hasLegacyOwnerFallback && result.status === 404) {
        const legacyResult = await apiFetchReferralSubscriptionStatus({
          inviteId: null,
          ownerPhone: normalizedOwnerPhone,
          ownerSubscriptionId: normalizedOwnerSubscriptionId,
          mode,
        });
        if (legacyResult.data) {
          setUseLegacyOwnerFallback(true);
          setStatusPayload(legacyResult.data);
          return;
        }
      }
      if (!result.data) {
        setUseLegacyOwnerFallback(false);
        setStatusPayload(null);
        setStatusError(result.error?.message || "Не удалось загрузить реферальную страницу.");
        return;
      }
      setUseLegacyOwnerFallback(false);
      setStatusPayload(result.data);
    } finally {
      setLoadingStatus(false);
    }
  }, [hasLegacyOwnerFallback, mode, normalizedInviteId, normalizedOwnerPhone, normalizedOwnerSubscriptionId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!isAuthenticated) {
      setProfile(null);
      return;
    }

    let active = true;
    const loadProfile = async () => {
      setLoadingProfile(true);
      try {
        const result = await apiFetchProfile();
        if (active) {
          setProfile(result.data || null);
        }
      } finally {
        if (active) {
          setLoadingProfile(false);
        }
      }
    };

    void loadProfile();
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const handleConfirmPayment = useCallback(async (paymentRef: string) => {
    if (!normalizedInviteId && (!normalizedOwnerPhone || !normalizedOwnerSubscriptionId)) return;

    const pendingEntry = readPendingPaymentEntries().find((entry) => entry.paymentRef === paymentRef) || null;
    const result = await apiConfirmReferralSubscriptionPurchase(paymentRef, {
      inviteId: useLegacyOwnerFallback ? null : (pendingEntry?.inviteId || normalizedInviteId),
      ownerPhone: useLegacyOwnerFallback
        ? (pendingEntry?.ownerPhone || normalizedOwnerPhone)
        : (pendingEntry?.inviteId ? null : (pendingEntry?.ownerPhone || normalizedOwnerPhone)),
      ownerSubscriptionId: useLegacyOwnerFallback
        ? (pendingEntry?.ownerSubscriptionId || normalizedOwnerSubscriptionId)
        : (pendingEntry?.inviteId ? null : (pendingEntry?.ownerSubscriptionId || normalizedOwnerSubscriptionId)),
      mode: pendingEntry?.mode ?? mode,
      planKey: pendingEntry?.planKey ?? null,
    });

    removePendingPaymentEntry(paymentRef);
    clearPaymentRefInUrl();

    if (!result.data) {
      setBuyInfo(null);
      setStatusError(result.error?.message || "Не удалось проверить оплату.");
      return;
    }

    if (result.data.paid) {
      setBuyInfo("Оплата подтверждена. Лимит по этой ссылке обновлен.");
    } else if (result.data.failed) {
      setBuyInfo("Оплата не завершена. Попробуйте создать новый платеж.");
    } else {
      setBuyInfo("Платеж еще обрабатывается. Страница обновлена.");
    }

    await loadStatus();
  }, [loadStatus, mode, normalizedInviteId, normalizedOwnerPhone, normalizedOwnerSubscriptionId, useLegacyOwnerFallback]);

  useEffect(() => {
    const paymentRef = readPaymentRefFromUrl();
    if (!paymentRef || (!normalizedInviteId && (!normalizedOwnerPhone || !normalizedOwnerSubscriptionId))) return;
    void handleConfirmPayment(paymentRef);
  }, [handleConfirmPayment, normalizedInviteId, normalizedOwnerPhone, normalizedOwnerSubscriptionId]);

  const beginPurchase = useCallback(async (planKey: ReferralSubscriptionPlanKey) => {
    if (!normalizedInviteId && (!normalizedOwnerPhone || !normalizedOwnerSubscriptionId)) {
      setStatusError("В ссылке не хватает inviteId или данных владельца подписки.");
      return;
    }

    if (!isAuthenticated) {
      setAuthRequestedPlanKey(planKey);
      return;
    }

    const clientPhone = trimText(profile?.phone);
    if (!clientPhone) {
      setBuyErrorByPlanKey((current) => ({
        ...current,
        [planKey]: "Не удалось определить ваш номер телефона для оплаты.",
      }));
      return;
    }

    setBuyingPlanKey(planKey);
    setBuyInfo(null);
    setStatusError(null);
    setBuyErrorByPlanKey((current) => ({ ...current, [planKey]: null }));

    try {
      const paymentRef = buildPaymentRef();
      const baseRedirectUrl = buildReturnUrl();
      const result = await apiCreateReferralSubscriptionPurchase({
        inviteId: effectiveInviteId,
        ownerPhone: effectiveOwnerPhone,
        ownerSubscriptionId: effectiveOwnerSubscriptionId,
        mode,
        clientPhone,
        clientId: profile?.id ?? null,
        planKey,
        paymentRef,
        baseRedirectUrl,
      });

      if (!result.data) {
        setBuyErrorByPlanKey((current) => ({
          ...current,
          [planKey]: result.error?.message || "Не удалось создать оплату.",
        }));
        await loadStatus();
        return;
      }

      upsertPendingPaymentEntry({
        inviteId: normalizedInviteId,
        paymentRef: result.data.paymentRef || paymentRef,
        ownerPhone: normalizedOwnerPhone,
        ownerSubscriptionId: normalizedOwnerSubscriptionId,
        mode,
        planKey,
        createdAt: new Date().toISOString(),
      });

      if (result.data.paymentUrl) {
        window.location.href = result.data.paymentUrl;
        return;
      }

      setBuyInfo("Платеж создан. Проверьте статус ниже.");
      await loadStatus();
    } finally {
      setBuyingPlanKey(null);
    }
  }, [
    effectiveInviteId,
    effectiveOwnerPhone,
    effectiveOwnerSubscriptionId,
    isAuthenticated,
    loadStatus,
    mode,
    normalizedInviteId,
    normalizedOwnerPhone,
    normalizedOwnerSubscriptionId,
    profile?.id,
    profile?.phone,
  ]);

  useEffect(() => {
    if (!pendingPurchaseRequest || !isAuthenticated || !profile) return;
    const request = pendingPurchaseRequest;
    setPendingPurchaseRequest(null);
    void beginPurchase(request.planKey);
  }, [beginPurchase, isAuthenticated, pendingPurchaseRequest, profile]);

  const handleAuthSuccess = useCallback(() => {
    if (!authRequestedPlanKey) return;
    setPendingPurchaseRequest({ planKey: authRequestedPlanKey });
    setAuthRequestedPlanKey(null);
  }, [authRequestedPlanKey]);

  const isRenewalMode = mode === "renewal";

  return (
    <div className="tournament-subscription-page">
      <div className="tournament-subscription-pattern" aria-hidden="true" />
      <header className="tournament-subscription-header">
        <button type="button" className="tournament-subscription-back" onClick={onBack}>Назад</button>
        <img src={logoHabWhite} alt="ПадлхАБ" className="tournament-subscription-logo" />
      </header>

      <section className="tournament-subscription-plans">
        {loadingStatus && <div className="tournament-subscription-global-message tournament-subscription-updated">Обновляем витрину…</div>}
        {statusError && <div className="tournament-subscription-global-message tournament-subscription-error">{statusError}</div>}
        {buyInfo && <div className="tournament-subscription-global-message tournament-subscription-info">{buyInfo}</div>}
        {visiblePlans.map((plan) => {
          const status = statusByPlanKey[plan.id];
          const remainingCount = status?.remainingCount ?? 0;
          const totalLimit = status?.totalLimit ?? 1;
          const canPurchase = Boolean(status?.canPurchase) && remainingCount > 0;
          const isBuying = buyingPlanKey === plan.id;
          const authRequired = !isAuthenticated && authRequestedPlanKey === plan.id;
          const ctaLabel = isBuying
            ? "Переходим к оплате…"
            : canPurchase
              ? `${isRenewalMode ? "Продлить подписку" : "Оформить подписку"} ${remainingCount} из ${totalLimit}`
              : "Лимит выбран";

          return (
            <article key={plan.id} className="tournament-subscription-plan tournament-subscription-plan--image">
              <div className="tournament-subscription-plan-image-wrap">
                <img
                  src={plan.artworkSrc}
                  alt={plan.artworkAlt}
                  className="tournament-subscription-plan-image"
                />
              </div>
              <div className="tournament-subscription-purchase-block tournament-subscription-purchase-block--image">
                <button
                  type="button"
                  className="tournament-subscription-buy"
                  disabled={!canPurchase || isBuying || loadingProfile}
                  onClick={() => void beginPurchase(plan.id)}
                >
                  {ctaLabel}
                </button>
                {!isAuthenticated && (
                  <div className="tournament-subscription-info">
                    Для оформления нужна авторизация.
                  </div>
                )}
                {authRequired && (
                  <div className="tournament-subscription-warning">
                    Сначала войдите в кабинет, затем покупка продолжится автоматически.
                  </div>
                )}
                {buyErrorByPlanKey[plan.id] && (
                  <div className="tournament-subscription-error">{buyErrorByPlanKey[plan.id]}</div>
                )}
              </div>
            </article>
          );
        })}
        {isRenewalMode && visiblePlans.length === 0 && !loadingStatus && !statusError && (
          <div className="tournament-subscription-global-message tournament-subscription-updated">
            Для этой ссылки сейчас нет доступного окна продления.
          </div>
        )}
      </section>

      {authRequestedPlanKey && (
        <div className="tournament-subscription-auth-overlay" role="dialog" aria-modal="true" aria-labelledby="referral-subscription-auth-title">
          <button
            type="button"
            className="tournament-subscription-auth-backdrop"
            onClick={() => setAuthRequestedPlanKey(null)}
            aria-label="Закрыть авторизацию"
          />
          <section className="tournament-subscription-auth-block">
            <button
              type="button"
              className="tournament-subscription-auth-close"
              onClick={() => setAuthRequestedPlanKey(null)}
              aria-label="Закрыть"
            >
              ×
            </button>
            <h1 id="referral-subscription-auth-title" className="tournament-subscription-auth-title">
              Войдите, чтобы оформить подписку
            </h1>
            <p className="tournament-subscription-auth-caption">
              После входа страница автоматически продолжит оформление по выбранной ссылке.
            </p>
            <AuthForm onLogin={handleAuthSuccess} />
          </section>
        </div>
      )}
    </div>
  );
}
