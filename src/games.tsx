import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import GamesPage from "./components/games/GamesPage";

type MountOptions = { targetId?: string; onClose?: () => void };

let gamesRoot: ReturnType<typeof createRoot> | null = null;

function GamesContent({ onClose }: { onClose?: () => void }) {
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

  return <GamesPage onBack={() => onClose?.()} />;
}

function GamesApp({ onClose }: { onClose?: () => void }) {
  return (
    <AuthProvider>
      <GamesContent onClose={onClose} />
    </AuthProvider>
  );
}

function mount(options: MountOptions = {}) {
  const targetId = options.targetId ?? "root";
  const container = document.getElementById(targetId);
  if (!container) return;
  gamesRoot?.unmount();
  gamesRoot = createRoot(container);
  gamesRoot.render(
    <StrictMode>
      <GamesApp onClose={options.onClose} />
    </StrictMode>,
  );
}

function unmount() {
  gamesRoot?.unmount();
  gamesRoot = null;
}

(window as any).LKWidgetGames = { mount, unmount };
