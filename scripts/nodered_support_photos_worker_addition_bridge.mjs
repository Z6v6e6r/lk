import { isDeepStrictEqual } from 'node:util';
import { validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { sha256 } from './nodered_max_outbox_resume.mjs';
import { buildSupportPhotoStates, photoPins } from './nodered_support_photos_release.mjs';
import { buildSupportPhotosWorkerRebind, SUPPORT_PHOTO_WORKER_BASELINE_FILES } from './nodered_support_photos_worker_rebind.mjs';

const GUARD = 'lib/lk1LiveGatewayGuard.mjs';
const GATEWAY = 'lk_subscription_booking_router_20260804';
const need = (value, code) => { if (!value) throw Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

function nativeFlow(raw) {
  need(Buffer.isBuffer(raw), 'ADDITION_BRIDGE_RAW_BYTES_REQUIRED');
  const flow = JSON.parse(raw.toString('utf8'));
  need(Array.isArray(flow) && flow.length > 0
    && (Buffer.from(JSON.stringify(flow, null, 4)).equals(raw)
      || Buffer.from(JSON.stringify(flow, null, 2) + '\n').equals(raw)), 'ADDITION_BRIDGE_NATIVE_ENCODING');
  const ids = flow.map(node => node?.id);
  need(ids.every(id => typeof id === 'string' && id.length > 0)
    && new Set(ids).size === ids.length, 'ADDITION_BRIDGE_NODE_IDS');
  return flow;
}

/** Pure, composed derivation. No intermediate manifest is represented as installed
 * or as the unchanged historical source. The original 13-file baseline remains
 * the only baseline for both final photo generations. */
export function buildSupportPhotosWorkerFromReviewedAdditions({
  originalBeforeFlow, beforeFlow, originalPins, baselineManifestBytes, baselineFiles,
  trustedBaseline, publishingSourceCommit, purpose = 'forward',
  ownerContractBytes, trustedForeign,
} = {}) {
  need(keys(trustedForeign, ['contractSha256', 'sourceFlowSha256',
    'candidateFlowSha256', 'deploymentId', 'additionCount'])
    && ['contractSha256', 'sourceFlowSha256', 'candidateFlowSha256']
      .every(key => digest(trustedForeign[key]))
    && /^[a-z0-9-]{2,64}$/.test(trustedForeign.deploymentId)
    && Number.isSafeInteger(trustedForeign.additionCount)
    && trustedForeign.additionCount > 0, 'ADDITION_BRIDGE_TRUST_PINS');
  need(Buffer.isBuffer(ownerContractBytes)
    && sha256(ownerContractBytes) === trustedForeign.contractSha256, 'ADDITION_BRIDGE_EVIDENCE_DIGEST');
  const original = nativeFlow(originalBeforeFlow), before = nativeFlow(beforeFlow);
  need(sha256(originalBeforeFlow) === trustedForeign.sourceFlowSha256
    && sha256(beforeFlow) === trustedForeign.candidateFlowSha256, 'ADDITION_BRIDGE_FLOW_DIGEST');
  const contract = JSON.parse(ownerContractBytes.toString('utf8'));
  need(Buffer.from(JSON.stringify(contract, null, 2) + '\n').equals(ownerContractBytes),
    'ADDITION_BRIDGE_CONTRACT_ENCODING');
  validateExactGraphContract({ liveBytes: originalBeforeFlow, candidateBytes: beforeFlow, contract });
  need(contract.deploymentId === trustedForeign.deploymentId && contract.allowedChanges.length === 0
    && contract.allowedAdditions.length === trustedForeign.additionCount, 'ADDITION_BRIDGE_CONTRACT_SCOPE');
  const oldIds = new Set(original.map(node => node.id));
  need(isDeepStrictEqual(before.filter(node => oldIds.has(node.id)), original),
    'ADDITION_BRIDGE_OLD_NODES_CHANGED');
  const additions = before.filter(node => !oldIds.has(node.id));
  need(additions.length === trustedForeign.additionCount, 'ADDITION_BRIDGE_ADDITIONS_CHANGED');
  const oldTabs = new Set(original.filter(node => node.type === 'tab').map(node => node.id));
  need(additions.every(node => !oldTabs.has(node.z)
    && !(node.wires || []).flat().some(id => oldIds.has(id))
    && !(node.links || []).some(id => oldIds.has(id))), 'ADDITION_BRIDGE_ACTIVE_EDGE');

  // Reuse every original baseline/source/UTF-8/constant/gateway/scope guard.
  // This in-memory validation result is deliberately not published or installed.
  buildSupportPhotosWorkerRebind({ beforeFlow: originalBeforeFlow,
    originalPins: photoPins(originalBeforeFlow), baselineManifestBytes, baselineFiles,
    trustedBaseline, publishingSourceCommit, purpose });
  const states = buildSupportPhotoStates(beforeFlow, originalPins);
  const gateway = original.find(node => node.id === GATEWAY);
  need(isDeepStrictEqual(gateway, before.find(node => node.id === GATEWAY))
    && isDeepStrictEqual(gateway, states.originalPaused.find(node => node.id === GATEWAY))
    && isDeepStrictEqual(gateway, states.photoActive.find(node => node.id === GATEWAY)), 'ADDITION_BRIDGE_GATEWAY_CHANGED');
  for (const flow of [states.originalPaused, states.photoPaused, states.photoActive]) {
    need(additions.every(node => isDeepStrictEqual(node, flow.find(next => next.id === node.id))),
      'ADDITION_BRIDGE_FOREIGN_NODE_CHANGED');
  }
  const pausedNativeDiskSha256 = sha256(JSON.stringify(states.originalPaused, null, 4));
  const nativeDiskSha256 = purpose === 'forward'
    ? sha256(JSON.stringify(states.photoActive, null, 4)) : pausedNativeDiskSha256;
  const oldGuard = baselineFiles.get(GUARD), text = oldGuard.toString('utf8');
  const declaration = [...text.matchAll(/^export const LK1_UNPAID_FLOW_SHA256 = '([a-f0-9]{64})';\r?$/gm)];
  need(declaration.length === 1 && declaration[0][1] === sha256(originalBeforeFlow), 'ADDITION_BRIDGE_GUARD_BINDING');
  const offset = Buffer.byteLength(text.slice(0, declaration[0].index), 'utf8')
    + declaration[0][0].indexOf(declaration[0][1]);
  const guard = Buffer.concat([oldGuard.subarray(0, offset), Buffer.from(nativeDiskSha256, 'ascii'), oldGuard.subarray(offset + 64)]);
  need(guard.length === oldGuard.length && Buffer.concat([guard.subarray(0, offset),
    Buffer.from(declaration[0][1], 'ascii'), guard.subarray(offset + 64)]).equals(oldGuard), 'ADDITION_BRIDGE_GUARD_INVERSE');
  const candidateFiles = new Map(SUPPORT_PHOTO_WORKER_BASELINE_FILES.map(name => [name,
    Buffer.from(name === GUARD ? guard : baselineFiles.get(name))]));
  const candidateManifest = { schema: 1, sourceCommit: publishingSourceCommit,
    files: Object.fromEntries([...candidateFiles].map(([name, bytes]) => [name, sha256(bytes)])) };
  const candidateManifestBytes = Buffer.from(JSON.stringify(candidateManifest, null, 2) + '\n');
  return { candidateFiles, candidateManifest, candidateManifestBytes,
    candidateManifestSha256: sha256(candidateManifestBytes),
    provenance: {
      schema: 'PHAB_SUPPORT_PHOTOS_COMPOSED_WORKER_REBIND_V1', purpose,
      baselineSourceCommit: trustedBaseline.sourceCommit,
      baselineManifestSha256: trustedBaseline.manifestSha256,
      baselineGuardSha256: trustedBaseline.guardSha256,
      publishingSourceCommit, originalBeforeFlowSha256: sha256(originalBeforeFlow),
      beforeFlowSha256: sha256(beforeFlow), nativeDiskSha256, pausedNativeDiskSha256,
      ownerContractSha256: trustedForeign.contractSha256,
      foreignDeploymentId: trustedForeign.deploymentId, preservedAdditionCount: additions.length,
      gatewayId: GATEWAY, gatewaySha256: sha256(gateway.func), gatewayUnchanged: true,
      changedFiles: [GUARD], unchangedFileCount: candidateFiles.size - 1,
    } };
}
