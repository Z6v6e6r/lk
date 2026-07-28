import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { patchTournamentResultsPersistence } from "../nodered_tournament_persistence_patch.mjs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

test("tournament persistence router keeps only valid writes on the Mongo branch", () => {
  const ready = {
    payload: { tournamentId: "t-1", rounds: [] },
    mongoQuery: { tournamentId: "t-1" },
    mongoUpdate: { $set: { rounds: [] } },
  };
  const routedReady = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_persist_router.js",
    ready,
  );
  assert.equal(Array.isArray(routedReady), true);
  assert.equal(routedReady[0]._tournamentResponse, ready.payload);
  assert.equal(routedReady[1], null);

  const routedValidationError = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_persist_router.js",
    { statusCode: 422, payload: { error: "ROUND_LAYOUT_REQUIRED" } },
  );
  assert.equal(routedValidationError[0], null);
  assert.equal(routedValidationError[1].statusCode, 422);
  assert.equal(routedValidationError[1].payload.error, "ROUND_LAYOUT_REQUIRED");

  const routedBrokenWrite = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_persist_router.js",
    { payload: { tournamentId: "t-1" } },
  );
  assert.equal(routedBrokenWrite[0], null);
  assert.equal(routedBrokenWrite[1].statusCode, 500);
  assert.equal(routedBrokenWrite[1].payload.error, "TOURNAMENT_PERSISTENCE_PREPARE_FAILED");
});

test("tournament response is successful only after an acknowledged matched write", () => {
  const response = { tournamentId: "t-1", rounds: [{ id: "round-1" }] };
  const idempotentRetry = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_update_after_write.js",
    {
      _tournamentResponse: response,
      payload: { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
    },
  );
  assert.equal(idempotentRetry.statusCode, 200);
  assert.deepEqual(idempotentRetry.payload, response);

  const unmatched = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_update_after_write.js",
    {
      _tournamentResponse: response,
      payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
    },
  );
  assert.equal(unmatched.statusCode, 409);
  assert.equal(unmatched.payload.error, "TOURNAMENT_PERSISTENCE_CONFLICT");

  const unacknowledged = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_update_after_write.js",
    {
      _tournamentResponse: response,
      payload: { acknowledged: false, matchedCount: 1 },
    },
  );
  assert.equal(unacknowledged.statusCode, 503);
  assert.equal(unacknowledged.payload.error, "TOURNAMENT_PERSISTENCE_NOT_ACKNOWLEDGED");
});

test("tournament persistence catch returns a retryable error without exposing Mongo details", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_write_error_response.js",
    {
      _tournamentResponse: { tournamentId: "t-1" },
      _error: {
        message: "mongodb://secret@example.invalid failed",
        source: { id: "mongo-node", name: "Update tournament" },
      },
    },
  );
  assert.equal(out.statusCode, 503);
  assert.equal(out.payload.error, "TOURNAMENT_PERSISTENCE_FAILED");
  assert.equal(out.payload.source, "Update tournament");
  assert.equal(JSON.stringify(out.payload).includes("secret"), false);
});

test("tournament update arguments bound the Mongo operation", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_update_args.js",
    {
      mongoQuery: { tournamentId: "t-1" },
      mongoUpdate: { $set: { updatedAt: "now" } },
    },
  );
  assert.deepEqual(out.payload, [
    { tournamentId: "t-1" },
    { $set: { updatedAt: "now" } },
    { upsert: false, maxTimeMS: 5000 },
  ]);
});

test("patch wires the results HTTP response after the Mongo acknowledgement", () => {
  const tab = { id: "tab-tournaments", type: "tab", label: "LK Tournaments" };
  const route = {
    id: "route", type: "http in", z: tab.id, name: "Americano results",
    url: "/lk/tournaments/americano/results", wires: [["recalculate"]],
  };
  const recalculate = {
    id: "recalculate", type: "function", z: tab.id, name: "Recalculate ratings & totals",
    wires: [["mongo-update-doc", "http-response"]],
  };
  const mongoUpdateDoc = {
    id: "mongo-update-doc", type: "change", z: tab.id, name: "Mongo update doc",
    rules: [
      { t: "set", p: "query", pt: "msg", to: "mongoQuery", tot: "msg" },
      { t: "set", p: "payload", pt: "msg", to: "mongoUpdate", tot: "msg" },
    ],
    wires: [["update-args"]],
  };
  const updateArgs = {
    id: "update-args", type: "function", z: tab.id, name: "Update tournament -> mongodb4 args",
    wires: [["update-tournament"]],
  };
  const updateTournament = {
    id: "update-tournament", type: "mongodb4", z: tab.id, name: "Update tournament", wires: [[]],
  };
  const httpResponse = { id: "http-response", type: "http response", z: tab.id, wires: [] };
  const flow = [tab, route, recalculate, mongoUpdateDoc, updateArgs, updateTournament, httpResponse];

  const result = patchTournamentResultsPersistence(flow);
  const repeated = patchTournamentResultsPersistence(flow);
  const byId = new Map(flow.map((node) => [node.id, node]));
  const router = byId.get(result.router);
  const afterWrite = byId.get(result.afterWrite);
  const catchNode = byId.get(result.catch);

  assert.deepEqual(recalculate.wires, [[result.router]]);
  assert.deepEqual(router.wires, [[mongoUpdateDoc.id], [httpResponse.id]]);
  assert.deepEqual(updateTournament.wires, [[result.afterWrite]]);
  assert.deepEqual(afterWrite.wires, [[httpResponse.id]]);
  assert.deepEqual(mongoUpdateDoc.rules[0], {
    t: "set",
    p: "_tournamentResponse",
    pt: "msg",
    to: "payload",
    tot: "msg",
  });
  assert.equal(catchNode.scope.includes(updateTournament.id), true);
  assert.equal(catchNode.wires[0].length, 1);
  assert.deepEqual(repeated, result);
});
