import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertPrivatePaginationOutput } from './prepare_subscription_booking_pagination.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const bookingId = 'lk_subscription_booking_router_20260804';
const previewId = 'lk_subscription_price_preview_20260908_router';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

function uniqueReplace(source, before, after) {
  if (!before || source.split(before).length !== 2) throw Error('Child tournament guard anchor drift');
  return source.replace(before, () => after);
}

const quoteAnchor = '  if (isSpanishTrainingExercise(exercise)) return { code: "SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE" };\n';
const quoteGuard = '  if (exerciseDirectionId(exercise) === 7108) return { code: "CHILD_TOURNAMENT_SUBSCRIPTION_UNAVAILABLE" };\n';
const hookAnchor = '// Resolve the instance first. PRO monetary eligibility is checked only after fresh\n';
const hookGuard = `if (exerciseDirectionId(exercise) === 7108) {
  return finishError(ctx, 409, "На детский турнир можно записаться только с разовой оплатой.", {
    code: "CHILD_TOURNAMENT_SUBSCRIPTION_UNAVAILABLE",
  });
}
`;
const legacyAnchor = '  const actualExerciseId = toStr(exercise?.id || exercise?.exerciseId || exercise?.uuid);\n'
  + '  const ownedSubscriptions = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);';
const legacyGuard = `  const direction = exercise?.direction ?? exercise?.exerciseDirection;
  const directionId = Number((isObj(direction) ? (direction.id ?? direction.directionId) : direction)
    ?? exercise?.directionId ?? exercise?.exerciseDirectionId);
  if (directionId === 7108) {
    return prepareFailedUpdate(ctx, 409, "На детский турнир можно записаться только с разовой оплатой.", "CHILD_TOURNAMENT_SUBSCRIPTION_UNAVAILABLE");
  }
`;
const originalPreview = '  if (canonical.isSpanishTrainingExercise(exercise)) {';
const updatedPreview = '  if (canonical.isSpanishTrainingExercise(exercise) || previewDirectionId(canonical, exercise) === 7108) {';

const gatewayPatches = {
  'nodered_lk1_hub_nodes/gateway.js': [quoteAnchor, quoteAnchor + quoteGuard],
  'nodered_lk1_hub_nodes/gateway_hooks.js': [hookAnchor, hookGuard + hookAnchor],
  'nodered_subscription_booking_nodes/fn_subscription_booking_router.js': [legacyAnchor, legacyGuard + legacyAnchor],
};

export function restoreSourceBeforeChildTournamentGuard(source, relative) {
  const patch = Object.hasOwn(gatewayPatches, relative) ? gatewayPatches[relative] : null;
  return patch && source.split(patch[1]).length === 2
    ? uniqueReplace(source, patch[1], patch[0])
    : source;
}

export function composeChildTournamentOneTimeRelease(liveBytes, {
  release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(release || '')
    || [expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256].some(v => !/^[a-f0-9]{64}$/.test(v || ''))
    || sha(liveBytes) !== expectedSourceSha256) throw Error('Exact child tournament flow preimage required');

  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(node => typeof node?.id !== 'string')
    || new Set(flow.map(node => node.id)).size !== flow.length) throw Error('Invalid Node-RED flow');

  const activeFunction = (id, expectedSha256) => {
    const node = flow.find(node => node.id === id);
    const tab = flow.find(tab => tab.id === node?.z && tab.type === 'tab');
    if (node?.type !== 'function' || node.d === true || node.disabled === true
      || !tab || tab.disabled === true || sha(node.func || '') !== expectedSha256) {
      throw Error('Child tournament router preimage mismatch: ' + id);
    }
    return node;
  };
  const booking = activeFunction(bookingId, expectedBookingSha256);
  const preview = activeFunction(previewId, expectedPreviewSha256);
  const bookingOriginal = booking.func;
  const previewOriginal = preview.func;
  if (bookingOriginal.includes('CHILD_TOURNAMENT_SUBSCRIPTION_UNAVAILABLE')
    || previewOriginal.includes(updatedPreview)) throw Error('Child tournament guard already present');

  for (const [source, [before, after]] of Object.entries(gatewayPatches)) {
    if (read('./' + source).split(after).length !== 2) throw Error('Child tournament booking source drift: ' + source);
    booking.func = uniqueReplace(booking.func, before, after);
  }
  if (read('./nodered_subscription_price_preview_nodes/router.js').split(updatedPreview).length !== 2
    || !previewOriginal.includes('const previewDirectionId =')
    || !bookingOriginal.includes('const exerciseDirectionId =')) throw Error('Child tournament direction resolver drift');
  preview.func = uniqueReplace(previewOriginal, originalPreview, updatedPreview);

  const recoveredBooking = Object.values(gatewayPatches)
    .reduce((body, [before, after]) => uniqueReplace(body, after, before), booking.func);
  if (recoveredBooking !== bookingOriginal || uniqueReplace(preview.func, updatedPreview, originalPreview) !== previewOriginal) {
    throw Error('Child tournament inverse does not restore the exact function bodies');
  }
  new Function(booking.func);
  new Function(preview.func);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = [bookingId, previewId].map(id => ({ id, fields: ['func'] }));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'child-tournament-one-time',
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: {
    sourceCommit: release, sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes),
    changedNodeIds: [bookingId, previewId], changedFields: ['func'],
    exactInverseVerified: true, liveMutationPerformed: false,
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('Clean release checkout required');
  assertPrivatePaginationOutput(repository, verified.workspace, directory);
  const packet = composeChildTournamentOneTimeRelease(fs.readFileSync(verified.sourcePath), {
    release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256,
  });
  for (const [file, data] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2)], ['report.json', JSON.stringify(packet.report, null, 2)]]) {
    fs.writeFileSync(path.join(directory, file), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
