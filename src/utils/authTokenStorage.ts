import { deleteCookie, getCookie, setCookie } from "./cookies.ts";

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

function readCookieBySuffix(cookieNameSuffix: string): string | null {
  if (typeof document === "undefined") return null;
  const cookies = String(document.cookie || "").split("; ");
  for (const row of cookies) {
    if (!row) continue;
    const [name, ...rest] = row.split("=");
    if (!name || !name.endsWith(cookieNameSuffix)) continue;
    const value = rest.join("=");
    const normalized = normalizeToken(value);
    if (normalized) return normalized;
  }
  return null;
}

function deleteCookiesBySuffix(cookieNameSuffix: string) {
  if (typeof document === "undefined") return;
  const cookies = String(document.cookie || "").split("; ");
  for (const row of cookies) {
    if (!row) continue;
    const [name] = row.split("=");
    if (!name || !name.endsWith(cookieNameSuffix)) continue;
    deleteCookie(name);
  }
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
    normalizeToken(getCookie(AUTH_TOKEN_COOKIE_NAME))
    || readCookieBySuffix("AuthToken")
    || readStoredToken(AUTH_TOKEN_STORAGE_KEY)
  );
}

export function readRefreshToken(): string | null {
  return (
    normalizeToken(getCookie(REFRESH_TOKEN_COOKIE_NAME))
    || readCookieBySuffix("RefreshToken")
    || readStoredToken(REFRESH_TOKEN_STORAGE_KEY)
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
    deleteCookiesBySuffix("AuthToken");
    writeStorage(AUTH_TOKEN_STORAGE_KEY, null);
  }

  const normalizedRefreshToken = normalizeToken(refreshToken);
  if (normalizedRefreshToken) {
    setCookie(REFRESH_TOKEN_COOKIE_NAME, normalizedRefreshToken, toCookieMaxAge(refreshExpiresIn));
    writeStoredToken(REFRESH_TOKEN_STORAGE_KEY, normalizedRefreshToken, refreshExpiresIn);
  } else {
    deleteCookiesBySuffix("RefreshToken");
    writeStorage(REFRESH_TOKEN_STORAGE_KEY, null);
  }
}

export function clearAuthTokens() {
  deleteCookiesBySuffix("AuthToken");
  deleteCookiesBySuffix("RefreshToken");
  writeStorage(AUTH_TOKEN_STORAGE_KEY, null);
  writeStorage(REFRESH_TOKEN_STORAGE_KEY, null);
}
