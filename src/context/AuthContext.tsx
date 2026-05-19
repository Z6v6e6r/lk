import { createContext, useContext, useState, useEffect } from "react";
import { getCookie, setCookie, deleteCookie } from "../utils/cookies";
import { TENANT_KEY, KEYCLOAK_BASE } from "../consts/api_config";
import {
  installGlobalErrorTracking,
  identifyAnalyticsUser,
  trackAnalyticsEvent,
  trackClientError,
  trackWidgetOpenOnce,
  useGlobalClickAnalytics,
} from "../utils/analytics";
import {
  initializePushNotifications,
  syncPushTokenWithBackend,
  unregisterPushToken,
} from "../utils/pushNotifications";

type AuthContextType = {
  isAuthenticated: boolean;
  phone: string;
  sendCode: (phone: string, channel?: string) => Promise<boolean>;
  login: (phone: string, code: string) => Promise<boolean>;
  logout: () => void;
  error: string | null;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  phone: "",
  sendCode: async () => false,
  login: async () => false,
  logout: () => {},
  error: null,
  clearError: () => {},
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  installGlobalErrorTracking();
  useGlobalClickAnalytics();

  useEffect(() => {
    const token = getCookie(`${TENANT_KEY}AuthToken`);
    const hasToken = Boolean(token);
    if (hasToken) {
      setIsAuthenticated(true);
      trackAnalyticsEvent("auth_token_detected", { hasToken: true });
    }
    trackWidgetOpenOnce({
      hasAuthToken: hasToken,
      path: typeof window !== "undefined" ? window.location.pathname : null,
    });
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
        });
        return true;
      } else {
        trackClientError(
          "auth.send_code_failed",
          new Error(`Failed to send auth code: HTTP ${res.status}`),
          { phone: phoneNumber, channel, status: res.status },
          { handled: true, severity: res.status >= 500 ? "error" : "warning" },
        );
        trackAnalyticsEvent("auth_code_send_failed", {
          phone: phoneNumber,
          channel,
          status: res.status,
        });
        setError("Не удалось отправить код");
        return false;
      }
    } catch (err) {
      trackClientError(
        "auth.send_code_exception",
        err,
        { phone: phoneNumber, channel },
        { handled: true, severity: "error" },
      );
      trackAnalyticsEvent("auth_code_send_failed", {
        phone: phoneNumber,
        channel,
        error: err instanceof Error ? err.message : String(err),
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
    trackAnalyticsEvent("auth_login_attempt", { phone: phoneNumber });

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
        setCookie(`${TENANT_KEY}AuthToken`, data.access_token, data.expires_in);
        setCookie(
          `${TENANT_KEY}RefreshToken`,
          data.refresh_token,
          data.refresh_expires_in,
        );
        setIsAuthenticated(true);
        trackAnalyticsEvent("auth_login_success", {
          phone: phoneNumber,
          tokenExpiresIn: data.expires_in ?? null,
          status: res.status,
        });
        return true;
      } else {
        trackClientError(
          "auth.login_failed",
          new Error(data?.error_description ?? data?.error ?? `Login failed: HTTP ${res.status}`),
          {
            phone: phoneNumber,
            status: res.status,
          },
          { handled: true, severity: res.status >= 500 ? "error" : "warning" },
        );
        trackAnalyticsEvent("auth_login_failed", {
          phone: phoneNumber,
          status: res.status,
          reason: data?.error_description ?? data?.error ?? "invalid_code",
        });
        setError(data.error_description || "Неверный код");
        return false;
      }
    } catch (err) {
      trackClientError(
        "auth.login_exception",
        err,
        { phone: phoneNumber },
        { handled: true, severity: "error" },
      );
      trackAnalyticsEvent("auth_login_failed", {
        phone: phoneNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      setError(`Ошибка при входе ${err}`);
      return false;
    }
  };

  const logout = () => {
    trackAnalyticsEvent("auth_logout", { phone }, { preferBeacon: true });
    void unregisterPushToken("logout");
    deleteCookie(`${TENANT_KEY}AuthToken`);
    deleteCookie(`${TENANT_KEY}RefreshToken`);
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
