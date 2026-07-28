import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_PATH = path.resolve(ROOT, process.env.NODERED_SOURCE_PATH || "node-red/modular/source.flow.json");
const IMPORT_PATH = path.resolve(ROOT, process.env.PADEL_DAY_IMPORT_PATH || "node-red/modular/imports/lk_padel_day.import.json");
const NODES_IMPORT_PATH = path.resolve(ROOT, process.env.PADEL_DAY_NODES_IMPORT_PATH || "node-red/modular/imports/lk_padel_day.nodes.import.json");
const FUNCTIONS_DIR = path.resolve(ROOT, "scripts/nodered_padel_day_nodes");
const TAB_ID = "lk_padel_day_5245";
const TAB_LABEL = "LK Padel Day";
const COLLECTION = "lk_padel_day_transactions";
const WAITLIST_COLLECTION = "lk_padel_day_waitlist";

const IDS = {
  guardIn: "pd5245_guard_in",
  guardPrepare: "pd5245_guard_prepare",
  profileRequest: "pd5245_profile_request",
  profileResolve: "pd5245_profile_resolve",
  bookingsRequest: "pd5245_bookings_request",
  bookingsResolve: "pd5245_bookings_resolve",
  exerciseRequest: "pd5245_exercise_request",
  exerciseResolve: "pd5245_exercise_resolve",
  lockAdapt: "pd5245_lock_adapt",
  lockMongo: "pd5245_lock_mongo",
  lockResponse: "pd5245_lock_response",
  lockCatch: "pd5245_lock_catch",
  lockError: "pd5245_lock_error",
  guardHttpResponse: "pd5245_guard_http_response",
  mutationIn: "pd5245_mutation_in",
  mutationPrepare: "pd5245_mutation_prepare",
  mutationAdapt: "pd5245_mutation_adapt",
  mutationMongo: "pd5245_mutation_mongo",
  mutationResponse: "pd5245_mutation_response",
  mutationHttpResponse: "pd5245_mutation_http_response",
  optionsGuardIn: "pd5245_options_guard_in",
  optionsMutationIn: "pd5245_options_mutation_in",
  waitlistIn: "pd5245_waitlist_in",
  waitlistPrepare: "pd5245_waitlist_prepare",
  waitlistAdapt: "pd5245_waitlist_adapt",
  waitlistMongo: "pd5245_waitlist_mongo",
  waitlistResponse: "pd5245_waitlist_response",
  waitlistHttpResponse: "pd5245_waitlist_http_response",
  optionsWaitlistIn: "pd5245_options_waitlist_in",
  optionsFn: "pd5245_options_fn",
  optionsResponse: "pd5245_options_response",
  debug: "pd5245_debug",
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const fn = (name) => fs.readFileSync(path.join(FUNCTIONS_DIR, name), "utf8");

function resolveMongoClient(flow) {
  const clients = new Set(flow.filter((node) => node?.type === "mongodb4-client").map((node) => node.id));
  const usage = new Map();
  flow.filter((node) => node?.type === "mongodb4" && clients.has(node.clientNode)).forEach((node) => {
    usage.set(node.clientNode, (usage.get(node.clientNode) || 0) + 1);
  });
  const ranked = [...clients].sort((left, right) => (usage.get(right) || 0) - (usage.get(left) || 0));
  if (!ranked[0]) throw new Error("Unable to resolve MongoDB4 client for LK Padel Day");
  return ranked[0];
}

function functionNode(id, name, source, outputs, x, y, wires) {
  return { id, type: "function", z: TAB_ID, name, func: source, outputs, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires };
}

function httpRequest(id, name, x, y, target) {
  return {
    id, type: "http request", z: TAB_ID, name, method: "use", ret: "obj", paytoqs: "ignore", url: "",
    requestTimeout: "20000", senderr: true, persist: false, authType: "", insecureHTTPParser: false,
    x, y, wires: [[target]],
  };
}

function mongoNode(id, name, clientNode, x, y, target, collection = COLLECTION) {
  return {
    id, type: "mongodb4", z: TAB_ID, name, collection, operation: "updateOne", clientNode,
    mode: "collection", output: "toArray", maxTimeMS: "0", handleDocId: false, x, y,
    wires: target ? [[target]] : [[]],
  };
}

function buildNodes(clientNode) {
  const lockAdapt = [
    "const query = msg.query || {};",
    "const update = msg.payload || {};",
    "msg.payload = [query, update, { upsert: true }];",
    "delete msg.query;",
    "return msg;",
  ].join("\n");
  const mutationAdapt = [
    "const query = msg.query || {};",
    "const update = msg.payload || {};",
    "msg.payload = [query, update, { upsert: false }];",
    "delete msg.query;",
    "return msg;",
  ].join("\n");

  return [
    { id: TAB_ID, type: "tab", label: TAB_LABEL, disabled: false, info: "Atomic booking gate for Viva direction.id=5245." },
    { id: IDS.guardIn, type: "http in", z: TAB_ID, name: "LK Padel Day acquire guard", url: "/lk/padel-day/guard", method: "post", upload: false, swaggerDoc: "", x: 170, y: 120, wires: [[IDS.guardPrepare]] },
    functionNode(IDS.guardPrepare, "Validate Padel Day guard", fn("fn_padel_day_guard_prepare.js"), 2, 440, 120, [[IDS.profileRequest], [IDS.guardHttpResponse]]),
    httpRequest(IDS.profileRequest, "Viva Padel Day profile", 720, 100, IDS.profileResolve),
    functionNode(IDS.profileResolve, "Resolve Padel Day profile", fn("fn_padel_day_guard_profile.js"), 2, 990, 100, [[IDS.bookingsRequest], [IDS.guardHttpResponse]]),
    httpRequest(IDS.bookingsRequest, "Viva active Padel Day bookings", 1280, 100, IDS.bookingsResolve),
    functionNode(IDS.bookingsResolve, "Reject duplicate Padel Day booking", fn("fn_padel_day_guard_bookings.js"), 2, 1580, 100, [[IDS.exerciseRequest], [IDS.guardHttpResponse]]),
    httpRequest(IDS.exerciseRequest, "Viva Padel Day exercise", 1860, 100, IDS.exerciseResolve),
    functionNode(IDS.exerciseResolve, "Validate Padel Day exercise and lock", fn("fn_padel_day_guard_exercise.js"), 2, 2140, 100, [[IDS.lockAdapt], [IDS.guardHttpResponse]]),
    functionNode(IDS.lockAdapt, "Padel Day lock -> mongodb4 args", lockAdapt, 1, 2400, 100, [[IDS.lockMongo]]),
    mongoNode(IDS.lockMongo, "Acquire atomic Padel Day lock", clientNode, 2670, 100, IDS.lockResponse),
    functionNode(IDS.lockResponse, "Build Padel Day guard response", fn("fn_padel_day_guard_response.js"), 1, 2940, 100, [[IDS.guardHttpResponse]]),
    { id: IDS.lockCatch, type: "catch", z: TAB_ID, name: "Catch Padel Day lock conflict", scope: [IDS.lockMongo], uncaught: false, x: 2390, y: 180, wires: [[IDS.lockError]] },
    functionNode(IDS.lockError, "Map Padel Day lock conflict", fn("fn_padel_day_guard_mongo_error.js"), 1, 2680, 180, [[IDS.guardHttpResponse]]),
    { id: IDS.guardHttpResponse, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, x: 3230, y: 120, wires: [] },

    { id: IDS.mutationIn, type: "http in", z: TAB_ID, name: "LK Padel Day guard mutation", url: "/lk/padel-day/guard/:guardId/:action", method: "post", upload: false, swaggerDoc: "", x: 200, y: 300, wires: [[IDS.mutationPrepare]] },
    functionNode(IDS.mutationPrepare, "Prepare Padel Day guard mutation", fn("fn_padel_day_guard_mutation_prepare.js"), 2, 500, 300, [[IDS.mutationAdapt], [IDS.mutationHttpResponse]]),
    functionNode(IDS.mutationAdapt, "Padel Day mutation -> mongodb4 args", mutationAdapt, 1, 820, 280, [[IDS.mutationMongo]]),
    mongoNode(IDS.mutationMongo, "Update Padel Day guard", clientNode, 1100, 280, IDS.mutationResponse),
    functionNode(IDS.mutationResponse, "Build Padel Day mutation response", fn("fn_padel_day_guard_mutation_response.js"), 1, 1380, 280, [[IDS.mutationHttpResponse]]),
    { id: IDS.mutationHttpResponse, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, x: 1680, y: 300, wires: [] },

    { id: IDS.optionsGuardIn, type: "http in", z: TAB_ID, name: "OPTIONS Padel Day guard", url: "/lk/padel-day/guard", method: "options", upload: false, swaggerDoc: "", x: 200, y: 440, wires: [[IDS.optionsFn]] },
    { id: IDS.optionsMutationIn, type: "http in", z: TAB_ID, name: "OPTIONS Padel Day mutation", url: "/lk/padel-day/guard/:guardId/:action", method: "options", upload: false, swaggerDoc: "", x: 220, y: 480, wires: [[IDS.optionsFn]] },
    { id: IDS.waitlistIn, type: "http in", z: TAB_ID, name: "LK Padel Day waitlist", url: "/lk/padel-day/waitlist", method: "post", upload: false, swaggerDoc: "", x: 160, y: 520, wires: [[IDS.waitlistPrepare]] },
    functionNode(IDS.waitlistPrepare, "Validate Padel Day waitlist", fn("fn_padel_day_waitlist_prepare.js"), 2, 430, 520, [[IDS.waitlistAdapt], [IDS.waitlistHttpResponse]]),
    functionNode(IDS.waitlistAdapt, "Padel Day waitlist -> mongodb4 args", lockAdapt, 1, 730, 500, [[IDS.waitlistMongo]]),
    mongoNode(IDS.waitlistMongo, "Upsert Padel Day waitlist", clientNode, 1010, 500, IDS.waitlistResponse, WAITLIST_COLLECTION),
    functionNode(IDS.waitlistResponse, "Build Padel Day waitlist response", fn("fn_padel_day_waitlist_response.js"), 1, 1310, 500, [[IDS.waitlistHttpResponse]]),
    { id: IDS.waitlistHttpResponse, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, x: 1620, y: 520, wires: [] },

    { id: IDS.optionsWaitlistIn, type: "http in", z: TAB_ID, name: "OPTIONS Padel Day waitlist", url: "/lk/padel-day/waitlist", method: "options", upload: false, swaggerDoc: "", x: 200, y: 640, wires: [[IDS.optionsFn]] },
    functionNode(IDS.optionsFn, "Padel Day CORS preflight", fn("fn_padel_day_options.js"), 1, 520, 640, [[IDS.optionsResponse]]),
    { id: IDS.optionsResponse, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, x: 810, y: 640, wires: [] },
    { id: IDS.debug, type: "debug", z: TAB_ID, name: "Padel Day gate debug", active: false, tosidebar: true, console: false, tostatus: false, complete: "payload", targetType: "msg", statusVal: "", statusType: "auto", x: 1120, y: 700, wires: [] },
  ];
}

function validate(flow, clientNode) {
  const ids = new Set(flow.map((node) => node.id));
  for (const node of flow.filter((item) => item.z === TAB_ID)) {
    for (const output of node.wires || []) {
      for (const target of output || []) if (!ids.has(target)) throw new Error(`Dangling Padel Day wire: ${node.id} -> ${target}`);
    }
  }
  const expectedRoutes = [
    ["post", "/lk/padel-day/guard"],
    ["post", "/lk/padel-day/guard/:guardId/:action"],
    ["options", "/lk/padel-day/guard"],
    ["options", "/lk/padel-day/guard/:guardId/:action"],
    ["post", "/lk/padel-day/waitlist"],
    ["options", "/lk/padel-day/waitlist"],
  ];
  expectedRoutes.forEach(([method, url]) => {
    const count = flow.filter((node) => node.type === "http in" && node.method === method && node.url === url).length;
    if (count !== 1) throw new Error(`Expected one ${method.toUpperCase()} ${url}, found ${count}`);
  });
  const mongoNodes = flow.filter((node) => node.type === "mongodb4" && node.z === TAB_ID);
  if (mongoNodes.some((node) => node.clientNode !== clientNode)) throw new Error("Padel Day nodes use inconsistent Mongo config");
}

const flow = readJson(SOURCE_PATH);
if (!Array.isArray(flow)) throw new Error("Node-RED source flow must be an array");
const clientNode = resolveMongoClient(flow);
const managedIds = new Set([TAB_ID, ...Object.values(IDS)]);
const cleaned = flow.filter((node) => !managedIds.has(node.id) && node.z !== TAB_ID && !(node.type === "tab" && node.label === TAB_LABEL));
const nodes = buildNodes(clientNode);
const next = [...cleaned, ...nodes];
validate(next, clientNode);
writeJson(SOURCE_PATH, next);
writeJson(IMPORT_PATH, nodes);
writeJson(NODES_IMPORT_PATH, nodes.filter((node) => node.type !== "tab"));
console.log(`Patched ${SOURCE_PATH} with ${nodes.length - 1} LK Padel Day nodes using Mongo ${clientNode}.`);
console.log(`Import written: ${IMPORT_PATH}`);
