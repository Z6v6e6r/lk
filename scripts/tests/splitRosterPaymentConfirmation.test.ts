import test from "node:test";
import assert from "node:assert/strict";
import {
  getPendingSplitRosterPaymentConfirmation,
  removePendingSplitRosterPaymentConfirmation,
  savePendingSplitRosterPaymentConfirmation,
} from "../../src/utils/splitRosterPaymentConfirmation.ts";

function installStorageMock() {
  const storage = new Map<string, string>();
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
  return {
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

test("split payment confirmation survives a payment redirect and can be consumed", () => {
  const mock = installStorageMock();
  try {
    const createdAt = new Date().toISOString();
    assert.equal(savePendingSplitRosterPaymentConfirmation({
      gameId: "pay_game",
      paymentRef: " payment-ref-1 ",
      reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      bookingId: "booking-1",
      clientId: "client-1",
      createdAt,
    }), true);

    assert.deepEqual(getPendingSplitRosterPaymentConfirmation("payment-ref-1"), {
      gameId: "pay_game",
      paymentRef: "payment-ref-1",
      reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      bookingId: "booking-1",
      clientId: "client-1",
      createdAt,
    });

    removePendingSplitRosterPaymentConfirmation("payment-ref-1");
    assert.equal(getPendingSplitRosterPaymentConfirmation("payment-ref-1"), null);
  } finally {
    mock.restore();
  }
});

test("split payment confirmation drops stale redirect state", () => {
  const mock = installStorageMock();
  try {
    savePendingSplitRosterPaymentConfirmation({
      gameId: "pay_game",
      paymentRef: "payment-ref-expired",
      reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-expired",
      bookingId: "booking-expired",
      clientId: "client-1",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    assert.equal(getPendingSplitRosterPaymentConfirmation("payment-ref-expired"), null);
  } finally {
    mock.restore();
  }
});

test("split payment confirmation fails closed when browser storage is blocked", () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
      },
    },
  });
  try {
    assert.equal(savePendingSplitRosterPaymentConfirmation({
      gameId: "pay_game",
      paymentRef: "payment-ref-blocked",
      reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
      operationType: "TRANSACTION",
      operationId: "transaction-blocked",
      bookingId: "booking-blocked",
      clientId: "client-1",
      createdAt: new Date().toISOString(),
    }), false);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as typeof globalThis & { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});
