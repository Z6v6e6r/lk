#!/usr/bin/env node
// Preimage check for the additive residency-lifecycle import.
//
// Usage:
//   node preimage-check.mjs --flows /private/flows.json [--import ./lk_residency_lifecycle.import.json]
//        [--expect-nodes 5678] [--expect-http-in 316]
//
// It proves that the exact candidate can be added without editing an existing node:
// the live preimage has no lifecycle node id, no lifecycle http-in route, and the
// import's routes/ids do not collide. It prints a SHA-256 of the preimage so the
// operator can pin the applied bytes. It never writes to the flow.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf("--" + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const flowsPath = option("flows", "");
const importPath = option("import", path.join(here, "lk_residency_lifecycle.import.json"));
const expectNodes = option("expect-nodes", "");
const expectHttpIn = option("expect-http-in", "");
if (!flowsPath) {
  console.error("--flows is required");
  process.exit(2);
}
function fail(message) {
  console.error("PREIMAGE_CHECK_FAILED: " + message);
  process.exit(1);
}
function readArray(file, label) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(label + " is not valid JSON"); }
  const nodes = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.nodes) ? parsed.nodes : null;
  if (!nodes) fail(label + " is not a Node-RED flow export");
  if (nodes.some((node) => !node || typeof node !== "object" || typeof node.id !== "string")) fail(label + " has an invalid node");
  return nodes;
}
const flows = readArray(flowsPath, "preimage");
const imported = readArray(importPath, "import");
const importedHttp = imported.filter((node) => node.type === "http in")
  .map((node) => ({ method: String(node.method || "").toUpperCase(), url: String(node.url || "") }));
const liveHttp = flows.filter((node) => node.type === "http in")
  .map((node) => ({ method: String(node.method || "").toUpperCase(), url: String(node.url || ""), id: node.id }));
const liveIds = new Set(flows.map((node) => node.id));
for (const node of imported) if (liveIds.has(node.id)) fail("node id collision: " + node.id);
const liveRoutes = new Set(liveHttp.map((route) => route.method + " " + route.url));
for (const route of importedHttp) if (liveRoutes.has(route.method + " " + route.url)) fail("route collision: " + route.method + " " + route.url);
const lifecycleRoutes = liveHttp.filter((route) => /^\/lk\/residency\/(catalog|status|orders)/.test(route.url));
if (lifecycleRoutes.length) fail("preimage already contains a lifecycle route: " + lifecycleRoutes.map((route) => route.method + " " + route.url).join(", "));
const lifecycleIds = flows.filter((node) => node.id.startsWith("lk_residency_lifecycle_"));
if (lifecycleIds.length) fail("preimage already contains a lifecycle node id: " + lifecycleIds[0].id);
if (expectNodes && flows.length !== Number(expectNodes)) fail("expected " + expectNodes + " nodes, found " + flows.length);
if (expectHttpIn && liveHttp.length !== Number(expectHttpIn)) fail("expected " + expectHttpIn + " http in, found " + liveHttp.length);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(flowsPath)).digest("hex");
console.log(JSON.stringify({ ok: true, preimage: path.resolve(flowsPath), preimageSha256: sha256,
  nodes: flows.length, httpIn: liveHttp.length, importNodes: imported.length,
  importHttp: importedHttp.length, addedRoutes: importedHttp.map((route) => route.method + " " + route.url).sort() }, null, 1));
