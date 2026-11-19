import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPrivatePaginationOutput } from './prepare_subscription_booking_pagination.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const bookingId = 'lk_subscription_booking_router_20260804';
const previewId = 'lk_subscription_price_preview_20260908_router';
const bookingFile = 'nodered_subscription_booking_nodes/fn_subscription_booking_router.js';
const previewFile = 'nodered_subscription_price_preview_nodes/router.js';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

const specs = [
  [bookingId, bookingFile, 'const kidsTrainingExcludesSubscription =',
    'const collectSubscriptionPurchaseDateEvidence = (value) => {'],
  [bookingId, 'nodered_lk1_hub_nodes/gateway.js',
    '  if ([2468, 2975, 3163].includes(exerciseDirectionId(exercise)))',
    '  // The station of the resolved booking target is part of the contour decision:',
    '  const configured = lk1Config(owned, exercise?.studio?.id || exercise?.studioId || null);'],
  [bookingId, 'nodered_lk1_hub_nodes/gateway_hooks.js',
    'if (kidsTrainingExcludesSubscription(exercise, selectedOwned)) {',
    'const proTrainingEnergyAllowed = selectedOwned.length === 1'],
  [bookingId, bookingFile,
    '  if (kidsTrainingExcludesSubscription(exercise, ownedSubscriptions)) {\n    return prepareFailedUpdate',
    '  if (!exercise || ownedSubscriptions.length === 0) {',
    '  if (!exercise || ownedSubscriptions.length !== 1) {'],
  [null, bookingFile, '  if (kidsTrainingExcludesSubscription(exercise, ownedSubscriptions)) {\n    return finishError',
    '  ctx.serviceDate = eventDate(exercise);\n  ctx.category = resolveCategory(exercise);'],
  [previewId, previewFile,
    "  if (eventRoute.category === 'group_training' && [2468, 2975, 3163].includes(previewDirectionId(canonical, exercise))) {",
    '  if (canonical.isSpanishTrainingExercise(exercise) || previewDirectionId(canonical, exercise) === 7108) {'],
];

function replaceExact(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Kids training patch anchor drift');
  return source.replace(before, () => after);
}

function insertion(file, start, anchor) {
  const source = read(file);
  const first = source.indexOf(start);
  const last = source.indexOf(anchor, first + start.length);
  if (first === -1 || last === -1 || source.split(start).length !== 2 || source.split(anchor).length !== 2) {
    throw Error('Kids training source anchor drift: ' + file);
  }
  return source.slice(first, last);
}

export function restoreSourceBeforeKidsTrainingGuard(source, relative) {
  for (const [, file, start, anchor] of specs) {
    if (file === relative && source.includes(start)) {
      source = replaceExact(source, insertion(file, start, anchor) + anchor, anchor);
    }
  }
  return source;
}

export function composeKidsTrainingSubscriptionRelease(liveBytes, { release, sourceSha256, bookingSha256, previewSha256 }) {
  if (!/^[a-f0-9]{40}$/.test(release || '') || sha(liveBytes) !== sourceSha256) {
    throw Error('Exact kids training flow preimage required');
  }
  const flow = JSON.parse(liveBytes);
  const checks = [[bookingId, bookingSha256], [previewId, previewSha256]];
  for (const [id, expected] of checks) {
    const router = flow.find(node => node.id === id);
    const tab = flow.find(node => node.id === router?.z && node.type === 'tab');
    if (router?.type !== 'function' || router.d || router.disabled || !tab || tab.disabled
      || sha(router.func || '') !== expected || router.func.includes('KIDS_TRAINING_SUBSCRIPTION_UNAVAILABLE')) {
      throw Error('Kids training router preimage mismatch: ' + id);
    }
    const patches = specs.filter(([nodeId]) => id === nodeId)
      .map(([, file, start, anchor, liveAnchor]) => ({ anchor: liveAnchor || anchor, delta: insertion(file, start, anchor) }));
    const original = router.func;
    router.func = patches.reduce((body, { anchor, delta }) => replaceExact(body, anchor, delta + anchor), original);
    if (patches.reduce((body, { anchor, delta }) => replaceExact(body, delta + anchor, anchor), router.func) !== original) {
      throw Error('Kids training inverse changed the preimage: ' + id);
    }
    new Function(router.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = checks.map(([id]) => ({ id, fields: ['func'] }));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'kids-training-subscription',
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { release, sourceSha256, candidateSha256: sha(candidateBytes),
    allowedChanges, exactInverseVerified: true, liveMutationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, sourceSha256, bookingSha256, previewSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('Clean release checkout required');
  assertPrivatePaginationOutput(repository, verified.workspace, directory);
  const packet = composeKidsTrainingSubscriptionRelease(fs.readFileSync(verified.sourcePath), {
    release, sourceSha256, bookingSha256, previewSha256,
  });
  for (const [file, data] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2)], ['report.json', JSON.stringify(packet.report, null, 2)]]) {
    fs.writeFileSync(path.join(directory, file), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
