import type { AuthMode } from "../context/authShared";

const AUTH_MODE_QUERY_PARAM = "authMode";
const VIVA_OAUTH_STORAGE_KEY = "padlhub_viva_oauth_pending_v1";
const DEFAULT_NAVIGATION_URL_PARAMS = ["cabinetUrl", "returnUrl"] as const;

function normalizeAuthMode(value: string | null | undefined): AuthMode | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "legacy" || normalized === "viva") {
    return normalized;
  }
  return null;
}

function canUseSessionStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function getVivaOAuthStorageKey() {
  return VIVA_OAUTH_STORAGE_KEY;
}

export function hasPendingVivaOAuthState() {
  if (!canUseSessionStorage()) return false;
  try {
    return Boolean(window.sessionStorage.getItem(VIVA_OAUTH_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function readExplicitAuthModeFromLocation(): AuthMode | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeAuthMode(new URLSearchParams(window.location.search).get(AUTH_MODE_QUERY_PARAM));
  } catch {
    return null;
  }
}

export function readAuthModeWindowDefault(): AuthMode | null {
  if (typeof window === "undefined") return null;
  return normalizeAuthMode(window.__LK_AUTH_MODE__);
}

export function resolveConfiguredAuthMode(): AuthMode {
  return (
    readExplicitAuthModeFromLocation()
    || readAuthModeWindowDefault()
    || (hasPendingVivaOAuthState() ? "viva" : null)
    || "viva"
  );
}

export function appendAuthModeToUrl(
  input: string | URL,
  mode: AuthMode = resolveConfiguredAuthMode(),
) {
  const baseHref = typeof window !== "undefined" ? window.location.href : "https://padlhub.ru/";
  const url = input instanceof URL ? new URL(input.toString()) : new URL(String(input), baseHref);
  url.searchParams.set(AUTH_MODE_QUERY_PARAM, mode);
  return url;
}

export function appendCurrentAuthModeToUrl(input: string | URL) {
  return appendAuthModeToUrl(input, resolveConfiguredAuthMode());
}

function appendAuthModeToNestedUrlParams(
  url: URL,
  mode: AuthMode,
  nestedParamNames: readonly string[],
) {
  nestedParamNames.forEach((paramName) => {
    const rawValue = url.searchParams.get(paramName);
    if (!rawValue?.trim()) return;

    try {
      const nestedUrl = appendAuthModeToUrl(rawValue, mode);
      url.searchParams.set(paramName, nestedUrl.toString());
    } catch {
      // Ignore malformed nested URLs and keep the original value.
    }
  });
  return url;
}

export function appendAuthModeToNavigableUrl(
  input: string | URL,
  mode: AuthMode = resolveConfiguredAuthMode(),
  nestedParamNames: readonly string[] = DEFAULT_NAVIGATION_URL_PARAMS,
) {
  const url = appendAuthModeToUrl(input, mode);
  return appendAuthModeToNestedUrlParams(url, mode, nestedParamNames);
}

export function appendCurrentAuthModeToNavigableUrl(
  input: string | URL,
  nestedParamNames: readonly string[] = DEFAULT_NAVIGATION_URL_PARAMS,
) {
  return appendAuthModeToNavigableUrl(input, resolveConfiguredAuthMode(), nestedParamNames);
}
