import { AUTH_RUNTIME_TENANT_KEY } from "../consts/authRuntime.ts";
import {
  clearAuthTokens,
  persistAuthTokens,
  readAuthToken,
  readRefreshToken,
} from "./authTokenStorage.ts";
import { deleteCookie, setCookie } from "./cookies.ts";

const LEGACY_AUTH_COOKIE = `${AUTH_RUNTIME_TENANT_KEY}AuthToken`;
const LEGACY_REFRESH_COOKIE = `${AUTH_RUNTIME_TENANT_KEY}RefreshToken`;

function normalizeTtl(value: number | string | null | undefined) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

export function readVivaAccessToken() {
  return readAuthToken();
}

export function readVivaRefreshToken() {
  return readRefreshToken();
}

export function shouldRestoreVivaSession(
  accessToken: string | null | undefined = readVivaAccessToken(),
  refreshToken: string | null | undefined = readVivaRefreshToken(),
) {
  return !accessToken && Boolean(refreshToken);
}

export function persistVivaAuthTokens(
  accessToken: string | null | undefined,
  accessExpiresIn: number | string | null | undefined,
  refreshToken: string | null | undefined,
  refreshExpiresIn: number | string | null | undefined,
) {
  persistAuthTokens(accessToken, accessExpiresIn, refreshToken, refreshExpiresIn);

  if (accessToken) {
    setCookie(LEGACY_AUTH_COOKIE, accessToken, normalizeTtl(accessExpiresIn));
  } else {
    deleteCookie(LEGACY_AUTH_COOKIE);
  }

  if (refreshToken) {
    setCookie(LEGACY_REFRESH_COOKIE, refreshToken, normalizeTtl(refreshExpiresIn));
  } else {
    deleteCookie(LEGACY_REFRESH_COOKIE);
  }
}

export function clearVivaAuthTokens() {
  clearAuthTokens();
  deleteCookie(LEGACY_AUTH_COOKIE);
  deleteCookie(LEGACY_REFRESH_COOKIE);
}
