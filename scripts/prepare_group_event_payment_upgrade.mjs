import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Public canonical #64 delta only. No installed function body is embedded here.
// Reviewed preimage: installed rejoin/preview expansions; only these bodies qualify.
export const GROUP_UPGRADE_TARGETS = Object.freeze([
  {
    "id": "lk_subscription_booking_router_20260804",
    "file": "scripts/nodered_lk1_hub_nodes/gateway.js",
    "beforeSha256": "26447ec9c83e38ec96a903abe2956146f4909574755e68adffe7a9b49a6ec82a",
    "afterSha256": "719df4042ff61eefe531f2fdb66d929813651bebd0850822351c1c5ee54018f5",
    "canonicalSha256": "ddc8893f9554095195c868297f909ae65cbdf71e22bcb03a668d9b27e4c2f6d0",
    "deltas": [
      {
        "before": "const lk1Checkout = (ctx) => {",
        "after": "// Group events use their server-resolved tariff product, never the game carrier.\nconst lk1IsGroupPayment = (ctx) => ctx.managedAction === \"BOOK_GROUP_TRAINING\";\nconst lk1GroupPaymentBinding = (ctx, quote = ctx.lk1) => {\n  const target = quote?.target;\n  const decision = quote?.decision;\n  const percent = quote?.rule?.groupTrainingDiscountPercent;\n  const base = target?.basePriceMinor;\n  if (ctx.caller !== \"http\" || target?.category !== \"GROUP_TRAINING\"\n    || target.eventId !== ctx.exerciseId || typeof target.priceProductId !== \"string\" || !target.priceProductId.trim()\n    || !Number.isSafeInteger(base) || base <= 0 || base > 1_000_000\n    || !Number.isSafeInteger(percent) || percent < 0 || percent > 100\n    || decision?.eligible !== true || decision.subscriptionVisitCount !== 0\n    || decision.benefit?.finalPriceMinor !== base - Math.floor(base * percent / 100)) return null;\n  return { productId: target.priceProductId, productType: \"SERVICE\", baseMinor: base,\n    chargeMinor: decision.benefit.finalPriceMinor,\n    discountMinor: base - decision.benefit.finalPriceMinor };\n};\n// Payment products use Viva's services/subServices envelopes as well as lists.\nconst lk1PaymentProductRows = (value, seen = new Set()) => {\n  if (Array.isArray(value)) return value;\n  if (!isObj(value) || seen.has(value) || value.last === false || value.hasNext === true) return null;\n  seen.add(value);\n  const keys = [\"content\", \"items\", \"records\", \"data\", \"payload\", \"result\", \"services\", \"subServices\"]\n    .filter(key => value[key] !== undefined);\n  if (!keys.length) return null;\n  const lists = keys.map(key => lk1PaymentProductRows(value[key], seen));\n  if (lists.some(rows => rows === null)) return null;\n  const rows = lists.flat();\n  const total = Number(value.totalElements ?? value.totalCount);\n  const page = Number(value.number ?? value.page);\n  const pages = Number(value.totalPages);\n  if ((Number.isFinite(total) && total > rows.length)\n    || (Number.isFinite(page) && Number.isFinite(pages) && page + 1 < pages)) return null;\n  return rows;\n};\nconst lk1Checkout = (ctx) => {"
      },
      {
        "before": "    return prepareAdminGet(ctx, \"lk1_transaction_readback\", `/api/v1/transactions/${encodeURIComponent(ctx.lk1.transactionId)}`);\n  }\n  // Reuse the split SERVICE selection and serializer via the existing finalizer.\n  const token = readGlobal(\"vivacrm_access_token\");\n  if (!token) return lk1Stop(ctx, \"LK1_SERVICE_TOKEN_UNAVAILABLE\");\n",
        "after": "    return prepareAdminGet(ctx, \"lk1_transaction_readback\", `/api/v1/transactions/${encodeURIComponent(ctx.lk1.transactionId)}`);\n  }\n  if (lk1IsGroupPayment(ctx) && !lk1GroupPaymentBinding(ctx)) return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_BINDING_INVALID\");\n  // Groups select the event tariff below; games retain the existing split serializer.\n  const token = readGlobal(\"vivacrm_access_token\");\n  if (!token) return lk1Stop(ctx, \"LK1_SERVICE_TOKEN_UNAVAILABLE\");\n"
      },
      {
        "before": "    }\n    const amount = quote.decision.benefit.finalPriceMinor;\n    if (amount > 0) {\n      const checkout = quote.checkout;\n",
        "after": "    }\n    const amount = quote.decision.benefit.finalPriceMinor;\n    if (managedActionForTarget({ ...ctx, category: operation.category }) === \"BOOK_GROUP_TRAINING\") {\n      const binding = lk1GroupPaymentBinding({ ...ctx, exerciseId: operation.exerciseId }, quote);\n      const intent = quote.transactionIntent;\n      // A previously verified legacy game-carrier checkout remains replayable.\n      // It never re-enters the write path; missing checkout still fails below.\n      const legacy = isObj(intent) && !Object.prototype.hasOwnProperty.call(intent, \"productType\")\n        && !Object.prototype.hasOwnProperty.call(intent, \"baseMinor\");\n      const validIntent = legacy\n        ? typeof intent.productId === \"string\" && Boolean(intent.productId.trim()) && intent.discountMinor === 1_000_000 - amount\n        : binding && isObj(intent) && intent.productId === binding.productId && intent.productType === binding.productType\n          && intent.baseMinor === binding.baseMinor && intent.discountMinor === binding.discountMinor;\n      if (!binding || (amount > 0 && !validIntent)) return lk1Stop(ctx, \"LK1_PAYMENT_RECONCILIATION_REQUIRED\");\n    }\n    if (amount > 0) {\n      const checkout = quote.checkout;\n"
      },
      {
        "before": "      || !Number.isSafeInteger(expected.basePriceMinor) || !Number.isSafeInteger(expected.amountMinor)\n      || expected.basePriceMinor !== target.basePriceMinor || expected.amountMinor !== decision.benefit.finalPriceMinor\n      || expected.productId !== target.priceProductId || expected.discountPercent !== 50\n      || expected.discountPercent !== ctx.lk1.rule.groupTrainingDiscountPercent\n      || expected.durationMinutes !== target.durationMinutes || typeof expected.startsAt !== \"string\"\n",
        "after": "      || !Number.isSafeInteger(expected.basePriceMinor) || !Number.isSafeInteger(expected.amountMinor)\n      || expected.basePriceMinor !== target.basePriceMinor || expected.amountMinor !== decision.benefit.finalPriceMinor\n      || expected.productId !== target.priceProductId\n      || expected.discountPercent !== ctx.lk1.rule.groupTrainingDiscountPercent\n      || expected.durationMinutes !== target.durationMinutes || typeof expected.startsAt !== \"string\"\n"
      },
      {
        "before": "if (ctx.step === \"lk1_payment_products\") {\n  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, \"LK1_PAYMENT_CARRIER_UNAVAILABLE\");\n  msg.statusCode = 200;\n  msg._subscriptionBooking = ctx;\n",
        "after": "if (ctx.step === \"lk1_payment_products\") {\n  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, \"LK1_PAYMENT_CARRIER_UNAVAILABLE\");\n  if (lk1IsGroupPayment(ctx)) {\n    const binding = lk1GroupPaymentBinding(ctx);\n    const products = lk1PaymentProductRows(msg.payload);\n    if (!binding || !products) return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_BINDING_INVALID\");\n    const rows = products.filter(row => isObj(row)\n      && [row.id, row.productId].includes(binding.productId));\n    if (rows.length !== 1) return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_PRODUCT_UNAVAILABLE\");\n    const row = rows[0];\n    const exact = (values, expected) => {\n      const present = values.filter(value => value !== undefined);\n      return present.length > 0 && present.every(value => value === expected);\n    };\n    if (!exact([row.id, row.productId], binding.productId)\n      || !exact([row.type, row.productType], binding.productType)\n      || !exact([row.cost, row.price, row.amount], binding.baseMinor)) {\n      return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_PRODUCT_CHANGED\");\n    }\n    const product = { id: binding.productId, type: binding.productType, count: 1,\n      bookingIds: [ctx.confirmedBookingId], customAmount: null, discount: binding.discountMinor };\n    msg._splitCtx = { productId: binding.productId, transactionPayload: {\n      clientPhone: ctx.actorPhone, paymentMethod: \"SMS\", products: [product], studioId: ctx.studioId,\n      discountReason: \"Скидка по правилам подписки на групповое занятие\",\n    } };\n    return prepareUserGet(ctx, \"lk1_payment_profile_recheck\", `/end-user/api/v1/${ctx.tenantKey}/profile`);\n  }\n  msg.statusCode = 200;\n  msg._subscriptionBooking = ctx;\n"
      },
      {
        "before": "  const payload = msg._splitCtx?.transactionPayload;\n  const product = payload?.products?.[0];\n  if (!isHttpOk(msg.statusCode) || normalizeId(profile?.id || profile?.clientId) !== normalizeId(ctx.actorClientId)\n    || normalizePhone(profile?.phone || profile?.phoneNumber) !== normalizePhone(ctx.actorPhone)\n",
        "after": "  const payload = msg._splitCtx?.transactionPayload;\n  const product = payload?.products?.[0];\n  const group = lk1IsGroupPayment(ctx);\n  const binding = group ? lk1GroupPaymentBinding(ctx) : null;\n  if (group && (!binding || product?.id !== binding.productId)) return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_BINDING_INVALID\");\n  if (!isHttpOk(msg.statusCode) || normalizeId(profile?.id || profile?.clientId) !== normalizeId(ctx.actorClientId)\n    || normalizePhone(profile?.phone || profile?.phoneNumber) !== normalizePhone(ctx.actorPhone)\n"
      },
      {
        "before": "    || typeof product.id !== \"string\" || product.id !== msg._splitCtx.productId\n    || !Number.isSafeInteger(product.discount)\n    || product.discount !== 1_000_000 - ctx.lk1.decision.benefit.finalPriceMinor) {\n    return lk1Stop(ctx, \"LK1_PAYMENT_INTENT_INVALID\");\n  }\n",
        "after": "    || typeof product.id !== \"string\" || product.id !== msg._splitCtx.productId\n    || !Number.isSafeInteger(product.discount)\n    || product.discount !== (group ? binding.baseMinor : 1_000_000) - ctx.lk1.decision.benefit.finalPriceMinor) {\n    return lk1Stop(ctx, \"LK1_PAYMENT_INTENT_INVALID\");\n  }\n"
      },
      {
        "before": "  ctx.lk1.transactionIntent = { productId: product.id, bookingId: ctx.confirmedBookingId,\n    actorClientId: ctx.actorClientId, studioId: ctx.studioId,\n    chargeMinor: ctx.lk1.decision.benefit.finalPriceMinor, discountMinor: product.discount };\n  // No credentials, phone or caller redirects in the durable price/minute record.\n  ctx.lk1TransactionPayload = { clientPhone: payload.clientPhone, paymentMethod: \"SMS\",\n",
        "after": "  ctx.lk1.transactionIntent = { productId: product.id, bookingId: ctx.confirmedBookingId,\n    actorClientId: ctx.actorClientId, studioId: ctx.studioId,\n    chargeMinor: ctx.lk1.decision.benefit.finalPriceMinor, discountMinor: product.discount,\n    ...(group ? { productType: binding.productType, baseMinor: binding.baseMinor } : {}) };\n  // No credentials, phone or caller redirects in the durable price/minute record.\n  ctx.lk1TransactionPayload = { clientPhone: payload.clientPhone, paymentMethod: \"SMS\",\n"
      },
      {
        "before": "  const transaction = unwrapRecord(msg.payload);\n  const intent = ctx.lk1.transactionIntent;\n  // All supplied aliases are evidence, not alternatives from which to pick a\n  // convenient value. Conflicting or malformed evidence cannot prove a bill.\n",
        "after": "  const transaction = unwrapRecord(msg.payload);\n  const intent = ctx.lk1.transactionIntent;\n  if (lk1IsGroupPayment(ctx)) {\n    const binding = lk1GroupPaymentBinding(ctx);\n    if (!binding || !isObj(intent) || intent.productId !== binding.productId\n      || intent.productType !== binding.productType || intent.baseMinor !== binding.baseMinor\n      || intent.chargeMinor !== binding.chargeMinor || intent.discountMinor !== binding.discountMinor) {\n      return lk1Stop(ctx, \"LK1_GROUP_PAYMENT_BINDING_INVALID\");\n    }\n  }\n  // All supplied aliases are evidence, not alternatives from which to pick a\n  // convenient value. Conflicting or malformed evidence cannot prove a bill.\n"
      }
    ]
  },
  {
    "id": "lk_subscription_price_preview_20260908_router",
    "file": "scripts/nodered_subscription_price_preview_nodes/router.js",
    "beforeSha256": "978bb9b97c290aac945cf425ec7ddd74e2e8d1a8aee4eeec0c47b9e44bb93171",
    "afterSha256": "561388227873f8349e754fa32ca057b512bafeb6a7cdc6f50c764cef7528f3d5",
    "canonicalSha256": "8a821bacde78f507d9590dd6ef0052dbcc7fc3520dbc06454b85ce2535e77aed",
    "deltas": [
      {
        "before": "      || decision.benefit.finalPriceMinor > ctx.basePriceMinor) return stop('PRICE_PREVIEW_DECISION_INVALID');\n    if (ctx.groupTraining) {\n      if (decision.subscriptionVisitCount !== 0 || ctx.groupDiscountPercent !== 50\n        || decision.benefit.finalPriceMinor !== Math.round(ctx.basePriceMinor * 0.5)) return stop('GROUP_DISCOUNT_DECISION_INVALID');\n      quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, 0, ctx.target.durationMinutes);\n    } else {\n",
        "after": "      || decision.benefit.finalPriceMinor > ctx.basePriceMinor) return stop('PRICE_PREVIEW_DECISION_INVALID');\n    if (ctx.groupTraining) {\n      if (decision.subscriptionVisitCount !== 0 || (!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)\n        || decision.benefit.finalPriceMinor !== ctx.basePriceMinor - Math.floor(ctx.basePriceMinor * ctx.groupDiscountPercent / 100)) return stop('GROUP_DISCOUNT_DECISION_INVALID');\n      quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, 0, ctx.target.durationMinutes);\n    } else {\n"
      },
      {
        "before": "    }\n    ctx.groupDiscountPercent = configured.rule.groupTrainingDiscountPercent;\n    if (ctx.groupDiscountPercent !== 50) return stop('GROUP_DISCOUNT_RULE_UNCONFIRMED');\n  }\n  const visitCount = configured.matched ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;\n",
        "after": "    }\n    ctx.groupDiscountPercent = configured.rule.groupTrainingDiscountPercent;\n    if ((!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)) return stop('GROUP_DISCOUNT_RULE_UNCONFIRMED');\n  }\n  const visitCount = configured.matched ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;\n"
      }
    ]
  }
]);

export function patchGroupEventPaymentBody(source, target) {
  let result = source;
  for (const delta of target.deltas) {
    if (result.split(delta.before).length !== 2) throw new Error(`Group payment anchor drift: ${target.id}`);
    result = result.replace(delta.before, () => delta.after);
  }
  new Function('msg', 'node', 'global', 'flow', 'env', result);
  return result;
}

// Alternate pins are a synthetic-test seam. The CLI always uses reviewed pins.
export function composeGroupEventPaymentUpgrade(liveBytes, deploymentId, pins = GROUP_UPGRADE_TARGETS) {
  const source = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(source) || source.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(source.map(n => n.id)).size !== source.length) throw new Error('Invalid flow identity');
  if (pins.length !== GROUP_UPGRADE_TARGETS.length
    || pins.some((p, i) => p.id !== GROUP_UPGRADE_TARGETS[i].id)) throw new Error('Invalid target allowlist');
  const candidate = structuredClone(source);
  for (const target of pins) {
    const node = candidate.find(n => n.id === target.id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true
      || !Number.isInteger(node.outputs) || node.outputs < 1 || node.wires?.length !== node.outputs
      || typeof node.func !== 'string') throw new Error(`Node contract mismatch: ${target.id}`);
    if (hash(fs.readFileSync(path.join(ROOT, target.file))) !== target.canonicalSha256) {
      throw new Error(`Canonical source drift: ${target.id}`);
    }
    if (hash(node.func) !== target.beforeSha256) throw new Error(`Preimage drift: ${target.id}`);
    node.func = patchGroupEventPaymentBody(node.func, target);
    if (hash(node.func) !== target.afterSha256) throw new Error(`Postimage drift: ${target.id}`);
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes: Buffer.from(liveBytes), candidateBytes, deploymentId,
    allowedChanges: GROUP_UPGRADE_TARGETS.map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: Buffer.from(liveBytes), candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}

export function writeGroupUpgradeArtifacts(input, output, deploymentId) {
  if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '') || fs.existsSync(output)
    || path.resolve(output) !== output || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error('Use absolute input and a new canonical private output directory');
  }
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: path.dirname(output), stdio: 'pipe' });
    throw new Error('Raw output must stay outside Git');
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const liveBytes = fs.readFileSync(input);
  const artifacts = composeGroupEventPaymentUpgrade(liveBytes, deploymentId);
  fs.mkdirSync(output, { mode: 0o700 });
  const summary = { deploymentId, sourceSha256: hash(liveBytes), candidateSha256: hash(artifacts.candidateBytes),
    changes: GROUP_UPGRADE_TARGETS.map(({ id, beforeSha256, afterSha256 }) => ({ id, fields: ['func'], beforeSha256, afterSha256 })),
    addedNodes: 0, liveWrites: 0 };
  for (const [name, value] of [['candidate.flow.json', artifacts.candidateBytes],
    ['exact-graph-contract.json', JSON.stringify(artifacts.contract, null, 2) + '\n'],
    ['operator-summary.json', JSON.stringify(summary, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: node prepare_group_event_payment_upgrade.mjs /absolute/source.flow.json /absolute/new-private-directory deployment-id');
  console.log(JSON.stringify(writeGroupUpgradeArtifacts(...process.argv.slice(2))));
}
