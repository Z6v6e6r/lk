import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import TournamentsPage from "./components/tournaments/TournamentsPage";

type MountOptions = { targetId?: string; onClose?: () => void };

let tournamentsRoot: ReturnType<typeof createRoot> | null = null;

function TournamentsContent({ onClose }: { onClose?: () => void }) {
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

  return <TournamentsPage onBack={() => onClose?.()} />;
}

function TournamentsApp({ onClose }: { onClose?: () => void }) {
  return (
    <AuthProvider>
      <TournamentsContent onClose={onClose} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) return;
  tournamentsRoot?.unmount();
  tournamentsRoot = createRoot(container);
  tournamentsRoot.render(
    <StrictMode>
      <TournamentsApp onClose={options.onClose} />
    </StrictMode>,
  );
}

function unmount() {
  tournamentsRoot?.unmount();
  tournamentsRoot = null;
}

(window as any).LKWidgetTournaments = { mount, unmount };
