import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  isSubscriptionBookingPending,
  pollSubscriptionBookingConfirmation,
} from "../../src/utils/subscriptionBookingConfirmation.ts";

type GatewayResult = {
  data: unknown | null;
  error: { status: number; message: string } | null;
  status: number | null;
};

test("subscription confirmation retries the same pending operation until Viva returns a booking", async () => {
  const responses: GatewayResult[] = [
    { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 },
    { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 },
    { data: { state: "CONFIRMED", bookingId: "booking-1" }, error: null, status: 201 },
  ];
  const waits: number[] = [];
  let attempts = 0;

  const result = await pollSubscriptionBookingConfirmation(
    async () => responses[attempts++] ?? responses.at(-1)!,
    {
      delaysMs: [10, 20, 30],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(result.data, { state: "CONFIRMED", bookingId: "booking-1" });
});

test("subscription confirmation is bounded when Viva remains eventually consistent", async () => {
  let attempts = 0;
  const pending: GatewayResult = {
    data: { state: "PENDING_CONFIRMATION" },
    error: null,
    status: 202,
  };

  const result = await pollSubscriptionBookingConfirmation(
    async () => {
      attempts += 1;
      return pending;
    },
    { delaysMs: [0, 0], wait: async () => {} },
  );

  assert.equal(attempts, 3);
  assert.equal(isSubscriptionBookingPending(result), true);
});

test("subscription confirmation does not retry definitive failures or unrelated responses", async () => {
  const cases: GatewayResult[] = [
    { data: null, error: { status: 409, message: "Daily limit reached" }, status: 409 },
    { data: { state: "FAILED" }, error: null, status: 200 },
    { data: { state: "CONFIRMED", bookingId: "booking-2" }, error: null, status: 201 },
  ];

  for (const response of cases) {
    let attempts = 0;
    const result = await pollSubscriptionBookingConfirmation(
      async () => {
        attempts += 1;
        return response;
      },
      { delaysMs: [0, 0], wait: async () => {} },
    );
    assert.equal(attempts, 1);
    assert.equal(result, response);
  }
});

test("tournament signup wires polling to one deterministic operation and renders pending as a notice", () => {
  const apiSource = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
  const pageSource = fs.readFileSync(
    "src/components/tournament-signup/TournamentSignupPage.tsx",
    "utf8",
  );
  const functionStart = apiSource.indexOf("async function apiCreateTournamentVivaBookingFromSubscription");
  const functionEnd = apiSource.indexOf("function buildTournamentVivaTransactionPayload", functionStart);
  const functionSource = apiSource.slice(functionStart, functionEnd);

  assert.match(functionSource, /const bookingRequest = \(\) => request<unknown>/);
  assert.match(functionSource, /operationId=\$\{encodeURIComponent\(idempotencyKey\)\}/);
  assert.match(functionSource, /pollSubscriptionBookingConfirmation\(bookingRequest\)/);
  assert.match(pageSource, /result\.status === 202 && subscriptionProductKey/);
  assert.match(pageSource, /className="tournament-signup-notice" role="status" aria-live="polite"/);
  assert.match(pageSource, /Подтверждаем запись…/);
});
