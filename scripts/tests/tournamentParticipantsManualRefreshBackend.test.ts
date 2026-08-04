import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const FN_DIR = "scripts/nodered_tournament_participants_nodes";
const CACHE_KEY = "lkTournamentParticipantResponseCacheV2";
const COOLDOWN_KEY = "lkTournamentParticipantManualRefreshCooldownV1";
const ACCESS_FIELD_ID = "e17a32f3-65f7-47c5-bda1-33d79932c884";
const vivaUuid = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const PRIMARY_EXERCISE_ID = vivaUuid(1);
const SECONDARY_EXERCISE_ID = vivaUuid(2);
const LEASE_EXERCISE_ID = vivaUuid(3);
const OVERLOAD_EXERCISE_ID = vivaUuid(4);
const CIRCUIT_EXERCISE_ID = vivaUuid(5);
const LEGACY_EXERCISE_ID = vivaUuid(6);
const QUERY_EXERCISE_ID = vivaUuid(7);
const BODY_EXERCISE_ID = vivaUuid(8);
const cacheKey = (exerciseId: string, capacity: number) => `${exerciseId}:${capacity}`;
const ENVELOPE_KEYS = [
  "exerciseId",
  "participants",
  "reason",
  "refreshed",
  "refreshedAt",
  "retryAfterMs",
];

function createContext(
  initial: Record<string, unknown> = {},
  globalInitial: Record<string, unknown> = {},
) {
  const values = new Map(Object.entries(initial));
  const globalValues = new Map(Object.entries(globalInitial));
  return {
    values,
    globalValues,
    flow: {
      get(key: string) {
        return values.get(key);
      },
      set(key: string, value: unknown) {
        values.set(key, value);
      },
    },
    global: {
      get(key: string) {
        return globalValues.get(key);
      },
      set(key: string, value: unknown) {
        globalValues.set(key, value);
      },
    },
  };
}

function runNodeRedFunction(
  fileName: string,
  options: {
    msg?: Record<string, any>;
    context?: ReturnType<typeof createContext>;
  } = {},
) {
  const source = fs.readFileSync(`${FN_DIR}/${fileName}`, "utf8");
  const fn = new Function("msg", "flow", "global", "node", source);
  const context = options.context ?? createContext();
  const msg = options.msg ?? {};
  const result = fn(msg, context.flow, context.global, { send() {} });
  return { result, context, msg };
}

function atTime<T>(now: number, callback: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return callback();
  } finally {
    Date.now = originalNow;
  }
}

function manualMessage(exerciseId = PRIMARY_EXERCISE_ID, size = 100) {
  return {
    _tournamentParticipantManualRefresh: {
      authorized: true,
      exerciseId,
      size,
      profileId: "profile-1",
    },
    payload: { exerciseId },
  };
}

function assertEnvelope(payload: Record<string, unknown>) {
  assert.deepEqual(Object.keys(payload).sort(), ENVELOPE_KEYS);
}

test("manual refresh rejects mismatched IDs and missing bearer before profile lookup", () => {
  const mismatch = runNodeRedFunction("fn_manual_refresh_prepare_v1.js", {
    msg: {
      req: {
        query: { exerciseId: QUERY_EXERCISE_ID },
        headers: { authorization: "Bearer token" },
      },
      payload: { exerciseId: BODY_EXERCISE_ID },
    },
  }).result;

  assert.equal(mismatch[0], null);
  assert.equal(mismatch[1].statusCode, 400);
  assert.deepEqual(mismatch[1].payload, {
    error: "EXERCISE_ID_MISMATCH",
    code: "EXERCISE_ID_MISMATCH",
    message: "ID турнира в query и body не совпадают",
  });

  const noBearer = runNodeRedFunction("fn_manual_refresh_prepare_v1.js", {
    msg: {
      req: { query: { exerciseId: PRIMARY_EXERCISE_ID }, headers: {} },
      payload: {},
    },
  }).result;
  assert.equal(noBearer[0], null);
  assert.equal(noBearer[1].statusCode, 401);
  assert.equal(noBearer[1].payload.code, "AUTH_TOKEN_REQUIRED");
});

test("manual refresh verifies the exact tournament-hosting profile field", () => {
  const prepared = runNodeRedFunction("fn_manual_refresh_prepare_v1.js", {
    msg: {
      req: {
        query: { exerciseId: PRIMARY_EXERCISE_ID },
        headers: { authorization: "Bearer valid-token" },
      },
      payload: { exerciseId: PRIMARY_EXERCISE_ID },
    },
  }).result;

  assert.equal(prepared[1], null);
  assert.equal(prepared[0].method, "GET");
  assert.equal(prepared[0].url, "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile");
  assert.equal(prepared[0].requestTimeout, 4_500);
  assert.equal(prepared[0].headers.Authorization, "Bearer valid-token");

  prepared[0].statusCode = 200;
  prepared[0].payload = {
    id: "profile-1",
    customFields: [{ id: ACCESS_FIELD_ID, value: ["проводит турниры"] }],
  };
  const authorized = runNodeRedFunction("fn_manual_refresh_authorize_v1.js", {
    msg: prepared[0],
  }).result;
  assert.equal(authorized[1], null);
  assert.equal(authorized[0]._tournamentParticipantManualRefresh.authorized, true);
  assert.equal(authorized[0]._tournamentParticipantManualRefresh.profileId, "profile-1");

  const optionAuthorized = runNodeRedFunction("fn_manual_refresh_authorize_v1.js", {
    msg: {
      statusCode: 200,
      _tournamentParticipantManualRefresh: {
        authorized: false,
        exerciseId: PRIMARY_EXERCISE_ID,
        size: 100,
      },
      payload: {
        id: "profile-2",
        customFields: [{
          id: ACCESS_FIELD_ID,
          value: ["option-host"],
          attributes: { options: [{ id: "option-host", name: "Проводит турниры" }] },
        }],
      },
    },
  }).result;
  assert.equal(optionAuthorized[1], null);
  assert.equal(optionAuthorized[0]._tournamentParticipantManualRefresh.authorized, true);

  const trainerOnly = runNodeRedFunction("fn_manual_refresh_authorize_v1.js", {
    msg: {
      statusCode: 200,
      _tournamentParticipantManualRefresh: {
        authorized: false,
        exerciseId: PRIMARY_EXERCISE_ID,
        size: 100,
      },
      payload: {
        id: "profile-3",
        trainer: true,
        customFields: [],
      },
    },
  }).result;
  assert.equal(trainerOnly[0], null);
  assert.equal(trainerOnly[1].statusCode, 403);
  assert.equal(trainerOnly[1].payload.code, "TOURNAMENT_ACCESS_REQUIRED");
});

test("manual success and cooldown use an HTTP 200 observable envelope", () => {
  const now = 1_000_000;
  const context = createContext();
  const owner = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: manualMessage(),
  }).result[0]);
  assert.ok(owner);
  assert.equal(owner.participantCacheOwnsInflight, true);

  owner.statusCode = 200;
  owner.payload = [{ id: "participant-1" }];
  const success = atTime(now + 1_000, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: owner,
  }).result);
  assert.equal(success.statusCode, 200);
  assertEnvelope(success.payload);
  assert.equal(success.payload.refreshed, true);
  assert.equal(success.payload.reason, "refreshed");
  assert.deepEqual(success.payload.participants, [{ id: "participant-1" }]);
  assert.equal(success.payload.retryAfterMs, 29_000);

  const cooldownBypass = atTime(now + 5_000, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: manualMessage(),
  }).result[1]);
  assert.equal(cooldownBypass.statusCode, 200);
  const cooldown = atTime(now + 5_000, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: cooldownBypass,
  }).result);
  assert.equal(cooldown.statusCode, 200);
  assertEnvelope(cooldown.payload);
  assert.equal(cooldown.payload.refreshed, false);
  assert.equal(cooldown.payload.reason, "cooldown");
  assert.equal(cooldown.payload.retryAfterMs, 25_000);
});

test("manual in-progress bypass is HTTP 200 and cannot clear the admitted owner", () => {
  const now = 2_000_000;
  const context = createContext({
    [CACHE_KEY]: {
      entries: {
        [cacheKey(PRIMARY_EXERCISE_ID, 100)]: {
          at: now - 10_000,
          epoch: 0,
          exerciseId: PRIMARY_EXERCISE_ID,
          payload: [{ id: "cached" }, { id: "cached-extra" }],
          refreshedAt: new Date(now - 10_000).toISOString(),
        },
      },
      inflight: {
        [cacheKey(PRIMARY_EXERCISE_ID, 100)]: {
          startedAt: now - 500,
          epoch: 0,
          exerciseId: PRIMARY_EXERCISE_ID,
          ownerId: "real-owner",
        },
      },
      refreshByExercise: {},
    },
  });

  const bypass = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: manualMessage(PRIMARY_EXERCISE_ID, 1),
  }).result[1]);
  const response = atTime(now, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: bypass,
  }).result);

  assert.equal(response.statusCode, 200);
  assertEnvelope(response.payload);
  assert.equal(response.payload.reason, "in_progress");
  assert.equal(response.payload.retryAfterMs, 29_500);
  assert.equal(response.headers["Retry-After"], "30");
  assert.deepEqual(response.payload.participants, [{ id: "cached" }]);
  assert.equal(
    (context.values.get(CACHE_KEY) as any).inflight[cacheKey(PRIMARY_EXERCISE_ID, 100)].ownerId,
    "real-owner",
  );
});

test("GET keeps a live owner for 30 seconds and exposes the exact remaining lease", () => {
  const now = 2_500_000;
  const context = createContext({
    [CACHE_KEY]: {
      entries: {},
      inflight: {
        [cacheKey(LEASE_EXERCISE_ID, 100)]: {
          startedAt: now - 15_000,
          epoch: 0,
          exerciseId: LEASE_EXERCISE_ID,
          ownerId: "owner-live",
        },
      },
      refreshByExercise: {},
    },
  });

  const busy = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: LEASE_EXERCISE_ID, size: "100" } } },
  }).result);
  assert.equal(busy[0], null);
  assert.equal(busy[1].statusCode, 429);
  assert.equal(busy[1].headers["Retry-After"], "15");
  assert.deepEqual(busy[1].payload, {
    error: "Participants refresh is busy",
    retryAfterMs: 15_000,
  });
  assert.equal(
    (context.values.get(CACHE_KEY) as any).inflight[cacheKey(LEASE_EXERCISE_ID, 100)].ownerId,
    "owner-live",
  );

  const replacement = atTime(now + 15_001, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: LEASE_EXERCISE_ID, size: "100" } } },
  }).result);
  assert.ok(replacement[0]);
  assert.equal(replacement[1], null);
  assert.notEqual(replacement[0].participantCacheOwnerId, "owner-live");
});

test("manual upstream errors return stale_if_error or unavailable as HTTP 200", () => {
  const now = 3_000_000;
  const stalePayload = [{ id: "stale" }, { id: "stale-extra" }];
  const staleContext = createContext({
    [CACHE_KEY]: {
      entries: {
        [cacheKey(PRIMARY_EXERCISE_ID, 100)]: {
          at: now - 60_000,
          epoch: 0,
          exerciseId: PRIMARY_EXERCISE_ID,
          payload: stalePayload,
          refreshedAt: new Date(now - 60_000).toISOString(),
        },
      },
      inflight: {},
      refreshByExercise: {},
    },
  });
  const staleOwner = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context: staleContext,
    msg: manualMessage(PRIMARY_EXERCISE_ID, 1),
  }).result[0]);
  staleOwner.statusCode = 502;
  staleOwner.payload = { error: "Viva down" };
  const staleResponse = atTime(now + 1, () => runNodeRedFunction("fn_terminal_v2.js", {
    context: staleContext,
    msg: staleOwner,
  }).result);
  assert.equal(staleResponse.statusCode, 200);
  assertEnvelope(staleResponse.payload);
  assert.equal(staleResponse.payload.reason, "stale_if_error");
  assert.deepEqual(staleResponse.payload.participants, [{ id: "stale" }]);

  const unavailableContext = createContext();
  const unavailableOwner = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context: unavailableContext,
    msg: manualMessage(SECONDARY_EXERCISE_ID),
  }).result[0]);
  unavailableOwner.statusCode = 502;
  unavailableOwner.payload = { error: "Viva down" };
  const unavailable = atTime(now + 1, () => runNodeRedFunction("fn_terminal_v2.js", {
    context: unavailableContext,
    msg: unavailableOwner,
  }).result);
  assert.equal(unavailable.statusCode, 200);
  assertEnvelope(unavailable.payload);
  assert.equal(unavailable.payload.reason, "unavailable");
  assert.deepEqual(unavailable.payload.participants, []);
});

test("bounded cache buckets promote small to large and keep cadence per exercise", () => {
  const context = createContext();
  const base = 4_000_000;
  const unchangedPayload = [
    { id: "participant-1" },
    { id: "participant-2" },
    { id: "participant-3" },
  ];

  const firstOwner = atTime(base, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "1" } } },
  }).result[0]);
  assert.equal(firstOwner.participantCacheKey, cacheKey(PRIMARY_EXERCISE_ID, 100));
  assert.equal(firstOwner.participantFetchCapacity, 100);
  assert.equal(firstOwner.participantResponseSize, 1);
  firstOwner.statusCode = 200;
  firstOwner.payload = unchangedPayload;
  const firstResponse = atTime(base, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: firstOwner,
  }).result);
  assert.deepEqual(firstResponse.payload, [{ id: "participant-1" }]);
  let state = context.values.get(CACHE_KEY) as any;
  assert.equal(state.entries[cacheKey(PRIMARY_EXERCISE_ID, 100)].capacity, 100);
  assert.deepEqual(state.entries[cacheKey(PRIMARY_EXERCISE_ID, 100)].payload, unchangedPayload);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].unchangedCycles, 0);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].nextRefreshAt, base + 60_000);

  const promotionOwner = atTime(base + 30_000, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "200" } } },
  }).result[0]);
  assert.ok(promotionOwner);
  assert.equal(promotionOwner.participantCacheKey, cacheKey(PRIMARY_EXERCISE_ID, 200));
  assert.equal(promotionOwner.participantFetchCapacity, 200);
  assert.equal(promotionOwner.participantCacheFallbackKey, null);

  const concurrentLarge = atTime(base + 30_500, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "200" } } },
  }).result);
  assert.equal(concurrentLarge[0], null);
  assert.equal(concurrentLarge[1].statusCode, 429);
  assert.equal(concurrentLarge[1].headers["x-lk-participants-cache"], "busy-key");
  assert.equal(concurrentLarge[1].headers["Retry-After"], "30");
  assert.deepEqual(concurrentLarge[1].payload, {
    error: "Participants refresh is busy",
    retryAfterMs: 29_500,
  });

  promotionOwner.statusCode = 200;
  promotionOwner.payload = [...unchangedPayload].reverse();
  atTime(base + 30_001, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: promotionOwner,
  }));
  state = context.values.get(CACHE_KEY) as any;
  assert.equal(state.entries[cacheKey(PRIMARY_EXERCISE_ID, 200)].capacity, 200);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].unchangedCycles, 1);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].nextRefreshAt, base + 150_001);

  const smallerHit = atTime(base + 40_000, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "1" } } },
  }).result);
  assert.equal(smallerHit[0], null);
  assert.equal(smallerHit[1].headers["x-lk-participants-cache"], "hit");
  assert.equal(smallerHit[1].participantCacheFallbackKey, cacheKey(PRIMARY_EXERCISE_ID, 200));
  assert.deepEqual(smallerHit[1].payload, [{ id: "participant-3" }]);
  assert.deepEqual(state.inflight, {});

  const cadenceOwner = atTime(base + 150_002, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "200" } } },
  }).result[0]);
  assert.ok(cadenceOwner);
  cadenceOwner.statusCode = 200;
  cadenceOwner.payload = unchangedPayload;
  atTime(base + 150_002, () => runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: cadenceOwner,
  }));
  state = context.values.get(CACHE_KEY) as any;
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].unchangedCycles, 2);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].nextRefreshAt, base + 450_002);

  const changedOwner = atTime(base + 450_003, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "200" } } },
  }).result[0]);
  changedOwner.statusCode = 200;
  changedOwner.payload = [{ id: "newest" }, { id: "second" }];
  atTime(base + 450_003, () => runNodeRedFunction("fn_terminal_v2.js", { context, msg: changedOwner }));
  state = context.values.get(CACHE_KEY) as any;
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].unchangedCycles, 0);
  assert.equal(state.refreshByExercise[PRIMARY_EXERCISE_ID].nextRefreshAt, base + 510_003);

  const newestSliced = atTime(base + 460_000, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: PRIMARY_EXERCISE_ID, size: "1" } } },
  }).result);
  assert.equal(newestSliced[0], null);
  assert.deepEqual(newestSliced[1].payload, [{ id: "newest" }]);
  assert.equal(newestSliced[1].participantCacheFallbackKey, cacheKey(PRIMARY_EXERCISE_ID, 200));
});

test("manual overload and circuit outcomes remain HTTP 200 envelopes", () => {
  const now = 5_000_000;
  const inflight = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const exerciseId = vivaUuid(100 + index);
      return [cacheKey(exerciseId, 100), {
        startedAt: now,
        epoch: 0,
        exerciseId,
        ownerId: `owner-${index}`,
      }];
    }),
  );
  const overloadContext = createContext({
    [CACHE_KEY]: { entries: {}, inflight, refreshByExercise: {} },
  });
  const overloadBypass = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context: overloadContext,
    msg: manualMessage(OVERLOAD_EXERCISE_ID),
  }).result[1]);
  const overload = atTime(now, () => runNodeRedFunction("fn_terminal_v2.js", {
    context: overloadContext,
    msg: overloadBypass,
  }).result);
  assert.equal(overload.statusCode, 200);
  assertEnvelope(overload.payload);
  assert.equal(overload.payload.reason, "overload");

  const circuitContext = createContext({
    lkTournamentParticipantVivaCircuitV2: { failures: 3, openedUntil: now + 10_000 },
  });
  const circuitBypass = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context: circuitContext,
    msg: manualMessage(CIRCUIT_EXERCISE_ID),
  }).result[1]);
  const unavailable = atTime(now, () => runNodeRedFunction("fn_terminal_v2.js", {
    context: circuitContext,
    msg: circuitBypass,
  }).result);
  assert.equal(unavailable.statusCode, 200);
  assertEnvelope(unavailable.payload);
  assert.equal(unavailable.payload.reason, "unavailable");
});

test("all manual-refresh Node-RED function bodies compile", () => {
  const files = fs.readdirSync(FN_DIR).filter((fileName) => fileName.includes("manual_refresh"));
  assert.deepEqual(files.sort(), [
    "fn_manual_refresh_authorize_v1.js",
    "fn_manual_refresh_options_v1.js",
    "fn_manual_refresh_prepare_v1.js",
  ]);
  files.forEach((fileName) => {
    const source = fs.readFileSync(`${FN_DIR}/${fileName}`, "utf8");
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", source), fileName);
  });
});

test("manual cooldown is global state keyed only by exact exercise", () => {
  const now = 6_000_000;
  const context = createContext({}, {
    [COOLDOWN_KEY]: {
      [PRIMARY_EXERCISE_ID]: { at: now - 1_000 },
    },
  });
  const blocked = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: manualMessage(PRIMARY_EXERCISE_ID, 200),
  }).result[1]);
  const other = atTime(now, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: manualMessage(SECONDARY_EXERCISE_ID, 200),
  }).result[0]);

  assert.equal(blocked.participantManualRefreshReason, "cooldown");
  assert.ok(other);
  assert.equal(other.participantCacheOwnsInflight, true);
});

test("synthetic and manual IDs never reach profile lookup or GET Viva admission", () => {
  for (const exerciseId of ["exercise-1", "manual-tournament-1", "viva_exercise-1"]) {
    const prepared = runNodeRedFunction("fn_manual_refresh_prepare_v1.js", {
      msg: {
        req: {
          query: { exerciseId },
          headers: { authorization: "Bearer valid-token" },
        },
        payload: { exerciseId },
      },
    }).result;
    assert.equal(prepared[0], null);
    assert.equal(prepared[1].statusCode, 400);
    assert.equal(prepared[1].payload.code, "EXERCISE_ID_INVALID");
    assert.equal(prepared[1].url, undefined);
    assert.equal(prepared[1]._tournamentParticipantManualRefresh, undefined);

    const context = createContext();
    const gated = runNodeRedFunction("fn_cache_gate_v2.js", {
      context,
      msg: { req: { query: { exerciseId, size: "100" } } },
    }).result;
    assert.equal(gated[0], null);
    assert.equal(gated[1].statusCode, 400);
    assert.equal(gated[1].payload.code, "EXERCISE_ID_INVALID");
    assert.equal(gated[1].participantCacheKey, undefined);
    const response = runNodeRedFunction("fn_terminal_v2.js", {
      context,
      msg: gated[1],
    }).result;
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.code, "EXERCISE_ID_INVALID");
    assert.equal(response.participantCacheSkipTerminalState, undefined);
    assert.equal(context.values.has(CACHE_KEY), false);
    assert.equal(context.globalValues.size, 0);
  }
});

test("legacy requested-size cache entries cannot impersonate a complete 100 bucket", () => {
  const now = 8_000_000;
  const context = createContext({
    [CACHE_KEY]: {
      entries: {
        [cacheKey(LEGACY_EXERCISE_ID, 1)]: {
          at: now,
          epoch: 0,
          payload: [{ id: "partial-only" }],
          nextRefreshAt: now + 60_000,
        },
      },
      inflight: {},
      refreshByExercise: {
        [LEGACY_EXERCISE_ID]: {
          at: now,
          epoch: 0,
          nextRefreshAt: now + 60_000,
        },
      },
    },
  });
  const promoted = atTime(now + 1_000, () => runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: LEGACY_EXERCISE_ID, size: "100" } } },
  }).result);

  assert.ok(promoted[0]);
  assert.equal(promoted[1], null);
  assert.equal(promoted[0].participantCacheKey, cacheKey(LEGACY_EXERCISE_ID, 100));
  assert.equal(promoted[0].participantCacheFallbackKey, null);
});
