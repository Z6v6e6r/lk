import assert from "node:assert/strict";
import test from "node:test";

import {
  RESIDENCY_STATION_STORAGE_KEY,
  clearPersistedResidencyEntryContext,
  consumeResidencyEntryContext,
  normalizeResidencyStationId,
  persistResidencyEntryContext,
  readPersistedResidencyEntryContext,
  readResidencyEntryFromSearch,
} from "../../src/residency/residencyStationContext.ts";

function installWindowMock() {
  const store = new Map<string, string>();
  const previousWindow = (globalThis as { window?: unknown }).window;
  const sessionStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage, location: { search: "" } },
  });
  return {
    store,
    restore() {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    },
  };
}

test("station entry is read from the query string", () => {
  assert.deepEqual(readResidencyEntryFromSearch("?residency=1&stationId=station-1"), {
    requested: true,
    stationId: "station-1",
  });
  assert.equal(readResidencyEntryFromSearch("?resident=true").requested, true);
  assert.equal(readResidencyEntryFromSearch("?residentPass=1").requested, true);
  assert.equal(readResidencyEntryFromSearch("?residency=0").requested, false);
  assert.equal(readResidencyEntryFromSearch("?other=1").requested, false);
  assert.equal(readResidencyEntryFromSearch("").requested, false);
});

test("station ids are normalized and unsafe values are dropped", () => {
  assert.equal(normalizeResidencyStationId(" station-1 "), "station-1");
  assert.equal(normalizeResidencyStationId("station/../etc"), null);
  assert.equal(normalizeResidencyStationId("station id"), null);
  assert.equal(normalizeResidencyStationId("x".repeat(201)), null);
  assert.equal(normalizeResidencyStationId(42), null);
  assert.deepEqual(readResidencyEntryFromSearch("?residency=1&stationId=bad station"), {
    requested: true,
    stationId: null,
  });
});

test("station context survives the login view and is consumed once", () => {
  const mock = installWindowMock();
  try {
    // The resident opens the station link while signed out.
    persistResidencyEntryContext({ requested: true, stationId: "station-7" });
    // After login the cabinet mounts with the same (query-less) URL.
    const consumed = consumeResidencyEntryContext("");
    assert.deepEqual(consumed, { entry: { requested: true, stationId: "station-7" }, consumed: true });
    assert.deepEqual(readPersistedResidencyEntryContext(), { requested: true, stationId: "station-7" });
    clearPersistedResidencyEntryContext();
    assert.deepEqual(consumeResidencyEntryContext(""), { entry: { requested: false, stationId: null }, consumed: false });
  } finally {
    mock.restore();
  }
});

test("a station link persists its own context and a plain cabinet load never opens the screen", () => {
  const mock = installWindowMock();
  try {
    const fromUrl = consumeResidencyEntryContext("?residency=1&stationId=station-9");
    assert.deepEqual(fromUrl.entry, { requested: true, stationId: "station-9" });
    assert.equal(mock.store.get(RESIDENCY_STATION_STORAGE_KEY).includes("station-9"), true);
    clearPersistedResidencyEntryContext();
    const plain = consumeResidencyEntryContext("?paymentRef=abc");
    assert.deepEqual(plain, { entry: { requested: false, stationId: null }, consumed: false });
  } finally {
    mock.restore();
  }
});

test("corrupted or unavailable storage never throws", () => {
  const mock = installWindowMock();
  try {
    mock.store.set(RESIDENCY_STATION_STORAGE_KEY, "{not json");
    assert.deepEqual(consumeResidencyEntryContext("").entry, { requested: false, stationId: null });
    assert.deepEqual(readPersistedResidencyEntryContext(), { requested: false, stationId: null });
  } finally {
    mock.restore();
  }
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  try {
    assert.deepEqual(consumeResidencyEntryContext("?residency=1").entry, { requested: true, stationId: null });
    assert.doesNotThrow(() => persistResidencyEntryContext({ requested: true, stationId: null }));
    assert.doesNotThrow(() => clearPersistedResidencyEntryContext());
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
