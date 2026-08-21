import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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

test("transaction lookup falls back from v2 to v1 endpoint and keeps payment url", async () => {
  const seenUrls: string[] = [];
  const fetchWithTrace = new Function(
    "TENANT_KEY",
    "request",
    "normalizeTournamentVivaTransactionResolution",
    `return ${toRunnableFunctionExpression("async function fetchTournamentVivaTransactionResolution")};`,
  )(
    "iSkq6G",
    async (url: string) => {
      seenUrls.push(url);
      if (url.includes("/api/v2/")) {
        return {
          data: null,
          error: { status: 404, message: "not found" },
          status: 404,
        };
      }

      return {
        data: {
          id: "tx-1",
          paymentUrl: "https://pay.example/checkout/tx-1",
          toPay: 2500,
        },
        error: null,
        status: 200,
      };
    },
    (payload: Record<string, unknown>, fallbackPaymentExpiresAt: string | null) => ({
      paymentUrl: typeof payload.paymentUrl === "string" ? payload.paymentUrl : null,
      bookingId: typeof payload.bookingId === "string" ? payload.bookingId : null,
      toPay: typeof payload.toPay === "number" ? payload.toPay : null,
      paid: payload.paid === true,
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

  const resolution = await fetchWithTrace("tx-1", "2026-06-03T10:00:00.000Z");

  assert.deepEqual(seenUrls, [
    "/end-user/api/v2/iSkq6G/transactions/tx-1",
    "/end-user/api/v1/iSkq6G/transactions/tx-1",
  ]);
  assert.equal(resolution?.paymentUrl, "https://pay.example/checkout/tx-1");
  assert.equal(resolution?.toPay, 2500);
  assert.equal(resolution?.paymentExpiresAt, "2026-06-03T10:00:00.000Z");
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
