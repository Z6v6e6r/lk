import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { createTournamentParticipantReader } from "../../src/utils/tournamentParticipantRead.ts";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const start = source.indexOf("const readTournamentParticipants = ");
const body = source.slice(start, source.indexOf("export type TournamentParticipantsRefreshReason", start));
const compiled = ts.transpileModule(body.replace("export async", "async"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const createApi = new Function("request", "getServ2Origin", "readAuthToken", "createTournamentParticipantReader",
  "sanitizeTournamentParticipantsPayload", `${compiled}; return apiFetchTournamentParticipants;`);
const ok = { status: 200, error: null, data: [{ fixture: "raw" }] };

test("actual API adapter coalesces concurrent 429 -> success with no generic retries or header exposure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gateSource = fs.readFileSync("scripts/nodered_tournament_participants_nodes/fn_cache_gate_v2.js", "utf8");
  const terminalSource = fs.readFileSync("scripts/nodered_tournament_participants_nodes/fn_terminal_v2.js", "utf8");
  const gate = new Function("msg", "flow", "global", gateSource);
  const terminal = new Function("msg", "flow", "global", terminalSource);
  const values = new Map();
  const flow = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  const global = { get: () => ({}), set: () => undefined };
  const exerciseId = "00000000-0000-4000-8000-000000000001";
  const msg = () => ({ req: { query: { exerciseId } } });
  const [owner] = gate(msg(), flow, global);
  const calls = [];
  let sanitized = 0;
  const api = createApi(async (url, options) => {
    calls.push({ url, options });
    const [, response] = gate(msg(), flow, global);
    assert.ok(response, "duplicate and cache hit must never enter Viva owner output");
    if (calls.length === 1) {
      assert.equal(response.statusCode, 429);
      // The already admitted owner finishes; next poll should read the shared cache.
      owner.statusCode = 200;
      owner.payload = [{ id: "fixture-booking", client: { firstName: "Fixture" } }];
      terminal(owner, flow, global);
    }
    return response.statusCode === 429
      ? { status: 429, data: null, error: { status: 429, raw: response.payload, message: response.payload.error } }
      : { status: response.statusCode, data: response.payload, error: null };
  }, () => "https://fixture.invalid", () => "fixture-session", createTournamentParticipantReader,
  (data) => { sanitized += 1; return data.map((item) => ({ ...item, sanitized: true })); });
  const a = api(exerciseId, { retries: 0 });
  const b = api(exerciseId, { retries: 0 });
  await setImmediate();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1_000);
  const results = await Promise.all([a, b]);
  assert.equal(calls.length, 2);
  assert.equal(sanitized, 2);
  assert.equal(results.every((result) => result.status === 200 && result.data[0].sanitized), true);
  assert.notEqual(results[0].data, results[1].data);
  for (const { options } of calls) {
    assert.equal(options.retries, 0);
    assert.equal(options.auth, true);
    assert.equal(options.method, "GET");
  }
  assert.deepEqual(values.get("lkTournamentParticipantResponseCacheV2").inflight, {});
});

test("raw booking-verification reads bypass coalescing and preserve caller retry policy", async () => {
  const calls = [];
  const api = createApi(async (url, options) => { calls.push({ url, options }); return ok; },
    () => "https://fixture.invalid", () => "fixture-session", createTournamentParticipantReader,
    () => { throw new Error("raw verification must not be sanitized"); });
  const results = await Promise.all([
    api("fixture/id?value", { sanitize: false, retries: 0 }),
    api("fixture/id?value", { sanitize: false, retries: 0 }),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(results.every((result) => result.data === ok.data), true);
  assert.equal(calls[0].options.retries, 0);
  assert.match(calls[0].url, /exerciseId=fixture%2Fid%3Fvalue$/);
});

test("adapter isolates origins, public/authenticated reads and full sessions", async () => {
  let base = "https://one.invalid";
  let token = "fixture-session-a";
  const completions = [];
  const api = createApi(() => new Promise((resolve) => completions.push(resolve)), () => base, () => token,
    createTournamentParticipantReader, (data) => data);
  const a = api("exercise");
  const publicRead = api("exercise", { auth: false });
  token = "fixture-session-b";
  const b = api("exercise");
  base = "https://two.invalid";
  const otherOrigin = api("exercise");
  assert.equal(completions.length, 4);
  completions.forEach((resolve) => resolve(ok));
  assert.equal((await a).data, null);
  assert.equal((await publicRead).data, ok.data);
  assert.equal((await b).data, ok.data);
  assert.equal((await otherOrigin).data, ok.data);
});

test("adapter fresh option waits for an old ordinary transport before returning a new snapshot", async () => {
  const completions = [];
  const api = createApi(() => new Promise((resolve) => completions.push(resolve)),
    () => "https://fixture.invalid", () => "fixture-session", createTournamentParticipantReader, data => data);
  const old = api("exercise", { auth: false });
  const fresh = api("exercise", { auth: false, fresh: true });
  assert.equal(completions.length, 1);
  completions[0]({ ...ok, data: ["old"] });await old;await setImmediate();
  assert.equal(completions.length, 2);
  completions[1](ok);assert.equal((await fresh).data, ok.data);
});
