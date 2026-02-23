import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AuthForm } from "./components/auth/AuthForm";
import { Cabinet } from "./components/cabinet/Cabinet";
import { GAMES_BUNDLE_URL, TOURNAMENTS_BUNDLE_URL, ONBOARDING_BUNDLE_URL } from "./consts/api_config";
import "./MyApp.css";

type WidgetModule = {
  mount: (options?: { targetId?: string; onClose?: () => void; data?: any }) => void;
  unmount?: (targetId?: string) => void;
};

const OVERLAY_ID = "lk-overlay";
let overlayRoot: ReturnType<typeof createRoot> | null = null;

function ensureOverlayContainer() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.className = "lk-overlay";
    document.body.appendChild(el);
  }
  return el;
}

function showOverlay() {
  const el = ensureOverlayContainer();
  el.classList.add("open");
  document.body.classList.add("lk-overlay-open");
  return el;
}

function hideOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) {
    el.classList.remove("open");
    el.innerHTML = "";
  }
  overlayRoot?.unmount();
  overlayRoot = null;
  document.body.classList.remove("lk-overlay-open");
}

const scriptPromises: Record<string, Promise<WidgetModule> | undefined> = {};

function loadWidget(src: string, globalName: string): Promise<WidgetModule> {
  if ((window as any)[globalName]) {
    return Promise.resolve((window as any)[globalName] as WidgetModule);
  }
  if (scriptPromises[globalName]) return scriptPromises[globalName]!;

  scriptPromises[globalName] = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const mod = (window as any)[globalName] as WidgetModule | undefined;
      if (!mod) {
        reject(new Error("Module did not register on window"));
        return;
      }
      resolve(mod);
    };
    script.onerror = () => reject(new Error("Failed to load script"));
    document.head.appendChild(script);
  });

  return scriptPromises[globalName];
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  const [view, setView] = useState<"auth" | "cabinet">("auth");

  useEffect(() => {
    (window as typeof window & { __LK_ON_READY?: () => void }).__LK_ON_READY?.();
  }, []);

  const openOverlayModule = async (
    module: "games" | "tournaments" | "onboarding",
    src?: string,
    globalName?: string,
    data?: any,
  ) => {
    if (!src || !globalName) {
      console.warn("Overlay module URL is not configured");
      if (!import.meta.env.DEV) return;
    }
    const container = showOverlay();
    container.innerHTML = '<div class="overlay-loading">Загрузка...</div>';

    if (import.meta.env.DEV) {
      try {
        const mod = module === "games"
          ? await import("./components/games/GamesPage")
          : module === "tournaments"
            ? await import("./components/tournaments/TournamentsPage")
            : await import("./components/onboarding/OnboardingPage");
        const Component = mod.default;
        container.innerHTML = "";
        overlayRoot?.unmount();
        overlayRoot = createRoot(container);
        overlayRoot.render(
          <Component
            onBack={() => {
              hideOverlay();
            }}
            {...(data ?? {})}
          />,
        );
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Ошибка загрузки";
        container.innerHTML = `<div class="overlay-loading">${message}</div>`;
        return;
      }
    }

    try {
      const widget = await loadWidget(src!, globalName!);
      widget.mount({
        targetId: OVERLAY_ID,
        onClose: () => {
          widget.unmount?.(OVERLAY_ID);
          hideOverlay();
        },
        data,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка загрузки";
      container.innerHTML = `<div class="overlay-loading">${message}</div>`;
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      setView("cabinet");
    } else {
      setView("auth");
      hideOverlay();
    }
  }, [isAuthenticated]);

  if (view === "cabinet") {
    return (
      <Cabinet
        onOpenGames={() =>
          openOverlayModule("games", GAMES_BUNDLE_URL, "LKWidgetGames")}
        onOpenTournaments={() =>
          openOverlayModule(
            "tournaments",
            TOURNAMENTS_BUNDLE_URL,
            "LKWidgetTournaments",
          )}
        onOpenOnboarding={(data) =>
          openOverlayModule(
            "onboarding",
            ONBOARDING_BUNDLE_URL,
            "LKWidgetOnboarding",
            data,
          )}
      />
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
