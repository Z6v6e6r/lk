import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveSplitPromoShareAmount } from "../../src/components/games/splitPromoPricing.ts";
import type { PadelSplitPaymentPromoConfig } from "../../src/utils/apiClient.ts";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function extractFunctionBlock(marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);

  const paramsStart = source.indexOf("(", start);
  assert.ok(paramsStart >= 0, `Cannot find parameters for: ${marker}`);

  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") paramsDepth += 1;
    if (char === ")") {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  assert.ok(paramsEnd >= 0, `Cannot find parameter end for: ${marker}`);

  const bodyStart = source.indexOf("{", paramsEnd);
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

function extractFunctionBody(marker: string) {
  const block = extractFunctionBlock(marker);
  const paramsStart = block.indexOf("(");
  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < block.length; index += 1) {
    const char = block[index];
    if (char === "(") paramsDepth += 1;
    if (char === ")") {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  assert.ok(paramsEnd >= 0, `Cannot find parameter end for: ${marker}`);
  const bodyStart = block.indexOf("{", paramsEnd);
  assert.ok(bodyStart >= 0, `Cannot find runtime body for: ${marker}`);
  return block.slice(bodyStart);
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

  return `(${signature}${block.slice(bodyStart)})`;
}

test("split payment payload keeps client subscription id separate from optional subscription template id", () => {
  const buildPayload = new Function(
    `return ${toRunnableFunctionExpression("function buildPadelSplitPaymentPayload")};`,
  )() as (params: Record<string, unknown>) => Record<string, unknown>;

  const payload = buildPayload({
    date: "2026-06-03",
    fromTime: "18:00",
    toTime: "19:00",
    studioId: "studio-1",
    roomId: "room-1",
    masterServiceId: "master-service-1",
    subServiceIds: ["sub-service-1", "sub-service-1", "sub-service-2"],
    shareCount: 4,
    shareAmount: 2500,
    clientSubscriptionId: "client-sport",
    subscriptionId: null,
  });

  assert.equal(payload.clientSubscriptionId, "client-sport");
  assert.equal(payload.subscriptionId, null);
  assert.equal(payload.masterServiceId, "master-service-1");
  assert.deepEqual(payload.subServiceIds, ["sub-service-1", "sub-service-2"]);
});

test("split payment payload passes distinct subscription id without mirroring client subscription id", () => {
  const buildPayload = new Function(
    `return ${toRunnableFunctionExpression("function buildPadelSplitPaymentPayload")};`,
  )() as (params: Record<string, unknown>) => Record<string, unknown>;

  const payload = buildPayload({
    date: "2026-06-03",
    fromTime: "18:00",
    toTime: "19:00",
    studioId: "studio-1",
    roomId: "room-1",
    shareCount: 4,
    shareAmount: 2500,
    clientSubscriptionId: "client-sport",
    subscriptionId: "product-sport",
  });

  assert.equal(payload.clientSubscriptionId, "client-sport");
  assert.equal(payload.subscriptionId, "product-sport");
});

test("split promo boundaries normalize legacy UTC timestamps to Moscow game dates", () => {
  const normalizeMoscowGameDate = new Function(
    "toTrimmedString",
    "normalizeDateLabel",
    `return ${toRunnableFunctionExpression("function normalizeMoscowGameDateLabel")};`,
  )(
    (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    () => null,
  ) as (value: unknown) => string | null;

  assert.equal(normalizeMoscowGameDate("2026-08-20"), "2026-08-20");
  assert.equal(normalizeMoscowGameDate("2026-08-19T21:00:00.000Z"), "2026-08-20");
  assert.equal(normalizeMoscowGameDate("2026-09-30T20:59:59.999Z"), "2026-09-30");
});

test("raw CUP expiresAt keeps Piter active through September 7 and disables it on September 8", () => {
  const normalizeMoscowGameDate = new Function(
    "toTrimmedString",
    "normalizeDateLabel",
    `return ${toRunnableFunctionExpression("function normalizeMoscowGameDateLabel")};`,
  )(
    (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    () => null,
  ) as (value: unknown) => string | null;

  const defaultConfig = {
    enabled: false,
    pricingMode: "PER_PARTICIPANT_HOUR",
    currency: "RUB",
    stationIds: [],
    stationNameIncludes: [],
    roomIds: [],
    roomNameIncludes: [],
    shareAmounts: { twoTeams: 500, fourPlayers: 250 },
    baseShareAmount: 250,
    vivaDirectionId: 4588,
    vivaExerciseTypeId: 1613,
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
  const pickString = (value: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
    return null;
  };
  const pickNumeric = (value: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(value[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };
  const normalizeFunctionBody = extractFunctionBody(
    "function normalizePadelSplitPaymentPromoConfigPayload",
  ).replace(": item is Record<string, unknown>", "");
  const normalizePayload = new Function(
    "isRecord",
    "pickString",
    "toBoolean",
    "DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG",
    "normalizeMoscowGameDateLabel",
    "uniqueIds",
    "extractStringList",
    "normalizeMoneyAmount",
    "pickNumeric",
    "normalizeIntegerSetting",
    `return function normalizePadelSplitPaymentPromoConfigPayload(value, options) ${normalizeFunctionBody};`,
  )(
    isRecord,
    pickString,
    (value: unknown) => typeof value === "boolean" ? value : null,
    defaultConfig,
    normalizeMoscowGameDate,
    (values: string[]) => Array.from(new Set(values)),
    (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
    },
    pickNumeric,
    (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    },
  ) as (value: unknown) => PadelSplitPaymentPromoConfig;

  const normalized = normalizePayload({
    enabled: false,
    promos: [{
      id: "piter-split-250-per-hour-v1",
      enabled: true,
      activeFrom: "2026-08-20",
      expiresAt: "2026-09-07",
      pricingMode: "PER_PARTICIPANT_HOUR",
      currency: "RUB",
      stationIds: ["studio-piter"],
      stationNameIncludes: [],
      roomIds: [],
      roomNameIncludes: [],
      shareAmounts: { twoTeams: 500, fourPlayers: 250 },
      baseShareAmount: 250,
      vivaDirectionId: 4588,
      vivaExerciseTypeId: 1613,
    }],
  });

  assert.equal(normalized.promos[0].activeTo, "2026-09-07");
  const selection = {
    config: normalized,
    studioId: "studio-piter",
    studioName: "Питер",
    roomId: "court-1",
    roomName: "Корт №1",
    shareCount: 4,
    durationMinutes: 60,
  };
  assert.equal(resolveSplitPromoShareAmount({ ...selection, date: "2026-09-07" }), 250);
  assert.equal(resolveSplitPromoShareAmount({ ...selection, date: "2026-09-08" }), null);
});

test("all split requests authenticate and subscription requests add a stable CORS-compatible operationId", () => {
  const requestHelper = extractFunctionBlock("function buildPadelSplitRequest");
  const createFunction = extractFunctionBlock("export async function apiCreatePadelSplitGamePayment");
  const joinFunction = extractFunctionBlock("export async function apiCreatePadelSplitParticipantPayment");

  assert.match(requestHelper, /paymentMode !== "subscription"/);
  assert.match(requestHelper, /return \{ path, options: \{ auth: true as const \}, operationId \}/);
  assert.match(requestHelper, /String\(params\.paymentRef \|\| ""\)\.trim\(\)/);
  assert.match(requestHelper, /operationId=/);
  assert.match(requestHelper, /auth:\s*true as const/);
  assert.doesNotMatch(requestHelper, /Idempotency-Key/);
  assert.match(requestHelper, /buildPadelSplitIdempotencyKey/);
  for (const sourceBlock of [createFunction, joinFunction]) {
    assert.match(sourceBlock, /buildPadelSplitRequest/);
    assert.doesNotMatch(sourceBlock, /auth:\s*true/);
  }
});

test("split callers treat PENDING_CONFIRMATION as an error instead of creating a local game", () => {
  const pendingHelper = extractFunctionBlock("function resolvePadelSplitPendingError");
  const createFunction = extractFunctionBlock("export async function apiCreatePadelSplitGamePayment");
  const joinFunction = extractFunctionBlock("export async function apiCreatePadelSplitParticipantPayment");

  assert.match(pendingHelper, /PENDING_CONFIRMATION/);
  for (const sourceBlock of [createFunction, joinFunction]) {
    assert.match(sourceBlock, /resolvePadelSplitPendingError/);
    assert.match(sourceBlock, /data: null as PadelSplitPaymentResult \| null/);
  }
});

test("split payment confirmation sends provider locators without a browser-owned paid flag", () => {
  const start = source.indexOf("export async function apiConfirmPadelGameRosterPayment");
  const end = source.indexOf("export async function apiCreatePadelGameRecord", start);
  assert.ok(start >= 0 && end > start);
  const confirmationFunction = source.slice(start, end);

  assert.match(confirmationFunction, /roster-payment-confirm/);
  assert.match(confirmationFunction, /reservationId:\s*input\.reservationId\.trim\(\)/);
  assert.match(confirmationFunction, /operationType:\s*input\.operationType/);
  assert.match(confirmationFunction, /operationId:\s*input\.operationId\.trim\(\)/);
  assert.match(confirmationFunction, /bookingId:\s*input\.bookingId\.trim\(\)/);
  assert.doesNotMatch(confirmationFunction, /\bpaid\s*:/);
});

test("subscription join re-issues the same operation while a pending confirmation is unresolved", () => {
  const joinFunction = extractFunctionBlock("export async function apiCreatePadelSplitParticipantPayment");
  const createFunction = extractFunctionBlock("export async function apiCreatePadelSplitGamePayment");
  const pollFunction = extractFunctionBlock("async function requestPadelSplitJoinWithPendingPoll");

  assert.match(joinFunction, /requestPadelSplitJoinWithPendingPoll\(splitRequest, baseUrl, params\)/);
  assert.doesNotMatch(joinFunction, /await requestPadelSplitPayment\(splitRequest, baseUrl, params\)/);
  assert.match(createFunction, /await requestPadelSplitPayment\(splitRequest, baseUrl, params\)/);
  assert.doesNotMatch(createFunction, /requestPadelSplitJoinWithPendingPoll/);
  assert.match(pollFunction, /params\.paymentMode !== "subscription"/);
  assert.match(pollFunction, /resolvePadelSplitPendingError\(response\.data, response\.status\)/);
  assert.match(pollFunction, /SUBSCRIPTION_BOOKING_CONFIRMATION_DELAYS_MS/);
  assert.equal(
    (pollFunction.match(/requestPadelSplitPayment\(splitRequest, baseUrl, params\)/g) || []).length,
    2,
  );
});

type SplitPollResult = {
  data: unknown;
  error: unknown;
  status: number | null;
};

type SplitPollAttempt = (...args: unknown[]) => Promise<SplitPollResult>;

function buildPendingJoinPoll(
  requestPadelSplitPayment: SplitPollAttempt,
  resolvePadelSplitPendingError?: (data: unknown, status: number | null) => unknown,
) {
  const expression = toRunnableFunctionExpression("async function requestPadelSplitJoinWithPendingPoll");
  return new Function(
    "requestPadelSplitPayment",
    "resolvePadelSplitPendingError",
    "SUBSCRIPTION_BOOKING_CONFIRMATION_DELAYS_MS",
    `return ${expression};`,
  )(
    requestPadelSplitPayment,
    resolvePadelSplitPendingError ?? ((data: unknown, status: number | null) => {
      const state = data && typeof data === "object"
        ? String((data as Record<string, unknown>).state || "").toUpperCase()
        : "";
      return state === "PENDING_CONFIRMATION" ? { status, message: "fixture pending" } : null;
    }),
    [10, 20, 30],
  ) as (
    splitRequest: unknown,
    baseUrl: string,
    params: Record<string, unknown>,
    options: { delaysMs?: number[]; wait?: (delayMs: number) => Promise<void> },
  ) => Promise<SplitPollResult>;
}

const pendingJoinRequest = { path: "/lk/games/game-1/split/join?operationId=op-1", operationId: "op-1" };

test("pending subscription join is re-issued until the gateway confirms it", async () => {
  const waits: number[] = [];
  let requestCalls = 0;
  const request = async (): Promise<SplitPollResult> => {
    requestCalls += 1;
    if (requestCalls < 3) return { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 };
    return { data: { state: "CONFIRMED", bookingId: "booking-1" }, error: null, status: 201 };
  };
  const poll = buildPendingJoinPoll(request);

  const result = await poll(pendingJoinRequest, "", { paymentMode: "subscription" }, {
    wait: async (delayMs: number) => { waits.push(delayMs); },
  });

  assert.equal(requestCalls, 3);
  assert.equal(waits.join(","), "10,20");
  assert.deepEqual(result.data, { state: "CONFIRMED", bookingId: "booking-1" });
  assert.equal(result.error, null);
});

test("definitive subscription join error is returned without any retry", async () => {
  const waits: number[] = [];
  let requestCalls = 0;
  const request = async (): Promise<SplitPollResult> => {
    requestCalls += 1;
    return { data: null, error: { status: 409, message: "no visits left" }, status: 409 };
  };
  const poll = buildPendingJoinPoll(request);

  const result = await poll(pendingJoinRequest, "", { paymentMode: "subscription" }, {
    wait: async (delayMs: number) => { waits.push(delayMs); },
  });

  assert.equal(requestCalls, 1);
  assert.equal(waits.length, 0);
  assert.deepEqual(result.error, { status: 409, message: "no visits left" });
});

test("one-time split join never polls a pending-looking payload", async () => {
  const waits: number[] = [];
  let requestCalls = 0;
  const request = async (): Promise<SplitPollResult> => {
    requestCalls += 1;
    return { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 };
  };
  const poll = buildPendingJoinPoll(request);

  const result = await poll(pendingJoinRequest, "", { paymentMode: "one_time" }, {
    wait: async (delayMs: number) => { waits.push(delayMs); },
  });

  assert.equal(requestCalls, 1);
  assert.equal(waits.length, 0);
  assert.equal(result.status, 202);
});

test("split join keeps polling within the bounded schedule before reporting pending", async () => {
  const waits: number[] = [];
  let requestCalls = 0;
  const request = async (): Promise<SplitPollResult> => {
    requestCalls += 1;
    return { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 };
  };
  const poll = buildPendingJoinPoll(request);

  const result = await poll(pendingJoinRequest, "", { paymentMode: "subscription" }, {
    wait: async (delayMs: number) => { waits.push(delayMs); },
  });

  assert.equal(requestCalls, 4);
  assert.equal(waits.join(","), "10,20,30");
  assert.equal(result.status, 202);
  assert.deepEqual(result.data, { state: "PENDING_CONFIRMATION" });
});

test("every retry repeats the same join path, operation and params object", async () => {
  const seen: unknown[][] = [];
  const request = async (...args: unknown[]): Promise<SplitPollResult> => {
    seen.push(args);
    return seen.length < 3
      ? { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 }
      : { data: { state: "CONFIRMED", bookingId: "booking-2" }, error: null, status: 201 };
  };
  const poll = buildPendingJoinPoll(request);
  const sameRequest = { path: "/lk/games/game-1/split/join?operationId=op-stable", operationId: "op-stable" };
  const sameParams = { paymentMode: "subscription", clientSubscriptionId: "subscription-a" };

  await poll(sameRequest, "https://serv2.invalid", sameParams, { wait: async () => {} });

  assert.equal(seen.length, 3);
  for (const args of seen) {
    assert.equal(args[0], sameRequest);
    assert.equal(args[1], "https://serv2.invalid");
    assert.equal(args[2], sameParams);
  }
});

test("the production pending predicate drives the retry loop", async () => {
  const predicateExpression = toRunnableFunctionExpression("function resolvePadelSplitPendingError");
  const predicate = new Function(
    "isRecord",
    "pickString",
    `return ${predicateExpression};`,
  )(
    (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    (value: unknown, keys: readonly string[]) => {
      if (!value || typeof value !== "object") return null;
      for (const key of keys) {
        const raw = (value as Record<string, unknown>)[key];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
      return null;
    },
  ) as (data: unknown, status: number | null) => { message: string } | null;

  assert.equal(predicate({ state: "CONFIRMED", bookingId: "b" }, 200), null);
  assert.equal(predicate({ error: "rejected" }, 409), null);
  assert.equal(
    predicate({ ok: true, state: "PENDING_CONFIRMATION", message: "gateway pending" }, 202)?.message,
    "gateway pending",
  );
  assert.equal(
    predicate({ data: { state: "pending_confirmation" } }, 202)?.message,
    "Запись ожидает подтверждения Viva. Повторите проверку.",
  );

  let requestCalls = 0;
  const waits: number[] = [];
  const request = async (): Promise<SplitPollResult> => {
    requestCalls += 1;
    if (requestCalls < 2) {
      return { data: { ok: true, state: "PENDING_CONFIRMATION", message: "gateway pending" }, error: null, status: 202 };
    }
    return { data: { state: "CONFIRMED", bookingId: "booking-3" }, error: null, status: 201 };
  };
  const poll = buildPendingJoinPoll(request, predicate);

  const result = await poll(pendingJoinRequest, "", { paymentMode: "subscription" }, {
    delaysMs: [1, 2, 3],
    wait: async (delayMs: number) => { waits.push(delayMs); },
  });

  assert.equal(requestCalls, 2);
  assert.equal(waits.join(","), "1");
  assert.equal((result.data as Record<string, unknown>).bookingId, "booking-3");
});
