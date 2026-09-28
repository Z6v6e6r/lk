import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canPayTournamentPending } from "../../src/utils/tournamentPendingPayment.ts";

const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");

function extractFunctionBlock(marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);

  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body for: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`Cannot extract function body for: ${marker}`);
}

function toRunnableFunctionExpression(marker: string) {
  const block = extractFunctionBlock(marker);
  const bodyStart = block.indexOf("{");
  assert.ok(bodyStart >= 0, `Cannot find runtime body for: ${marker}`);

  const rawSignature = block.slice(0, bodyStart);
  const signatureEnd = rawSignature.lastIndexOf(")");
  assert.ok(signatureEnd >= 0, `Cannot find signature end for: ${marker}`);

  const signature = `${rawSignature
    .slice(0, signatureEnd + 1)
    .replace(/:\s*[^,)={]+/g, "")}${rawSignature
      .slice(signatureEnd + 1)
      .replace(/\s*:\s*[\s\S]*$/, "")}`;
  const body = block
    .slice(bodyStart)
    .replace(/\s+as\s+unknown/g, "")
    .replace(/request<unknown>\(/g, "request(")
    .replace(/: TournamentVivaPaymentResolution \| null/g, "")
    .replace(/: Array<Promise<TournamentVivaPaymentResolution \| null>>/g, "");

  return `(${signature}${body})`;
}

const awaitPreferredTournamentPaymentResolution = new Function(
  "isResolvedTournamentVivaPayment",
  `return ${toRunnableFunctionExpression("async function awaitPreferredTournamentPaymentResolution")};`,
)(
  (value: { paymentUrl?: string | null; paid?: boolean | null } | null | undefined) =>
    Boolean(value?.paymentUrl || value?.paid === true),
) as <T extends { paymentUrl?: string | null; paid?: boolean | null }>(
  promises: Array<Promise<T | null>>,
) => Promise<T | null>;

test("socket user id prefers auth token subject over viva profile id", () => {
  const decodeBase64UrlSegment = new Function(
    `return ${toRunnableFunctionExpression("function decodeBase64UrlSegment")};`,
  )() as (value: string | null | undefined) => string | null;

  const extractAuthTokenJwtPayload = new Function(
    "decodeBase64UrlSegment",
    "isRecord",
    `return ${toRunnableFunctionExpression("function extractAuthTokenJwtPayload")};`,
  )(
    decodeBase64UrlSegment,
    (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
  ) as (token: string | null | undefined) => Record<string, unknown> | null;

  const resolveVivaSocketUserId = new Function(
    "readAuthToken",
    "extractAuthTokenJwtPayload",
    "pickString",
    `return ${toRunnableFunctionExpression("function resolveVivaSocketUserId")};`,
  )(
    () => "eyJhbGciOiJub25lIn0.eyJzdWIiOiI4Mzc1NjUyNy1jZmJlLTRiN2YtYjE0My0xYTZhYzk2ZDJhOTMiLCJ0eXAiOiJCZWFyZXIifQ.sig",
    extractAuthTokenJwtPayload,
    (payload: Record<string, unknown> | null, keys: string[]) => {
      if (!payload) return null;
      for (const key of keys) {
        const value = payload[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return null;
    },
  ) as (clientId: string | null | undefined) => string | null;

  assert.equal(
    resolveVivaSocketUserId("191ff3d9-52d3-4182-8ad9-46ff7e4e4339"),
    "83756527-cfbe-4b7f-b143-1a6ac96d2a93",
  );
});

test("socket user id falls back to viva profile id when auth token is unavailable", () => {
  const resolveVivaSocketUserId = new Function(
    "readAuthToken",
    "extractAuthTokenJwtPayload",
    "pickString",
    `return ${toRunnableFunctionExpression("function resolveVivaSocketUserId")};`,
  )(
    () => null,
    () => null,
    () => null,
  ) as (clientId: string | null | undefined) => string | null;

  assert.equal(
    resolveVivaSocketUserId("191ff3d9-52d3-4182-8ad9-46ff7e4e4339"),
    "191ff3d9-52d3-4182-8ad9-46ff7e4e4339",
  );
});

test("transaction payload includes redirect aliases used by working Viva flows", () => {
  const buildPayload = new Function(
    "buildTournamentVivaTransactionProductPayload",
    `return ${toRunnableFunctionExpression("function buildTournamentVivaTransactionPayload")};`,
  )(
    (product: { id: string; type: string; name: string }, exerciseId: string) => ({
      id: product.id,
      type: product.type,
      name: product.name,
      count: 1,
      bookingRequests: [{ exerciseId }],
    }),
  ) as (
    params: {
      exerciseId: string;
      studioId: string | null;
      clientPhone: string;
      product: { id: string; type: string; name: string };
      promoCode?: string | null;
    },
    successUrl: string | null,
    failUrl: string | null,
  ) => Record<string, unknown>;

  const payload = buildPayload(
    {
      exerciseId: "exercise-1",
      studioId: "studio-1",
      clientPhone: "79603075826",
      product: {
        id: "product-1",
        type: "SERVICE",
        name: "Tournament ticket",
      },
      promoCode: "PIK-PADELHUB",
    },
    "https://padlhub.ru/tournaments?success=1",
    "https://padlhub.ru/tournaments?failed=1",
  );

  assert.equal(payload.successUrl, "https://padlhub.ru/tournaments?success=1");
  assert.equal(payload.baseRedirectUrl, "https://padlhub.ru/tournaments?success=1");
  assert.equal(payload.redirectUrl, "https://padlhub.ru/tournaments?success=1");
  assert.equal(payload.returnUrl, "https://padlhub.ru/tournaments?success=1");
  assert.equal(payload.successRedirectUrl, "https://padlhub.ru/tournaments?success=1");
  assert.equal(payload.failUrl, "https://padlhub.ru/tournaments?failed=1");
  assert.equal(payload.failRedirectUrl, "https://padlhub.ru/tournaments?failed=1");
  assert.equal(payload.failureRedirectUrl, "https://padlhub.ru/tournaments?failed=1");
  assert.equal(payload.promoCode, "PIK-PADELHUB");
});

test("transaction status is read from the v2 /status route used by the official widget", async () => {
  const seenRequests: Array<{ url: string; options: { method?: string; auth?: boolean } }> = [];
  const fetchStatus = new Function(
    "TENANT_KEY",
    "request",
    "normalizeTournamentVivaTransactionResolution",
    `return ${toRunnableFunctionExpression("async function fetchTournamentVivaTransactionResolution")};`,
  )(
    "iSkq6G",
    async (url: string, options: { method?: string; auth?: boolean }) => {
      seenRequests.push({ url, options });
      return {
        data: { transactionStatus: "PAID", toPay: 0 },
        error: null,
        status: 200,
      };
    },
    (payload: Record<string, unknown>, fallbackPaymentExpiresAt: string | null) => ({
      paymentUrl: typeof payload.paymentUrl === "string" ? payload.paymentUrl : null,
      bookingId: typeof payload.bookingId === "string" ? payload.bookingId : null,
      toPay: typeof payload.toPay === "number" ? payload.toPay : null,
      paid: payload.transactionStatus === "PAID",
      paymentExpiresAt: fallbackPaymentExpiresAt,
      raw: payload,
    }),
  ) as (
    transactionId: string,
    fallbackPaymentExpiresAt: string | null,
  ) => Promise<{
    paymentUrl: string | null;
    bookingId: string | null;
    toPay: number | null;
    paid: boolean | null;
    paymentExpiresAt: string | null;
    raw: unknown;
  } | null>;

  const resolution = await fetchStatus("tx-1", "2026-06-03T10:00:00.000Z");

  // The flat `/transactions/{id}` route queried before is not part of the partner
  // end-user API (it answered 404 for every id); the official widget uses `/status`.
  assert.deepEqual(seenRequests, [
    { url: "/end-user/api/v2/iSkq6G/transactions/tx-1/status", options: { method: "GET", auth: true, retries: 1 } },
  ]);
  assert.equal(resolution?.paid, true);
  assert.equal(resolution?.paymentExpiresAt, "2026-06-03T10:00:00.000Z");
});

function buildReadVivaOperationResolution() {
  const isRecord = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  const pickString = (value: Record<string, unknown> | null, keys: string[]) => {
    if (!value) return null;
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
  };

  const isLikelyPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function isLikelyPaymentUrl")};`,
  )() as (value: string) => boolean;
  const extractPaymentUrlFromString = new Function(
    "isLikelyPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrlFromString")};`,
  )(isLikelyPaymentUrl) as (value: string) => string | null;
  const readTrustedPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function readTrustedPaymentUrl")};`,
  )() as (value: unknown) => string | null;
  const extractPaymentUrl = new Function(
    "isRecord",
    "extractPaymentUrlFromString",
    "readTrustedPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrl(payload")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, extractPaymentUrlFromString, readTrustedPaymentUrl) as (payload: unknown) => string | null;

  const pickFirstStringArray = new Function(
    // The local harness strips types with a comma-unaware regex, so `Record<string, unknown>`
    // leaves a `, unknown>` fragment in the signature; drop it before evaluating.
    `return ${toRunnableFunctionExpression("function pickFirstStringArray").replace(/, unknown>/g, "")};`,
  )() as (value: Record<string, unknown>, keys: string[]) => string | null;

  const extractBookingId = new Function(
    "isRecord",
    "pickString",
    "pickFirstStringArray",
    `return ${toRunnableFunctionExpression("function extractBookingId")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, pickString, pickFirstStringArray) as (payload: unknown) => string | null;

  const readVivaPaymentDueDate = new Function(
    "isRecord",
    "pickString",
    `return ${toRunnableFunctionExpression("function readVivaPaymentDueDate")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, pickString) as (value: unknown) => string | null;

  const isVivaFailedOperation = new Function(
    "isRecord",
    "pickString",
    `return ${toRunnableFunctionExpression("function isVivaFailedOperation")};`,
  )(isRecord, pickString) as (payload: unknown) => boolean;

  const readVivaOperationResolution = new Function(
    "isRecord",
    "pickString",
    "extractPaymentUrl",
    "extractBookingId",
    "readVivaPaymentDueDate",
    "isVivaFailedOperation",
    `return ${toRunnableFunctionExpression("function readVivaOperationResolution")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")
      .replace(/: TournamentVivaPaymentResolution \| null/g, "")};`,
  )(
    isRecord,
    pickString,
    extractPaymentUrl,
    extractBookingId,
    readVivaPaymentDueDate,
    isVivaFailedOperation,
  ) as (
    payload: unknown,
    fallbackPaymentExpiresAt: string | null,
  ) => {
    paymentUrl: string | null;
    bookingId: string | null;
    paid: boolean | null;
    paymentExpiresAt: string | null;
    raw: unknown;
  } | null;

  return { isRecord, readVivaOperationResolution };
}

// Live 2026-09-28 case: the transaction bb95f4f5… was created in Viva with
// cardPaymentInfo.paymentUrl, the websocket event never reached the client and the client
// had no operation readback, so the payer saw "Не удалось получить ссылку на оплату".
const liveOperationStatusPayload = {
  correlationId: "bb95f4f5-8aed-4433-8971-8a34df0b54af",
  status: "ACCEPTED",
  progress: { current: 1, total: 1 },
  result: {
    bookingId: "a7d40555-6e7c-4e0b-a17f-3c4988e46e34",
    paymentUrl: "https://pay.vivacrm.ru/Fw6cae9WH6bYr9bUAtESZQ",
    paymentDueDate: "2026-09-28T13:39:22.513+03:00",
  },
  error: null,
};

test("the Viva operation status carries the checkout link the socket event may miss", async () => {
  const { isRecord, readVivaOperationResolution } = buildReadVivaOperationResolution();
  const readVivaFailureCode = new Function(
    "isRecord",
    `return ${toRunnableFunctionExpression("function readVivaFailureCode")};`,
  )(isRecord) as (payload: unknown) => string | null;

  const seenRequests: Array<{ url: string; options: unknown }> = [];
  const fetchOperation = new Function(
    "TENANT_KEY",
    "request",
    "readVivaOperationResolution",
    `return ${toRunnableFunctionExpression("async function fetchTournamentVivaOperationResolution")};`,
  )(
    "iSkq6G",
    async (url: string, options: unknown) => {
      seenRequests.push({ url, options });
      return { data: liveOperationStatusPayload, error: null, status: 200 };
    },
    readVivaOperationResolution,
  ) as (
    transactionId: string,
    fallbackPaymentExpiresAt: string | null,
  ) => Promise<{
    paymentUrl: string | null;
    bookingId: string | null;
    paid: boolean | null;
    paymentExpiresAt: string | null;
    raw: unknown;
  } | null>;

  const resolution = await fetchOperation("bb95f4f5-8aed-4433-8971-8a34df0b54af", null);

  assert.deepEqual(seenRequests, [
    {
      url: "/end-user/api/v2/iSkq6G/operations/bb95f4f5-8aed-4433-8971-8a34df0b54af",
      options: { method: "GET", auth: true, retries: 1 },
    },
  ]);
  assert.equal(resolution?.paymentUrl, "https://pay.vivacrm.ru/Fw6cae9WH6bYr9bUAtESZQ");
  assert.equal(resolution?.bookingId, "a7d40555-6e7c-4e0b-a17f-3c4988e46e34");
  assert.equal(resolution?.paymentExpiresAt, "2026-09-28T13:39:22.513+03:00");
  assert.equal(resolution?.paid, false);

  // A failed operation has no link, but it must still reach the screen with Viva's code.
  const failed = readVivaOperationResolution(
    { status: "FAILED", error: { code: "NO_AVAILABLE_SPOTS", message: "no available spots" } },
    null,
  );
  assert.equal(failed?.paymentUrl, null);
  assert.equal(readVivaFailureCode(failed?.raw), "NO_AVAILABLE_SPOTS");

  // Nothing to resolve while the operation is in flight, and unusable values stay out.
  assert.equal(readVivaOperationResolution({ status: "IN_PROGRESS", result: {} }, null), null);
  assert.equal(
    readVivaOperationResolution({ status: "ACCEPTED", result: { paymentUrl: "not-a-url" } }, null),
    null,
  );
  // The due date falls back to the client-side window when Viva omits it.
  assert.equal(
    readVivaOperationResolution(
      { status: "ACCEPTED", result: { paymentUrl: "https://pay.vivacrm.ru/link-2" } },
      "2026-09-28T13:20:00.000Z",
    )?.paymentExpiresAt,
    "2026-09-28T13:20:00.000Z",
  );
});

test("the payment flow polls the Viva operation status and the corrected status route", () => {
  assert.match(
    source,
    /\/end-user\/api\/v2\/\$\{TENANT_KEY\}\/operations\/\$\{encodeURIComponent\(normalizedTransactionId\)\}/,
  );
  assert.match(
    source,
    /"\/end-user\/api\/v2\/" \+ TENANT_KEY \+ "\/transactions\/" \+ encodedTransactionId \+ "\/status"/,
  );
  assert.match(source, /pollTournamentVivaOperationResolution\(transactionId, transactionStartedAtMs\)/);
  assert.match(source, /pollTournamentVivaTransactionResolution\(transactionId, transactionStartedAtMs\)/);
  // The dead flat route must not come back: it answered 404 for every transaction id.
  assert.doesNotMatch(
    source,
    /"\/end-user\/api\/v2\/" \+ TENANT_KEY \+ "\/transactions\/" \+ encodedTransactionId,/,
  );
});

test("preferred payment resolution ignores early null and returns later payment url", async () => {
  const resolution = await awaitPreferredTournamentPaymentResolution([
    Promise.resolve(null),
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          paymentUrl: "https://pay.example/checkout/tx-2",
          bookingId: "booking-2",
          toPay: 1900,
          paid: false,
          paymentExpiresAt: "2026-06-03T10:20:00.000Z",
          raw: { source: "transaction_lookup" },
        });
      }, 5);
    }),
  ]);

  assert.equal(resolution?.paymentUrl, "https://pay.example/checkout/tx-2");
  assert.equal(resolution?.bookingId, "booking-2");
});

test("preferred payment resolution returns fallback booking state when payment url never appears", async () => {
  const fallback = {
    paymentUrl: null,
    bookingId: "booking-3",
    toPay: 1900,
    paid: false,
    paymentExpiresAt: "2026-06-03T10:20:00.000Z",
    raw: { source: "booking_poll" },
  };

  const resolution = await awaitPreferredTournamentPaymentResolution([
    Promise.resolve(null),
    Promise.resolve(fallback),
  ]);

  assert.deepEqual(resolution, fallback);
});

test("explicit Viva payment fields are trusted while our own redirects stay filtered", () => {
  const isRecord = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);

  const isLikelyPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function isLikelyPaymentUrl")};`,
  )() as (value: string) => boolean;

  const extractPaymentUrlFromString = new Function(
    "isLikelyPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrlFromString")};`,
  )(isLikelyPaymentUrl) as (value: string) => string | null;

  const readTrustedPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function readTrustedPaymentUrl")};`,
  )() as (value: unknown) => string | null;

  const extractPaymentUrl = new Function(
    "isRecord",
    "extractPaymentUrlFromString",
    "readTrustedPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrl(payload")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, extractPaymentUrlFromString, readTrustedPaymentUrl) as (payload: unknown) => string | null;

  // A URL Viva put into its own payment field is the checkout link even when the host does
  // not look like an acquirer page and the token lives in the fragment.
  assert.equal(
    extractPaymentUrl({ cardPaymentInfo: { paymentUrl: "https://widget.example.com/#/pay/tx-1" } }),
    "https://widget.example.com/#/pay/tx-1",
  );
  assert.equal(
    extractPaymentUrl({ paymentUrl: "https://gateway.example.net/order/42" }),
    "https://gateway.example.net/order/42",
  );
  // Our own success redirect must never be mistaken for a payment link.
  assert.equal(extractPaymentUrl({ redirectUrl: "https://padlhub.ru/tournaments?paymentsuccess=true" }), null);
  assert.equal(extractPaymentUrl({ url: "https://padlhub.ru/lk_new" }), null);
  // Free-text scanning still recognizes acquirer hosts, and the fragment now counts too.
  assert.equal(extractPaymentUrl("checkout: https://pay.tbank.ru/abc"), "https://pay.tbank.ru/abc");
  assert.equal(isLikelyPaymentUrl("https://widget.example.com/#/payment/1"), true);
  assert.equal(isLikelyPaymentUrl("https://padlhub.ru/lk_new"), false);
});

test("Viva failure codes are read from flat and nested error payloads", () => {
  const readVivaFailureCode = new Function(
    "isRecord",
    `return ${toRunnableFunctionExpression("function readVivaFailureCode")};`,
  )((value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)) as (
    payload: unknown,
  ) => string | null;

  assert.equal(readVivaFailureCode({ code: "NO_SPOTS" }), "NO_SPOTS");
  assert.equal(readVivaFailureCode({ error: { code: "CLIENT_NOT_ALLOWED" } }), "CLIENT_NOT_ALLOWED");
  assert.equal(readVivaFailureCode({ error: { message: "no code" } }), null);
  assert.equal(readVivaFailureCode(null), null);
});

test("payment waits are bounded and link failures name the transaction and the Viva code", () => {
  assert.match(source, /const TOURNAMENT_PAYMENT_RESOLUTION_BUDGET_MS = 25_000;/);
  assert.match(source, /withTournamentPaymentBudget\(paymentResolutionPromises\)/);
  assert.match(source, /setTimeout\(\(\) => ticketController\.abort\(\), 3_000\)/);
  assert.match(source, /signal: ticketController\.signal/);
  assert.match(source, /транзакция \$\{transactionId\}/);
  assert.match(source, /код Viva \$\{vivaFailureCode\}/);
});

// Captured from the live 2026-09-19 attempt on tournament 6aacf5ed…: the 202 create
// response carried only the transaction id, the transaction readback 404s and the exercise
// bookings expose no owning client, so this event is the only source of the booking id.
const liveTransactionCreatedPayload = {
  status: "COMPLETED", correlationId: "6bf48740-ae16-4319-98c4-8b3debe489a8", action: "TRANSACTION_CREATED",
  exerciseId: null, entityId: "6bf48740-ae16-4319-98c4-8b3debe489a8", error: null, progress: null,
  data: {
    bookingIds: ["c8421449-10bd-411b-87fc-e322db49f9f4"],
    paymentUrl: "https://pay.vivacrm.ru/Fw6cae9WH6bYr9bUAtESZQ",
    paymentDueDate: "2026-09-19T23:03:14.274625208+03:00",
  },
  terminal: false,
};

test("the live TRANSACTION_CREATED event yields booking id and due date, not just the url", () => {
  const isRecord = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  const pickString = (value: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
  };

  const pickFirstStringArray = new Function(
    // The local harness strips types with a comma-unaware regex, so `Record<string, unknown>`
    // leaves a `, unknown>` fragment in the signature; drop it before evaluating.
    `return ${toRunnableFunctionExpression("function pickFirstStringArray").replace(/, unknown>/g, "")};`,
  )() as (value: Record<string, unknown>, keys: string[]) => string | null;

  const extractBookingId = new Function(
    "isRecord",
    "pickString",
    "pickFirstStringArray",
    `return ${toRunnableFunctionExpression("function extractBookingId")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, pickString, pickFirstStringArray) as (payload: unknown) => string | null;

  const isLikelyPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function isLikelyPaymentUrl")};`,
  )() as (value: string) => boolean;
  const extractPaymentUrlFromString = new Function(
    "isLikelyPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrlFromString")};`,
  )(isLikelyPaymentUrl) as (value: string) => string | null;
  const readTrustedPaymentUrl = new Function(
    `return ${toRunnableFunctionExpression("function readTrustedPaymentUrl")};`,
  )() as (value: unknown) => string | null;
  const extractPaymentUrl = new Function(
    "isRecord",
    "extractPaymentUrlFromString",
    "readTrustedPaymentUrl",
    `return ${toRunnableFunctionExpression("function extractPaymentUrl(payload")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, extractPaymentUrlFromString, readTrustedPaymentUrl) as (payload: unknown) => string | null;

  const readVivaPaymentDueDate = new Function(
    "isRecord",
    "pickString",
    `return ${toRunnableFunctionExpression("function readVivaPaymentDueDate")
      .replace(/: unknown/g, "")
      .replace(/: string \| null/g, "")};`,
  )(isRecord, pickString) as (value: unknown) => string | null;

  const readVivaPaymentEvent = new Function(
    "extractPaymentUrl",
    "extractBookingId",
    "readVivaPaymentDueDate",
    `return ${toRunnableFunctionExpression("function readVivaPaymentEvent")
      .replace(/: unknown/g, "")
      .replace(/: TournamentVivaPaymentEvent \| null/g, "")};`,
  )(extractPaymentUrl, extractBookingId, readVivaPaymentDueDate) as (
    value: unknown,
  ) => { paymentUrl: string; bookingId: string | null; paymentExpiresAt: string | null } | null;

  // The 202 create body has no booking id, the event does.
  assert.equal(extractBookingId({ id: "6bf48740-ae16-4319-98c4-8b3debe489a8", exerciseIds: ["a1fed11d-3ae1-4866-9809-aa82ac9fee2f"] }), null);
  assert.equal(extractBookingId(liveTransactionCreatedPayload), "c8421449-10bd-411b-87fc-e322db49f9f4");
  assert.equal(extractBookingId({ spot: 6, id: "booking-1", paymentType: "RESERVED" }), "booking-1");
  assert.equal(extractBookingId({ bookingIds: [null, "  ", "booking-2"] }), "booking-2");

  const event = readVivaPaymentEvent(liveTransactionCreatedPayload);
  assert.deepEqual(event, {
    paymentUrl: "https://pay.vivacrm.ru/Fw6cae9WH6bYr9bUAtESZQ",
    bookingId: "c8421449-10bd-411b-87fc-e322db49f9f4",
    paymentExpiresAt: "2026-09-19T23:03:14.274625208+03:00",
  });
  // Without a payment url there is nothing to open, even with a booking id present.
  assert.equal(readVivaPaymentEvent({ data: { bookingIds: ["booking-2"] } }), null);
  // An unusable due date must not reach the pending-payment guard, which parses it.
  assert.equal(readVivaPaymentDueDate({ data: { paymentDueDate: "not-a-date" } }), null);

  // The state the widget builds from this event has to stay payable: the previous code
  // dropped the booking id, `canPayTournamentPending` failed and the link was never opened.
  // The captured event is real, so freeze "now" inside its payment window: the default
  // wall clock made this assertion fail from 2026-09-20 on.
  const capturedAtMs = Date.parse("2026-09-19T23:00:00+03:00");
  assert.equal(canPayTournamentPending({
    status: "PAYMENT_PENDING",
    bookingId: event?.bookingId ?? null,
    placeNumber: null,
    waitlistNumber: null,
    canRegister: false,
    canCancel: true,
    message: null,
    paymentUrl: event?.paymentUrl ?? null,
    paymentExpiresAt: event?.paymentExpiresAt ?? null,
  }, capturedAtMs), true);
  assert.equal(canPayTournamentPending({
    status: "PAYMENT_PENDING",
    bookingId: null,
    placeNumber: null,
    waitlistNumber: null,
    canRegister: false,
    canCancel: true,
    message: null,
    paymentUrl: event?.paymentUrl ?? null,
    paymentExpiresAt: event?.paymentExpiresAt ?? null,
  }, capturedAtMs), false);
});

test("the payment watcher carries the booking identity through both resolution paths", () => {
  assert.match(source, /createVivaSocketWatcher<TournamentVivaPaymentEvent>/);
  assert.match(source, /bookingId: extractBookingId\(value\)/);
  assert.match(source, /bookingId: event\.bookingId/);
  assert.match(source, /bookingId: event\.bookingId \?\? responseBookingId/);
  assert.match(source, /paymentExpiresAt: event\.paymentExpiresAt \?\? buildPaymentExpiresAt\(transactionStartedAtMs\)/);
  assert.match(source, /pickFirstStringArray\(value, \["bookingIds", "booking_ids"\]\)/);
});
