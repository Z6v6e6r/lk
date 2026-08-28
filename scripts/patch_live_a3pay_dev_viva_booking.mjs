#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_a3pay_dev_viva_booking_nodes");
const TAB_ID = "4b91e2a2413688db";
const EXPECTED_SOURCE_SHA256 = "9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263";
const EXPECTED_NODE_COUNT = 4762;
const EXPECTED_ROUTE_COUNT = 215;
const COLLECTION = "lk_a3pay_dev_viva_booking_ops";
const MONGO_CLIENT_ID = "4e820638cc39c730";

export const A3PAY_DEV_VIVA_BOOKING_IDS = Object.freeze({
  comment: "a3pay_dev_viva_booking_comment_20260828",
  postIn: "a3pay_dev_viva_booking_post_20260828",
  prepare: "a3pay_dev_viva_booking_prepare_20260828",
  http: "a3pay_dev_viva_booking_http_20260828",
  router: "a3pay_dev_viva_booking_router_20260828",
  mongoFind: "a3pay_dev_viva_booking_find_20260828",
  mongoUpdate: "a3pay_dev_viva_booking_update_20260828",
  response: "a3pay_dev_viva_booking_response_20260828",
  catch: "a3pay_dev_viva_booking_catch_20260828",
  mongoError: "a3pay_dev_viva_booking_mongo_error_20260828",
  optionsIn: "a3pay_dev_viva_booking_options_in_20260828",
  options: "a3pay_dev_viva_booking_options_20260828",
  optionsResponse: "a3pay_dev_viva_booking_options_response_20260828",
  debug: "a3pay_dev_viva_booking_debug_20260828",
});

const SOURCE_FILES = Object.freeze({
  prepare: "fn_a3pay_dev_viva_booking_prepare.js",
  router: "fn_a3pay_dev_viva_booking_router.js",
  options: "fn_a3pay_dev_viva_booking_options.js",
  mongoError: "fn_a3pay_dev_viva_booking_mongo_error.js",
});

const EXPECTED_FUNCTION_SHA256 = Object.freeze({
  prepare: "b48c743ab5dbeb2f64f9e9e6dbe388dfddeac249c13f53e9c04d719d8569ff24",
  router: "a434dcef1a965f3bae31e8b8af79e811728526833d5badc2127fb39402f5b974",
  options: "c0c81b31b5f819dc8efcce34149429b55a309f8a4f9443d0e43c36c9ce6a19b5",
  mongoError: "8c2c41f036f03effe66f403038543d953f767cf38ba1927c7cdbaed0e8de53cf",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const readFunction = (key) => fs.readFileSync(path.join(FN_DIR, SOURCE_FILES[key]), "utf8");
const functionNode = (id, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB_ID,
  name,
  func,
  outputs,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});

function assertPinnedFunctions() {
  for (const key of Object.keys(SOURCE_FILES)) {
    const actual = sha256(readFunction(key));
    if (actual !== EXPECTED_FUNCTION_SHA256[key]) {
      fail(`Candidate function source mismatch: ${SOURCE_FILES[key]}`);
    }
  }
}

function buildNodes() {
  const ids = A3PAY_DEV_VIVA_BOOKING_IDS;
  return [
    {
      id: ids.comment,
      type: "comment",
      z: TAB_ID,
      name: "Dev-only A3.pay Viva booking gateway (default off)",
      info: [
        "Source baseline: verified live primary 147; deployment target is reserve 89 only.",
        "Runtime requires three exact A3PAY_DEV_VIVA_BOOKING_* environment gates.",
        "A3 invoice and LK game creation are intentionally out of scope.",
        "Provider POST is never retried; durable state and read-back guard ambiguity.",
      ].join("\n"),
      x: 300,
      y: 5660,
      wires: [],
    },
    {
      id: ids.postIn,
      type: "http in",
      z: TAB_ID,
      name: "LK dev A3.pay Viva booking",
      url: "/lk/games/a3pay/dev/viva-booking/:action",
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 260,
      y: 5720,
      wires: [[ids.prepare]],
    },
    functionNode(
      ids.prepare,
      "Prepare dev-only Viva booking",
      readFunction("prepare"),
      2,
      560,
      5720,
      [[ids.http], [ids.response]],
    ),
    {
      id: ids.http,
      type: "http request",
      z: TAB_ID,
      name: "A3.pay dev Viva request (no retry)",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "20000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      headers: [{
        keyType: "other",
        keyValue: "User-Agent",
        valueType: "other",
        valueValue: "PadlHub-LK-Dev-A3Pay/1.0",
      }],
      x: 880,
      y: 5700,
      wires: [[ids.router]],
    },
    functionNode(
      ids.router,
      "Route durable dev Viva booking",
      readFunction("router"),
      5,
      1190,
      5720,
      [[ids.http], [ids.mongoFind], [ids.mongoUpdate], [ids.response], [ids.debug]],
    ),
    {
      id: ids.mongoFind,
      type: "mongodb4",
      z: TAB_ID,
      name: "Read A3.pay dev Viva operation",
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      collection: COLLECTION,
      operation: "find",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      x: 1510,
      y: 5680,
      wires: [[ids.router]],
    },
    {
      id: ids.mongoUpdate,
      type: "mongodb4",
      z: TAB_ID,
      name: "Update A3.pay dev Viva operation",
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      collection: COLLECTION,
      operation: "updateOne",
      output: "toArray",
      maxTimeMS: "5000",
      handleDocId: false,
      x: 1520,
      y: 5740,
      wires: [[ids.router]],
    },
    {
      id: ids.response,
      type: "http response",
      z: TAB_ID,
      name: "",
      statusCode: "",
      headers: {},
      x: 1800,
      y: 5800,
      wires: [],
    },
    {
      id: ids.catch,
      type: "catch",
      z: TAB_ID,
      name: "Catch A3.pay dev persistence errors",
      scope: [ids.mongoFind, ids.mongoUpdate],
      uncaught: false,
      x: 1510,
      y: 5860,
      wires: [[ids.mongoError]],
    },
    functionNode(
      ids.mongoError,
      "Fail closed on A3.pay dev persistence",
      readFunction("mongoError"),
      1,
      1810,
      5860,
      [[ids.response]],
    ),
    {
      id: ids.optionsIn,
      type: "http in",
      z: TAB_ID,
      name: "OPTIONS LK dev A3.pay Viva booking",
      url: "/lk/games/a3pay/dev/viva-booking/:action",
      method: "options",
      upload: false,
      swaggerDoc: "",
      x: 280,
      y: 5920,
      wires: [[ids.options]],
    },
    functionNode(
      ids.options,
      "A3.pay dev Viva booking CORS",
      readFunction("options"),
      1,
      620,
      5920,
      [[ids.optionsResponse]],
    ),
    {
      id: ids.optionsResponse,
      type: "http response",
      z: TAB_ID,
      name: "",
      statusCode: "",
      headers: {},
      x: 950,
      y: 5920,
      wires: [],
    },
    {
      id: ids.debug,
      type: "debug",
      z: TAB_ID,
      name: "A3.pay dev Viva booking debug",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 1510,
      y: 5920,
      wires: [],
    },
  ];
}

export function buildA3PayDevVivaBookingCandidate(inputFlow, options = {}) {
  if (!Array.isArray(inputFlow)) fail("Node-RED flow must be an array");
  assertPinnedFunctions();
  const sourceSha256 = options.sourceSha256 || sha256(Buffer.from(JSON.stringify(inputFlow)));
  if (options.enforceLiveContract !== false) {
    if (sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
    if (inputFlow.length !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
    if (inputFlow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
      fail("Live flow HTTP route count mismatch");
    }
  }
  const tab = inputFlow.filter((node) => node.id === TAB_ID && node.type === "tab");
  if (tab.length !== 1 || tab[0].label !== "LK Games" || tab[0].disabled !== false) {
    fail("LK Games tab contract mismatch");
  }

  const managedIds = new Set(Object.values(A3PAY_DEV_VIVA_BOOKING_IDS));
  if (inputFlow.some((node) => managedIds.has(node.id))) fail("A3.pay dev node id already exists");
  const routeKey = (node) => `${node.method}:${node.url}`;
  const managedRoutes = new Set([
    "post:/lk/games/a3pay/dev/viva-booking/:action",
    "options:/lk/games/a3pay/dev/viva-booking/:action",
  ]);
  if (inputFlow.some((node) => node.type === "http in" && managedRoutes.has(routeKey(node)))) {
    fail("A3.pay dev route already exists");
  }

  const before = structuredClone(inputFlow);
  const addedNodes = buildNodes();
  const candidate = [...structuredClone(inputFlow), ...addedNodes];
  const byId = new Map(candidate.map((node) => [node.id, node]));
  if (byId.size !== candidate.length) fail("Candidate contains duplicate node ids");
  for (const node of candidate) {
    for (const target of (node.wires || []).flat()) {
      if (!byId.has(target)) fail(`Dangling wire ${node.id} -> ${target}`);
    }
    if (node.type === "function" && node.wires.length !== node.outputs) {
      fail(`Function output/wire count mismatch: ${node.id}`);
    }
  }
  if (!isDeepStrictEqual(candidate.slice(0, before.length), before)) {
    fail("Candidate modified the verified live preimage");
  }
  if (candidate.length !== before.length + addedNodes.length) fail("Candidate node delta mismatch");
  if (candidate.filter((node) => node.type === "http in").length
    !== before.filter((node) => node.type === "http in").length + 2) {
    fail("Candidate route delta mismatch");
  }
  const functionSources = addedNodes.filter((node) => node.type === "function").map((node) => node.func);
  for (const source of functionSources) {
    if (/grant_type=password|password\s*[:=]|client_secret\s*[:=]|refresh_token\s*[:=]/i.test(source)) {
      fail("Candidate contains a credential literal path");
    }
  }
  const routerSource = readFunction("router");
  if (!/state:\s*"PROVIDER_PENDING"/.test(routerSource)
    || !/state:\s*"PROVIDER_UNVERIFIED"/.test(routerSource)
    || !/VIVA_BOOKING_CREATED/.test(routerSource)
    || !/cancel_readback/.test(routerSource)) {
    fail("Candidate is missing required durable provider states");
  }
  if (/paymentUrl\s*:/.test(routerSource)) {
    fail("Candidate must never return or persist a Viva payment URL");
  }

  return {
    candidate,
    addedNodes,
    addedNodeIds: addedNodes.map((node) => node.id),
    sourceSha256,
    candidateSha256: sha256(Buffer.from(JSON.stringify(candidate))),
    additiveImportSha256: sha256(Buffer.from(JSON.stringify(addedNodes))),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) parsed[argv[index]] = argv[index + 1];
  if (!parsed["--workspace"] || !parsed["--output"] || !parsed["--report"]) {
    fail("Usage: --workspace <verified-live-workspace> --output <candidate.json> --report <report.json>");
  }
  return parsed;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  const result = buildA3PayDevVivaBookingCandidate(verified.source, {
    sourceSha256: verified.sourceSha256,
  });
  writeJson(path.resolve(args["--output"]), result.addedNodes);
  writeJson(path.resolve(args["--report"]), {
    kind: "a3pay-dev-viva-booking-additive-import-candidate",
    sourceHost: "lk-primary-147",
    intendedTargetHost: "lk-reserve-89",
    sourceSha256: result.sourceSha256,
    candidateSha256: result.candidateSha256,
    additiveImportSha256: result.additiveImportSha256,
    addedNodeIds: result.addedNodeIds,
    routeDelta: 2,
    collection: COLLECTION,
    deployAuthorized: false,
    importAuthorized: false,
    liveMutationAuthorized: false,
    providerMutationTested: false,
    requiresReservePreimageReconciliation: true,
    runtimeFlags: {
      A3PAY_DEV_VIVA_BOOKING_ENABLED: "true",
      A3PAY_DEV_VIVA_BOOKING_TARGET: "lk-reserve-89",
      A3PAY_DEV_VIVA_BOOKING_TENANT: "iSkq6G",
      HOSTNAME: "89-108-64-209.cloudvps.regruhosting.ru",
      A3PAY_DEV_VIVA_BOOKING_CLIENT_IDS: "<exact-test-client-id allowlist>",
      A3PAY_DEV_VIVA_BOOKING_STUDIO_IDS: "<exact-test-studio-id allowlist>",
      A3PAY_DEV_VIVA_BOOKING_MASTER_SERVICE_IDS: "<exact-test-master-service-id allowlist>",
    },
    requiredIndex: {
      collection: COLLECTION,
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
      configured: false,
    },
    nonterminalReconciliation: {
      states: [
        "SNAPSHOT_PENDING",
        "PROVIDER_PENDING",
        "PROVIDER_UNVERIFIED",
        "PROVIDER_RESULT_RECEIVED",
        "VIVA_BOOKING_CREATED",
        "CANCEL_PENDING",
      ],
      automaticProviderMutation: false,
      retention: "no TTL until an explicit verified terminal state",
      operatorAction: [
        "read the exact operation and Viva booking history by operation marker",
        "preserve the record while provider outcome is ambiguous",
        "confirm or cancel only through the guarded route and verify Viva read-back",
      ],
      configured: false,
    },
    activationBlockers: [
      "fresh reserve flow preimage reconciliation",
      "exact test client, studio and master-service allowlists",
      "expiresAt TTL index creation and read-back",
      "operator reconciliation ownership for every nonterminal operation",
    ],
  });
}
