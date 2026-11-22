#!/usr/bin/env node
/**
 * Additive install preparation for the residency lifecycle flow.
 *
 * Reads a live Node-RED flows.json preimage and the reviewed import, verifies that every
 * node id and every (method,url) is free, appends the 19 new nodes and writes a candidate
 * plus a report. It never connects to a host, restarts Node-RED, edits an existing node or
 * writes to the live file. Applying the candidate is a separate approved operation.
 *
 * Usage:
 *   node scripts/prepare_lk_residency_lifecycle_install.mjs \
 *     --preimage /private/live/flows.json \
 *     --import node-red/imports/lk_residency_lifecycle.import.json \
 *     --candidate /private/candidate/flows.json \
 *     --report /private/candidate/report.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  const error = new Error(message);
  error.code = "RESIDENCY_INSTALL_REFUSED";
  throw error;
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail("Unexpected argument: " + key);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) fail("Missing value for " + key);
    values[key.slice(2)] = value;
    i += 1;
  }
  return values;
}

function readArray(file, label) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(label + " is not valid JSON"); }
  if (!Array.isArray(parsed)) fail(label + " must be a Node-RED flows array");
  return parsed;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function prepareInstall({ preimage, importFile, candidate, report }) {
  if (!preimage || !importFile || !candidate || !report) {
    fail("--preimage, --import, --candidate and --report are required");
  }
  const live = readArray(preimage, "preimage");
  const incoming = readArray(importFile, "import");
  if (!incoming.length) fail("The import is empty");
  if (incoming.length > 500) fail("The import is unexpectedly large");

  const liveIds = new Set();
  const liveRoutes = new Set();
  for (const node of live) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || !node.id) fail("The preimage has a node without an id");
    if (liveIds.has(node.id)) fail("The preimage already contains duplicate id " + node.id);
    liveIds.add(node.id);
    if (node.type === "http in" && typeof node.url === "string") {
      liveRoutes.add(String(node.method || "").toUpperCase() + " " + node.url);
    }
  }

  const incomingIds = new Set();
  const incomingRoutes = new Set();
  for (const node of incoming) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || !node.id) fail("The import has a node without an id");
    if (incomingIds.has(node.id)) fail("The import repeats id " + node.id);
    incomingIds.add(node.id);
    if (liveIds.has(node.id)) fail("Node id already exists in the live graph: " + node.id);
    if (node.type === "http in") {
      const route = String(node.method || "").toUpperCase() + " " + node.url;
      if (incomingRoutes.has(route)) fail("The import repeats route " + route);
      if (liveRoutes.has(route)) fail("Route already exists in the live graph: " + route);
      if (!String(node.url).startsWith("/lk/residency/")) fail("Unexpected route namespace: " + route);
      incomingRoutes.add(route);
    }
  }

  const merged = [...live, ...incoming];
  const candidateDir = path.dirname(candidate);
  const reportDir = path.dirname(report);
  for (const dir of [candidateDir, reportDir]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail("Output directory does not exist: " + dir);
  }
  if (fs.existsSync(candidate)) fail("Candidate already exists and is never overwritten: " + candidate);
  if (fs.existsSync(report)) fail("Report already exists and is never overwritten: " + report);

  fs.writeFileSync(candidate, JSON.stringify(merged), { mode: 0o600, flag: "wx" });
  const result = {
    schemaVersion: 1,
    action: "ADDITIVE_NODE_RED_IMPORT_CANDIDATE",
    preimage: { path: preimage, sha256: sha256(preimage), nodes: live.length },
    import: { path: importFile, sha256: sha256(importFile), nodes: incoming.length },
    candidate: { path: candidate, sha256: sha256(candidate), nodes: merged.length },
    added: {
      ids: [...incomingIds],
      routes: [...incomingRoutes].sort(),
      httpIn: incoming.filter((node) => node.type === "http in").length,
    },
    untouched: { existingNodes: live.length, replacedNodes: 0 },
    apply: "Not applied. Review this report, then use the approved Node-RED import/restart process.",
  };
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = prepareInstall({ preimage: args.preimage, importFile: args.import,
      candidate: args.candidate, report: args.report });
    console.log(JSON.stringify({ ok: true, candidate: result.candidate, added: result.added }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || "ERROR", message: error.message }));
    process.exitCode = 1;
  }
}
