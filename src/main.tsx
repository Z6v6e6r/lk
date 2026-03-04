import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";

installGlobalErrorTracking();
trackAnalyticsEvent("widget_bootstrap_started", { entry: "main" });

const rootElement = document.getElementById("root");

if (!rootElement) {
  trackClientError(
    "bootstrap.root_missing",
    new Error("Root container #root was not found"),
    { entry: "main" },
    { handled: false, severity: "error" },
  );
} else {
  const root = createRoot(rootElement);

  void import("./MyApp")
    .then(({ default: App }) => {
      root.render(
        <StrictMode>
          <AppErrorBoundary module="main">
            <App />
          </AppErrorBoundary>
        </StrictMode>,
      );
      trackAnalyticsEvent("widget_bootstrap_rendered", { entry: "main" });
    })
    .catch((error) => {
      trackClientError(
        "bootstrap.app_import_failed",
        error,
        { entry: "main" },
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
