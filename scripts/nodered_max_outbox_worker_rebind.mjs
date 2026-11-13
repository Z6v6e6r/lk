import { isDeepStrictEqual } from 'node:util';
import {
  buildMaxOutboxOnlyResume, MAX_OUTBOX_RESUME_TOPOLOGY, sha256,
} from './nodered_max_outbox_resume.mjs';

// Exact 13-file closure from lk1_unpaid_cancel_service/build_bundle.mjs and
// verify_bundle.mjs. Kept data-only here: importing the verifier runs filesystem
// checks at module load. A regression test checks agreement with its file list.
export const MAX_OUTBOX_WORKER_BASELINE_FILES = Object.freeze([
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

function exactMaxDelta(before, after) {
  const expected = structuredClone(before);
  const by = new Map(expected.map((node) => [node.id, node]));
  for (const route of MAX_OUTBOX_RESUME_TOPOLOGY) {
    by.get(route.poller).d = false;
    by.get(route.dispatch).wires[0] = [route.newSender];
    expected.push({ ...structuredClone(by.get(route.sender)), id: route.newSender,
      name: route.newName, d: false });
  }
  need(isDeepStrictEqual(after, expected), 'MAX_DELTA_NOT_EXACT');
}

/** Derive a new immutable worker bundle in memory; never installs or starts it. */
export function buildMaxOutboxWorkerRebind({
  beforeFlow, trustedNrPins, baselineManifestBytes, baselineFiles,
  trustedBaseline, publishingSourceCommit,
} = {}) {
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
    && keysEqual(Object.keys(manifest.files), MAX_OUTBOX_WORKER_BASELINE_FILES), 'BASELINE_MANIFEST_FILESET_INVALID');
  need(baselineFiles instanceof Map && [...baselineFiles.keys()].every(safePath)
    && keysEqual(baselineFiles.keys(), MAX_OUTBOX_WORKER_BASELINE_FILES), 'BASELINE_FILESET_INVALID');
  for (const file of MAX_OUTBOX_WORKER_BASELINE_FILES) {
    need(Buffer.isBuffer(baselineFiles.get(file)) && digest(manifest.files[file])
      && sha256(baselineFiles.get(file)) === manifest.files[file], 'BASELINE_FILE_DIGEST_MISMATCH');
  }
  const oldGuard = baselineFiles.get(GUARD);
  need(sha256(oldGuard) === trustedBaseline.guardSha256, 'BASELINE_GUARD_MISMATCH');
  const guardText = oldGuard.toString('utf8');
  need(Buffer.from(guardText, 'utf8').equals(oldGuard), 'GUARD_UTF8_INVALID');
  const flowConstant = constant(guardText, 'LK1_UNPAID_FLOW_SHA256');
  const gatewayConstant = constant(guardText, 'LK1_UNPAID_GATEWAY_SHA256');

  // The sole candidate comes from the independently pinned, bounded MAX patcher.
  const resume = buildMaxOutboxOnlyResume(beforeFlow, trustedNrPins);
  const before = JSON.parse(beforeFlow.toString());
  exactMaxDelta(before, resume.flow);
  need(flowConstant.hash === resume.sourceSha256, 'BASELINE_FLOW_BINDING_MISMATCH');
  const gateway = before.find((node) => node.id === GATEWAY);
  const gatewayTab = before.find((node) => node.id === gateway?.z);
  need(gateway?.type === 'function' && typeof gateway.func === 'string'
    && gateway.d !== true && gatewayTab?.type === 'tab'
    && gatewayTab.disabled !== true && gatewayTab.d !== true,
  'GATEWAY_SHAPE_INVALID');
  const gatewaySha256 = sha256(gateway.func);
  need(gatewayConstant.hash === gatewaySha256, 'BASELINE_GATEWAY_BINDING_MISMATCH');
  need(isDeepStrictEqual(gateway, resume.flow.find((node) => node.id === GATEWAY)), 'GATEWAY_CHANGED');
  // Node-RED 4.0.9 pretty storage uses four spaces and no trailing newline.
  const nativeDiskSha256 = sha256(JSON.stringify(resume.flow, null, 4));
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
  const candidateFiles = new Map(MAX_OUTBOX_WORKER_BASELINE_FILES.map((file) => [file,
    file === GUARD ? candidateGuard : Buffer.from(baselineFiles.get(file)),
  ]));
  const changedFiles = MAX_OUTBOX_WORKER_BASELINE_FILES.filter((file) =>
    !candidateFiles.get(file).equals(baselineFiles.get(file)));
  need(isDeepStrictEqual(changedFiles, [GUARD]), 'WORKER_FILE_DELTA_INVALID');
  const candidateManifest = {
    schema: 1, sourceCommit: publishingSourceCommit,
    files: Object.fromEntries(MAX_OUTBOX_WORKER_BASELINE_FILES.map((file) => [file, sha256(candidateFiles.get(file))])),
  };
  const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidateManifest, null, 2)}\n`);
  return {
    candidateFiles, candidateManifest, candidateManifestBytes,
    candidateManifestSha256: sha256(candidateManifestBytes),
    provenance: {
      schema: 'PHAB_MAX_OUTBOX_WORKER_REBIND_V1',
      baselineSourceCommit: trustedBaseline.sourceCommit,
      baselineManifestSha256: trustedBaseline.manifestSha256,
      baselineGuardSha256: trustedBaseline.guardSha256,
      publishingSourceCommit, beforeFlowSha256: resume.sourceSha256, nativeDiskSha256,
      gatewayId: GATEWAY, gatewaySha256, gatewayUnchanged: true,
      changedFiles, unchangedFileCount: candidateFiles.size - 1,
      flowChangedIds: [...resume.changedIds], flowAddedIds: [...resume.addedIds],
    },
  };
}

/** The native inverse restores the original graph using the native encoder;
 * its disk bytes need not equal an earlier full-runtime installer's bytes. */
export function buildMaxOutboxWorkerInverse(options) {
  // Reuse every baseline/closure/gateway/MAX-delta guard before deriving either
  // generation. No caller-supplied target digest or installed pin is accepted.
  const forward = buildMaxOutboxWorkerRebind(options);
  const nativeDiskSha256 = sha256(JSON.stringify(JSON.parse(options.beforeFlow.toString()), null, 4));
  const guard = forward.candidateFiles.get(GUARD), text = guard.toString('utf8');
  const bound = constant(text, 'LK1_UNPAID_FLOW_SHA256');
  need(bound.hash === forward.provenance.nativeDiskSha256, 'INVERSE_FORWARD_BINDING_MISMATCH');
  const offset = Buffer.byteLength(text.slice(0, bound.offset), 'utf8')
    + Buffer.from(bound.line, 'utf8').indexOf(bound.hash);
  const candidateFiles = new Map([...forward.candidateFiles].map(([file, bytes]) => [file, Buffer.from(bytes)]));
  candidateFiles.set(GUARD, Buffer.concat([guard.subarray(0, offset),
    Buffer.from(nativeDiskSha256, 'ascii'), guard.subarray(offset + 64)]));
  const changedFiles = MAX_OUTBOX_WORKER_BASELINE_FILES.filter(file => !candidateFiles.get(file).equals(options.baselineFiles.get(file)));
  need(changedFiles.every(file => file === GUARD), 'INVERSE_WORKER_FILE_DELTA_INVALID');
  const candidateManifest = { schema: 1, sourceCommit: options.publishingSourceCommit,
    files: Object.fromEntries([...candidateFiles].map(([file, bytes]) => [file, sha256(bytes)])) };
  const candidateManifestBytes = Buffer.from(`${JSON.stringify(candidateManifest, null, 2)}\n`);
  return { candidateFiles, candidateManifest, candidateManifestBytes,
    candidateManifestSha256: sha256(candidateManifestBytes),
    provenance: { ...forward.provenance, schema: 'PHAB_MAX_OUTBOX_WORKER_NATIVE_INVERSE_V1',
      forwardNativeDiskSha256: forward.provenance.nativeDiskSha256, nativeDiskSha256,
      changedFiles, unchangedFileCount: candidateFiles.size - changedFiles.length,
      flowAddedIds: [], flowRemovedIds: [...forward.provenance.flowAddedIds] } };
}
