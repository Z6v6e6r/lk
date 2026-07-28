import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVivaOAuthCallbackUrl,
  buildVivaOAuthReturnUrl,
  clearPendingVivaOAuth,
  readPendingVivaOAuth,
} from "../../src/utils/vivaOAuth.ts";
import { getVivaOAuthStorageKey } from "../../src/utils/authMode.ts";

function installWindowMock(href: string) {
  const sessionStorageMap = new Map<string, string>();
  const url = new URL(href);
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        search: url.search,
        origin: url.origin,
      },
      sessionStorage: {
        getItem(key: string) {
          return sessionStorageMap.has(key) ? sessionStorageMap.get(key) ?? null : null;
        },
        setItem(key: string, value: string) {
          sessionStorageMap.set(key, String(value));
        },
        removeItem(key: string) {
          sessionStorageMap.delete(key);
        },
      },
      history: {
        replaceState() {},
      },
    },
  });

  return {
    sessionStorageMap,
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as typeof globalThis & { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: previousWindow,
        });
      }
    },
  };
}

test("viva oauth callback url uses cabinet path and preserves channel", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?channel=dev&joinGame=abc");
  try {
    const callbackUrl = new URL(buildVivaOAuthCallbackUrl());
    assert.equal(callbackUrl.origin, "https://padlhub.ru");
    assert.equal(callbackUrl.pathname, "/lk_new");
    assert.equal(callbackUrl.searchParams.get("channel"), "dev");
    assert.equal(callbackUrl.searchParams.get("authMode"), "viva");
  } finally {
    mocks.restore();
  }
});

test("viva oauth return url keeps original route and injects auth mode", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?joinGame=abc&channel=dev&authMode=viva");
  try {
    const returnUrl = new URL(buildVivaOAuthReturnUrl());
    assert.equal(returnUrl.pathname, "/game_join");
    assert.equal(returnUrl.searchParams.get("joinGame"), "abc");
    assert.equal(returnUrl.searchParams.get("channel"), "dev");
    assert.equal(returnUrl.searchParams.get("authMode"), "viva");
  } finally {
    mocks.restore();
  }
});

test("viva oauth pending state can be read and cleared", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new?authMode=viva");
  try {
    mocks.sessionStorageMap.set(getVivaOAuthStorageKey(), JSON.stringify({
      provider: "vkid",
      state: "state-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://padlhub.ru/lk_new?authMode=viva",
      returnTo: "https://padlhub.ru/game_join?authMode=viva",
    }));

    assert.equal(readPendingVivaOAuth()?.provider, "vkid");
    clearPendingVivaOAuth();
    assert.equal(readPendingVivaOAuth(), null);
  } finally {
    mocks.restore();
  }
});
