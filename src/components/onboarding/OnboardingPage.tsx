import { useEffect, useState } from "react";
import { apiFetchProfile } from "../../utils/apiClient";
import type { UserProfileType } from "../../utils/apiClient";
import { OnboardingModal } from "../cabinet/OnboardingModal";

interface OnboardingPageProps {
  onBack: () => void;
  profile?: UserProfileType;
  gamesLink: string;
  trainingLink: string;
  tournamentsLink: string;
}

export default function OnboardingPage({
  onBack,
  profile: initialProfile,
  gamesLink,
  trainingLink,
  tournamentsLink,
}: OnboardingPageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(
    initialProfile ?? null,
  );
  const [loading, setLoading] = useState(!initialProfile);

  useEffect(() => {
    if (initialProfile) return;
    setLoading(true);
    apiFetchProfile()
      .then((res) => {
        if (res.data) setProfile(res.data);
      })
      .finally(() => setLoading(false));
  }, [initialProfile]);

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!profile) {
    return <div className="loading">Ошибка загрузки профиля</div>;
  }

  return (
    <OnboardingModal
      isOpen={true}
      onClose={onBack}
      profile={profile}
      gamesLink={gamesLink}
      trainingLink={trainingLink}
      tournamentsLink={tournamentsLink}
      onProfileUpdated={() => {
        window.dispatchEvent(new CustomEvent("lk-profile-updated"));
      }}
    />
  );
}
