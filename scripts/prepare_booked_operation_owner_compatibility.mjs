import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { OWNER_SOURCE_SHA256, OWNER_UNITS, graftOwnerFunctions, hash } from './lib/bookedOperationOwnerCompatibility.mjs';
import { assertFlowArray, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { buildReceiverCandidate } from './patch_nodered_booked_operation_receiver_flow.mjs';
import { buildOwnerCapabilityGetNode, OWNER_CAPABILITY_GET_ID } from './lib/subscriptionBookingOwnerProbe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS = 'lk_subscription_booking_options_20260804';
const ROUTER = OWNER_UNITS[0][1];
const CLOSURE = [
  'scripts/prepare_booked_operation_owner_compatibility.mjs',
  'scripts/lib/bookedOperationOwnerCompatibility.mjs',
  'scripts/lib/subscriptionBookingOwnerProbe.mjs',
  'scripts/verify_nodered_source_origin.mjs', 'scripts/lib/release-provenance.mjs',
  'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'scripts/patch_nodered_booked_operation_receiver_flow.mjs',
  'package.json', 'package-lock.json',
  ...OWNER_UNITS.map(row => 'scripts/nodered_subscription_booking_nodes/' + row[2]),
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_options.js',
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js',
  ...fs.readdirSync(path.join(ROOT, 'scripts/nodered_booked_operation_receiver_nodes'))
    .filter(file => file.endsWith('.js')).sort().map(file => 'scripts/nodered_booked_operation_receiver_nodes/' + file),
];

export function composeOwnerCompatibility(liveBytes, deploymentId) {
  if (hash(liveBytes) !== OWNER_SOURCE_SHA256) throw new Error('Owner whole-flow preimage drift');
  const flow = JSON.parse(liveBytes.toString());
  assertFlowArray(flow);
  const router = flow.find(node => node.id === ROUTER);
  if (router.outputs !== 8 || !isDeepStrictEqual(router.wires, [
    ['lk_subscription_booking_http_20260804'], ['lk_subscription_booking_find_20260804'],
    ['lk_subscription_booking_insert_20260804'], ['lk_subscription_booking_update_20260804'],
    ['lk_subscription_booking_finalize_20260804'], ['lk_subscription_booking_debug_20260804'],
    ['lk_subscription_managed_policy_20260820'], ['lk_subscription_product_router_20260907'],
  ])) throw new Error('Installed product continuation topology drift');
  const { candidate, reports } = graftOwnerFunctions(flow);
  const nextRouter = candidate.find(node => node.id === ROUTER);
  const prefix = fs.readFileSync(path.join(ROOT,
    'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js'), 'utf8');
  nextRouter.func = prefix + nextRouter.func;
  const options = candidate.find(node => node.id === OPTIONS);
  if (options?.type !== 'function' || options.outputs !== 1
    || hash(options.func) !== 'fec610c6edf685732d0fdf24f007327829fbf7f87d64598d81b6b9e613d2d2df'
    || !isDeepStrictEqual(options.wires, [['lk_subscription_booking_options_response_20260804']])) {
    throw new Error('Installed owner OPTIONS preimage drift');
  }
  options.func = fs.readFileSync(path.join(ROOT,
    'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_options.js'), 'utf8');
  options.outputs = 2;
  options.wires = [['lk_subscription_booking_options_response_20260804'], [ROUTER]];
  if (options.z !== nextRouter.z || !candidate.some(node => node.type === 'http in'
    && node.method === 'post' && node.url === '/lk/subscription-bookings'
    && node.z === nextRouter.z)) throw new Error('Owner capability target topology drift');
  if (candidate.some(node => node.id === OWNER_CAPABILITY_GET_ID || (node.type === 'http in'
    && node.method === 'get' && node.url === '/lk/subscription-bookings'))) {
    throw new Error('Owner capability GET route already exists');
  }
  candidate.push(buildOwnerCapabilityGetNode(nextRouter.z));
  new Function('msg', 'global', 'node', 'env', nextRouter.func);
  new Function('msg', options.func);
  const allowedChanges = OWNER_UNITS.map(row => ({ id: row[1], fields: ['func'] }));
  allowedChanges.push({ id: OPTIONS, fields: ['func', 'outputs', 'wires'] });
  // Owner and receiver form one reviewed graph. No sequential partial imports.
  const receiver = buildReceiverCandidate(candidate);
  const candidateBytes = Buffer.from(JSON.stringify(receiver.candidate, null, 2) + '\n');
  const originalIds = new Set(flow.map(node => node.id));
  const allowedAdditionIds = receiver.candidate.filter(node => !originalIds.has(node.id)).map(node => node.id);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate: receiver.candidate, candidateBytes, contract, reports, receiver: receiver.report };
}

function provenance() {
  const identity = readRepositoryProvenance(ROOT);
  if (identity.sourceDirty) throw new Error('Commit the exact owner candidate source before packet generation');
  return { ...identity, sourceFiles: Object.fromEntries(CLOSURE.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file)))])) };
}

export function prepareOwnerCompatibility(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const source = provenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (hash(liveBytes) !== verified.sourceSha256) throw new Error('Verified owner source changed');
  const packet = composeOwnerCompatibility(liveBytes, 'booked-operation-owner-' + source.sourceCommit.slice(0, 12));
  if (!isDeepStrictEqual(source, provenance())) throw new Error('Owner source changed during composition');
  const report = { ...source, sourceSha256: hash(liveBytes), candidateSha256: hash(packet.candidateBytes),
    contractKind: 'exact-graph', nodeCount: packet.candidate.length,
    routerOutputs: 8, productContinuationPreserved: true,
    receiver: packet.receiver,
    protectedStatements: packet.reports.reduce((total, row) => total + row.protectedStatements, 0),
    changed: packet.reports.map(row => ({ ...row,
      candidateSha256: hash(packet.candidate.find(node => node.id === row.id).func) })),
    ownerCapabilityMethod: 'GET', ownerCapabilityAdditions: 1,
    receiverNodesAdded: packet.receiver.invariants.addedNodeCount, receiverTabsAdded: 1,
    allAdditionsInReceiverTab: false,
    sourceOnly: true, activationAuthorized: false,
    imported: false, providerWritesPerformed: false };
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2) + '\n'],
    ['report.json', JSON.stringify(report, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: <fresh-private-live-workspace> <new-private-output-directory>');
    console.log(JSON.stringify(prepareOwnerCompatibility(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
