import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  matchesManagedSubscriptionRouterTopology,
  resolveManagedSubscriptionRouterContract,
} from "./nodered_subscription_booking_router_contract.mjs";

const ROOT = process.cwd();
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const candidatePath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const importPath = process.argv[4]
  ? path.resolve(process.argv[4])
  : path.resolve(ROOT, "node-red/modular/imports/lk_subscription_booking.nodes.import.json");
const functionsDir = path.resolve(ROOT, "scripts/nodered_subscription_booking_nodes");
const EXPECTED_LIVE_ROUTER_SHA256 = "d9d6d1f17c12f38b567cf226468caa6780ed3d6e707f55f4af26c066be86b1a4";
const ROUTER_ID = "8f7bd5b482fe9763";
const COLLECTION = "lk_subscription_daily_booking_ops";

if (!sourcePath || !candidatePath) {
  throw new Error("Usage: node scripts/patch_nodered_subscription_booking_flow.mjs <fresh-live-source> <candidate-flow> [nodes-import]");
}
if (sourcePath === candidatePath) {
  throw new Error("Refusing to overwrite the verified live source snapshot");
}

const IDS = {
  comment: "lk_subscription_booking_comment_20260804",
  postIn: "lk_subscription_booking_post_20260804",
  prepare: "lk_subscription_booking_prepare_20260804",
  http: "lk_subscription_booking_http_20260804",
  router: "lk_subscription_booking_router_20260804",
  managedPolicy: "lk_subscription_managed_policy_20260820",
  managedPolicyBlocked: "lk_subscription_managed_policy_blocked_20260820",
  mongoFind: "lk_subscription_booking_find_20260804",
  mongoInsert: "lk_subscription_booking_insert_20260804",
  mongoUpdate: "lk_subscription_booking_update_20260804",
  finalize: "lk_subscription_booking_finalize_20260804",
  response: "lk_subscription_booking_response_20260804",
  catch: "lk_subscription_booking_catch_20260804",
  mongoError: "lk_subscription_booking_mongo_error_20260804",
  optionsIn: "lk_subscription_booking_options_in_20260804",
  options: "lk_subscription_booking_options_20260804",
  optionsResponse: "lk_subscription_booking_options_response_20260804",
  debug: "lk_subscription_booking_debug_20260804",
};

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readFunction = (name) => fs.readFileSync(path.join(functionsDir, name), "utf8");
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

function verifyLiveSource() {
  const metaPath = path.join(path.dirname(sourcePath), "source.flow.meta.json");
  const sourceBuffer = fs.readFileSync(sourcePath);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const pulledAt = Date.parse(String(meta.pulledAt || ""));
  const fresh = Number.isFinite(pulledAt)
    && Date.now() >= pulledAt
    && Date.now() - pulledAt <= 30 * 60 * 1000;
  const exactOrigin = meta.sourceKind === "live-147"
    && meta.sourceHost === "lk-primary-147"
    && meta.sourceUser === "root"
    && String(meta.sourcePort) === "22"
    && meta.remoteFlowPath === "/root/.node-red/flows.json";
  const sourceHash = sha256(sourceBuffer);
  if (!exactOrigin || !fresh || meta.sourceSha256 !== sourceHash) {
    throw new Error("Refusing to patch a stale or unverified live-147 Node-RED source");
  }
  return { flow: JSON.parse(sourceBuffer.toString("utf8")), sourceHash };
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Split router preimage mismatch: ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function patchSplitRouterSource(source) {
  if (sha256(source) !== EXPECTED_LIVE_ROUTER_SHA256) {
    throw new Error("Live split router SHA changed; refresh and review the preimage before patching");
  }
  const adminBlock = `const adminRequest = (ctx, method, path, payload) => {
  msg._splitCtx = ctx;
  msg.method = method;
  msg.url = \`${"${ADMIN_API}${path}"}\`;
  msg.headers = {
    Authorization: \`Bearer ${"${ctx.token}"}\`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, msg];
};`;
  const gatewayBlock = `${adminBlock}

const startSubscriptionBookingGateway = (ctx) => {
  const requestHeaders = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  const authHeader = toStr(requestHeaders.authorization || requestHeaders.Authorization);
  const operationId = toStr(
    requestHeaders["idempotency-key"]
    || requestHeaders["Idempotency-Key"]
    || msg.req?.query?.operationId,
  );
  if (!authHeader || !/^Bearer\\s+\\S+/i.test(authHeader)) {
    return fail(401, "Требуется авторизация Viva", {
      code: "SUBSCRIPTION_BOOKING_AUTH_REQUIRED",
    });
  }
  if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
    return fail(400, "Требуется корректный operationId", {
      code: "SUBSCRIPTION_BOOKING_OPERATION_ID_REQUIRED",
    });
  }

  msg._splitCtx = ctx;
  msg._subscriptionBooking = {
    caller: "split",
    step: "profile",
    tenantKey: "iSkq6G",
    operationId,
    authHeader,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    managedAction: ctx.action === "create"
      ? "CREATE_GAME"
      : ctx.action === "join"
        ? "JOIN_GAME"
        : null,
    spot: ctx.spot || null,
    subscriptionVisitCount: resolveSubscriptionVisitCount(ctx),
    startedAt: new Date().toISOString(),
  };
  msg.method = "GET";
  msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
  msg.headers = {
    Authorization: authHeader,
    Accept: "application/json",
  };
  msg.payload = undefined;
  return [null, null, null, msg];
};`;
  let next = replaceOnce(source, adminBlock, gatewayBlock, "admin request helper");
  const bookingTail = `  ctx.bookingPaymentType = bookingPaymentType;
  ctx.subscriptionVisitCount = subscriptionVisitCount;
  ctx.selectedPaymentMode = resolvePaymentMode(ctx.paymentMode);
  ctx.step = "create_booking";`;
  const guardedBookingTail = `  ctx.bookingPaymentType = bookingPaymentType;
  ctx.subscriptionVisitCount = subscriptionVisitCount;
  ctx.selectedPaymentMode = resolvePaymentMode(ctx.paymentMode);
  if (
    bookingPaymentType === "SUBSCRIPTION"
    && clientSubscriptionId
    && ctx.subscriptionGuardDone !== true
  ) {
    return startSubscriptionBookingGateway(ctx);
  }
  ctx.step = "create_booking";`;
  next = replaceOnce(next, bookingTail, guardedBookingTail, "subscription booking dispatch");
  return next;
}

function patchManagedRouterSource(source, contract) {
  if (!contract?.managedActionCandidateSha256) return source;
  const before = `    clientSubscriptionId: ctx.clientSubscriptionId,
    spot: ctx.spot || null,`;
  const after = `    clientSubscriptionId: ctx.clientSubscriptionId,
    managedAction: ctx.action === "create"
      ? "CREATE_GAME"
      : ctx.action === "join"
        ? "JOIN_GAME"
        : null,
    spot: ctx.spot || null,`;
  const next = replaceOnce(source, before, after, "managed subscription action");
  if (sha256(next) !== contract.managedActionCandidateSha256) {
    throw new Error("Managed split router candidate SHA changed");
  }
  return next;
}

function functionNode(tabId, id, name, func, outputs, x, y, wires) {
  return {
    id, type: "function", z: tabId, name, func, outputs, timeout: "", noerr: 0,
    initialize: "", finalize: "", libs: [], x, y, wires,
  };
}

function mongoNode(tabId, id, name, operation, clientNode, x, y, target) {
  return {
    id,
    type: "mongodb4",
    z: tabId,
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
    wires: [[target]],
  };
}

function buildManagedNodes(tabId, mongoClientId) {
  return [
    {
      id: IDS.comment,
      type: "comment",
      z: tabId,
      name: "Atomic daily subscription booking gateway",
      info: [
        "One server-owned operation verifies actor, exercise and exact clientSubscriptionId.",
        "Active and history Viva bookings are checked fail-closed before an atomic subscription+date claim.",
        "PENDING_CONFIRMATION is never released after an ambiguous upstream result.",
      ].join("\n"),
      x: 260,
      y: 5060,
      wires: [],
    },
    {
      id: IDS.postIn, type: "http in", z: tabId, name: "LK subscription booking",
      url: "/lk/subscription-bookings", method: "post", upload: false, swaggerDoc: "",
      x: 180, y: 5120, wires: [[IDS.prepare]],
    },
    functionNode(
      tabId, IDS.prepare, "Prepare subscription booking", readFunction("fn_subscription_booking_prepare.js"),
      2, 450, 5120, [[IDS.http], [IDS.finalize]],
    ),
    {
      id: IDS.http, type: "http request", z: tabId, name: "Subscription booking Viva request",
      method: "use", ret: "obj", paytoqs: "ignore", url: "", requestTimeout: "20000",
      senderr: true, persist: false, authType: "", insecureHTTPParser: false,
      x: 760, y: 5100, wires: [[IDS.router]],
    },
    functionNode(
      tabId, IDS.router, "Route atomic subscription booking", readFunction("fn_subscription_booking_router.js"),
      7, 1060, 5120,
      [[IDS.http], [IDS.mongoFind], [IDS.mongoInsert], [IDS.mongoUpdate], [IDS.finalize], [IDS.debug], [IDS.managedPolicy]],
    ),
    functionNode(
      tabId, IDS.managedPolicy, "Evaluate managed subscription policy",
      readFunction("fn_managed_subscription_policy_evaluate.js"),
      2, 1370, 5010, [[IDS.router], [IDS.managedPolicyBlocked]],
    ),
    functionNode(
      tabId, IDS.managedPolicyBlocked, "Block managed subscription decision",
      readFunction("fn_managed_subscription_policy_blocked.js"),
      1, 1690, 5010, [[IDS.finalize]],
    ),
    mongoNode(tabId, IDS.mongoFind, "Find daily subscription operation", "find", mongoClientId, 1380, 5060, IDS.router),
    mongoNode(tabId, IDS.mongoInsert, "Insert daily subscription operation", "insertOne", mongoClientId, 1390, 5110, IDS.router),
    mongoNode(tabId, IDS.mongoUpdate, "Update daily subscription operation", "updateOne", mongoClientId, 1390, 5160, IDS.router),
    functionNode(
      tabId, IDS.finalize, "Finalize subscription booking response", readFunction("fn_subscription_booking_finalize.js"),
      2, 1700, 5120, [[ROUTER_ID], [IDS.response]],
    ),
    {
      id: IDS.response, type: "http response", z: tabId, name: "", statusCode: "", headers: {},
      x: 1990, y: 5140, wires: [],
    },
    {
      id: IDS.catch, type: "catch", z: tabId, name: "Catch subscription booking persistence errors",
      scope: [IDS.mongoFind, IDS.mongoInsert, IDS.mongoUpdate], uncaught: false,
      x: 1370, y: 5230, wires: [[IDS.mongoError]],
    },
    functionNode(
      tabId, IDS.mongoError, "Fail closed on subscription booking persistence", readFunction("fn_subscription_booking_mongo_error.js"),
      1, 1730, 5230, [[IDS.finalize]],
    ),
    {
      id: IDS.optionsIn, type: "http in", z: tabId, name: "OPTIONS subscription booking",
      url: "/lk/subscription-bookings", method: "options", upload: false, swaggerDoc: "",
      x: 200, y: 5310, wires: [[IDS.options]],
    },
    functionNode(
      tabId, IDS.options, "Subscription booking CORS", readFunction("fn_subscription_booking_options.js"),
      1, 500, 5310, [[IDS.optionsResponse]],
    ),
    {
      id: IDS.optionsResponse, type: "http response", z: tabId, name: "", statusCode: "", headers: {},
      x: 800, y: 5310, wires: [],
    },
    {
      id: IDS.debug, type: "debug", z: tabId, name: "subscription booking debug", active: false,
      tosidebar: true, console: false, tostatus: false, complete: "payload", targetType: "msg",
      statusVal: "", statusType: "auto", x: 1380, y: 5310, wires: [],
    },
  ];
}

function validateCandidate(flow, tabId, mongoClientId) {
  const ids = new Set(flow.map((node) => node.id));
  for (const node of flow.filter((item) => item.z === tabId)) {
    for (const output of node.wires || []) {
      for (const target of output || []) {
        if (!ids.has(target)) throw new Error(`Dangling wire ${node.id} -> ${target}`);
      }
    }
  }
  for (const [method, url] of [["post", "/lk/subscription-bookings"], ["options", "/lk/subscription-bookings"]]) {
    const count = flow.filter((node) => node.type === "http in" && node.method === method && node.url === url).length;
    if (count !== 1) throw new Error(`Expected one ${method.toUpperCase()} ${url}, found ${count}`);
  }
  const managedMongoNodes = flow.filter((node) => (
    [IDS.mongoFind, IDS.mongoInsert, IDS.mongoUpdate].includes(node.id)
  ));
  if (managedMongoNodes.some((node) => node.clientNode !== mongoClientId)) {
    throw new Error("Subscription booking nodes use an inconsistent Mongo client");
  }
  const splitRouter = flow.find((node) => node.id === ROUTER_ID);
  if (!matchesManagedSubscriptionRouterTopology(splitRouter)) {
    throw new Error("Split subscription dispatch was not wired to the atomic gateway");
  }
}

const { flow, sourceHash } = verifyLiveSource();
if (!Array.isArray(flow)) throw new Error("Node-RED source flow must be an array");
const tabs = flow.filter((node) => node.type === "tab" && node.disabled !== true && node.label === "LK Games");
if (tabs.length !== 1) throw new Error(`Expected one enabled LK Games tab, found ${tabs.length}`);
const tabId = tabs[0].id;
const routerNode = flow.find((node) => node.id === ROUTER_ID && node.z === tabId && node.type === "function");
const routerSha = routerNode?.func ? sha256(routerNode.func) : null;
const originalRouter = routerNode?.name === "Route Viva split payment"
  && routerNode.outputs === 3
  && routerSha === EXPECTED_LIVE_ROUTER_SHA256;
const managedRouterContract = resolveManagedSubscriptionRouterContract(routerNode, routerSha);
const managedRouter = Boolean(managedRouterContract);
if (!originalRouter && !managedRouter) {
  throw new Error("Live split router node preimage changed");
}
const mongoClientIds = Array.from(new Set(flow
  .filter((node) => node.type === "mongodb4" && node.z === tabId && node.collection === "lk_games")
  .map((node) => node.clientNode)
  .filter(Boolean)));
if (mongoClientIds.length !== 1) throw new Error(`Expected one LK Games Mongo client, found ${mongoClientIds.length}`);
const mongoClientId = mongoClientIds[0];
const managedIds = new Set(Object.values(IDS));
const managedRoutes = new Set(["post:/lk/subscription-bookings", "options:/lk/subscription-bookings"]);
const unmanagedDuplicate = flow.some((node) => (
  !managedIds.has(node.id)
  && node.type === "http in"
  && managedRoutes.has(`${node.method}:${node.url}`)
));
if (unmanagedDuplicate) throw new Error("An unmanaged subscription booking route already exists");

const next = flow.filter((node) => !managedIds.has(node.id));
const nextRouter = next.find((node) => node.id === ROUTER_ID);
if (originalRouter) {
  nextRouter.func = patchSplitRouterSource(nextRouter.func);
  nextRouter.outputs = 4;
  nextRouter.wires = [...nextRouter.wires, [IDS.http]];
} else if (managedRouterContract?.managedActionCandidateSha256) {
  nextRouter.func = patchManagedRouterSource(nextRouter.func, managedRouterContract);
}
const managedNodes = buildManagedNodes(tabId, mongoClientId);
const candidate = [...next, ...managedNodes];
validateCandidate(candidate, tabId, mongoClientId);
writeJson(candidatePath, candidate);
writeJson(importPath, [nextRouter, ...managedNodes]);

console.log(`sourceSha256=${sourceHash}`);
console.log(`candidateSha256=${sha256(fs.readFileSync(candidatePath))}`);
console.log(`managedNodeCount=${managedNodes.length + 1}`);
console.log(`mongoCollection=${COLLECTION}`);
