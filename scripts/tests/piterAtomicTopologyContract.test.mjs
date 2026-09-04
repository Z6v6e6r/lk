import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PITER_ATOMIC_ERROR_SOURCE,
  PITER_ATOMIC_TOPOLOGY_IDS,
  assertNoEnabledLegacyPiterSalesTab,
  assertPiterAtomicTopology,
  rejectTopologyDependentPiterSource,
} from "../lib/piterAtomicTopologyContract.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FUNCTION_DIR = path.join(ROOT, "scripts/nodered_games_nodes");

function validFlow() {
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  const atomicRouterSource = fs.readFileSync(
    path.join(FUNCTION_DIR, "fn_tournament_subscription_piter_atomic_router.js"),
    "utf8",
  );
  return [
    { id: ids.purchaseRouter, type: "function", z: ids.tab, name: "Route tournament subscription payment", outputs: 5, wires: [[], [], [], [], [ids.atomicRouter]] },
    { id: ids.confirmResolve, type: "function", z: ids.tab, name: "Resolve tournament subscription confirm", outputs: 4, wires: [[], [], [], [ids.atomicRouter]] },
    { id: ids.atomicRouter, type: "function", z: ids.tab, name: "Route atomic Piter subscription sale", func: atomicRouterSource, outputs: 5, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 2750, y: 2240, wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]] },
    { id: ids.ledgerFind, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", name: "Find Piter atomic inventory ledger", collection: "lk_tournament_subscription_sales", operation: "find", output: "toArray", maxTimeMS: "5000", handleDocId: false, x: 3140, y: 2180, wires: [[ids.atomicRouter]] },
    { id: ids.ledgerUpdate, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", name: "CAS Piter atomic inventory ledger", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, x: 3140, y: 2220, wires: [[ids.atomicRouter]] },
    { id: ids.saleUpdate, type: "mongodb4", z: ids.tab, clientNode: ids.mongoClient, mode: "collection", name: "Persist Piter atomic sale", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, x: 3140, y: 2260, wires: [[ids.atomicRouter]] },
    { id: ids.mongoCatch, type: "catch", z: ids.tab, name: "Catch Piter atomic Mongo errors", scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate], uncaught: false, x: 2780, y: 2320, wires: [[ids.mongoError]] },
    { id: ids.mongoError, type: "function", z: ids.tab, name: "Redact Piter atomic Mongo error", func: PITER_ATOMIC_ERROR_SOURCE, outputs: 2, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 3150, y: 2320, wires: [[ids.response], [ids.debug]] },
    { id: ids.mongoClient, type: "mongodb4-client", name: "Mongo" },
    { id: ids.viva, type: "http request", z: ids.tab, name: "Viva" },
    { id: ids.response, type: "http response", z: ids.tab, name: "Response" },
    { id: ids.debug, type: "debug", z: ids.tab, name: "tournament subscription payment debug", active: false },
  ];
}

test("exact Piter atomic topology accepts the reviewed graph", () => {
  assert.equal(assertPiterAtomicTopology(validFlow()), true);
});

test("exact Piter atomic topology rejects graph, Mongo, function, and debug drift", () => {
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  for (const mutate of [
    (flow) => { flow[0].outputs = 4; },
    (flow) => { flow[0].wires[4] = ["wrong"]; },
    (flow) => { flow.find(({ id }) => id === ids.confirmResolve).wires[3] = ["wrong"]; },
    (flow) => { flow.find(({ id }) => id === ids.atomicRouter).func = "return null;"; },
    (flow) => { flow.find(({ id }) => id === ids.ledgerFind).collection = "wrong"; },
    (flow) => { flow.find(({ id }) => id === ids.ledgerUpdate).clientNode = "wrong"; },
    (flow) => { flow.find(({ id }) => id === ids.mongoCatch).scope = []; },
    (flow) => { flow.find(({ id }) => id === ids.mongoError).wires = [[], []]; },
    (flow) => { flow.find(({ id }) => id === ids.debug).active = true; },
    (flow) => { flow.find(({ id }) => id === ids.response).type = "debug"; },
  ]) {
    const flow = validFlow();
    mutate(flow);
    assert.throws(() => assertPiterAtomicTopology(flow), /Piter atomic topology precondition failed/);
  }
});

test("legacy Piter paths remain disabled and function-only composition stays blocked", () => {
  assert.equal(assertNoEnabledLegacyPiterSalesTab([
    { id: "8ccb70ac6befff79", type: "tab", label: "Media2", disabled: true },
  ]), true);
  assert.throws(() => assertNoEnabledLegacyPiterSalesTab([
    { id: "8ccb70ac6befff79", type: "tab", label: "Media2", disabled: false },
  ]), /enabled legacy Media2/);

  const currentRouter = fs.readFileSync(
    path.join(FUNCTION_DIR, "fn_tournament_subscription_purchase_router.js"),
    "utf8",
  );
  assert.throws(
    () => rejectTopologyDependentPiterSource(currentRouter, "fixture"),
    /cannot compose the topology-dependent Piter purchase router/,
  );
  assert.equal(rejectTopologyDependentPiterSource("return msg;", "fixture"), true);
});
