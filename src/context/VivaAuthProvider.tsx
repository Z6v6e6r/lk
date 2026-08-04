import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUTH_RUNTIME_KEYCLOAK_BASE,
  AUTH_RUNTIME_TENANT_KEY,
} from "../consts/authRuntime";
import { AuthContext } from "./authShared";
import type { VivaOAuthProvider } from "./authShared";
import {
  identifyAnalyticsUser,
  trackAnalyticsEvent,
  trackClientError,
} from "../utils/analytics";
import {
  clearPendingAuthConsents,
  hasRetryablePendingAuthConsents,
  stageAuthConsents,
  syncPendingAuthConsents,
} from "../utils/authConsents";
import {
  initializePushNotifications,
  syncPushTokenWithBackend,
  unregisterPushToken,
} from "../utils/pushNotifications";
import {
  extractJwtStringClaim,
  getJwtExpiryTimestamp,
  hasPhoneClaim,
} from "../utils/vivaAuthJwt";
import {
  clearVivaAuthTokens,
  persistVivaAuthTokens,
  readVivaAccessToken,
  readVivaRefreshToken,
  shouldRestoreVivaSession,
} from "../utils/vivaAuthStorage";
import {
  cleanupVivaOAuthCallbackUrl,
  clearPendingVivaOAuth,
  readPendingVivaOAuth,
  startVivaOAuthRedirect,
} from "../utils/vivaOAuth";
import { isLkIdleRequestPausedError } from "../utils/lkIdleDataGuard";

const VIVA_REALM = "clients";
const REFRESH_LEEWAY_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 10_000;

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in?: number | null;
  refresh_expires_in?: number | null;
};

function buildTokenUrl() {
  return `${AUTH_RUNTIME_KEYCLOAK_BASE}/realms/${VIVA_REALM}/protocol/openid-connect/token`;
}

function buildLogoutUrl() {
  return `${AUTH_RUNTIME_KEYCLOAK_BASE}/realms/${VIVA_REALM}/protocol/openid-connect/logout`;
}

function buildAuthenticationCodeUrl(phone: string, channel: string) {
  return `${AUTH_RUNTIME_KEYCLOAK_BASE}/realms/${VIVA_REALM}/sms/authentication-code?phoneNumber=${phone}&channel=${channel}&tenantKey=${AUTH_RUNTIME_TENANT_KEY}`;
}

function buildPhoneVerificationUrl(phone: string, channel: string, code?: string) {
  const params = new URLSearchParams({
    phoneNumber: phone,
    channel,
    tenantKey: AUTH_RUNTIME_TENANT_KEY,
  });
  if (code) {
    params.set("code", code);
  }
  return `${AUTH_RUNTIME_KEYCLOAK_BASE}/realms/${VIVA_REALM}/sms/verification-code?${params.toString()}`;
}

function resolvePhoneFromToken(token: string | null | undefined) {
  return extractJwtStringClaim(token, ["phone_number", "phoneNumber", "phone"]) || "";
}

export function VivaAuthProvider({ children }: { children: React.ReactNode }) {
  const initialToken = useMemo(() => readVivaAccessToken(), []);
  const shouldRestoreInitialSession = useMemo(
    () => shouldRestoreVivaSession(initialToken),
    [initialToken],
  );
  const [isAuthenticated, setIsAuthenticated] = useState(
    Boolean(initialToken) && hasPhoneClaim(initialToken),
  );
  const [phone, setPhone] = useState(resolvePhoneFromToken(initialToken));
  const [error, setError] = useState<string | null>(null);
  const [needsPhoneVerification, setNeedsPhoneVerification] = useState(
    Boolean(initialToken) && !hasPhoneClaim(initialToken),
  );
  const [isLoading, setIsLoading] = useState(shouldRestoreInitialSession);
  const [isRestoringSession, setIsRestoringSession] = useState(shouldRestoreInitialSession);
  const refreshTimerRef = useRef<number | null>(null);
  const onMountResolvedRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const cancelRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const applyTokenState = useCallback((tokenResponse: TokenResponse, fallbackPhone = "") => {
    persistVivaAuthTokens(
      tokenResponse.access_token,
      tokenResponse.expires_in,
      tokenResponse.refresh_token,
      tokenResponse.refresh_expires_in,
    );

    const resolvedPhone = resolvePhoneFromToken(tokenResponse.access_token) || fallbackPhone;
    const requiresPhoneVerification = !hasPhoneClaim(tokenResponse.access_token) && !resolvedPhone;
    setPhone(resolvedPhone);
    setNeedsPhoneVerification(requiresPhoneVerification);
    setIsAuthenticated(!requiresPhoneVerification);
    if (resolvedPhone) {
      identifyAnalyticsUser({ phone: resolvedPhone });
    }
  }, []);

  const refreshTokens = useCallback(async () => {
    const refreshToken = readVivaRefreshToken();
    if (!refreshToken) {
      clearVivaAuthTokens();
      setIsAuthenticated(false);
      setNeedsPhoneVerification(false);
      return false;
    }

    try {
      const res = await fetch(buildTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "widget",
          refresh_token: refreshToken,
        }).toString(),
      });

      const data = await res.json();
      if (!res.ok || !data?.access_token) {
        throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`);
      }

      applyTokenState(data, phone);
      trackAnalyticsEvent("auth_token_refreshed", {
        authMode: "viva",
        expiresIn: data.expires_in ?? null,
      });
      return true;
    } catch (refreshError) {
      if (isLkIdleRequestPausedError(refreshError)) {
        return false;
      }
      trackClientError(
        "auth.refresh_failed",
        refreshError,
        { authMode: "viva" },
        { handled: true, severity: "warning" },
      );
      clearVivaAuthTokens();
      setIsAuthenticated(false);
      setNeedsPhoneVerification(false);
      setPhone("");
      return false;
    }
  }, [applyTokenState, phone]);

  const scheduleRefresh = useCallback(async () => {
    cancelRefreshTimer();
    const token = readVivaAccessToken();
    const expiryTs = getJwtExpiryTimestamp(token);
    if (!expiryTs) return;
    const delayMs = Math.max(expiryTs - Date.now() - REFRESH_LEEWAY_MS, MIN_REFRESH_DELAY_MS);
    refreshTimerRef.current = window.setTimeout(() => {
      void refreshTokens().then((ok) => {
        if (ok) {
          void scheduleRefresh();
        }
      });
    }, delayMs);
  }, [cancelRefreshTimer, refreshTokens]);

  useEffect(() => {
    if (isAuthenticated) {
      void syncPendingAuthConsents();
      void initializePushNotifications();
      void syncPushTokenWithBackend("auth_changed");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const retryNow = () => {
      if (!hasRetryablePendingAuthConsents()) return;
      void syncPendingAuthConsents();
    };
    const handleConsentVisibility = () => {
      if (document.visibilityState === "visible") retryNow();
    };

    retryNow();
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", handleConsentVisibility);
    return () => {
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", handleConsentVisibility);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const expiryTs = getJwtExpiryTimestamp(readVivaAccessToken());
      if (expiryTs !== null && expiryTs - Date.now() <= REFRESH_LEEWAY_MS) {
        void refreshTokens().then((ok) => {
          if (ok) {
            void scheduleRefresh();
          }
        });
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelRefreshTimer();
    };
  }, [cancelRefreshTimer, refreshTokens, scheduleRefresh]);

  useEffect(() => {
    if (onMountResolvedRef.current) return;
    onMountResolvedRef.current = true;

    const pending = readPendingVivaOAuth();
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const oauthError = params.get("error");

    if (oauthError) {
      if (pending) {
        void clearPendingAuthConsents({
          authMethod: pending.provider,
          bindingType: "oauth-state",
          bindingValue: pending.state,
        });
      }
      cleanupVivaOAuthCallbackUrl();
      clearPendingVivaOAuth();
      setIsLoading(false);
      setIsRestoringSession(false);
      setError("Не удалось завершить вход через внешний провайдер");
      trackAnalyticsEvent("auth_oauth_failed", {
        authMode: "viva",
        reason: oauthError,
      });
      return;
    }

    if (!pending || !code) {
      if (initialToken) {
        setIsLoading(false);
        setIsRestoringSession(false);
        void scheduleRefresh();
        return;
      }

      if (shouldRestoreVivaSession(null)) {
        setIsLoading(true);
        setIsRestoringSession(true);
        void refreshTokens().then((ok) => {
          if (ok) {
            void scheduleRefresh();
          }
        }).finally(() => {
          setIsLoading(false);
          setIsRestoringSession(false);
        });
        return;
      }

      setIsLoading(false);
      setIsRestoringSession(false);
      return;
    }

    if (pending.state !== returnedState) {
      void clearPendingAuthConsents({
        authMethod: pending.provider,
        bindingType: "oauth-state",
        bindingValue: pending.state,
      });
      cleanupVivaOAuthCallbackUrl();
      clearPendingVivaOAuth();
      setIsLoading(false);
      setIsRestoringSession(false);
      setError("Сессия входа устарела, попробуйте снова");
      trackAnalyticsEvent("auth_oauth_failed", {
        authMode: "viva",
        reason: "state_mismatch",
      });
      return;
    }

    setIsLoading(true);
    void (async () => {
      try {
        const res = await fetch(buildTokenUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "widget",
            code,
            redirect_uri: pending.redirectUri,
            code_verifier: pending.codeVerifier,
          }).toString(),
        });
        const data = await res.json();
        if (!res.ok || !data?.access_token) {
          throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`);
        }

        clearPendingVivaOAuth();
        cleanupVivaOAuthCallbackUrl();
        applyTokenState(data);
        await syncPendingAuthConsents({
          authMethod: pending.provider,
          bindingType: "oauth-state",
          bindingValue: pending.state,
        });
        trackAnalyticsEvent("auth_oauth_success", {
          authMode: "viva",
          provider: pending.provider,
        });
        await scheduleRefresh();

        const returnTo = String(pending.returnTo || "").trim();
        const currentUrl = window.location.href;
        if (returnTo && returnTo !== currentUrl) {
          window.location.replace(returnTo);
          return;
        }
      } catch (oauthExchangeError) {
        void clearPendingAuthConsents({
          authMethod: pending.provider,
          bindingType: "oauth-state",
          bindingValue: pending.state,
        });
        clearPendingVivaOAuth();
        cleanupVivaOAuthCallbackUrl();
        trackClientError(
          "auth.oauth_exchange_failed",
          oauthExchangeError,
          { authMode: "viva" },
          { handled: true, severity: "warning" },
        );
        setError("Не удалось завершить вход, попробуйте снова");
      } finally {
        setIsLoading(false);
        setIsRestoringSession(false);
      }
    })();
  }, [applyTokenState, initialToken, refreshTokens, scheduleRefresh]);

  const sendCode = useCallback(async (phoneNumber: string, channel = "cascade") => {
    clearError();
    setPhone(phoneNumber);
    identifyAnalyticsUser({ phone: phoneNumber });
    trackAnalyticsEvent("auth_code_requested", {
      phone: phoneNumber,
      channel,
      authMode: "viva",
    });

    try {
      const res = await fetch(buildAuthenticationCodeUrl(phoneNumber, channel), { method: "GET" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      trackAnalyticsEvent("auth_code_sent", {
        phone: phoneNumber,
        channel,
        status: res.status,
        authMode: "viva",
      });
      return true;
    } catch (sendError) {
      trackClientError(
        "auth.viva_send_code_failed",
        sendError,
        { phone: phoneNumber, channel, authMode: "viva" },
        { handled: true, severity: "warning" },
      );
      setError("Не удалось отправить код");
      return false;
    }
  }, [clearError]);

  const login = useCallback(async (phoneNumber: string, code: string) => {
    clearError();
    setIsLoading(true);
    identifyAnalyticsUser({ phone: phoneNumber });
    trackAnalyticsEvent("auth_login_attempt", {
      phone: phoneNumber,
      authMode: "viva",
      realm: VIVA_REALM,
    });

    try {
      const res = await fetch(buildTokenUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          phone_number: phoneNumber,
          code,
          client_id: "widget",
          tenant_key: AUTH_RUNTIME_TENANT_KEY,
        }).toString(),
      });
      const data = await res.json();
      if (!res.ok || !data?.access_token) {
        throw new Error(data?.error_description ?? data?.error ?? `HTTP ${res.status}`);
      }

      applyTokenState(data, phoneNumber);
      await syncPendingAuthConsents({
        authMethod: "sms",
        bindingType: "sms-phone",
        bindingValue: phoneNumber,
      });
      await scheduleRefresh();
      trackAnalyticsEvent("auth_login_success", {
        phone: phoneNumber,
        authMode: "viva",
        realm: VIVA_REALM,
        status: res.status,
      });
      return true;
    } catch (loginError) {
      trackClientError(
        "auth.viva_login_failed",
        loginError,
        { phone: phoneNumber, authMode: "viva" },
        { handled: true, severity: "warning" },
      );
      setError("Не удалось выполнить вход");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [applyTokenState, clearError, scheduleRefresh]);

  const startOAuth = useCallback((provider: VivaOAuthProvider) => {
    clearError();
    setIsLoading(true);
    trackAnalyticsEvent("auth_oauth_started", {
      authMode: "viva",
      provider,
    });
    void startVivaOAuthRedirect(
      provider,
      "widget",
      AUTH_RUNTIME_TENANT_KEY,
      (pending) => stageAuthConsents({
        authMethod: provider,
        bindingType: "oauth-state",
        bindingValue: pending.state,
      }),
    ).catch((oauthStartError) => {
      setIsLoading(false);
      trackClientError(
        "auth.oauth_start_failed",
        oauthStartError,
        { authMode: "viva", provider },
        { handled: true, severity: "warning" },
      );
      setError("Не удалось открыть вход через внешний провайдер");
    });
  }, [clearError]);

  const sendPhoneVerificationCode = useCallback(async (phoneNumber: string, channel = "cascade") => {
    clearError();
    const accessToken = readVivaAccessToken();
    if (!accessToken) {
      setError("Сессия истекла, войдите снова");
      return false;
    }

    setPhone(phoneNumber);
    setIsLoading(true);
    try {
      const res = await fetch(buildPhoneVerificationUrl(phoneNumber, channel), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      trackAnalyticsEvent("auth_phone_verification_code_sent", {
        authMode: "viva",
        phone: phoneNumber,
      });
      return true;
    } catch (verificationError) {
      trackClientError(
        "auth.phone_verification_code_failed",
        verificationError,
        { authMode: "viva", phone: phoneNumber },
        { handled: true, severity: "warning" },
      );
      setError("Не удалось отправить код подтверждения");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [clearError]);

  const verifyPhone = useCallback(async (phoneNumber: string, code: string) => {
    clearError();
    const accessToken = readVivaAccessToken();
    if (!accessToken) {
      setError("Сессия истекла, войдите снова");
      return false;
    }

    setIsLoading(true);
    try {
      const verifyRes = await fetch(buildPhoneVerificationUrl(phoneNumber, "cascade", code), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!verifyRes.ok) {
        throw new Error(`HTTP ${verifyRes.status}`);
      }

      const refreshed = await refreshTokens();
      if (!refreshed) {
        throw new Error("refresh_failed");
      }

      setPhone(phoneNumber);
      setNeedsPhoneVerification(false);
      setIsAuthenticated(true);
      trackAnalyticsEvent("auth_phone_verified", {
        authMode: "viva",
        phone: phoneNumber,
      });
      await scheduleRefresh();
      return true;
    } catch (verifyError) {
      trackClientError(
        "auth.phone_verification_failed",
        verifyError,
        { authMode: "viva", phone: phoneNumber },
        { handled: true, severity: "warning" },
      );
      setError("Не удалось подтвердить номер");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [clearError, refreshTokens, scheduleRefresh]);

  const logout = useCallback(() => {
    const refreshToken = readVivaRefreshToken();
    trackAnalyticsEvent("auth_logout", { phone, authMode: "viva" }, { preferBeacon: true });
    if (refreshToken) {
      void fetch(buildLogoutUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "widget",
          refresh_token: refreshToken,
        }).toString(),
      }).catch(() => {});
    }

    void unregisterPushToken("logout");
    cancelRefreshTimer();
    clearPendingVivaOAuth();
    clearVivaAuthTokens();
    setIsAuthenticated(false);
    setIsRestoringSession(false);
    setNeedsPhoneVerification(false);
    setPhone("");
    setError(null);
  }, [cancelRefreshTimer, phone]);

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
        authMode: "viva",
        supportsOAuth: true,
        isLoading,
        isRestoringSession,
        needsPhoneVerification,
        startOAuth,
        sendPhoneVerificationCode,
        verifyPhone,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
