import { useEffect, useState } from "react";
import { TENANT_KEY, KEYCLOAK_BASE } from "../consts/api_config";
import { AuthContext } from "./authShared";
import {
  identifyAnalyticsUser,
  trackAnalyticsEvent,
  trackClientError,
} from "../utils/analytics";
import {
  initializePushNotifications,
  syncPushTokenWithBackend,
  unregisterPushToken,
} from "../utils/pushNotifications";
import {
  clearAuthTokens,
  persistAuthTokens,
  readAuthToken,
} from "../utils/authTokenStorage";

export function LegacyAuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = readAuthToken();
    if (token) {
      setIsAuthenticated(true);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      void initializePushNotifications();
      void syncPushTokenWithBackend("auth_changed");
    }
  }, [isAuthenticated]);

  const clearError = () => setError(null);

  const sendCode = async (
    phoneNumber: string,
    channel = "cascade",
  ): Promise<boolean> => {
    clearError();
    setPhone(phoneNumber);
    identifyAnalyticsUser({ phone: phoneNumber });
    trackAnalyticsEvent("auth_code_requested", {
      phone: phoneNumber,
      channel,
      authMode: "legacy",
    });

    try {
      const res = await fetch(
        `${KEYCLOAK_BASE}/realms/prod/sms/authentication-code?phoneNumber=${phoneNumber}&channel=${channel}&tenantKey=${TENANT_KEY}`,
        { method: "GET" },
      );
      if (res.ok) {
        trackAnalyticsEvent("auth_code_sent", {
          phone: phoneNumber,
          channel,
          status: res.status,
          authMode: "legacy",
        });
        return true;
      }

      trackClientError(
        "auth.send_code_failed",
        new Error(`Failed to send auth code: HTTP ${res.status}`),
        { phone: phoneNumber, channel, status: res.status, authMode: "legacy" },
        { handled: true, severity: res.status >= 500 ? "error" : "warning" },
      );
      trackAnalyticsEvent("auth_code_send_failed", {
        phone: phoneNumber,
        channel,
        status: res.status,
        authMode: "legacy",
      });
      setError("Не удалось отправить код");
      return false;
    } catch (err) {
      trackClientError(
        "auth.send_code_exception",
        err,
        { phone: phoneNumber, channel, authMode: "legacy" },
        { handled: true, severity: "error" },
      );
      trackAnalyticsEvent("auth_code_send_failed", {
        phone: phoneNumber,
        channel,
        error: err instanceof Error ? err.message : String(err),
        authMode: "legacy",
      });
      setError(`Ошибка сети ${err}`);
      return false;
    }
  };

  const login = async (phoneNumber: string, code: string): Promise<boolean> => {
    clearError();
    const formData = new URLSearchParams();
    formData.append("grant_type", "password");
    formData.append("phone_number", phoneNumber);
    formData.append("code", code);
    formData.append("client_id", "widget");
    formData.append("tenant_key", TENANT_KEY);
    identifyAnalyticsUser({ phone: phoneNumber });
    trackAnalyticsEvent("auth_login_attempt", { phone: phoneNumber, authMode: "legacy" });

    try {
      const res = await fetch(
        `${KEYCLOAK_BASE}/realms/prod/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formData.toString(),
        },
      );

      const data = await res.json();
      if (res.ok && data.access_token) {
        persistAuthTokens(
          data.access_token,
          data.expires_in,
          data.refresh_token,
          data.refresh_expires_in,
        );
        setPhone(phoneNumber);
        setIsAuthenticated(true);
        trackAnalyticsEvent("auth_login_success", {
          phone: phoneNumber,
          tokenExpiresIn: data.expires_in ?? null,
          status: res.status,
          authMode: "legacy",
        });
        return true;
      }

      trackClientError(
        "auth.login_failed",
        new Error(data?.error_description ?? data?.error ?? `Login failed: HTTP ${res.status}`),
        {
          phone: phoneNumber,
          status: res.status,
          authMode: "legacy",
        },
        { handled: true, severity: res.status >= 500 ? "error" : "warning" },
      );
      trackAnalyticsEvent("auth_login_failed", {
        phone: phoneNumber,
        status: res.status,
        reason: data?.error_description ?? data?.error ?? "invalid_code",
        authMode: "legacy",
      });
      setError(data.error_description || "Неверный код");
      return false;
    } catch (err) {
      trackClientError(
        "auth.login_exception",
        err,
        { phone: phoneNumber, authMode: "legacy" },
        { handled: true, severity: "error" },
      );
      trackAnalyticsEvent("auth_login_failed", {
        phone: phoneNumber,
        error: err instanceof Error ? err.message : String(err),
        authMode: "legacy",
      });
      setError(`Ошибка при входе ${err}`);
      return false;
    }
  };

  const logout = () => {
    trackAnalyticsEvent("auth_logout", { phone, authMode: "legacy" }, { preferBeacon: true });
    void unregisterPushToken("logout");
    clearAuthTokens();
    setIsAuthenticated(false);
    setPhone("");
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        phone,
        sendCode,
        login,
        logout,
        error,
        clearError,
        authMode: "legacy",
        supportsOAuth: false,
        isLoading: false,
        isRestoringSession: false,
        needsPhoneVerification: false,
        startOAuth: () => {},
        sendPhoneVerificationCode: async () => false,
        verifyPhone: async () => false,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
