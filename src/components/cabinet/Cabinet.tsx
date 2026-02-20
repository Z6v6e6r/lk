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

const QUICK_ACTIONS = [
  { icon: "🎾", label: "Играть", href: "https://t.me/padlhub_bot" },
  { icon: "👥", label: "Групповые тренировки", href: "#9Rzqf" },
  { icon: "🏆", label: "Турниры", href: "https://t.me/Academy_F_padel_bot" },
  { icon: "🎯", label: "Индивидуальные тренировки", href: "https://padlhub.ru/indi_lk" },
];

export function Cabinet() {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [historyBookings, setHistoryBookings] = useState<BookingsResponse | null>(null);
  const [activeBookings, setActiveBookings] = useState<BookingsResponse | null>(null);
  const [userSubscriptions, setUserSubscriptions] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
      try {
        const [profileRes, activeRes, historyRes, subsRes] = await Promise.all([
          apiFetchProfile(),
          apiFetchBookings(false),
          apiFetchBookings(true),
          apiFetchSubscriptions(),
        ]);
        if (!isMounted) return;
        if (!profileRes?.data) { logout(); return; }
        setProfile(profileRes.data);
        setActiveBookings(activeRes?.data || null);
        setHistoryBookings(historyRes?.data || null);
        setUserSubscriptions(subsRes?.data || null);
      } catch (error) {
        if (isMounted) console.error("Ошибка загрузки:", error);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    loadData();
    return () => { isMounted = false; };
  }, [logout]);

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
  if (!profile) return <div className="loading">Ошибка загрузки профиля</div>;

  return (
    <div className="app-container">

      {/* Шапка с профилем */}
      <UserProfile
        profile={profile}
        openEditForm={() => setIsEditOpen(true)}
      />

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

      {/* Записи */}
      <BookingsContainer
        activeBookings={activeBookings}
        historyBookings={historyBookings}
        openHistory={() => setIsBookingHistoryOpen(true)}
        loadBookings={loadBookings}
      />

      {/* Реклама */}
      <div className="section-title-row">
        <span className="section-title">Акции</span>
      </div>
      <Advertisement />

      {/* Абонементы */}
      <SubscriptionsContainer
        UserSubscriptions={userSubscriptions}
        phone={profile.phone}
        openSubInfo={openSubInfo}
        openBuy={() => setOpenBuySub(true)}
      />

      {/* Соцсети */}
      <ButtonModule onOpenOnboarding={() => setIsOnboardingOpen(true)} />

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
        onboardingFieldIndex={4}
        gamesLink={QUICK_ACTIONS.find((action) => action.label === "Играть")?.href || "#"}
        tournamentsLink={QUICK_ACTIONS.find((action) => action.label === "Турниры")?.href || "#"}
        onProfileUpdated={loadProfile}
      />
    </div>
  );
}
