import { clearTournamentPendingPayments } from "./tournamentPendingPayment";
import { invalidateSubscriptionSnapshot } from "./subscriptionSessionCache";
import { deleteCookie, setCookie } from "./cookies.ts";
import { AUTH_RUNTIME_TENANT_KEY } from "../consts/authRuntime.ts";

const AUTH_TOKEN_COOKIE_NAME = "padlhubAuthToken";
const REFRESH_TOKEN_COOKIE_NAME = "padlhubRefreshToken";
const AUTH_TOKEN_STORAGE_KEY = "padlhub_auth_token_v1";
const REFRESH_TOKEN_STORAGE_KEY = "padlhub_refresh_token_v1";

type StoredTokenEnvelope = {
  token: string;
  expiresAt: number | null;
};

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
    // Ignore storage failures.
  }
}

function normalizeToken(value: string | null | undefined): string | null {
  const token = String(value || "").trim();
  return token || null;
}

function toExpiresAt(maxAgeSeconds: number | string | null | undefined): number | null {
  if (maxAgeSeconds === null || maxAgeSeconds === undefined) return null;
  const seconds = typeof maxAgeSeconds === "number" ? maxAgeSeconds : Number(maxAgeSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Date.now() + Math.floor(seconds) * 1000;
}

function toCookieMaxAge(maxAgeSeconds: number | string | null | undefined): number | null {
  if (maxAgeSeconds === null || maxAgeSeconds === undefined) return null;
  const seconds = typeof maxAgeSeconds === "number" ? maxAgeSeconds : Number(maxAgeSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.floor(seconds);
}

function serializeTokenEnvelope(token: string, maxAgeSeconds?: number | string | null): string {
  const envelope: StoredTokenEnvelope = {
    token,
    expiresAt: toExpiresAt(maxAgeSeconds),
  };
  return JSON.stringify(envelope);
}

function parseTokenEnvelope(raw: string | null): StoredTokenEnvelope | null {
  const token = normalizeToken(raw);
  if (!token) return null;

  try {
    const parsed = JSON.parse(token) as unknown;
    if (typeof parsed === "string") {
      const stringToken = normalizeToken(parsed);
      return stringToken ? { token: stringToken, expiresAt: null } : null;
    }
    if (parsed && typeof parsed === "object") {
      const candidate = parsed as Partial<StoredTokenEnvelope>;
      const normalizedToken = normalizeToken(candidate.token);
      if (!normalizedToken) return null;
      const expiresAt = typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)
        ? candidate.expiresAt
        : null;
      return { token: normalizedToken, expiresAt };
    }
  } catch {
    // Legacy plain token stored as raw string.
  }

  return { token, expiresAt: null };
}

function readExactCookie(cookieName: string): string | null {
  if (typeof document === "undefined") return null;
  const cookies = String(document.cookie || "").split(/;\s*/);
  for (const row of cookies) {
    if (!row) continue;
    const [name, ...rest] = row.split("=");
    if (name !== cookieName) continue;
    const value = rest.join("=");
    const normalized = normalizeToken(value);
    if (normalized) return normalized;
  }
  return null;
}

function deleteOwnedCookies(canonicalName: string, tenantSuffix: string) {
  if (typeof document === "undefined") return;
  deleteCookie(canonicalName);
  deleteCookie(`${AUTH_RUNTIME_TENANT_KEY}${tenantSuffix}`);
}

function readStoredToken(key: string): string | null {
  const envelope = parseTokenEnvelope(readStorage(key));
  if (!envelope) return null;
  if (envelope.expiresAt !== null && envelope.expiresAt <= Date.now()) {
    writeStorage(key, null);
    return null;
  }
  return envelope.token;
}

function writeStoredToken(key: string, token: string | null, maxAgeSeconds?: number | string | null) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    writeStorage(key, null);
    return;
  }
  writeStorage(key, serializeTokenEnvelope(normalizedToken, maxAgeSeconds));
}

export function readAuthToken(): string | null {
  return (
    readExactCookie(AUTH_TOKEN_COOKIE_NAME)
    || readStoredToken(AUTH_TOKEN_STORAGE_KEY)
    || readExactCookie(`${AUTH_RUNTIME_TENANT_KEY}AuthToken`)
  );
}

export function readRefreshToken(): string | null {
  return (
    readExactCookie(REFRESH_TOKEN_COOKIE_NAME)
    || readStoredToken(REFRESH_TOKEN_STORAGE_KEY)
    || readExactCookie(`${AUTH_RUNTIME_TENANT_KEY}RefreshToken`)
  );
}

export function persistAuthTokens(
  accessToken: string | null | undefined,
  accessExpiresIn: number | string | null | undefined,
  refreshToken: string | null | undefined,
  refreshExpiresIn: number | string | null | undefined,
) {
  const normalizedAccessToken = normalizeToken(accessToken);
  if (normalizedAccessToken) {
    setCookie(AUTH_TOKEN_COOKIE_NAME, normalizedAccessToken, toCookieMaxAge(accessExpiresIn));
    writeStoredToken(AUTH_TOKEN_STORAGE_KEY, normalizedAccessToken, accessExpiresIn);
  } else {
    deleteOwnedCookies(AUTH_TOKEN_COOKIE_NAME, "AuthToken");
    writeStorage(AUTH_TOKEN_STORAGE_KEY, null);
  }

  const normalizedRefreshToken = normalizeToken(refreshToken);
  if (normalizedRefreshToken) {
    setCookie(REFRESH_TOKEN_COOKIE_NAME, normalizedRefreshToken, toCookieMaxAge(refreshExpiresIn));
    writeStoredToken(REFRESH_TOKEN_STORAGE_KEY, normalizedRefreshToken, refreshExpiresIn);
  } else {
    deleteOwnedCookies(REFRESH_TOKEN_COOKIE_NAME, "RefreshToken");
    writeStorage(REFRESH_TOKEN_STORAGE_KEY, null);
  }
}

export function clearAuthTokens() {
  clearTournamentPendingPayments();
  invalidateSubscriptionSnapshot();
  clearAuthSessionTokens();
}

// Session incompatibility must not delete pending payments or consent evidence.
export function clearAuthSessionTokens() {
  deleteOwnedCookies(AUTH_TOKEN_COOKIE_NAME, "AuthToken");
  deleteOwnedCookies(REFRESH_TOKEN_COOKIE_NAME, "RefreshToken");
  writeStorage(AUTH_TOKEN_STORAGE_KEY, null);
  writeStorage(REFRESH_TOKEN_STORAGE_KEY, null);
}
