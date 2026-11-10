import { IS_PRIMARY_TENANT } from "../consts/tenantIntegrations.ts";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { AuthForm } from "../components/auth/AuthForm";
import { trackAnalyticsEvent } from "../utils/analytics";
import { processPendingPaymentSyncQueue } from "../utils/paymentSync";
import { AcademyCabinet } from "./AcademyCabinet";
import { AcademyBrand } from "./AcademyBrand";
import rodinaMark from "./assets/rodina-mark.svg";

function AcademyAppContent() {
  const { isAuthenticated, isRestoringSession } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet">(isAuthenticated ? "cabinet" : "auth");

  useEffect(() => {
    if (isRestoringSession) return;
    setView(isAuthenticated ? "cabinet" : "auth");
  }, [isAuthenticated, isRestoringSession]);

  useEffect(() => {
    if (IS_PRIMARY_TENANT) void processPendingPaymentSyncQueue();
  }, []);

  useEffect(() => {
    trackAnalyticsEvent("academy_view_changed", { view });
  }, [view]);

  return (
    <div className="academy-shell">
      {isRestoringSession ? (
        <div className="loading">Проверяем сессию...</div>
      ) : null}
      {!isRestoringSession && (
        <>
          {view === "auth" ? (
            <div className="academy-auth-panel">
              <div className="academy-auth-copy">
                <AcademyBrand />
                <h1>Личный кабинет академии</h1>
                <p>Расписание тренировок, прогресс игрока, достижения, тесты и сообщества в одном кабинете.</p>
              </div>
              <AuthForm
                onLogin={() => setView("cabinet")}
                brandLogo={{ src: rodinaMark, alt: "Герб Родины" }}
              />
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
