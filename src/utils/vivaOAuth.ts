import {
  AUTH_RUNTIME_CABINET_URL,
  AUTH_RUNTIME_KEYCLOAK_BASE,
} from "../consts/authRuntime.ts";
import type { VivaOAuthProvider } from "../context/authShared";
import { getVivaOAuthStorageKey, resolveConfiguredAuthMode } from "./authMode.ts";

const VIVA_REALM = "clients";

export type PendingVivaOAuth = {
  provider: VivaOAuthProvider;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
};

function canUseSessionStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function encodeBase64Url(buffer: Uint8Array) {
  let value = "";
  for (let index = 0; index < buffer.length; index += 1) {
    value += String.fromCharCode(buffer[index]);
  }
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateRandomBase64Url(byteLength: number) {
  const array = new Uint8Array(byteLength);
  crypto.getRandomValues(array);
  return encodeBase64Url(array);
}

async function createCodeChallenge(codeVerifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return encodeBase64Url(new Uint8Array(digest));
}

function stripOAuthParams(url: URL) {
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("session_state");
  url.searchParams.delete("iss");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  return url;
}

export function cleanupVivaOAuthCallbackUrl() {
  if (typeof window === "undefined") return;
  const cleanUrl = stripOAuthParams(new URL(window.location.href));
  window.history.replaceState({}, "", cleanUrl.toString());
}

export function buildVivaOAuthReturnUrl() {
  const currentUrl = stripOAuthParams(new URL(window.location.href));
  if (resolveConfiguredAuthMode() === "viva") {
    currentUrl.searchParams.set("authMode", "viva");
  }
  return currentUrl.toString();
}

export function buildVivaOAuthCallbackUrl() {
  const currentUrl = new URL(window.location.href);
  const cabinetPath = (() => {
    try {
      return new URL(AUTH_RUNTIME_CABINET_URL, currentUrl.origin).pathname || "/lk_new";
    } catch {
      return "/lk_new";
    }
  })();

  const callbackUrl = new URL(cabinetPath, currentUrl.origin);
  const currentParams = new URLSearchParams(currentUrl.search);
  const channel = currentParams.get("channel");
  if (channel) {
    callbackUrl.searchParams.set("channel", channel);
  }
  callbackUrl.searchParams.set("authMode", "viva");
  return callbackUrl.toString();
}

export function readPendingVivaOAuth(): PendingVivaOAuth | null {
  if (!canUseSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(getVivaOAuthStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingVivaOAuth>;
    if (
      !parsed
      || typeof parsed !== "object"
      || typeof parsed.state !== "string"
      || typeof parsed.codeVerifier !== "string"
      || typeof parsed.redirectUri !== "string"
      || typeof parsed.returnTo !== "string"
      || (parsed.provider !== "vkid" && parsed.provider !== "yandex")
    ) {
      return null;
    }
    return parsed as PendingVivaOAuth;
  } catch {
    return null;
  }
}

export function clearPendingVivaOAuth() {
  if (!canUseSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(getVivaOAuthStorageKey());
  } catch {
    // Ignore session storage failures.
  }
}

export function isPendingVivaOAuthReturn() {
  if (typeof window === "undefined") return false;
  const code = new URLSearchParams(window.location.search).get("code");
  const pending = readPendingVivaOAuth();
  return Boolean(code && pending);
}

export async function startVivaOAuthRedirect(
  provider: VivaOAuthProvider,
  clientId: string,
  tenantKey: string,
  onPending?: (pending: PendingVivaOAuth) => Promise<boolean> | boolean,
) {
  const codeVerifier = generateRandomBase64Url(32);
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const state = generateRandomBase64Url(16);
  const redirectUri = buildVivaOAuthCallbackUrl();
  const returnTo = buildVivaOAuthReturnUrl();

  const pending: PendingVivaOAuth = {
    provider,
    state,
    codeVerifier,
    redirectUri,
    returnTo,
  };

  if (canUseSessionStorage()) {
    window.sessionStorage.setItem(getVivaOAuthStorageKey(), JSON.stringify(pending));
  }

  if (onPending && !await onPending(pending)) {
    clearPendingVivaOAuth();
    throw new Error("Auth consent could not be stored before OAuth redirect");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    kc_idp_hint: provider,
    tenant_key: tenantKey,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${AUTH_RUNTIME_KEYCLOAK_BASE}/realms/${VIVA_REALM}/protocol/openid-connect/auth?${params.toString()}`;
}
