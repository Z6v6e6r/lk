import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import GroupSchedulePage from "./components/group-schedule/GroupSchedulePage";
import TournamentSignupPage from "./components/tournament-signup/TournamentSignupPage";
import { AuthProvider } from "./context/AuthContext";
import { appendCurrentAuthModeToNavigableUrl } from "./utils/authMode";
import { appendSubscriptionUsageShadowToSameOriginUrl } from "./components/subscriptions/subscriptionUsageShadow";

function returnToCabinet() {
  const current = new URL(window.location.href);
  const cabinet = appendSubscriptionUsageShadowToSameOriginUrl(
    new URL("/lk_dev", current.origin),
    current,
  );
  window.location.href = appendCurrentAuthModeToNavigableUrl(cabinet).toString();
}

function SubscriptionShadowDevApp() {
  if (!import.meta.env.DEV) {
    return <div className="load-error">DEV-shadow экран недоступен в production-сборке.</div>;
  }
  const current = new URL(window.location.href);
  if (current.searchParams.get("screen") === "group") {
    return (
      <GroupSchedulePage
        onBack={returnToCabinet}
        initialExerciseId={current.searchParams.get("exerciseId")}
        initialDate={current.searchParams.get("date")}
        initialStudioId={current.searchParams.get("studioId")}
      />
    );
  }
  if (current.searchParams.get("screen") === "tournament") {
    return (
      <TournamentSignupPage
        onBack={returnToCabinet}
        initialTournamentId={current.searchParams.get("tournamentId")}
        initialTournamentSlug={current.searchParams.get("slug")}
        initialDate={current.searchParams.get("date")}
      />
    );
  }
  return <div className="load-error">Не выбран DEV-shadow сценарий.</div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Subscription DEV-shadow mount target is missing");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary module="subscription-shadow-dev">
      <AuthProvider authMode="viva">
        <SubscriptionShadowDevApp />
      </AuthProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
