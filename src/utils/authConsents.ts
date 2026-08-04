import { SERV2, SERV2_FALLBACK, TENANT_KEY } from "../consts/api_config";
import { readAuthToken } from "./authTokenStorage";
import { trackAnalyticsEvent, trackClientError } from "./analytics";
import { buildProjectUrlCandidates } from "./lkApiBaseUrls";
import { isLkIdleRequestPausedError } from "./lkIdleDataGuard";
import { extractJwtStringClaim } from "./vivaAuthJwt";

export const AUTH_CONSENT_DOCUMENT_SET_VERSION = "2026-07-14";
export const AUTH_CONSENT_DOCUMENTS = [
  {
    id: "public-offer",
    title: "Публичная оферта",
    version: "2026-07-14",
    url: "https://padlhub.ru/docs",
  },
  {
    id: "personal-data-policy",
    title: "Политика обработки персональных данных",
    version: "2026-07-14",
    url: "https://padlhub.ru/politica",
  },
] as const;

type AuthConsentMethod = "sms" | "vkid" | "yandex";

type AuthConsentAttempt = {
  authMethod: AuthConsentMethod;
  bindingType: "sms-phone" | "oauth-state";
  bindingValue: string;
};

type PendingAuthConsent = {
  schemaVersion: 1;
  documentSetVersion: string;
  acceptedAtClient: string;
  authMethod: AuthConsentMethod;
  attemptFingerprint: string;
  subjectFingerprint: string | null;
  documents: Array<{
    id: string;
    version: string;
    url: string;
    accepted: true;
  }>;
};

const AUTH_CONSENT_STORAGE_PREFIX = `${TENANT_KEY}_pending_auth_consent_v1`;
const AUTH_CONSENT_ENDPOINT_PATH = "/lk/analytics/auth-consents";
const RETRYABLE_HTTP_STATUSES = new Set([404, 405, 408, 425, 429, 500, 502, 503, 504]);

let syncInFlight: Promise<boolean> | null = null;
let retryTimer: number | null = null;
let retryAttempt = 0;

async function fingerprintSubject(subject: string): Promise<string> {
  if (globalThis.crypto?.subtle && typeof TextEncoder !== "undefined") {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(subject),
    );
    return Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  let hash = 2166136261;
  for (let index = 0; index < subject.length; index += 1) {
    hash ^= subject.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getStorageCandidates(): Storage[] {
  if (typeof window === "undefined") return [];
  const storages: Storage[] = [];
  try {
    storages.push(window.localStorage);
  } catch {
    // Fall back to sessionStorage when persistent storage is blocked.
  }
  try {
    storages.push(window.sessionStorage);
  } catch {
    // Authentication remains available even when all browser storage is blocked.
  }
  return storages;
}

function normalizeAttemptBinding(attempt: AuthConsentAttempt) {
  const value = attempt.bindingType === "sms-phone"
    ? attempt.bindingValue.replace(/\D/g, "")
    : attempt.bindingValue.trim();
  return `${attempt.bindingType}:${value}`;
}

function storageKeyForAttempt(attemptFingerprint: string) {
  return `${AUTH_CONSENT_STORAGE_PREFIX}:${attemptFingerprint}`;
}

function readPendingAuthConsents(): PendingAuthConsent[] {
  const pendingByAttempt = new Map<string, PendingAuthConsent>();
  for (const storage of getStorageCandidates()) {
    try {
      const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter((key): key is string => Boolean(key?.startsWith(`${AUTH_CONSENT_STORAGE_PREFIX}:`)));
      for (const key of keys) {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Partial<PendingAuthConsent>;
        const acceptedAtTs = Date.parse(String(parsed.acceptedAtClient || ""));
        const isCurrentVersion = parsed.documentSetVersion === AUTH_CONSENT_DOCUMENT_SET_VERSION;
        const attemptFingerprint = typeof parsed.attemptFingerprint === "string"
          ? parsed.attemptFingerprint
          : "";
        const hasValidAttempt = attemptFingerprint.length > 0;
        if (
          parsed.schemaVersion !== 1
          || !isCurrentVersion
          || !Number.isFinite(acceptedAtTs)
          || acceptedAtTs > Date.now() + 5 * 60 * 1000
          || !hasValidAttempt
          || key !== storageKeyForAttempt(attemptFingerprint)
          || !Array.isArray(parsed.documents)
        ) {
          storage.removeItem(key);
          continue;
        }
        if (!pendingByAttempt.has(attemptFingerprint)) {
          pendingByAttempt.set(attemptFingerprint, parsed as PendingAuthConsent);
        }
      }
    } catch {
      // Try the next storage backend.
    }
  }
  return Array.from(pendingByAttempt.values());
}

function writePendingAuthConsent(value: PendingAuthConsent) {
  const serialized = JSON.stringify(value);
  const key = storageKeyForAttempt(value.attemptFingerprint);
  let written = false;
  for (const storage of getStorageCandidates()) {
    try {
      if (!written) {
        storage.setItem(key, serialized);
        written = true;
        continue;
      }
      storage.removeItem(key);
    } catch {
      // Try the next storage backend.
    }
  }
  return written;
}

function removePendingAuthConsent(attemptFingerprint: string) {
  const key = storageKeyForAttempt(attemptFingerprint);
  for (const storage of getStorageCandidates()) {
    try {
      storage.removeItem(key);
    } catch {
      // Try the next storage backend.
    }
  }
}

function buildConsentEndpoint() {
  try {
    return new URL(AUTH_CONSENT_ENDPOINT_PATH, new URL(SERV2).origin).toString();
  } catch {
    return `https://padlhub.su${AUTH_CONSENT_ENDPOINT_PATH}`;
  }
}

function resolveEndpointCandidates() {
  return buildProjectUrlCandidates(buildConsentEndpoint(), SERV2, SERV2_FALLBACK);
}

export function hasPendingAuthConsents() {
  return readPendingAuthConsents().length > 0;
}

export function hasRetryablePendingAuthConsents() {
  return readPendingAuthConsents().some((pending) => Boolean(pending.subjectFingerprint));
}

export async function stageAuthConsents(attempt: AuthConsentAttempt): Promise<boolean> {
  const pending: PendingAuthConsent = {
    schemaVersion: 1,
    documentSetVersion: AUTH_CONSENT_DOCUMENT_SET_VERSION,
    acceptedAtClient: new Date().toISOString(),
    authMethod: attempt.authMethod,
    attemptFingerprint: await fingerprintSubject(normalizeAttemptBinding(attempt)),
    subjectFingerprint: null,
    documents: AUTH_CONSENT_DOCUMENTS.map((document) => ({
      id: document.id,
      version: document.version,
      url: document.url,
      accepted: true,
    })),
  };
  const persisted = writePendingAuthConsent(pending);
  if (!persisted) {
    trackClientError(
      "auth.consents_queue_failed",
      new Error("Auth consent could not be stored before authentication"),
      { documentSetVersion: pending.documentSetVersion, authMethod: attempt.authMethod },
      { handled: true, severity: "error" },
    );
    return false;
  }
  trackAnalyticsEvent("auth_consents_staged", {
    documentSetVersion: pending.documentSetVersion,
    authMethod: attempt.authMethod,
  });
  return true;
}

export async function clearPendingAuthConsents(attempt: AuthConsentAttempt) {
  const attemptFingerprint = await fingerprintSubject(normalizeAttemptBinding(attempt));
  const current = readPendingAuthConsents().find((pending) => (
    pending.attemptFingerprint === attemptFingerprint
    && pending.authMethod === attempt.authMethod
  ));
  if (!current || current.subjectFingerprint) return;
  removePendingAuthConsent(attemptFingerprint);
}

async function postPendingConsent(
  endpoint: string,
  authToken: string,
  pending: PendingAuthConsent,
  timeoutMs: number,
) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = window.setTimeout(() => controller?.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: pending.schemaVersion,
        documentSetVersion: pending.documentSetVersion,
        acceptedAtClient: pending.acceptedAtClient,
        authMethod: pending.authMethod,
        documents: pending.documents,
      }),
      signal: controller?.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const error = new Error(`Auth consent audit failed: HTTP ${response.status}`);
    return { ok: false, error, retryable: RETRYABLE_HTTP_STATUSES.has(response.status) };
  }

  return { ok: true, error: null, retryable: false };
}

function schedulePendingAuthConsentRetry() {
  if (
    typeof window === "undefined"
    || retryTimer !== null
    || !hasRetryablePendingAuthConsents()
  ) return;
  const delayMs = Math.min(1_000 * (2 ** retryAttempt), 60_000);
  retryAttempt = Math.min(retryAttempt + 1, 6);
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void syncPendingAuthConsents();
  }, delayMs);
}

export async function syncPendingAuthConsents(attempt?: AuthConsentAttempt): Promise<boolean> {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const authToken = readAuthToken();
    if (!authToken) return false;

    const subject = extractJwtStringClaim(authToken, ["sub"]);
    if (!subject) return false;
    const subjectFingerprint = await fingerprintSubject(subject);
    const attemptFingerprint = attempt
      ? await fingerprintSubject(normalizeAttemptBinding(attempt))
      : null;
    const pending = readPendingAuthConsents().find((candidate) => (
      attemptFingerprint
        ? candidate.attemptFingerprint === attemptFingerprint && candidate.authMethod === attempt?.authMethod
        : candidate.subjectFingerprint === subjectFingerprint
    ));
    if (!pending) return false;
    if (pending.subjectFingerprint && pending.subjectFingerprint !== subjectFingerprint) return false;

    if (!pending.subjectFingerprint) {
      if (!attempt || attempt.authMethod !== pending.authMethod) return false;
      if (attemptFingerprint !== pending.attemptFingerprint) return false;
      pending.subjectFingerprint = subjectFingerprint;
      if (!writePendingAuthConsent(pending)) return false;
    }

    const endpoints = resolveEndpointCandidates();
    const deadline = Date.now() + 2_500;
    let lastError: unknown = null;
    let shouldRetry = false;
    for (const endpoint of endpoints) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        shouldRetry = true;
        break;
      }
      try {
        const result = await postPendingConsent(endpoint, authToken, pending, remainingMs);
        if (result.ok) {
          removePendingAuthConsent(pending.attemptFingerprint);
          if (retryTimer !== null) window.clearTimeout(retryTimer);
          retryTimer = null;
          retryAttempt = 0;
          trackAnalyticsEvent("auth_consents_recorded", {
            documentSetVersion: pending.documentSetVersion,
            authMethod: pending.authMethod,
          });
          if (hasRetryablePendingAuthConsents()) schedulePendingAuthConsentRetry();
          return true;
        }
        lastError = result.error;
        shouldRetry = result.retryable;
        if (!result.retryable) break;
      } catch (error) {
        lastError = error;
        if (isLkIdleRequestPausedError(error)) {
          shouldRetry = false;
          break;
        }
        shouldRetry = true;
        continue;
      }
    }

    trackClientError(
      "auth.consents_record_failed",
      lastError ?? new Error("Auth consent endpoint is unavailable"),
      { documentSetVersion: pending.documentSetVersion, endpoints },
      { handled: true, severity: "warning" },
    );
    if (shouldRetry) schedulePendingAuthConsentRetry();
    return false;
  })().finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}
