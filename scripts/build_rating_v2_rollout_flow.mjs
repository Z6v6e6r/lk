import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const basePath = getArg("--base");
const outPath = getArg("--out");
const manifestPath = getArg("--manifest");
if (!basePath || !outPath || !manifestPath) {
  throw new Error("Usage: node scripts/build_rating_v2_rollout_flow.mjs --base live.json --out rollout.json --manifest manifest.json");
}

const root = process.cwd();
const flow = JSON.parse(fs.readFileSync(path.resolve(basePath), "utf8"));
const byId = new Map(flow.map((node) => [node.id, node]));
const selected = [];
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = (node) => JSON.parse(JSON.stringify(node));

function replaceNode(id, mutate) {
  const node = byId.get(id);
  if (!node) throw new Error(`Live node missing: ${id}`);
  const before = snapshot(node);
  mutate(node);
  selected.push({ id, action: "replace", name: node.name, beforeSha256: digest(before), afterSha256: digest(node) });
}

function addNode(node) {
  if (byId.has(node.id)) throw new Error(`Add-only node already exists: ${node.id}`);
  flow.push(node);
  byId.set(node.id, node);
  selected.push({ id: node.id, action: "add", name: node.name, beforeSha256: null, afterSha256: digest(node) });
}

const readFn = (name) => fs.readFileSync(path.join(root, "scripts/nodered_result_nodes", name), "utf8");
const canonicalWrite = byId.get("127cf4d595cc30bc");
if (!canonicalWrite?.clientNode || !canonicalWrite?.z) throw new Error("Canonical rating writer context missing");

replaceNode("1dd46edba0d97ab8", (node) => {
  node.func = readFn("fn_result_rating_ledger_state_msg.js");
});
replaceNode("127cf4d595cc30bc", (node) => {
  node.collection = "player_rating_state";
  node.wires = [["result_rating_compatibility_prepare_001"]];
});
replaceNode("b6be1b085f163ad7", (node) => {
  node.collection = "player_rating_state";
});

addNode({
  id: "result_rating_compatibility_prepare_001",
  type: "function",
  z: canonicalWrite.z,
  name: "Build player_ratings compatibility projection",
  func: readFn("fn_result_rating_compatibility_msg.js"),
  outputs: 1,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2960,
  y: 3980,
  wires: [["result_rating_compatibility_write_001"]],
});
addNode({
  id: "result_rating_compatibility_write_001",
  type: "mongodb4",
  z: canonicalWrite.z,
  clientNode: canonicalWrite.clientNode,
  mode: "collection",
  collection: "player_ratings",
  operation: "updateOne",
  output: "toArray",
  maxTimeMS: canonicalWrite.maxTimeMS || "5000",
  handleDocId: false,
  name: "Project canonical state to player_ratings",
  x: 3270,
  y: 3980,
  wires: [["result_rating_ledger_projection_001"]],
});

replaceNode("d76eb463cd34bdef", (node) => {
  const before = node.func;
  node.func = before.replaceAll("community-rating-v1.1.0", "community-rating-v1.2.0");
  if (node.func === before) throw new Error("Community ranking query version marker was not replaced");
});
replaceNode("c33fafb4f5484966", (node) => {
  let next = String(node.func || "");
  next = next.replaceAll("community-rating-v1.1.0", "community-rating-v1.2.0");
  const updatedAtLine = "    updatedAt: toStr(snapshot.updatedAt) || nowIso,";
  if (!next.includes(updatedAtLine)) throw new Error("Snapshot response updatedAt marker missing");
  next = next.replace(updatedAtLine, `${updatedAtLine}\n    dataThrough: toStr(snapshot.dataThrough),\n    sourceVersion: toStr(snapshot.sourceVersion) || 'rating_events+player_rating_state+attendance-v1',\n    degraded: false,`);
  const fallback = `msg.payload = {\n  communityId: ctx.communityId,\n  archived: { $ne: true },\n  kind: { $in: ['GAME', 'TOURNAMENT'] },\n};\nreturn [null, msg, msg];`;
  if (!next.includes(fallback)) throw new Error("Live community fallback marker missing");
  next = next.replace(fallback, `const errorMsg = withJson(msg, 503, {\n  error: 'RATING_SNAPSHOT_NOT_READY',\n  communityId: ctx.communityId || null,\n  tab: normalizeRatingTab(ctx.tab),\n  period: normalizeRatingPeriod(ctx.period),\n  calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,\n  degraded: true,\n});\nreturn [errorMsg, null, errorMsg];`);
  node.func = next;
});

if (byId.get("127cf4d595cc30bc").collection !== "player_rating_state") throw new Error("Canonical state writer not switched");
if (byId.get("b6be1b085f163ad7").collection !== "player_rating_state") throw new Error("Game rating read not switched");
if (byId.get("result_rating_compatibility_write_001").collection !== "player_ratings") throw new Error("Compatibility writer missing");
if (!byId.get("c33fafb4f5484966").func.includes("RATING_SNAPSHOT_NOT_READY")) throw new Error("Degraded snapshot response missing");

const missingWires = [];
for (const node of flow) {
  for (const group of node.wires || []) {
    for (const target of group) if (!byId.has(target)) missingWires.push({ nodeId: node.id, target });
  }
}
if (missingWires.length > 0) throw new Error(`Missing wire targets: ${JSON.stringify(missingWires.slice(0, 10))}`);
if (new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Duplicate node ids");

const absoluteOut = path.resolve(outPath);
const absoluteManifest = path.resolve(manifestPath);
fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
fs.mkdirSync(path.dirname(absoluteManifest), { recursive: true });
fs.writeFileSync(absoluteOut, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
const manifest = {
  generatedAt: new Date().toISOString(),
  base: path.resolve(basePath),
  output: absoluteOut,
  baseNodeCount: flow.length - 2,
  outputNodeCount: flow.length,
  selectedNodes: selected,
  checks: {
    uniqueNodeIds: true,
    allWireTargetsExist: true,
    canonicalStateBeforeCompatibilityBeforeViva: true,
    communitySnapshotOnlyV120: true,
  },
  outputSha256: crypto.createHash("sha256").update(fs.readFileSync(absoluteOut)).digest("hex"),
};
fs.writeFileSync(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
