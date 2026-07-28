import assert from "node:assert/strict";
import test from "node:test";
import {
  clearVivaAuthTokens,
  persistVivaAuthTokens,
  readVivaAccessToken,
  readVivaRefreshToken,
  shouldRestoreVivaSession,
} from "../../src/utils/vivaAuthStorage.ts";

function installStorageMocks() {
  const cookieJar = new Map<string, string>();
  const storage = new Map<string, string>();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;

  const documentMock = {};
  Object.defineProperty(documentMock, "cookie", {
    configurable: true,
    get() {
      return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    set(value: string) {
      const [pair, ...attributes] = String(value).split(";").map((part) => part.trim());
      const [name, ...rest] = pair.split("=");
      const cookieValue = rest.join("=");
      const isDeletion = attributes.some((attribute) => /^expires=/i.test(attribute) && /Thu, 01 Jan 1970/i.test(attribute));
      const isExpired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
      if (isDeletion || isExpired) {
        cookieJar.delete(name);
        return;
      }
      cookieJar.set(name, cookieValue);
    },
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string) {
          return storage.has(key) ? storage.get(key) ?? null : null;
        },
        setItem(key: string, value: string) {
          storage.set(key, String(value));
        },
        removeItem(key: string) {
          storage.delete(key);
        },
      },
    },
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

test("viva auth storage writes both generic and tenant cookies", () => {
  const mocks = installStorageMocks();
  try {
    persistVivaAuthTokens("access-token", 300, "refresh-token", 1800);

    assert.equal(readVivaAccessToken(), "access-token");
    assert.equal(readVivaRefreshToken(), "refresh-token");
    assert.equal(mocks.cookieJar.has("padlhubAuthToken"), true);
    assert.equal(mocks.cookieJar.has("iSkq6GAuthToken"), true);
    assert.equal(mocks.cookieJar.has("padlhubRefreshToken"), true);
    assert.equal(mocks.cookieJar.has("iSkq6GRefreshToken"), true);
  } finally {
    mocks.restore();
  }
});

test("viva auth storage clears generic and tenant cookies together", () => {
  const mocks = installStorageMocks();
  try {
    persistVivaAuthTokens("access-token", 300, "refresh-token", 1800);
    clearVivaAuthTokens();

    assert.equal(readVivaAccessToken(), null);
    assert.equal(readVivaRefreshToken(), null);
    assert.equal(mocks.cookieJar.size, 0);
    assert.equal(mocks.storage.size, 0);
  } finally {
    mocks.restore();
  }
});

test("viva auth storage treats refresh-only state as restorable", () => {
  const mocks = installStorageMocks();
  try {
    persistVivaAuthTokens(null, null, "refresh-token", 1800);

    assert.equal(readVivaAccessToken(), null);
    assert.equal(readVivaRefreshToken(), "refresh-token");
    assert.equal(shouldRestoreVivaSession(), true);
    assert.equal(shouldRestoreVivaSession("access-token", "refresh-token"), false);
  } finally {
    mocks.restore();
  }
});
