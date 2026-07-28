import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_FLOW_PATH = path.resolve(
  ROOT,
  process.env.NODERED_SOURCE_PATH || "node-red/modular/source.flow.json",
);
const FUNCTION_DIR = path.resolve(ROOT, "scripts/nodered_games_nodes");
const REFERRAL_TAB_LABEL = "LK Referral Subscriptions";
let TAB_ID = "f0a407d98e53109d";
let MONGO_CLIENT_ID = "4e820638cc39c730";
const REFERRAL_COLLECTION = "lk_referral_subscription_sales";
const REFERRAL_INVITE_COLLECTION = "lk_referral_subscription_invites";

const NODE_IDS = {
  inviteHttpIn: "f6a7b8c9d0e64001",
  invitePrepare: "f6a7b8c9d0e64002",
  inviteMongoAdapt: "mongo4_adapt_f6a7b8c9d0e64003",
  inviteUpsert: "f6a7b8c9d0e64003",
  inviteResponse: "f6a7b8c9d0e64004",
  inviteHttpResponse: "f6a7b8c9d0e64005",
  inviteDebug: "f6a7b8c9d0e64006",
  statusHttpIn: "f6a7b8c9d0e64101",
  statusPrepare: "f6a7b8c9d0e64102",
  statusHttpRequest: "f6a7b8c9d0e64103",
  statusOwnerResolve: "f6a7b8c9d0e64104",
  statusInviteLookup: "f6a7b8c9d0e64109",
  statusFindSales: "f6a7b8c9d0e64105",
  statusResponse: "f6a7b8c9d0e64106",
  statusHttpResponse: "f6a7b8c9d0e64107",
  statusDebug: "f6a7b8c9d0e64108",
  purchaseHttpIn: "f6a7b8c9d0e64201",
  purchasePrepare: "f6a7b8c9d0e64202",
  purchaseOwnerRequest: "f6a7b8c9d0e64203",
  purchaseOwnerResolve: "f6a7b8c9d0e64204",
  purchaseInviteLookup: "f6a7b8c9d0e64212",
  purchaseFindSales: "f6a7b8c9d0e64205",
  purchaseLimit: "f6a7b8c9d0e64206",
  purchaseTransactionRequest: "f6a7b8c9d0e64207",
  purchaseResolve: "f6a7b8c9d0e64208",
  purchaseMongoAdapt: "mongo4_adapt_f6a7b8c9d0e64209",
  purchaseUpsert: "f6a7b8c9d0e64209",
  purchaseHttpResponse: "f6a7b8c9d0e64210",
  purchaseDebug: "f6a7b8c9d0e64211",
  confirmHttpIn: "f6a7b8c9d0e64301",
  confirmPrepare: "f6a7b8c9d0e64302",
  confirmFindRecord: "f6a7b8c9d0e64303",
  confirmResolve: "f6a7b8c9d0e64304",
  confirmHttpRequest: "f6a7b8c9d0e64305",
  confirmMongoAdapt: "mongo4_adapt_f6a7b8c9d0e64306",
  confirmUpsert: "f6a7b8c9d0e64306",
  confirmHttpResponse: "f6a7b8c9d0e64307",
  confirmDebug: "f6a7b8c9d0e64308",
};

const REFERRAL_URLS = new Set([
  "/lk/tournaments/referral-subscription/invite",
  "/lk/tournaments/referral-subscription/status",
  "/lk/tournaments/referral-subscription/purchase",
  "/lk/tournaments/referral-subscription/confirm",
]);

const REFERRAL_NAMES = new Set([
  "LK referral subscription invite",
  "Prepare referral subscription invite",
  "Upsert referral subscription invite -> mongodb4 args",
  "Upsert referral subscription invite",
  "Build referral subscription invite response",
  "referral subscription invite debug",
  "LK referral subscription status",
  "Prepare referral subscription status",
  "Viva referral subscription owner status request",
  "Resolve referral subscription owner status",
  "Find referral subscription invite",
  "Find referral subscription sales by owner",
  "Build referral subscription status",
  "referral subscription status debug",
  "LK referral subscription purchase",
  "Prepare referral subscription purchase",
  "Viva referral subscription owner purchase request",
  "Resolve referral subscription owner purchase",
  "Find referral subscription invite for purchase",
  "Find referral subscription plan sales",
  "Check referral subscription limit",
  "Viva referral subscription transaction request",
  "Resolve referral subscription purchase",
  "Upsert referral subscription sale -> mongodb4 args",
  "Upsert referral subscription sale",
  "referral subscription purchase debug",
  "LK referral subscription confirm",
  "Prepare referral subscription confirm",
  "Find referral subscription record by paymentRef",
  "Resolve referral subscription confirm",
  "Viva referral subscription confirm request",
  "Upsert referral subscription confirm state -> mongodb4 args",
  "Upsert referral subscription confirm state",
  "referral subscription confirm debug",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readFunctionSource(fileName) {
  return fs.readFileSync(path.join(FUNCTION_DIR, fileName), "utf8");
}

function buildMongoAdaptNode(id, name, targetId, x, y) {
  return {
    id,
    type: "function",
    z: TAB_ID,
    name,
    func:
      'const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};\n'
      + 'const rawUpdate = Array.isArray(msg.payload) ? (msg.payload[1] || {}) : (msg.payload || {});\n'
      + 'const update = Array.isArray(rawUpdate)\n'
      + '  ? rawUpdate\n'
      + '  : ((rawUpdate && typeof rawUpdate === "object") ? rawUpdate : {});\n'
      + 'const hasAtomicOperators = Array.isArray(update)\n'
      + '  ? true\n'
      + '  : Object.keys(update).some((key) => String(key).startsWith("$"));\n'
      + 'if (!hasAtomicOperators) {\n'
      + '  return null;\n'
      + '}\n'
      + 'if (!Array.isArray(update)) {\n'
      + '  const setDoc = update.$set && typeof update.$set === "object" ? update.$set : null;\n'
      + '  const setOnInsertDoc = update.$setOnInsert && typeof update.$setOnInsert === "object" ? update.$setOnInsert : null;\n'
      + '  if (setDoc && setOnInsertDoc) {\n'
      + '    for (const key of Object.keys(setOnInsertDoc)) {\n'
      + '      if (Object.prototype.hasOwnProperty.call(setDoc, key)) {\n'
      + '        delete setDoc[key];\n'
      + '      }\n'
      + '    }\n'
      + '  }\n'
      + '}\n'
      + 'msg.payload = [filter, update, { upsert: true }];\n'
      + 'delete msg.query;\n'
      + 'delete msg.mongoQuery;\n'
      + 'delete msg.mongoUpdate;\n'
      + 'return msg;',
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x,
    y,
    wires: [[targetId]],
  };
}

function buildNodes() {
  return [
    {
      id: NODE_IDS.inviteHttpIn,
      type: "http in",
      z: TAB_ID,
      name: "LK referral subscription invite",
      url: "/lk/tournaments/referral-subscription/invite",
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 180,
      y: 2360,
      wires: [[NODE_IDS.invitePrepare]],
    },
    {
      id: NODE_IDS.invitePrepare,
      type: "function",
      z: TAB_ID,
      name: "Prepare referral subscription invite",
      func: readFunctionSource("fn_referral_subscription_invite_prepare.js"),
      outputs: 3,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 500,
      y: 2360,
      wires: [
        [NODE_IDS.inviteMongoAdapt],
        [NODE_IDS.inviteHttpResponse],
        [NODE_IDS.inviteDebug],
      ],
    },
    buildMongoAdaptNode(
      NODE_IDS.inviteMongoAdapt,
      "Upsert referral subscription invite -> mongodb4 args",
      NODE_IDS.inviteUpsert,
      820,
      2360,
    ),
    {
      id: NODE_IDS.inviteUpsert,
      type: "mongodb4",
      z: TAB_ID,
      name: "Upsert referral subscription invite",
      collection: REFERRAL_INVITE_COLLECTION,
      operation: "updateOne",
      x: 1120,
      y: 2360,
      wires: [[NODE_IDS.inviteResponse]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.inviteResponse,
      type: "function",
      z: TAB_ID,
      name: "Build referral subscription invite response",
      func: readFunctionSource("fn_referral_subscription_invite_response.js"),
      outputs: 2,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1440,
      y: 2360,
      wires: [
        [NODE_IDS.inviteHttpResponse],
        [NODE_IDS.inviteDebug],
      ],
    },
    {
      id: NODE_IDS.inviteHttpResponse,
      type: "http response",
      z: TAB_ID,
      name: "",
      x: 1740,
      y: 2360,
      wires: [],
    },
    {
      id: NODE_IDS.inviteDebug,
      type: "debug",
      z: TAB_ID,
      name: "referral subscription invite debug",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 1740,
      y: 2320,
      wires: [],
    },
    {
      id: NODE_IDS.statusHttpIn,
      type: "http in",
      z: TAB_ID,
      name: "LK referral subscription status",
      url: "/lk/tournaments/referral-subscription/status",
      method: "get",
      upload: false,
      swaggerDoc: "",
      x: 180,
      y: 2440,
      wires: [[NODE_IDS.statusPrepare]],
    },
    {
      id: NODE_IDS.statusPrepare,
      type: "function",
      z: TAB_ID,
      name: "Prepare referral subscription status",
      func: readFunctionSource("fn_referral_subscription_status_prepare.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 500,
      y: 2440,
      wires: [
        [NODE_IDS.statusHttpRequest],
        [NODE_IDS.statusHttpResponse],
        [NODE_IDS.statusDebug],
        [NODE_IDS.statusInviteLookup],
      ],
    },
    {
      id: NODE_IDS.statusHttpRequest,
      type: "http request",
      z: TAB_ID,
      name: "Viva referral subscription owner status request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "20000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      x: 820,
      y: 2440,
      wires: [[NODE_IDS.statusOwnerResolve]],
    },
    {
      id: NODE_IDS.statusOwnerResolve,
      type: "function",
      z: TAB_ID,
      name: "Resolve referral subscription owner status",
      func: readFunctionSource("fn_referral_subscription_owner_resolve.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1140,
      y: 2440,
      wires: [
        [NODE_IDS.statusHttpRequest],
        [NODE_IDS.statusFindSales],
        [NODE_IDS.statusHttpResponse],
        [NODE_IDS.statusDebug],
      ],
    },
    {
      id: NODE_IDS.statusInviteLookup,
      type: "mongodb4",
      z: TAB_ID,
      name: "Find referral subscription invite",
      collection: REFERRAL_INVITE_COLLECTION,
      operation: "find",
      x: 820,
      y: 2480,
      wires: [[NODE_IDS.statusOwnerResolve]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.statusFindSales,
      type: "mongodb4",
      z: TAB_ID,
      name: "Find referral subscription sales by owner",
      collection: REFERRAL_COLLECTION,
      operation: "find",
      x: 1440,
      y: 2480,
      wires: [[NODE_IDS.statusResponse]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.statusResponse,
      type: "function",
      z: TAB_ID,
      name: "Build referral subscription status",
      func: readFunctionSource("fn_referral_subscription_status_response.js"),
      outputs: 2,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1740,
      y: 2480,
      wires: [
        [NODE_IDS.statusHttpResponse],
        [NODE_IDS.statusDebug],
      ],
    },
    {
      id: NODE_IDS.statusHttpResponse,
      type: "http response",
      z: TAB_ID,
      name: "",
      x: 2040,
      y: 2440,
      wires: [],
    },
    {
      id: NODE_IDS.statusDebug,
      type: "debug",
      z: TAB_ID,
      name: "referral subscription status debug",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 2050,
      y: 2480,
      wires: [],
    },
    {
      id: NODE_IDS.purchaseHttpIn,
      type: "http in",
      z: TAB_ID,
      name: "LK referral subscription purchase",
      url: "/lk/tournaments/referral-subscription/purchase",
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 180,
      y: 2560,
      wires: [[NODE_IDS.purchasePrepare]],
    },
    {
      id: NODE_IDS.purchasePrepare,
      type: "function",
      z: TAB_ID,
      name: "Prepare referral subscription purchase",
      func: readFunctionSource("fn_referral_subscription_purchase_prepare.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 500,
      y: 2560,
      wires: [
        [NODE_IDS.purchaseOwnerRequest],
        [NODE_IDS.purchaseHttpResponse],
        [NODE_IDS.purchaseDebug],
        [NODE_IDS.purchaseInviteLookup],
      ],
    },
    {
      id: NODE_IDS.purchaseOwnerRequest,
      type: "http request",
      z: TAB_ID,
      name: "Viva referral subscription owner purchase request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "20000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      x: 820,
      y: 2560,
      wires: [[NODE_IDS.purchaseOwnerResolve]],
    },
    {
      id: NODE_IDS.purchaseOwnerResolve,
      type: "function",
      z: TAB_ID,
      name: "Resolve referral subscription owner purchase",
      func: readFunctionSource("fn_referral_subscription_owner_resolve.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1140,
      y: 2560,
      wires: [
        [NODE_IDS.purchaseOwnerRequest],
        [NODE_IDS.purchaseFindSales],
        [NODE_IDS.purchaseHttpResponse],
        [NODE_IDS.purchaseDebug],
      ],
    },
    {
      id: NODE_IDS.purchaseInviteLookup,
      type: "mongodb4",
      z: TAB_ID,
      name: "Find referral subscription invite for purchase",
      collection: REFERRAL_INVITE_COLLECTION,
      operation: "find",
      x: 820,
      y: 2720,
      wires: [[NODE_IDS.purchaseOwnerResolve]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.purchaseFindSales,
      type: "mongodb4",
      z: TAB_ID,
      name: "Find referral subscription plan sales",
      collection: REFERRAL_COLLECTION,
      operation: "find",
      x: 1440,
      y: 2600,
      wires: [[NODE_IDS.purchaseLimit]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.purchaseLimit,
      type: "function",
      z: TAB_ID,
      name: "Check referral subscription limit",
      func: readFunctionSource("fn_referral_subscription_purchase_limit.js"),
      outputs: 3,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1740,
      y: 2600,
      wires: [
        [NODE_IDS.purchaseTransactionRequest],
        [NODE_IDS.purchaseHttpResponse],
        [NODE_IDS.purchaseDebug],
      ],
    },
    {
      id: NODE_IDS.purchaseTransactionRequest,
      type: "http request",
      z: TAB_ID,
      name: "Viva referral subscription transaction request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "20000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      x: 2050,
      y: 2560,
      wires: [[NODE_IDS.purchaseResolve]],
    },
    {
      id: NODE_IDS.purchaseResolve,
      type: "function",
      z: TAB_ID,
      name: "Resolve referral subscription purchase",
      func: readFunctionSource("fn_referral_subscription_purchase_resolve.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 2360,
      y: 2560,
      wires: [
        [NODE_IDS.purchaseTransactionRequest],
        [NODE_IDS.purchaseMongoAdapt],
        [NODE_IDS.purchaseHttpResponse],
        [NODE_IDS.purchaseDebug],
      ],
    },
    buildMongoAdaptNode(
      NODE_IDS.purchaseMongoAdapt,
      "Upsert referral subscription sale -> mongodb4 args",
      NODE_IDS.purchaseUpsert,
      2360,
      2620,
    ),
    {
      id: NODE_IDS.purchaseUpsert,
      type: "mongodb4",
      z: TAB_ID,
      name: "Upsert referral subscription sale",
      collection: REFERRAL_COLLECTION,
      operation: "updateOne",
      x: 2660,
      y: 2620,
      wires: [],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.purchaseHttpResponse,
      type: "http response",
      z: TAB_ID,
      name: "",
      x: 2960,
      y: 2560,
      wires: [],
    },
    {
      id: NODE_IDS.purchaseDebug,
      type: "debug",
      z: TAB_ID,
      name: "referral subscription purchase debug",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 2960,
      y: 2620,
      wires: [],
    },
    {
      id: NODE_IDS.confirmHttpIn,
      type: "http in",
      z: TAB_ID,
      name: "LK referral subscription confirm",
      url: "/lk/tournaments/referral-subscription/confirm",
      method: "post",
      upload: false,
      swaggerDoc: "",
      x: 180,
      y: 2680,
      wires: [[NODE_IDS.confirmPrepare]],
    },
    {
      id: NODE_IDS.confirmPrepare,
      type: "function",
      z: TAB_ID,
      name: "Prepare referral subscription confirm",
      func: readFunctionSource("fn_referral_subscription_confirm_prepare.js"),
      outputs: 3,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 500,
      y: 2680,
      wires: [
        [NODE_IDS.confirmFindRecord],
        [NODE_IDS.confirmHttpResponse],
        [NODE_IDS.confirmDebug],
      ],
    },
    {
      id: NODE_IDS.confirmFindRecord,
      type: "mongodb4",
      z: TAB_ID,
      name: "Find referral subscription record by paymentRef",
      collection: REFERRAL_COLLECTION,
      operation: "find",
      x: 860,
      y: 2680,
      wires: [[NODE_IDS.confirmResolve]],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.confirmResolve,
      type: "function",
      z: TAB_ID,
      name: "Resolve referral subscription confirm",
      func: readFunctionSource("fn_referral_subscription_confirm_resolve.js"),
      outputs: 4,
      timeout: "",
      noerr: 0,
      initialize: "",
      finalize: "",
      libs: [],
      x: 1180,
      y: 2680,
      wires: [
        [NODE_IDS.confirmHttpRequest],
        [NODE_IDS.confirmMongoAdapt],
        [NODE_IDS.confirmHttpResponse],
        [NODE_IDS.confirmDebug],
      ],
    },
    {
      id: NODE_IDS.confirmHttpRequest,
      type: "http request",
      z: TAB_ID,
      name: "Viva referral subscription confirm request",
      method: "use",
      ret: "obj",
      paytoqs: "ignore",
      url: "",
      requestTimeout: "20000",
      senderr: true,
      persist: false,
      authType: "",
      insecureHTTPParser: false,
      x: 1460,
      y: 2640,
      wires: [[NODE_IDS.confirmResolve]],
    },
    buildMongoAdaptNode(
      NODE_IDS.confirmMongoAdapt,
      "Upsert referral subscription confirm state -> mongodb4 args",
      NODE_IDS.confirmUpsert,
      1480,
      2720,
    ),
    {
      id: NODE_IDS.confirmUpsert,
      type: "mongodb4",
      z: TAB_ID,
      name: "Upsert referral subscription confirm state",
      collection: REFERRAL_COLLECTION,
      operation: "updateOne",
      x: 1780,
      y: 2720,
      wires: [],
      clientNode: MONGO_CLIENT_ID,
      mode: "collection",
      output: "toArray",
      maxTimeMS: "0",
      handleDocId: false,
    },
    {
      id: NODE_IDS.confirmHttpResponse,
      type: "http response",
      z: TAB_ID,
      name: "",
      x: 2060,
      y: 2680,
      wires: [],
    },
    {
      id: NODE_IDS.confirmDebug,
      type: "debug",
      z: TAB_ID,
      name: "referral subscription confirm debug",
      active: false,
      tosidebar: true,
      console: false,
      tostatus: false,
      complete: "payload",
      targetType: "msg",
      statusVal: "",
      statusType: "auto",
      x: 2060,
      y: 2720,
      wires: [],
    },
  ];
}

function isReferralNode(node) {
  if (!node || typeof node !== "object") return false;
  if (node.id && Object.values(NODE_IDS).includes(node.id)) return true;
  if (node.type === "http in" && REFERRAL_URLS.has(node.url)) return true;
  return typeof node.name === "string" && REFERRAL_NAMES.has(node.name);
}

function resolveReferralTabId(flow) {
  const activeTabs = flow.filter((node) => (
    node?.type === "tab"
    && node.label === REFERRAL_TAB_LABEL
    && node.disabled !== true
  ));

  if (activeTabs.length !== 1) {
    throw new Error(
      `Expected exactly one enabled ${REFERRAL_TAB_LABEL} tab, found ${activeTabs.length}`,
    );
  }

  return activeTabs[0].id;
}

function resolveMongoClientId(flow, tabId) {
  const referencedClientIds = new Set(
    flow
      .filter((node) => node?.type === "mongodb4" && node.z === tabId && node.clientNode)
      .map((node) => node.clientNode),
  );

  if (referencedClientIds.size === 1) {
    const [clientId] = referencedClientIds;
    const client = flow.find((node) => node.id === clientId && node.type === "mongodb4-client");
    if (!client) {
      throw new Error(`Referral Mongo config node not found: ${clientId}`);
    }
    return clientId;
  }

  if (referencedClientIds.size > 1) {
    throw new Error(
      `Referral tab references multiple Mongo config nodes: ${[...referencedClientIds].join(", ")}`,
    );
  }

  const namedClients = flow.filter((node) => (
    node?.type === "mongodb4-client" && node.name === "lk_referral_subscription_mongo"
  ));
  if (namedClients.length === 1) return namedClients[0].id;

  const allClients = flow.filter((node) => node?.type === "mongodb4-client");
  if (allClients.length === 1) return allClients[0].id;

  throw new Error(
    `Unable to resolve one Mongo config for ${REFERRAL_TAB_LABEL}: found ${allClients.length}`,
  );
}

function collectReferralNodeIds(flow, tabId) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const referralIds = new Set(
    flow.filter((node) => isReferralNode(node)).map((node) => node.id),
  );

  for (const nodeId of [...referralIds]) {
    const node = byId.get(nodeId);
    for (const output of node?.wires || []) {
      for (const targetId of output || []) {
        const target = byId.get(targetId);
        if (target?.type === "http response" && target.z === tabId) {
          referralIds.add(targetId);
        }
      }
    }
  }

  return referralIds;
}

function validateReferralGraph(flow, tabId, mongoClientId) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  if (!byId.has(tabId)) throw new Error(`Referral tab not found after patch: ${tabId}`);
  if (!byId.has(mongoClientId)) {
    throw new Error(`Referral Mongo config not found after patch: ${mongoClientId}`);
  }

  const referralNodes = flow.filter((node) => isReferralNode(node));
  const wrongTabNodes = referralNodes.filter((node) => node.z !== tabId);
  if (wrongTabNodes.length > 0) {
    throw new Error(
      `Referral nodes assigned to the wrong tab: ${wrongTabNodes.map((node) => node.id).join(", ")}`,
    );
  }

  for (const url of REFERRAL_URLS) {
    const routes = flow.filter((node) => node.type === "http in" && node.url === url);
    if (routes.length !== 1) {
      throw new Error(`Expected exactly one referral route ${url}, found ${routes.length}`);
    }
  }

  const purchasePrepare = byId.get(NODE_IDS.purchasePrepare);
  const purchaseLookup = byId.get(NODE_IDS.purchaseInviteLookup);
  const purchaseOwnerResolve = byId.get(NODE_IDS.purchaseOwnerResolve);
  if (!purchasePrepare || !purchaseLookup || !purchaseOwnerResolve) {
    throw new Error("Referral purchase invite lookup path is incomplete");
  }
  if (purchasePrepare.outputs !== 4) {
    throw new Error(`Referral purchase prepare must have 4 outputs, got ${purchasePrepare.outputs}`);
  }
  if (JSON.stringify(purchasePrepare.wires?.[3]) !== JSON.stringify([purchaseLookup.id])) {
    throw new Error("Referral purchase output 4 is not wired to invite lookup");
  }
  if (JSON.stringify(purchaseLookup.wires?.[0]) !== JSON.stringify([purchaseOwnerResolve.id])) {
    throw new Error("Referral purchase invite lookup is not wired to owner resolver");
  }
  if (purchaseLookup.clientNode !== mongoClientId) {
    throw new Error("Referral purchase invite lookup uses the wrong Mongo config");
  }

  for (const node of referralNodes) {
    for (const output of node.wires || []) {
      for (const targetId of output || []) {
        if (!byId.has(targetId)) {
          throw new Error(`Referral node ${node.id} has dangling wire to ${targetId}`);
        }
      }
    }
  }
}

function main() {
  const flow = readJson(SOURCE_FLOW_PATH);
  if (!Array.isArray(flow)) {
    throw new Error("source.flow.json must contain a JSON array");
  }

  TAB_ID = resolveReferralTabId(flow);
  MONGO_CLIENT_ID = resolveMongoClientId(flow, TAB_ID);

  const referralNodeIds = collectReferralNodeIds(flow, TAB_ID);
  const filtered = flow.filter((node) => !referralNodeIds.has(node.id));
  const insertIndex = filtered.findIndex((node) => node.id === MONGO_CLIENT_ID);
  const referralNodes = buildNodes();

  if (insertIndex === -1) {
    filtered.push(...referralNodes);
  } else {
    filtered.splice(insertIndex, 0, ...referralNodes);
  }

  validateReferralGraph(filtered, TAB_ID, MONGO_CLIENT_ID);
  writeJson(SOURCE_FLOW_PATH, filtered);
  console.log(
    `Patched ${SOURCE_FLOW_PATH} with ${referralNodes.length} referral nodes on ${TAB_ID}.`,
  );
}

main();
