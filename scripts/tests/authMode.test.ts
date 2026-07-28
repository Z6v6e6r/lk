import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCurrentAuthModeToUrl,
  appendCurrentAuthModeToNavigableUrl,
  hasPendingVivaOAuthState,
  resolveConfiguredAuthMode,
} from "../../src/utils/authMode.ts";

function installWindowMock(href: string, authMode?: "legacy" | "viva") {
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
      __LK_AUTH_MODE__: authMode,
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

test("auth mode prefers explicit query param", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new?authMode=viva", "legacy");
  try {
    assert.equal(resolveConfiguredAuthMode(), "viva");
  } finally {
    mocks.restore();
  }
});

test("auth mode falls back to window default", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new", "viva");
  try {
    assert.equal(resolveConfiguredAuthMode(), "viva");
  } finally {
    mocks.restore();
  }
});

test("auth mode switches to viva when pending oauth state exists", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new");
  try {
    mocks.sessionStorageMap.set("padlhub_viva_oauth_pending_v1", "{\"state\":\"ok\"}");
    assert.equal(hasPendingVivaOAuthState(), true);
    assert.equal(resolveConfiguredAuthMode(), "viva");
  } finally {
    mocks.restore();
  }
});

test("auth mode defaults to viva when no explicit override exists", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new");
  try {
    assert.equal(resolveConfiguredAuthMode(), "viva");
  } finally {
    mocks.restore();
  }
});

test("appendCurrentAuthModeToUrl preserves viva switch", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?channel=dev&authMode=viva");
  try {
    const url = appendCurrentAuthModeToUrl("https://padlhub.ru/lk_new?channel=dev");
    assert.equal(url.searchParams.get("authMode"), "viva");
    assert.equal(url.searchParams.get("channel"), "dev");
  } finally {
    mocks.restore();
  }
});

test("appendCurrentAuthModeToUrl preserves explicit legacy rollback", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?channel=dev&authMode=legacy");
  try {
    const url = appendCurrentAuthModeToUrl("https://padlhub.ru/lk_new?channel=dev");
    assert.equal(url.searchParams.get("authMode"), "legacy");
    assert.equal(url.searchParams.get("channel"), "dev");
  } finally {
    mocks.restore();
  }
});

test("appendCurrentAuthModeToNavigableUrl also updates nested return params", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?channel=dev&authMode=viva");
  try {
    const url = appendCurrentAuthModeToNavigableUrl(
      "https://padlhub.ru/finde_game?cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk_new%3Fchannel%3Ddev",
    );
    assert.equal(url.searchParams.get("authMode"), "viva");
    const nestedCabinetUrl = new URL(String(url.searchParams.get("cabinetUrl") || ""));
    assert.equal(nestedCabinetUrl.searchParams.get("authMode"), "viva");
    assert.equal(nestedCabinetUrl.searchParams.get("channel"), "dev");
  } finally {
    mocks.restore();
  }
});
