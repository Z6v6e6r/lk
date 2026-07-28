import { useEffect } from "react";
import { readAuthToken } from "../utils/authTokenStorage";
import {
  installGlobalErrorTracking,
  trackAnalyticsEvent,
  trackWidgetOpenOnce,
  useGlobalClickAnalytics,
} from "../utils/analytics";
import { LegacyAuthProvider } from "./LegacyAuthProvider";
import { VivaAuthProvider } from "./VivaAuthProvider";
import { resolveConfiguredAuthMode } from "../utils/authMode";
import type { AuthMode } from "./authShared";
export { useAuth } from "./authShared";

export const AuthProvider = ({
  children,
  authMode = "auto",
}: {
  children: React.ReactNode;
  authMode?: AuthMode | "auto";
}) => {
  const resolvedAuthMode = authMode === "auto" ? resolveConfiguredAuthMode() : authMode;

  installGlobalErrorTracking();
  useGlobalClickAnalytics();

  useEffect(() => {
    const token = readAuthToken();
    const hasToken = Boolean(token);
    if (hasToken) {
      trackAnalyticsEvent("auth_token_detected", { hasToken: true, authMode: resolvedAuthMode });
    }
    trackWidgetOpenOnce({
      hasAuthToken: hasToken,
      authMode: resolvedAuthMode,
      path: typeof window !== "undefined" ? window.location.pathname : null,
    });
  }, [resolvedAuthMode]);

  if (resolvedAuthMode === "viva") {
    return <VivaAuthProvider>{children}</VivaAuthProvider>;
  }

  return <LegacyAuthProvider>{children}</LegacyAuthProvider>;
};
