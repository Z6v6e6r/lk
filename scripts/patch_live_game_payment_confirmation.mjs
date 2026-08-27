#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");

export const CONTRACT = Object.freeze({
  flowSha256: "9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263",
  nodeCount: 4762,
  httpRouteCount: 215,
  tabId: "4b91e2a2413688db",
  createNode: {
    id: "e656cff36a8cd210",
    name: "Prepare game upsert",
    beforeFuncSha256: "08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f",
  },
  mongoWriteNodes: [
    {
      id: "5eaf4c087c0cc668",
      name: "Upsert lk game",
      collection: "lk_games",
      operation: "updateOne",
      maxTimeMS: "5000",
      ackTarget: "confirmWriteAck",
    },
    {
      id: "11079a30bf3cc6ad",
      name: "Archive split game after cleanup",
      collection: "lk_games",
      operation: "updateOne",
      maxTimeMS: "0",
      ackTarget: "cleanupWriteAck",
    },
  ],
  sourceTargets: [
    {
      id: "9508f8e0ae8d282a",
      name: "Prepare split cleanup tasks",
      beforeFuncSha256: "988bacd186c89d3901a60ab01433c4a928aa860e452ad14253bb0515b614acd6",
      source: "fn_split_cleanup_prepare.js",
    },
    {
      id: "bcc3dccf8d64f9bb",
      name: "Route split cleanup action",
      beforeFuncSha256: "676a2caff25cb948fb791e69c98dbdb58431f861957ef21fb9f481fc13bb3186",
      source: "fn_split_cleanup_router.js",
    },
    {
      id: "79307f9bcbc28b6c",
      name: "Upsert lk game -> mongodb4 args",
      beforeFuncSha256: "b0d21fdbd8b5e1d4c6004f1e4bce6ba2fc74a9bbf62a49937775ed301604ce06",
      source: "fn_game_upsert_args.js",
    },
  ],
  routes: [
    { id: "715662c56fc5eac6", name: "LK games payment confirm", url: "/lk/games/payment/confirm" },
    { id: "4d960c11d162d102", name: "LK games confirm alias", url: "/lk/games/confirm" },
  ],
});

export const PAYMENT_NODE_IDS = Object.freeze({
  lookup: "lk_game_payment_confirm_lookup_20260826",
  find: "lk_game_payment_confirm_find_20260826",
  router: "lk_game_payment_confirm_router_20260826",
  request: "lk_game_payment_confirm_http_20260826",
  confirmClaimUpdate: "lk_game_payment_confirm_claim_update_20260826",
  confirmClaimFind: "lk_game_payment_confirm_claim_find_20260826",
  cleanupClaimUpdate: "lk_split_cleanup_payment_claim_update_20260826",
  cleanupClaimFind: "lk_split_cleanup_payment_claim_find_20260826",
  confirmWriteAck: "lk_game_payment_confirm_write_ack_20260826",
  confirmWriteReadback: "lk_game_payment_confirm_write_readback_20260826",
  cleanupWriteAck: "lk_split_cleanup_write_ack_20260826",
  cleanupWriteReadback: "lk_split_cleanup_write_readback_20260826",
});
const IDS = PAYMENT_NODE_IDS;
const RESPONSE_ID = "ae5ee70de15fe66e";
const DEBUG_ID = "60a3353902ae9973";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const routes = (flow) => flow.filter((node) => node.type === "http in").map((node) => ({
  id: node.id,
  z: node.z ?? "",
  method: node.method ?? "",
  url: node.url ?? "",
  wires: node.wires ?? [],
}));
const brokenReferences = (flow) => {
  const ids = new Set(flow.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const targetId of output ?? []) if (!ids.has(targetId)) brokenWires += 1;
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) if (!ids.has(targetId)) brokenLinks += 1;
    }
  }
  return { brokenWires, brokenLinks };
};

function extractCreateGuard(source) {
  const match = source.match(
    /\/\/ GAME_PAYMENT_CONFIRM_GUARD_START\n([\s\S]*?)\/\/ GAME_PAYMENT_CONFIRM_GUARD_END\n/,
  );
  if (!match?.[1]) fail("Create payment confirmation guard markers are missing");
  return match[1];
}

function insertCreateGuard(liveSource, guard) {
  if (liveSource.includes("GAME_PAYMENT_EVIDENCE_REQUIRED")) fail("Live create function already contains payment guard");
  const anchor = `const resolvedPaid =
  mode === "draft"
    ? false
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);

`;
  const matches = liveSource.split(anchor).length - 1;
  if (matches !== 1) fail(`Create guard anchor count mismatch: ${matches}`);
  return liveSource.replace(
    anchor,
    `${anchor}// GAME_PAYMENT_CONFIRM_GUARD_START\n${guard}// GAME_PAYMENT_CONFIRM_GUARD_END\n\n`,
  );
}

function replaceCreateBlock(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) fail(`Create ${label} anchor count mismatch: ${count}`);
  return source.replace(before, after);
}

function patchCreateFunction(liveSource, futureSource) {
  let patched = replaceCreateBlock(
    liveSource,
    `const explicitAction = toStr(body.action || body._action || msg._action || msg.action);
let mode = "create";
if (reqPath.includes("/payment/confirm")) mode = "confirm";
if (reqPath.includes("/draft")) mode = "draft";
if (explicitAction) {
  const normalized = explicitAction.toLowerCase();
  if (["create", "draft", "confirm"].includes(normalized)) {
    mode = normalized;
  }
}
`,
    `const internalAction = toStr(msg._action);
let mode = "create";
if (reqPath.includes("/payment/confirm")) mode = "confirm";
if (reqPath.includes("/draft")) mode = "draft";
if (internalAction) {
  const normalized = internalAction.toLowerCase();
  if (["create", "draft", "confirm"].includes(normalized)) {
    mode = normalized;
  }
}
`,
    "route authoritative mode",
  );
  patched = replaceCreateBlock(
    patched,
    `const resolvedPaid =
  mode === "draft"
    ? (incomingPaid === null ? false : incomingPaid)
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);
`,
    `const resolvedPaid =
  mode === "draft"
    ? false
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);
`,
    "draft paid",
  );
  patched = replaceCreateBlock(
    patched,
    "const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || `g_${Date.now()}`;\n",
    `const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || \`g_\${Date.now()}\`;
const expectedRevision = body.expectedRevision !== null && body.expectedRevision !== undefined
  && Number.isSafeInteger(Number(body.expectedRevision))
  && Number(body.expectedRevision) >= 1
  ? Number(body.expectedRevision)
  : null;
const expectedUpdatedAt = toStr(body.expectedUpdatedAt);
`,
    "stale guard inputs",
  );
  patched = insertCreateGuard(patched, extractCreateGuard(futureSource));
  patched = replaceCreateBlock(
    patched,
    `const incomingStatus = toStr(body.status);
const resolvedStatus =
  incomingStatus
  || (mode === "draft"
    ? "PAYMENT_PENDING"
    : resolvedPaid
      ? "PAID"
      : "PAYMENT_PENDING");
`,
    `const incomingStatus = toStr(body.status);
const resolvedStatus =
  mode === "draft"
    ? "PAYMENT_PENDING"
    : incomingStatus
      || (resolvedPaid ? "PAID" : "PAYMENT_PENDING");
`,
    "draft status",
  );
  patched = replaceCreateBlock(
    patched,
    `const queryFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };
`,
    `const paymentRefFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };
const queryFilter = mode === "confirm"
  ? {
      $and: [
        paymentRefFilter,
        { archived: { $ne: true } },
        { status: "PAYMENT_PENDING" },
        expectedRevision !== null
          ? { revision: expectedRevision }
          : { updatedAt: expectedUpdatedAt },
      ],
    }
  : paymentRefFilter;
`,
    "confirm CAS query",
  );
  patched = replaceCreateBlock(
    patched,
    `  _requestUrl: reqPathRaw,
  _requestMode: mode,
});`,
    `  _requestUrl: reqPathRaw,
  _requestMode: mode,
  ...(mode === "confirm" ? {
    _gameConfirmWriteAck: {
      step: "write_ack",
      gameId,
      tenantKey: toStr(body.tenantKey),
      expectedRevision,
      expectedNextRevision: expectedRevision === null ? null : expectedRevision + 1,
      paymentRef,
      transactionId: toStr(paymentVerification?.transactionId),
      bookingId: toStr(paymentVerification?.bookingId),
      exerciseId: toStr(paymentVerification?.exerciseId),
    },
  } : {}),
});`,
    "confirm write acknowledgement context",
  );
  patched = replaceCreateBlock(
    patched,
    "return [dbMsg, responseMsg, debugMsg, autojoinMsg];",
    `return [
  dbMsg,
  mode === "confirm" ? null : responseMsg,
  debugMsg,
  mode === "confirm" ? null : autojoinMsg,
];`,
    "confirm side effect",
  );
  return patched;
}

export function buildCandidate(flow, sourceSha256, options = {}) {
  const contract = options.contract ?? CONTRACT;
  if (sourceSha256 !== contract.flowSha256) fail("Whole-flow preimage SHA mismatch");
  if (!Array.isArray(flow) || flow.length !== contract.nodeCount) fail("Flow node count mismatch");
  if (new Set(flow.map((node) => node.id)).size !== flow.length) fail("Flow contains duplicate node IDs");
  if (routes(flow).length !== contract.httpRouteCount) fail("HTTP route count mismatch");
  for (const id of Object.values(IDS)) if (flow.some((node) => node.id === id)) fail(`Added node already exists: ${id}`);

  const before = structuredClone(flow);
  const beforeRoutes = routes(before);
  const createNode = flow.find((node) => node.id === contract.createNode.id);
  if (!createNode || createNode.type !== "function" || createNode.name !== contract.createNode.name) {
    fail("Create node identity mismatch");
  }
  if (sha256(String(createNode.func ?? "")) !== contract.createNode.beforeFuncSha256) {
    fail("Create node function preimage mismatch");
  }
  const futureCreateSource = fs.readFileSync(path.join(SOURCE_DIR, "fn_create.js"), "utf8");
  createNode.func = patchCreateFunction(String(createNode.func), futureCreateSource);

  for (const target of contract.sourceTargets) {
    const node = flow.find((item) => item.id === target.id);
    if (!node || node.type !== "function" || node.name !== target.name) fail(`${target.name} identity mismatch`);
    if (sha256(String(node.func ?? "")) !== target.beforeFuncSha256) fail(`${target.name} function preimage mismatch`);
    node.func = fs.readFileSync(path.join(SOURCE_DIR, target.source), "utf8");
    if (target.id === "bcc3dccf8d64f9bb") {
      const expectedWires = [
        ["41d9d40fefc3b1f3"],
        ["ed88ec81ce95b8b0"],
        ["e71d73fb91b0c3f0"],
        ["ba322f367a4d4fcd"],
      ];
      if (node.outputs !== 4 || !isDeepStrictEqual(node.wires, expectedWires)) {
        fail("Split cleanup router topology drift");
      }
      node.outputs = 6;
      node.wires = [...expectedWires, [IDS.cleanupClaimUpdate], [IDS.cleanupClaimFind]];
    }
  }

  for (const expected of contract.mongoWriteNodes) {
    const node = flow.find((item) => item.id === expected.id);
    if (
      !node
      || node.type !== "mongodb4"
      || node.z !== contract.tabId
      || node.name !== expected.name
      || node.clientNode !== "4e820638cc39c730"
      || node.mode !== "collection"
      || node.collection !== expected.collection
      || node.operation !== expected.operation
      || node.output !== "toArray"
      || node.maxTimeMS !== expected.maxTimeMS
      || node.handleDocId !== false
      || !isDeepStrictEqual(node.wires, [[]])
    ) {
      fail(`${expected.name} topology drift`);
    }
    node.wires = [[IDS[expected.ackTarget]]];
  }

  for (const expected of contract.routes) {
    const node = flow.find((item) => item.id === expected.id);
    if (!node || node.type !== "http in" || node.name !== expected.name || node.url !== expected.url) {
      fail(`Payment route contract mismatch: ${expected.id}`);
    }
    if (!isDeepStrictEqual(node.wires, [[contract.createNode.id]])) fail(`Payment route wiring drift: ${expected.id}`);
    node.wires = [[IDS.lookup]];
  }

  const lookupSource = fs.readFileSync(path.join(SOURCE_DIR, "fn_game_payment_confirm_lookup.js"), "utf8");
  const routerSource = fs.readFileSync(path.join(SOURCE_DIR, "fn_game_payment_confirm_router.js"), "utf8");
  const confirmWriteAckSource = fs.readFileSync(path.join(SOURCE_DIR, "fn_game_confirm_write_ack.js"), "utf8");
  const cleanupWriteAckSource = fs.readFileSync(path.join(SOURCE_DIR, "fn_split_cleanup_write_ack.js"), "utf8");
  if (/VIVA_SERVICE_PASSWORD\s*=\s*["'][^"']+["']/.test(
    `${lookupSource}\n${routerSource}\n${confirmWriteAckSource}\n${cleanupWriteAckSource}`,
  )) {
    fail("Candidate contains inline credential material");
  }
  flow.push(
    {
      id: IDS.lookup,
      type: "function",
      z: contract.tabId,
      name: "Build verified game payment lookup",
      func: lookupSource,
      outputs: 2,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 430,
      y: 2900,
      wires: [[IDS.find], [RESPONSE_ID]],
    },
    {
      id: IDS.find,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Find exact game payment draft",
      x: 710,
      y: 2900,
      wires: [[IDS.router]],
    },
    {
      id: IDS.router,
      type: "function",
      z: contract.tabId,
      name: "Verify game payment with Viva",
      func: routerSource,
      outputs: 6,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 980,
      y: 2900,
      wires: [
        [IDS.request],
        [contract.createNode.id],
        [RESPONSE_ID],
        [DEBUG_ID],
        [IDS.confirmClaimUpdate],
        [IDS.confirmClaimFind],
      ],
    },
    {
      id: IDS.request,
      type: "http request",
      z: contract.tabId,
      name: "Viva game payment verification request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      headers: [{
        keyType: "other",
        keyValue: "User-Agent",
        valueType: "other",
        valueValue: "PadlHub-LK/1.0",
      }],
      x: 1280,
      y: 2900,
      wires: [[IDS.router]],
    },
    {
      id: IDS.confirmClaimUpdate,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_game_payment_evidence_claims",
      operation: "updateOne",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Claim exact game payment evidence",
      x: 1280,
      y: 2960,
      wires: [[IDS.router]],
    },
    {
      id: IDS.confirmClaimFind,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_game_payment_evidence_claims",
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Read back exact game payment claim",
      x: 1280,
      y: 3020,
      wires: [[IDS.router]],
    },
    {
      id: IDS.cleanupClaimUpdate,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_game_payment_evidence_claims",
      operation: "updateOne",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Claim split cleanup payment evidence",
      x: 1800,
      y: 2140,
      wires: [["bcc3dccf8d64f9bb"]],
    },
    {
      id: IDS.cleanupClaimFind,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_game_payment_evidence_claims",
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Read back split cleanup payment claim",
      x: 1800,
      y: 2200,
      wires: [["bcc3dccf8d64f9bb"]],
    },
    {
      id: IDS.confirmWriteAck,
      type: "function",
      z: contract.tabId,
      name: "Acknowledge confirmed game persistence",
      func: confirmWriteAckSource,
      outputs: 3,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1580,
      y: 2900,
      wires: [[IDS.confirmWriteReadback], [RESPONSE_ID], [DEBUG_ID]],
    },
    {
      id: IDS.confirmWriteReadback,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Read back confirmed game persistence",
      x: 1880,
      y: 2900,
      wires: [[IDS.confirmWriteAck]],
    },
    {
      id: IDS.cleanupWriteAck,
      type: "function",
      z: contract.tabId,
      name: "Acknowledge split cleanup persistence",
      func: cleanupWriteAckSource,
      outputs: 3,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1800,
      y: 2260,
      wires: [[IDS.cleanupWriteReadback], ["e71d73fb91b0c3f0"], ["ba322f367a4d4fcd"]],
    },
    {
      id: IDS.cleanupWriteReadback,
      type: "mongodb4",
      z: contract.tabId,
      clientNode: "4e820638cc39c730",
      mode: "collection",
      collection: "lk_games",
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      name: "Read back split cleanup persistence",
      x: 2100,
      y: 2260,
      wires: [[IDS.cleanupWriteAck]],
    },
  );

  const afterRoutes = routes(flow);
  if (afterRoutes.length !== beforeRoutes.length) fail("HTTP route count changed");
  const changedRouteIds = new Set(contract.routes.map((item) => item.id));
  for (const route of beforeRoutes) {
    if (changedRouteIds.has(route.id)) continue;
    const after = afterRoutes.find((item) => item.id === route.id);
    if (!isDeepStrictEqual(route, after)) fail(`Unrelated HTTP route changed: ${route.id}`);
  }
  const broken = brokenReferences(flow);
  if (broken.brokenWires || broken.brokenLinks) fail("Candidate contains broken references");
  return {
    candidate: flow,
    report: {
      ok: true,
      sourceSha256,
      candidateNodeCount: flow.length,
      httpRouteCount: afterRoutes.length,
      addedNodeIds: Object.values(IDS),
      changedNodeIds: [
        contract.createNode.id,
        ...contract.sourceTargets.map((item) => item.id),
        ...contract.mongoWriteNodes.map((item) => item.id),
        ...contract.routes.map((item) => item.id),
      ],
      ...broken,
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--input", "--output", "--report"]).has(key) || !value) fail(`Invalid argument: ${key ?? ""}`);
    values[key] = value;
  }
  if (!values["--input"] || !values["--output"] || !values["--report"]) {
    fail("Usage: node scripts/patch_live_game_payment_confirmation.mjs --input FLOW --output CANDIDATE --report REPORT");
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args["--input"]);
  const outputPath = path.resolve(args["--output"]);
  const reportPath = path.resolve(args["--report"]);
  if (new Set([inputPath, outputPath, reportPath]).size !== 3) fail("Input, output and report paths must be distinct");
  if (fs.existsSync(outputPath) || fs.existsSync(reportPath)) fail("Output files must not exist");
  const bytes = fs.readFileSync(inputPath);
  const result = buildCandidate(JSON.parse(bytes.toString("utf8")), sha256(bytes));
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const report = { ...result.report, candidateSha256: sha256(candidateBytes) };
  fs.writeFileSync(outputPath, candidateBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
