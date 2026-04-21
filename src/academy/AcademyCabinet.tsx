import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { BuySupscription } from "../components/cabinet/BuySubscription";
import {
  apiFetchBookings,
  apiFetchProfile,
  apiFetchSubscriptions,
  type Booking,
  type Subscription,
  type UserProfileType,
} from "../utils/apiClient";
import { apiFetchCommunities, type CommunityRecord } from "../utils/communityApi";
import { trackAnalyticsEvent } from "../utils/analytics";
import { ACADEMY_NEWS, type AcademyNewsDefinition } from "./content";

type AcademySnapshot = {
  profile: UserProfileType;
  bookings: Booking[];
  subscriptions: Subscription[];
  communities: CommunityRecord[];
};

type NewsTone = AcademyNewsDefinition["tone"];

function formatPhone(raw: string | null | undefined): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  if (digits.length === 10) {
    return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 10)}`;
  }
  return raw?.trim() || "+7 000 000-00-00";
}

function formatSlashDate(value: string | null | undefined): string {
  if (!value) return "дата уточняется";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function isUpcomingBooking(booking: Booking): boolean {
  const timeFrom = booking.exercise?.timeFrom;
  if (!timeFrom || booking.isCancelled) return false;
  const timestamp = Date.parse(timeFrom);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= Date.now();
}

function getActiveSubscription(subscriptions: Subscription[]): Subscription | null {
  return subscriptions.find((item) => item.status === "ACTIVE") ?? subscriptions[0] ?? null;
}

function getDisplayName(profile: UserProfileType): string {
  return [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Александр Петров";
}

function resolveSubscriptionTitle(subscription: Subscription | null): string {
  if (!subscription) return "Абонемент «Прогресс»";
  if (subscription.name?.trim()) return subscription.name.trim();
  if (subscription.variant?.trim()) return subscription.variant.trim();
  return "Абонемент «Прогресс»";
}

function resolveSubscriptionStatus(subscription: Subscription | null): string {
  return subscription?.status === "ACTIVE" ? "Активен" : "Не активен";
}

function resolveFreezeDays(subscription: Subscription | null): number {
  if (!subscription) return 21;
  return subscription.totalFreezeDays || subscription.freezingDays || 21;
}

function buildVisitSegments(subscription: Subscription | null): boolean[] {
  const total = Math.max(1, Math.min(10, subscription?.visitsTotal || 10));
  const visitsLeft = Math.max(0, Math.min(total, subscription?.visitsLeft ?? 3));
  const usedVisits = Math.max(0, total - visitsLeft);
  return Array.from({ length: total }, (_, index) => index < usedVisits);
}

function buildNewsCards(communities: CommunityRecord[], bookings: Booking[]): AcademyNewsDefinition[] {
  const nextBooking = bookings.find(isUpcomingBooking);
  const dynamicCards = [...ACADEMY_NEWS];

  if (communities.length > 0) {
    dynamicCards[0] = {
      ...dynamicCards[0],
      title: `Сообщество ${communities[0].name} открыло весенний набор`,
    };
  }

  if (nextBooking) {
    dynamicCards[1] = {
      ...dynamicCards[1],
      date: formatSlashDate(nextBooking.exercise?.timeFrom),
      title: `${nextBooking.exercise?.type?.name || "Следующая тренировка"} в ${String(
        nextBooking.exercise?.timeFrom || "",
      ).slice(11, 16) || "расписании"}`,
    };
  }

  return dynamicCards;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.5 2.75V4M11.5 2.75V4M3.75 5.25H12.25M4.2 13.25H11.8C12.3523 13.25 12.8 12.8023 12.8 12.25V4.75C12.8 4.19772 12.3523 3.75 11.8 3.75H4.2C3.64772 3.75 3.2 4.19772 3.2 4.75V12.25C3.2 12.8023 3.64772 13.25 4.2 13.25Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BallIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.9 5.2C5.3 5.5 6.8 4.8 7.8 3.4M12 5.2C10.6 5.5 9.1 4.8 8.1 3.4M5 11.6C6 10.4 7.6 9.8 9.2 10.1M11 11.3C9.7 10.2 7.7 10 6.2 10.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path
        d="M2 5.2L4.1 7.2L8 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CircleActionIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.4 8H11.6M8 4.4V11.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AcademyCabinet() {
  const { logout } = useAuth();
  const newsTrackRef = useRef<HTMLDivElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AcademySnapshot | null>(null);
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);

  const loadAcademySnapshot = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const [profileResult, bookingsResult, historyResult, subscriptionsResult] = await Promise.all([
      apiFetchProfile(),
      apiFetchBookings(false),
      apiFetchBookings(true),
      apiFetchSubscriptions(),
    ]);

    if (!profileResult.data) {
      setError(profileResult.error?.message || "Не удалось загрузить кабинет академии.");
      setIsLoading(false);
      return;
    }

    const communitiesResult = await apiFetchCommunities({
      phone: profileResult.data.phone,
      clientId: profileResult.data.id,
    });

    setSnapshot({
      profile: profileResult.data,
      bookings: [...(bookingsResult.data?.content ?? []), ...(historyResult.data?.content ?? [])],
      subscriptions: subscriptionsResult.data?.content ?? [],
      communities: communitiesResult.data?.communities ?? [],
    });
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadAcademySnapshot();
  }, [loadAcademySnapshot]);

  const newsCards = useMemo(
    () => buildNewsCards(snapshot?.communities ?? [], snapshot?.bookings ?? []),
    [snapshot],
  );

  const activeSubscription = useMemo(
    () => getActiveSubscription(snapshot?.subscriptions ?? []),
    [snapshot],
  );

  const visitSegments = useMemo(
    () => buildVisitSegments(activeSubscription),
    [activeSubscription],
  );

  const upcomingBooking = useMemo(
    () => (snapshot?.bookings ?? []).filter(isUpcomingBooking).sort((left, right) => {
      const leftTs = Date.parse(left.exercise?.timeFrom || "");
      const rightTs = Date.parse(right.exercise?.timeFrom || "");
      return leftTs - rightTs;
    })[0] ?? null,
    [snapshot],
  );

  useEffect(() => {
    if (!snapshot) return;
    trackAnalyticsEvent("academy_figma_home_loaded", {
      clientId: snapshot.profile.id,
      subscriptions: snapshot.subscriptions.length,
      communities: snapshot.communities.length,
      hasUpcomingBooking: Boolean(upcomingBooking),
    });
  }, [snapshot, upcomingBooking]);

  const displayName = snapshot ? getDisplayName(snapshot.profile) : "Александр Петров";
  const formattedPhone = snapshot ? formatPhone(snapshot.profile.phone) : "+7 988 000-00-00";

  const handleNewsScroll = (direction: "prev" | "next") => {
    const target = newsTrackRef.current;
    if (!target) return;
    target.scrollBy({
      left: direction === "next" ? 232 : -232,
      behavior: "smooth",
    });
  };

  const handleFreezeClick = () => {
    trackAnalyticsEvent("academy_subscription_freeze_clicked", {
      hasSubscription: Boolean(activeSubscription),
    });
  };

  const handleShortcutClick = (target: "schedule" | "games") => {
    trackAnalyticsEvent("academy_shortcut_clicked", {
      target,
    });

    if (target === "games") {
      newsTrackRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  if (isLoading) {
    return (
      <div className="academy-page">
        <div className="academy-frame academy-frame--loading">
          <div className="academy-loader-card">Загружаем экран по макету...</div>
        </div>
      </div>
    );
  }

  if (!snapshot || error) {
    return (
      <div className="academy-page">
        <div className="academy-frame academy-frame--loading">
          <div className="academy-loader-card academy-loader-card--error">
            <h2>Не удалось открыть кабинет</h2>
            <p>{error || "Попробуйте обновить страницу позже."}</p>
            <div className="academy-loader-actions">
              <button type="button" className="academy-primary-action" onClick={() => void loadAcademySnapshot()}>
                Повторить
              </button>
              <button type="button" className="academy-secondary-action" onClick={logout}>
                Выйти
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const subscriptionTitle = resolveSubscriptionTitle(activeSubscription);
  const subscriptionStatus = resolveSubscriptionStatus(activeSubscription);
  const visitsLeft = activeSubscription?.visitsLeft ?? 3;
  const visitsTotal = activeSubscription?.visitsTotal || 10;
  const freezeDays = resolveFreezeDays(activeSubscription);

  return (
    <div className="academy-page">
      <div className="academy-frame">
        <div className="academy-glow academy-glow--top-left" aria-hidden="true" />
        <div className="academy-glow academy-glow--left-rail" aria-hidden="true" />
        <div className="academy-glow academy-glow--mid" aria-hidden="true" />
        <div className="academy-glow academy-glow--bottom-right" aria-hidden="true" />

        <header className="academy-profile-header">
          <div className="academy-profile-main">
            <div className="academy-profile-avatar-wrap">
              <div className="academy-profile-avatar-ring" />
              {snapshot.profile.photo ? (
                <img className="academy-profile-avatar" src={snapshot.profile.photo} alt={displayName} />
              ) : (
                <div className="academy-profile-avatar academy-profile-avatar--fallback">
                  {displayName.slice(0, 1)}
                </div>
              )}
            </div>

            <div className="academy-profile-copy">
              <div className="academy-profile-name">{displayName}</div>
              <div className="academy-profile-phone">{formattedPhone}</div>
            </div>
          </div>

          <button type="button" className="academy-profile-action" onClick={() => setIsBuyModalOpen(true)} aria-label="Действия">
            <CircleActionIcon />
            <span className="academy-profile-action-dot" aria-hidden="true" />
          </button>
        </header>

        <main className="academy-scroll-area">
          <section className="academy-main-banner">
            <div className="academy-subscription-block">
              <div className="academy-subscription-card">
                <div className="academy-subscription-noise" aria-hidden="true" />
                <div className="academy-subscription-content">
                  <div className="academy-status-pill">{subscriptionStatus}</div>
                  <h1 className="academy-subscription-title">{subscriptionTitle}</h1>

                  <div className="academy-subscription-meta">
                    <div className="academy-subscription-meta-row">
                      <span className="academy-meta-icon"><CheckIcon /></span>
                      <span>Действует до {formatSlashDate(activeSubscription?.expirationDate)}</span>
                    </div>
                    <div className="academy-subscription-meta-row">
                      <span className="academy-meta-icon"><CheckIcon /></span>
                      <span>{freezeDays} день заморозки</span>
                    </div>
                  </div>

                  <div className="academy-visits-copy">
                    Посещений осталось: {visitsLeft} / {visitsTotal}
                  </div>

                  <div className="academy-visits-bar" aria-hidden="true">
                    {visitSegments.map((filled, index) => (
                      <span
                        key={`${activeSubscription?.subscriptionId || "stub"}-${index}`}
                        className={`academy-visits-segment${filled ? " is-filled" : ""}`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="academy-subscription-footer">
                <button type="button" className="academy-freeze-button" onClick={handleFreezeClick}>
                  Заморозить Абонемент
                </button>
                <button
                  type="button"
                  className="academy-circle-link"
                  onClick={() => setIsBuyModalOpen(true)}
                  aria-label="Открыть абонементы"
                >
                  <ChevronIcon />
                </button>
              </div>
            </div>

            <button type="button" className="academy-shortcut-card" onClick={() => handleShortcutClick("schedule")}>
              <div className="academy-shortcut-main">
                <span className="academy-shortcut-icon"><CalendarIcon /></span>
                <span className="academy-shortcut-label">Расписание тренировок</span>
              </div>
              <span className="academy-shortcut-arrow"><ChevronIcon /></span>
            </button>

            <button type="button" className="academy-shortcut-card" onClick={() => handleShortcutClick("games")}>
              <div className="academy-shortcut-main">
                <span className="academy-shortcut-icon"><BallIcon /></span>
                <span className="academy-shortcut-label">Игры «Поколения F»</span>
              </div>
              <span className="academy-shortcut-arrow"><ChevronIcon /></span>
            </button>

            {upcomingBooking && (
              <div className="academy-inline-note">
                Ближайшая тренировка: {upcomingBooking.exercise?.type?.name || "Тренировка"}{" "}
                {String(upcomingBooking.exercise?.timeFrom || "").slice(11, 16)} •{" "}
                {upcomingBooking.exercise?.studio?.name || "локация уточняется"}
              </div>
            )}
          </section>

          <section className="academy-news-section">
            <div className="academy-news-head">
              <h2>Последние новости</h2>
              <div className="academy-news-nav">
                <button type="button" className="academy-news-nav-btn" onClick={() => handleNewsScroll("prev")} aria-label="Предыдущие новости">
                  <span className="academy-news-nav-btn-icon is-prev"><ChevronIcon /></span>
                </button>
                <button type="button" className="academy-news-nav-btn" onClick={() => handleNewsScroll("next")} aria-label="Следующие новости">
                  <span className="academy-news-nav-btn-icon"><ChevronIcon /></span>
                </button>
              </div>
            </div>

            <div ref={newsTrackRef} className="academy-news-track">
              {newsCards.map((item) => (
                <article
                  key={item.id}
                  className={`academy-news-card academy-news-card--${item.size} academy-news-card--${item.tone as NewsTone}`}
                >
                  <div className="academy-news-badge">{item.label}</div>
                  <div className="academy-news-footer">
                    <div className="academy-news-footer-inner">
                      <div className="academy-news-date">{item.date}</div>
                      <div className="academy-news-title-row">
                        <div className="academy-news-title">{item.title}</div>
                        <div className="academy-news-cta">{item.cta}</div>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>

        <div className="academy-homebar" aria-hidden="true">
          <span className="academy-homebar-indicator" />
        </div>
      </div>

      <BuySupscription
        isOpen={isBuyModalOpen}
        onClose={() => setIsBuyModalOpen(false)}
        phone={snapshot.profile.phone}
      />
    </div>
  );
}
