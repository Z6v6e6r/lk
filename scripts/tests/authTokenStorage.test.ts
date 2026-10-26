import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAuthTokens,
  persistAuthTokens,
  readAuthToken,
  readRefreshToken,
  clearAuthSessionTokens,
} from "../../src/utils/authTokenStorage.ts";
import { AUTH_RUNTIME_TENANT_KEY } from "../../src/consts/authRuntime.ts";

function installAuthStorageMocks() {
  const cookieJar = new Map<string, string>();
  const storage = new Map<string, string>();

  const documentMock = {};
  Object.defineProperty(documentMock, "cookie", {
    configurable: true,
    get() {
      return [...cookieJar.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    set(value: string) {
      const [pair, ...attributes] = String(value).split(";").map((part) => part.trim());
      const [name, ...rest] = pair.split("=");
      const cookieValue = rest.join("=");
      const isDeletion = attributes.some(
        (attribute) =>
          /^expires=/i.test(attribute) && /Thu, 01 Jan 1970/i.test(attribute),
      );
      const maxAgeAttribute = attributes.find((attribute) => /^max-age=/i.test(attribute));
      const isExpired = maxAgeAttribute === "max-age=0";

      if (isDeletion || isExpired) {
        cookieJar.delete(name);
        return;
      }

      if (name) {
        cookieJar.set(name, cookieValue);
      }
    },
  });

  const localStorageMock = {
    getItem(key: string) {
      return storage.has(key) ? storage.get(key) ?? null : null;
    },
    setItem(key: string, value: string) {
      storage.set(key, String(value));
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    key(index: number) {
      return [...storage.keys()][index] ?? null;
    },
    get length() {
      return storage.size;
    },
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: localStorageMock },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });

  return {
    cookieJar,
    storage,
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as typeof globalThis & { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: previousWindow,
        });
      }

      if (previousDocument === undefined) {
        delete (globalThis as typeof globalThis & { document?: unknown }).document;
      } else {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: previousDocument,
        });
      }
    },
  };
}

test("auth token storage falls back to localStorage when cookie is unavailable", () => {
  const mocks = installAuthStorageMocks();
  try {
    persistAuthTokens("access-token", 3600, "refresh-token", 7200);
    mocks.cookieJar.clear();

    assert.equal(readAuthToken(), "access-token");
    assert.equal(mocks.storage.size > 0, true);
  } finally {
    mocks.restore();
  }
});

test("auth token storage expires localStorage fallback when max age is elapsed", () => {
  const mocks = installAuthStorageMocks();
  const originalNow = Date.now;

  try {
    persistAuthTokens("access-token", 1, null, null);
    mocks.cookieJar.clear();

    Date.now = () => originalNow() + 2_000;

    assert.equal(readAuthToken(), null);
  } finally {
    Date.now = originalNow;
    mocks.restore();
  }
});

test("auth token storage can be cleared from both cookie and localStorage", () => {
  const mocks = installAuthStorageMocks();
  try {
    persistAuthTokens("access-token", 3600, "refresh-token", 7200);
    clearAuthTokens();

    assert.equal(readAuthToken(), null);
    assert.equal(mocks.storage.size, 0);
    assert.equal(mocks.cookieJar.size, 0);
  } finally {
    mocks.restore();
  }
});

test("arbitrary suffix and canonical-prefix cookies cannot replace the current session", () => {
  const mocks = installAuthStorageMocks();
  try {
    mocks.cookieJar.set("anotherTenantAuthToken", "foreign-access");
    mocks.cookieJar.set("padlhubAuthTokenOther", "lookalike-access");
    mocks.cookieJar.set("anotherTenantRefreshToken", "foreign-refresh");
    mocks.cookieJar.set("padlhubRefreshTokenOther", "lookalike-refresh");
    assert.equal(readAuthToken(), null);
    assert.equal(readRefreshToken(), null);
    persistAuthTokens("current", 3600, "refresh", 3600);
    mocks.cookieJar.delete("padlhubAuthToken");
    mocks.cookieJar.delete("padlhubRefreshToken");
    mocks.cookieJar.set(`${AUTH_RUNTIME_TENANT_KEY}AuthToken`, "older-tenant-access");
    mocks.cookieJar.set(`${AUTH_RUNTIME_TENANT_KEY}RefreshToken`, "older-tenant-refresh");
    assert.equal(readAuthToken(), "current");
    assert.equal(readRefreshToken(), "refresh");
  } finally { mocks.restore(); }
});

test("exact current-tenant cookies remain a legacy fallback and only owned credentials are cleared", () => {
  const mocks = installAuthStorageMocks();
  try {
    mocks.cookieJar.set(`${AUTH_RUNTIME_TENANT_KEY}AuthToken`, "legacy");
    mocks.cookieJar.set(`${AUTH_RUNTIME_TENANT_KEY}RefreshToken`, "legacy-refresh");
    mocks.cookieJar.set("otherAuthToken", "foreign");
    mocks.storage.set("pending-consent-fixture", "keep");
    mocks.storage.set("padlhub:tournament-payment:fixture", "keep");
    assert.equal(readAuthToken(), "legacy");
    assert.equal(readRefreshToken(), "legacy-refresh");
    clearAuthSessionTokens();
    assert.equal(readAuthToken(), null);
    assert.equal(readRefreshToken(), null);
    assert.equal(mocks.cookieJar.get("otherAuthToken"), "foreign");
    assert.equal(mocks.storage.get("pending-consent-fixture"), "keep");
    assert.equal(mocks.storage.get("padlhub:tournament-payment:fixture"), "keep");
  } finally { mocks.restore(); }
});
