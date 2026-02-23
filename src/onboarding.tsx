import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import OnboardingPage from "./components/onboarding/OnboardingPage";
import type { UserProfileType } from "./utils/apiClient";

type OnboardingData = {
  profile?: UserProfileType;
  gamesLink?: string;
  trainingLink?: string;
  tournamentsLink?: string;
};

type MountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: OnboardingData;
};

let onboardingRoot: ReturnType<typeof createRoot> | null = null;

function OnboardingContent({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: OnboardingData;
}) {
  const { isAuthenticated } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  if (!ready) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!isAuthenticated) {
    return <AuthForm onLogin={() => {}} />;
  }

  return (
    <OnboardingPage
      onBack={() => onClose?.()}
      profile={data?.profile}
      gamesLink={data?.gamesLink || "#"}
      trainingLink={data?.trainingLink || "#"}
      tournamentsLink={data?.tournamentsLink || "#"}
    />
  );
}

function OnboardingApp({
  onClose,
  data,
}: {
  onClose?: () => void;
  data?: OnboardingData;
}) {
  return (
    <AuthProvider>
      <OnboardingContent onClose={onClose} data={data} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) return;
  onboardingRoot?.unmount();
  onboardingRoot = createRoot(container);
  onboardingRoot.render(
    <StrictMode>
      <OnboardingApp onClose={options.onClose} data={options.data} />
    </StrictMode>,
  );
}

function unmount() {
  onboardingRoot?.unmount();
  onboardingRoot = null;
}

(window as any).LKWidgetOnboarding = { mount, unmount };
