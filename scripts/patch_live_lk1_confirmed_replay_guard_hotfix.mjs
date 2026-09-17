#!/usr/bin/env node

// Focused Node-RED generation: a confirmed subscription claim is replayed with its stored
// money evidence only after the provider proves it still holds the booking.
//
// The live incident (2026-09-16, client 24dda8e0…, game pay_66a6b649…): the split
// participant payment-timeout cleanup cancelled the Viva booking and expired the split
// payment, but the daily claim stayed `CONFIRMED` with a dead `bookingId`. Every repeat of
// the same deterministic join operation (`lk-split-join-<hash>` is derived from client,
// game, phone and subscription, so the widget cannot invent a new one) replayed that claim:
// the gateway returned the stored `CONFIRMED` decision and the widget rendered
// "Временная техническая ошибка. Не удалось подтвердить условия подписки …".
//
// Two nodes, one field each:
//   * `lk_subscription_booking_router_20260804.func` — an ingress replay of a `CONFIRMED`
//     claim now re-reads the exercise bookings before it replays the decision. A live bound
//     row keeps the ordinary replay; a cancelled row, or a complete page that neither lists
//     the bound row nor holds a live booking of this actor and subscription, releases the
//     claim with a compare-and-swap and answers 409 so the player starts a new attempt.
//     Unverified provider evidence keeps the claim and stays pending, as before.
//   * `lk_subscription_booking_finalize_20260804.func` — the ingress replay response now
//     carries the money evidence the widget validates (`toPayMinor`/`toPay`, `transactionId`,
//     `paymentUrl`, `settlementState`, `selectedPaymentMode`) plus the intent identity
//     (`mode`, `paymentRef`, `gameId`). Without them a paid replay is rejected as an unknown
//     state, so a player could not resume the stored checkout even while the booking is live.
//
// Nothing is deployed, imported or restarted here. The patcher fails closed unless the
// supplied preimage is exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const CONFIRMED_REPLAY_DEPLOYMENT_ID = "lk1-confirmed-replay-guard";
export const CONFIRMED_REPLAY_KIND = "FOCUSED_LK1_CONFIRMED_REPLAY_GUARD_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-17 (4804 nodes,
// sha256 90fb9821…). A live change must never be absorbed silently: it requires a
// conscious re-review of every pin below.
export const CONFIRMED_REPLAY_SOURCE_SHA256 =
  "90fb9821b3a7299433e7b5c3923cd1e1e29c5b8f5224efe6e803584ae4461951";
export const CONFIRMED_REPLAY_SOURCE_NODE_COUNT = 4804;

export const CONFIRMED_REPLAY_GATEWAY_ID = "lk_subscription_booking_router_20260804";
export const CONFIRMED_REPLAY_FINALIZE_ID = "lk_subscription_booking_finalize_20260804";

export const CONFIRMED_REPLAY_TARGETS = Object.freeze({
  gateway: Object.freeze({
    id: CONFIRMED_REPLAY_GATEWAY_ID,
    liveFuncSha256: "2c8bfbe7d1a5873dc85331bf42402c45c0a08de4227630a3450e8a3d770332cd",
    patchedFuncSha256: "3920bb21323fd5023cd427b5e8a183f6a70909dafa88a6e39bfe02caf9076fe0",
  }),
  finalize: Object.freeze({
    id: CONFIRMED_REPLAY_FINALIZE_ID,
    liveFuncSha256: "72f575fc4eb01f2e3ff0b7e057adff2e6a523030ac5cf7ab3776c1d13cd01415",
    patchedFuncSha256: "2b11541259acf223cbfa2fe8cc81ad268dc26213e4b171d1bd6726fa9515dc3d",
  }),
});

const CONFIRMED_REPLAY_INSERT = `    ctx.lk1 = JSON.parse(JSON.stringify(quote));
    ctx.exerciseId = operation.exerciseId;
    ctx.confirmedBookingId = operation.bookingId;
    // Split join/create only: the payment-timeout cleanup that orphans a confirmed
    // booking is split-specific and the group/tournament replay contract is pinned
    // separately. A split replay re-reads the provider before it replays the stored
    // checkout, because a replay must not send the player to pay for a booking the
    // provider no longer holds.
    if (ctx.caller !== "split") return lk1Finish(ctx);
    ctx.lk1ConfirmedReplay = {
      operationKey: operation._id,
      operationId: operation.operationId,
      bookingId: operation.bookingId,
      fingerprint: quote.fingerprint,
      updatedAt: operation.updatedAt ?? null,
    };
    return prepareAdminGet(ctx, LK1_CONFIRMED_BOOKING_RECHECK,
      \`/api/v1/exercises/\${encodeURIComponent(operation.exerciseId)}/bookings?showCancelled=true&size=200\`);
  }
}

const releaseConfirmedOrphan = (ctx, bound) => {
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, LK1_CONFIRMED_ORPHAN_RELEASE, {
    _id: bound.operationKey,
    operationId: bound.operationId,
    state: "CONFIRMED",
    bookingId: bound.bookingId,
    "lk1.fingerprint": bound.fingerprint,
    updatedAt: bound.updatedAt,
  }, {
    $set: {
      state: "RELEASED",
      releasedAt: nowIso,
      updatedAt: nowIso,
      releaseReason: "CONFIRMED_BOOKING_GONE",
      reconciliation: {
        source: "hub_confirmed_replay_provider_readback",
        decision: "SAFE_TO_RELEASE",
        reconciledAt: nowIso,
        observedBookingId: bound.bookingId,
        observedUpdatedAt: bound.updatedAt,
      },
    },
  });
};

if (ctx.step === LK1_CONFIRMED_BOOKING_RECHECK) {
  // Portable helpers: this body is composed both with and without the booking-readback
  // layer, so the recheck must not depend on helpers a partial composition omits.
  const recheckKey = (value) => (value === null || value === undefined
    ? null : String(value).trim().toLowerCase() || null);
  const recheckRowBookingId = (row) => (isObj(row) ? row.id || row.bookingId || row.uuid || null : null);
  const recheckRowClientId = (row) => (isObj(row)
    ? row.clientId || (isObj(row.client) ? row.client.id : null) || row.playerId || row.userId || null
    : null);
  const recheckRowSubscriptionId = (row) => {
    if (!isObj(row)) return null;
    const nested = isObj(row.subscription) ? row.subscription
      : isObj(row.clientSubscription) ? row.clientSubscription : {};
    return row.clientSubscriptionId || row.subscriptionId || row.clientSubId
      || nested.clientSubscriptionId || nested.subscriptionId || nested.id || nested.uuid || null;
  };
  const recheckRowCancelled = (row) => {
    if (!isObj(row)) return false;
    if (row.isCancelled === true || row.cancelled === true || row.canceled === true) return true;
    if ([row.isCancelled, row.cancelled, row.canceled].some((flag) => flag === false)) return false;
    if (row.cancelledAt || row.cancellationDate) return true;
    return /cancel/i.test(String(row.bookingStatus || row.status || row.state || ""));
  };
  const bound = isObj(ctx.lk1ConfirmedReplay) ? ctx.lk1ConfirmedReplay : null;
  if (!bound || !bound.operationKey || !bound.operationId || !bound.bookingId || !bound.fingerprint) {
    return lk1Stop(ctx, "LK1_CONFIRMED_RECHECK_CONTEXT_INVALID");
  }
  // "Cannot verify" always means "keep the claim and answer pending": only a complete
  // provider page may release the seat.
  if (!isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) {
    return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_EVIDENCE_UNAVAILABLE");
  }
  const rows = extractItems(msg.payload).filter((row) => isObj(row));
  const actor = recheckKey(ctx.actorClientId);
  const subscription = recheckKey(ctx.clientSubscriptionId);
  const boundId = recheckKey(bound.bookingId);
  const matches = rows.filter((row) => recheckKey(recheckRowBookingId(row)) === boundId);
  if (matches.length > 1) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_AMBIGUOUS");
  if (matches.length === 1) {
    // The provider still lists the row: a live one is the ordinary replay, a cancelled
    // one is the orphaned claim this guard has to return.
    if (!recheckRowCancelled(matches[0])) {
      delete ctx.lk1ConfirmedReplay;
      return lk1Finish(ctx);
    }
    return releaseConfirmedOrphan(ctx, bound);
  }
  for (const row of rows) {
    if (recheckRowCancelled(row)) continue;
    if (recheckKey(recheckRowClientId(row)) !== actor) continue;
    const sub = recheckKey(recheckRowSubscriptionId(row));
    if (!sub) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_SUBSCRIPTION_UNRESOLVED");
    if (sub === subscription) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_STILL_ACTIVE");
  }
  // The complete page neither lists the bound booking nor holds a live booking of this
  // actor and subscription: the provider deleted it (exactly what the payment-timeout
  // cleanup does). The claim still holds the seat, so it is the one to return.
  return releaseConfirmedOrphan(ctx, bound);
}

if (ctx.step === LK1_CONFIRMED_ORPHAN_RELEASE) {
  const bound = isObj(ctx.lk1ConfirmedReplay) ? ctx.lk1ConfirmedReplay : {};
  const ackResults = isObj(msg.payload) ? [msg.payload, msg.payload.result] : [];
  let matched = 0;
  for (const result of ackResults) {
    if (!isObj(result)) continue;
    for (const value of [result.matchedCount, result.modifiedCount, result.upsertedCount,
      result.n, result.nModified]) {
      if (Number.isFinite(Number(value))) { matched = Number(value); break; }
    }
    if (matched > 0) break;
  }
  if (msg.error || matched < 1) {
    return lk1Stop(ctx, "LK1_CONFIRMED_ORPHAN_RELEASE_CONFLICT");
  }
  delete ctx.lk1ConfirmedReplay;
  const released = {
    code: "SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED",
    operationId: bound.operationId || null,
    releasedBookingId: bound.bookingId || null,
  };
  // \`finishError\` belongs to the booking router this body is embedded into; a partial
  // harness that only carries \`finishPending\` still gets the same pending contract.
  return typeof finishError === "function"
    ? finishError(ctx, 409, "Подтверждённая ранее запись отменена, место освобождено — присоединитесь заново", released)
    : finishPending(ctx, "Подтверждённая ранее запись отменена, место освобождено — присоединитесь заново", released);
}`;

export const CONFIRMED_REPLAY_GATEWAY_DELTAS = Object.freeze([
  { id: "confirmed-replay-step-constants",
    before: `const LK1_EXPIRED_PENDING_RECONCILE = "lk1_ingress_expired_pending";
const LK1_EXPIRED_PENDING_RELEASE = "lk1_expired_pending_release";`,
    after: `const LK1_EXPIRED_PENDING_RECONCILE = "lk1_ingress_expired_pending";
const LK1_EXPIRED_PENDING_RELEASE = "lk1_expired_pending_release";
// An ingress replay of a confirmed claim re-reads the provider before it replays the
// stored checkout: the split payment-timeout cleanup cancels the booking without
// releasing the claim, and a replay must not send the player to pay for a booking the
// provider no longer holds.
const LK1_CONFIRMED_BOOKING_RECHECK = "lk1_ingress_confirmed_booking_recheck";
const LK1_CONFIRMED_ORPHAN_RELEASE = "lk1_confirmed_orphan_release";` },
  { id: "confirmed-replay-provider-verification",
    before: `    ctx.lk1 = JSON.parse(JSON.stringify(quote));
    ctx.exerciseId = operation.exerciseId;
    ctx.confirmedBookingId = operation.bookingId;
    return lk1Finish(ctx);
  }
}`,
    after: CONFIRMED_REPLAY_INSERT },
]);

export const CONFIRMED_REPLAY_FINALIZE_DELTAS = Object.freeze([
  { id: "confirmed-replay-money-evidence",
    before: `  if (responseStatus === 200 && payload.state === "CONFIRMED" && ctx.lk1) {
    msg.payload = { ...payload,
      settlementState: payload.toPayMinor > 0 ? "PAYMENT_REQUIRED" : "CONFIRMED",
      selectedPaymentMode: payload.toPayMinor > 0 ? "one_time" : "subscription" };
  }`,
    after: `  if (responseStatus === 200 && payload.state === "CONFIRMED" && ctx.lk1) {
    const split = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
    const checkout = ctx.lk1 && typeof ctx.lk1 === "object"
      && ctx.lk1.checkout && typeof ctx.lk1.checkout === "object" ? ctx.lk1.checkout : null;
    // The widget accepts a confirmed replay only with consistent money evidence that
    // names the same intent. Without \`mode\`/\`paymentRef\`/\`gameId\` a paid replay is
    // rejected as an unknown state, so the player cannot resume the stored checkout.
    const toPayMinor = Number.isSafeInteger(payload.toPayMinor) ? payload.toPayMinor
      : Number.isSafeInteger(checkout?.toPayMinor) ? checkout.toPayMinor : 0;
    const action = split.action === "create" || split.action === "join" ? split.action
      : ctx.managedAction === "CREATE_GAME" ? "create"
        : ctx.managedAction === "JOIN_GAME" ? "join" : null;
    msg.payload = { ...payload,
      toPayMinor,
      toPay: toPayMinor / 100,
      transactionId: payload.transactionId || checkout?.transactionId || null,
      paymentUrl: payload.paymentUrl || checkout?.paymentUrl || null,
      settlementState: toPayMinor > 0 ? "PAYMENT_REQUIRED" : "CONFIRMED",
      selectedPaymentMode: toPayMinor > 0 ? "one_time" : "subscription",
      mode: action,
      paymentRef: split.paymentRef || payload.paymentRef || null,
      gameId: split.gameId || payload.gameId || null,
      exerciseId: payload.exerciseId || ctx.exerciseId || null };
  }` },
]);

export const GATEWAY_MARKERS = Object.freeze([
  "const LK1_CONFIRMED_BOOKING_RECHECK = ",
  "const LK1_CONFIRMED_ORPHAN_RELEASE = ",
  'if (ctx.caller !== "split") return lk1Finish(ctx);',
  "ctx.lk1ConfirmedReplay = {",
  "const releaseConfirmedOrphan = (ctx, bound) => {",
  "const recheckRowCancelled = (row) => {",
  'return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_EVIDENCE_UNAVAILABLE");',
  'return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_STILL_ACTIVE");',
  'code: "SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED",',
  'typeof finishError === "function"',
]);

export const GATEWAY_ABSENT_MARKERS = Object.freeze([
  `    ctx.confirmedBookingId = operation.bookingId;
    return lk1Finish(ctx);`,
]);

export const FINALIZE_MARKERS = Object.freeze([
  "const checkout = ctx.lk1 && typeof ctx.lk1 === \"object\"",
  "const action = split.action === \"create\" || split.action === \"join\" ? split.action",
  "paymentRef: split.paymentRef || payload.paymentRef || null,",
  "gameId: split.gameId || payload.gameId || null,",
]);

export const FINALIZE_ABSENT_MARKERS = Object.freeze([
  `      selectedPaymentMode: payload.toPayMinor > 0 ? "one_time" : "subscription" };`,
]);

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function applyDeltas(source, deltas, label) {
  let patched = source;
  for (const delta of deltas) {
    if ((patched.split(delta.before).length - 1) !== 1) {
      throw new Error(`${label} delta ${delta.id} does not match exactly one preimage region`);
    }
    patched = patched.replace(delta.before, () => delta.after);
  }
  return patched;
}

function assertMarkers(body, present, absent, label) {
  for (const marker of present) {
    if ((body.split(marker).length - 1) !== 1) {
      throw new Error(`${label} is missing the reviewed marker exactly once: ${marker}`);
    }
  }
  for (const marker of absent) {
    if (body.includes(marker)) throw new Error(`${label} still carries the superseded region: ${marker}`);
  }
  try {
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

export function patchConfirmedReplayGatewayBody(source, target = CONFIRMED_REPLAY_TARGETS.gateway) {
  const patched = applyDeltas(source, CONFIRMED_REPLAY_GATEWAY_DELTAS, "booking gateway");
  assertMarkers(patched, GATEWAY_MARKERS, GATEWAY_ABSENT_MARKERS, "Patched booking gateway");
  const digest = sha256(patched);
  if (target.patchedFuncSha256 && digest !== target.patchedFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function patchConfirmedReplayFinalizeBody(source, target = CONFIRMED_REPLAY_TARGETS.finalize) {
  const patched = applyDeltas(source, CONFIRMED_REPLAY_FINALIZE_DELTAS, "subscription finalizer");
  assertMarkers(patched, FINALIZE_MARKERS, FINALIZE_ABSENT_MARKERS, "Patched subscription finalizer");
  const digest = sha256(patched);
  if (target.patchedFuncSha256 && digest !== target.patchedFuncSha256) {
    throw new Error(`Subscription finalizer postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

function assertFunctionNode(node, id) {
  if (!node) throw new Error(`Node contract mismatch: ${id} is absent`);
  if (node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1
    || node.wires?.length !== node.outputs || typeof node.func !== "string"
    || typeof node.initialize !== "string") {
    throw new Error(`Node contract mismatch: ${id}`);
  }
  return node;
}

export function composeConfirmedReplayArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? CONFIRMED_REPLAY_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== CONFIRMED_REPLAY_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${CONFIRMED_REPLAY_SOURCE_NODE_COUNT}`);
  }
  const targets = CONFIRMED_REPLAY_TARGETS;
  const gateway = assertFunctionNode(flow.find((node) => node.id === targets.gateway.id), targets.gateway.id);
  const finalize = assertFunctionNode(flow.find((node) => node.id === targets.finalize.id), targets.finalize.id);
  for (const [label, actual, pin] of [
    ["Booking gateway", sha256(gateway.func), targets.gateway.liveFuncSha256],
    ["Subscription finalizer", sha256(finalize.func), targets.finalize.liveFuncSha256],
  ]) {
    if (actual !== pin) throw new Error(`${label} installed preimage drift: ${actual} != ${pin}`);
  }
  const gatewayBefore = JSON.parse(JSON.stringify({ ...gateway, func: null }));
  const finalizeBefore = JSON.parse(JSON.stringify({ ...finalize, func: null }));

  const patchedGateway = patchConfirmedReplayGatewayBody(gateway.func);
  const patchedFinalize = patchConfirmedReplayFinalizeBody(finalize.func);
  gateway.func = patchedGateway;
  finalize.func = patchedFinalize;
  if (JSON.stringify({ ...gateway, func: null }) !== JSON.stringify(gatewayBefore)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  if (JSON.stringify({ ...finalize, func: null }) !== JSON.stringify(finalizeBefore)) {
    throw new Error("Subscription finalizer changed a field other than func");
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [
    { id: targets.gateway.id, fields: ["func"],
      func: { beforeSha256: targets.gateway.liveFuncSha256, afterSha256: sha256(patchedGateway) } },
    { id: targets.finalize.id, fields: ["func"],
      func: { beforeSha256: targets.finalize.liveFuncSha256, afterSha256: sha256(patchedFinalize) } },
  ];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: changes.map((change) => ({ id: change.id, fields: ["func"] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    preview: {
      gatewayGuard: GATEWAY_MARKERS.every((marker) => patchedGateway.includes(marker)),
      finalizeMoneyEvidence: FINALIZE_MARKERS.every((marker) => patchedFinalize.includes(marker)),
      otherFieldsUnchanged: true,
    },
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function prepareTargets(workspace, requested) {
  const canonical = (value) => {
    if (!path.isAbsolute(value)) throw new Error("Output paths must be absolute");
    if (path.resolve(value) !== value) throw new Error("Output paths must be canonical");
    if (fs.existsSync(value)) throw new Error(`Refusing to overwrite output: ${value}`);
    if (value === workspace || value.startsWith(`${workspace}${path.sep}`)) {
      throw new Error("Outputs must stay outside the live workspace");
    }
    return value;
  };
  return requested.map(canonical);
}

function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
      return;
    }
    if (values[key] !== undefined) {
      fail(`Duplicate argument: ${key}`);
      return;
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
    return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeConfirmedReplayArtifacts(liveBytes, CONFIRMED_REPLAY_DEPLOYMENT_ID, {
    expectedSourceSha256: CONFIRMED_REPLAY_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: CONFIRMED_REPLAY_KIND,
    deploymentId: CONFIRMED_REPLAY_DEPLOYMENT_ID,
    targets: {
      gateway: { id: CONFIRMED_REPLAY_TARGETS.gateway.id,
        func: { beforeSha256: CONFIRMED_REPLAY_TARGETS.gateway.liveFuncSha256,
          afterSha256: built.changes[0].func.afterSha256 } },
      finalize: { id: CONFIRMED_REPLAY_TARGETS.finalize.id,
        func: { beforeSha256: CONFIRMED_REPLAY_TARGETS.finalize.liveFuncSha256,
          afterSha256: built.changes[1].func.afterSha256 } },
    },
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 2,
    addedNodeCount: built.addedNodeCount,
    changes: built.changes,
    preview: built.preview,
    topologyChanged: false, routesChanged: false, policyChanged: false,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
