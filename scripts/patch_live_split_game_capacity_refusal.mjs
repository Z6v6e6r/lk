import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const SOURCE_SHA256 = '0e2b81008aefb3fe940cc14c02010b5b7e10f8cb5e8e91b9890c1473e27ddd32';
const TARGETS = {
  gateway: ['lk_subscription_booking_router_20260804', '68a1dde4e669a02f4dc19dc50a6bfce6b98830dc5961f2aaff798f121f8013a7', 8],
  split: ['8f7bd5b482fe9763', '34ff89678b362b17da83c07f38d1dfa0e88c644774fed8d2ba019780fe7db5ef', 5],
};

const FULL = 'Все места в игре заняты. Состав игры можно уточнить у администратора станции.';
const WAS_FULL = 'На момент вашей попытки все места в игре были заняты. Состав игры можно уточнить у администратора станции.';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Split capacity anchor missing or repeated: ${before.split('\n')[0]}`);
  return source.replace(before, after);
}

export function patchGateway(source) {
  const context = 'const lk1CapacityBinding =';
  let next = replaceOnce(source, context, `const lk1GameCapacityBinding = (ctx) => [ctx.operationId, ctx.actorClientId, ctx.exerciseId, ctx.clientSubscriptionId];
const lk1GameCapacityJoin = (ctx) => ctx.caller === "split"
  && (ctx.action === undefined || ctx.action === "book") && ctx.managedAction === "JOIN_GAME"
  && msg._splitCtx?.action === "join" && !msg._splitCtx.ownsExercise
  && typeof ctx.actorClientId === "string" && ctx.actorClientId.length > 0
  && msg._splitCtx.operationId === ctx.operationId && msg._splitCtx.exerciseId === ctx.exerciseId
  && (!msg._splitCtx.clientId || msg._splitCtx.clientId === ctx.actorClientId)
  && msg._splitCtx.clientSubscriptionId === ctx.clientSubscriptionId;

${context}`);

  const lookup = 'if (ctx.step === "lk1_ingress_operation_find") {';
  next = replaceOnce(next, lookup, `${lookup}
  const fullCapacityRead = ctx.lk1FullCapacityRead;
  delete ctx.lk1FullCapacityRead;`);
  const noPriorOperation = `    delete ctx.lk1IngressReplay;
    ctx.step = "lk1_profile_continue";
  } else {`;
  next = replaceOnce(next, noPriorOperation, `    const joinCapacityBinding = JSON.stringify(lk1GameCapacityBinding(ctx));
    if (lk1GameCapacityJoin(ctx)) {
      if (fullCapacityRead === joinCapacityBinding) {
        return finishError(ctx, 409, ${JSON.stringify(FULL)}, { code: "SPLIT_GAME_FULL" });
      }
      ctx.lk1FreshCapacityCheck = joinCapacityBinding;
    }
${noPriorOperation}`);

  const exercise = `if (ctx.step === "exercise") {`;
  next = replaceOnce(next, exercise, `${exercise}
  // An existing operation or successor continues through its original recovery
  // path. Only a fresh join can stop on this read before any visit or payment is reserved.
  const freshCapacityCheck = ctx.lk1FreshCapacityCheck;
  delete ctx.lk1FreshCapacityCheck;
  if (freshCapacityCheck === JSON.stringify(lk1GameCapacityBinding(ctx)) && lk1GameCapacityJoin(ctx) && !ctx.lk1
    && !ctx.precreatedEntitlementReserved && !ctx.managedEntitlementOperationId
    && !msg.error && isHttpOk(msg.statusCode)) {
    const capacityExercise = unwrapRecord(msg.payload);
    if (capacityExercise?.id === ctx.exerciseId && resolveCategory(capacityExercise) === "open_game"
      && capacityExercise.canceled !== true && capacityExercise.isCancelled !== true
      && capacityExercise.cancelled !== true && capacityExercise.archived !== true
      && Number.isSafeInteger(capacityExercise.maxClientsCount) && capacityExercise.maxClientsCount > 0
      && Number.isSafeInteger(capacityExercise.clientsCount)
      && capacityExercise.clientsCount >= capacityExercise.maxClientsCount) {
      // Another request with this ID may have taken the last seat. Re-check the
      // operation after the Viva read and let existing bookings use normal recovery.
      ctx.lk1FullCapacityRead = freshCapacityCheck;
      ctx.lk1IngressReplay = true;
      return lk1Find(ctx, "lk1_ingress_operation_find", {
        _id: \`lk1-product:\${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}\`,
      });
    }
  }`);

  const release = '    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {';
  return replaceOnce(next, release, `    // The identity and quote above have already been validated. Describe the old
    // refusal only when the worker released an unaccepted attempt without a booking or money leg.
    if (operation.state === "RELEASED" && ctx.lk1IngressReplay === true
      && operation.category === "open_game" && lk1GameCapacityJoin(ctx)
      && quote.target?.category === "GAME" && quote.target.eventId === ctx.exerciseId
      && operation.releaseReason === "RECONCILE_HUNG_DAILY_CLAIM"
      && operation.reconciliation?.source === "hung_claim_reconciler"
      && operation.reconciliation.decision === "SAFE_TO_RELEASE"
      && operation.reconciliation.observedState === "PREPARED"
      && operation.reconciliation.reconciledAt === operation.releasedAt
      && Date.parse(operation.previousFailureAt) <= Date.parse(operation.releasedAt)
      && operation.previousFailure?.statusCode === 409 && operation.previousFailure.rawCode === "CONFLICT"
      && operation.previousFailure.message === "Нет свободных мест"
      && ![operation.acceptedAt, operation.correlationId, operation.bookingId, operation.upstreamBookingId,
        operation.upstreamAttemptedAt, operation.transactionId, operation.managedEntitlementOperationId,
        operation.precreatedEntitlementReserved, quote.createAttemptedAt, quote.bookingAttemptedAt,
        quote.transactionAttemptedAt, quote.transactionId, quote.transactionIntent, quote.checkout,
        quote.visitJob, quote.unpaidCancellation].some(Boolean)) {
      return finishError(ctx, 409, ${JSON.stringify(WAS_FULL)}, { code: "SPLIT_GAME_FULL" });
    }
${release}`);
}

export function patchSplitRouter(source) {
  const fallback = '  return fail(msg.statusCode || 502, "Viva request failed", msg.payload || null);';
  return replaceOnce(source, fallback, `  if (ctx.action === "join" && ctx.step === "create_booking" && !msg.error
    && !ctx.bookingId && !ctx.transactionId && !ctx.lk1Checkout && !ctx.ownsExercise
    && Number(msg.statusCode) === 409 && msg.payload?.code === "CONFLICT"
    && toStr(msg.payload.message || msg.payload.error) === "Нет свободных мест") {
    return fail(409, ${JSON.stringify(FULL)}, { code: "SPLIT_GAME_FULL" });
  }
${fallback}`);
}

export function composeSplitGameCapacity(liveBytes) {
  if (sha256(liveBytes) !== SOURCE_SHA256) throw new Error('Split capacity whole-flow preimage drift');
  const flow = JSON.parse(liveBytes);
  const patches = { gateway: patchGateway, split: patchSplitRouter };
  for (const [key, [id, hash, outputs]] of Object.entries(TARGETS)) {
    const node = flow.find(item => item.id === id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true
      || node.outputs !== outputs || node.wires?.length !== outputs
      || typeof node.func !== 'string' || sha256(node.func) !== hash) throw new Error(`Split capacity ${key} preimage drift`);
    node.func = patches[key](node.func);
    new Function('msg', 'global', 'node', 'flow', 'env', node.func);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({
    liveBytes, candidateBytes, deploymentId: 'split-game-capacity-refusal',
    allowedChanges: Object.values(TARGETS).map(([id]) => ({ id, fields: ['func'] })),
    allowedAdditionIds: [],
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [, , workspace] = process.argv;
    if (!workspace || process.argv.length !== 3) throw new Error('Usage: node scripts/patch_live_split_game_capacity_refusal.mjs ABS_LIVE_WORKSPACE');
    const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
    const verified = verifyWorkspace(workspace, { quiet: true });
    const liveBytes = fs.readFileSync(verified.sourcePath);
    const { candidateBytes, contract } = composeSplitGameCapacity(liveBytes);
    // Only report digests here. The full candidate contains live runtime configuration.
    console.log(JSON.stringify({ sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes),
      changedNodes: Object.keys(TARGETS).length, contractDeploymentId: contract.deploymentId }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
