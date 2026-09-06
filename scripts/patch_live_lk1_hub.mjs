import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { verifyWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';

// This adapter composes only the direct HUB rule over the reviewed live bodies.
// Generic main/CUP sources and all non-target graph fields are deliberately inert.
export const HUB_IDS = Object.freeze({
  split: '8f7bd5b482fe9763',
  gateway: 'lk_subscription_booking_router_20260804',
  finalize: 'lk_subscription_booking_finalize_20260804',
  evaluator: 'lk_subscription_managed_policy_20260820',
});
export const HUB_PREIMAGES = Object.freeze({
  split: 'c6ecc73da7b68b006b5e50950435cb8eb6d56027fec2dad441f0c1fb8818c5e0',
  gateway: '818817e01cdd1771e6efdfcf6cfe261f626f73456425d77ff859ec04906e475d',
  finalize: '37b05b0a6fb18c854317e9eb0bd5ebf753fb1724cd3909172ca857798498f881',
  evaluator: '47c5e8b751e2379a27ed969aaf29e82a84e6dc8472a0235bb05052e5a715c853',
});
const dir = path.dirname(fileURLToPath(import.meta.url));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const snippet = name => fs.readFileSync(path.join(dir, 'nodered_lk1_hub_nodes', name + '.js'), 'utf8');
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('HUB exact source anchor drift: ' + before.slice(0, 80));
  return source.replace(before, after);
}
function replaceStep(source, step, before, after) {
  const marker = 'if (ctx.step === "' + step + '") {';
  if (source.split(marker).length !== 2) throw new Error('HUB step anchor drift');
  const start = source.indexOf(marker);
  const end = source.indexOf('\nif (', start + marker.length);
  if (end < 0) throw new Error('HUB step end drift');
  const section = source.slice(start, end);
  return source.slice(0, start) + replace(section, before, after) + source.slice(end);
}
function sections(source) {
  const parts = source.split(/^\/\/ HUB_([A-Z]+)\s*$/m);
  const result = {};
  for (let i = 1; i < parts.length; i += 2) {
    if (Object.hasOwn(result, parts[i])) throw new Error('Duplicate HUB fragment');
    result[parts[i]] = parts[i + 1].trim();
  }
  return result;
}
export function patchHubSources(source) {
  for (const key of Object.keys(HUB_IDS)) {
    if (hash(source[key] || '') !== HUB_PREIMAGES[key]) throw new Error('HUB function preimage drift: ' + key);
  }
  const out = { ...source };
  const hooks = sections(snippet('gateway_hooks'));
  const gateway = snippet('gateway').split('// HUB_STEPS');
  if (gateway.length !== 2) throw new Error('HUB gateway fragment drift');
  out.gateway = replace(out.gateway, 'const ctx = isObj(msg._subscriptionBooking)',
    hooks.HELPERS + '\n' + gateway[0] + '\nconst ctx = isObj(msg._subscriptionBooking)');
  out.gateway = replace(out.gateway, 'if (ctx.step === "profile") {',
    gateway[1] + '\nif (ctx.step === "profile") {');
  out.gateway = replace(out.gateway, '  if (ctx.action === "release") {\n    return prepareUserGet(ctx, "active_bookings"',
    '  if (ctx.lk1BeforeCreate === true) {\n'
    + '    if (ctx.caller !== "split" || ctx.actorClientId !== ctx.lk1ApprovedActor) return lk1Stop(ctx, "LK1_CREATE_ACTOR_CHANGED");\n'
    + '    return prepareUserGet(ctx, "prospective_subscriptions", "/end-user/api/v1/" + ctx.tenantKey + "/subscriptions?includeFinished=true&size=1000");\n'
    + '  }\n  if (ctx.action === "release") {\n    return prepareUserGet(ctx, "active_bookings"');
  out.gateway = replaceStep(out.gateway, 'exercise', '  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);',
    hooks.EXERCISE + '\n  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);');
  out.gateway = replace(out.gateway, 'if (ctx.step === "exercise_recheck") {',
    'if (ctx.step === "exercise_recheck") {\n' + hooks.RECHECK);
  out.gateway = replace(out.gateway, '  delete ctx.activeBookingsPayload;',
    '  delete ctx.activeBookingsPayload;\n' + hooks.HISTORY);
  out.gateway = replace(out.gateway, 'const preparePreaccept = (ctx) => {\n  const now = new Date();',
    'const preparePreaccept = (ctx) => {\n  const now = new Date();\n' + hooks.PREACCEPT);
  out.gateway = replace(out.gateway, '  msg.payload = [query, update, {}];',
    '  msg.payload = [query, update, ctx.lk1 ? { writeConcern: { w: "majority", j: true } } : {}];');
  out.gateway = replace(out.gateway, '  if (ctx.spot) payload.spot = ctx.spot;',
    hooks.BOOKING + '\n  if (ctx.spot) payload.spot = ctx.spot;');
  out.gateway = replace(out.gateway, 'if (ctx.step === "operation_insert") {',
    'if (ctx.step === "operation_insert") {\n'
    + '  if (ctx.lk1 && (msg.error || !lk1MongoInserted(msg.payload, ctx.operationKey))) return lk1Stop(ctx, "LK1_INSERT_ACK_UNKNOWN");');
  for (const step of ['operation_preaccept', 'operation_accept', 'operation_confirm']) {
    out.gateway = replace(out.gateway, 'if (ctx.step === "' + step + '") {',
      'if (ctx.step === "' + step + '") {\n'
      + '  if (ctx.lk1 && (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1)) return lk1Stop(ctx, "LK1_DURABLE_ACK_UNKNOWN");'
      + (step === 'operation_confirm' ? '\n  if (ctx.lk1) return lk1Checkout(ctx);' : ''));
  }
  out.gateway = replace(out.gateway, 'if (ctx.step === "confirmation_bookings") {',
    'if (ctx.step === "confirmation_bookings") {\n' + hooks.CONFIRMATION);
  out.gateway = replace(out.gateway, '  ctx.correlationId = extractCorrelationId(msg.payload);',
    '  if (ctx.lk1 && !bookingId(msg.payload)) return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNKNOWN");\n'
    + '  ctx.correlationId = extractCorrelationId(msg.payload);');
  out.gateway = replace(out.gateway, '  ctx.step = step;\n  msg._subscriptionBooking = ctx;\n  msg.method = method;',
    '  ctx.step = step;\n  msg._subscriptionBooking = ctx;\n'
    + '  if (ctx.lk1 || ctx.lk1BeforeCreate || ctx.lk1ReadOnlyQuote) { msg.followRedirects = false; msg.maxRedirects = 0; }\n'
    + '  msg.method = method;');

  out.evaluator = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n'
    + '  return (() => {\n' + snippet('evaluator') + '\n})();\n}\n' + out.evaluator;

  out.split = replace(out.split, 'const continueSplitAfterVerifiedPrice = (ctx) => {',
    snippet('split') + '\nconst continueSplitAfterVerifiedPrice = (ctx) => {');
  out.split = replace(out.split, '    subscriptionVisitCount: resolveSubscriptionVisitCount(ctx),\n    startedAt:',
    '    subscriptionVisitCount: resolveSubscriptionVisitCount(ctx),\n'
    + '    lk1TariffProof: ctx.lk1TariffProof,\n    lk1CreateBinding: ctx.lk1CreateBinding,\n'
    + '    lk1CreatePayload: ctx.action === "create" ? lk1CreatePayload(ctx) : undefined,\n    startedAt:');
  out.split = replace(out.split, '    ctx.step = "create_exercise";',
    '    if (ctx.lk1ReadOnlyApproval) {\n'
    + '      if (!ctx.lk1CreateBinding) return startLk1CreateAttempt(ctx);\n'
    + '      if (!lk1CreateDispatchBound(ctx)) return fail(409, "HUB CREATE requires durable confirmation");\n'
    + '      ctx.lk1CreateDispatchUsed = true;\n'
    + '      delete msg._subscriptionBooking;\n'
    + '    } else if (ctx.lk1CreateBinding) { return fail(409, "HUB CREATE marker is unbound"); }\n'
    + '    ctx.step = "create_exercise";');
  out.split = replace(out.split, '  ctx.exactCourtPriceVerified = true;',
    '  ctx.exactCourtPriceVerified = true;\n  retainLk1TariffProof(ctx, Math.round(ctx.shareAmount * 100));');
  out.split = replace(out.split,
    '      ctx.shareAmount = Math.max(0, Math.round(hourlyAmount * durationMinutes / 60 * 100) / 100);',
    '      ctx.shareAmount = Math.max(0, Math.round(hourlyAmount * durationMinutes / 60 * 100) / 100);\n'
    + '      retainLk1TariffProof(ctx, Math.round(ctx.shareAmount * 100));');
  out.split = replace(out.split, 'if (ctx.step === "token") {',
    'if (ctx.step === "lk1_tariff_required") {\n'
    + '  if (!["create", "join"].includes(ctx.action) || resolveBookingPaymentType(ctx) !== "SUBSCRIPTION") return fail(409, "HUB tariff context lost");\n'
    + '  return startOrdinaryPriceVerification(ctx);\n}\n'
    + sections(snippet('split_hooks')).CHECKOUT + '\nif (ctx.step === "token") {');
  out.split = replace(out.split, 'const fail = (status, error, details) => {',
    'const fail = (status, error, details) => {\n' + sections(snippet('split_hooks')).FAIL);
  out.split = replace(out.split, 'if (!isOk(msg.statusCode)) {',
    'if (!isOk(msg.statusCode)) {\n  if (ctx.lk1CreateBinding && ctx.step === "create_exercise") return fail(202, "HUB CREATE outcome unknown");');
  out.split = replace(out.split, 'if (ctx.step === "available_products") {',
    'if (ctx.step === "available_products") {\n' + sections(snippet('split_hooks')).PRODUCTS);
  out.split = replace(out.split, '  const selectedProductType = resolveProductType(selectedProduct.raw);',
    '  const selectedProductType = resolveProductType(selectedProduct.raw);\n'
    + '  const lk1CarrierTypes = [selectedProduct.raw?.productType, selectedProduct.raw?.type].filter(value => value !== undefined);\n'
    + '  if (lk1 && (selectedMode !== "one_time" || selectedProductType !== "SERVICE"\n'
    + '    || !lk1CarrierTypes.length || lk1CarrierTypes.some(value => value !== "SERVICE")\n'
    + '    || selectedProduct.raw?.cost !== 1_000_000 || selectedProduct.costMinor !== 1_000_000\n'
    + '    || typeof selectedProduct.raw?.id !== "string" || selectedProduct.raw.id !== selectedProduct.id\n'
    + '    || lk1.finalPriceMinor > 1_000_000)) return fail(409, "HUB SERVICE carrier unavailable");');
  out.split = replace(out.split, '    selectedMode === "one_time"\n    && policyHourlyAmount === null',
    '    !lk1 && selectedMode === "one_time"\n    && policyHourlyAmount === null');
  out.split = replace(out.split, '  const shareAmountMinor = selectedMode === "one_time" && policyHourlyAmount !== null',
    '  const shareAmountMinor = lk1 ? lk1.finalPriceMinor : selectedMode === "one_time" && policyHourlyAmount !== null');
  out.split = replace(out.split, '  if (ctx.successUrl) {\n    transactionPayload.successUrl',
    '  if (lk1) { transactionPayload.paymentMethod = "SMS"; transactionPayload.discountReason = "Льгота абонемента: оплата платной части события"; }\n'
    + '  if (!lk1 && ctx.successUrl) {\n    transactionPayload.successUrl');
  out.split = replace(out.split, '  if (ctx.failUrl) {\n    transactionPayload.failUrl',
    '  if (!lk1 && ctx.failUrl) {\n    transactionPayload.failUrl');
  out.split = replace(out.split, '  ctx.transactionPayload = transactionPayload;',
    '  ctx.transactionPayload = transactionPayload;\n' + sections(snippet('split_hooks')).PAYMENT);

  const finalize = snippet('finalize').split('if (ctx?.lk1) {');
  if (finalize.length !== 2) throw new Error('HUB finalizer fragment drift');
  out.finalize = replace(out.finalize, 'if (ctx?.caller === "split_create_readonly_preflight") {',
    'const responseStatus = Number(msg.statusCode) || 0;\n' + finalize[0]
    + '\nif (ctx?.caller === "split_create_readonly_preflight") {');
  out.finalize = replace(out.finalize, '    split.subscriptionCreatePreflightDone = true;',
    '    if (ctx.lk1ReadOnlyQuote) {\n'
    + '      split.lk1ReadOnlyApproval = { operationId: ctx.operationId, actorClientId: ctx.actorClientId,\n'
    + '        clientSubscriptionId: ctx.clientSubscriptionId, createPayload: ctx.lk1CreatePayload };\n'
    + '    }\n    split.subscriptionCreatePreflightDone = true;');
  out.finalize = replace(out.finalize, 'if (ctx?.caller === "split" && payload.state === "CONFIRMED" && payload.bookingId) {',
    'if (ctx?.lk1) {' + finalize[1]
    + '\nif (ctx?.caller === "split" && payload.state === "CONFIRMED" && payload.bookingId) {');
  for (const value of Object.values(out)) new Function('msg', 'node', 'env', 'global', value);
  return out;
}
export function composeHubFlow(flow) {
  const ids = assertFlowArray(flow);
  const pins = JSON.parse(fs.readFileSync(path.join(dir, 'nodered_lk1_hub_nodes/preimages.json'), 'utf8'));
  for (const [id, expected] of Object.entries(pins.nodes)) {
    const node = flow.find(n => n.id === id);
    if (!node || hash(JSON.stringify(node)) !== expected) throw new Error('HUB node/dependency preimage drift: ' + id);
  }
  const targets = new Set(Object.values(HUB_IDS));
  const incoming = flow.flatMap(n => (n.wires || []).flatMap((group, output) =>
    group.filter(id => targets.has(id)).map(id => [n.id, output, id]))).sort();
  if (!isDeepStrictEqual(incoming, pins.incoming)) throw new Error('HUB incoming route drift');
  if (flow.some(n => [...(n.wires || []).flat(),
    ...(['link in', 'link out'].includes(n.type) ? n.links || [] : [])].some(id => !ids.has(id)))) {
    throw new Error('HUB source has broken graph references');
  }
  const original = Object.fromEntries(Object.entries(HUB_IDS).map(([key, id]) => {
    const matches = flow.filter(n => n.id === id && n.type === 'function');
    if (matches.length !== 1) throw new Error('Missing HUB target: ' + key);
    return [key, matches[0].func];
  }));
  const patched = patchHubSources(original);
  const candidate = structuredClone(flow);
  for (const [key, id] of Object.entries(HUB_IDS)) candidate.find(n => n.id === id).func = patched[key];
  const changed = candidate.filter((n, i) => !isDeepStrictEqual(n, flow[i]));
  if (changed.length !== 4 || changed.some(n => {
    const before = flow.find(old => old.id === n.id);
    return !isDeepStrictEqual({ ...n, func: before.func }, before);
  })) throw new Error('HUB four-function change budget exceeded');
  return candidate;
}

// Pure composition above accepts the frozen local fixture. Artifact publication
// always rechecks fresh live-pull custody; an old local test is not a live permit.
export function assertHubOutputPath(outputDirectory) {
  const output = path.resolve(outputDirectory);
  if (!path.isAbsolute(outputDirectory) || fs.existsSync(output)
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error('Use a new canonical private external output directory');
  }
  let insideGit = false;
  try {
    insideGit = execFileSync('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'],
      { cwd: path.dirname(output), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim().split('\n').includes('true');
  } catch (error) {
    // Only "not a git repository" is a proven external destination.
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  if (insideGit) throw new Error('HUB raw candidate must stay outside every Git worktree and git directory');
  return output;
}
export function hubSourceProvenance() {
  const repo = fs.realpathSync(path.join(dir, '..'));
  const provenance = readRepositoryProvenance(repo);
  if (provenance.sourceDirty) throw new Error('HUB publication requires a clean committed source');
  const closure = ['scripts/patch_live_lk1_hub.mjs', 'scripts/verify_nodered_source_origin.mjs',
    'scripts/lib/release-provenance.mjs',
    ...['gateway.js', 'gateway_hooks.js', 'split.js', 'split_hooks.js', 'finalize.js',
      'evaluator.js', 'preimages.json'].map(name => 'scripts/nodered_lk1_hub_nodes/' + name)];
  const sourceFiles = Object.fromEntries(closure.map(file => {
    const disk = fs.readFileSync(path.join(repo, file));
    const committed = execFileSync('git', ['show', provenance.sourceCommit + ':' + file],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4_000_000 });
    if (!disk.equals(committed)) throw new Error('HUB executable source differs from committed bytes');
    return [file, hash(disk)];
  }));
  return { sourceCommit: provenance.sourceCommit, sourceBranch: provenance.sourceBranch,
    sourceDirty: false, sourceFiles, sourceClosureSha256: hash(JSON.stringify(sourceFiles)) };
}
export function buildHubCandidate(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const provenance = hubSourceProvenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const candidate = composeHubFlow(verified.source);
  const bytes = JSON.stringify(candidate, null, 2) + '\n';
  const report = { ...provenance, sourceSha256: verified.sourceSha256, candidateSha256: hash(bytes),
    changed: Object.entries(HUB_IDS).map(([key, id]) => ({ id, fields: ['func'],
      beforeSha256: HUB_PREIMAGES[key], afterSha256: hash(candidate.find(n => n.id === id).func) })),
    nodeCount: candidate.length, httpRouteCount: candidate.filter(n => n.type === 'http in').length,
    deployed: false, rulesActivated: false, liveMutationPerformed: false };
  if (!isDeepStrictEqual(provenance, hubSourceProvenance())) throw new Error('HUB source changed during composition');
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'candidate.json'), bytes, { mode: 0o600, flag: 'wx' });
  // Report is last: a partially written directory is not a completed candidate.
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: <fresh-live-workspace> <new-private-output-directory>');
    console.log(JSON.stringify(buildHubCandidate(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
