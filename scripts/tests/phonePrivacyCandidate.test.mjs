import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildPhonePrivacyCandidate, PHONE_PRIVACY_CONTRACT } from "../patch_live_phone_privacy.mjs";

// A small synthetic graph exercises the same reviewed edges, without committing
// a live flow, service configuration, credentials or customer records.
function fixture() {
  const contract = structuredClone(PHONE_PRIVACY_CONTRACT);
  const nodes = new Map();
  const add = (id, type, fields = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, z: "synthetic-tab", wires: [], ...fields });
    return nodes.get(id);
  };
  for (const id of contract.responseIds) {
    add(id, "http response");
    add("producer-" + id, "function", { func: "return msg;", wires: [[id]] });
  }
  const t = contract.tournament;
  add(t.saveRouteId, "http in", { method: "post", url: "/lk/tournaments/americano", wires: [[t.saveTargetId]] });
  add(t.saveTargetId, "function", { func: "return msg;", wires: [[t.saveResponseId]] });
  add(t.findTemplateId, "mongodb4", { collection: "tournaments", operation: "find", wires: [[t.resultsTargetId]] });
  add(t.resultsTargetId, "function", { func: "return msg;", wires: [[t.resultsResponseId]] });
  add(t.exportMongoId, "mongodb4", { collection: "tournaments", operation: "find", wires: [[t.exportTargetId]] });
  add(t.exportTargetId, "function", { func: "return msg;", wires: [[t.exportResponseId]] });
  for (const row of contract.communityReads) {
    add(row.mongoId, "mongodb4", { collection: "lk_communities", operation: "find", wires: [[row.targetId]] });
    add(row.targetId, "function", { func: "return msg;", wires: [[row.responseId]] });
  }
  for (const row of contract.resultReads) {
    add(row.mongoId, "mongodb4", { collection: row.collection, operation: "find", wires: [[row.targetId]] });
    add(row.targetId, "function", { func: "return msg;", wires: [[row.responseId]] });
  }
  add("anonymous-schedule", "http in", { method: "get", url: "/lk/games", wires: [["anonymous-roster"]] });
  add("anonymous-roster", "function", { func: "return msg;", wires: [["public-roster-response"]] });
  add("public-roster-response", "http response");
  const flow = [...nodes.values()];
  contract.nodeCount = flow.length;
  contract.httpRouteCount = 2;
  return { flow, contract };
}

test("privacy candidate preserves anonymous routes, existing code and every filtered egress", () => {
  const { flow, contract } = fixture();
  const before = structuredClone(flow);
  const result = buildPhonePrivacyCandidate(flow, contract.wholeFlowSha256, contract);
  assert.deepEqual(flow, before);
  for (const id of ["anonymous-schedule", "anonymous-roster", "public-roster-response"]) {
    assert.deepEqual(result.candidate.find((node) => node.id === id), before.find((node) => node.id === id));
  }
  for (const id of contract.responseIds) {
    const incoming = result.candidate.filter((node) => node.wires.some((wires) => wires.includes(id)));
    assert.deepEqual(incoming.map((node) => node.id), ["phone_privacy_response_" + id]);
  }
  for (const id of result.addedNodeIds) {
    const node = result.candidate.find((item) => item.id === id);
    if (node.type === "function") new vm.Script("(function(msg){" + node.func + "\n})");
  }
});

test("wrong preimage, missing edge and duplicate node fail closed", () => {
  const { flow, contract } = fixture();
  assert.throws(() => buildPhonePrivacyCandidate(flow, "wrong", contract), /SHA mismatch/);
  const drift = structuredClone(flow);
  drift.find((node) => node.id === contract.tournament.findTemplateId).wires = [[]];
  assert.throws(() => buildPhonePrivacyCandidate(drift, contract.wholeFlowSha256, contract), /Missing reviewed edge/);
  assert.throws(() => buildPhonePrivacyCandidate([...flow, flow[0]], contract.wholeFlowSha256, contract), /duplicate node/);
});

test("new identity lookup errors cannot reach a tournament write or echo the command", () => {
  const { flow, contract } = fixture();
  const { candidate } = buildPhonePrivacyCandidate(flow, contract.wholeFlowSha256, contract);
  const catcher = candidate.find((node) => node.id === "phone_privacy_tournament_lookup_catch");
  assert.deepEqual(catcher.scope, ["phone_privacy_tournament_save_find"]);
  const handler = candidate.find((node) => node.id === catcher.wires[0][0]);
  const msg = { payload: { phone: "70000000001" }, _phonePrivacyCommand: { phone: "70000000001" } };
  vm.runInNewContext("(function(msg){" + handler.func + "\n})(msg)", { msg });
  assert.equal(msg.statusCode, 503);
  assert.equal(msg._phonePrivacyCommand, undefined);
  assert.equal(msg.payload.code, "PUBLIC_IDENTITY_UNAVAILABLE");
  assert.equal(JSON.stringify(msg).includes("70000000001"), false);
  assert.deepEqual(handler.wires, [["phone_privacy_response_" + contract.tournament.saveResponseId]]);
});
