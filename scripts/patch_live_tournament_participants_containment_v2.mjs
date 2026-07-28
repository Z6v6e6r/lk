#!/usr/bin/env node

/**
 * Upgrades the live /lk/tournaments/participants containment path from the
 * 2026-07-19 waiter-based patch to bounded stale-while-revalidate semantics.
 *
 * Usage:
 *   node scripts/patch_live_tournament_participants_containment_v2.mjs input.json output.json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/patch_live_tournament_participants_containment_v2.mjs input.json output.json");
}

const EXPECTED_SOURCE_SHA256 = "4e51d3154dc60c29a7f29ad332bddd4f0aa243099ed39f3144039c651c9f2f3f";
const TAB_ID = "f9575c8726e29196";
const fnDir = path.resolve(process.cwd(), "scripts/nodered_tournament_participants_nodes");
const ids = {
  httpIn: "e0836350a9474a78",
  validate: "4970937254c10761",
  normalize: "efa2b09c651dac1f",
  clientRequest: "21d3e90986ed5b82",
  clientHttp: "8f038c84aa896ec2",
  attachRating: "0c63087697cb16c0",
  join: "22d45839d507e03b",
  response: "afef710ac9f58b69",
  cacheGate: "lk_tournament_participants_cache_gate_20260719",
  terminal: "lk_tournament_participants_terminal_20260719",
  upstreamError: "lk_tournament_participants_upstream_error_20260719",
  clientQueue: "lk_tournament_participants_client_queue_20260719",
  clientRelease: "lk_tournament_participants_client_release_20260719",
};
const expectedFunctionHashes = {
  [ids.normalize]: "501349e9d3452c45b7d1e00384702d03280c24afc2f1f603aede99fd0fb24421",
  [ids.clientRequest]: "9bfbc0699b94041df80c1fde03be776094a20db5e9307df364b880284cc30b35",
  [ids.attachRating]: "1908b5390465ca72429c12c669bd0bab1006fb122bc2843377bd7e1013385a12",
  [ids.cacheGate]: "24e223afa491814bfc7605bf5d3b0b878c8dd81899c57a5258eb089e07db91dc",
  [ids.terminal]: "c769bbebb0cc0ae141d2e0720689aed6ad81ab170c45e1daeb55b5d7c8a846e0",
  [ids.upstreamError]: "50632f8bfc0aec0bcb84009990702e59612010ac7aa35724c4bac1e96334afce",
  [ids.clientQueue]: "2fb1766cfacd33d524ce8baa2ee5d2150387d53bb5436e23359a89a5b6912a15",
  [ids.clientRelease]: "91c43f2853e753c1451cfcdd70d89057b40b006756064667086fdc04e5c4e91b",
};

const source = await readFile(inputPath);
const sourceSha256 = createHash("sha256").update(source).digest("hex");
if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
  throw new Error(
    `Refusing to patch an unexpected live flow: got ${sourceSha256}, expected ${EXPECTED_SOURCE_SHA256}`,
  );
}

const flow = JSON.parse(source);
if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");
const byId = new Map(flow.map((node) => [node.id, node]));
const requireNode = (id, type, name) => {
  const node = byId.get(id);
  if (!node || node.type !== type || node.z !== TAB_ID) {
    throw new Error(`Expected ${name} (${id}) was not found in live LK Tournaments`);
  }
  return node;
};
const readFn = async (fileName) => readFile(path.join(fnDir, fileName), "utf8");
const assertFunctionHash = (node) => {
  const expected = expectedFunctionHashes[node.id];
  const actual = createHash("sha256").update(String(node.func || "")).digest("hex");
  if (actual !== expected) {
    throw new Error(`Function ${node.name || node.id} drifted: got ${actual}, expected ${expected}`);
  }
};

const httpIn = requireNode(ids.httpIn, "http in", "participants HTTP in");
if (httpIn.url !== "/lk/tournaments/participants") {
  throw new Error("The expected participants route changed; refusing to patch");
}
const normalize = requireNode(ids.normalize, "function", "bookings normalizer");
const clientRequest = requireNode(ids.clientRequest, "function", "client request builder");
const attachRating = requireNode(ids.attachRating, "function", "rating attachment");
const cacheGate = requireNode(ids.cacheGate, "function", "participants cache gate");
const terminal = requireNode(ids.terminal, "function", "participants terminal");
const upstreamError = requireNode(ids.upstreamError, "function", "participants upstream error");
const clientQueue = requireNode(ids.clientQueue, "function", "participants client queue");
const clientRelease = requireNode(ids.clientRelease, "function", "participants client queue release");
requireNode(ids.clientHttp, "http request", "Viva client request");
requireNode(ids.join, "join", "participants join");
requireNode(ids.response, "http response", "participants HTTP response");

[
  normalize,
  clientRequest,
  attachRating,
  cacheGate,
  terminal,
  upstreamError,
  clientQueue,
  clientRelease,
].forEach(assertFunctionHash);

cacheGate.name = "Participants bounded cache gate v2";
cacheGate.func = await readFn("fn_cache_gate_v2.js");
cacheGate.outputs = 2;
cacheGate.wires = [[ids.validate], [ids.terminal]];

terminal.name = "Participants cache terminal v2";
terminal.func = await readFn("fn_terminal_v2.js");
terminal.outputs = 1;
terminal.wires = [[ids.response]];

upstreamError.name = "Participants Viva circuit error v2";
upstreamError.func = await readFn("fn_upstream_error_v2.js");
upstreamError.outputs = 1;
upstreamError.wires = [[ids.terminal]];

normalize.func = await readFn("fn_normalize_bookings_v2.js");
normalize.outputs = 3;
normalize.wires = [["517cb87b7425ef66"], [ids.upstreamError], [ids.terminal]];

clientRequest.func = await readFn("fn_build_client_request_v2.js");
clientRequest.outputs = 2;
clientRequest.wires = [[ids.join], [ids.clientQueue]];

clientQueue.name = "Viva client queue v2 (3 active / 30 queued)";
clientQueue.func = await readFn("fn_client_queue_v2.js");
clientQueue.outputs = 2;
clientQueue.wires = [[ids.clientHttp], [ids.join]];

clientRelease.name = "Release Viva client queue slot v2";
clientRelease.func = await readFn("fn_client_release_v2.js");
clientRelease.outputs = 2;
clientRelease.wires = [[ids.clientHttp], [ids.join]];

attachRating.func = await readFn("fn_attach_rating_v2.js");
attachRating.outputs = 1;
attachRating.wires = [[ids.clientRelease, "0172ee848e9f2364"]];

const outputText = `${JSON.stringify(flow, null, 2)}\n`;
await writeFile(outputPath, outputText);
const importPath = outputPath.replace(/\.json$/u, ".import.json");
const importIds = new Set([
  ids.normalize,
  ids.clientRequest,
  ids.attachRating,
  ids.cacheGate,
  ids.terminal,
  ids.upstreamError,
  ids.clientQueue,
  ids.clientRelease,
]);
await writeFile(importPath, `${JSON.stringify(flow.filter((node) => importIds.has(node.id)), null, 2)}\n`);

console.log(JSON.stringify({
  sourceSha256,
  outputSha256: createHash("sha256").update(outputText).digest("hex"),
  importPath,
  importNodes: importIds.size,
  queueWires: clientQueue.wires,
  releaseWires: clientRelease.wires,
}));
