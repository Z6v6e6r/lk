import assert from "node:assert/strict";
import test from "node:test";

import { buildPhase2CasCandidate } from "../patch_live_games_split_leave_phase2_cas.mjs";

const ids = Object.freeze({
  tab: "4b91e2a2413688db",
  patchRoute: "7ad34f13c4b25d60",
  patchRecordsRoute: "4cb1e542db56b508",
  patchPrepare: "e0d7883bc1a9fa8c",
  patchArgs: "b2a10027fc45966c",
  patchMongo: "591234d213742276",
  patchResponse: "e17f8a411d4dfa91",
  patchDebug: "3b822085d5f18e97",
  patchAutojoin: "5fc5eaeab97f3f88",
  functionTemplate: "9878400d518ebcbd",
  patchCasGuard: "lk_game_patch_cas_guard_20260801",
  patchCasQuery: "lk_game_patch_apply_cas_20260801",
  patchResponseGate: "lk_game_patch_response_gate_20260801",
  patchAutojoinGate: "lk_game_patch_autojoin_gate_20260801",
  patchAfterWrite: "lk_game_patch_after_write_20260801",
  patchCatch: "lk_game_patch_write_catch_20260801",
});

function phaseOneFixture() {
  const flow = [
    { id: ids.tab, type: "tab", label: "LK Games", disabled: false },
    {
      id: ids.patchRoute,
      type: "http in",
      z: ids.tab,
      url: "/lk/games/:gameId",
      method: "patch",
      wires: [[ids.patchPrepare]],
    },
    {
      id: ids.patchRecordsRoute,
      type: "http in",
      z: ids.tab,
      url: "/lk/games/records/:gameId",
      method: "patch",
      wires: [[ids.patchPrepare]],
    },
    {
      id: ids.patchPrepare,
      type: "function",
      z: ids.tab,
      name: "Prepare game patch",
      func: "return msg;",
      outputs: 4,
      wires: [[ids.patchArgs], [ids.patchResponse], [ids.patchDebug], [ids.patchAutojoin]],
    },
    {
      id: ids.patchArgs,
      type: "function",
      z: ids.tab,
      name: "Update lk game -> mongodb4 args",
      func: "return msg;",
      outputs: 1,
      wires: [[ids.patchMongo]],
    },
    {
      id: ids.patchMongo,
      type: "mongodb4",
      z: ids.tab,
      operation: "updateOne",
      wires: [[]],
    },
    { id: ids.patchResponse, type: "http response", z: ids.tab, wires: [] },
    { id: ids.patchDebug, type: "debug", z: ids.tab, wires: [] },
    { id: ids.patchAutojoin, type: "mongodb4", z: ids.tab, operation: "find", wires: [] },
    {
      id: ids.functionTemplate,
      type: "function",
      z: ids.tab,
      name: "Function template",
      func: "return msg;",
      outputs: 1,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      wires: [[]],
    },
  ];
  for (let index = 0; index < 201; index += 1) {
    flow.push({
      id: `fixture_http_${index}`,
      type: "http in",
      z: ids.tab,
      url: `/fixture/${index}`,
      method: "get",
      wires: [],
    });
  }
  while (flow.length < 4667) {
    flow.push({ id: `fixture_node_${flow.length}`, type: "comment", z: ids.tab, wires: [] });
  }
  return flow;
}

test("phase-two builder adds only the PATCH CAS acknowledgement graph", () => {
  const source = phaseOneFixture();
  const { flow, changes } = buildPhase2CasCandidate(source);
  const byId = new Map(flow.map((node) => [node.id, node]));

  assert.equal(flow.length, 4673);
  assert.equal(changes.filter((change) => change.kind === "changed").length, 5);
  assert.equal(changes.filter((change) => change.kind === "added").length, 6);
  assert.deepEqual(byId.get(ids.patchRoute).wires, [[ids.patchCasGuard]]);
  assert.deepEqual(byId.get(ids.patchRecordsRoute).wires, [[ids.patchCasGuard]]);
  assert.deepEqual(byId.get(ids.patchPrepare).wires, [
    [ids.patchArgs],
    [ids.patchResponseGate],
    [ids.patchDebug],
    [ids.patchAutojoinGate],
  ]);
  assert.deepEqual(byId.get(ids.patchArgs).wires, [[ids.patchCasQuery]]);
  assert.deepEqual(byId.get(ids.patchMongo).wires, [[ids.patchAfterWrite]]);
  assert.deepEqual(byId.get(ids.patchCatch).scope, [ids.patchMongo]);

  assert.deepEqual(source.find((node) => node.id === ids.patchRoute).wires, [[ids.patchPrepare]]);
});

test("phase-two builder fails closed for a drifted phase-one graph", () => {
  const source = phaseOneFixture();
  source.find((node) => node.id === ids.patchMongo).wires = [[ids.patchResponse]];

  assert.throws(
    () => buildPhase2CasCandidate(source),
    /Phase-one PATCH wire contract mismatch/,
  );
});

test("phase-two builder refuses to apply twice", () => {
  const first = buildPhase2CasCandidate(phaseOneFixture()).flow;

  assert.throws(
    () => buildPhase2CasCandidate(first),
    /Phase-one live node count mismatch|already exists/,
  );
});
