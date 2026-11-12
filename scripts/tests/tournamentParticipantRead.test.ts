import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createTournamentParticipantReader } from "../../src/utils/tournamentParticipantRead.ts";
import type { ApiResult } from "../../src/utils/apiClient.ts";

const success: ApiResult<string[]> = { status: 200, data: ["fixture-player"], error: null };
const busy: ApiResult<string[]> = {
  status: 429, data: null,
  error: { status: 429, message: "Participants refresh is busy", raw: {
    code: "PARTICIPANTS_BUSY_KEY", retryAfterMs: 30_000,
  } },
};
const options = { key: "fixture-origin/exercise/public", isCurrentSession: () => true };

test("concurrent reads share 429 -> fast retry -> success, with no settled cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const read = createTournamentParticipantReader<string[]>();
  let calls = 0;
  const run = async () => ++calls === 1 ? busy : success;
  const first = read({ ...options, run });
  const second = read({ ...options, run });
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(749);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(251);
  await setImmediate();
  assert.deepEqual(await first, success);
  assert.deepEqual(await second, success);
  assert.equal(calls, 2);
  await read({ ...options, run });
  assert.equal(calls, 3);
});

test("persistent busy-key is bounded to four total requests within six seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const read = createTournamentParticipantReader<string[]>();
  let calls = 0;
  const response = read({ ...options, run: async () => { calls += 1; return busy; } });
  for (const delay of [1_000, 1_750, 3_250]) {
    await setImmediate();
    t.mock.timers.tick(delay);
  }
  assert.deepEqual(await response, busy);
  assert.equal(calls, 4);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 4);
});

test("edge/global/unknown429 and auth/provider/transport/idle errors never fast retry", async () => {
  const read = createTournamentParticipantReader<string[]>();
  for (const [status, raw] of [
    [429, { error: "Participants refresh is busy", retryAfterMs: 2_000 }],
    [429, { code: "PARTICIPANTS_BUSY_GLOBAL" }],
    [429, "edge rate limited"],
    [401, { code: "PARTICIPANTS_BUSY_KEY" }],
    [500, { code: "PARTICIPANTS_BUSY_KEY" }],
    [null, new Error("fixture network error")],
    [null, { code: "LK_IDLE_REQUEST_PAUSED" }],
  ] as const) {
    let calls = 0;
    const result: ApiResult<string[]> = { status, data: null, error: { status, raw, message: "fixture" } };
    assert.equal(await read({ ...options, run: async () => { calls += 1; return result; } }), result);
    assert.equal(calls, 1);
  }
});

test("cancelling one subscriber preserves the other, cancelling all aborts transport", async () => {
  const read = createTournamentParticipantReader<string[]>();
  let complete!: (result: ApiResult<string[]>) => void;
  let sharedSignal!: AbortSignal;
  const run = (signal: AbortSignal) => {
    sharedSignal = signal;
    return new Promise<ApiResult<string[]>>((resolve) => { complete = resolve; });
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = read({ ...options, run, signal: firstController.signal });
  const second = read({ ...options, run, signal: secondController.signal });
  firstController.abort();
  assert.equal((await first).status, null);
  assert.equal(sharedSignal.aborted, false);
  complete(success);
  assert.equal(await second, success);

  const third = read({ ...options, run, signal: secondController.signal });
  secondController.abort();
  assert.equal((await third).status, null);
  assert.equal(sharedSignal.aborted, true);
  // A replacement must not attach to an aborted transport that ignores its signal.
  assert.equal(await read({ ...options, run: async () => success }), success);
  complete(success);
});

test("all subscribers closing cancels retry sleep; a new flight has a fresh budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const read = createTournamentParticipantReader<string[]>();
  const controller = new AbortController();
  let calls = 0;
  const request = read({ ...options, signal: controller.signal, run: async () => { calls += 1; return busy; } });
  await setImmediate();
  controller.abort();
  assert.equal((await request).status, null);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(await read({ ...options, run: async () => success }), success);
});

test("already aborted callers do not start requests", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await createTournamentParticipantReader<string[]>()({ ...options, signal: controller.signal,
    run: async () => { calls += 1; return success; } });
  assert.equal(result.status, null);
  assert.equal(calls, 0);
});

test("different origins/exercises/auth sessions do not share and old sessions never receive data", async () => {
  const read = createTournamentParticipantReader<string[]>();
  const completions: Array<(result: ApiResult<string[]>) => void> = [];
  const run = () => new Promise<ApiResult<string[]>>((resolve) => completions.push(resolve));
  let current = true;
  const previous = read({ ...options, key: "fixture/session-a", isCurrentSession: () => current, run });
  const next = read({ ...options, key: "fixture/session-b", run });
  const other = read({ ...options, key: "other-origin/exercise", run });
  assert.equal(completions.length, 3);
  current = false;
  completions.forEach((resolve) => resolve(success));
  assert.equal((await previous).data, null);
  assert.equal(await next, success);
  assert.equal(await other, success);
});

test("session change during retry delay prevents another HTTP attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = true;
  let calls = 0;
  const response = createTournamentParticipantReader<string[]>()({ ...options, isCurrentSession: () => current,
    run: async () => { calls += 1; return busy; } });
  await setImmediate();
  current = false;
  t.mock.timers.tick(1_000);
  assert.equal((await response).data, null);
  assert.equal(calls, 1);
});

test("unexpected transport throws release all subscribers and the flight", async () => {
  const read = createTournamentParticipantReader<string[]>();
  const run = async (): Promise<ApiResult<string[]>> => { throw new Error("fixture"); };
  const results = await Promise.all([read({ ...options, run }), read({ ...options, run })]);
  assert.equal(results.every((result) => result.error && result.data === null), true);
  assert.equal(await read({ ...options, run: async () => success }), success);
});

test("owning Node-RED gate marks only a cold duplicate, preserving owner and global rejection", () => {
  const source = fs.readFileSync("scripts/nodered_tournament_participants_nodes/fn_cache_gate_v2.js", "utf8");
  const gate = new Function("msg", "flow", "global", source);
  const state = { entries: {}, inflight: {} as Record<string, unknown> };
  const flow = { get: () => state, set: () => undefined };
  const global = { get: () => ({}), set: () => undefined };
  const msg = () => ({ req: { query: { exerciseId: "00000000-0000-4000-8000-000000000001" } } });
  const [owner] = gate(msg(), flow, global);
  assert.ok(owner);
  const before = JSON.stringify(state.inflight);
  const [, duplicate] = gate(msg(), flow, global);
  assert.equal(duplicate.statusCode, 429);
  assert.equal(duplicate.payload.code, "PARTICIPANTS_BUSY_KEY");
  assert.equal(JSON.stringify(state.inflight), before);
  state.inflight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    `fixture-other-${i}`, { startedAt: Date.now(), exerciseId: `fixture-other-${i}` },
  ]));
  const [, overloaded] = gate(msg(), flow, global);
  assert.equal(overloaded.headers["x-lk-participants-cache"], "busy-global");
  assert.equal(overloaded.payload.code, undefined);
});
