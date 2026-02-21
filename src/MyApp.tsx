import { useState, useEffect, lazy, Suspense } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import { Cabinet } from "./components/cabinet/Cabinet";
import "./MyApp.css";

const GamesPage = lazy(() => import("./components/games/GamesPage"));
const TournamentsPage = lazy(() => import("./components/tournaments/TournamentsPage"));

function AppContent() {
  const { isAuthenticated } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet" | "games" | "tournaments">("auth");

  useEffect(() => {
    if (isAuthenticated) {
      setView("cabinet");
    } else {
      setView("auth");
    }
  }, [isAuthenticated]);

  if (view === "cabinet") {
    return (
      <Cabinet
        onOpenGames={() => setView("games")}
        onOpenTournaments={() => setView("tournaments")}
      />
    );
  }

  if (view === "games") {
    return (
      <Suspense fallback={<div className="loading">Загрузка...</div>}>
        <GamesPage onBack={() => setView("cabinet")} />
      </Suspense>
    );
  }

  if (view === "tournaments") {
    return (
      <Suspense fallback={<div className="loading">Загрузка...</div>}>
        <TournamentsPage onBack={() => setView("cabinet")} />
      </Suspense>
    );
  }

  return <AuthForm onLogin={() => setView("cabinet")} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
