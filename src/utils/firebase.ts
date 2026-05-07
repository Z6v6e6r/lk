import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  getAnalytics,
  isSupported,
  logEvent,
  setUserId,
  setUserProperties,
  type Analytics,
} from "firebase/analytics";

type AnalyticsPayload = Record<string, unknown>;

type IdentifyFirebaseUserPayload = {
  clientId?: string | null;
  onboardingCompleted?: boolean;
  levelLetter?: string | null;
  levelNumeric?: string | number | null;
};

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyDEjZ9c-wyVcxK3YcqaYNOLPCGF0srul6Q",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "padlhub.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "padlhub",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "padlhub.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "743700931941",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:743700931941:web:f149df985d436486a2ad8c",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? "G-R8NG2E9S0E",
};

const FIREBASE_DISABLED =
  String(import.meta.env.VITE_FIREBASE_ANALYTICS_ENABLED ?? "true").toLowerCase() === "false";
const REDACTED_PARAM_VALUE = "[redacted]";
const MAX_PARAM_STRING_LENGTH = 100;

let analyticsPromise: Promise<Analytics | null> | null = null;

function getFirebaseApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

function canUseFirebaseAnalytics() {
  return !FIREBASE_DISABLED && typeof window !== "undefined" && typeof document !== "undefined";
}

async function getFirebaseAnalytics(): Promise<Analytics | null> {
  if (!canUseFirebaseAnalytics()) return null;
  if (analyticsPromise) return analyticsPromise;

  analyticsPromise = (async () => {
    try {
      if (!(await isSupported())) return null;
      return getAnalytics(getFirebaseApp());
    } catch (error) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[Firebase analytics] initialization failed", error);
      }
      return null;
    }
  })();

  return analyticsPromise;
}

function normalizeEventName(event: string): string {
  const normalized = event.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([^a-zA-Z])/, "lk_$1");
  return normalized.slice(0, 40) || "lk_event";
}

function normalizeParamName(key: string): string {
  const normalized = key.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([^a-zA-Z])/, "lk_$1");
  return normalized.slice(0, 40) || "param";
}

function shouldRedactParam(key: string): boolean {
  return /(phone|email|token|code|password|secret)/i.test(key);
}

function trimParamString(value: string): string {
  return value.length <= MAX_PARAM_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_PARAM_STRING_LENGTH - 3)}...`;
}

function serializeParamValue(key: string, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (shouldRedactParam(key)) return REDACTED_PARAM_VALUE;
  if (typeof value === "string") return trimParamString(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  try {
    return trimParamString(JSON.stringify(value));
  } catch {
    return trimParamString(String(value));
  }
}

function sanitizeFirebaseParams(payload: AnalyticsPayload): AnalyticsPayload {
  const params: AnalyticsPayload = {};

  for (const [key, value] of Object.entries(payload)) {
    const serialized = serializeParamValue(key, value);
    if (serialized === null) continue;
    params[normalizeParamName(key)] = serialized;
  }

  return params;
}

export function trackFirebaseAnalyticsEvent(event: string, payload: AnalyticsPayload = {}) {
  const eventName = normalizeEventName(event);
  const eventParams = sanitizeFirebaseParams(payload);

  void getFirebaseAnalytics().then((analytics) => {
    if (!analytics) return;
    try {
      logEvent(analytics, eventName, eventParams);
    } catch (error) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[Firebase analytics] event logging failed", error);
      }
    }
  });
}

export function identifyFirebaseAnalyticsUser(payload: IdentifyFirebaseUserPayload) {
  void getFirebaseAnalytics().then((analytics) => {
    if (!analytics) return;

    try {
      const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
      if (clientId) {
        setUserId(analytics, clientId);
      }

      const userProperties: Record<string, string> = {};
      if (typeof payload.onboardingCompleted === "boolean") {
        userProperties.onboarding_completed = String(payload.onboardingCompleted);
      }
      if (payload.levelLetter) {
        userProperties.level_letter = String(payload.levelLetter);
      }
      if (payload.levelNumeric !== null && payload.levelNumeric !== undefined) {
        userProperties.level_numeric = String(payload.levelNumeric);
      }

      if (Object.keys(userProperties).length > 0) {
        setUserProperties(analytics, userProperties);
      }
    } catch (error) {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn("[Firebase analytics] user identification failed", error);
      }
    }
  });
}
