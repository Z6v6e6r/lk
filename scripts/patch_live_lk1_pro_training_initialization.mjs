import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeProTrainingBeforeSteps } from './lib/proTrainingInitialization.mjs';
import { verifyWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const BOOKING_ID = 'lk_subscription_booking_router_20260804';
export const DEPLOYMENT_ID = 'lk1-pro-training-initialization-20261002';
export const TARGET = Object.freeze({
  source: '0dacc3d0264a1d243b163996ef13939ef523e69a44b8f2cfe60729547570e268',
  nodeCount: 4804,
  booking: 'f97b4b2ec40db022257571a0b69f82bc5236ea96013719708cb0d076d7197bb9',
  patchedBooking: '802529aca772e3343d53971d40f8040fbf99ce8764c9aa3b12c06d8717f281e5',
});
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Offline preparation only. The reviewed deployment helper independently checks
// the source hash, exact graph, lock/lease and foreign changes at real apply.
export function compose(raw) {
  if (sha256(raw) !== TARGET.source) throw new Error('PRO initialization live source drift');
  const flow = JSON.parse(raw);
  assertFlowArray(flow, 'PRO initialization source');
  if (flow.length !== TARGET.nodeCount) throw new Error('PRO initialization node count drift');
  const booking = flow.find(node => node.id === BOOKING_ID);
  if (booking?.type !== 'function' || booking.d === true || booking.disabled === true
    || sha256(booking.func || '') !== TARGET.booking) throw new Error('PRO initialization booking preimage drift');
  booking.func = initializeProTrainingBeforeSteps(booking.func);
  if (sha256(booking.func) !== TARGET.patchedBooking) throw new Error('PRO initialization postimage drift');
  const candidate = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: candidate, deploymentId: DEPLOYMENT_ID,
    allowedChanges: [{ id: BOOKING_ID, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: candidate, contract, deploymentId: DEPLOYMENT_ID });
  return { candidate, contract };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, workspace, outputFlag, output] = process.argv.slice(2);
  if (process.argv.length !== 6 || flag !== '--workspace' || outputFlag !== '--output'
    || !output || output !== path.resolve(output) || !output.startsWith('/private/tmp/')
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error('Usage: --workspace /absolute/private/live-workspace --output /private/tmp/new-output-directory');
  }
  const verified = verifyWorkspace(workspace, { quiet: true });
  const raw = fs.readFileSync(verified.sourcePath);
  const result = compose(raw);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(output + '/candidate.flow.json', result.candidate, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(output + '/contract.json', JSON.stringify(result.contract, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: TARGET.source, candidateSha256: sha256(result.candidate),
    bookingSha256: TARGET.patchedBooking, changedNodeCount: 1, addedNodeCount: 0, liveMutationAuthorized: false }));
}
