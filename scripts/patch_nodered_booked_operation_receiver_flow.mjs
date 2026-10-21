#!/usr/bin/env node
// Source-driven patch for the fail-closed LK1 receiver of the LK2 commercial
// JOIN booked-operation contract.
//
// It adds one isolated Node-RED tab with:
//   POST /lk/integrations/v1/booked-operation-admissions
//   GET  /lk/integrations/v1/booked-operations/:operationId
//
// The tab reuses the existing `lk_subscription_daily_booking_ops` Mongo client.
// No existing node is edited, no live flow, server or database is touched: the
// script only turns a privately supplied preimage into a candidate flow plus a
// report.
//
// The execution adapter is wired but disabled by default: the single provider
// request node is only reachable from the executor, which requires
// `BOOKED_OPERATION_EXECUTION_ENABLED` plus the signed actor-token binding in the
// delegation. Without both, admission still stops at PENDING and no provider
// request is ever emitted.
//
// Runtime prerequisites (checked before any import, not by this script):
//   - Node-RED settings.js must not set `functionExternalModules: false`
//     (only an explicit false blocks the builtin `crypto` external module);
//   - the receiver env configuration must be present (see HANDOFF-LK1.md).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS_DIR = path.join(ROOT, "scripts/nodered_booked_operation_receiver_nodes");

export const COLLECTION = "lk_subscription_daily_booking_ops";
export const TAB_ID = "lk_booked_operation_receiver_tab_20261021";
export const TAB_LABEL = "LK Booked Operation Receiver";
export const ROUTES = Object.freeze({
  admission: "/lk/integrations/v1/booked-operation-admissions",
  readPrefix: "/lk/integrations/v1/booked-operations/",
});
export const NODE_IDS = Object.freeze({
  comment: "lk_booked_operation_comment_20261021",
  admissionIn: "lk_booked_operation_admission_in_20261021",
  admissionVerify: "lk_booked_operation_admission_verify_20261021",
  readIn: "lk_booked_operation_read_in_20261021",
  readVerify: "lk_booked_operation_read_verify_20261021",
  router: "lk_booked_operation_router_20261021",
  executor: "lk_booked_operation_executor_20261021",
  providerRequest: "lk_booked_operation_provider_request_20261021",
  mongoFind: "lk_booked_operation_find_20261021",
  mongoUpsert: "lk_booked_operation_upsert_20261021",
  mongoAttempt: "lk_booked_operation_attempt_20261021",
  mongoFinalize: "lk_booked_operation_finalize_20261021",
  respond: "lk_booked_operation_respond_20261021",
  response: "lk_booked_operation_response_20261021",
  catch: "lk_booked_operation_catch_20261021",
  storeError: "lk_booked_operation_store_error_20261021",
});

const FUNCTION_FILES = Object.freeze({
  admission_verify: {
    file: "fn_booked_operation_admission_verify.js",
    preludes: ["_booked_operation_delegation_prelude.js"],
    outputs: 2,
  },
  read_verify: {
    file: "fn_booked_operation_read_verify.js",
    preludes: ["_booked_operation_delegation_prelude.js"],
    outputs: 2,
  },
  router: { file: "fn_booked_operation_router.js", preludes: [], outputs: 4 },
  executor: {
    file: "fn_booked_operation_executor.js",
    preludes: ["_booked_operation_viva_contract.js"],
    outputs: 5,
  },
  response: { file: "fn_booked_operation_response.js", preludes: [], outputs: 1 },
  store_error: { file: "fn_booked_operation_store_error.js", preludes: [], outputs: 1 },
});
const CRYPTO_LIBS = Object.freeze([{ var: "nodeCrypto", module: "crypto" }]);

const readSource = (name) => fs.readFileSync(path.join(FUNCTIONS_DIR, name), "utf8");
const PRELUDE_SHA256 = crypto
  .createHash("sha256")
  .update(readSource("_booked_operation_delegation_prelude.js"))
  .digest("hex");
const VIVA_CONTRACT_SHA256 = crypto
  .createHash("sha256")
  .update(readSource("_booked_operation_viva_contract.js"))
  .digest("hex");

// The reviewed verification/contract sources are prepended to their node bodies;
// mode-specific behavior stays in the node body itself.
export const receiverFunctionSource = (name) => {
  const spec = FUNCTION_FILES[name];
  if (!spec) throw new Error(`Unknown receiver function ${name}`);
  const body = readSource(spec.file);
  if (!spec.preludes || spec.preludes.length === 0) return body;
  const prelude = spec.preludes.map((file) => readSource(file)).join("\n");
  return `${prelude}\n${body}`;
};

const functionNode = (id, name, outputs, func, libs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB_ID,
  name,
  func,
  outputs,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs,
  x,
  y,
  wires,
});
const mongoNode = (id, name, operation, clientNode, x, y, wires) => ({
  id,
  type: "mongodb4",
  z: TAB_ID,
  name,
  collection: COLLECTION,
  operation,
  clientNode,
  mode: "collection",
  output: "toArray",
  maxTimeMS: "5000",
  handleDocId: false,
  x,
  y,
  wires,
});

export function buildReceiverNodes({ tabId = TAB_ID, mongoClientNodeId } = {}) {
  if (!mongoClientNodeId) throw new Error("A Mongo client config node is required");
  const ids = NODE_IDS;
  const respondWires = [[ids.response]];
  return [
    {
      id: ids.comment,
      type: "comment",
      z: tabId,
      name: "LK2 booked-operation receiver (fail-closed)",
      info: [
        "POST /lk/integrations/v1/booked-operation-admissions",
        "GET /lk/integrations/v1/booked-operations/:operationId",
        "RS256 actor-delegation verification against an env public key; no key in git.",
        "One durable document per operation_id in " + COLLECTION + ".",
        "Execution adapter is disabled by default (BOOKED_OPERATION_EXECUTION_ENABLED unset).",
        "When enabled it requires the signed actor-token/subscription binding and writes the",
        "ATTEMPTING dispatch marker before the single Viva booking POST; no retry after UNKNOWN.",
      ].join("\n"),
      x: 200,
      y: 900,
      wires: [],
    },
    {
      id: ids.admissionIn,
      type: "http in",
      z: tabId,
      name: "LK2 booked-operation admission",
      url: ROUTES.admission,
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 200,
      y: 960,
      wires: [[ids.admissionVerify]],
    },
    functionNode(
      ids.admissionVerify,
      "Verify booked-operation admission delegation",
      2,
      receiverFunctionSource("admission_verify"),
      CRYPTO_LIBS,
      500,
      960,
      [[ids.mongoFind], [ids.respond]],
    ),
    {
      id: ids.readIn,
      type: "http in",
      z: tabId,
      name: "LK2 booked-operation read",
      url: `${ROUTES.readPrefix}:operationId`,
      method: "get",
      upload: false,
      swaggerDoc: "",
      x: 200,
      y: 1040,
      wires: [[ids.readVerify]],
    },
    functionNode(
      ids.readVerify,
      "Verify booked-operation read delegation",
      2,
      receiverFunctionSource("read_verify"),
      CRYPTO_LIBS,
      500,
      1040,
      [[ids.mongoFind], [ids.respond]],
    ),
    mongoNode(
      ids.mongoFind,
      "Find booked-operation receipt",
      "find",
      mongoClientNodeId,
      820,
      1000,
      [[ids.router]],
    ),
    mongoNode(
      ids.mongoUpsert,
      "Create booked-operation receipt",
      "updateOne",
      mongoClientNodeId,
      820,
      1080,
      [[ids.router]],
    ),
    mongoNode(
      ids.mongoAttempt,
      "Claim booked-operation attempt",
      "updateOne",
      mongoClientNodeId,
      1420,
      1080,
      [[ids.executor]],
    ),
    mongoNode(
      ids.mongoFinalize,
      "Finalize booked-operation receipt",
      "updateOne",
      mongoClientNodeId,
      1420,
      1160,
      [[ids.executor]],
    ),
    functionNode(
      ids.router,
      "Route booked-operation receipt",
      4,
      receiverFunctionSource("router"),
      [],
      1120,
      1000,
      [[ids.mongoUpsert], [ids.respond], [ids.mongoFind], [ids.executor]],
    ),
    functionNode(
      ids.executor,
      "Execute booked-operation booking",
      5,
      receiverFunctionSource("executor"),
      CRYPTO_LIBS,
      1120,
      1080,
      [
        [ids.providerRequest],
        [ids.mongoAttempt],
        [ids.mongoFinalize],
        [ids.respond],
        [ids.mongoFind],
      ],
    ),
    {
      // The single provider-facing node of the receiver. method "use" mirrors the
      // existing subscription-booking gateway: the executor sets msg.method,
      // msg.url and msg.headers. senderr lets the executor classify a transport
      // failure as UNKNOWN instead of throwing after a possible write.
      id: ids.providerRequest,
      type: "http request",
      z: tabId,
      name: "Viva booked-operation request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "15000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      x: 1420,
      y: 1000,
      wires: [[ids.executor]],
    },
    functionNode(
      ids.respond,
      "Guard booked-operation response",
      1,
      receiverFunctionSource("response"),
      [],
      1720,
      1000,
      respondWires,
    ),
    {
      id: ids.response,
      type: "http response",
      z: tabId,
      name: "",
      statusCode: "",
      headers: {},
      x: 1980,
      y: 1000,
      wires: [],
    },
    {
      id: ids.catch,
      type: "catch",
      z: tabId,
      name: "Catch booked-operation faults",
      scope: [
        ids.admissionVerify,
        ids.readVerify,
        ids.router,
        ids.executor,
        ids.mongoFind,
        ids.mongoUpsert,
        ids.mongoAttempt,
        ids.mongoFinalize,
      ],
      uncaught: false,
      x: 820,
      y: 1240,
      wires: [[ids.storeError]],
    },
    functionNode(
      ids.storeError,
      "Fail closed on booked-operation fault",
      1,
      receiverFunctionSource("store_error"),
      [],
      1120,
      1240,
      [[ids.respond]],
    ),
  ];
}

const assertHttpRouteDoesNotOverlap = (flow) => {
  const reservedLiteral = [
    ROUTES.admission.toLowerCase(),
    ROUTES.readPrefix.toLowerCase(),
  ];
  const routeLiteral = (url) => url.toLowerCase().split(/[?:*({[]/, 1)[0];
  const overlap = flow.find((node) => {
    if (!node || node.type !== "http in" || typeof node.url !== "string") return false;
    const literal = routeLiteral(node.url);
    return reservedLiteral.some((reserved) => (
      literal === reserved
      || literal.startsWith(reserved)
      || reserved.startsWith(literal)
    ));
  });
  if (overlap) throw new Error(`Booked-operation route overlaps existing ${overlap.url}`);
};

const resolveMongoClientNodeId = (flow) => {
  const operationClients = [...new Set(flow
    .filter((node) => node && node.type === "mongodb4" && node.collection === COLLECTION)
    .map((node) => node.clientNode)
    .filter((value) => typeof value === "string" && value))];
  if (operationClients.length > 1) {
    throw new Error("Booked-operation collection uses ambiguous Mongo clients");
  }
  if (operationClients.length === 1) {
    const clientNodeId = operationClients[0];
    if (!flow.some((node) => node && node.id === clientNodeId && node.type === "mongodb4-client")) {
      throw new Error("Booked-operation Mongo client config node is missing");
    }
    return clientNodeId;
  }
  const configNodes = flow.filter((node) => node && node.type === "mongodb4-client");
  if (configNodes.length !== 1) {
    throw new Error(`Expected one Mongo client config node, found ${configNodes.length}`);
  }
  return configNodes[0].id;
};

// Pure preimage -> candidate step. No file, network, runtime or database access.
export function buildReceiverCandidate(sourceFlow) {
  if (!Array.isArray(sourceFlow)) throw new Error("Node-RED source flow must be an array");
  const sourceIds = sourceFlow.map((node) => (typeof node?.id === "string" ? node.id : ""));
  if (sourceIds.some((id) => !id) || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Source flow contains missing or duplicate node identities");
  }
  if (sourceFlow.some((node) => (
    node?.id === TAB_ID || (node?.type === "tab" && node.label === TAB_LABEL)
  ))) {
    throw new Error("Booked-operation receiver tab already exists");
  }
  assertHttpRouteDoesNotOverlap(sourceFlow);
  const mongoClientNodeId = resolveMongoClientNodeId(sourceFlow);
  const tab = { id: TAB_ID, type: "tab", label: TAB_LABEL, disabled: false, info: "" };
  const additions = buildReceiverNodes({ mongoClientNodeId });
  const candidate = [...structuredClone(sourceFlow), structuredClone(tab), ...additions];

  const candidateIds = candidate.map((node) => node.id);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("Candidate contains duplicate node IDs");
  }
  const knownIds = new Set(candidateIds);
  const brokenWires = [];
  for (const node of candidate) {
    for (const row of Array.isArray(node.wires) ? node.wires : []) {
      for (const targetId of Array.isArray(row) ? row : []) {
        if (!knownIds.has(targetId)) brokenWires.push(`${node.id}->${targetId}`);
      }
    }
  }
  if (brokenWires.length > 0) {
    throw new Error(`Candidate contains broken wires: ${brokenWires.join(", ")}`);
  }
  for (let index = 0; index < sourceFlow.length; index += 1) {
    if (!isDeepStrictEqual(sourceFlow[index], candidate[index])) {
      throw new Error(`Source node changed: ${sourceFlow[index]?.id}`);
    }
  }
  const addedTyped = additions.filter((node) => node.type !== "comment");
  const addedHttpRoutes = additions.filter((node) => node.type === "http in");
  if (addedHttpRoutes.length !== 2) {
    throw new Error(`Expected two added HTTP routes, found ${addedHttpRoutes.length}`);
  }
  const forbidden = additions.filter((node) => (
    ["exec", "mongodb4-client"].includes(node.type)
  ));
  if (forbidden.length > 0) {
    throw new Error("Receiver additions must not perform host I/O");
  }
  // Exactly one provider request node is allowed, and only the executor may emit
  // into it: the adapter's activation/binding gates are the single provider path.
  const providerRequests = additions.filter((node) => node.type === "http request");
  if (providerRequests.length !== 1) {
    throw new Error(`Expected one provider request node, found ${providerRequests.length}`);
  }
  const providerRequest = providerRequests[0];
  if (providerRequest.method !== "use" || providerRequest.senderr !== true) {
    throw new Error("Provider request node must use msg.method/msg.url and senderr");
  }
  const providerWiredFrom = additions.filter((node) => (
    (Array.isArray(node.wires) ? node.wires : []).some((row) => (
      Array.isArray(row) && row.includes(providerRequest.id)
    ))
  ));
  if (providerWiredFrom.length !== 1 || providerWiredFrom[0].id !== NODE_IDS.executor) {
    throw new Error("Provider request node must only be driven by the executor");
  }
  const executorSource = receiverFunctionSource("executor");
  if (
    !/BOOKED_OPERATION_EXECUTION_ENABLED/.test(executorSource)
    || !/LK1_BOOKED_OPERATION_VIVA_API_BASE/.test(executorSource)
    || !/DISPATCH_ATTEMPTING/.test(executorSource)
  ) {
    throw new Error("Executor source must carry the activation, endpoint and attempt marker contract");
  }
  // Only the executor/contract source may name provider endpoints; only the
  // executor may construct an Authorization header. The response guard is allowed
  // to scrub such headers defensively.
  const providerReferences = additions.filter((node) => (
    node.id !== NODE_IDS.executor
    && /vivacrm|api\.viva|Authorization:\s*`Bearer/.test(String(node.func || ""))
  ));
  if (providerReferences.length > 0) {
    throw new Error("Only the executor may reference provider endpoints or build a Bearer header");
  }
  // Every added message edge must stay inside the receiver tab.
  const addedIds = new Set(additions.map((node) => node.id));
  for (const node of additions) {
    for (const row of Array.isArray(node.wires) ? node.wires : []) {
      for (const targetId of Array.isArray(row) ? row : []) {
        if (!addedIds.has(targetId)) throw new Error(`Receiver node ${node.id} wires outside its tab`);
      }
    }
  }
  return {
    candidate,
    report: {
      addedTabId: TAB_ID,
      addedTabLabel: TAB_LABEL,
      addedNodeIds: additions.map((node) => node.id),
      mongoClientNodeId,
      collection: COLLECTION,
      routes: [ROUTES.admission, `${ROUTES.readPrefix}:operationId`],
      mode: "FAIL_CLOSED_EXECUTION_ADAPTER",
      executionEnabledByDefault: false,
      executionFlag: "BOOKED_OPERATION_EXECUTION_ENABLED",
      providerRequestNodeCount: providerRequests.length,
      providerCallsWhenExecutionDisabled: 0,
      preludeSha256: PRELUDE_SHA256,
      vivaContractSha256: VIVA_CONTRACT_SHA256,
      runtimePrerequisites: [
        "Node-RED settings.js must not set functionExternalModules:false",
        "LK1_BOOKED_OPERATION_RECEIVER_ENABLED, LK2_BOOKED_OPERATION_DELEGATION_ISSUER, "
          + "LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE, "
          + "LK2_BOOKED_OPERATION_DELEGATION_KEY_ID and "
          + "LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM must be configured",
        "BOOKED_OPERATION_EXECUTION_ENABLED must stay unset until LK2 delivers "
          + "X-Subscription-Actor-Token plus the signed actor_token_sha256, "
          + "actor_token_expires_at and provider_client_subscription_id claims",
        "Execution uses LK1_BOOKED_OPERATION_VIVA_API_BASE (default "
          + "https://api.vivacrm.ru) and the documented profile/booking/readback paths",
        "LK1 must receive a backend-issued user-scoped actor token; the shared "
          + "service token is never substituted",
      ],
      invariants: {
        sourceNodeCount: sourceFlow.length,
        candidateNodeCount: candidate.length,
        addedNodeCount: additions.length,
        addedHttpInRouteCount: addedHttpRoutes.length,
        sourceNodesUnchanged: true,
        addedTabOnly: true,
        brokenWireCount: 0,
        addedProviderWriteNodeCount: providerRequests.length,
        addedExecutorNodeCount: additions.filter((node) => node.id === NODE_IDS.executor).length,
      },
      addedNodeTypes: [...new Set(addedTyped.map((node) => node.type))].sort(),
    },
  };
}

// --- CLI (media/flow patcher convention: explicit preimage, atomic outputs) ---

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const canonicalizePath = (filePath) => {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) return fs.realpathSync(absolutePath);
  return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
};
const sameInode = (leftPath, rightPath) => {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
};
const tempPath = (destination) => path.join(
  path.dirname(destination),
  `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
);
const removeIfPresent = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const runCli = () => {
  const inputPath = getArg("--input");
  const outputPath = getArg("--output");
  const reportPath = getArg("--report");
  const expectedFlowSha256 = String(getArg("--expected-flow-sha256") || "").toLowerCase();
  if (!inputPath || !outputPath || !reportPath || !/^[a-f0-9]{64}$/.test(expectedFlowSha256)) {
    throw new Error(
      "Usage: node scripts/patch_nodered_booked_operation_receiver_flow.mjs "
      + "--input <flow.json> --output <candidate.json> --report <report.json> "
      + "--expected-flow-sha256 <sha256>",
    );
  }
  const input = canonicalizePath(inputPath);
  const output = canonicalizePath(outputPath);
  const reportFile = canonicalizePath(reportPath);
  if (
    input === output || input === reportFile || output === reportFile
    || sameInode(input, output) || sameInode(input, reportFile) || sameInode(output, reportFile)
  ) {
    throw new Error("Input, output, and report paths must be distinct");
  }
  if (fs.existsSync(output) || fs.existsSync(reportFile)) {
    throw new Error("Output and report destinations must not already exist");
  }
  const inputBytes = fs.readFileSync(input);
  const flowSha256 = sha256(inputBytes);
  if (flowSha256 !== expectedFlowSha256) {
    throw new Error(`Flow preimage mismatch: expected ${expectedFlowSha256}, got ${flowSha256}`);
  }
  const { candidate, report } = buildReceiverCandidate(JSON.parse(inputBytes.toString("utf8")));
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  const reportText = `${JSON.stringify(
    { ok: true, flowSha256, expectedFlowSha256, candidateSha256: sha256(Buffer.from(candidateText, "utf8")), ...report },
    null,
    2,
  )}\n`;
  const outputTemp = tempPath(output);
  const reportTemp = tempPath(reportFile);
  let outputPublished = false;
  let reportPublished = false;
  try {
    fs.writeFileSync(outputTemp, candidateText, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(reportTemp, reportText, { flag: "wx", mode: 0o600 });
    fs.linkSync(reportTemp, reportFile);
    reportPublished = true;
    fs.linkSync(outputTemp, output);
    outputPublished = true;
  } catch (error) {
    if (outputPublished) removeIfPresent(output);
    if (reportPublished) removeIfPresent(reportFile);
    throw error;
  } finally {
    removeIfPresent(outputTemp);
    removeIfPresent(reportTemp);
  }
  console.log(reportText.trimEnd());
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
