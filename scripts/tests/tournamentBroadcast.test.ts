import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatTournamentBroadcastTargets,
  getTournamentBroadcastTargetOptions,
  isTournamentBroadcastTargetSelectionStation,
  isSkolkovoTournamentBroadcastStation,
  NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
  NAGATINSKAYA_TOURNAMENT_BROADCAST_TARGET_OPTIONS,
  normalizeTournamentBroadcastTargets,
  resolveTournamentBroadcastStationId,
  SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
  TOURNAMENT_BROADCAST_TARGET_OPTIONS,
} from "../../src/components/tournaments/tournamentBroadcast.ts";

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

function getOutputMessagesAt(result: unknown, outputIndex: number): Array<Record<string, unknown>> {
  const outputs = Array.isArray(result) ? result : [];
  const output = outputs[outputIndex];
  if (Array.isArray(output)) return output as Array<Record<string, unknown>>;
  if (output && typeof output === "object") return [output as Record<string, unknown>];
  return [];
}

function dispatchRouteToDeviceRequests(routeResult: unknown) {
  return getOutputMessagesAt(routeResult, 0).flatMap((message) => getOutputMessagesAt(
    runFunctionNode(
      "fn_tournament_broadcast_dispatch.js",
      structuredClone(message),
    ),
    1,
  ));
}

function assertDeviceRequestTimeouts(requests: Array<Record<string, unknown>>) {
  assert.ok(requests.length > 0);
  assert.equal(requests.every((request) => request.requestTimeout === 20000), true);
}

type DeviceOutcome = {
  statusCode: number;
  payload?: Record<string, unknown>;
  error?: { message: string };
};

function aggregateDeviceOutcomes(
  requests: Array<Record<string, unknown>>,
  outcomes: DeviceOutcome[],
) {
  assert.equal(requests.length, outcomes.length);
  const normalized = requests.map((request, index) => runFunctionNode(
    "fn_tournament_broadcast_result.js",
    {
      ...structuredClone(request),
      statusCode: outcomes[index].statusCode,
      payload: outcomes[index].payload ?? {},
      ...(outcomes[index].error ? { error: outcomes[index].error } : {}),
    },
  ) as Record<string, unknown>);
  const joined = {
    ...normalized[0],
    payload: normalized.map((item) => item.payload),
  };
  return runFunctionNode("fn_tournament_broadcast_aggregate.js", joined);
}

const integrationEnvironment = {
  TOURNAMENT_BROADCAST_API_BASE_URL: "https://broadcast.example.test",
  TOURNAMENT_BROADCAST_BEARER_TOKEN: "server-only-token",
};

const skolkovoEnvironment = {
  ...integrationEnvironment,
  CUP_STATION_SETTINGS_JSON: JSON.stringify({
    [SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID]: {
      tournamentBroadcastTargets: {
        right_arena: "box-right",
        left_arena: { boxId: "box-left" },
      },
    },
  }),
};

const nagatinskayaEnvironment = {
  ...integrationEnvironment,
  CUP_STATION_SETTINGS_JSON: JSON.stringify({
    [NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID]: {
      tournamentBroadcastTargets: {
        right_arena: "box-court-1",
        left_arena: { boxId: "box-court-7" },
      },
    },
  }),
};

function buildSkolkovoRouteMessage(
  action: "start" | "stop" | "status",
  requestedTarget?: "right_arena" | "left_arena" | "both",
  broadcast: Record<string, unknown> = {},
) {
  return {
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: {
        stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
        broadcast,
      },
    }],
    _tournamentBroadcast: {
      action,
      tournamentId: "tournament-1",
      requestedStationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      requestedTarget: requestedTarget ?? null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
}

function buildNagatinskayaRouteMessage(
  action: "start" | "stop" | "status",
  requestedTarget?: "right_arena" | "left_arena" | "both",
  broadcast: Record<string, unknown> = {},
) {
  return {
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: {
        stationId: NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
        broadcast,
      },
    }],
    _tournamentBroadcast: {
      action,
      tournamentId: "tournament-1",
      requestedStationId: NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
      requestedTarget: requestedTarget ?? null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
}

type SkolkovoBroadcastTarget = "right_arena" | "left_arena" | "both";

function prepareSkolkovoStartClaim(
  target: SkolkovoBroadcastTarget,
  broadcast: Record<string, unknown> = {},
  tournamentFields: Record<string, unknown> = {},
) {
  const routeMessage = buildSkolkovoRouteMessage("start", target, broadcast);
  Object.assign(routeMessage.payload[0], tournamentFields);
  const routeResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    routeMessage,
    skolkovoEnvironment,
  );
  const routed = getOutputMessagesAt(routeResult, 0);
  assert.equal(routed.length, 1);
  const dispatchResult = runFunctionNode(
    "fn_tournament_broadcast_dispatch.js",
    structuredClone(routed[0]),
  );
  const claimMessages = getOutputMessagesAt(dispatchResult, 0);
  assert.equal(claimMessages.length, 1);
  assert.deepEqual(getOutputMessagesAt(dispatchResult, 1), []);
  assert.deepEqual(getOutputMessagesAt(dispatchResult, 2), []);
  return {
    routeResult,
    claimMessage: claimMessages[0],
  };
}

function resolveSkolkovoStartClaim(
  claimMessage: Record<string, unknown>,
  mongoResult: unknown = { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
) {
  return runFunctionNode("fn_tournament_broadcast_dispatch.js", {
    ...structuredClone(claimMessage),
    payload: structuredClone(mongoResult),
  });
}

function claimSkolkovoRouteResult(
  routeResult: unknown,
  mongoResult: unknown = { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
) {
  const routed = getOutputMessagesAt(routeResult, 0);
  assert.equal(routed.length, 1);
  const claimPreparation = runFunctionNode(
    "fn_tournament_broadcast_dispatch.js",
    structuredClone(routed[0]),
  );
  const claimMessages = getOutputMessagesAt(claimPreparation, 0);
  assert.equal(claimMessages.length, 1);
  const claimResult = resolveSkolkovoStartClaim(claimMessages[0], mongoResult);
  return {
    claimMessage: claimMessages[0],
    claimResult,
    requests: getOutputMessagesAt(claimResult, 1),
    errors: getOutputMessagesAt(claimResult, 2),
  };
}

function buildClaimedSkolkovoStartRequests(
  target: SkolkovoBroadcastTarget,
  broadcast: Record<string, unknown> = {},
  tournamentFields: Record<string, unknown> = {},
) {
  const prepared = prepareSkolkovoStartClaim(target, broadcast, tournamentFields);
  const claimResult = resolveSkolkovoStartClaim(prepared.claimMessage);
  const requests = getOutputMessagesAt(claimResult, 1);
  assert.equal(getOutputMessagesAt(claimResult, 0).length, 0);
  assert.equal(getOutputMessagesAt(claimResult, 2).length, 0);
  return {
    ...prepared,
    claimResult,
    requests,
  };
}

test("frontend exposes station-specific screen selectors without integration secrets or device addressing", () => {
  const pageSource = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  const apiSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const combinedSource = `${pageSource}\n${apiSource}`;

  assert.match(pageSource, /Трансляция результатов/);
  assert.match(pageSource, /Остановить трансляцию результатов/);
  assert.match(pageSource, /Где запустить трансляцию\?/);
  assert.match(pageSource, /setBroadcastSelectedTarget\(null\)/);
  assert.match(pageSource, /disabled=\{!broadcastSelectedTarget \|\| broadcastLoading \|\| !isOnline\}/);
  assert.match(pageSource, /isTournamentBroadcastTargetSelectionStation\(broadcastStationId\)/);
  assert.match(pageSource, /getTournamentBroadcastTargetOptions\(broadcastStationId\)/);
  assert.match(pageSource, /aria-pressed=\{broadcastActive\}/);
  assert.match(pageSource, /withTournamentStationContext/);
  assert.match(apiSource, /\/lk\/tournaments\/broadcast\/status/);
  assert.match(apiSource, /\/lk\/tournaments\/broadcast\/\$\{payload\.action\}/);
  assert.match(apiSource, /target: payload\.target/);
  assert.match(apiSource, /"starting" \| "stopping"/);
  assert.match(apiSource, /operationInProgress\?: boolean/);
  assert.match(apiSource, /operationLeaseUntil\?: string \| null/);
  assert.match(apiSource, /recoveryRequired\?: boolean/);
  assert.match(pageSource, /applyBroadcastServerState/);
  assert.match(pageSource, /status === "starting"/);
  assert.match(pageSource, /broadcastRecoveryRequired/);
  assert.equal((pageSource.match(/apiFetchTournamentBroadcastState\(data\.tournamentId, stationId\)/g) || []).length >= 3, true);
  assert.equal((apiSource.match(/auth: true/g) || []).length > 0, true);
  assert.doesNotMatch(combinedSource, /TOURNAMENT_BROADCAST_BEARER_TOKEN/);
  assert.doesNotMatch(combinedSource, /integrations\/v1\/devices/);
  assert.doesNotMatch(combinedSource, /\bboxId\b/);
});

test("frontend uses the server station for active recovery and current station for the next inactive start", () => {
  assert.equal(
    resolveTournamentBroadcastStationId(
      NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
      "",
      true,
    ),
    NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
  );
  assert.equal(
    resolveTournamentBroadcastStationId(null, SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID),
    SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
  );
  assert.equal(
    resolveTournamentBroadcastStationId(
      SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
      false,
    ),
    NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
  );
  assert.equal(
    resolveTournamentBroadcastStationId(
      SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
      true,
    ),
    SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
  );
  assert.equal(
    resolveTournamentBroadcastStationId(
      SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      "local-studio:legacy",
      false,
    ),
    SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
  );

  const pageSource = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  assert.match(pageSource, /setBroadcastServerStationId\(String\(state\.stationId/);
  assert.match(
    pageSource,
    /const broadcastStationId = resolveTournamentBroadcastStationId\([\s\S]*?broadcastServerStationId,[\s\S]*?tournamentParams\.stationId,[\s\S]*?broadcastActive/,
  );
  assert.match(pageSource, /const stationId = broadcastStationId \|\| null/);
  assert.match(pageSource, /isTournamentBroadcastTargetSelectionStation\(broadcastStationId\)/);
});

test("frontend fences stale broadcast status reads and preserves transition leases from persisted state", () => {
  const pageSource = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  const statusFetchIndex = pageSource.indexOf(
    "void apiFetchTournamentBroadcastState(data.tournamentId, stationId).then",
  );
  const staleStatusGuardIndex = pageSource.indexOf(
    "requestGeneration !== broadcastRequestGenerationRef.current",
    statusFetchIndex,
  );
  const statusApplyIndex = pageSource.indexOf(
    "applyBroadcastServerState(result.data)",
    staleStatusGuardIndex,
  );
  const mutationIndex = pageSource.indexOf("const handleSetTournamentBroadcast = async");
  const mutationGenerationIndex = pageSource.indexOf(
    "const requestGeneration = broadcastRequestGenerationRef.current + 1",
    mutationIndex,
  );
  const mutationRequestIndex = pageSource.indexOf("await apiSetTournamentBroadcastState", mutationIndex);

  assert.equal(statusFetchIndex >= 0, true);
  assert.equal(staleStatusGuardIndex > statusFetchIndex, true);
  assert.equal(statusApplyIndex > staleStatusGuardIndex, true);
  assert.equal(mutationGenerationIndex > mutationIndex, true);
  assert.equal(mutationRequestIndex > mutationGenerationIndex, true);
  assert.match(
    pageSource,
    /operationInProgress: typeof savedBroadcastState\?\.operationInProgress === "boolean"/,
  );
});

test("Skolkovo broadcast selector exposes only ordered server-safe targets", () => {
  assert.equal(
    isSkolkovoTournamentBroadcastStation(SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID),
    true,
  );
  assert.equal(isSkolkovoTournamentBroadcastStation("0d5504f6-ea6f-44bb-a9e4-947faf0273ac"), false);
  assert.equal(isSkolkovoTournamentBroadcastStation("Сколково"), false);
  assert.deepEqual(
    TOURNAMENT_BROADCAST_TARGET_OPTIONS.map((option) => [option.value, option.label]),
    [
      ["right_arena", "Правый манеж"],
      ["left_arena", "Левый манеж"],
      ["both", "Оба"],
    ],
  );
  assert.deepEqual(
    normalizeTournamentBroadcastTargets(["left_arena", "both", "unknown", "right_arena", "left_arena"]),
    ["right_arena", "left_arena"],
  );
  assert.equal(
    formatTournamentBroadcastTargets(["left_arena", "right_arena"]),
    "Правый манеж, Левый манеж",
  );
});

test("Nagatinskaya uses court 1, court 7 and both-screen labels with the same safe target values", () => {
  assert.equal(
    isTournamentBroadcastTargetSelectionStation(NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID),
    true,
  );
  assert.deepEqual(
    getTournamentBroadcastTargetOptions(NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID),
    NAGATINSKAYA_TOURNAMENT_BROADCAST_TARGET_OPTIONS,
  );
  assert.deepEqual(
    NAGATINSKAYA_TOURNAMENT_BROADCAST_TARGET_OPTIONS.map((option) => [option.value, option.label]),
    [
      ["right_arena", "Экран Корт №1"],
      ["left_arena", "Экран Корт №7"],
      ["both", "Оба экрана"],
    ],
  );
  assert.equal(
    formatTournamentBroadcastTargets(
      ["right_arena", "left_arena"],
      NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
    ),
    "Экран Корт №1, Экран Корт №7",
  );
});

test("broadcast prepare requires Viva auth and accepts only a start target", () => {
  const unauthenticated = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: { tournamentId: "tournament-1" },
    req: { params: { action: "start" }, headers: {} },
  });
  assert.equal(unauthenticated[1].statusCode, 401);
  assert.equal(unauthenticated[1].payload.code, "AUTH_TOKEN_REQUIRED");

  const prepared = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: {
      tournamentId: "tournament-1",
      stationId: "station-1",
      target: "right_arena",
      boxId: "attacker-box",
    },
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
  assert.equal(prepared._tournamentBroadcast.requestedTarget, "right_arena");
  assert.equal(prepared._tournamentBroadcast.boxId, undefined);

  const invalidTarget = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: { tournamentId: "tournament-1", target: "attacker-box" },
    req: {
      params: { action: "start" },
      headers: { authorization: "Bearer user-token" },
    },
  });
  assert.equal(invalidTarget[1].payload.code, "BROADCAST_TARGET_INVALID");

  const stopTarget = runFunctionNode("fn_tournament_broadcast_prepare.js", {
    payload: { tournamentId: "tournament-1", target: "both" },
    req: {
      params: { action: "stop" },
      headers: { authorization: "Bearer user-token" },
    },
  });
  assert.equal(stopTarget[1].payload.code, "BROADCAST_TARGET_NOT_ALLOWED");
});

test("broadcast prepare rejects malformed actions and identifiers before any upstream call", () => {
  const cases = [
    {
      msg: {
        payload: { tournamentId: "tournament-1" },
        req: {
          params: { action: "restart" },
          headers: { authorization: "Bearer user-token" },
        },
      },
      code: "BROADCAST_ACTION_INVALID",
    },
    {
      msg: {
        payload: { tournamentId: "../tournament-1" },
        req: {
          params: { action: "start" },
          headers: { authorization: "Bearer user-token" },
        },
      },
      code: "TOURNAMENT_ID_INVALID",
    },
    {
      msg: {
        payload: { tournamentId: "tournament-1", stationId: "station/attacker" },
        req: {
          params: { action: "start" },
          headers: { authorization: "Bearer user-token" },
        },
      },
      code: "STATION_ID_INVALID",
    },
    {
      msg: {
        payload: { tournamentId: "tournament-1", target: "both" },
        req: {
          params: { action: "status" },
          headers: { authorization: "Bearer user-token" },
        },
      },
      code: "BROADCAST_TARGET_NOT_ALLOWED",
    },
  ];

  cases.forEach(({ msg, code }) => {
    const result = runFunctionNode("fn_tournament_broadcast_prepare.js", msg);
    assert.equal(result[0], null);
    assert.equal(result[1].statusCode, 400);
    assert.equal(result[1].payload.code, code);
    assert.equal(result[1].url, undefined);
    assert.equal(result[1]._tournamentBroadcast, undefined);
  });
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

test("legacy single-box stations keep their existing no-target contract", () => {
  const message = {
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: { stationId: "station-1" },
    }],
    _tournamentBroadcast: {
      action: "start",
      tournamentId: "tournament-1",
      requestedStationId: "station-1",
      requestedTarget: null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
  const result = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    structuredClone(message),
    {
      ...integrationEnvironment,
      CUP_STATION_SETTINGS_JSON: JSON.stringify({
        "station-1": { tournamentBroadcastBoxId: "box-from-cup" },
      }),
    },
  );
  const requests = dispatchRouteToDeviceRequests(result);
  assert.equal(requests.length, 1);
  assertDeviceRequestTimeouts(requests);
  assert.equal(
    requests[0].url,
    "https://broadcast.example.test/integrations/v1/devices/box-from-cup/tournament/start",
  );
  assert.deepEqual(requests[0].payload, { tournament_id: "tournament-1" });

  const mismatched = structuredClone(message);
  mismatched._tournamentBroadcast.requestedStationId = "station-attacker";
  const mismatchResult = runFunctionNode("fn_tournament_broadcast_route.js", mismatched);
  assert.equal(mismatchResult[2].payload.code, "TOURNAMENT_STATION_MISMATCH");
});

test("legacy single-box start and stop still complete through aggregate and persistence", () => {
  const environment = {
    ...integrationEnvironment,
    CUP_STATION_SETTINGS_JSON: JSON.stringify({
      "station-1": { tournamentBroadcastBoxId: "legacy-box" },
    }),
  };
  const buildMessage = (action: "start" | "stop", broadcast: Record<string, unknown> = {}) => ({
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: { stationId: "station-1", broadcast },
    }],
    _tournamentBroadcast: {
      action,
      tournamentId: "tournament-1",
      requestedStationId: "station-1",
      requestedTarget: null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  });

  const startRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildMessage("start"),
    environment,
  );
  const startRequests = dispatchRouteToDeviceRequests(startRoute);
  assert.equal(startRequests.length, 1);
  const started = aggregateDeviceOutcomes(startRequests, [
    { statusCode: 409, payload: { detail: "Same state" } },
  ]);
  const startPersist = runFunctionNode("fn_tournament_broadcast_persist.js", started[0])[0];
  const activeState = startPersist.payload[1].$set["params.broadcast"];
  assert.equal(activeState.active, true);
  assert.equal(activeState.status, "active");
  assert.equal(activeState.requestedTarget, null);
  assert.deepEqual(activeState.activeTargets, []);
  assert.doesNotMatch(JSON.stringify(activeState), /legacy-box|server-only-token/);

  const stopRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildMessage("stop", activeState),
    environment,
  );
  const stopRequests = dispatchRouteToDeviceRequests(stopRoute);
  assert.equal(stopRequests.length, 1);
  assert.equal(stopRequests[0].payload, undefined);
  const stopped = aggregateDeviceOutcomes(stopRequests, [
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  const stopPersist = runFunctionNode("fn_tournament_broadcast_persist.js", stopped[0])[0];
  const inactiveState = stopPersist.payload[1].$set["params.broadcast"];
  assert.equal(inactiveState.active, false);
  assert.equal(inactiveState.status, "inactive");
  assert.equal(inactiveState.requestedTarget, null);
  assert.deepEqual(inactiveState.activeTargets, []);
});

test("broadcast routing requires either exact organizer identity or verified hosting access", () => {
  const forbiddenMessage = buildSkolkovoRouteMessage("start", "right_arena");
  forbiddenMessage._tournamentBroadcast.profileId = "attacker-profile";
  const forbidden = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    forbiddenMessage,
    skolkovoEnvironment,
  );
  assert.equal(forbidden[0], null);
  assert.equal(forbidden[1], null);
  assert.equal(forbidden[2].statusCode, 403);
  assert.equal(forbidden[2].payload.code, "TOURNAMENT_BROADCAST_FORBIDDEN");

  const hostingMessage = buildSkolkovoRouteMessage("start", "right_arena");
  hostingMessage._tournamentBroadcast.profileId = "verified-host";
  hostingMessage._tournamentBroadcast.hasHostingAccess = true;
  const hostingRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    hostingMessage,
    skolkovoEnvironment,
  );
  const hostingRequests = claimSkolkovoRouteResult(hostingRoute).requests;
  assert.equal(hostingRequests.length, 1);
  assert.match(String(hostingRequests[0].url), /\/devices\/box-right\/tournament\/start$/);
});

test("multi-target mode is fail-closed to the saved Skolkovo station ID", () => {
  const missingTarget = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("start"),
    skolkovoEnvironment,
  );
  assert.equal(missingTarget[2].payload.code, "BROADCAST_TARGET_REQUIRED");

  const nameSpoof = buildSkolkovoRouteMessage("start", "right_arena");
  nameSpoof.payload[0].params.stationId = "station-1";
  nameSpoof.payload[0].params.stationName = "Сколково";
  nameSpoof._tournamentBroadcast.requestedStationId = "station-1";
  const spoofResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    nameSpoof,
    skolkovoEnvironment,
  );
  assert.equal(spoofResult[2].payload.code, "BROADCAST_TARGET_NOT_ALLOWED");

  const requestSpoof = buildSkolkovoRouteMessage("start", "both");
  requestSpoof.payload[0].params.stationId = "station-1";
  const requestSpoofResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    requestSpoof,
    skolkovoEnvironment,
  );
  assert.equal(requestSpoofResult[2].payload.code, "TOURNAMENT_STATION_MISMATCH");
});

test("inactive status and the next start follow the tournament after a station change", () => {
  const inactiveOldStation = {
    active: false,
    status: "inactive",
    stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    updatedAt: "2026-08-04T10:00:00.000Z",
  };
  const statusResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildNagatinskayaRouteMessage("status", undefined, inactiveOldStation),
    nagatinskayaEnvironment,
  );
  const statusRequests = dispatchRouteToDeviceRequests(statusResult);
  assert.deepEqual(
    statusRequests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-court-1", "box-court-7"],
  );
  assert.equal(
    statusRequests.every((request) => (
      (request._tournamentBroadcast as Record<string, unknown>).stationId
        === NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID
    )),
    true,
  );

  const startResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildNagatinskayaRouteMessage("start", "right_arena", inactiveOldStation),
    nagatinskayaEnvironment,
  );
  const routedStarts = getOutputMessagesAt(startResult, 0);
  assert.equal(routedStarts.length, 1);
  assert.deepEqual(getOutputMessagesAt(startResult, 2), []);
  assert.equal(
    (routedStarts[0]._tournamentBroadcast as Record<string, unknown>).stationId,
    NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID,
  );
});

test("an already-active Skolkovo broadcast must be stopped before any new target start", () => {
  (["right_arena", "left_arena", "both"] as const).forEach((target) => {
    const result = runFunctionNode(
      "fn_tournament_broadcast_route.js",
      buildSkolkovoRouteMessage("start", target, {
        active: true,
        status: "active",
        stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
        requestedTarget: "right_arena",
        activeTargets: ["right_arena"],
      }),
      skolkovoEnvironment,
    );
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2].statusCode, 409);
    assert.equal(result[2].payload.code, "BROADCAST_ALREADY_ACTIVE");
    assert.doesNotMatch(JSON.stringify(result[2].payload), /box-right|box-left|server-only-token/);
  });
});

test("two concurrent Skolkovo claims fan out only for the atomic winner", () => {
  const first = prepareSkolkovoStartClaim("both", {}, { _id: "mongo-tournament-1" });
  const second = prepareSkolkovoStartClaim("both", {}, { _id: "mongo-tournament-1" });
  const firstContext = first.claimMessage._tournamentBroadcast as Record<string, unknown>;
  const secondContext = second.claimMessage._tournamentBroadcast as Record<string, unknown>;
  assert.notEqual(firstContext.operationId, secondContext.operationId);

  const claimArgs = first.claimMessage.payload as Array<Record<string, unknown>>;
  assert.deepEqual(claimArgs[0], {
    tournamentId: "tournament-1",
    _id: "mongo-tournament-1",
    "params.stationId": SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    "params.broadcast.active": { $ne: true },
    "params.broadcast.status": { $nin: ["starting", "stopping"] },
  });
  const claimSet = (claimArgs[1].$set || {}) as Record<string, unknown>;
  const claimBroadcast = (claimSet["params.broadcast"] || {}) as Record<string, unknown>;
  assert.equal(claimBroadcast.active, true);
  assert.equal(claimBroadcast.status, "starting");
  assert.equal(
    claimBroadcast.operationId,
    firstContext.operationId,
  );
  assert.deepEqual(
    claimBroadcast.activeTargets,
    ["right_arena", "left_arena"],
  );

  const winner = resolveSkolkovoStartClaim(first.claimMessage, {
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
  });
  const loser = resolveSkolkovoStartClaim(second.claimMessage, {
    acknowledged: true,
    matchedCount: 0,
    modifiedCount: 0,
  });
  const winnerRequests = getOutputMessagesAt(winner, 1);
  assert.equal(winnerRequests.length, 2);
  assert.deepEqual(
    winnerRequests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-right", "box-left"],
  );
  assert.deepEqual(getOutputMessagesAt(loser, 0), []);
  assert.deepEqual(getOutputMessagesAt(loser, 1), []);
  const loserErrors = getOutputMessagesAt(loser, 2);
  assert.equal(loserErrors.length, 1);
  assert.equal(loserErrors[0].statusCode, 409);
  assert.equal(
    (loserErrors[0].payload as Record<string, unknown>).code,
    "BROADCAST_ALREADY_ACTIVE",
  );
  assert.doesNotMatch(JSON.stringify(loserErrors[0].payload), /box-right|box-left|server-only-token/);
});

test("unknown or unconfirmed claim results never fan out to a device", () => {
  const rejectedClaims = [
    {},
    { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
    [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }, { errmsg: "driver-secret" }],
  ];

  rejectedClaims.forEach((mongoResult) => {
    const { claimMessage } = prepareSkolkovoStartClaim("right_arena");
    const result = resolveSkolkovoStartClaim(claimMessage, mongoResult);
    assert.deepEqual(getOutputMessagesAt(result, 0), []);
    assert.deepEqual(getOutputMessagesAt(result, 1), []);
    const errors = getOutputMessagesAt(result, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].statusCode, 503);
    assert.equal(
      (errors[0].payload as Record<string, unknown>).code,
      "TOURNAMENT_BROADCAST_CLAIM_FAILED",
    );
    assert.doesNotMatch(JSON.stringify(errors[0].payload), /driver-secret|box-right|server-only-token/);
  });
});

test("start, stop, and status stay locked during a live transition lease", () => {
  const leaseUntil = new Date(Date.now() + 45_000).toISOString();
  const startingState = {
    active: true,
    status: "starting",
    stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    requestedTarget: "both",
    activeTargets: ["right_arena", "left_arena"],
    operationId: "secret-operation-id",
    operationLeaseUntil: leaseUntil,
    boxId: "secret-box",
    integrationToken: "secret-token",
    updatedAt: "2026-08-04T10:00:00.000Z",
  };

  ([
    buildSkolkovoRouteMessage("start", "both", startingState),
    buildSkolkovoRouteMessage("stop", undefined, startingState),
    buildSkolkovoRouteMessage("status", undefined, startingState),
  ]).forEach((message) => {
    const result = runFunctionNode(
      "fn_tournament_broadcast_route.js",
      message,
      skolkovoEnvironment,
    );
    assert.deepEqual(getOutputMessagesAt(result, 0), []);
    assert.deepEqual(getOutputMessagesAt(result, 1), []);
    const errors = getOutputMessagesAt(result, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].statusCode, 409);
    assert.equal(
      (errors[0].payload as Record<string, unknown>).code,
      "BROADCAST_OPERATION_IN_PROGRESS",
    );
    assert.equal((errors[0].headers as Record<string, unknown>)["Retry-After"], "5");
  });
});

test("external status uses snapshot CAS and cannot overwrite a newer broadcast operation", () => {
  const savedState = {
    active: false,
    status: "inactive",
    stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    updatedAt: "2026-08-04T10:00:00.000Z",
  };
  const routeMessage = buildSkolkovoRouteMessage("status", undefined, savedState);
  Object.assign(routeMessage.payload[0], { _id: "mongo-tournament-1" });
  const routeResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    routeMessage,
    skolkovoEnvironment,
  );
  const requests = dispatchRouteToDeviceRequests(routeResult);
  assert.equal(requests.length, 2);
  const expectedCas = {
    tournamentId: "tournament-1",
    _id: "mongo-tournament-1",
    "params.stationId": SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    "params.broadcast.active": false,
    "params.broadcast.status": "inactive",
    "params.broadcast.operationId": { $exists: false },
    "params.broadcast.updatedAt": "2026-08-04T10:00:00.000Z",
  };
  assert.deepEqual(
    (requests[0]._tournamentBroadcast as Record<string, unknown>).persistenceFilter,
    expectedCas,
  );

  const aggregated = aggregateDeviceOutcomes(requests, [
    { statusCode: 200, payload: { online: true, tournament_active: false } },
    { statusCode: 200, payload: { online: true, tournament_active: false } },
  ]);
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", aggregated[0])[0];
  assert.deepEqual(persisted.payload[0], expectedCas);
  const staleResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persisted,
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  });
  assert.equal(staleResponse.statusCode, 503);
  assert.equal(staleResponse.payload.code, "TOURNAMENT_BROADCAST_PERSISTENCE_FAILED");
});

test("expired starting state stops every intended target and uses operation CAS", () => {
  const expiredState = {
    active: true,
    status: "starting",
    stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    requestedTarget: "both",
    activeTargets: ["right_arena", "left_arena"],
    operationId: "expired-operation",
    operationLeaseUntil: new Date(Date.now() - 5_000).toISOString(),
    updatedAt: "2026-08-04T10:00:00.000Z",
  };
  const routeMessage = buildSkolkovoRouteMessage("stop", undefined, expiredState);
  Object.assign(routeMessage.payload[0], { _id: "mongo-tournament-1" });
  const routeResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    routeMessage,
    skolkovoEnvironment,
  );
  const requests = dispatchRouteToDeviceRequests(routeResult);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-right", "box-left"],
  );
  assert.equal(requests.every((request) => String(request.url).endsWith("/tournament/stop")), true);
  const expectedCas = {
    tournamentId: "tournament-1",
    _id: "mongo-tournament-1",
    "params.stationId": SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    "params.broadcast.active": true,
    "params.broadcast.status": "starting",
    "params.broadcast.operationId": "expired-operation",
  };
  assert.deepEqual(
    (requests[0]._tournamentBroadcast as Record<string, unknown>).persistenceFilter,
    expectedCas,
  );

  const stopped = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  const persistMessage = runFunctionNode(
    "fn_tournament_broadcast_persist.js",
    stopped[0],
  )[0];
  assert.deepEqual(persistMessage.payload[0], expectedCas);
  const inactive = persistMessage.payload[1].$set["params.broadcast"];
  assert.equal(inactive.active, false);
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.operationId, undefined);
  const response = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persistMessage,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.active, false);
  assert.equal(response.payload.recoveryRequired, false);
});

test("Skolkovo right, left and both resolve only through server-side target mapping", () => {
  const expectations = [
    { target: "right_arena" as const, boxes: ["box-right"] },
    { target: "left_arena" as const, boxes: ["box-left"] },
    { target: "both" as const, boxes: ["box-right", "box-left"] },
  ];

  expectations.forEach(({ target, boxes }) => {
    const { requests } = buildClaimedSkolkovoStartRequests(target);
    assert.equal(requests.length, boxes.length);
    assertDeviceRequestTimeouts(requests);
    assert.deepEqual(
      requests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
      boxes,
    );
    assert.equal(requests.every((request) => (
      (request.headers as Record<string, unknown>).Authorization === "Bearer server-only-token"
    )), true);
    assert.equal(requests.every((request) => (
      JSON.stringify(request.payload) === JSON.stringify({ tournament_id: "tournament-1" })
    )), true);
  });

  const duplicateConfig = {
    ...integrationEnvironment,
    CUP_STATION_SETTINGS_JSON: JSON.stringify({
      [SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID]: {
        tournamentBroadcastTargets: {
          right_arena: "same-box",
          left_arena: "same-box",
        },
      },
    }),
  };
  const duplicateResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("start", "both"),
    duplicateConfig,
  );
  assert.equal(duplicateResult[2].payload.code, "TOURNAMENT_BROADCAST_CONFIG_INVALID");
});

test("Nagatinskaya routes court 1, court 7 and both only through its server-side mapping", () => {
  const expectations = [
    { target: "right_arena" as const, boxes: ["box-court-1"], label: "Экран Корт №1" },
    { target: "left_arena" as const, boxes: ["box-court-7"], label: "Экран Корт №7" },
    { target: "both" as const, boxes: ["box-court-1", "box-court-7"], label: null },
  ];

  expectations.forEach(({ target, boxes, label }) => {
    const route = runFunctionNode(
      "fn_tournament_broadcast_route.js",
      buildNagatinskayaRouteMessage("start", target),
      nagatinskayaEnvironment,
    );
    const routed = getOutputMessagesAt(route, 0);
    assert.equal(routed.length, 1);
    const claim = getOutputMessagesAt(
      runFunctionNode("fn_tournament_broadcast_dispatch.js", structuredClone(routed[0])),
      0,
    )[0];
    const requests = getOutputMessagesAt(runFunctionNode("fn_tournament_broadcast_dispatch.js", {
      ...structuredClone(claim),
      payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    }), 1);
    assert.deepEqual(
      requests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
      boxes,
    );
    if (label) {
      assert.equal(
        (requests[0]._tournamentBroadcast as Record<string, unknown>).targetLabel,
        label,
      );
    }
  });
});

test("status exposes only safe target state and never a box identifier", () => {
  const result = runFunctionNode("fn_tournament_broadcast_route.js", buildSkolkovoRouteMessage(
    "status",
    undefined,
    {
      active: true,
      status: "partial",
      requestedTarget: "both",
      activeTargets: ["right_arena"],
      updatedAt: "2026-08-04T10:00:00.000Z",
      boxId: "secret-box",
      boxIds: ["secret-left", "secret-right"],
    },
  ), skolkovoEnvironment);
  const requests = dispatchRouteToDeviceRequests(result);
  const aggregate = aggregateDeviceOutcomes(requests, [
    {
      statusCode: 200,
      payload: {
        box_id: "secret-right",
        online: true,
        tournament_active: true,
        tournament_id: "tournament-1",
      },
    },
    {
      statusCode: 200,
      payload: {
        box_id: "secret-left",
        online: true,
        tournament_active: true,
        tournament_id: "another-tournament",
      },
    },
  ]);
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", aggregate[0])[0];
  const response = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persisted,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  const payload = response.payload;
  assert.equal(payload.active, true);
  assert.equal(payload.stationId, SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID);
  assert.equal(payload.selectionRequired, true);
  assert.equal(payload.partial, true);
  assert.equal(payload.requestedTarget, "right_arena");
  assert.deepEqual(payload.activeTargets, ["right_arena"]);
  assert.doesNotMatch(JSON.stringify(payload), /secret-box|secret-left|secret-right|box-right|box-left/);
});

test("legacy single-screen status uses box-control GET status and matches the current Viva tournament", () => {
  const environment = {
    ...integrationEnvironment,
    CUP_STATION_SETTINGS_JSON: JSON.stringify({
      "station-1": { tournamentBroadcastBoxId: "legacy-secret-box" },
    }),
  };
  const buildMessage = () => ({
    payload: [{
      tournamentId: "tournament-1",
      organizer: { id: "manager-1" },
      params: { stationId: "station-1", broadcast: {} },
    }],
    _tournamentBroadcast: {
      action: "status",
      tournamentId: "tournament-1",
      requestedStationId: "station-1",
      requestedTarget: null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  });

  const resolve = (tournamentId: string) => {
    const route = runFunctionNode(
      "fn_tournament_broadcast_route.js",
      buildMessage(),
      environment,
    );
    const requests = dispatchRouteToDeviceRequests(route);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.match(String(requests[0].url), /\/devices\/legacy-secret-box\/status$/);
    assert.equal(requests[0].payload, undefined);
    const aggregate = aggregateDeviceOutcomes(requests, [{
      statusCode: 200,
      payload: {
        box_id: "legacy-secret-box",
        online: true,
        tournament_active: true,
        tournament_id: tournamentId,
      },
    }]);
    return runFunctionNode("fn_tournament_broadcast_persist.js", aggregate[0])[0]
      .payload[1].$set["params.broadcast"];
  };

  assert.equal(resolve("tournament-1").active, true);
  assert.equal(resolve("another-tournament").active, false);
});

test("stop restores the saved station and fans out only to saved active targets", () => {
  const tournamentId = "tournament-1";
  const message = buildSkolkovoRouteMessage("stop", undefined, {
    active: true,
    status: "active",
    stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    requestedTarget: "both",
    activeTargets: ["right_arena", "left_arena"],
  });
  message.payload[0].params.stationId = `local-studio:${tournamentId}`;
  message._tournamentBroadcast.requestedStationId = `local-studio:${tournamentId}`;

  const result = runFunctionNode("fn_tournament_broadcast_route.js", message, skolkovoEnvironment);
  const requests = dispatchRouteToDeviceRequests(result);
  assert.equal(requests.length, 2);
  assert.equal(requests.every((request) => request.payload === undefined), true);
  assert.equal(requests.every((request) => String(request.url).endsWith("/tournament/stop")), true);
  assert.equal(
    (requests[0]._tournamentBroadcast as Record<string, unknown>).stationId,
    SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
  );
});

test("per-device idempotent 409 responses are normalized as success", () => {
  const start = runFunctionNode("fn_tournament_broadcast_result.js", {
    statusCode: 409,
    payload: { detail: "Same state" },
    _tournamentBroadcast: {
      commandAction: "start",
      targetKey: "right_arena",
      targetLabel: "Правый манеж",
    },
  });
  assert.equal(start.payload.ok, true);

  const stop = runFunctionNode("fn_tournament_broadcast_result.js", {
    statusCode: 409,
    payload: { detail: "No active tournament session on this box" },
    _tournamentBroadcast: {
      commandAction: "stop",
      targetKey: "right_arena",
      targetLabel: "Правый манеж",
    },
  });
  assert.equal(stop.payload.ok, true);
});

test("both succeeds only after both device responses and persists safe active targets", () => {
  const { requests } = buildClaimedSkolkovoStartRequests("both");
  const aggregated = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 409, payload: { detail: "Same state" } },
  ]);
  assert.equal(aggregated[1], null);
  assert.equal(aggregated[2], null);

  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", aggregated[0])[0];
  const broadcast = persisted.payload[1].$set["params.broadcast"];
  assert.equal(broadcast.active, true);
  assert.equal(broadcast.status, "active");
  assert.equal(broadcast.requestedTarget, "both");
  assert.deepEqual(broadcast.activeTargets, ["right_arena", "left_arena"]);
  assert.doesNotMatch(JSON.stringify(broadcast), /box-right|box-left|server-only-token/);

  const response = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persisted,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(response.payload.active, true);
  assert.equal(response.payload.requestedTarget, "both");
  assert.deepEqual(response.payload.activeTargets, ["right_arena", "left_arena"]);
  assert.doesNotMatch(JSON.stringify(response.payload), /box-right|box-left|server-only-token/);
});

test("successful multi-target stop persists and returns one safe inactive state", () => {
  const stopRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("stop", undefined, {
      active: true,
      status: "active",
      stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      requestedTarget: "both",
      activeTargets: ["right_arena", "left_arena"],
    }),
    skolkovoEnvironment,
  );
  const stopRequests = dispatchRouteToDeviceRequests(stopRoute);
  const stopped = aggregateDeviceOutcomes(stopRequests, [
    { statusCode: 204 },
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  assert.equal(stopped[1], null);
  assert.equal(stopped[2], null);

  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", stopped[0])[0];
  const inactiveState = persisted.payload[1].$set["params.broadcast"];
  assert.equal(inactiveState.active, false);
  assert.equal(inactiveState.status, "inactive");
  assert.equal(inactiveState.requestedTarget, null);
  assert.deepEqual(inactiveState.activeTargets, []);
  assert.doesNotMatch(JSON.stringify(inactiveState), /box-right|box-left|server-only-token/);

  const response = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persisted,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.active, false);
  assert.equal(response.payload.status, "inactive");
  assert.equal(response.payload.requestedTarget, null);
  assert.deepEqual(response.payload.activeTargets, []);
  assert.doesNotMatch(JSON.stringify(response.payload), /box-right|box-left|server-only-token/);
});

test("all-failed device errors are redacted before the HTTP response", () => {
  const normalizedFailure = runFunctionNode("fn_tournament_broadcast_result.js", {
    statusCode: 0,
    error: {
      message: "connect ECONNREFUSED https://broadcast.internal/devices/box-right/tournament/start?token=server-only-token",
    },
    _tournamentBroadcast: {
      commandAction: "start",
      targetKey: "right_arena",
      targetLabel: "Правый манеж",
    },
  });
  assert.equal(normalizedFailure.payload.ok, false);
  assert.equal(normalizedFailure.payload.message, "Приставка не подтвердила запуск трансляции");
  assert.doesNotMatch(
    JSON.stringify(normalizedFailure.payload),
    /box-right|server-only-token|broadcast\.internal|ECONNREFUSED/i,
  );

  const startRequests = buildClaimedSkolkovoStartRequests("both").requests;
  const failedStart = aggregateDeviceOutcomes(startRequests, [
    {
      statusCode: 0,
      error: {
        message: "connect ECONNREFUSED https://broadcast.internal/devices/box-right/tournament/start?token=server-only-token",
      },
    },
    {
      statusCode: 502,
      payload: { detail: "private upstream failure for box-left" },
    },
  ]);
  assert.equal(failedStart[0], null);
  assert.equal(failedStart[2], null);
  const compensationRequests = failedStart[1] as Array<Record<string, unknown>>;
  assert.equal(compensationRequests.length, 2);
  const compensated = aggregateDeviceOutcomes(compensationRequests, [
    { statusCode: 204 },
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  const compensatedPersist = runFunctionNode(
    "fn_tournament_broadcast_persist.js",
    compensated[0],
  )[0];
  const failedStartResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...compensatedPersist,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(failedStartResponse.statusCode, 502);
  assert.equal(failedStartResponse.payload.code, "TOURNAMENT_BROADCAST_UPSTREAM_FAILED");
  assert.equal(
    failedStartResponse.payload.message,
    "Не удалось запустить трансляцию на всех приставках. Приставки остановлены",
  );
  assert.doesNotMatch(
    JSON.stringify(failedStartResponse.payload),
    /box-right|box-left|server-only-token|broadcast\.internal|private upstream failure/i,
  );

  const stopRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("stop", undefined, {
      active: true,
      stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      requestedTarget: "both",
      activeTargets: ["right_arena", "left_arena"],
    }),
    skolkovoEnvironment,
  );
  const stopRequests = dispatchRouteToDeviceRequests(stopRoute);
  const failedStop = aggregateDeviceOutcomes(stopRequests, [
    {
      statusCode: 500,
      payload: { detail: "box-right stop failed with server-only-token" },
    },
    {
      statusCode: 0,
      error: { message: "request to https://broadcast.internal/devices/box-left failed" },
    },
  ]);
  assert.notEqual(failedStop[0], null);
  assert.equal(failedStop[1], null);
  assert.equal(failedStop[2], null);
  const failedStopPersist = runFunctionNode(
    "fn_tournament_broadcast_persist.js",
    failedStop[0],
  )[0];
  const failedStopState = failedStopPersist.payload[1].$set["params.broadcast"];
  assert.equal(failedStopState.active, true);
  assert.equal(failedStopState.status, "partial");
  assert.deepEqual(failedStopState.activeTargets, ["right_arena", "left_arena"]);
  const failedStopResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...failedStopPersist,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(failedStopResponse.statusCode, 502);
  assert.equal(failedStopResponse.payload.code, "TOURNAMENT_BROADCAST_UPSTREAM_FAILED");
  assert.equal(failedStopResponse.payload.message, "Приставки не подтвердили остановку трансляции");
  assert.doesNotMatch(
    JSON.stringify(failedStopResponse.payload),
    /box-right|box-left|server-only-token|broadcast\.internal/i,
  );
});

test("all Skolkovo start timeouts compensate every intended target", () => {
  const { requests } = buildClaimedSkolkovoStartRequests(
    "both",
    {},
    { _id: "mongo-tournament-1" },
  );
  const timedOut = aggregateDeviceOutcomes(requests, [
    { statusCode: 0, error: { message: "right request timeout at box-right" } },
    { statusCode: 0, error: { message: "left request timeout at box-left" } },
  ]);
  assert.equal(timedOut[0], null);
  assert.equal(timedOut[2], null);
  const compensationRequests = timedOut[1] as Array<Record<string, unknown>>;
  assert.equal(compensationRequests.length, 2);
  assertDeviceRequestTimeouts(compensationRequests);
  assert.deepEqual(
    compensationRequests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-right", "box-left"],
  );
  assert.equal(compensationRequests.every((request) => (
    String(request.url).endsWith("/tournament/stop") && request.payload === undefined
  )), true);
  assert.equal(compensationRequests.every((request) => (
    (request.parts as Record<string, unknown>).count === 2
  )), true);
  assert.doesNotMatch(
    JSON.stringify(compensationRequests.map((request) => request.payload)),
    /box-right|box-left|server-only-token/,
  );
});

test("single-target Skolkovo start timeout compensates only the intended target", () => {
  const { requests } = buildClaimedSkolkovoStartRequests(
    "right_arena",
    {},
    { _id: "mongo-tournament-1" },
  );
  assert.equal(requests.length, 1);

  const timedOut = aggregateDeviceOutcomes(requests, [
    { statusCode: 0, error: { message: "right request timeout at box-right" } },
  ]);
  assert.equal(timedOut[0], null);
  assert.equal(timedOut[2], null);

  const compensationRequests = timedOut[1] as Array<Record<string, unknown>>;
  assert.equal(compensationRequests.length, 1);
  assert.deepEqual(
    compensationRequests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-right"],
  );
  assert.equal(
    String(compensationRequests[0].url).endsWith("/tournament/stop"),
    true,
  );
  assert.equal(compensationRequests[0].payload, undefined);
  assert.equal(
    (compensationRequests[0].parts as Record<string, unknown>).count,
    1,
  );
});

test("final start persistence uses operation CAS and external status reconciles a failed finalize", () => {
  const { claimMessage, requests } = buildClaimedSkolkovoStartRequests(
    "both",
    {},
    { _id: "mongo-tournament-1" },
  );
  const context = requests[0]._tournamentBroadcast as Record<string, unknown>;
  const operationId = String(context.operationId);
  const expectedCas = {
    tournamentId: "tournament-1",
    _id: "mongo-tournament-1",
    "params.stationId": SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
    "params.broadcast.active": true,
    "params.broadcast.status": "starting",
    "params.broadcast.operationId": operationId,
  };
  assert.deepEqual(context.persistenceFilter, expectedCas);

  const completed = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 204 },
  ]);
  const persistMessage = runFunctionNode(
    "fn_tournament_broadcast_persist.js",
    completed[0],
  )[0];
  assert.deepEqual(persistMessage.payload[0], expectedCas);
  assert.equal(
    persistMessage.payload[1].$set["params.broadcast"].operationId,
    undefined,
  );

  const failedResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persistMessage,
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  });
  assert.equal(failedResponse.statusCode, 503);
  assert.deepEqual(failedResponse.payload, {
    ok: false,
    code: "TOURNAMENT_BROADCAST_PERSISTENCE_FAILED",
    message: "Не удалось сохранить состояние трансляции",
  });

  const claimArgs = claimMessage.payload as Array<Record<string, unknown>>;
  const claimSet = (claimArgs[1].$set || {}) as Record<string, unknown>;
  const startingState = {
    ...claimSet["params.broadcast"] as Record<string, unknown>,
    operationLeaseUntil: new Date(Date.now() - 5_000).toISOString(),
  };
  const statusResult = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("status", undefined, startingState),
    skolkovoEnvironment,
  );
  const statusRequests = dispatchRouteToDeviceRequests(statusResult);
  const statusAggregate = aggregateDeviceOutcomes(statusRequests, [
    {
      statusCode: 200,
      payload: { online: true, tournament_active: true, tournament_id: "tournament-1" },
    },
    {
      statusCode: 200,
      payload: { online: true, tournament_active: true, tournament_id: "tournament-1" },
    },
  ]);
  const statusPersist = runFunctionNode("fn_tournament_broadcast_persist.js", statusAggregate[0])[0];
  const statusResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...statusPersist,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  const status = statusResponse.payload;
  assert.equal(status.active, true);
  assert.equal(status.status, "active");
  assert.equal(status.operationInProgress, false);
  assert.equal(status.recoveryRequired, false);
  assert.equal(status.operationId, undefined);
  assert.equal(JSON.stringify(status).includes(operationId), false);
});

test("broadcast success is returned only after an acknowledged matched Mongo write", () => {
  const { requests } = buildClaimedSkolkovoStartRequests("right_arena");
  const aggregated = aggregateDeviceOutcomes(requests, [{ statusCode: 204 }]);
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", aggregated[0])[0];

  const acknowledgedResults = [
    { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    [{ acknowledged: true, matchedCount: 1, modifiedCount: 0 }],
    { result: { acknowledged: true, n: 1, nModified: 0 } },
  ];
  acknowledgedResults.forEach((mongoResult) => {
    const acknowledged = runFunctionNode("fn_tournament_broadcast_response.js", {
      ...structuredClone(persisted),
      payload: mongoResult,
    });
    assert.equal(acknowledged.statusCode, 200);
    assert.equal(acknowledged.payload.ok, true);
    assert.equal(acknowledged.payload.active, true);
    assert.deepEqual(acknowledged.payload.activeTargets, ["right_arena"]);
  });

  const rejectedResults = [
    { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 },
    { acknowledged: true, result: { acknowledged: false, n: 1 } },
    [{ acknowledged: true, matchedCount: 1 }, { errmsg: "driver-secret" }],
  ];
  rejectedResults.forEach((mongoResult) => {
    const rejected = runFunctionNode("fn_tournament_broadcast_response.js", {
      ...structuredClone(persisted),
      payload: mongoResult,
    });
    assert.equal(rejected.statusCode, 503);
    assert.deepEqual(rejected.payload, {
      ok: false,
      code: "TOURNAMENT_BROADCAST_PERSISTENCE_FAILED",
      message: "Не удалось сохранить состояние трансляции",
    });
    assert.doesNotMatch(
      JSON.stringify(rejected.payload),
      /box-right|server-only-token|acknowledged|matchedCount|modifiedCount/i,
    );
  });
});

test("partial start compensates the successful box before returning failure", () => {
  const { requests } = buildClaimedSkolkovoStartRequests("both");
  const initial = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 500, payload: { detail: "left failed" } },
  ]);
  assert.equal(initial[0], null);
  assert.equal(initial[2], null);
  const compensationRequests = initial[1] as Array<Record<string, unknown>>;
  assert.equal(compensationRequests.length, 2);
  assert.deepEqual(
    compensationRequests.map((request) => String(request.url).match(/devices\/([^/]+)/)?.[1]),
    ["box-right", "box-left"],
  );
  assert.equal(compensationRequests.every((request) => request.payload === undefined), true);

  const compensated = aggregateDeviceOutcomes(compensationRequests, [
    { statusCode: 204 },
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  assert.notEqual(compensated[0], null);
  assert.equal(compensated[1], null);
  assert.equal(compensated[2], null);

  const persist = runFunctionNode("fn_tournament_broadcast_persist.js", compensated[0]);
  const persistMessage = persist[0];
  const cleared = persistMessage.payload[1].$set["params.broadcast"];
  assert.equal(cleared.active, false);
  assert.equal(cleared.status, "inactive");
  assert.deepEqual(cleared.activeTargets, []);
  assert.equal(cleared.operationId, undefined);

  const response = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...persistMessage,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.payload.code, "TOURNAMENT_BROADCAST_UPSTREAM_FAILED");
  assert.match(response.payload.message, /остановлены/);
});

test("failed compensation persists the exact remaining partial target", () => {
  const requests = buildClaimedSkolkovoStartRequests("both").requests;
  const initial = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 500, payload: { detail: "left failed" } },
  ]);
  const compensationRequests = initial[1] as Array<Record<string, unknown>>;
  const compensation = aggregateDeviceOutcomes(compensationRequests, [
    { statusCode: 500, payload: { detail: "rollback failed" } },
    { statusCode: 409, payload: { detail: "No active tournament session on this box" } },
  ]);
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", compensation[0])[0];
  const broadcast = persisted.payload[1].$set["params.broadcast"];
  assert.equal(broadcast.active, true);
  assert.equal(broadcast.status, "partial");
  assert.equal(broadcast.requestedTarget, "both");
  assert.deepEqual(broadcast.activeTargets, ["right_arena"]);
  assert.doesNotMatch(JSON.stringify(broadcast), /box-right|box-left/);
});

test("partial stop preserves only targets that did not confirm stop", () => {
  const stopRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    buildSkolkovoRouteMessage("stop", undefined, {
      active: true,
      stationId: SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID,
      requestedTarget: "both",
      activeTargets: ["right_arena", "left_arena"],
    }),
    skolkovoEnvironment,
  );
  const requests = dispatchRouteToDeviceRequests(stopRoute);
  const aggregate = aggregateDeviceOutcomes(requests, [
    { statusCode: 204 },
    { statusCode: 500, payload: { detail: "left stop failed" } },
  ]);
  const persisted = runFunctionNode("fn_tournament_broadcast_persist.js", aggregate[0])[0];
  const broadcast = persisted.payload[1].$set["params.broadcast"];
  assert.equal(broadcast.active, true);
  assert.equal(broadcast.status, "partial");
  assert.equal(broadcast.requestedTarget, "both");
  assert.deepEqual(broadcast.activeTargets, ["left_arena"]);

  const allFailed = aggregateDeviceOutcomes(requests, [
    { statusCode: 500, payload: { detail: "right stop failed" } },
    { statusCode: 500, payload: { detail: "left stop failed" } },
  ]);
  assert.notEqual(allFailed[0], null);
  assert.equal(allFailed[1], null);
  assert.equal(allFailed[2], null);
  const allFailedPersist = runFunctionNode(
    "fn_tournament_broadcast_persist.js",
    allFailed[0],
  )[0];
  const allFailedBroadcast = allFailedPersist.payload[1].$set["params.broadcast"];
  assert.equal(allFailedBroadcast.active, true);
  assert.equal(allFailedBroadcast.status, "partial");
  assert.deepEqual(allFailedBroadcast.activeTargets, ["right_arena", "left_arena"]);
  const allFailedResponse = runFunctionNode("fn_tournament_broadcast_response.js", {
    ...allFailedPersist,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(allFailedResponse.statusCode, 502);
  assert.equal(allFailedResponse.payload.code, "TOURNAMENT_BROADCAST_UPSTREAM_FAILED");
});

test("scoped test tournament override still resolves only its configured test box", () => {
  const baseMessage = {
    payload: [{
      tournamentId: "test-tournament",
      organizer: { id: "manager-1" },
      params: { stationId: "test-station" },
    }],
    _tournamentBroadcast: {
      action: "start",
      tournamentId: "test-tournament",
      requestedTarget: null,
      profileId: "manager-1",
      hasHostingAccess: false,
    },
  };
  const environment = {
    ...integrationEnvironment,
    TOURNAMENT_BROADCAST_TEST_TOURNAMENT_ID: "test-tournament",
    TOURNAMENT_BROADCAST_TEST_BOX_ID: "test-box",
  };
  const matchedRoute = runFunctionNode(
    "fn_tournament_broadcast_route.js",
    structuredClone(baseMessage),
    environment,
  );
  const matched = dispatchRouteToDeviceRequests(matchedRoute);
  assert.equal(matched.length, 1);
  assert.match(String(matched[0].url), /\/devices\/test-box\/tournament\/start$/);

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

test("broadcast flow patch is idempotent, joined, and keeps the live Mongo client", () => {
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
    execFileSync(
      process.execPath,
      ["scripts/patch_nodered_tournament_broadcast_flow.mjs", sourcePath, importPath],
      { cwd: workspaceRoot, stdio: "pipe" },
    );
    const firstPass = fs.readFileSync(sourcePath, "utf8");
    execFileSync(
      process.execPath,
      ["scripts/patch_nodered_tournament_broadcast_flow.mjs", sourcePath, importPath],
      { cwd: workspaceRoot, stdio: "pipe" },
    );
    const secondPass = fs.readFileSync(sourcePath, "utf8");
    assert.equal(secondPass, firstPass);

    const patched = JSON.parse(secondPass) as Array<Record<string, unknown>>;
    const ids = patched.map((node) => String(node.id || ""));
    assert.equal(new Set(ids).size, ids.length);
    const idSet = new Set(ids);
    const brokenWires = patched.flatMap((node) => (
      Array.isArray(node.wires) ? node.wires : []
    )).flatMap((row) => (
      Array.isArray(row) ? row : []
    )).filter((targetId) => !idSet.has(String(targetId)));
    assert.deepEqual(brokenWires, []);
    const brokenLinks = patched.flatMap((node) => (
      Array.isArray(node.links) ? node.links : []
    )).filter((targetId) => !idSet.has(String(targetId)));
    assert.deepEqual(brokenLinks, []);

    const routeCount = patched.filter((node) => (
      node.type === "http in"
      && node.method === "post"
      && node.url === "/lk/tournaments/broadcast/:action"
    )).length;
    const joins = patched.filter((node) => (
      node.type === "join"
      && node.id === "lk_tournament_broadcast_device_join_20260804"
    ));
    const aggregates = patched.filter((node) => (
      node.type === "function"
      && node.id === "lk_tournament_broadcast_aggregate_20260804"
    ));
    const routes = patched.filter((node) => (
      node.type === "function"
      && node.id === "lk_tournament_broadcast_route_20260719"
    ));
    const dispatches = patched.filter((node) => (
      node.type === "function"
      && node.id === "lk_tournament_broadcast_dispatch_20260804"
    ));
    const claimUpdates = patched.filter((node) => (
      node.type === "mongodb4"
      && node.id === "lk_tournament_broadcast_claim_20260804"
    ));
    const deviceRequests = patched.filter((node) => (
      node.type === "http request"
      && node.id === "lk_tournament_broadcast_device_20260719"
    ));
    const managedMongo = patched.filter((node) => (
      node.type === "mongodb4"
      && String(node.id || "").startsWith("lk_tournament_broadcast_")
    ));
    assert.equal(routeCount, 1);
    assert.equal(joins.length, 1);
    assert.equal(aggregates.length, 1);
    assert.equal(routes.length, 1);
    assert.equal(dispatches.length, 1);
    assert.equal(claimUpdates.length, 1);
    assert.equal(deviceRequests.length, 1);
    assert.deepEqual(routes[0].wires, [
      ["lk_tournament_broadcast_dispatch_20260804"],
      ["lk_tournament_broadcast_http_response_20260719"],
      ["lk_tournament_broadcast_http_response_20260719"],
    ]);
    assert.deepEqual(dispatches[0].wires, [
      ["lk_tournament_broadcast_claim_20260804"],
      ["lk_tournament_broadcast_device_20260719"],
      ["lk_tournament_broadcast_http_response_20260719"],
    ]);
    assert.deepEqual(claimUpdates[0].wires, [
      ["lk_tournament_broadcast_dispatch_20260804"],
    ]);
    assert.equal(deviceRequests[0].requestTimeout, "20000");
    assert.equal(joins[0].timeout, "25");
    assert.deepEqual(aggregates[0].wires, [
      ["lk_tournament_broadcast_persist_20260719"],
      ["lk_tournament_broadcast_device_20260719"],
      ["lk_tournament_broadcast_http_response_20260719"],
    ]);
    assert.equal(managedMongo.length, 3);
    assert.equal(managedMongo.every((node) => node.clientNode === "mongo-client"), true);
    assert.ok(fs.existsSync(importPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
