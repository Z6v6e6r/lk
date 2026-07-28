import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { AuthForm } from "../components/auth/AuthForm";
import { trackAnalyticsEvent } from "../utils/analytics";
import { processPendingPaymentSyncQueue } from "../utils/paymentSync";
import { AcademyCabinet } from "./AcademyCabinet";

function AcademyAppContent() {
  const { isAuthenticated, isRestoringSession } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet">(isAuthenticated ? "cabinet" : "auth");

  useEffect(() => {
    if (isRestoringSession) return;
    setView(isAuthenticated ? "cabinet" : "auth");
  }, [isAuthenticated, isRestoringSession]);

  useEffect(() => {
    void processPendingPaymentSyncQueue();
  }, []);

  useEffect(() => {
    trackAnalyticsEvent("academy_view_changed", { view });
  }, [view]);

  return (
    <div className="academy-shell">
      <div className="academy-shell-backdrop" aria-hidden="true" />
      <div className="academy-shell-orbit academy-shell-orbit--one" aria-hidden="true" />
      <div className="academy-shell-orbit academy-shell-orbit--two" aria-hidden="true" />
      {isRestoringSession ? (
        <div className="loading">Проверяем сессию...</div>
      ) : null}
      {!isRestoringSession && (
        <>
          {view === "auth" ? (
            <div className="academy-auth-panel">
              <div className="academy-auth-copy">
                <div className="academy-eyebrow">FFC Team</div>
                <h1>Личный кабинет академии</h1>
                <p>Расписание тренировок, прогресс игрока, достижения, тесты и сообщества в одном кабинете.</p>
              </div>
              <AuthForm onLogin={() => setView("cabinet")} />
            </div>
          ) : (
            <AcademyCabinet />
          )}
        </>
      )}
    </div>
  );
}

export default function AcademyApp() {
  return (
    <AuthProvider>
      <AcademyAppContent />
    </AuthProvider>
  );
}
