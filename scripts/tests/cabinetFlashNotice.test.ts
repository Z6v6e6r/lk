import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeCabinetFlashNotice,
  pushCabinetFlashNotice,
} from "../../src/utils/cabinetFlashNotice.ts";

test("cabinet flash notice is stored once and consumed once", () => {
  const storage = new Map<string, string>();
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem(key: string) {
          return storage.has(key) ? storage.get(key)! : null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
        removeItem(key: string) {
          storage.delete(key);
        },
      },
    },
  });

  pushCabinetFlashNotice("  1 посещение вернули в абонемент.  ");
  assert.equal(consumeCabinetFlashNotice(), "1 посещение вернули в абонемент.");
  assert.equal(consumeCabinetFlashNotice(), null);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: previousWindow,
  });
});
