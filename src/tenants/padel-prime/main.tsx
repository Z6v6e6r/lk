import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../index.css";
import "../../MyApp.css";
import "./theme.css";
import { AppErrorBoundary } from "../../components/UI/AppErrorBoundary";
import { RUNTIME_CONFIG_AUDIT } from "../../consts/api_config";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "../../utils/analytics";

const THEME_ATTRIBUTE = "padel-prime";

// Тема клуба включается до первого рендера: стили LK1 скоупятся
// html[data-theme="padel-prime"], поэтому бандлы других клубов не затрагиваются.
document.documentElement.setAttribute("data-theme", THEME_ATTRIBUTE);

(window as Window & { __LK_RUNTIME_CONFIG_AUDIT__?: typeof RUNTIME_CONFIG_AUDIT })
  .__LK_RUNTIME_CONFIG_AUDIT__ = RUNTIME_CONFIG_AUDIT;

installGlobalErrorTracking();
trackAnalyticsEvent("widget_bootstrap_started", { entry: "padel_prime" });

const rootElement = document.getElementById("root");

if (!rootElement) {
  trackClientError(
    "bootstrap.root_missing",
    new Error("Root container #root was not found"),
    { entry: "padel_prime" },
    { handled: false, severity: "error" },
  );
} else {
  const root = createRoot(rootElement);

  void import("../../MyApp")
    .then(({ default: App }) => {
      root.render(
        <StrictMode>
          <AppErrorBoundary module="main">
            <App />
          </AppErrorBoundary>
        </StrictMode>,
      );
      trackAnalyticsEvent("widget_bootstrap_rendered", { entry: "padel_prime" });
    })
    .catch((error) => {
      trackClientError(
        "bootstrap.app_import_failed",
        error,
        { entry: "padel_prime" },
        { handled: false, severity: "error" },
      );
      root.render(
        <div className="load-error">
          <div className="load-error-title">Не удалось загрузить кабинет</div>
          <div className="load-error-text">Проверьте интернет или попробуйте позже.</div>
        </div>,
      );
    });
}
