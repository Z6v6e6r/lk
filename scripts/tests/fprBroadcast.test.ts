import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { buildFprNodeFunction } from "../nodered_fpr6x25.mjs";
import { createTournamentBroadcastController } from "../../src/components/tournaments/tournamentBroadcastController.ts";
import { SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID as stationId } from "../../src/components/tournaments/tournamentBroadcast.ts";
import type { TournamentBroadcastState, TournamentBroadcastStateRequest } from "../../src/utils/apiClient.ts";

const tournamentId = "fpr-11111111-2222-4333-8444-555555555555";
const inactive = (extra: Partial<TournamentBroadcastState> = {}): TournamentBroadcastState => ({ tournamentId, stationId, active: false, status: "inactive", ...extra });
type Options = Parameters<typeof createTournamentBroadcastController>[0];
function fixture(overrides: Partial<Options> = {}) {
  const writes: TournamentBroadcastStateRequest[] = [], reads: Array<[string, string | null]> = [];
  let persisted = inactive();
  const controller = createTournamentBroadcastController({
    tournamentId, stationId,
    read: async (id, station) => { reads.push([id, station]); return { data: persisted }; },
    write: async request => {
      writes.push(structuredClone(request));
      persisted = inactive({ active: request.action === "start", status: request.action === "start" ? "active" : "inactive", activeTargets: request.action === "start" ? ["right_arena", "left_arena"] : [] });
      return { data: persisted };
    }, ...overrides,
  });
  return { controller, reads, writes };
}

test("FPR broadcast verifies status, sends only logical screen selectors, and stop never inherits target", async () => {
  const { controller: c, writes } = fixture();
  assert.equal(await c.start("both"), false); assert.equal(writes.length, 0);
  await c.refresh(); assert.equal(c.getSnapshot().verified, true);
  assert.equal(await c.start("both"), true);
  assert.deepEqual(writes[0], { tournamentId, stationId, action: "start", target: "both" });
  assert.equal(c.getSnapshot().active, true);
  assert.equal(await c.stop(), true);
  assert.deepEqual(writes[1], { tournamentId, stationId, action: "stop" });
  assert.equal(c.getSnapshot().needsStop, false);
});

test("screen selection is mandatory only for configured multi-screen stations", async () => {
  const { controller: c, writes } = fixture(); await c.refresh();
  assert.equal(await c.start(), false); assert.equal(writes.length, 0);
  assert.equal(await c.start("unexpected" as "both"), false); assert.equal(writes.length, 0);
  const singleWrites: TournamentBroadcastStateRequest[] = [];
  const singleStation = "a92348a1-1a1a-4b4b-8c8c-d83a3f355932";
  const single = fixture({ stationId: singleStation, read: async () => ({ data: inactive({ stationId: singleStation }) }), write: async request => {
    singleWrites.push(request); return { data: inactive({ stationId: singleStation, active: true, status: "active" }) };
  } }).controller;
  await single.refresh(); assert.equal(await single.start(), true);
  assert.deepEqual(singleWrites, [{ tournamentId, stationId: singleStation, action: "start" }]);
});

test("double click and a simultaneous stop dispatch one device operation", async () => {
  let resolve!: (reply: { data: TournamentBroadcastState }) => void;
  let count = 0;
  const pending = new Promise<{ data: TournamentBroadcastState }>(done => { resolve = done; });
  const c = fixture({ write: async () => { count += 1; return pending; } }).controller;
  await c.refresh(); const first = c.start("both");
  assert.equal(await c.start("both"), false); assert.equal(await c.stop(), false); assert.equal(count, 1);
  resolve({ data: inactive({ active: true, status: "active" }) });
  assert.equal(await first, true); assert.equal(c.getSnapshot().loading, false);
});

test("unconfirmed start plus unavailable status requires explicit stop and never retries start", async () => {
  let reads = 0; const writes: TournamentBroadcastStateRequest[] = [];
  const c = fixture({
    read: async () => { if (++reads > 1) throw new Error("status unavailable"); return { data: inactive() }; },
    write: async request => { writes.push(request); if (request.action === "start") throw new Error("response lost"); return { data: inactive() }; },
  }).controller;
  await c.refresh(); assert.equal(await c.start("both"), false);
  assert.equal(c.getSnapshot().needsStop, true); assert.equal(c.getSnapshot().recoveryRequired, true);
  assert.equal(await c.start("both"), false); assert.equal(writes.length, 1);
  assert.equal(await c.stop(), true); assert.equal(writes.length, 2); assert.equal(writes[1].action, "stop");
});

test("lost start response reconciles actual active state through GET without another POST", async () => {
  let reads = 0, writes = 0;
  const c = fixture({
    read: async () => ({ data: ++reads === 1 ? inactive() : inactive({ active: true, status: "active", activeTargets: ["left_arena"] }) }),
    write: async () => { writes += 1; return { error: { message: "timeout" } }; },
  }).controller;
  await c.refresh(); assert.equal(await c.start("left_arena"), false);
  assert.equal(writes, 1); assert.equal(c.getSnapshot().needsStop, true);
  assert.deepEqual(c.getSnapshot().activeTargets, ["left_arena"]);
  assert.equal(await c.start("right_arena"), false); assert.equal(writes, 1);
});

test("bounded server lease blocks all commands then exposes stop recovery", async () => {
  let clock = Date.parse("2026-10-29T09:00:00Z"), writes = 0;
  const c = fixture({ now: () => clock,
    read: async () => ({ data: inactive({ active: true, status: "starting", operationInProgress: true, operationLeaseUntil: new Date(clock + 1000).toISOString() }) }),
    write: async request => { writes += 1; assert.equal(request.action, "stop"); assert.equal("target" in request, false); return { data: inactive() }; },
  }).controller;
  await c.refresh(); assert.equal(await c.stop(), false); assert.equal(await c.start("both"), false); assert.equal(writes, 0);
  clock += 1001; c.reconcileLease();
  assert.equal(c.getSnapshot().operationInProgress, false); assert.equal(c.getSnapshot().recoveryRequired, true);
  assert.equal(await c.stop(), true); assert.equal(writes, 1);
});

test("disposed view ignores late GET and late POST responses", async () => {
  let resolve!: (reply: { data: TournamentBroadcastState }) => void;
  const pending = new Promise<{ data: TournamentBroadcastState }>(done => { resolve = done; });
  const c = fixture({ read: async () => pending }).controller;
  let updates = 0; c.subscribe(() => { updates += 1; });
  const refresh = c.refresh(); c.dispose(); const before = updates;
  resolve({ data: inactive({ active: true, status: "active" }) }); await refresh;
  assert.equal(updates, before); assert.equal(c.getSnapshot().active, false);
  let finish!: (reply: { data: TournamentBroadcastState }) => void;
  const post = new Promise<{ data: TournamentBroadcastState }>(done => { finish = done; });
  const other = fixture({ write: async () => post }).controller; await other.refresh();
  const command = other.start("both"); other.dispose(); finish({ data: inactive({ active: true, status: "active" }) });
  assert.equal(await command, false); assert.equal(other.getSnapshot().active, false);
});

test("wrong tournament status is rejected and cannot enable start", async () => {
  const { controller: c, writes } = fixture({ read: async () => ({ data: inactive({ tournamentId: "other" }) }) });
  await c.refresh(); assert.equal(c.getSnapshot().verified, false); assert.match(c.getSnapshot().error!, /другого турнира/);
  assert.equal(await c.start("both"), false); assert.equal(writes.length, 0);
});

test("incomplete or inconsistent status cannot turn client station metadata into start authority", async () => {
  for (const data of [
    { tournamentId }, inactive({ stationId: null }), inactive({ stationId: "local-studio:forged" }),
    inactive({ active: false, status: "active" }),
    inactive({ active: true, status: "starting", operationInProgress: true, operationLeaseUntil: "invalid" }),
  ]) {
    const { controller: c, writes } = fixture({ read: async () => ({ data: data as TournamentBroadcastState }) });
    await c.refresh(); assert.equal(c.getSnapshot().verified, false);
    assert.equal(await c.start("both"), false); assert.equal(writes.length, 0);
  }
  const cached = fixture({ initialState: inactive({ active: true, status: "active" }), read: async () => ({ data: { tournamentId } as TournamentBroadcastState }) });
  await cached.controller.refresh();
  assert.equal(cached.controller.getSnapshot().needsStop, true);
  assert.equal(await cached.controller.stop(), true);
});

test("offline mode dispatches no requests; verified server station overrides stale payload station", async () => {
  const offline = fixture({ online: false }); await offline.controller.refresh();
  assert.equal(await offline.controller.start("both"), false); assert.equal(offline.reads.length, 0); assert.equal(offline.writes.length, 0);
  offline.controller.setOnline(true); await offline.controller.refresh(); assert.equal(offline.reads.length, 1);
  const writes: TournamentBroadcastStateRequest[] = [];
  const c = fixture({ stationId: "local-studio:untrusted", read: async (_id, station) => { assert.equal(station, null); return { data: inactive() }; }, write: async request => {
    writes.push(request); return { data: inactive({ active: true, status: "active" }) };
  } }).controller;
  await c.refresh(); assert.equal(await c.start("both"), true); assert.equal(writes[0].stationId, stationId);
});

const legacyRouteSource = fs.readFileSync("scripts/nodered_tournament_broadcast_nodes/fn_tournament_broadcast_route.js", "utf8");
const route = new Function("msg", "env", buildFprNodeFunction(legacyRouteSource, "broadcast_route"));
const deviceEnvironment = { get: (key: string) => ({
  TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test", TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
  CUP_STATION_SETTINGS_JSON: JSON.stringify({ [stationId]: { tournamentBroadcastTargets: { right_arena: "box-right", left_arena: "box-left" } } }),
} as Record<string, string>)[key] };
function routeMessage(action: string, host = false, kind = "fpr_6x25") {
  return { payload: [{ tournamentId, tournamentType: kind, organizer: { id: "organizer" }, params: { stationId } }],
    _tournamentBroadcast: { action, tournamentId, profileId: "organizer", hasHostingAccess: host, requestedStationId: stationId, requestedTarget: action === "start" ? "both" : null } };
}

test("FPR creator metadata, forged claim and source alias cannot grant physical screen start or stop", () => {
  for (const action of ["start", "stop"]) {
    const msg = routeMessage(action);
    Object.assign(msg.payload[0].params, { sourceExerciseId: "pretend-authoritative", broadcast: { stationId, active: true, operationId: "forged-claim" } });
    const result = route(msg, deviceEnvironment);
    assert.equal(result[0], null); assert.equal(result[1], null); assert.equal(result[2].statusCode, 403);
    assert.equal(result[2].payload.code, "FPR_BROADCAST_HOST_ACCESS_REQUIRED");
    assert.equal(result[2].headers["Cache-Control"], "no-store");
  }
});

test("server-authorized tournament host starts the exact FPR ID through the existing claimed dispatch", () => {
  const input = routeMessage("start", true);
  Object.assign(input.payload[0].params, { sourceExerciseId: "different-source-event" });
  const result = route(input, deviceEnvironment);
  const message = Array.isArray(result[0]) ? result[0][0] : result[0];
  assert.ok(message); assert.equal(result[2], null);
  assert.equal(message._tournamentBroadcast.tournamentId, tournamentId);
  assert.equal(message._tournamentBroadcast.action, "start");

  const dispatch = new Function("msg", fs.readFileSync("scripts/nodered_tournament_broadcast_nodes/fn_tournament_broadcast_dispatch.js", "utf8"));
  const prepared = dispatch(structuredClone(message));
  assert.ok(prepared[0]); assert.equal(prepared[1], null); assert.equal(prepared[2], null);
  const claimed = dispatch({ ...prepared[0], payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } });
  assert.equal(claimed[0], null); assert.equal(claimed[2], null);
  assert.equal(claimed[1].length, 2);
  for (const request of claimed[1]) {
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/tournament\/start$/);
    assert.deepEqual(request.payload, { tournament_id: tournamentId });
  }
});

test("staff FPR stop, owner status and ordinary-format ownership use the unchanged legacy route", () => {
  const legacy = new Function("msg", "env", legacyRouteSource);
  for (const input of [routeMessage("stop", true), routeMessage("status"), routeMessage("start", false, "americano_classic")]) {
    const wrapped = route(structuredClone(input), deviceEnvironment), original = legacy(structuredClone(input), deviceEnvironment);
    // Operation IDs, join IDs and timestamps are generated per independent evaluation.
    const sanitize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => {
      if (/operationId|operationLeaseUntil|updatedAt/.test(key)) return "generated";
      if (key === "id" && typeof entry === "string" && new RegExp(`^${tournamentId}:command:\\d+$`).test(entry)) return `${tournamentId}:command:generated`;
      return entry;
    }));
    assert.deepEqual(sanitize(wrapped), sanitize(original));
  }
});
