import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspaceRoot = process.cwd();
const nodeDir = path.join(workspaceRoot, "scripts/nodered_tournament_broadcast_nodes");

function runFunctionNode(
  fileName: string,
  msg: Record<string, unknown>,
  environment: Record<string, string> = {},
) {
  const source = fs.readFileSync(path.join(nodeDir, fileName), "utf8");
  const execute = new Function("msg", "env", source);
  return execute(msg, { get: (key: string) => environment[key] });
}

test("frontend exposes one authenticated tournament broadcast toggle without integration secrets", () => {
  const pageSource = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  const apiSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const combinedSource = `${pageSource}\n${apiSource}`;

  assert.match(pageSource, /Трансляция результатов/);
  assert.match(pageSource, /Остановить трансляцию результатов/);
  assert.match(pageSource, /aria-pressed=\{broadcastActive\}/);
  assert.match(pageSource, /withTournamentStationContext/);
  assert.match(apiSource, /\/lk\/tournaments\/broadcast\/status/);
  assert.match(apiSource, /\/lk\/tournaments\/broadcast\/\$\{payload\.action\}/);
  assert.equal((apiSource.match(/auth: true/g) || []).length > 0, true);
  assert.doesNotMatch(combinedSource, /TOURNAMENT_BROADCAST_BEARER_TOKEN/);
  assert.doesNotMatch(combinedSource, /xS6NpaiysmhVrx4V1J5XlX3RY4a3mNVO/);
});

test("broadcast prepare requires a Viva bearer and fixed tournament command shape", () => {
  const unauthenticated = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: { tournamentId: "tournament-1" },
    req: { params: { action: "start" }, headers: {} },
  });
  assert.equal(unauthenticated[1].statusCode, 401);
  assert.equal(unauthenticated[1].payload.code, "AUTH_TOKEN_REQUIRED");

  const prepared = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: { tournamentId: "tournament-1", stationId: "station-1", boxId: "attacker-box" },
    req: {
      params: { action: "start" },
      headers: { authorization: "Bearer user-token" },
    },
  })[0];
  assert.equal(prepared.method, "GET");
  assert.equal(prepared.url, "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile");
  assert.equal(prepared.headers.Authorization, "Bearer user-token");
  assert.equal(prepared._tournamentBroadcast.tournamentId, "tournament-1");
  assert.equal(prepared._tournamentBroadcast.requestedStationId, "station-1");
  assert.equal(prepared._tournamentBroadcast.boxId, undefined);
});

test("verified Viva profile is reduced to server-side tournament permission context", () => {
  const authorized = runFunctionNode("fn_tournament_broadcast_authorize.js", {
    statusCode: 200,
    payload: {
      id: "manager-1",
      customFields: [{
        id: "e17a32f3-65f7-47c5-bda1-33d79932c884",
        value: ["hosting-option"],
        attributes: { options: [{ id: "hosting-option", name: "Проводит турниры" }] },
      }],
    },
    _tournamentBroadcast: { tournamentId: "tournament-1", action: "start" },
  })[0];
  assert.equal(authorized._tournamentBroadcast.profileId, "manager-1");
  assert.equal(authorized._tournamentBroadcast.hasHostingAccess, true);
  assert.deepEqual(authorized.payload, { tournamentId: "tournament-1" });

  const invalidToken = runFunctionNode("fn_tournament_broadcast_authorize.js", {
    statusCode: 401,
    payload: {},
    _tournamentBroadcast: { tournamentId: "tournament-1" },
  });
  assert.equal(invalidToken[1].payload.code, "AUTH_TOKEN_INVALID");
});

test("broadcast device is resolved from CUP station settings and never from request body", () => {
  const msg = {
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: { stationId: "station-1" },
    }],
    _tournamentBroadcast: {
      action: "start",
      tournamentId: "tournament-1",
      requestedStationId: "station-1",
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
  const result = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    structuredClone(msg),
    {
      CUP_STATION_SETTINGS_JSON: JSON.stringify({
        "station-1": { tournamentBroadcastBoxId: "box-from-cup" },
      }),
      TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test/",
      TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
    },
  );
  const prepared = result[0];
  assert.equal(result[1], null);
  assert.equal(result[2], null);
  assert.equal(
    prepared.url,
    "https://broadcast.example.test/integrations/v1/devices/box-from-cup/tournament/start",
  );
  assert.equal(prepared.headers.Authorization, "Bearer server-only-token");
  assert.deepEqual(prepared.payload, { tournament_id: "tournament-1" });

  const mismatched = structuredClone(msg);
  mismatched._tournamentBroadcast.requestedStationId = "station-attacker";
  const mismatchResult = runFunctionNode("fn_tournament_broadcast_route.js", mismatched);
  assert.equal(mismatchResult[2].statusCode, 409);
  assert.equal(mismatchResult[2].payload.code, "TOURNAMENT_STATION_MISMATCH");
});

test("status and stop use the saved broadcast station when tournament station became synthetic", () => {
  const tournamentId = "tournament-1";
  const stationId = "station-1";
  const environment = {
    CUP_STATION_SETTINGS_JSON: JSON.stringify({
      [stationId]: { tournamentBroadcastBoxId: "box-1" },
    }),
    TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test",
    TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
  };
  const buildMessage = (action: "status" | "stop", requestedStationId: string) => ({
    payload: [{
      tournamentId,
      organizer: { id: "manager-1" },
      params: {
        stationId: `local-studio:${tournamentId}`,
        broadcast: {
          active: true,
          stationId,
          updatedAt: "2026-07-31T16:08:29.940Z",
        },
      },
    }],
    _tournamentBroadcast: {
      action,
      tournamentId,
      requestedStationId,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  });

  const status = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildMessage("status", `local-studio:${tournamentId}`),
    environment,
  );
  assert.equal(status[0], null);
  assert.equal(status[2], null);
  assert.equal(status[1].statusCode, 200);
  assert.equal(status[1].payload.stationId, stationId);
  assert.equal(status[1].payload.active, true);

  const stop = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildMessage("stop", stationId),
    environment,
  );
  assert.equal(stop[1], null);
  assert.equal(stop[2], null);
  assert.match(stop[0].url, /\/devices\/box-1\/tournament\/stop$/);
  assert.equal(stop[0]._tournamentBroadcast.stationId, stationId);
});

test("stop command has no body and successful upstream response is persisted", () => {
  const routed = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    {
      payload: [{
        tournamentId: "tournament-1",
        organizer: { id: "manager-1" },
        params: { stationId: "station-1" },
      }],
      _tournamentBroadcast: {
        action: "stop",
        tournamentId: "tournament-1",
        profileId: "manager-1",
        hasHostingAccess: false,
      },
    },
    {
      CUP_STATION_SETTINGS_JSON: JSON.stringify({ "station-1": "box-1" }),
      TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test",
      TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
    },
  )[0];
  assert.equal(routed.url.endsWith("/tournament/stop"), true);
  assert.equal(routed.payload, undefined);

  routed.statusCode = 204;
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", routed)[0];
  assert.deepEqual(persisted.payload[0], { tournamentId: "tournament-1" });
  assert.equal(persisted.payload[1].$set["params.broadcast"].active, false);
  assert.equal(persisted.payload[1].$set["params.broadcast"].updatedBy, "manager-1");
  assert.deepEqual(persisted.payload[2], { upsert: false, maxTimeMS: 5000 });
});

test("stop is idempotent when the box reports no active tournament session", () => {
  const result = runFunctionNode("fn_tournament_broadcast_persist.js", {
    statusCode: 409,
    payload: { detail: "No active tournament session on this box" },
    _tournamentBroadcast: {
      action: "stop",
      tournamentId: "tournament-1",
      stationId: "station-1",
      profileId: "manager-1",
    },
  });

  assert.equal(result[1], null);
  assert.equal(result[0].payload[1].$set["params.broadcast"].active, false);
});

test("start is idempotent when the box confirms the same state", () => {
  const result = runFunctionNode("fn_tournament_broadcast_persist.js", {
    statusCode: 409,
    payload: { detail: "Same state" },
    _tournamentBroadcast: {
      action: "start",
      tournamentId: "tournament-1",
      stationId: "station-1",
      profileId: "manager-1",
    },
  });

  assert.equal(result[1], null);
  assert.equal(result[0].payload[1].$set["params.broadcast"].active, true);
});

test("scoped test tournament override resolves only its configured test box", () => {
  const baseMessage = {
    payload: [{
      tournamentId: "test-tournament",
      organizer: { id: "manager-1" },
      params: { stationId: "test-station" },
    }],
    _tournamentBroadcast: {
      action: "start",
      tournamentId: "test-tournament",
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
  const environment = {
    TOURNAMENT_BROADCAST_TEST_TOURNAMENT_ID: "test-tournament",
    TOURNAMENT_BROADCAST_TEST_BOX_ID: "test-box",
    TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test",
    TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
  };
  const matched = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    structuredClone(baseMessage),
    environment,
  )[0];
  assert.match(matched.url, /\/devices\/test-box\/tournament\/start$/);

  const otherTournament = structuredClone(baseMessage);
  otherTournament.payload[0].tournamentId = "other-tournament";
  otherTournament._tournamentBroadcast.tournamentId = "other-tournament";
  const rejected = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    otherTournament,
    environment,
  );
  assert.equal(rejected[2].payload.code, "TOURNAMENT_BROADCAST_DEVICE_MISSING");
});

test("status returns only safe broadcast state", () => {
  const result = runFunctionNode("fn_tournament_broadcast_route.js", {
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: {
        stationId: "station-1",
        broadcast: { active: true, updatedAt: "2026-07-19T10:00:00.000Z", boxId: "secret-box" },
      },
    }],
    _tournamentBroadcast: {
      action: "status",
      tournamentId: "tournament-1",
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  });
  assert.equal(result[1].payload.active, true);
  assert.equal(result[1].payload.stationId, "station-1");
  assert.equal(result[1].payload.boxId, undefined);
});

test("broadcast flow patch is idempotent and reuses the live tournament Mongo client", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tournament-broadcast-flow-"));
  const sourcePath = path.join(tempDir, "source.flow.json");
  const importPath = path.join(tempDir, "broadcast.import.json");
  fs.writeFileSync(sourcePath, JSON.stringify([
    { id: "tournaments-tab", type: "tab", label: "LK Tournaments", disabled: false },
    {
      id: "existing-tournament-mongo",
      type: "mongodb4",
      z: "tournaments-tab",
      clientNode: "mongo-client",
      collection: "tournaments",
      operation: "find",
      wires: [[]],
    },
    { id: "mongo-client", type: "mongodb4-client", name: "existing" },
  ]));

  try {
    for (let index = 0; index < 2; index += 1) {
      execFileSync(
        process.execPath,
        ["scripts/patch_nodered_tournament_broadcast_flow.mjs", sourcePath, importPath],
        { cwd: workspaceRoot, stdio: "pipe" },
      );
    }
    const patched = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const routeCount = patched.filter((node: Record<string, unknown>) => (
      node.type === "http in"
      && node.method === "post"
      && node.url === "/lk/tournaments/broadcast/:action"
    )).length;
    const managedMongo = patched.filter((node: Record<string, unknown>) => (
      node.type === "mongodb4"
      && String(node.id || "").startsWith("lk_tournament_broadcast_")
    ));
    assert.equal(routeCount, 1);
    assert.equal(managedMongo.length, 2);
    assert.equal(managedMongo.every((node: Record<string, unknown>) => node.clientNode === "mongo-client"), true);
    assert.ok(fs.existsSync(importPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
