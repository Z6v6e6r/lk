// Contract between the client release rule (isDefinitiveSplitJoinRefusal) and the
// real Node-RED handlers: every status + code pair the client accepts as "refused
// before any provider write" is produced only at a pre-write point, and the
// answers produced after a provider write never satisfy the rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDefinitiveSplitJoinRefusal } from "../../src/utils/splitJoinAttemptEvidence.ts";
// @ts-expect-error untyped .mjs composer of the paid-join pilot
import { composePaidJoinRouter } from "../patch_live_paid_join_recovery.mjs";

const routerSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_router.js", "utf8");
const prepareSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_join_prepare.js", "utf8");
const checkoutSource = fs.readFileSync("scripts/nodered_split_join_recovery_nodes/checkout.js", "utf8");
const PREWRITE_CODES = ["SPLIT_GAME_LOCATION_INCOMPLETE", "SPLIT_JOIN_AUTH_REQUIRED", "SPLIT_JOIN_ACTOR_MISMATCH"];
const occurrences = (source: string, needle: string) => source.split(needle).length - 1;

test("pre-write codes have exactly one origin and the base split router never emits them", () => {
  for (const code of PREWRITE_CODES) assert.equal(occurrences(routerSource, code), 0, `${code} in fn_split_router.js`);
  assert.equal(occurrences(prepareSource, '"SPLIT_GAME_LOCATION_INCOMPLETE"'), 1);
  assert.equal(occurrences(checkoutSource, '"SPLIT_JOIN_AUTH_REQUIRED"'), 1);
  assert.equal(occurrences(checkoutSource, '"SPLIT_JOIN_ACTOR_MISMATCH"'), 1);
  // The join prepare reads storage and refreshes the service token; it never calls a business write.
  assert.doesNotMatch(prepareSource, /\/transactions|\/bookings"|adminRequest/);
  // In the pilot both codes sit before the first provider write of the request.
  const firstWrite = checkoutSource.search(/adminRequest\(ctx, "(POST|PATCH|DELETE)"/);
  assert.ok(firstWrite > 0);
  assert.ok(checkoutSource.indexOf('"SPLIT_JOIN_AUTH_REQUIRED"') < firstWrite);
  assert.ok(checkoutSource.indexOf('"SPLIT_JOIN_ACTOR_MISMATCH"') < firstWrite);
});

type Out = Array<{ statusCode?: number; payload?: unknown; method?: string; url?: string; _splitCtx?: Record<string, unknown> } | null | undefined>;
const runBase = (msg: Record<string, unknown>) => new Function("msg", "env", "global", routerSource)(
  msg, { get: () => undefined }, { get: () => undefined, set() {} }) as Out;

test("base router: every failure after POST /transactions keeps the hold", () => {
  const ctx = { action: "join", step: "transaction", paymentMode: "one_time", gameId: "g", paymentRef: "r", operationId: "r",
    token: "t", exerciseId: "e", bookingId: "b", shareAmountMinor: 150000 };
  for (const status of [400, 401, 403, 404, 405, 409, 410, 415, 422, 429, 500, 502, 503]) {
    const created = runBase({ statusCode: status, payload: { message: "x" }, _splitCtx: { ...ctx } })[1];
    assert.equal(isDefinitiveSplitJoinRefusal(created?.statusCode, created?.payload), false, `create ${status}`);
    const lookupStep = runBase({ statusCode: 201, payload: { id: "txn-1" }, _splitCtx: { ...ctx } })[0];
    const lookup = runBase({ statusCode: status, payload: { message: "x" }, _splitCtx: { ...lookupStep!._splitCtx } })[1];
    assert.equal(isDefinitiveSplitJoinRefusal(lookup?.statusCode, lookup?.payload), false, `lookup ${status}`);
  }
});

test("base router forwards a provider payload as details: a provider-echoed code is the only residual risk", () => {
  // Documented boundary: the router puts Viva's body into details. If Viva ever returned
  // {code: "SPLIT_JOIN_AUTH_REQUIRED"} with 401 the client would release. Viva codes are
  // not SPLIT_-prefixed; this test pins the current forwarding so a change is noticed.
  const ctx = { action: "join", step: "transaction", paymentMode: "one_time", gameId: "g", paymentRef: "r", operationId: "r",
    token: "t", exerciseId: "e", bookingId: "b", shareAmountMinor: 150000 };
  const out = runBase({ statusCode: 401, payload: { message: "Unauthorized" }, _splitCtx: ctx })[1];
  assert.deepEqual(out?.payload, { error: "Viva request failed", details: { message: "Unauthorized" } });
});

test("paid-join pilot: auth and actor refusals are pre-write; a failed lookup after the bill is in flight", () => {
  const source = composePaidJoinRouter(routerSource, 5) as string;
  const store = new Map<string, unknown>();
  const env = { get: (name: string) => ({ LK_PAID_SPLIT_JOIN_RECOVERY_ENABLED: "1", LK_PAID_SPLIT_JOIN_RECOVERY_GAME_IDS: "game-fixture" } as Record<string, string>)[name] || "" };
  const run = (msg: Record<string, unknown>) => new Function("msg", "env", "global", "node", source)(
    msg, env, { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) }, { warn() {}, error() {} }) as Out;
  const admitted = (rest: Record<string, unknown> = {}) => ({
    action: "join", step: "token", paymentMode: "one_time", paidJoinTenant: null, gameId: "game-fixture", exerciseId: "exercise-fixture",
    clientId: "actor-fixture", clientPhone: "71111111111", userAuthHeader: "Bearer fixture", paymentRef: "ref-fixture",
    roomId: "room-fixture", studioId: "studio-fixture", exactCourtPriceVerified: true, shareAmount: 1200, shareAmountMinor: 120000,
    totalAmount: 4800, shareCount: 4, ...rest,
  });

  const noSession = run({ _splitCtx: admitted({ userAuthHeader: "" }), statusCode: 200, payload: { access_token: "service" } });
  assert.equal(noSession[0], null, "no provider call");
  assert.equal(isDefinitiveSplitJoinRefusal(noSession[1]?.statusCode, noSession[1]?.payload), true, JSON.stringify(noSession[1]?.payload));

  const ctx = admitted();
  const profile = run({ _splitCtx: ctx, statusCode: 200, payload: { access_token: "service" } });
  assert.equal(profile[0]?.method, "GET");
  assert.ok(profile[0]?.url?.endsWith("/profile"));
  const foreign = run({ _splitCtx: profile[0]!._splitCtx, statusCode: 200, payload: { id: "other-fixture", phone: "71111111111" } });
  assert.equal(foreign[0], null, "no provider call");
  assert.equal(isDefinitiveSplitJoinRefusal(foreign[1]?.statusCode, foreign[1]?.payload), true, JSON.stringify(foreign[1]?.payload));

  for (const status of [400, 401, 403, 404, 422]) {
    const lookup = run({ _splitCtx: { ...admitted(), paidJoin: true, step: "transaction_lookup", transactionId: "txn-1" },
      statusCode: status, payload: { message: "x" } });
    const answer = lookup[1];
    assert.ok(answer, `pilot lookup ${status} answered`);
    assert.equal(isDefinitiveSplitJoinRefusal(answer?.statusCode, answer?.payload), false, `pilot lookup ${status}: ${JSON.stringify(answer?.payload)}`);
  }
});
