import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./MyApp.css";
import "./academy/academy.css";
import { AppErrorBoundary } from "./components/UI/AppErrorBoundary";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackClientError,
} from "./utils/analytics";
import { mountDevReleaseBadge } from "./utils/devReleaseBadge";
import { ensureFreshRelease } from "./utils/releaseGuard";

ensureFreshRelease({
  entry: "academy",
  bundleFileNames: ["ffc-academy-lk.js", "ffc-academy-lk-dev.js"],
  releaseFileName: import.meta.env.MODE === "dev"
    ? "release-ffc-academy-dev.json"
    : "release-ffc-academy.json",
});
mountDevReleaseBadge({ bundleFileNames: ["ffc-academy-lk.js", "ffc-academy-lk-dev.js"] });
installGlobalErrorTracking();
trackAnalyticsEvent("widget_bootstrap_started", { entry: "academy" });

const rootElement = document.getElementById("root");

if (!rootElement) {
  trackClientError(
    "bootstrap.root_missing",
    new Error("Root container #root was not found"),
    { entry: "academy" },
    { handled: false, severity: "error" },
  );
} else {
  const root = createRoot(rootElement);

  void import("./academy/AcademyApp")
    .then(({ default: AcademyApp }) => {
      root.render(
        <StrictMode>
          <AppErrorBoundary module="academy">
            <AcademyApp />
          </AppErrorBoundary>
        </StrictMode>,
      );
      trackAnalyticsEvent("widget_bootstrap_rendered", { entry: "academy" });
    })
    .catch((error) => {
      trackClientError(
        "bootstrap.app_import_failed",
        error,
        { entry: "academy" },
        { handled: false, severity: "error" },
      );
      root.render(
        <div className="load-error">
          <div className="load-error-title">Не удалось загрузить кабинет академии</div>
          <div className="load-error-text">Проверьте интернет или попробуйте позже.</div>
        </div>,
      );
    });
}
