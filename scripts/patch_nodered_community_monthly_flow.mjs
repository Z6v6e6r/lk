#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { tournamentClosedExpression, TOURNAMENT_WRITE_FIELDS } from "./lib/communityMonthlyFinalization.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "scripts/nodered_community_monthly_nodes");
const sha256 = source => crypto.createHash("sha256").update(source).digest("hex");
const read = name => fs.readFileSync(path.join(directory, name + ".js"), "utf8");
const bundle = () => buildSync({ entryPoints: [path.join(root, "src/services/community-rating/monthlyContract.ts")], bundle: true, format: "iife", globalName: "CommunityMonthly", write: false, target: "es2022" }).outputFiles[0].text;
const routes = ["/lk/communities/:communityId/rating/monthly", "/lk/communities/:communityId/events"];
export function buildCommunityMonthlyFlow(flow) {
  if (!Array.isArray(flow)) throw new Error("FLOW_ARRAY_REQUIRED");
  const enabled = new Set(flow.filter(node => node.type === "tab" && node.disabled !== true).map(node => node.id));
  const canonical = flow.filter(node => node.type === "http in" && node.method === "get" && node.url === "/lk/communities/:communityId/rating" && enabled.has(node.z));
  if (canonical.length !== 1) throw new Error("CANONICAL_COMMUNITY_RATING_ROUTE_REQUIRED");
  const z = canonical[0].z;
  const clients = [...new Set(flow.filter(node => node.z === z && node.type === "mongodb4" && ["lk_communities", "community_rating_snapshots"].includes(node.collection)).map(node => node.clientNode))];
  if (clients.length !== 1 || !clients[0] || !flow.some(node => node.type === "mongodb4-client" && node.id === clients[0])) throw new Error("COMMUNITY_MONGO_CLIENT_REQUIRED");
  const prefix = "community_monthly_20261005_", id = suffix => prefix + suffix;
  const without = flow.filter(node => !String(node.id).startsWith(prefix));
  if (without.some(node => node.type === "http in" && routes.includes(node.url))) throw new Error("UNMANAGED_MONTHLY_ROUTE_EXISTS");
  const common = bundle();
  const fn = (suffix, name, body, outputs, wires, x, y) => ({ id: id(suffix), type: "function", z, name, func: common + "\n" + body, outputs, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires: wires.map(row => row.map(id)) });
  const mongo = (suffix, collection, target, x, y) => ({ id: id(suffix), type: "mongodb4", z, name: "Read " + collection, clientNode: clients[0], mode: "collection", collection, operation: "find", output: "toArray", maxTimeMS: "5000", handleDocId: false, x, y, wires: [[id(target)]] });
  const nodes = routes.map((url, index) => ({ id: id(index ? "events_in" : "monthly_in"), type: "http in", z, name: index ? "Published community events" : "Calendar-month top20", url, method: "get", upload: false, swaggerDoc: "", x: 160, y: 6300 + index * 80, wires: [[id(index ? "events_prepare" : "monthly_prepare")]] }));
  for (const route of ["monthly", "events"]) nodes.push(fn(route + "_prepare", "Prepare " + route, read("prepare").replace("return [msg, null];", `msg._communityMonthly.route = '${route}';\nreturn [msg, null];`), 2, [["community_find"], ["http_response"]], 450, route === "monthly" ? 6300 : 6380));
  nodes.push(mongo("community_find", "lk_communities", "community", 740, 6340));
  let communitySource = read("community").replace(/return \[null, error\(/g, "return [null, null, error(").replace("return [msg, null];", "return [ctx.route === 'monthly' ? msg : null, ctx.route === 'events' ? msg : null, null];");
  nodes.push(fn("community", "Verify public community", communitySource, 3, [["monthly_find"], ["feed_find"], ["http_response"]], 1060, 6340));
  nodes.push(mongo("monthly_find", "community_monthly_reports", "monthly_response", 1370, 6300));
  nodes.push(fn("monthly_response", "Monthly top20 response", read("monthly_response"), 1, [["http_response"]], 1680, 6300));
  nodes.push(mongo("feed_find", "lk_community_feed", "events_query", 1370, 6380));
  nodes.push(fn("events_query", "Resolve published game sources", read("events_query"), 1, [["games_find"]], 1680, 6380));
  nodes.push(mongo("games_find", "lk_games", "tournaments_query", 1950, 6380));
  nodes.push(fn("tournaments_query", "Resolve published tournament sources", read("tournaments_query"), 1, [["tournaments_find"]], 2240, 6380));
  nodes.push(mongo("tournaments_find", "tournaments", "events_response", 2520, 6380));
  nodes.push(fn("events_response", "Published events and signup links", read("events_response"), 1, [["http_response"]], 2810, 6380));
  nodes.push({ id: id("http_response"), type: "http response", z, name: "", statusCode: "", headers: {}, x: 3090, y: 6340, wires: [] });
  nodes.push({ id: id("catch"), type: "catch", z, name: "Community report errors", scope: nodes.filter(node => ["function", "mongodb4"].includes(node.type)).map(node => node.id), uncaught: false, x: 2240, y: 6470, wires: [[id("error")]] });
  nodes.push(fn("error", "Sanitize report errors", read("error"), 1, [["http_response"]], 2530, 6470));
  // Narrow source-driven guards on all writers that can undo automatic closure.
  const modified = [];
  for (const [nodeId, kind] of [["2e70b2e547e77c00", "write"], ["4f0f1ce8189a9e8c", "create"], ["745f991e11130b08", "ack"]]) {
    const node = without.find(item => item.id === nodeId && item.type === "function" && enabled.has(item.z));
    if (!node) throw new Error("ACTIVE_TOURNAMENT_WRITER_REQUIRED");
    const marker = `monthly_tournament_${kind}_guard_v1`;
    if (node.func.includes(marker)) { modified.push(node); continue; }
    let source = node.func;
    if (kind === "write") {
      const anchor = "const body = msg.req?.body || {};";
      if (source.split(anchor).length !== 2 || !source.trimEnd().endsWith("return msg;")) throw new Error("TOURNAMENT_RECALCULATE_PREIMAGE_MISMATCH");
      source = source.replace(anchor, read("tournament_write_header").replace("MONTHLY_WRITE_FIELDS", JSON.stringify(TOURNAMENT_WRITE_FIELDS)) + "\n" + anchor).replace(/return msg;\s*$/, read("tournament_write_tail") + "\nreturn msg;\n");
    } else if (kind === "create") {
      if (!source.trimEnd().endsWith("return [msg, null];") || !source.includes("msg._tournamentLegacySuccessPayload = msg.payload;")) throw new Error("TOURNAMENT_CREATE_PREIMAGE_MISMATCH");
      const tail = read("tournament_create_tail").replace("MONTHLY_CLOSED_EXPRESSION", JSON.stringify(tournamentClosedExpression()));
      source = source.replace(/return \[msg, null\];\s*$/, () => tail + "\nreturn [msg, null];\n");
    } else {
      const anchor = "const legacyPayload = ";
      if (source.split(anchor).length !== 2) throw new Error("TOURNAMENT_ACK_PREIMAGE_MISMATCH");
      source = source.replace(anchor, read("tournament_ack_header") + "\n" + anchor);
    }
    const guarded = { ...node, func: source };
    without[without.indexOf(node)] = guarded; modified.push(guarded);
  }
  const candidate = [...without, ...nodes], ids = new Set(candidate.map(node => node.id));
  if (ids.size !== candidate.length) throw new Error("DUPLICATE_NODE_ID");
  for (const node of candidate) for (const row of node.wires || []) for (const target of row) if (!ids.has(target)) throw new Error("BROKEN_WIRE");
  for (const node of [...nodes, ...modified]) if (node.type === "function") new Function("msg", "node", node.func);
  return { candidate, nodes: [...nodes, ...modified], sourceHashes: modified.map(node => ({ id: node.id, sourceSha256: sha256(flow.find(original => original.id === node.id).func), candidateSha256: sha256(node.func) })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  if (!["--source", "--output", "--source-sha256"].every(name => process.argv.includes(name))) throw new Error("Usage: --source /fresh/live.flow.json --output /private/candidate.json --source-sha256 <sha256>");
  const sourcePath = path.resolve(arg("--source")), output = path.resolve(arg("--output"));
  if (sourcePath === output || output.startsWith(root + path.sep)) throw new Error("EXTERNAL_NEW_CANDIDATE_REQUIRED");
  const raw = fs.readFileSync(sourcePath);
  if (sha256(raw) !== arg("--source-sha256")) throw new Error("FLOW_SOURCE_HASH_MISMATCH");
  if (Date.now() - fs.statSync(sourcePath).mtimeMs > 30 * 60 * 1000) throw new Error("FRESH_LIVE_FLOW_REQUIRED");
  const result = buildCommunityMonthlyFlow(JSON.parse(raw));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, JSON.stringify(result.candidate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(output + ".nodes.json", JSON.stringify(result.nodes, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.writeFileSync(output + ".report.json", JSON.stringify({ routes, sourceSha256: sha256(raw), candidateSha256: sha256(fs.readFileSync(output)), nodes: result.nodes.length, sourceHashes: result.sourceHashes }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ok: true, routes, nodes: result.nodes.length, candidateSha256: sha256(fs.readFileSync(output)) }));
}
