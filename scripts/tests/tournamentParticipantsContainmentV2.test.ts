import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const FN_DIR = "scripts/nodered_tournament_participants_nodes";

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
    sent?: unknown[];
  } = {},
) {
  const source = fs.readFileSync(`${FN_DIR}/${fileName}`, "utf8");
  const fn = new Function("msg", "flow", "global", "node", source);
  const context = options.context ?? createContext();
  const sent = options.sent ?? [];
  const result = fn(
    options.msg ?? {},
    context.flow,
    context.global,
    { send: (value: unknown) => sent.push(value) },
  );
  return { result, context, sent };
}

test("same-key cold refresh rejects without retaining req/res waiters", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const context = createContext({
    [cacheKey]: {
      entries: {},
      inflight: { "exercise-1:100": { startedAt: Date.now() } },
    },
  });
  const req = { query: { exerciseId: "exercise-1" } };
  const res = { marker: "response" };
  const { result } = runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req, res },
  });

  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 429);
  assert.equal(result[1].headers["x-lk-participants-cache"], "busy-key");
  assert.deepEqual(context.values.get(cacheKey), {
    entries: {},
    inflight: { "exercise-1:100": { startedAt: (context.values.get(cacheKey) as any).inflight["exercise-1:100"].startedAt } },
  });
  assert.doesNotMatch(JSON.stringify(context.values.get(cacheKey)), /response|waiters/);
});

test("same-key refresh serves stale immediately while one request refreshes", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const payload = [{ id: "participant-1" }];
  const context = createContext({
    [cacheKey]: {
      entries: { "exercise-1:100": { at: Date.now() - 90_000, payload } },
      inflight: { "exercise-1:100": { startedAt: Date.now() } },
    },
  });
  const { result } = runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: "exercise-1" } } },
  });

  assert.equal(result[1].statusCode, 200);
  assert.equal(result[1].headers["x-lk-participants-cache"], "stale-refreshing");
  assert.equal(result[1].payload, payload);
  assert.equal(result[1].participantCacheBypassWrite, true);
});

test("global refresh admission limit rejects a ninth cold exercise", () => {
  const inflight = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`exercise-${index}:100`, { startedAt: Date.now() }]),
  );
  const context = createContext({
    lkTournamentParticipantResponseCacheV2: { entries: {}, inflight },
  });
  const { result } = runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: "exercise-9" } } },
  });

  assert.equal(result[1].statusCode, 429);
  assert.equal(result[1].headers["x-lk-participants-cache"], "busy-global");
});

test("terminal stores a successful response and clears inflight", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const context = createContext({
    [cacheKey]: {
      entries: {},
      inflight: { "exercise-1:100": { startedAt: Date.now() } },
    },
  });
  const payload = [{ id: "participant-1" }];
  const msg = {
    statusCode: 200,
    payload,
    participantCacheKey: "exercise-1:100",
    participantCacheExerciseId: "exercise-1",
    participantCacheEpoch: 0,
  };
  const { result } = runNodeRedFunction("fn_terminal_v2.js", { context, msg });
  const state = context.values.get(cacheKey) as any;

  assert.equal(result, msg);
  assert.equal(result.headers["x-lk-participants-cache"], "miss");
  assert.equal(state.entries["exercise-1:100"].payload, payload);
  assert.equal(state.entries["exercise-1:100"].epoch, 0);
  assert.equal(state.inflight["exercise-1:100"], undefined);
});

test("epoch bump prevents serving a previously fresh participant cache entry", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const context = createContext({
    [cacheKey]: {
      entries: {
        "exercise-1:100": { at: Date.now(), epoch: 4, payload: [{ id: "stale" }] },
      },
      inflight: {},
    },
  }, {
    lkTournamentParticipantEpochV1: { "exercise-1": 5 },
  });
  const { result } = runNodeRedFunction("fn_cache_gate_v2.js", {
    context,
    msg: { req: { query: { exerciseId: "exercise-1" } } },
  });
  const state = context.values.get(cacheKey) as any;

  assert.notEqual(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[0].participantCacheEpoch, 5);
  assert.equal(state.entries["exercise-1:100"], undefined);
  assert.equal(state.inflight["exercise-1:100"].epoch, 5);
});

test("epoch bump during an upstream read suppresses its stale response and cache write", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const context = createContext({
    [cacheKey]: {
      entries: {},
      inflight: { "exercise-1:100": { startedAt: Date.now(), epoch: 8 } },
    },
  }, {
    lkTournamentParticipantEpochV1: { "exercise-1": 9 },
  });
  const msg = {
    statusCode: 200,
    payload: [{ id: "pre-leave-roster" }],
    participantCacheKey: "exercise-1:100",
    participantCacheExerciseId: "exercise-1",
    participantCacheEpoch: 8,
  };
  const { result } = runNodeRedFunction("fn_terminal_v2.js", { context, msg });
  const state = context.values.get(cacheKey) as any;

  assert.equal(result.statusCode, 409);
  assert.equal(result.headers["x-lk-participants-cache"], "epoch-changed");
  assert.equal(state.entries["exercise-1:100"], undefined);
  assert.equal(state.inflight["exercise-1:100"], undefined);
});

test("terminal falls back to stale on upstream error without extending its age", () => {
  const cacheKey = "lkTournamentParticipantResponseCacheV2";
  const at = Date.now() - 120_000;
  const payload = [{ id: "participant-stale" }];
  const context = createContext({
    [cacheKey]: {
      entries: { "exercise-1:100": { at, payload } },
      inflight: { "exercise-1:100": { startedAt: Date.now() } },
    },
  });
  const { result } = runNodeRedFunction("fn_terminal_v2.js", {
    context,
    msg: {
      statusCode: 502,
      payload: { error: "upstream" },
      participantCacheKey: "exercise-1:100",
    },
  });
  const state = context.values.get(cacheKey) as any;

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload, payload);
  assert.equal(result.headers["x-lk-participants-cache"], "stale-if-error");
  assert.equal(state.entries["exercise-1:100"].at, at);
});

test("client queue is bounded and overflow fallback never exposes phone", () => {
  const queue = Array.from({ length: 30 }, (_, index) => ({
    _participantClientQueuedAt: Date.now(),
    participant: { client: { id: `client-${index}` } },
  }));
  const context = createContext({
    lkTournamentParticipantClientQueueV2: { active: 3, queue },
  });
  const { result } = runNodeRedFunction("fn_client_queue_v2.js", {
    context,
    msg: {
      participant: { client: { id: "overflow", phone: "+79990000000" } },
    },
  });

  assert.equal(result[0], null);
  assert.equal(result[1].payload.rating, null);
  assert.equal(result[1].payload.client.phone, undefined);
  assert.equal((context.values.get("lkTournamentParticipantClientQueueV2") as any).queue.length, 30);
});

test("release sends the next queued lookup to client HTTP and current result to join", () => {
  const next = {
    _participantClientQueuedAt: Date.now(),
    participant: { client: { id: "next-client" } },
  };
  const context = createContext({
    lkTournamentParticipantClientQueueV2: { active: 3, queue: [next] },
  });
  const sent: unknown[] = [];
  const current = { _participantClientQueueSlot: true, payload: { id: "done" } };
  const { result } = runNodeRedFunction("fn_client_release_v2.js", {
    context,
    msg: current,
    sent,
  });

  assert.equal((sent[0] as any)[0], next);
  assert.equal((sent[0] as any)[1], null);
  assert.equal(result[0], null);
  assert.equal(result[1], current);
  assert.equal((context.values.get("lkTournamentParticipantClientQueueV2") as any).active, 3);
});

test("booking normalization strips phone before the anonymous response path", () => {
  const { result } = runNodeRedFunction("fn_normalize_bookings_v2.js", {
    msg: {
      statusCode: 200,
      payload: [{
        id: "booking-1",
        client: {
          id: "client-1",
          firstName: "Анна",
          lastName: "Иванова",
          phone: "+79990000000",
        },
      }],
    },
  });

  assert.equal(result[0].payload[0].client.id, "client-1");
  assert.equal(result[0].payload[0].client.phone, undefined);
});

test("v2 patch source pins bounded cache and two-output release wiring", () => {
  const patchSource = fs.readFileSync("scripts/patch_live_tournament_participants_containment_v2.mjs", "utf8");
  assert.match(patchSource, /EXPECTED_SOURCE_SHA256 = "4e51d315/);
  assert.match(patchSource, /clientRelease\.outputs = 2/);
  assert.match(patchSource, /clientRelease\.wires = \[\[ids\.clientHttp\], \[ids\.join\]\]/);
  assert.doesNotMatch(
    fs.readFileSync(`${FN_DIR}/fn_cache_gate_v2.js`, "utf8"),
    /waiters|msg\.req,\s*res|res:\s*msg\.res/,
  );
});

test("all Node-RED v2 function bodies compile in the function-node harness", () => {
  const files = fs.readdirSync(FN_DIR).filter((fileName) => fileName.endsWith("_v2.js"));
  assert.equal(files.length, 8);
  files.forEach((fileName) => {
    const source = fs.readFileSync(`${FN_DIR}/${fileName}`, "utf8");
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", source), fileName);
  });
});
