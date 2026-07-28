import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAuthTokens,
  persistAuthTokens,
  readAuthToken,
} from "../../src/utils/authTokenStorage.ts";

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
