import { isDeepStrictEqual } from "node:util";

export const PITER_ATOMIC_TOPOLOGY_IDS = Object.freeze({
  tab: "f9575c8726e29196",
  purchaseRouter: "566ae4b886c37ae5",
  viva: "fdc3f25f39199546",
  response: "10fe94a32b8adc35",
  debug: "03cc3ac17f7e154a",
  atomicRouter: "piter_atomic_router_20260903",
  ledgerFind: "piter_ledger_find_20260903",
  ledgerUpdate: "piter_ledger_update_20260903",
  saleUpdate: "piter_sale_update_20260903",
  mongoCatch: "piter_atomic_catch_20260903",
  mongoError: "piter_atomic_error_20260903",
});

const fail = (message) => {
  throw new Error(`Piter atomic topology precondition failed: ${message}`);
};

const exactNode = (flow, id) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`expected one node ${id}, found ${matches.length}`);
  return matches[0];
};

const assertNode = (flow, id, expected) => {
  const node = exactNode(flow, id);
  for (const [field, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(node[field], value)) fail(`${id}.${field} mismatch`);
  }
  return node;
};

export function assertPiterAtomicTopology(flow) {
  if (!Array.isArray(flow)) fail("flow must be an array");
  const ids = PITER_ATOMIC_TOPOLOGY_IDS;
  const purchaseRouter = assertNode(flow, ids.purchaseRouter, {
    type: "function",
    z: ids.tab,
    name: "Route tournament subscription payment",
    outputs: 5,
  });
  if (!Array.isArray(purchaseRouter.wires)
    || purchaseRouter.wires.length !== 5
    || !isDeepStrictEqual(purchaseRouter.wires[4], [ids.atomicRouter])) {
    fail(`${ids.purchaseRouter}.wires[4] mismatch`);
  }
  assertNode(flow, ids.atomicRouter, {
    type: "function",
    z: ids.tab,
    name: "Route atomic Piter subscription sale",
    outputs: 5,
    wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]],
  });
  for (const [id, name, operation, wire] of [
    [ids.ledgerFind, "Find Piter atomic inventory ledger", "find", ids.atomicRouter],
    [ids.ledgerUpdate, "CAS Piter atomic inventory ledger", "updateOne", ids.atomicRouter],
    [ids.saleUpdate, "Persist Piter atomic sale", "updateOne", ids.atomicRouter],
  ]) {
    assertNode(flow, id, {
      type: "mongodb4",
      z: ids.tab,
      name,
      collection: "lk_tournament_subscription_sales",
      operation,
      wires: [[wire]],
    });
  }
  assertNode(flow, ids.mongoCatch, {
    type: "catch",
    z: ids.tab,
    name: "Catch Piter atomic Mongo errors",
    scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate],
    uncaught: false,
    wires: [[ids.mongoError]],
  });
  assertNode(flow, ids.mongoError, {
    type: "function",
    z: ids.tab,
    name: "Redact Piter atomic Mongo error",
    outputs: 2,
    wires: [[ids.response], [ids.debug]],
  });
  return true;
}
