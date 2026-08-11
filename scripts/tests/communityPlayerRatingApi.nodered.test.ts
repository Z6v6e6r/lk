import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fnDir = "scripts/nodered_community_player_rating_nodes";
const runFunction = (fileName: string, msg: Record<string, unknown>) => {
  const source = fs.readFileSync(path.join(fnDir, fileName), "utf8");
  return new Function("msg", source)(msg);
};

test("builds a snapshot query only for an exact community member ID", () => {
  const prepared = runFunction("fn_community_player_rating_prepare.js", {
    req: {
      params: { communityId: "community-1", playerId: "client-1" },
      query: { tab: "games", period: "30d" },
    },
  });
  const request = prepared[0];
  assert.deepEqual(request.payload, { id: "community-1", archived: { $ne: true } });

  request.payload = [{
    id: "community-1",
    members: [{ id: "internal-row", clientId: "client-1", phone: "+79990000000", name: "Анна" }],
  }];
  const verified = runFunction("fn_community_player_rating_community.js", request);
  assert.equal(verified[1], null);
  assert.equal(verified[0]._communityPlayerRating.snapshotPlayerId, "internal-row");
  assert.deepEqual(verified[0].payload, {
    communityId: "community-1",
    tab: "games",
    period: "30d",
    calculationVersion: "community-rating-v1.3.0",
  });

  const spoofed = { ...request, payload: [{ id: "community-1", members: [{ phone: "client-1", name: "client-1" }] }] };
  const rejected = runFunction("fn_community_player_rating_community.js", spoofed);
  assert.equal(rejected[0], null);
  assert.equal(rejected[1].statusCode, 404);
  assert.equal(rejected[1].payload.error, "PLAYER_NOT_FOUND_IN_COMMUNITY");
});

test("returns a minimal rating payload without member PII", () => {
  const result = runFunction("fn_community_player_rating_response.js", {
    _communityPlayerRating: {
      communityId: "community-1",
      playerId: "client-1",
      snapshotPlayerId: "internal-row",
      tab: "overall",
      period: "all",
    },
    payload: [{
      tab: "overall",
      period: "all",
      updatedAt: "2026-08-11T10:00:00.000Z",
      dataThrough: null,
      sourceVersion: "rating_events+player_rating_state+attendance-v1",
      calculationVersion: "community-rating-v1.3.0",
      rows: [{
        playerId: "internal-row",
        playerName: "Анна Секретная",
        playerPhone: "+79990000000",
        avatarUrl: "https://private.example/avatar",
        rank: 3,
        currentLevel: 4.25,
        levelDelta: 0,
        gamesPlayed: 0,
        gamesWon: 0,
        gamesLost: 0,
        winRate: 0,
        tournamentsPlayed: 0,
        bestPlace: null,
        visitsAttended: 0,
        gamesScore: 0,
        tournamentScore: 0,
        activityScore: 0,
        overallScore: 0,
        totalEventsPlayed: 0,
        lastActivityAt: null,
        badges: ["no_activity"],
      }],
    }],
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.playerId, "client-1");
  assert.equal(result.payload.rating.currentLevel, 4.25);
  assert.deepEqual(result.payload.rating.badges, ["no_activity"]);
  const serialized = JSON.stringify(result.payload);
  assert.doesNotMatch(serialized, /Анна Секретная|79990000000|private\.example|playerName|playerPhone|avatarUrl/);
});

test("fails closed when the snapshot or exact player row is not ready", () => {
  const context = {
    communityId: "community-1",
    playerId: "client-1",
    tab: "overall",
    period: "all",
  };
  const missingSnapshot = runFunction("fn_community_player_rating_response.js", {
    _communityPlayerRating: context,
    payload: [],
  });
  assert.equal(missingSnapshot.statusCode, 503);
  assert.equal(missingSnapshot.payload.error, "RATING_SNAPSHOT_NOT_READY");

  const staleSnapshot = runFunction("fn_community_player_rating_response.js", {
    _communityPlayerRating: context,
    payload: [{ rows: [{ playerId: "another-player" }] }],
  });
  assert.equal(staleSnapshot.statusCode, 503);
  assert.equal(staleSnapshot.payload.error, "PLAYER_RATING_NOT_READY");
});

test("focused patcher adds both routes idempotently to the canonical live tab shape", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "community-player-rating-"));
  const flowPath = path.join(tempDir, "source.flow.json");
  const importPath = path.join(tempDir, "import.json");
  fs.writeFileSync(flowPath, JSON.stringify([
    { id: "tab-1", type: "tab", label: "LK Communities", disabled: false },
    {
      id: "existing-rating-route",
      type: "http in",
      z: "tab-1",
      method: "get",
      url: "/lk/communities/:communityId/rating",
      wires: [],
    },
    {
      id: "existing-community-find",
      type: "mongodb4",
      z: "tab-1",
      collection: "lk_communities",
      clientNode: "mongo-client",
      wires: [],
    },
    {
      id: "existing-snapshot-find",
      type: "mongodb4",
      z: "tab-1",
      collection: "community_rating_snapshots",
      clientNode: "mongo-client",
      wires: [],
    },
    { id: "mongo-client", type: "mongodb4-client", wires: [] },
  ], null, 2));

  execFileSync(process.execPath, [
    "scripts/patch_nodered_community_player_rating_flow.mjs",
    flowPath,
    importPath,
  ]);
  execFileSync(process.execPath, [
    "scripts/patch_nodered_community_player_rating_flow.mjs",
    flowPath,
    importPath,
  ]);

  const patched = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  for (const url of [
    "/lk/communities/:communityId/players/:playerId/rating",
    "/communities/:communityId/players/:playerId/rating",
  ]) {
    assert.equal(patched.filter((node: { url?: string }) => node.url === url).length, 1);
  }
  assert.equal(JSON.parse(fs.readFileSync(importPath, "utf8")).length, 11);
});
