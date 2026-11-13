import { isDeepStrictEqual } from 'node:util';
import {
  sha256, nodeSha256,
} from './nodered_max_outbox_resume.mjs';
import { buildMaxDurableTransition, durableOperations } from './nodered_max_durable_release.mjs';
import { MAX_DURABLE_QUEUE_REQUIRED_IDS } from './prepare_max_durable_queue.mjs';

// Exact 13-file closure from lk1_unpaid_cancel_service/build_bundle.mjs and
// verify_bundle.mjs. Kept data-only here: importing the verifier runs filesystem
// checks at module load. A regression test checks agreement with its file list.
export const MAX_DURABLE_WORKER_BASELINE_FILES = Object.freeze([
  'launch_lk1_unpaid_booking_cancellation.mjs',
  'run_lk1_unpaid_booking_cancellation.mjs',
  'lib/lk1UnpaidBookingCancellation.mjs',
  'lib/lk1VivaServiceToken.mjs',
  'lib/lk1LiveGatewayGuard.mjs',
  'lib/lk1FlowReadTokenAuth.cjs',
  'lib/lk1UnpaidScanCursor.mjs',
  'lib/lk1FreeCancellation.mjs',
  'lib/lk1FreeCancellationWorker.mjs',
  'package.json',
  'package-lock.json',
  'lk1-unpaid-cancel.service',
  'verify_bundle.mjs',
]);
const GUARD = 'lib/lk1LiveGatewayGuard.mjs';
const GATEWAY = 'lk_subscription_booking_router_20260804';
const need = (ok, code) => { if (!ok) throw new Error(code); };
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const keysEqual = (keys, expected) => isDeepStrictEqual([...keys].sort(), [...expected].sort());
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = (value) => typeof value === 'string'
  && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/.test(value);

function constant(text, name) {
  const declarations = [...text.matchAll(new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`, 'gm'))];
  const exact = [...text.matchAll(new RegExp(`^export const ${name} = '([a-f0-9]{64})';\\r?$`, 'gm'))];
  need(declarations.length === 1 && exact.length === 1, 'GUARD_CONSTANT_SHAPE_INVALID');
  return { hash: exact[0][1], line: exact[0][0], offset: exact[0].index };
}

/** Derive a new immutable worker bundle in memory; never installs or starts it. */
export function buildMaxDurableWorkerRebind({
  beforeFlow, trustedNrPins, baselineManifestBytes, baselineFiles, purpose = 'forward',
  trustedBaseline, publishingSourceCommit,
} = {}) {
  need(['forward', 'paused-recovery'].includes(purpose), 'WORKER_PURPOSE_INVALID');
  need((Buffer.isBuffer(beforeFlow) || typeof beforeFlow === 'string')
    && Buffer.isBuffer(baselineManifestBytes), 'RAW_BASELINE_BYTES_REQUIRED');
  need(object(trustedBaseline) && digest(trustedBaseline.manifestSha256)
    && digest(trustedBaseline.guardSha256) && commit(trustedBaseline.sourceCommit), 'BASELINE_PINS_INVALID');
  need(commit(publishingSourceCommit)
    && publishingSourceCommit !== trustedBaseline.sourceCommit, 'PUBLISHING_COMMIT_INVALID');
  need(sha256(baselineManifestBytes) === trustedBaseline.manifestSha256, 'BASELINE_MANIFEST_MISMATCH');
  const manifest = JSON.parse(baselineManifestBytes.toString('utf8'));
  need(object(manifest) && keysEqual(Object.keys(manifest), ['schema', 'sourceCommit', 'files'])
    && manifest.schema === 1 && object(manifest.files), 'BASELINE_MANIFEST_SHAPE_INVALID');
  need(manifest.sourceCommit === trustedBaseline.sourceCommit, 'BASELINE_SOURCE_MISMATCH');
  need(Object.keys(manifest.files).every(safePath)
    && keysEqual(Object.keys(manifest.files), MAX_DURABLE_WORKER_BASELINE_FILES), 'BASELINE_MANIFEST_FILESET_INVALID');
  need(baselineFiles instanceof Map && [...baselineFiles.keys()].every(safePath)
    && keysEqual(baselineFiles.keys(), MAX_DURABLE_WORKER_BASELINE_FILES), 'BASELINE_FILESET_INVALID');
  for (const file of MAX_DURABLE_WORKER_BASELINE_FILES) {
    need(Buffer.isBuffer(baselineFiles.get(file)) && digest(manifest.files[file])
      && sha256(baselineFiles.get(file)) === manifest.files[file], 'BASELINE_FILE_DIGEST_MISMATCH');
  }
  const oldGuard = baselineFiles.get(GUARD);
  need(sha256(oldGuard) === trustedBaseline.guardSha256, 'BASELINE_GUARD_MISMATCH');
  const guardText = oldGuard.toString('utf8');
  need(Buffer.from(guardText, 'utf8').equals(oldGuard), 'GUARD_UTF8_INVALID');
  const flowConstant = constant(guardText, 'LK1_UNPAID_FLOW_SHA256');
  const gatewayConstant = constant(guardText, 'LK1_UNPAID_GATEWAY_SHA256');

  // The installed baseline binds the ACTIVE source. Prove the exact pause and
  // paused-to-v1 transition before deriving either native worker generation.
  const before = JSON.parse(beforeFlow.toString());
  const pause = buildMaxDurableTransition(beforeFlow, trustedNrPins, 'pause');
  durableOperations(before, pause.flow, 'pause');
  const pausedRaw = JSON.stringify(pause.flow, null, 4);
  const pausedPins = { flowSha256: sha256(pausedRaw), nodeSha256: Object.fromEntries(
    MAX_DURABLE_QUEUE_REQUIRED_IDS.map(id => [id, nodeSha256(pause.flow.find(n => n.id === id))])) };
  const resume = buildMaxDurableTransition(pausedRaw, pausedPins, 'activate');
  durableOperations(pause.flow, resume.flow, 'activate');
  need(flowConstant.hash === sha256(beforeFlow), 'BASELINE_FLOW_BINDING_MISMATCH');
  const gateway = before.find((node) => node.id === GATEWAY);
  const gatewayTab = before.find((node) => node.id === gateway?.z);
  need(gateway?.type === 'function' && typeof gateway.func === 'string'
    && gateway.d !== true && gatewayTab?.type === 'tab'
    && gatewayTab.disabled !== true && gatewayTab.d !== true,
  'GATEWAY_SHAPE_INVALID');
  const gatewaySha256 = sha256(gateway.func);
  need(gatewayConstant.hash === gatewaySha256, 'BASELINE_GATEWAY_BINDING_MISMATCH');
  need(isDeepStrictEqual(gateway, resume.flow.find((node) => node.id === GATEWAY))
    && isDeepStrictEqual(gateway, pause.flow.find(node => node.id === GATEWAY)), 'GATEWAY_CHANGED');
  // Node-RED 4.0.9 pretty storage uses four spaces and no trailing newline.
  const nativeDiskSha256 = sha256(purpose === 'forward' ? JSON.stringify(resume.flow, null, 4) : pausedRaw);
  need(nativeDiskSha256 !== flowConstant.hash, 'FLOW_BINDING_UNCHANGED');
  const offset = Buffer.byteLength(guardText.slice(0, flowConstant.offset), 'utf8')
    + Buffer.from(flowConstant.line, 'utf8').indexOf(flowConstant.hash);
  const candidateGuard = Buffer.concat([
    oldGuard.subarray(0, offset), Buffer.from(nativeDiskSha256, 'ascii'), oldGuard.subarray(offset + 64),
  ]);
  need(candidateGuard.length === oldGuard.length
    && Buffer.concat([candidateGuard.subarray(0, offset), Buffer.from(flowConstant.hash, 'ascii'),
      candidateGuard.subarray(offset + 64)]).equals(oldGuard), 'GUARD_INVERSE_MISMATCH');

  // Copy buffers as well as the Map: no candidate mutation can alter the inputs.
  const candidateFiles = new Map(MAX_DURABLE_WORKER_BASELINE_FILES.map((file) => [file,
    file === GUARD ? candidateGuard : Buffer.from(baselineFiles.get(file)),
  ]));
  const changedFiles = MAX_DURABLE_WORKER_BASELINE_FILES.filter((file) =>
    !candidateFiles.get(file).equals(baselineFiles.get(file)));
  need(isDeepStrictEqual(changedFiles, [GUARD]), 'WORKER_FILE_DELTA_INVALID');
  const candidateManifest = {
    schema: 1, sourceCommit: publishingSourceCommit,
    files: Object.fromEntries(MAX_DURABLE_WORKER_BASELINE_FILES.map((file) => [file, sha256(candidateFiles.get(file))])),
  };
  const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidateManifest, null, 2)}\n`);
  return {
    candidateFiles, candidateManifest, candidateManifestBytes,
    candidateManifestSha256: sha256(candidateManifestBytes),
    provenance: {
      schema: 'PHAB_MAX_DURABLE_WORKER_REBIND_V1', purpose,
      baselineSourceCommit: trustedBaseline.sourceCommit,
      baselineManifestSha256: trustedBaseline.manifestSha256,
      baselineGuardSha256: trustedBaseline.guardSha256,
      publishingSourceCommit, beforeFlowSha256: sha256(beforeFlow), pausedNativeDiskSha256: sha256(pausedRaw), nativeDiskSha256,
      gatewayId: GATEWAY, gatewaySha256, gatewayUnchanged: true,
      changedFiles, unchangedFileCount: candidateFiles.size - 1,
      flowPausedIds: [...pause.changedIds], flowChangedIds: [...resume.changedIds], flowAddedIds: [...resume.addedIds],
    },
  };
}

