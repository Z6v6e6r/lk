import { useState, useEffect } from "react";
import { UserProfile } from "./UserProfile";
import {
  apiFetchProfile,
  apiFetchBookings,
  apiFetchSubscriptions,
} from "../../utils/apiClient";
import type {
  UserProfileType,
  BookingsResponse,
  SubscriptionResponse,
  Subscription,
} from "../../utils/apiClient";
import { useAuth } from "../../context/AuthContext";
import { ButtonModule } from "./ButtonModele";
import { ProfileEditForm } from "./ProfileEditForm";
import { BookingsContainer } from "./BookingsContainer";
import { BookingHistory } from "./BookingHistory";
import { SubscriptionsContainer } from "./SubscriptionsContainer";
import { SubscriptionInformation } from "./SubscriptionInformation";
import { BuySupscription } from "./BuySubscription";
import { Advertisement } from "./Advertisement";
import { OnboardingModal } from "./OnboardingModal";
import { CUSTOM_FIELD_IDS, getCustomField, getCustomFieldValue } from "../../utils/customFields";

const QUICK_ACTIONS = [
  { icon: "🎾", label: "Играть", href: "https://padlhub.ru/locations_lk" },
  { icon: "👥", label: "Групповые тренировки", href: "#9Rzqf" },
  { icon: "🏆", label: "Турниры", href: "https://padlhub.ru/padel_torneos" },
  { icon: "🎯", label: "Индивидуальные тренировки", href: "https://padlhub.ru/indi_lk" },
];

interface CabinetProps {
  onOpenGames: () => void;
  onOpenTournaments: () => void;
}

export function Cabinet({ onOpenGames, onOpenTournaments }: CabinetProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [historyBookings, setHistoryBookings] = useState<BookingsResponse | null>(null);
  const [activeBookings, setActiveBookings] = useState<BookingsResponse | null>(null);
  const [userSubscriptions, setUserSubscriptions] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isBookingHistoryOpen, setIsBookingHistoryOpen] = useState(false);
  const [isSubscriptionInfoOpen, SetSubscriptionInfoOpen] = useState(false);
  const [currenSub, SetCurrenSub] = useState<Subscription | null>(null);
  const [currenSubName, SetCurrenSubName] = useState<string>("Абонемент");
  const [isOpenBuySub, setOpenBuySub] = useState<boolean>(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const { logout } = useAuth();

  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [profileRes, activeRes, historyRes, subsRes] = await Promise.all([
          apiFetchProfile(),
          apiFetchBookings(false),
          apiFetchBookings(true),
          apiFetchSubscriptions(),
        ]);
        if (!isMounted) return;
        if (!profileRes?.data) {
          if (profileRes?.status === 401) {
            logout();
            return;
          }
          setLoadError(profileRes?.error?.message || "Не удалось загрузить данные. Проверьте интернет.");
          setLoading(false);
          return;
        }
        setProfile(profileRes.data);
        setActiveBookings(activeRes?.data || null);
        setHistoryBookings(historyRes?.data || null);
        setUserSubscriptions(subsRes?.data || null);
      } catch (error) {
        if (isMounted) {
          console.error("Ошибка загрузки:", error);
          setLoadError("Ошибка сети. Проверьте интернет и повторите.");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    loadData();
    return () => { isMounted = false; };
  }, [logout, reloadKey]);

  const loadProfile = async () => {
    const data = await apiFetchProfile();
    if (data) setProfile(data.data);
  };

  const loadBookings = async () => {
    const [activeBookingsData, historyBookingsData, userSubscriptionsData] = await Promise.all([
      apiFetchBookings(false),
      apiFetchBookings(true),
      apiFetchSubscriptions(),
    ]);
    if (activeBookingsData) setActiveBookings(activeBookingsData.data);
    if (historyBookingsData) setHistoryBookings(historyBookingsData.data);
    if (userSubscriptionsData.data) setUserSubscriptions(userSubscriptionsData.data);
  };

  const openSubInfo = (sub: Subscription, subName: string) => {
    SetCurrenSub(sub);
    SetCurrenSubName(subName);
    SetSubscriptionInfoOpen(true);
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (loadError) {
    return (
      <div className="load-error">
        <div className="load-error-title">Не удалось загрузить данные</div>
        <div className="load-error-text">{loadError}</div>
        <button
          className="section-cta"
          type="button"
          onClick={() => setReloadKey((v) => v + 1)}
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!profile) return <div className="load-error">Ошибка загрузки профиля</div>;
  const numericLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
  const hasLevel = numericLevelValue !== undefined && numericLevelValue !== null && numericLevelValue !== "";
  const onboardingLabel = hasLevel ? "Верифицируй свой уровень" : "Определи свой уровень";
  const tournamentsField = getCustomField(profile, CUSTOM_FIELD_IDS.tournamentsAccess);
  const tournamentsAccessValue = tournamentsField?.value?.[0];
  const canHostTournaments = tournamentsAccessValue === "проводит турниры"
    || Boolean(
      tournamentsField?.attributes?.options?.some(
        (opt) => opt.id === tournamentsAccessValue && opt.name.toLowerCase() === "проводит турниры",
      ),
    );

  return (
    <div className="app-container">

      {/* Шапка с профилем */}
      <UserProfile
        profile={profile}
        openEditForm={() => setIsEditOpen(true)}
      />

      {/* Онбординг */}
      {canHostTournaments && (
        <div className="onboarding-section">
          <button className="onboarding-btn" onClick={() => setIsOnboardingOpen(true)}>
            {onboardingLabel}
          </button>
        </div>
      )}

      {/* Быстрые действия */}
      <div className="quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <a
            key={action.label}
            href={action.href}
            target="_blank"
            rel="noopener noreferrer"
            className="quick-action-card"
          >
            <span className="quick-action-icon">{action.icon}</span>
            <span className="quick-action-label">{action.label}</span>
          </a>
        ))}
      </div>

      {/* Игры */}
      {canHostTournaments && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Игры</span>
          </div>
          <div className="section-body">
            <p className="section-text">Открывайте игровые сценарии в отдельном модуле.</p>
            <button className="section-cta" onClick={onOpenGames} type="button">
              Перейти в игры
            </button>
          </div>
        </div>
      )}

      {/* Турниры */}
      {canHostTournaments && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Турниры</span>
          </div>
          <div className="section-body">
            <p className="section-text">Управляйте турнирами в отдельном модуле.</p>
            <button className="section-cta" onClick={onOpenTournaments} type="button">
              Перейти в турниры
            </button>
          </div>
        </div>
      )}

      {/* Записи */}
      <BookingsContainer
        activeBookings={activeBookings}
        historyBookings={historyBookings}
        openHistory={() => setIsBookingHistoryOpen(true)}
        loadBookings={loadBookings}
      />

      {/* Реклама */}
      <div className="section section--ads">
        <div className="section-header">
          <span className="section-title">Акции</span>
        </div>
        <Advertisement />
      </div>

      {/* Абонементы */}
      <SubscriptionsContainer
        UserSubscriptions={userSubscriptions}
        phone={profile.phone}
        openSubInfo={openSubInfo}
        openBuy={() => setOpenBuySub(true)}
      />

      {/* Соцсети */}
      <ButtonModule />

      {/* Модалки */}
      <ProfileEditForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        initialData={{
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          middleName: profile.middleName,
          sex: profile.sex,
          photo: profile.photo,
        }}
        onSaveSuccess={loadProfile}
      />
      <BookingHistory
        isOpen={isBookingHistoryOpen}
        onClose={() => setIsBookingHistoryOpen(false)}
        historyBookings={historyBookings}
      />
      <SubscriptionInformation
        isOpen={isSubscriptionInfoOpen}
        onClose={() => SetSubscriptionInfoOpen(false)}
        sub={currenSub}
        subName={currenSubName}
      />
      <BuySupscription
        isOpen={isOpenBuySub}
        onClose={() => setOpenBuySub(false)}
        phone={profile.phone}
      />
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        profile={profile}
        gamesLink={QUICK_ACTIONS.find((action) => action.label === "Играть")?.href || "#"}
        trainingLink={QUICK_ACTIONS.find((action) => action.label === "Групповые тренировки")?.href || "#"}
        tournamentsLink={QUICK_ACTIONS.find((action) => action.label === "Турниры")?.href || "#"}
        onProfileUpdated={loadProfile}
      />
    </div>
  );
}
