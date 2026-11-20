#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_tournament_participants_nodes");

export const CUP_ROSTER_PATCH_CONTRACT = Object.freeze({
  routeId: "e0836350a9474a78",
  routeUrl: "/lk/tournaments/participants",
  paymentRouteUrl: "/lk/tournaments/participants/reconcile-payment",
  tabId: "f9575c8726e29196",
  nodes: {
    validate: "4970937254c10761",
    vivaHttp: "fbbb248557014e63",
    vivaNormalize: "efa2b09c651dac1f",
    terminal: "lk_tournament_participants_terminal_20260719",
  },
  functionPreimages: {
    terminal: "b83a269ae242baab05c918bb427cda29341056494260cc34df235cd2760dbf23",
    validate: "2c898a82fa3ec2f11bbefbd1b853000ee5d9292bb828bcc42d45117d835d0a42",
    vivaNormalize: "d36e997c64327784a208a268c9a67e5f4acf365662d15f160016bccb3f01ff88",
  },
  sources: {
    lookup: "fn_cup_lookup_request_v1.js",
    publicRequest: "fn_cup_public_request_v1.js",
    normalize: "fn_cup_roster_normalize_v1.js",
    vivaFallback: "fn_cup_viva_fallback_prepare_v1.js",
    reconcilePayment: "fn_cup_reconcile_payment_v1.js",
  },
});

const NEW_IDS = Object.freeze({
  publicPrepare: "lk_tournament_participants_cup_public_prepare_20261120",
  publicHttp: "lk_tournament_participants_cup_public_http_20261120",
  publicNormalize: "lk_tournament_participants_cup_public_normalize_20261120",
  vivaFallbackPrepare: "lk_tournament_participants_cup_viva_fallback_prepare_20261120",
  vivaFallbackHttp: "lk_tournament_participants_cup_viva_fallback_http_20261120",
  paymentIn: "lk_tournament_participants_payment_in_20261120",
  paymentRouter: "lk_tournament_participants_payment_router_20261120",
  paymentHttp: "lk_tournament_participants_payment_http_20261120",
  paymentResponse: "lk_tournament_participants_payment_response_20261120",
});

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--") || index + 1 >= argv.length) fail(`Invalid argument: ${arg}`);
    values.set(arg.slice(2), argv[index + 1]);
    index += 1;
  }
  return values;
}

function readSource(name) {
  const file = CUP_ROSTER_PATCH_CONTRACT.sources[name];
  return fs.readFileSync(path.join(SOURCE_DIR, file), "utf8");
}

function exactNode(flow, id, description) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`${description} ${id} must exist exactly once`);
  return matches[0];
}

function assertFunctionHash(node, expected, description) {
  if (sha256(String(node?.func || "")) !== expected) {
    fail(`${description} ${node?.id || "unknown"} function preimage mismatch`);
  }
}

function assertFlow(flow) {
  if (!Array.isArray(flow)) fail("Node-RED source must be a JSON array");
  const ids = new Set();
  for (const node of flow) {
    if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.id !== "string" || !node.id.trim()) {
      fail("Node-RED source contains an invalid node");
    }
    if (ids.has(node.id)) fail(`Duplicate Node-RED node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const id of Object.values(NEW_IDS)) {
    if (ids.has(id)) fail(`New participants node already exists: ${id}`);
  }
  if (flow.some((node) => node.type === "http in" && node.method === "post"
    && node.url === CUP_ROSTER_PATCH_CONTRACT.paymentRouteUrl)) {
    fail("Payment reconciliation route already exists");
  }
  const route = exactNode(flow, CUP_ROSTER_PATCH_CONTRACT.routeId, "Participants route");
  if (route.type !== "http in" || route.method !== "get" || route.url !== CUP_ROSTER_PATCH_CONTRACT.routeUrl) {
    fail("Participants route contract mismatch");
  }
  const validate = exactNode(flow, CUP_ROSTER_PATCH_CONTRACT.nodes.validate, "Participants request builder");
  const vivaNormalize = exactNode(flow, CUP_ROSTER_PATCH_CONTRACT.nodes.vivaNormalize, "Participants normalize");
  const vivaHttp = exactNode(flow, CUP_ROSTER_PATCH_CONTRACT.nodes.vivaHttp, "Participants Viva HTTP");
  const terminal = exactNode(flow, CUP_ROSTER_PATCH_CONTRACT.nodes.terminal, "Participants terminal");
  if (validate.type !== "function" || vivaNormalize.type !== "function" || vivaHttp.type !== "http request") {
    fail("Participants node types changed");
  }
  assertFunctionHash(validate, CUP_ROSTER_PATCH_CONTRACT.functionPreimages.validate, "Participants request builder");
  assertFunctionHash(vivaNormalize, CUP_ROSTER_PATCH_CONTRACT.functionPreimages.vivaNormalize, "Participants normalize");
  assertFunctionHash(terminal, CUP_ROSTER_PATCH_CONTRACT.functionPreimages.terminal, "Participants terminal");
  return { route, validate, vivaHttp, vivaNormalize, terminal };
}

function httpRequestNode(id, name, x, y, wires) {
  return {
    id,
    type: "http request",
    z: CUP_ROSTER_PATCH_CONTRACT.tabId,
    name,
    method: "use",
    ret: "obj",
    paytoqs: "ignore",
    url: "",
    headers: [
      {
        keyType: "other",
        keyValue: "User-Agent",
        valueType: "other",
        valueValue: "PadlHub-LK/1.0",
      },
    ],
    x,
    y,
    wires,
  };
}

export function protectRosterTerminal(func) {
  if (sha256(func) !== CUP_ROSTER_PATCH_CONTRACT.functionPreimages.terminal) {
    fail("Participants terminal function preimage mismatch");
  }
  return func
    .replaceAll("NODE_RED_MANAGED_RESPONSE_HEADERS", "BLOCKED_RESPONSE_HEADERS")
    .replace('  "connection",', [
      '  "authorization",',
      '  "proxy-authorization",',
      '  "cookie",',
      '  "set-cookie",',
      '  "connection",',
    ].join("\n"));
}

export function applyCupRosterPatch(flow) {
  const { validate, vivaHttp, vivaNormalize, terminal } = assertFlow(flow);
  const source = {
    lookup: readSource("lookup"),
    publicRequest: readSource("publicRequest"),
    normalize: readSource("normalize"),
    vivaFallback: readSource("vivaFallback"),
    reconcilePayment: readSource("reconcilePayment"),
  };
  const patched = structuredClone(flow);

  const validatePatched = exactNode(patched, validate.id, "Participants request builder");
  validatePatched.name = "Validate + build CUP tournament request";
  validatePatched.func = source.lookup;
  validatePatched.wires = [[vivaHttp.id], [CUP_ROSTER_PATCH_CONTRACT.nodes.terminal]];

  const vivaHttpPatched = exactNode(patched, vivaHttp.id, "Participants Viva HTTP");
  vivaHttpPatched.name = "CUP tournament lookup";
  vivaHttpPatched.wires = [[NEW_IDS.publicPrepare]];

  const vivaNormalizePatched = exactNode(patched, vivaNormalize.id, "Participants normalize");
  vivaNormalizePatched.name = "Normalize Viva fallback bookings";
  exactNode(patched, terminal.id, "Participants terminal").func = protectRosterTerminal(terminal.func);

  patched.push(
    {
      id: NEW_IDS.publicPrepare,
      type: "function",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Prepare CUP public roster request",
      func: source.publicRequest,
      outputs: 3,
      timeout: 0,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1_100,
      y: 1_000,
      wires: [[NEW_IDS.publicHttp], [NEW_IDS.vivaFallbackPrepare], [CUP_ROSTER_PATCH_CONTRACT.nodes.terminal]],
    },
    httpRequestNode(NEW_IDS.publicHttp, "CUP public tournament roster", 1_320, 1_000, [[NEW_IDS.publicNormalize]]),
    {
      id: NEW_IDS.publicNormalize,
      type: "function",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Normalize CUP public roster",
      func: source.normalize,
      outputs: 2,
      timeout: 0,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1_550,
      y: 1_000,
      wires: [[CUP_ROSTER_PATCH_CONTRACT.nodes.terminal], [CUP_ROSTER_PATCH_CONTRACT.nodes.terminal]],
    },
    {
      id: NEW_IDS.vivaFallbackPrepare,
      type: "function",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Fallback to Viva roster",
      func: source.vivaFallback,
      outputs: 2,
      timeout: 0,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1_320,
      y: 1_150,
      wires: [[NEW_IDS.vivaFallbackHttp], [CUP_ROSTER_PATCH_CONTRACT.nodes.terminal]],
    },
    httpRequestNode(NEW_IDS.vivaFallbackHttp, "Viva Admin bookings (fallback)", 1_550, 1_150, [[vivaNormalize.id]]),
    {
      id: NEW_IDS.paymentIn,
      type: "http in",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Tournament payment reconciliation",
      url: CUP_ROSTER_PATCH_CONTRACT.paymentRouteUrl,
      method: "post",
      upload: false,
      x: 650,
      y: 1_250,
      wires: [[NEW_IDS.paymentRouter]],
    },
    {
      id: NEW_IDS.paymentRouter,
      type: "function",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Reconcile CUP payment and invalidate roster",
      func: source.reconcilePayment,
      outputs: 2,
      timeout: 0,
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [{ var: "cupUrl", module: "url" }],
      x: 1_010,
      y: 1_250,
      wires: [[NEW_IDS.paymentHttp], [NEW_IDS.paymentResponse]],
    },
    httpRequestNode(NEW_IDS.paymentHttp, "CUP checkout reconciliation", 1_370, 1_240, [[NEW_IDS.paymentRouter]]),
    {
      id: NEW_IDS.paymentResponse,
      type: "http response",
      z: CUP_ROSTER_PATCH_CONTRACT.tabId,
      name: "Tournament payment reconciliation response",
      statusCode: "",
      headers: {},
      x: 1_420,
      y: 1_300,
      wires: [],
    },
  );

  return patched;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args.get("source");
  const outputPath = args.get("output");
  if (!sourcePath || !outputPath) {
    fail("Usage: node scripts/patch_live_tournament_participants_cup_source.mjs --source /abs/source.flow.json --output /abs/candidate.flow.json");
  }
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(outputPath)) fail("Source and output must be absolute paths");
  if (fs.existsSync(outputPath)) fail("Output already exists");
  const sourceReal = fs.realpathSync(sourcePath);
  const outputDir = fs.realpathSync(path.dirname(outputPath));
  const canonicalOutput = path.join(outputDir, path.basename(outputPath));
  if (canonicalOutput === sourceReal) fail("Output must differ from source");
  if (`${canonicalOutput}/`.startsWith(`${REPO_ROOT}/`)) fail("Output must be outside the repository");
  const raw = fs.readFileSync(sourceReal);
  const flow = JSON.parse(raw);
  const patched = applyCupRosterPatch(flow);
  fs.writeFileSync(canonicalOutput, `${JSON.stringify(patched, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    source: sourceReal,
    output: canonicalOutput,
    sourceSha256: sha256(raw),
    candidateSha256: sha256(fs.readFileSync(canonicalOutput)),
    sourceNodeCount: flow.length,
    candidateNodeCount: patched.length,
    routeId: CUP_ROSTER_PATCH_CONTRACT.routeId,
    addedNodeIds: Object.values(NEW_IDS),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
