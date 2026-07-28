import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(ROOT, "scripts/nodered_games_nodes");

const PERSISTENCE_NODE_IDS = {
  router: "a73c590f8f001001",
  afterWrite: "a73c590f8f001002",
  catch: "a73c590f8f001003",
  errorResponse: "a73c590f8f001004",
};

function readFunctionSource(name) {
  return fs.readFileSync(path.join(FN_DIR, name), "utf8");
}

function asWireTargets(node) {
  return Array.isArray(node?.wires)
    ? node.wires.flat().filter(Boolean)
    : [];
}

function upsertNode(flow, node) {
  const index = flow.findIndex((item) => item?.id === node.id);
  if (index >= 0) {
    flow[index] = { ...flow[index], ...node };
  } else {
    flow.push(node);
  }
}

function findRequiredNode(flow, predicate, description) {
  const nodes = flow.filter(predicate);
  if (nodes.length !== 1) {
    throw new Error(`${description}: expected exactly one node, got ${nodes.length}`);
  }
  return nodes[0];
}

export function patchTournamentResultsPersistence(flow) {
  if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");

  const activeTournamentTab = findRequiredNode(
    flow,
    (item) => item?.type === "tab" && item?.label === "LK Tournaments" && item?.disabled !== true,
    "Active LK Tournaments tab",
  );
  const inActiveTournamentTab = (type, name) => (item) => (
    item?.z === activeTournamentTab.id && item?.type === type && item?.name === name
  );
  const route = findRequiredNode(
    flow,
    (item) => item?.z === activeTournamentTab.id
      && item?.type === "http in"
      && item?.url === "/lk/tournaments/americano/results",
    "Americano results route",
  );
  const recalculate = findRequiredNode(
    flow,
    inActiveTournamentTab("function", "Recalculate ratings & totals"),
    "Recalculate ratings & totals",
  );
  const mongoUpdateDoc = findRequiredNode(
    flow,
    inActiveTournamentTab("change", "Mongo update doc"),
    "Mongo update doc",
  );
  const updateArgs = findRequiredNode(
    flow,
    inActiveTournamentTab("function", "Update tournament -> mongodb4 args"),
    "Update tournament -> mongodb4 args",
  );
  const updateTournament = findRequiredNode(
    flow,
    inActiveTournamentTab("mongodb4", "Update tournament"),
    "Update tournament",
  );

  updateArgs.func = readFunctionSource("fn_tournament_update_args.js");

  const nodesById = new Map(flow.map((item) => [item.id, item]));
  const recalculateTargets = asWireTargets(recalculate);
  const existingRouter = nodesById.get(PERSISTENCE_NODE_IDS.router);
  const alreadyPatched = recalculateTargets.includes(PERSISTENCE_NODE_IDS.router);
  let httpResponse = null;

  if (alreadyPatched) {
    if (recalculateTargets.length !== 1 || existingRouter?.type !== "function") {
      throw new Error("Recalculate ratings & totals has an unexpected patched persistence wiring");
    }
    const responseIds = Array.isArray(existingRouter.wires?.[1])
      ? existingRouter.wires[1].filter((id) => nodesById.get(id)?.type === "http response")
      : [];
    if (responseIds.length !== 1) {
      throw new Error(`Tournament persistence router: expected one HTTP response, got ${responseIds.length}`);
    }
    httpResponse = nodesById.get(responseIds[0]);
  } else {
    const directResponseIds = recalculateTargets
      .filter((id) => nodesById.get(id)?.type === "http response");
    if (directResponseIds.length !== 1) {
      throw new Error(`Recalculate ratings & totals: expected one direct HTTP response, got ${directResponseIds.length}`);
    }
    httpResponse = nodesById.get(directResponseIds[0]);
    if (!recalculateTargets.includes(mongoUpdateDoc.id)) {
      throw new Error("Recalculate ratings & totals is not wired to Mongo update doc");
    }
  }
  if (!httpResponse?.id) throw new Error("Tournament HTTP response node not found");
  const updateArgsTargets = asWireTargets(updateArgs);
  if (!updateArgsTargets.includes(updateTournament.id)) {
    throw new Error("Update tournament -> mongodb4 args is not wired to Update tournament");
  }

  const existingRules = Array.isArray(mongoUpdateDoc.rules) ? mongoUpdateDoc.rules : [];
  mongoUpdateDoc.rules = [
    {
      t: "set",
      p: "_tournamentResponse",
      pt: "msg",
      to: "payload",
      tot: "msg",
    },
    ...existingRules.filter((rule) => !(rule?.p === "_tournamentResponse" && rule?.pt === "msg")),
  ];

  recalculate.wires = [[PERSISTENCE_NODE_IDS.router]];
  updateTournament.wires = [[PERSISTENCE_NODE_IDS.afterWrite]];

  upsertNode(flow, {
    id: PERSISTENCE_NODE_IDS.router,
    type: "function",
    z: activeTournamentTab.id,
    name: "Route tournament persistence response",
    func: readFunctionSource("fn_tournament_persist_router.js"),
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1080,
    y: 1400,
    wires: [[mongoUpdateDoc.id], [httpResponse.id]],
  });
  upsertNode(flow, {
    id: PERSISTENCE_NODE_IDS.afterWrite,
    type: "function",
    z: activeTournamentTab.id,
    name: "Build tournament persistence response",
    func: readFunctionSource("fn_tournament_update_after_write.js"),
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1880,
    y: 1340,
    wires: [[httpResponse.id]],
  });
  upsertNode(flow, {
    id: PERSISTENCE_NODE_IDS.errorResponse,
    type: "function",
    z: activeTournamentTab.id,
    name: "Build tournament persistence error",
    func: readFunctionSource("fn_tournament_write_error_response.js"),
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1760,
    y: 1480,
    wires: [[httpResponse.id]],
  });
  upsertNode(flow, {
    id: PERSISTENCE_NODE_IDS.catch,
    type: "catch",
    z: activeTournamentTab.id,
    name: "Catch tournament persistence failure",
    scope: [
      route.id,
      recalculate.id,
      PERSISTENCE_NODE_IDS.router,
      mongoUpdateDoc.id,
      updateArgs.id,
      updateTournament.id,
      PERSISTENCE_NODE_IDS.afterWrite,
    ],
    uncaught: false,
    x: 1370,
    y: 1480,
    wires: [[PERSISTENCE_NODE_IDS.errorResponse]],
  });

  return {
    tabId: activeTournamentTab.id,
    routeId: route.id,
    recalculateId: recalculate.id,
    mongoUpdateDocId: mongoUpdateDoc.id,
    updateArgsId: updateArgs.id,
    updateTournamentId: updateTournament.id,
    httpResponseId: httpResponse.id,
    ...PERSISTENCE_NODE_IDS,
  };
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const sourceIndex = process.argv.indexOf("--source");
  const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : null;
  if (!sourcePath) throw new Error("Usage: node scripts/nodered_tournament_persistence_patch.mjs --source <flow.json>");
  const absoluteSourcePath = path.resolve(sourcePath);
  const flow = JSON.parse(fs.readFileSync(absoluteSourcePath, "utf8"));
  const result = patchTournamentResultsPersistence(flow);
  fs.writeFileSync(absoluteSourcePath, `${JSON.stringify(flow, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, source: absoluteSourcePath, ...result }, null, 2));
}
