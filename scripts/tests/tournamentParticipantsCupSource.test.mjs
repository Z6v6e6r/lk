import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { protectRosterTerminal } from "../patch_live_tournament_participants_cup_source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODES = path.join(ROOT, "nodered_tournament_participants_nodes");

function run(file, msg, envValues = {}, globalValues = {}, transform = (source) => source) {
  const source = transform(fs.readFileSync(path.join(NODES, file), "utf8"));
  const context = {
    msg,
    env: { get: (key) => envValues[key] },
    global: { get: (key) => globalValues[key] },
    URL,
    console,
  };
  return vm.runInNewContext(`(function(){ ${source} })()`, context, { filename: file });
}

test("CUP public roster maps to the LK participant contract", () => {
  const msg = {
    statusCode: 200,
    participantResponseSize: 3,
    payload: {
      participants: [
        { id: "cup-1", name: "ЦУП Игрок", levelLabel: "3.25", avatarUrl: "https://example.test/a.png", paymentStatus: "PAID", phone: "fixture-private" },
        { id: "cup-1", name: "Дубль" },
        { id: "cup-2", name: "Второй ЦУП", levelLabel: null, status: "REGISTERED" },
      ],
      waitlist: [{ id: "cup-wait-1", name: "Ожидающий Игрок" }],
    },
  };
  const [out, fallback] = run("fn_cup_roster_normalize_v1.js", msg);
  assert.equal(fallback, null);
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers["x-lk-participants-source"], "cup");
  assert.equal(out.payload.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(out.payload[0])), {
    id: "cup-1",
    spot: 1,
    isCancelled: false,
    client: { id: "cup-1", firstName: "ЦУП", lastName: "Игрок", middleName: null, photo: "https://example.test/a.png" },
    rating: "3.25",
    ratingSource: "cup",
    paymentStatus: "PAID",
    status: "REGISTERED",
  });
  assert.equal(out.payload[1].client.firstName, "Второй");
  assert.equal(out.payload[1].client.lastName, "ЦУП");
  assert.equal(out.payload[1].ratingSource, "cup_unrated");
});

test("CUP roster fills the shared cache before the terminal slices the response", () => {
  const msg = {
    statusCode: 200,
    participantFetchCapacity: 100,
    participantResponseSize: 1,
    payload: { participants: [{ id: "cup-1" }, { id: "cup-2" }] },
  };
  const [out, fallback] = run("fn_cup_roster_normalize_v1.js", msg);
  assert.equal(fallback, null);
  assert.deepEqual(Array.from(out.payload, (item) => item.id), ["cup-1", "cup-2"]);
});

test("CUP public roster failures terminate without revealing a Viva carrier", () => {
  for (const msg of [{ statusCode: 200, payload: { items: [] } }, { statusCode: 503, headers: { "Set-Cookie": "fixture" } }]) {
    const [out, failure] = run("fn_cup_roster_normalize_v1.js", msg);
    assert.equal(out, null);
    assert.equal(failure.statusCode, 502);
    assert.deepEqual(Object.keys(failure.headers), []);
  }
});

test("CUP lookup authorizes Viva fallback only on a legacy roster or the exact snapshot miss", () => {
  const id = "manual-exercise";
  const cases = [
    { statusCode: 200, payload: { source: "VIVA", exerciseId: id }, expected: "fallback" },
    { statusCode: 200, payload: { source: "VIVA", exerciseId: id, linkedCustomTournamentId: "linked" }, expected: "error" },
    { statusCode: 200, payload: { source: "CUSTOM", exerciseId: id, slug: "roster" }, expected: "public" },
    { statusCode: 200, payload: { source: "CUSTOM", exerciseId: "another", slug: "roster" }, expected: "error" },
    { statusCode: 503, payload: { statusCode: 503, error: "Service Unavailable", message: `Persisted tournament snapshot for ${id} is unavailable` }, expected: "fallback" },
    { statusCode: 503, payload: { message: "Tournament read model is temporarily unavailable" }, expected: "error" },
    { statusCode: 404, payload: {}, expected: "error" },
    { error: { code: "ETIMEDOUT" }, expected: "error" },
  ];
  for (const { expected, ...response } of cases) {
    const [request, fallback, failure] = run("fn_cup_public_request_v1.js", {
      ...response, participantCacheExerciseId: id,
    }, { CUP_API_BASE_URL: "http://127.0.0.1:3000/api" });
    assert.equal(request ? "public" : fallback ? "fallback" : "error", expected);
    if (request) assert.equal(request.url, "http://127.0.0.1:3000/api/tournaments/public/roster?format=json");
    if (failure) assert.equal(failure.statusCode, 502);
  }
});

test("Viva fallback uses the validated manual ID after CUP replaces the payload", () => {
  const msg = {
    participantCacheExerciseId: "manual-exercise",
    participantSize: 100,
    payload: { exerciseId: "upstream-id" },
  };
  const [out] = run("fn_cup_viva_fallback_prepare_v1.js", msg, {}, { vivacrm_access_token: "fixture-only" });
  assert.equal(new URL(out.url).pathname, "/api/v1/exercises/manual-exercise/bookings");
  assert.equal(new URL(out.url).searchParams.get("size"), "100");
});

test("participants terminal never forwards upstream authorization or cookies", () => {
  const msg = {
    participantCacheSkipTerminalState: true,
    headers: { Authorization: "fixture-only", "Set-Cookie": "fixture", "x-lk-participants-cache": "hit" },
  };
  const out = run("fn_terminal_v2.js", msg, {}, {}, protectRosterTerminal);
  assert.deepEqual(Object.keys(out.headers), ["x-lk-participants-cache"]);
});

test("CUP lookup validates a local CUP base and builds the tournament URL", () => {
  const msg = { req: { query: { exerciseId: "11111111-1111-4111-8111-111111111111" } } };
  const [out] = run("fn_cup_lookup_request_v1.js", msg, { CUP_API_BASE_URL: "http://127.0.0.1:3000/api" });
  assert.equal(out.method, "GET");
  assert.equal(out.url, "http://127.0.0.1:3000/api/tournaments/11111111-1111-4111-8111-111111111111");
  assert.deepEqual(JSON.parse(JSON.stringify(out.headers)), { Accept: "application/json" });
});

test("CUP lookup rejects an untrusted base before any request", () => {
  const msg = { req: { query: { exerciseId: "11111111-1111-4111-8111-111111111111" } } };
  const [out, error] = run("fn_cup_lookup_request_v1.js", msg, { CUP_API_BASE_URL: "http://example.com/api" });
  assert.equal(out, null);
  assert.equal(error.statusCode, 503);
  assert.equal(error.payload.error, "CUP_API_BASE_URL invalid");
});
