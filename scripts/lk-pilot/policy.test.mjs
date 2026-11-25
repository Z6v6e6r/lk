import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { isPilotPostBodyAllowed, readPilotTarget } from "./policy.mjs";
import { createPilotServer } from "./server.mjs";

const lk = "https://padlhub.su";
const viva = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const quotes = lk + "/lk/subscriptions/game-price-preview";

test("pilot opens the established browse and tariff contracts", () => {
  for (const url of [
    lk + "/lk/games?public=true&limit=20&_ts=1", lk + "/lk/games/123abc", lk + "/api/tournaments/123abc/registration/me",
    lk + "/lk/onboarding/stations", lk + "/api/tournaments?date=2026-11-25",
    viva + "/exercises?date=2026-11-25", viva + "/studios?size=1000",
    "https://api.vivacrm.ru/api/v1/time?timeZone=Europe%2FMoscow",
    viva + "/products/master-services/123abc/price", viva + "/products/master-services/123abc/meta",
    viva + "/products/master-services/123abc/subServices?studioId=123&showAll=true",
    viva + "/products/master-services/123abc/studios",
  ]) assert.ok(readPilotTarget(url, "GET"), url);
  for (const url of [quotes, viva + "/transactions/preview", viva + "/products/master-services/123abc/timeslots"]) {
    assert.ok(readPilotTarget(url, "POST"), url);
  }
});

test("pilot rejects writes, side-effecting reads and unreviewed routes", () => {
  for (const [method, target] of [
    ["POST", lk + "/lk/games/split/cleanup"],
    ["POST", lk + "/lk/games/123abc/split/join"],
    ["GET", lk + "/api/tournaments?refresh=if-stale"],
    ["GET", lk + "/lk/onboarding/stations?includeInactive=true"],
    ["POST", lk + "/lk/onboarding/stations"],
    ["POST", viva + "/products/master-services/123abc/subServices"],
    ["GET", viva + "/products/master-services/123abc/subServices?studioId=123&showAll=false"],
    ["GET", viva.replace("/v1/", "/v2/") + "/products/master-services/123abc/meta"],
    ["GET", lk + "/lk/games/by-phone?phone=70000000000"],
    ["GET", lk + "/lk/games/by-phone"],
    ["GET", lk + "/lk/games?public=true&profileId=someone"],
    ["GET", lk + "/lk/games?public=true&public=false"],
    ["GET", lk + "/lk/games?limit=20"],
    ["GET", lk + "/lk/subscriptions/product?subId=test"],
    ["GET", lk + "/lk/games/123.%2Fxyz"],
    ["GET", "https://unexpected.example/api/tournaments"],
    ["POST", viva + "/transactions"],
    ["POST", viva + "/products/master-services/123abc/pay"],
    ["DELETE", viva + "/bookings/123abc"],
  ]) assert.equal(readPilotTarget(target, method), null, target);
  assert.equal(isPilotPostBodyAllowed(new URL(quotes), { action: "checkout" }), false);
  assert.equal(isPilotPostBodyAllowed(new URL(quotes), { target: { targetKind: "GROUP_TRAINING_RESIDENCY_PURCHASE", exerciseId: "x" } }), false);
  assert.ok(isPilotPostBodyAllowed(new URL(quotes), { target: { targetKind: "GROUP_TRAINING", exerciseId: "x" } }));
});

test("gateway forwards a vetted query once and never follows payment redirects", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lk-pilot-http-"));
  const version = "a".repeat(24);
  await writeFile(path.join(directory, "release.json"), JSON.stringify({ version }));
  const calls = [];
  const pageOrigin = "https://padlhub.ru";
  const server = createPilotServer({ directory, pageOrigin, forward: async (url, init) => {
    calls.push([url.href, init]);
    if (url.pathname.endsWith("/games")) return Response.redirect("https://bank.example/invoice");
    return Response.json({ quotes: [] });
  }});
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const local = `http://127.0.0.1:${server.address().port}`;
  const run = (method, target, body, origin = pageOrigin) => fetch(local + "/lk-pilot-api", {
    method, headers: { origin, "x-lk-pilot-target": target, "content-type": "application/json", authorization: "Bearer fixture" },
    body: body && JSON.stringify(body),
  });

  assert.equal((await run("POST", viva + "/transactions", { value: 1 })).status, 405);
  assert.equal((await run("POST", quotes, { action: "create" })).status, 405);
  assert.equal((await run("GET", lk + "/lk/games", null, "https://unexpected.example")).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await run("POST", quotes, { target: { targetKind: "TOURNAMENT", exerciseId: "fixture" } })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers.authorization, "Bearer fixture");
  assert.equal((await run("GET", lk + "/lk/games?public=true")).status, 502);
  assert.equal(calls[1][1].redirect, "manual");
  assert.equal((await fetch(local + `/lk-pilot/${version}/release.json`)).status, 200);
  assert.equal((await fetch(local + `/lk-pilot/${"b".repeat(24)}/release.json`)).status, 404);
});

test("gateway gives an exact game subscription quote more time and aborts abandoned reads", async (t) => {
  const deadlines = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", ms => {
    deadlines.push(ms);
    return timeout(ms);
  });
  let activate;
  const activated = new Promise(resolve => { activate = resolve; });
  let abort;
  const aborted = new Promise(resolve => { abort = resolve; });
  const pageOrigin = "https://padlhub.ru";
  const server = createPilotServer({ directory: tmpdir(), pageOrigin, forward: async (url, init) => {
    if (url.href === quotes) return Response.json({ quotes: [] });
    activate();
    await new Promise(resolve => init.signal.addEventListener("abort", resolve, { once: true }));
    abort();
    return Response.json({});
  }});
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/lk-pilot-api`;
  const headers = { origin: pageOrigin, "x-lk-pilot-target": quotes, "content-type": "application/json" };
  const response = await fetch(endpoint, { method:"POST", headers, body: JSON.stringify({
    target: { targetKind: "EXISTING_GAME", gameId: "fixture", startsAt: "2026-11-27T12:00:00+03:00", durationMinutes: 120 },
  }) });
  assert.equal(response.status, 200);
  await response.json();
  const request = new AbortController();
  const pending = fetch(endpoint, { signal: request.signal, headers: { ...headers, "x-lk-pilot-target": lk+"/lk/games?public=true" } });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await activated;
  request.abort();
  await Promise.all([rejected, aborted]);
  assert.deepEqual(deadlines, [29_000, 8_000]);
});
