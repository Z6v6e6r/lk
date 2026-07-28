import fs from "node:fs";
import path from "node:path";

const [flowPathArg, importPathArg] = process.argv.slice(2);
if (!flowPathArg || !importPathArg) {
  throw new Error("Usage: node apply_nodered_padel_day_import.mjs /root/.node-red/flows.json /root/.node-red/lk_padel_day.import.json");
}

const flowPath = path.resolve(flowPathArg);
const importPath = path.resolve(importPathArg);
const TAB_ID = "lk_padel_day_5245";
const TAB_LABEL = "LK Padel Day";
const ROUTES = new Set([
  "/lk/padel-day/guard",
  "/lk/padel-day/guard/:guardId/:action",
  "/lk/padel-day/waitlist",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomically(filePath, value) {
  const tmpPath = `${filePath}.tmp-padel-day-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function isManagedNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.id === TAB_ID || node.z === TAB_ID || legacyTabIds.has(node.z)) return true;
  if (node.type === "tab" && node.label === TAB_LABEL) return true;
  return node.type === "http in" && ROUTES.has(node.url);
}

const flow = readJson(flowPath);
const imported = readJson(importPath);
if (!Array.isArray(flow) || !Array.isArray(imported)) {
  throw new Error("Both flow and import must be Node-RED arrays");
}
const legacyTabIds = new Set(
  flow.filter((node) => node?.type === "tab" && node.label === TAB_LABEL).map((node) => node.id),
);

const importedTab = imported.find((node) => node.type === "tab" && node.id === TAB_ID);
if (!importedTab) throw new Error("Padel Day import does not contain its tab node");

const mongoClients = new Set(flow.filter((node) => node.type === "mongodb4-client").map((node) => node.id));
for (const node of imported.filter((item) => item.type === "mongodb4")) {
  if (!mongoClients.has(node.clientNode)) {
    throw new Error(`Required Mongo config node is absent in live flow: ${node.clientNode}`);
  }
}

const candidate = [...flow.filter((node) => !isManagedNode(node)), ...imported];
const ids = new Set(candidate.map((node) => node.id));
for (const node of candidate) {
  for (const output of node.wires || []) {
    for (const targetId of output || []) {
      if (!ids.has(targetId)) throw new Error(`Dangling wire after Padel Day import: ${node.id} -> ${targetId}`);
    }
  }
}

for (const [method, url] of [["post", "/lk/padel-day/guard"], ["post", "/lk/padel-day/guard/:guardId/:action"], ["options", "/lk/padel-day/guard"], ["options", "/lk/padel-day/guard/:guardId/:action"], ["post", "/lk/padel-day/waitlist"], ["options", "/lk/padel-day/waitlist"]]) {
  const count = candidate.filter((node) => node.type === "http in" && node.method === method && node.url === url).length;
  if (count !== 1) throw new Error(`Expected exactly one ${method.toUpperCase()} ${url}, got ${count}`);
}

const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
const backupPath = `${flowPath}.backup-padel-day-${stamp}`;
fs.copyFileSync(flowPath, backupPath);
writeJsonAtomically(flowPath, candidate);
console.log(JSON.stringify({
  ok: true,
  backupPath,
  nodesBefore: flow.length,
  nodesAfter: candidate.length,
  padelDayNodes: imported.length,
}, null, 2));
