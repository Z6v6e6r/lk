#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  buildCandidate as buildPaymentCandidate,
  CONTRACT as BASE_PAYMENT_CONTRACT,
  PAYMENT_NODE_IDS,
} from "./patch_live_game_payment_confirmation.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");

export const FUTURE_VISIBILITY_CONTRACT = Object.freeze({
  sourceFlowSha256: "e38f844343ef290aa49f2583861dfc4488031b97d303ccbe36b3a5e12c292ec3",
  sourceNodeCount: 4768,
  httpRouteCount: 215,
  paymentCandidateSha256: "d392c710fb851bd20f1b074d6797f97c6d6838051e83f08cc1e58efd28045319",
  paymentCreateFuncSha256: "8907299b4ef267c4d5cb22fa966f45a0e6f436ddbf600ca865f7966df2565f7c",
  tabId: "4b91e2a2413688db",
  createNodeId: "e656cff36a8cd210",
  upsertArgsNodeId: "79307f9bcbc28b6c",
  mongoWriteNodeId: "5eaf4c087c0cc668",
  responseNodeId: "ae5ee70de15fe66e",
  debugNodeId: "60a3353902ae9973",
  autojoinNodeId: "9756d9125563753f",
});

export const FUTURE_VISIBILITY_NODE_IDS = Object.freeze({
  authPrepare: "lk_game_future_auth_prepare_20260906",
  authRequest: "lk_game_future_auth_request_20260906",
  authResolve: "lk_game_future_auth_resolve_20260906",
  authCatch: "lk_game_future_auth_catch_20260906",
  identityFind: "lk_game_future_identity_find_20260906",
  identityResolve: "lk_game_future_identity_resolve_20260906",
  identityCatch: "lk_game_future_identity_catch_20260906",
  writeAck: "lk_game_future_write_ack_20260906",
  writeReadback: "lk_game_future_write_readback_20260906",
  writeCatch: "lk_game_future_write_catch_20260906",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const readFn = (name) => fs.readFileSync(path.join(SOURCE_DIR, name), "utf8");
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Expected exact ${type} node ${id}`);
  return matches[0];
};
const replaceOnce = (source, before, after, label) => {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    fail(`Expected one exact ${label} preimage`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
};
const routes = (flow) => flow.filter((node) => node.type === "http in").map((node) => ({
  id: node.id,
  z: node.z ?? "",
  method: node.method ?? "",
  url: node.url ?? "",
  wires: node.wires ?? [],
}));
const withoutWires = (route) => {
  const copy = { ...route };
  delete copy.wires;
  return copy;
};
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
const normalizeNotBefore = (value) => {
  const normalized = String(value || "").trim();
  const parsed = Date.parse(normalized);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== normalized) {
    fail("Future write not-before must be a canonical UTC timestamp");
  }
  return normalized;
};

const paymentSourceContract = () => ({
  ...BASE_PAYMENT_CONTRACT,
  flowSha256: FUTURE_VISIBILITY_CONTRACT.sourceFlowSha256,
  nodeCount: FUTURE_VISIBILITY_CONTRACT.sourceNodeCount,
  httpRouteCount: FUTURE_VISIBILITY_CONTRACT.httpRouteCount,
});

const PAYMENT_CONFIRMATION_NODE_IDS = Object.freeze([
  PAYMENT_NODE_IDS.lookup,
  PAYMENT_NODE_IDS.find,
  PAYMENT_NODE_IDS.router,
  PAYMENT_NODE_IDS.request,
  PAYMENT_NODE_IDS.confirmClaimUpdate,
  PAYMENT_NODE_IDS.confirmClaimFind,
  PAYMENT_NODE_IDS.confirmWriteAck,
  PAYMENT_NODE_IDS.confirmWriteReadback,
]);

function removeUnrelatedCleanupPaymentChanges(flow, sourceFlow) {
  const sourceById = new Map(sourceFlow.map((node) => [node.id, node]));
  const restoreIds = [
    BASE_PAYMENT_CONTRACT.sourceTargets[0].id,
    BASE_PAYMENT_CONTRACT.sourceTargets[1].id,
    BASE_PAYMENT_CONTRACT.mongoWriteNodes[1].id,
  ];
  for (const id of restoreIds) {
    const index = flow.findIndex((node) => node.id === id);
    if (index < 0 || !sourceById.has(id)) fail(`Cleanup restoration target is missing: ${id}`);
    flow[index] = structuredClone(sourceById.get(id));
  }
  const keep = new Set(PAYMENT_CONFIRMATION_NODE_IDS);
  for (let index = flow.length - 1; index >= 0; index -= 1) {
    const id = flow[index].id;
    if (Object.values(PAYMENT_NODE_IDS).includes(id) && !keep.has(id)) flow.splice(index, 1);
  }
}

export function patchFutureCreateFunction(source, options = {}) {
  if (sha256(source) !== FUTURE_VISIBILITY_CONTRACT.paymentCreateFuncSha256) {
    fail("Payment-hardened create function preimage mismatch");
  }
  const notBefore = normalizeNotBefore(options.notBefore);
  let next = replaceOnce(
    source,
    `const booking = isObj(body.booking) ? body.booking : {};
`,
    `const FUTURE_GAME_WRITES_NOT_BEFORE = "${notBefore}";
const futureGameWritesNotBeforeMs = Date.parse(FUTURE_GAME_WRITES_NOT_BEFORE);
if (!Number.isFinite(futureGameWritesNotBeforeMs) || Date.now() < futureGameWritesNotBeforeMs) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Future game persistence is waiting for its reviewed activation time",
      code: "GAME_FUTURE_WRITE_NOT_ACTIVE",
      retryable: true,
      notBefore: FUTURE_GAME_WRITES_NOT_BEFORE,
    },
  });
  return [null, errMsg, errMsg, null];
}

const booking = isObj(body.booking) ? body.booking : {};
`,
    "future game activation fence",
  );
  next = replaceOnce(
    next,
    `const resolvedPaid =
  mode === "draft"`,
    `let resolvedPaid =
  mode === "draft"`,
    "server-canonical future payment state",
  );
  next = replaceOnce(
    next,
    `const expectedUpdatedAt = toStr(body.expectedUpdatedAt);
`,
    `const expectedUpdatedAt = toStr(body.expectedUpdatedAt);
const expectedRevisionSupplied = body.expectedRevision !== null && body.expectedRevision !== undefined
  && String(body.expectedRevision).trim() !== "";
if (expectedRevisionSupplied && expectedRevision === null) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "expectedRevision has invalid format", code: "GAME_REVISION_INVALID" },
  });
  return [null, errMsg, errMsg, null];
}
if (!gameId || gameId.length > 180) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "gameId has invalid format", code: "GAME_ID_INVALID" },
  });
  return [null, errMsg, errMsg, null];
}
if ((paymentRef && paymentRef.length > 180) || dedupeKey.length > 360) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Game persistence identity is too long", code: "GAME_WRITE_IDENTITY_INVALID" },
  });
  return [null, errMsg, errMsg, null];
}
`,
    "future game input validation",
  );
  next = replaceOnce(
    next,
    `const record = {
  id: gameId,
  tenantKey: toStr(body.tenantKey) || null,`,
    `const persistenceIdentityKind = "dedupe";
const persistenceIdentityValue = dedupeKey;
const persistentId = "lk_game_v1:" + tenantKey.length + ":" + tenantKey
  + ":" + persistenceIdentityKind + ":" + persistenceIdentityValue.length + ":" + persistenceIdentityValue;

const record = {
  id: gameId,
  tenantKey,`,
    "server-owned future game identity",
  );
  next = replaceOnce(
    next,
    `// GAME_PAYMENT_CONFIRM_GUARD_START
const paymentVerification = isObj(msg._gamePaymentVerified) ? msg._gamePaymentVerified : null;`,
    `// GAME_PAYMENT_CONFIRM_GUARD_START
const PLATFORM_TENANT_KEY = "iSkq6G";
let runtimeTenantKey = null;
try { runtimeTenantKey = toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY")); } catch (_error) { runtimeTenantKey = null; }
if (runtimeTenantKey && runtimeTenantKey !== PLATFORM_TENANT_KEY) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Game tenant configuration does not match this deployment", code: "GAME_TENANT_CONFIG_MISMATCH" },
  });
  return [null, errMsg, errMsg, null];
}
const tenantKey = PLATFORM_TENANT_KEY;
const requestedTenantKey = toStr(body.tenantKey);
if (requestedTenantKey && requestedTenantKey !== tenantKey) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 403,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Game tenant does not match this deployment", code: "GAME_TENANT_MISMATCH" },
  });
  return [null, errMsg, errMsg, null];
}
const futureGameAuth = isObj(msg._futureGameAuth) ? msg._futureGameAuth : null;
const futureBookingEvidence = isObj(futureGameAuth?.providerEvidence)
  ? futureGameAuth.providerEvidence
  : null;
const futureBookingIds = asArray(futureBookingEvidence?.bookingIds).map((value) => toStr(value)).filter(Boolean);
const futureActorBookingId = toStr(futureBookingEvidence?.actorBookingId);
const futureSettlementKind = toStr(futureBookingEvidence?.settlementKind);
const futureProviderCost = Number(futureBookingEvidence?.providerCost);
const futureProviderCostMinor = Number(futureBookingEvidence?.providerCostMinor);
const futureProviderCurrency = toStr(futureBookingEvidence?.providerCurrency);
const futureRequestAmount = Number(payment.amount);
const futureBookingEvidenceVerified = (
  futureGameAuth?.verified === true
  && futureGameAuth.mode === mode
  && futureGameAuth.tenantKey === tenantKey
  && futureBookingEvidence?.source === "viva_end_user_bookings"
  && toStr(futureBookingEvidence.exerciseId) === vivaExerciseId
  && futureActorBookingId
  && futureBookingIds.includes(futureActorBookingId)
  && bookingIds.includes(futureActorBookingId)
  && toStr(futureBookingEvidence.studioId)?.toLowerCase() === toStr(studioId)?.toLowerCase()
  && toStr(futureBookingEvidence.roomId)?.toLowerCase() === toStr(roomId)?.toLowerCase()
  && toStr(futureBookingEvidence.date) === toStr(date)
  && toStr(futureBookingEvidence.timeFrom) === toStr(timeFrom)?.slice(0, 5)
  && toStr(futureBookingEvidence.timeTo) === toStr(timeTo)?.slice(0, 5)
  && (mode !== "create" || futureBookingEvidence.settled === true)
  && (mode !== "create" || ["ZERO_DUE", "SUBSCRIPTION", "ONE_TIME_PAID"].includes(futureSettlementKind))
  && (mode !== "create" || futureSettlementKind !== "ONE_TIME_PAID" || !paymentRef)
  && (mode !== "create" || futureProviderCurrency === "RUB")
  && (mode !== "create" || (
    Number.isSafeInteger(futureProviderCostMinor)
    && futureProviderCostMinor >= 0
    && Number.isSafeInteger(futureRequestAmount)
    && futureRequestAmount >= 0
    && Number.isSafeInteger(futureRequestAmount * 100)
    && futureRequestAmount * 100 === futureProviderCostMinor
    && futureProviderCost === futureRequestAmount
  ))
  && (!organizerNorm.id || toStr(futureGameAuth.actorClientId) === organizerNorm.id)
  && (!organizerNorm.phoneNorm || toStr(futureGameAuth.actorPhoneNorm) === organizerNorm.phoneNorm)
);
if (mode !== "confirm" && !futureBookingEvidenceVerified) {
  const errMsg = Object.assign({}, msg, {
    statusCode: futureGameAuth?.verified === true ? 409 : 401,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Игра должна быть связана с вашей подтверждённой бронью Viva",
      code: "GAME_BOOKING_EVIDENCE_REQUIRED",
      retryable: true,
    },
  });
  return [null, errMsg, errMsg, null];
}
if (mode === "create") resolvedPaid = true;
const paymentVerification = isObj(msg._gamePaymentVerified) ? msg._gamePaymentVerified : null;`,
    "future game authenticated booking evidence",
  );
  next = replaceOnce(
    next,
    `const incomingStatus = toStr(body.status);
const resolvedStatus =
  mode === "draft"
    ? "PAYMENT_PENDING"
    : incomingStatus
      || (resolvedPaid ? "PAID" : "PAYMENT_PENDING");`,
    `const resolvedStatus = mode === "draft" ? "PAYMENT_PENDING" : "PAID";`,
    "server-canonical future status",
  );
  const archivedMarker = `  archived: Boolean(body.archived),`;
  if (next.split(archivedMarker).length !== 3) {
    fail("Expected two exact server-canonical future archive state preimages");
  }
  next = next.split(archivedMarker).join(`  archived: false,`);
  next = replaceOnce(
    next,
    `  mode === "create"
  && resolvedPaid === true
  && paymentVerification?.verified !== true`,
    `  mode === "create"
  && resolvedPaid === true
  && futureBookingEvidenceVerified !== true
  && paymentVerification?.verified !== true`,
    "authenticated zero-due create evidence",
  );
  next = replaceOnce(
    next,
    `const queryFilter = mode === "confirm"
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
  : paymentRefFilter;`,
    `const queryFilter = {
  _id: persistentId,
  tenantKey,
  id: gameId,
  ...(mode === "confirm" ? {
    archived: { $ne: true },
    status: "PAYMENT_PENDING",
    revision: expectedRevision,
  } : {}),
  ...paymentRefFilter,
};`,
    "tenant revision query",
  );
  next = replaceOnce(
    next,
    `    $setOnInsert: {
      createdAt: nowIso,
    },`,
    `    $setOnInsert: {
      _id: persistentId,
      createdAt: nowIso,
    },`,
    "deterministic insert identity",
  );
  next = replaceOnce(
    next,
    `    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },`,
    `    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
    $inc: { revision: 1 },`,
    "future game revision",
  );
  next = replaceOnce(
    next,
    `      tenantKey: toStr(body.tenantKey),`,
    `      tenantKey,`,
    "confirmed game tenant context",
  );
  next = replaceOnce(
    next,
    `return [
  dbMsg,
  mode === "confirm" ? null : responseMsg,
  debugMsg,
  mode === "confirm" ? null : autojoinMsg,
];`,
    `dbMsg._futureGameWrite = {
  step: "identity_lookup",
  persistentId,
  tenantKey,
  gameId,
  mode,
  dedupeKey,
  paymentRef: paymentRef || null,
  expectedRevision,
  httpStatus: dbMsg._httpStatus || 200,
  update: dbMsg.payload,
};
const identityAlternatives = [
  { _id: persistentId },
  { tenantKey, id: gameId },
  { dedupeKey },
];
if (paymentRef) {
  identityAlternatives.push(
    { "metadata.paymentRef": paymentRef },
    { "payment.paymentRef": paymentRef },
  );
}
dbMsg.payload = { $or: identityAlternatives };
dbMsg.limit = 3;
dbMsg.sort = { updatedAt: -1, _id: -1 };
delete dbMsg.query;
return [dbMsg, null, null, null];`,
    "deferred future game persistence",
  );
  return next;
}

export function patchPaymentRouter(source) {
  let next = replaceOnce(
    source,
    `    toStr(claim.gameId) === toStr(ctx.record?.id)
    && toStr(claim.paymentRef) === ctx.paymentRef`,
    `    toStr(claim.tenantKey) === toStr(ctx.tenantKey)
    && toStr(claim.gameId) === toStr(ctx.record?.id)
    && toStr(claim.paymentRef) === ctx.paymentRef`,
    "tenant-bound payment claim readback",
  );
  next = replaceOnce(
    next,
    `  if (!tenantKey || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !expectedUpdatedAt) {`,
    `  if (tenantKey !== toStr(ctx.tenantKey) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !expectedUpdatedAt) {`,
    "tenant-bound payment draft",
  );
  next = replaceOnce(
    next,
    `if (ctx.step === "claim_write") {
  ctx.step = "claim_read";`,
    `if (ctx.step === "claim_write") {
  const claimAck = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
  if (msg.error || claimAck.acknowledged !== true) {
    return fail(ctx, 503, "GAME_PAYMENT_CLAIM_WRITE_FAILED", "Не удалось надёжно закрепить транзакцию за игрой");
  }
  ctx.step = "claim_read";`,
    "payment claim write acknowledgement",
  );
  next = replaceOnce(
    next,
    `    $setOnInsert: {
      transactionId: ctx.transactionId,`,
    `    $setOnInsert: {
      tenantKey: ctx.tenantKey,
      transactionId: ctx.transactionId,`,
    "tenant-bound payment claim write",
  );
  next = replaceOnce(
    next,
    `  { upsert: true },
];`,
    `  { upsert: true, writeConcern: { w: "majority", j: true }, maxTimeMS: 5000 },
];`,
    "durable payment claim write",
  );
  return next;
}

function functionNode(id, name, func, outputs, wires, x, y) {
  return {
    id,
    type: "function",
    z: FUTURE_VISIBILITY_CONTRACT.tabId,
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
  };
}

function mongoFindNode(id, name, wires, x, y) {
  return {
    id,
    type: "mongodb4",
    z: FUTURE_VISIBILITY_CONTRACT.tabId,
    clientNode: "4e820638cc39c730",
    mode: "collection",
    collection: "lk_games",
    operation: "find",
    output: "toArray",
    maxTimeMS: "5000",
    handleDocId: false,
    name,
    x,
    y,
    wires,
  };
}

function httpRequestNode(id, name, wires, x, y) {
  return {
    id,
    type: "http request",
    z: FUTURE_VISIBILITY_CONTRACT.tabId,
    name,
    method: "use",
    ret: "obj",
    paytoqs: "ignore",
    url: "",
    tls: "",
    persist: false,
    proxy: "",
    insecureHTTPParser: false,
    authType: "",
    senderr: true,
    headers: [],
    x,
    y,
    wires,
  };
}

function installFutureWriteGraph(flow, finalCreateSource, { recovery = false } = {}) {
  const ids = FUTURE_VISIBILITY_NODE_IDS;
  for (const id of Object.values(ids)) if (flow.some((node) => node.id === id)) fail(`Future node already exists: ${id}`);
  const create = exactNode(flow, FUTURE_VISIBILITY_CONTRACT.createNodeId, "function");
  const upsertArgs = exactNode(flow, FUTURE_VISIBILITY_CONTRACT.upsertArgsNodeId, "function");
  const mongoWrite = exactNode(flow, FUTURE_VISIBILITY_CONTRACT.mongoWriteNodeId, "mongodb4");
  if (create.outputs !== 4 || !isDeepStrictEqual(create.wires, [
    [FUTURE_VISIBILITY_CONTRACT.upsertArgsNodeId],
    [FUTURE_VISIBILITY_CONTRACT.responseNodeId],
    [FUTURE_VISIBILITY_CONTRACT.debugNodeId],
    [FUTURE_VISIBILITY_CONTRACT.autojoinNodeId],
  ])) fail("Create topology drift");
  if (!isDeepStrictEqual(upsertArgs.wires, [[FUTURE_VISIBILITY_CONTRACT.mongoWriteNodeId]])) {
    fail("Game upsert adapter topology drift");
  }
  create.func = recovery
    ? replaceOnce(
        finalCreateSource,
        `// GAME_PAYMENT_CONFIRM_GUARD_START
`,
        `// GAME_PAYMENT_CONFIRM_GUARD_START
if (mode === "confirm") {
  const errMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Payment confirmation is temporarily disabled", code: "GAME_PAYMENT_CONFIRMATION_DISABLED", retryable: true },
  });
  return [null, errMsg, errMsg, null];
}
`,
        "recovery payment stop",
      )
    : finalCreateSource;
  create.wires[0] = [ids.identityFind];
  upsertArgs.func = readFn("fn_future_game_upsert_args.js");
  if (!recovery && !isDeepStrictEqual(mongoWrite.wires, [[PAYMENT_NODE_IDS.confirmWriteAck]])) {
    fail("Payment confirmation ACK topology drift");
  }
  if (recovery && !isDeepStrictEqual(mongoWrite.wires, [[]])) fail("Recovery Mongo write topology drift");
  const ordinaryRouteUrls = new Set(["/lk/games", "/lk/games/records", "/lk/games/drafts", "/lk/games/draft"]);
  const ordinaryRoutes = flow.filter((node) => (
    node.type === "http in" && node.method === "post" && ordinaryRouteUrls.has(node.url)
  ));
  if (ordinaryRoutes.length !== 4 || ordinaryRoutes.some((node) => (
    !isDeepStrictEqual(node.wires, [[FUTURE_VISIBILITY_CONTRACT.createNodeId]])
  ))) fail("Ordinary future game route topology drift");
  ordinaryRoutes.forEach((node) => { node.wires = [[ids.authPrepare]]; });
  mongoWrite.wires = [[ids.writeAck]];

  flow.push(
    functionNode(
      ids.authPrepare,
      "Prepare future game Viva authorization",
      readFn("fn_future_game_auth_prepare.js"),
      3,
      [[ids.authRequest], [FUTURE_VISIBILITY_CONTRACT.responseNodeId], [FUTURE_VISIBILITY_CONTRACT.debugNodeId]],
      430,
      2580,
    ),
    httpRequestNode(ids.authRequest, "Verify future game in Viva", [[ids.authResolve]], 700, 2580),
    functionNode(
      ids.authResolve,
      "Resolve future game Viva authorization",
      readFn("fn_future_game_auth_resolve.js"),
      4,
      [[ids.authRequest], [FUTURE_VISIBILITY_CONTRACT.createNodeId], [FUTURE_VISIBILITY_CONTRACT.responseNodeId], [FUTURE_VISIBILITY_CONTRACT.debugNodeId]],
      960,
      2580,
    ),
    {
      id: ids.authCatch,
      type: "catch",
      z: FUTURE_VISIBILITY_CONTRACT.tabId,
      name: "Catch future game Viva authorization errors",
      scope: [ids.authRequest],
      uncaught: false,
      x: 700,
      y: 2640,
      wires: [[ids.authResolve]],
    },
    mongoFindNode(ids.identityFind, "Find future game identity", [[ids.identityResolve]], 660, 2700),
    functionNode(
      ids.identityResolve,
      "Resolve future game identity revision",
      readFn("fn_future_game_identity_resolve.js"),
      4,
      [
        [FUTURE_VISIBILITY_CONTRACT.upsertArgsNodeId],
        [FUTURE_VISIBILITY_CONTRACT.responseNodeId],
        [FUTURE_VISIBILITY_CONTRACT.debugNodeId],
        recovery ? [] : [PAYMENT_NODE_IDS.confirmWriteReadback],
      ],
      930,
      2700,
    ),
    {
      id: ids.identityCatch,
      type: "catch",
      z: FUTURE_VISIBILITY_CONTRACT.tabId,
      name: "Catch future game identity read errors",
      scope: [ids.identityFind],
      uncaught: false,
      x: 930,
      y: 2760,
      wires: [[ids.identityResolve]],
    },
    functionNode(
      ids.writeAck,
      "Acknowledge future game persistence",
      readFn("fn_future_game_write_ack.js"),
      5,
      [
        [ids.writeReadback],
        [FUTURE_VISIBILITY_CONTRACT.responseNodeId],
        [FUTURE_VISIBILITY_CONTRACT.debugNodeId],
        [FUTURE_VISIBILITY_CONTRACT.autojoinNodeId],
        recovery ? [] : [PAYMENT_NODE_IDS.confirmWriteAck],
      ],
      1510,
      2700,
    ),
    mongoFindNode(ids.writeReadback, "Read back future game persistence", [[ids.writeAck]], 1810, 2700),
    {
      id: ids.writeCatch,
      type: "catch",
      z: FUTURE_VISIBILITY_CONTRACT.tabId,
      name: "Catch future game persistence errors",
      scope: [FUTURE_VISIBILITY_CONTRACT.mongoWriteNodeId, ids.writeReadback],
      uncaught: false,
      x: 1510,
      y: 2760,
      wires: [[ids.writeAck]],
    },
  );
}

function buildRecoveryFlow(candidate, sourceFlow, finalCreateSource) {
  const recovery = structuredClone(candidate);
  const sourceById = new Map(sourceFlow.map((node) => [node.id, node]));
  const recoveryById = new Map(recovery.map((node) => [node.id, node]));
  recoveryById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func = replaceOnce(
    finalCreateSource,
    `// GAME_PAYMENT_CONFIRM_GUARD_START
`,
    `// GAME_PAYMENT_CONFIRM_GUARD_START
if (mode === "confirm") {
  const errMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Payment confirmation is temporarily disabled", code: "GAME_PAYMENT_CONFIRMATION_DISABLED", retryable: true },
  });
  return [null, errMsg, errMsg, null];
}
`,
    "recovery payment stop",
  );
  recoveryById.get(FUTURE_VISIBILITY_NODE_IDS.writeAck).wires[4] = [];
  for (const route of BASE_PAYMENT_CONTRACT.routes) {
    recoveryById.get(route.id).wires = structuredClone(sourceById.get(route.id).wires);
  }
  for (const target of BASE_PAYMENT_CONTRACT.sourceTargets) {
    if (target.id === FUTURE_VISIBILITY_CONTRACT.upsertArgsNodeId) continue;
    const index = recovery.findIndex((node) => node.id === target.id);
    recovery[index] = structuredClone(sourceById.get(target.id));
  }
  const cleanupWriteId = BASE_PAYMENT_CONTRACT.mongoWriteNodes[1].id;
  recoveryById.set(cleanupWriteId, recovery.find((node) => node.id === cleanupWriteId));
  recoveryById.get(cleanupWriteId).wires = structuredClone(sourceById.get(cleanupWriteId).wires);
  return recovery;
}

export function buildFutureVisibilityCandidate(sourceFlow, sourceSha256, options = {}) {
  const contract = FUTURE_VISIBILITY_CONTRACT;
  const notBefore = normalizeNotBefore(options.notBefore);
  if (sourceSha256 !== contract.sourceFlowSha256) fail("Whole-flow source SHA mismatch");
  if (!Array.isArray(sourceFlow) || sourceFlow.length !== contract.sourceNodeCount) fail("Source node count mismatch");
  if (routes(sourceFlow).length !== contract.httpRouteCount) fail("Source HTTP route count mismatch");
  if (new Set(sourceFlow.map((node) => node.id)).size !== sourceFlow.length) fail("Source contains duplicate node IDs");
  const sourceRoutes = routes(sourceFlow);

  const payment = buildPaymentCandidate(structuredClone(sourceFlow), sourceSha256, {
    contract: paymentSourceContract(),
  });
  const paymentBytes = Buffer.from(`${JSON.stringify(payment.candidate, null, 2)}\n`);
  if (sha256(paymentBytes) !== contract.paymentCandidateSha256) fail("Payment candidate SHA mismatch");

  const candidate = payment.candidate;
  removeUnrelatedCleanupPaymentChanges(candidate, sourceFlow);
  const paymentCreate = exactNode(candidate, contract.createNodeId, "function");
  const finalCreateSource = patchFutureCreateFunction(String(paymentCreate.func || ""), { notBefore });
  exactNode(candidate, PAYMENT_NODE_IDS.lookup, "function").func = readFn("fn_future_game_payment_confirm_lookup.js");
  const paymentRouter = exactNode(candidate, PAYMENT_NODE_IDS.router, "function");
  paymentRouter.func = patchPaymentRouter(String(paymentRouter.func || ""));
  exactNode(candidate, PAYMENT_NODE_IDS.confirmWriteAck, "function").func = readFn(
    "fn_future_game_confirm_write_ack.js",
  );
  installFutureWriteGraph(candidate, finalCreateSource);
  const sourceIds = new Set(sourceFlow.map((node) => node.id));
  const futureIds = new Set(Object.values(FUTURE_VISIBILITY_NODE_IDS));
  const reorderedCandidate = [
    ...candidate.filter((node) => sourceIds.has(node.id)),
    ...candidate.filter((node) => futureIds.has(node.id)),
    ...candidate.filter((node) => !sourceIds.has(node.id) && !futureIds.has(node.id)),
  ];
  candidate.splice(0, candidate.length, ...reorderedCandidate);

  const foundation = structuredClone(sourceFlow);
  installFutureWriteGraph(foundation, finalCreateSource, { recovery: true });
  const recovery = buildRecoveryFlow(candidate, sourceFlow, finalCreateSource);

  for (const [label, flow] of [["foundation", foundation], ["candidate", candidate], ["recovery", recovery]]) {
    if (routes(flow).length !== sourceRoutes.length) fail(`${label} HTTP route count changed`);
    const broken = brokenReferences(flow);
    if (broken.brokenWires || broken.brokenLinks) fail(`${label} contains broken references`);
  }
  const ordinaryRouteUrls = new Set(["/lk/games", "/lk/games/records", "/lk/games/drafts", "/lk/games/draft"]);
  const ordinaryRouteIds = new Set(sourceRoutes.filter((route) => (
    route.method === "post" && ordinaryRouteUrls.has(route.url)
  )).map((route) => route.id));
  if (ordinaryRouteIds.size !== 4) fail("Ordinary future game source route contract changed");
  const paymentRouteIds = new Set(BASE_PAYMENT_CONTRACT.routes.map((route) => route.id));
  for (const [label, flow, extraAllowedIds] of [
    ["foundation", foundation, new Set()],
    ["candidate", candidate, paymentRouteIds],
    ["recovery", recovery, new Set()],
  ]) {
    const flowRoutes = routes(flow);
    for (const sourceRoute of sourceRoutes) {
      const nextRoute = flowRoutes.find((route) => route.id === sourceRoute.id);
      const ordinary = ordinaryRouteIds.has(sourceRoute.id);
      const allowed = ordinary || extraAllowedIds.has(sourceRoute.id);
      if (!allowed && !isDeepStrictEqual(nextRoute, sourceRoute)) {
        fail(`Unrelated ${label} route changed: ${sourceRoute.id}`);
      }
      if (allowed && !isDeepStrictEqual(withoutWires(nextRoute), withoutWires(sourceRoute))) {
        fail(`${label} route identity changed: ${sourceRoute.id}`);
      }
      if (ordinary && !isDeepStrictEqual(nextRoute.wires, [[FUTURE_VISIBILITY_NODE_IDS.authPrepare]])) {
        fail(`${label} ordinary game route authorization wire mismatch: ${sourceRoute.id}`);
      }
    }
  }

  return {
    foundation,
    candidate,
    recovery,
    report: {
      ok: true,
      sourceSha256,
      sourceNodeCount: sourceFlow.length,
      foundationNodeCount: foundation.length,
      candidateNodeCount: candidate.length,
      recoveryNodeCount: recovery.length,
      notBefore,
      httpRouteCount: sourceRoutes.length,
      addedFutureNodeIds: Object.values(FUTURE_VISIBILITY_NODE_IDS),
      paymentAddedNodeIds: PAYMENT_CONFIRMATION_NODE_IDS,
      candidateBrokenReferences: brokenReferences(candidate),
      recoveryBrokenReferences: brokenReferences(recovery),
      recoveryPolicy: {
        beforeFirstOrganicWrite: "exact-source rollback allowed",
        afterFirstOrganicWrite: "roll back candidate to foundation-compatible recovery; keep tenant/revision writer and disable payment confirmation",
      },
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--input", "--foundation", "--candidate", "--recovery", "--report", "--not-before"]).has(key) || !value) {
      fail(`Invalid argument: ${key ?? ""}`);
    }
    values[key] = value;
  }
  if (!values["--input"] || !values["--foundation"] || !values["--candidate"]
    || !values["--recovery"] || !values["--report"] || !values["--not-before"]) {
    fail("Usage: node scripts/patch_live_game_future_visibility.mjs --input FLOW --foundation FOUNDATION --candidate CANDIDATE --recovery RECOVERY --report REPORT --not-before UTC");
  }
  return values;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args["--input"]);
  const foundationPath = path.resolve(args["--foundation"]);
  const candidatePath = path.resolve(args["--candidate"]);
  const recoveryPath = path.resolve(args["--recovery"]);
  const reportPath = path.resolve(args["--report"]);
  if (new Set([inputPath, foundationPath, candidatePath, recoveryPath, reportPath]).size !== 5) fail("All paths must be distinct");
  for (const outputPath of [foundationPath, candidatePath, recoveryPath, reportPath]) {
    if (fs.existsSync(outputPath)) fail(`Output already exists: ${outputPath}`);
  }
  const notBefore = normalizeNotBefore(args["--not-before"]);
  const minimumNotBeforeMs = Date.now() + 30 * 60 * 1000;
  if (Date.parse(notBefore) < minimumNotBeforeMs) {
    fail("Future write not-before must be at least 30 minutes after artifact generation");
  }
  const sourceBytes = fs.readFileSync(inputPath);
  const result = buildFutureVisibilityCandidate(JSON.parse(sourceBytes.toString("utf8")), sha256(sourceBytes), { notBefore });
  const foundationBytes = Buffer.from(`${JSON.stringify(result.foundation, null, 2)}\n`);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const recoveryBytes = Buffer.from(`${JSON.stringify(result.recovery, null, 2)}\n`);
  const report = {
    ...result.report,
    foundationSha256: sha256(foundationBytes),
    candidateSha256: sha256(candidateBytes),
    recoverySha256: sha256(recoveryBytes),
  };
  fs.writeFileSync(foundationPath, foundationBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(candidatePath, candidateBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(recoveryPath, recoveryBytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
