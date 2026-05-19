import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  PushNotifications,
  type ActionPerformed,
  type PermissionStatus,
  type PushNotificationSchema,
  type RegistrationError,
  type Token,
} from "@capacitor/push-notifications";
import {
  PUSH_REGISTRATION_URL,
  PUSH_UNREGISTRATION_URL,
  TENANT_KEY,
} from "../consts/api_config";
import { trackAnalyticsEvent, trackClientError } from "./analytics";
import { getCookie } from "./cookies";

type PushSyncReason = "token_received" | "auth_changed" | "logout" | "manual";

type PushRuntimeState = {
  initialized: boolean;
  listenersAttached: boolean;
  token: string | null;
  syncedToken: string | null;
  syncInFlight: Promise<void> | null;
};

type FirebaseAvailabilityResult = {
  available?: boolean;
  reason?: string | null;
  message?: string | null;
};

type FirebaseAvailabilityPlugin = {
  isAvailable: () => Promise<FirebaseAvailabilityResult>;
};

declare global {
  interface Window {
    __LK_PUSH_RUNTIME__?: PushRuntimeState;
  }
}

const PUSH_TOKEN_STORAGE_KEY = `${TENANT_KEY}_fcm_push_token_v1`;
const PUSH_SYNCED_TOKEN_STORAGE_KEY = `${TENANT_KEY}_fcm_push_synced_token_v1`;
const PUSH_EVENT_RECEIVED = "lk-push-received";
const PUSH_EVENT_ACTION = "lk-push-action";
const DEFAULT_ANDROID_CHANNEL_ID = "lk_default";
const FirebaseAvailability = registerPlugin<FirebaseAvailabilityPlugin>("FirebaseAvailability");

let pushConfigWarningSent = false;
let firebaseAvailabilityCache: boolean | null = null;

function hasPushRegistrationConfig() {
  return Boolean(String(PUSH_REGISTRATION_URL || "").trim());
}

function trackPushConfigSkippedOnce() {
  if (pushConfigWarningSent) return;
  pushConfigWarningSent = true;
  trackAnalyticsEvent("push_skipped_not_configured", {
    platform: Capacitor.getPlatform(),
    hasRegistrationEndpoint: false,
  });
}

async function isFirebaseConfiguredForPush() {
  if (Capacitor.getPlatform() !== "android") return true;
  if (firebaseAvailabilityCache !== null) return firebaseAvailabilityCache;

  try {
    const result = await FirebaseAvailability.isAvailable();
    const available = Boolean(result?.available);

    if (!available) {
      trackAnalyticsEvent("push_firebase_unavailable", {
        reason: result?.reason ?? "unknown",
        message: result?.message ?? null,
      });
    }

    firebaseAvailabilityCache = available;
    return available;
  } catch (error) {
    trackClientError(
      "push.firebase_availability_check_failed",
      error,
      { platform: Capacitor.getPlatform() },
      { handled: true, severity: "warning" },
    );
    firebaseAvailabilityCache = false;
    return false;
  }
}

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readStorage(key: string): string | null {
  if (!canUseStorage()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  if (!canUseStorage()) return;
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage errors.
  }
}

function normalizeToken(value: string | null | undefined): string | null {
  const token = String(value || "").trim();
  return token || null;
}

function resolveRuntimeState(): PushRuntimeState {
  if (typeof window === "undefined") {
    return {
      initialized: false,
      listenersAttached: false,
      token: null,
      syncedToken: null,
      syncInFlight: null,
    };
  }

  if (window.__LK_PUSH_RUNTIME__) {
    return window.__LK_PUSH_RUNTIME__;
  }

  const state: PushRuntimeState = {
    initialized: false,
    listenersAttached: false,
    token: normalizeToken(readStorage(PUSH_TOKEN_STORAGE_KEY)),
    syncedToken: normalizeToken(readStorage(PUSH_SYNCED_TOKEN_STORAGE_KEY)),
    syncInFlight: null,
  };
  window.__LK_PUSH_RUNTIME__ = state;
  return state;
}

function isNativePushAvailable() {
  return (
    typeof window !== "undefined"
    && Capacitor.isNativePlatform()
    && Capacitor.isPluginAvailable("PushNotifications")
  );
}

async function resolvePermissions() {
  let permissionStatus: PermissionStatus;
  try {
    permissionStatus = await PushNotifications.checkPermissions();
  } catch (error) {
    trackClientError(
      "push.permissions_check_failed",
      error,
      { platform: Capacitor.getPlatform() },
      { handled: true, severity: "error" },
    );
    return null;
  }

  if (permissionStatus.receive === "granted") {
    return permissionStatus;
  }

  try {
    permissionStatus = await PushNotifications.requestPermissions();
  } catch (error) {
    trackClientError(
      "push.permissions_request_failed",
      error,
      { platform: Capacitor.getPlatform() },
      { handled: true, severity: "error" },
    );
    return null;
  }

  return permissionStatus;
}

async function ensureAndroidChannel() {
  if (Capacitor.getPlatform() !== "android") return;
  try {
    await PushNotifications.createChannel({
      id: DEFAULT_ANDROID_CHANNEL_ID,
      name: "Основные уведомления",
      description: "Игры, турниры и важные события профиля",
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: "#1A73E8",
    });
  } catch (error) {
    trackClientError(
      "push.channel_create_failed",
      error,
      { channelId: DEFAULT_ANDROID_CHANNEL_ID },
      { handled: true, severity: "warning" },
    );
  }
}

function getAuthToken() {
  return normalizeToken(getCookie(`${TENANT_KEY}AuthToken`));
}

function buildRegistrationPayload(token: string) {
  return {
    token,
    platform: Capacitor.getPlatform(),
    tenantKey: TENANT_KEY,
    appVersion: typeof window !== "undefined" ? window.__LK_RELEASE_VERSION__ ?? null : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    registeredAt: new Date().toISOString(),
  };
}

async function handleTokenRegistration(tokenRaw: string, reason: PushSyncReason) {
  const token = normalizeToken(tokenRaw);
  if (!token) return;

  const state = resolveRuntimeState();
  state.token = token;
  writeStorage(PUSH_TOKEN_STORAGE_KEY, token);

  trackAnalyticsEvent("push_token_received", {
    platform: Capacitor.getPlatform(),
    reason,
  });

  await syncPushTokenWithBackend(reason);
}

function emitPushEvent(eventName: string, detail: PushNotificationSchema | ActionPerformed) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

async function attachPushListeners() {
  const state = resolveRuntimeState();
  if (state.listenersAttached) return;
  state.listenersAttached = true;

  await PushNotifications.addListener("registration", (token: Token) => {
    void handleTokenRegistration(token.value, "token_received");
  });

  await PushNotifications.addListener("registrationError", (error: RegistrationError) => {
    trackClientError(
      "push.registration_error",
      new Error(error.error),
      { platform: Capacitor.getPlatform() },
      { handled: true, severity: "error" },
    );
  });

  await PushNotifications.addListener("pushNotificationReceived", (notification: PushNotificationSchema) => {
    trackAnalyticsEvent("push_notification_received", {
      id: notification.id,
      title: notification.title ?? null,
      hasData: Boolean(notification.data),
    });
    emitPushEvent(PUSH_EVENT_RECEIVED, notification);
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", (action: ActionPerformed) => {
    trackAnalyticsEvent("push_notification_opened", {
      id: action.notification?.id ?? null,
      actionId: action.actionId ?? null,
    });
    emitPushEvent(PUSH_EVENT_ACTION, action);
  });
}

export async function initializePushNotifications() {
  if (!isNativePushAvailable()) return;
  if (!hasPushRegistrationConfig()) {
    trackPushConfigSkippedOnce();
    return;
  }
  if (!(await isFirebaseConfiguredForPush())) return;

  const state = resolveRuntimeState();
  if (state.initialized) {
    await syncPushTokenWithBackend("auth_changed");
    return;
  }
  state.initialized = true;

  await attachPushListeners();
  await ensureAndroidChannel();

  const permissions = await resolvePermissions();
  if (!permissions || permissions.receive !== "granted") {
    trackAnalyticsEvent("push_permission_denied", {
      permission: permissions?.receive ?? "unknown",
    });
    return;
  }

  try {
    await PushNotifications.register();
    trackAnalyticsEvent("push_register_requested", {
      platform: Capacitor.getPlatform(),
    });
  } catch (error) {
    trackClientError(
      "push.register_failed",
      error,
      { platform: Capacitor.getPlatform() },
      { handled: true, severity: "error" },
    );
  }
}

export async function syncPushTokenWithBackend(reason: PushSyncReason = "manual") {
  if (!isNativePushAvailable()) return;

  const endpoint = String(PUSH_REGISTRATION_URL || "").trim();
  if (!endpoint) return;

  const state = resolveRuntimeState();
  const token = normalizeToken(state.token ?? readStorage(PUSH_TOKEN_STORAGE_KEY));
  if (!token) return;
  if (state.syncedToken === token) return;

  const authToken = getAuthToken();
  if (!authToken) return;

  if (state.syncInFlight) {
    await state.syncInFlight;
    return;
  }

  state.syncInFlight = (async () => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildRegistrationPayload(token)),
      });

      if (!response.ok) {
        throw new Error(`Push register request failed: HTTP ${response.status}`);
      }

      state.syncedToken = token;
      writeStorage(PUSH_SYNCED_TOKEN_STORAGE_KEY, token);
      trackAnalyticsEvent("push_token_synced", {
        reason,
        platform: Capacitor.getPlatform(),
      });
    } catch (error) {
      trackClientError(
        "push.sync_failed",
        error,
        { reason, endpoint },
        { handled: true, severity: "warning" },
      );
    } finally {
      state.syncInFlight = null;
    }
  })();

  await state.syncInFlight;
}

export async function unregisterPushToken(reason: PushSyncReason = "logout") {
  if (!isNativePushAvailable()) return;

  const state = resolveRuntimeState();
  const token = normalizeToken(state.token ?? readStorage(PUSH_TOKEN_STORAGE_KEY));
  const authToken = getAuthToken();
  const endpoint = String(PUSH_UNREGISTRATION_URL || "").trim();

  if (token && authToken && endpoint) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token,
          tenantKey: TENANT_KEY,
          platform: Capacitor.getPlatform(),
          unregisteredAt: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Push unregister request failed: HTTP ${response.status}`);
      }
    } catch (error) {
      trackClientError(
        "push.unsync_failed",
        error,
        { reason, endpoint },
        { handled: true, severity: "warning" },
      );
    }
  }

  try {
    await PushNotifications.unregister();
  } catch (error) {
    trackClientError(
      "push.unregister_failed",
      error,
      { reason },
      { handled: true, severity: "warning" },
    );
  }

  state.initialized = false;
  state.token = null;
  state.syncedToken = null;
  writeStorage(PUSH_TOKEN_STORAGE_KEY, null);
  writeStorage(PUSH_SYNCED_TOKEN_STORAGE_KEY, null);

  trackAnalyticsEvent("push_token_unregistered", {
    reason,
    platform: Capacitor.getPlatform(),
  });
}
