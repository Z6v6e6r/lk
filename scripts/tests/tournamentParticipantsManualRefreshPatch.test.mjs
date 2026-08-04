import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT,
  buildTournamentParticipantRefreshCandidate,
} from "../patch_live_tournament_participants_manual_refresh.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_SOURCE_DIR = path.resolve(SCRIPT_DIR, "../nodered_tournament_participants_nodes");
const PREIMAGE_FUNCTION = "return msg;";
const SOURCE_BY_NAME = Object.freeze({
  cacheGate: "msg.fixture = 'cache';\nreturn [msg, null];",
  terminal: "msg.fixture = 'terminal';\nreturn msg;",
  refreshPrepare: "msg.fixture = 'prepare';\nreturn [msg, null];",
  refreshAuthorize: "msg.fixture = 'authorize';\nreturn [msg, null];",
  refreshOptions: "msg.fixture = 'options';\nreturn msg;",
});

function functionNode(id, z, outputs, wires) {
  return {
    id,
    type: "function",
    z,
    name: id,
    func: PREIMAGE_FUNCTION,
    outputs,
    wires,
  };
}

function fixture() {
  const ids = TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT.ids;
  const tabId = TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT.tab.id;
  const debugIds = {
    get: "07131f07eb86f115",
    validate: "91c4abd8f70de99a",
    admin: "1f4650948e4789f3",
    rating: "0172ee848e9f2364",
    join: "07de41d59cc86a90",
  };
  const flow = [
    {
      id: tabId,
      type: "tab",
      label: "LK Tournaments",
      disabled: false,
    },
    {
      id: ids.getRoute,
      type: "http in",
      z: tabId,
      name: "LK tournaments participants",
      method: "get",
      url: "/lk/tournaments/participants",
      wires: [[ids.cacheGate, debugIds.get]],
    },
    functionNode(
      ids.validate,
      tabId,
      2,
      [[ids.adminBookings, debugIds.validate], [ids.terminal]],
    ),
    {
      id: ids.adminBookings,
      type: "http request",
      z: tabId,
      method: "use",
      wires: [[ids.normalize, debugIds.admin]],
    },
    functionNode(ids.normalize, tabId, 3, [[ids.split], [ids.upstreamError], [ids.terminal]]),
    {
      id: ids.split,
      type: "split",
      z: tabId,
      wires: [[ids.clientRequest]],
    },
    functionNode(ids.clientRequest, tabId, 2, [[ids.join], [ids.clientQueue]]),
    functionNode(ids.clientQueue, tabId, 2, [[ids.clientHttp], [ids.join]]),
    {
      id: ids.clientHttp,
      type: "http request",
      z: tabId,
      method: "use",
      wires: [[ids.attachRating]],
    },
    functionNode(
      ids.attachRating,
      tabId,
      1,
      [[ids.clientRelease, debugIds.rating]],
    ),
    functionNode(ids.clientRelease, tabId, 2, [[ids.clientHttp], [ids.join]]),
    {
      id: ids.join,
      type: "join",
      z: tabId,
      wires: [[ids.terminal, debugIds.join]],
    },
    functionNode(ids.upstreamError, tabId, 1, [[ids.terminal]]),
    functionNode(ids.cacheGate, tabId, 2, [[ids.validate], [ids.terminal]]),
    functionNode(ids.terminal, tabId, 1, [[ids.response]]),
    {
      id: ids.response,
      type: "http response",
      z: tabId,
      wires: [],
    },
    ...Object.values(debugIds).map((id) => ({
      id,
      type: "debug",
      z: tabId,
      wires: [],
    })),
  ];
  const preimageSha256 = sha256(PREIMAGE_FUNCTION);
  const contract = {
    ...TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT,
    wholeFlowSha256: "fixture-source-sha256",
    nodeCount: flow.length,
    httpRouteCount: 1,
    functionPreimages: Object.fromEntries(
      Object.keys(TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT.functionPreimages)
        .map((name) => [name, preimageSha256]),
    ),
    sources: Object.fromEntries(Object.entries(SOURCE_BY_NAME).map(([name, source]) => [
      name,
      { file: `${name}.js`, sha256: sha256(source) },
    ])),
  };
  return { flow, contract, sources: SOURCE_BY_NAME };
}

test("guarded participant refresh builder changes exactly two functions and appends seven nodes", () => {
  const { flow, contract, sources } = fixture();
  const result = buildTournamentParticipantRefreshCandidate(
    structuredClone(flow),
    contract.wholeFlowSha256,
    contract,
    sources,
  );

  assert.equal(result.candidate.length, flow.length + 7);
  assert.equal(result.report.httpRouteCount, 3);
  assert.deepEqual(result.report.existingChanges, [
    { id: contract.ids.cacheGate, changedFields: ["func"] },
    { id: contract.ids.terminal, changedFields: ["func"] },
  ]);
  assert.equal(result.report.addedNodes.length, 7);
  assert.equal(result.report.brokenWires, 0);
  assert.equal(result.report.brokenLinks, 0);
  assert.deepEqual(
    result.candidate
      .filter((node) => node.type === "http in" && node.url.endsWith("/refresh"))
      .map((node) => node.method)
      .sort(),
    ["options", "post"],
  );
});

test("guarded participant refresh builder rejects the wrong whole-flow SHA", () => {
  const { flow, contract, sources } = fixture();
  assert.throws(
    () => buildTournamentParticipantRefreshCandidate(flow, "wrong-sha", contract, sources),
    /Whole-flow preimage SHA mismatch/,
  );
});

test("guarded participant refresh builder rejects topology drift", () => {
  const { flow, contract, sources } = fixture();
  const cacheGate = flow.find((node) => node.id === contract.ids.cacheGate);
  cacheGate.wires = [[contract.ids.response], [contract.ids.terminal]];

  assert.throws(
    () => buildTournamentParticipantRefreshCandidate(
      flow,
      contract.wholeFlowSha256,
      contract,
      sources,
    ),
    /contract mismatch for wires/,
  );
});

test("guarded participant refresh builder rejects an existing manual refresh route", () => {
  const { flow, contract, sources } = fixture();
  flow.push({
    id: "fixture_existing_refresh",
    type: "http in",
    z: contract.tab.id,
    method: "post",
    url: "/lk/tournaments/participants/refresh",
    wires: [[contract.ids.response]],
  });
  const routeContract = {
    ...contract,
    nodeCount: flow.length,
    httpRouteCount: 2,
  };

  assert.throws(
    () => buildTournamentParticipantRefreshCandidate(
      flow,
      routeContract.wholeFlowSha256,
      routeContract,
      sources,
    ),
    /Manual participant refresh route already exists/,
  );
});

test("default builder contract pins every real participant-refresh source", () => {
  for (const sourceContract of Object.values(TOURNAMENT_PARTICIPANT_REFRESH_CONTRACT.sources)) {
    const source = fs.readFileSync(path.join(REAL_SOURCE_DIR, sourceContract.file), "utf8");
    assert.equal(sha256(source), sourceContract.sha256, sourceContract.file);
  }
});
