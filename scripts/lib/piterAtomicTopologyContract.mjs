import crypto from "node:crypto";
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
  mongoClient: "4e820638cc39c730",
});

// Source contract for quota-aware candidates; not a binding to an installed flow.
export const PITER_ATOMIC_ROUTER_SHA256 = "7283aec32b1a9e9b3c3ae0d76bc14d1214c4b2a27b9d4a8821619e61149deaf4";
export const PITER_TOPOLOGY_DEPENDENT_PURCHASE_ROUTER_SHA256 = "28cda3933e4ec72690e451a36e883e22157f8c6624cb23a0f12f1f8b9f6056f7";
export const PITER_ATOMIC_BINDING_INITIALIZER_SOURCE = `const key = "summer_subscription_piter_friendship_product_id";
const expectedProductId = "8bf334ba-3050-4017-b40a-7eef2db1eb16";
const currentProductId = String(global.get(key) ?? "").trim();
if (currentProductId && currentProductId !== expectedProductId) {
  throw new Error("Piter subscription product binding mismatch");
}
global.set(key, expectedProductId);
`;
export const PITER_ATOMIC_BINDING_INITIALIZER_SHA256 = "a75f370ed3fb43b61ff93cf17a97499ad46a4929e50de6f697589ef88d88d5c9";
export const PITER_ATOMIC_ERROR_SOURCE = `msg.statusCode = 503;
msg.headers = {"Content-Type":"application/json; charset=utf-8"};
msg.payload = {error:"Хранилище временно недоступно",details:{code:"PITER_ATOMIC_MONGO_ERROR"}};
return [msg,msg];
`;
export const PITER_ATOMIC_ERROR_SHA256 = "2e27be3e1b560b41c3000f2c76e4ee2a410e8a2f2d5b86ef960c00f552c51787";

const fail = (message) => {
  throw new Error(`Piter atomic topology precondition failed: ${message}`);
};
const sha256 = (value) => crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
if (sha256(PITER_ATOMIC_ERROR_SOURCE) !== PITER_ATOMIC_ERROR_SHA256) {
  fail("checked-in Mongo error source hash mismatch");
}
if (sha256(PITER_ATOMIC_BINDING_INITIALIZER_SOURCE) !== PITER_ATOMIC_BINDING_INITIALIZER_SHA256) {
  fail("checked-in product binding initializer hash mismatch");
}

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

const assertExactFunctionNode = (flow, expected, expectedSourceSha256) => {
  const node = exactNode(flow, expected.id);
  const { func, ...actualWithoutFunc } = node;
  if (!isDeepStrictEqual(actualWithoutFunc, expected)) fail(`${expected.id} node fields mismatch`);
  if (sha256(func) !== expectedSourceSha256) fail(`${expected.id}.func mismatch`);
};

export function assertNoEnabledLegacyPiterSalesTab(flow) {
  const legacyTab = exactNode(flow, "8ccb70ac6befff79");
  if (legacyTab.type !== "tab" || legacyTab.label !== "Media2") {
    fail("legacy Media2 tab identity mismatch");
  }
  if (legacyTab.disabled !== true) {
    fail("enabled legacy Media2 requires a separate exact atomic topology contract");
  }
  return true;
}

export function rejectTopologyDependentPiterSource(source, context) {
  if (sha256(source) === PITER_TOPOLOGY_DEPENDENT_PURCHASE_ROUTER_SHA256) {
    fail(`${context} cannot compose the topology-dependent Piter purchase router`);
  }
  return true;
}

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
  assertExactFunctionNode(flow, {
    id: ids.atomicRouter,
    type: "function",
    z: ids.tab,
    name: "Route atomic Piter subscription sale",
    outputs: 5,
    timeout: "",
    noerr: 0,
    initialize: PITER_ATOMIC_BINDING_INITIALIZER_SOURCE,
    finalize: "",
    libs: [],
    x: 2750,
    y: 2240,
    wires: [[ids.ledgerFind], [ids.ledgerUpdate], [ids.saleUpdate], [ids.response], [ids.viva]],
  }, PITER_ATOMIC_ROUTER_SHA256);
  for (const [id, name, operation, y] of [
    [ids.ledgerFind, "Find Piter atomic inventory ledger", "find", 2180],
    [ids.ledgerUpdate, "CAS Piter atomic inventory ledger", "updateOne", 2220],
    [ids.saleUpdate, "Persist Piter atomic sale", "updateOne", 2260],
  ]) {
    const node = exactNode(flow, id);
    if (!isDeepStrictEqual(node, {
      id,
      type: "mongodb4",
      z: ids.tab,
      clientNode: ids.mongoClient,
      mode: "collection",
      name,
      collection: "lk_tournament_subscription_sales",
      operation,
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      x: 3140,
      y,
      wires: [[ids.atomicRouter]],
    })) fail(`${id} node fields mismatch`);
  }
  const mongoCatch = exactNode(flow, ids.mongoCatch);
  if (!isDeepStrictEqual(mongoCatch, {
    id: ids.mongoCatch,
    type: "catch",
    z: ids.tab,
    name: "Catch Piter atomic Mongo errors",
    scope: [ids.ledgerFind, ids.ledgerUpdate, ids.saleUpdate],
    uncaught: false,
    x: 2780,
    y: 2320,
    wires: [[ids.mongoError]],
  })) fail(`${ids.mongoCatch} node fields mismatch`);
  assertExactFunctionNode(flow, {
    id: ids.mongoError,
    type: "function",
    z: ids.tab,
    name: "Redact Piter atomic Mongo error",
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 3150,
    y: 2320,
    wires: [[ids.response], [ids.debug]],
  }, PITER_ATOMIC_ERROR_SHA256);
  assertNode(flow, ids.mongoClient, { type: "mongodb4-client" });
  assertNode(flow, ids.viva, { type: "http request", z: ids.tab });
  assertNode(flow, ids.response, { type: "http response", z: ids.tab });
  assertNode(flow, ids.debug, {
    type: "debug",
    z: ids.tab,
    name: "tournament subscription payment debug",
    active: false,
  });
  return true;
}
