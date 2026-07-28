import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchTournamentResultsPersistence } from "./nodered_tournament_persistence_patch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FLOW_PATH = path.join(ROOT, "node-red/modular/source.flow.json");
const FN_DIR = path.join(ROOT, "scripts/nodered_games_nodes");

const flow = JSON.parse(fs.readFileSync(SOURCE_FLOW_PATH, "utf8"));
if (!Array.isArray(flow)) {
  throw new Error("source.flow.json must contain a JSON array");
}

const readFn = (name) => fs.readFileSync(path.join(FN_DIR, name), "utf8");

const findNode = (name) => {
  const node = flow.find((item) => item?.type === "function" && item?.name === name);
  if (!node) {
    throw new Error(`Function node not found in modular source: ${name}`);
  }
  return node;
};

const replaceFunction = (name, file) => {
  const node = findNode(name);
  node.func = readFn(file);
};

const replaceAllFunctions = (name, file) => {
  const nextFunc = readFn(file);
  const nodes = flow.filter((item) => item?.type === "function" && item?.name === name);
  if (nodes.length === 0) {
    throw new Error(`Function nodes not found in modular source: ${name}`);
  }
  nodes.forEach((node) => {
    node.func = nextFunc;
  });
};

const replaceSummerSubscriptionLimitInit = () => {
  const nodes = flow.filter((item) => item?.type === "function" && item?.name === "summer_subscription_limit");
  nodes.forEach((node) => {
    node.func = [
      'global.set("summer_subscription_limit", 100);',
      'global.set("summer_subscription_friendship_limit", 5);',
      'global.set("summer_subscription_sport_limit", 132);',
      'global.set("summer_subscription_academy_limit", 125);',
      'global.set("summer_subscription_ra_limit", 5);',
    ].join("\n");
  });
};

replaceAllFunctions("Build upcoming query by phone", "fn_list_query.js");
replaceAllFunctions("Dedupe + normalize upcoming games", "fn_list_normalize.js");
replaceFunction("Prepare split leave booking cancel", "fn_split_leave_prepare.js");
replaceAllFunctions("Prepare game upsert", "fn_create.js");
replaceAllFunctions("Prepare split game payment", "fn_split_create_prepare.js");
replaceAllFunctions("Prepare split join payment", "fn_split_join_prepare.js");
replaceAllFunctions("Route Viva split payment", "fn_split_router.js");
replaceFunction("Route split leave booking cancel", "fn_split_leave_router.js");
replaceFunction("Build split cleanup query", "fn_split_cleanup_query.js");
replaceFunction("Prepare split cleanup tasks", "fn_split_cleanup_prepare.js");
replaceFunction("Route split cleanup action", "fn_split_cleanup_router.js");
replaceFunction("Build split cleanup response", "fn_split_cleanup_response.js");
replaceAllFunctions("Prepare tournament doc", "fn_tournament_prepare.js");
replaceAllFunctions("Recalculate ratings & totals", "fn_tournament_recalculate.js");
replaceAllFunctions("Update tournament -> mongodb4 args", "fn_tournament_update_args.js");
replaceAllFunctions(
  "Prepare tournament subscription counter refresh",
  "fn_tournament_subscription_counter_refresh_prepare.js",
);
replaceAllFunctions(
  "Build tournament subscription counters",
  "fn_tournament_subscription_counter_refresh_response.js",
);
replaceAllFunctions(
  "Prepare tournament subscription status",
  "fn_tournament_subscription_status_prepare.js",
);
replaceAllFunctions(
  "Build tournament subscription status",
  "fn_tournament_subscription_status_response.js",
);
replaceAllFunctions(
  "Prepare tournament subscription purchase",
  "fn_tournament_subscription_purchase_prepare.js",
);
replaceAllFunctions(
  "Check tournament subscription limit",
  "fn_tournament_subscription_purchase_limit.js",
);
replaceAllFunctions(
  "Route tournament subscription payment",
  "fn_tournament_subscription_purchase_router.js",
);
replaceAllFunctions(
  "Prepare tournament subscription confirm",
  "fn_tournament_subscription_confirm_prepare.js",
);
replaceAllFunctions(
  "Resolve tournament subscription confirm",
  "fn_tournament_subscription_confirm_resolve.js",
);
replaceSummerSubscriptionLimitInit();

const activeTournamentTab = flow.find((item) => (
  item?.type === "tab"
  && item?.label === "LK Tournaments"
  && item?.disabled !== true
));
if (!activeTournamentTab?.id) {
  throw new Error("Active LK Tournaments tab not found in modular source");
}

const findActiveTournamentNode = (type, name) => {
  const node = flow.find((item) => (
    item?.z === activeTournamentTab.id
    && item?.type === type
    && item?.name === name
  ));
  if (!node) throw new Error(`Active LK Tournaments node not found: ${name}`);
  return node;
};

const refreshCounterInject = findActiveTournamentNode(
  "inject",
  "Refresh tournament subscription counters",
);
refreshCounterInject.crontab = "00 10 * * *";
refreshCounterInject.once = true;
refreshCounterInject.onceDelay = 20;
refreshCounterInject.payloadType = "date";

const activeConfirmResolve = findActiveTournamentNode(
  "function",
  "Resolve tournament subscription confirm",
);
const activeSalesMongo = findActiveTournamentNode(
  "mongodb4",
  "Find tournament subscription record by paymentRef",
);
const activeHistoryRoute = flow.find((item) => (
  item?.z === activeTournamentTab.id
  && item?.type === "http in"
  && item?.url === "/lk/tournaments/americano/history"
));
if (!activeHistoryRoute) {
  throw new Error("Active LK Tournaments americano history route not found");
}
const activeHistoryMongo = findActiveTournamentNode(
  "mongodb4",
  "Find tournament history",
);
const activeHistoryDebugNodes = flow.filter((item) => (
  item?.z === activeTournamentTab.id
  && item?.type === "debug"
  && item?.name === "Americano save payload"
));
const activeHistoryDebugIds = new Set(activeHistoryDebugNodes.map((node) => node.id));
const reconcileIds = {
  inject: "ab1e202650000001",
  query: "ab1e202650000002",
  mongo: "ab1e202650000003",
  split: "ab1e202650000004",
  delay: "ab1e202650000005",
  record: "ab1e202650000006",
};

activeHistoryRoute.wires = (activeHistoryRoute.wires || []).map((targets) => (
  Array.isArray(targets)
    ? targets.filter((targetId) => !activeHistoryDebugIds.has(targetId))
    : targets
));
activeHistoryDebugNodes.forEach((node) => {
  node.active = false;
});
activeHistoryMongo.limit = "1";
activeHistoryMongo.maxTimeMS = "5000";

const upsertNode = (node) => {
  const index = flow.findIndex((item) => item?.id === node.id);
  if (index >= 0) {
    flow[index] = { ...flow[index], ...node };
  } else {
    flow.push(node);
  }
};

patchTournamentResultsPersistence(flow);

upsertNode({
  id: reconcileIds.inject,
  type: "inject",
  z: activeTournamentTab.id,
  name: "Reconcile tournament subscription payments",
  props: [{ p: "payload" }, { p: "topic", vt: "str" }],
  repeat: "120",
  crontab: "",
  once: true,
  onceDelay: 20,
  topic: "",
  payload: "",
  payloadType: "date",
  x: 230,
  y: 2280,
  wires: [[reconcileIds.query]],
});
upsertNode({
  id: reconcileIds.query,
  type: "function",
  z: activeTournamentTab.id,
  name: "Prepare tournament subscription reconciliation",
  func: readFn("fn_tournament_subscription_reconcile_query.js"),
  outputs: 1,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 550,
  y: 2280,
  wires: [[reconcileIds.mongo]],
});
upsertNode({
  id: reconcileIds.mongo,
  type: "mongodb4",
  z: activeTournamentTab.id,
  clientNode: activeSalesMongo.clientNode,
  mode: "collection",
  collection: "lk_tournament_subscription_sales",
  operation: "find",
  output: "toArray",
  maxTimeMS: "15000",
  handleDocId: false,
  name: "Find pending tournament subscription payments",
  x: 870,
  y: 2280,
  wires: [[reconcileIds.split]],
});
upsertNode({
  id: reconcileIds.split,
  type: "split",
  z: activeTournamentTab.id,
  name: "Split pending tournament subscription payments",
  splt: "\\n",
  spltType: "str",
  arraySplt: 1,
  arraySpltType: "len",
  stream: false,
  addname: "",
  property: "payload",
  x: 1160,
  y: 2280,
  wires: [[reconcileIds.delay]],
});
upsertNode({
  id: reconcileIds.delay,
  type: "delay",
  z: activeTournamentTab.id,
  name: "Rate limit tournament subscription reconciliation",
  pauseType: "rate",
  timeout: "1",
  timeoutUnits: "seconds",
  rate: "1",
  nbRateUnits: "1",
  rateUnits: "second",
  randomFirst: "1",
  randomLast: "5",
  randomUnits: "seconds",
  drop: false,
  allowrate: false,
  outputs: 1,
  x: 1480,
  y: 2280,
  wires: [[reconcileIds.record]],
});
upsertNode({
  id: reconcileIds.record,
  type: "function",
  z: activeTournamentTab.id,
  name: "Prepare pending subscription confirmation",
  func: readFn("fn_tournament_subscription_reconcile_record.js"),
  outputs: 1,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1790,
  y: 2280,
  wires: [[activeConfirmResolve.id]],
});

replaceAllFunctions(
  "Route tournament subscription reconcile",
  "fn_tournament_subscription_reconcile_router.js",
);

fs.writeFileSync(SOURCE_FLOW_PATH, `${JSON.stringify(flow, null, 2)}\n`);
console.log("Updated modular LK Games function nodes from scripts/nodered_games_nodes");
