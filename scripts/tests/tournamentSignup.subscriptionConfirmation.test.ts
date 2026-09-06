import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
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
  assert.match(functionSource, /normalizeConfirmedSubscriptionBookingPayment\(response.data\)/);
  assert.match(pageSource, /result\.status === 202 && subscriptionProductKey/);
  assert.match(pageSource, /className="tournament-signup-notice" role="status" aria-live="polite"/);
  assert.match(pageSource, /Подтверждаем запись…/);
});

test("subscription checkout keeps the server money leg unpaid and rejects ambiguous completion", () => {
  const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
  const start = source.indexOf("function normalizeConfirmedSubscriptionBookingPayment(");
  const end = source.indexOf("async function apiCreateTournamentVivaBookingFromSubscription", start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const normalize = new Function(`${compiled}; return normalizeConfirmedSubscriptionBookingPayment;`)();
  const legacy = { state: "CONFIRMED", bookingId: "fixture:booking" };
  assert.equal(normalize(legacy).paid, true);
  assert.equal(normalize({ ...legacy, toPayMinor: 0, toPay: 0, paid: true, paymentUrl: null }).paid, true);
  const mixed = { ...legacy, toPayMinor: 35_000, toPay: 350, paid: false,
    transactionId: "fixture:transaction", paymentUrl: "https://checkout.invalid/fixture-only" };
  assert.equal(normalize(mixed).paid, false);
  assert.equal(normalize(mixed).toPay, 35_000, "existing checkout consumes minor units");
  assert.equal(normalize(mixed).paymentUrl, mixed.paymentUrl);
  for (const delta of [{ paid: true }, { toPay: 700 }, { paymentUrl: null },
    { paymentUrl: "javascript:alert(1)" }, { transactionId: null },
    { state: "PENDING_CONFIRMATION" }, { toPayMinor: -1 }]) {
    assert.equal(normalize({ ...mixed, ...delta }), null);
  }
});

test("GT/T checkout displays only active owned money candidates without changing provider visit availability", () => {
  const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
  const start = source.indexOf("function collectLk1MoneyDiscountCandidates(");
  const end = source.indexOf("export async function apiFetchTournamentVivaPublicCheckout", start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const collect = new Function(`${compiled}; return collectLk1MoneyDiscountCandidates;`)();
  const startsAt = new Date(Date.now() + 36 * 60 * 60_000).toISOString();
  const exercise = { timeFrom: startsAt, timeTo: new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(), availableClientSubscriptions: [] };
  const subscription = { subscriptionId: "fixture:owned-instance", productId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
    clientId: "fixture:actor", status: "ACTIVE", purchaseDate: "2026-09-01", activationDate: "2026-09-01",
    expirationDate: "2027-09-01", visitsLeft: 0 };
  const candidates = collect({ content: [subscription], last: true, totalElements: 1 }, "fixture:actor", exercise);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].lk1MoneyDiscountCandidate, true);
  assert.equal(candidates[0].visitsTotal, null);
  assert.match(candidates[0].priceLabel, /без списания посещения/);
  assert.deepEqual(exercise.availableClientSubscriptions, []);
  for (const delta of [{ status: "NEW" }, { clientId: "fixture:other" }, { productId: "fixture:other" },
    { purchaseDate: "2026-08-31" }, { purchaseAt: "2026-08-31" }, { expirationDate: "2026-08-31" },
    { activationDate: null }, { expirationDate: "2026-99-99" }, { isFrozen: true },
    { expirationDate: new Date(Date.parse(startsAt) - 60_000).toISOString() },
    { activationDate: new Date(Date.now() + 60_000).toISOString() },
    { clientId: ["fixture:actor"] }, { subscriptionId: ["fixture:owned-instance"] },
    { holdUntil: "2027-01-01" }, { id: "fixture:different-instance" }]) {
    assert.deepEqual(collect([{ ...subscription, ...delta }], "fixture:actor", exercise), []);
  }
  assert.deepEqual(collect({ content: [subscription], last: false }, "fixture:actor", exercise), []);
  assert.deepEqual(collect([subscription, subscription], "fixture:actor", exercise), []);
  const fetchBody = source.slice(source.indexOf("export async function apiFetchTournamentVivaCheckout"), start);
  assert.match(fetchBody, /apiFetchSubscriptions\(\{ includeFinished: true, size: 1000 \}\)/);
  const bookingBody = source.slice(source.indexOf("async function apiCreateTournamentVivaBookingFromSubscription"));
  assert.match(bookingBody, /params.product.lk1MoneyDiscountCandidate !== true/,
    "a money candidate must not be blocked by the legacy visit-only daily precheck");
});

test("GT/T checkout preserves exact activation and expiry gates for Viva microseconds", () => {
  const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
  const start = source.indexOf("function collectLk1MoneyDiscountCandidates(");
  const end = source.indexOf("export async function apiFetchTournamentVivaPublicCheckout", start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const now = Date.parse("2026-09-07T09:00:00.123Z");
  const FixedDate = class extends Date { static now() { return now; } };
  const collect = new Function("Date", `${compiled}; return collectLk1MoneyDiscountCandidates;`)(FixedDate);
  const exercise = { timeFrom: "2026-09-08T09:00:00.000Z", timeTo: "2026-09-08T10:00:00.000Z" };
  const subscription = { subscriptionId: "fixture:owned", product: { id: "db7a5250-7369-4f43-8ac5-9111be24bc74" },
    status: "ACTIVE", purchaseDate: "2026-09-05T06:40:26.082370", activationDate: "2026-09-01", expirationDate: "2027-09-01" };
  const candidates = (delta: Record<string, unknown>, target = exercise) => collect([{ ...subscription, ...delta }], "fixture:actor", target);
  for (const precision of ["1", "12", "123", "1230", "12300", "123000"]) {
    for (const [time, zone] of [["09:00:00", "Z"], ["12:00:00", "+03:00"],
      ["12:00:00", "+0300"], ["12:00:00", ""], ["05:00:00", "-04:00"]]) {
      assert.equal(candidates({ activationDate: `2026-09-07T${time}.${precision}${zone}` }).length, 1);
    }
  }
  for (const fraction of ["1234", "12345", "123001", "123456", "999999"]) {
    assert.equal(candidates({ activationDate: `2026-09-07T09:00:00.${fraction}Z` }).length, 0,
      "sub-millisecond future activation must not round back into eligibility");
    assert.equal(candidates({ activationDate: `2026-09-06T09:00:00.${fraction}Z` }).length, 1);
  }
  for (const fraction of ["999", "9990", "99900", "999000", "999001"]) {
    assert.equal(candidates({ expirationDate: `2026-09-08T09:59:59.${fraction}Z` }).length, 1);
  }
  for (const fraction of ["9989", "99899", "998999"]) {
    assert.equal(candidates({ expirationDate: `2026-09-08T09:59:59.${fraction}Z` }).length, 0,
      "expiry before the existing inclusive millisecond boundary must not round forward");
  }
  assert.equal(candidates({ activationDate: "2026-09-07T09:00:00.122999Z" },
    { ...exercise, timeFrom: "2026-09-07T09:00:00.122001Z" }).length, 0,
  "fractional target start must not be rounded forward to admit a later activation");
  assert.equal(candidates({ expirationDate: "2026-09-08T09:59:59.999000Z" },
    { ...exercise, timeTo: "2026-09-08T10:00:00.000001Z" }).length, 0,
  "fractional target end must not be rounded back to admit an earlier expiry");
  for (const invalid of ["2026-09-07T09:00:00.1234567Z", "2026-09-07T09:00:00.1230000Z",
    "2026-02-30T09:00:00.123456Z", "2026-09-07T24:00:00.123456Z",
    "2026-09-07T09:00:00.123456+24:00", "2026-09-07T09:00:00.123456+03:60"]) {
    assert.equal(candidates({ activationDate: invalid }).length, 0);
    assert.equal(candidates({ expirationDate: invalid }).length, 0);
  }
  assert.equal(candidates({ status: "NEW", activationDate: null, expirationDate: null }).length, 0);
});
