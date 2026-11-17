import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExactGraphContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { sha256 } from '../nodered_max_outbox_resume.mjs';
import { buildSupportPhotoStates, photoPins } from '../nodered_support_photos_release.mjs';
import { buildSupportPhotosWorkerRebind, SUPPORT_PHOTO_WORKER_BASELINE_FILES as files } from '../nodered_support_photos_worker_rebind.mjs';
import { buildSupportPhotosWorkerFromReviewedAdditions as build } from '../nodered_support_photos_worker_addition_bridge.mjs';
import { supportPhotoFixture } from './fixtures/support-photos-release.mjs';

const GUARD = 'lib/lk1LiveGatewayGuard.mjs', GATEWAY = 'lk_subscription_booking_router_20260804';
const native = flow => Buffer.from(JSON.stringify(flow, null, 4));
function baseline(input) {
  input.baselineManifestBytes = Buffer.from(JSON.stringify({ schema: 1, sourceCommit: input.trustedBaseline.sourceCommit,
    files: Object.fromEntries([...input.baselineFiles].map(([name, bytes]) => [name, sha256(bytes)])) }) + '\n');
  input.trustedBaseline.manifestSha256 = sha256(input.baselineManifestBytes);
  input.trustedBaseline.guardSha256 = sha256(input.baselineFiles.get(GUARD));
}
function owner(input, contract) {
  input.ownerContractBytes = Buffer.from(JSON.stringify(contract, null, 2) + '\n');
  input.trustedForeign.contractSha256 = sha256(input.ownerContractBytes);
}
function fixture() {
  const original = supportPhotoFixture();original.find(node => node.id === GATEWAY).func = 'return msg;';
  const originalBeforeFlow = native(original);
  const additions = [{ id: 'foreign-tab', type: 'tab', disabled: false },
    { id: 'foreign-function', z: 'foreign-tab', type: 'function', func: 'return msg;',
      initialize: 'global.set("synthetic-foreign", true);', wires: [], clientNode: GATEWAY },
    { id: 'foreign-config', type: 'synthetic-config', clientNode: 'unrelated' }];
  const beforeFlow = native([...original, ...additions]);
  const baselineFiles = new Map(files.map(name => [name, Buffer.from('synthetic ' + name)]));
  baselineFiles.set(GUARD, Buffer.from('// Синтетический preamble; repeated digest: ' + sha256(originalBeforeFlow) + '\n'
    + `export const LK1_UNPAID_FLOW_SHA256 = '${sha256(originalBeforeFlow)}';\n`
    + `export const LK1_UNPAID_GATEWAY_SHA256 = '${sha256('return msg;')}';\n`));
  const input = { originalBeforeFlow, beforeFlow, originalPins: photoPins(beforeFlow), baselineFiles,
    trustedBaseline: { sourceCommit: 'a'.repeat(40) }, publishingSourceCommit: 'b'.repeat(40),
    trustedForeign: { sourceFlowSha256: sha256(originalBeforeFlow), candidateFlowSha256: sha256(beforeFlow),
      deploymentId: 'synthetic-foreign-bridge', additionCount: additions.length } };
  baseline(input);
  owner(input, buildExactGraphContract({ liveBytes: originalBeforeFlow, candidateBytes: beforeFlow,
    deploymentId: input.trustedForeign.deploymentId, allowedChanges: [], allowedAdditionIds: additions.map(node => node.id) }));
  return input;
}
function repinCandidate(input, mutateContract = () => {}) {
  const contract = JSON.parse(input.ownerContractBytes);
  contract.candidateSha256 = sha256(input.beforeFlow);
  contract.candidateNodeCount = JSON.parse(input.beforeFlow).length;
  input.trustedForeign.candidateFlowSha256 = contract.candidateSha256;
  input.originalPins = { ...input.originalPins, flowSha256: sha256(input.beforeFlow) };
  mutateContract(contract);owner(input, contract);
}

test('composed forward/recovery use the real historical baseline and preserve every reviewed addition', () => {
  const input = fixture(), saved = structuredClone(input);
  assert.throws(() => buildSupportPhotosWorkerRebind(input), /BASELINE_FLOW_BINDING_MISMATCH/);
  const states = buildSupportPhotoStates(input.beforeFlow, input.originalPins);
  for (const purpose of ['forward', 'paused-recovery']) {
    const result = build({ ...input, purpose });
    const target = purpose === 'forward' ? states.photoActive : states.originalPaused;
    const expected = sha256(native(target));
    assert.equal(result.provenance.nativeDiskSha256, expected);
    assert.equal(result.provenance.pausedNativeDiskSha256, sha256(native(states.originalPaused)));
    assert.equal(result.provenance.baselineSourceCommit, input.trustedBaseline.sourceCommit);
    assert.equal(result.candidateManifest.sourceCommit, input.publishingSourceCommit);
    assert.equal(result.provenance.originalBeforeFlowSha256, sha256(input.originalBeforeFlow));
    assert.equal(result.provenance.beforeFlowSha256, sha256(input.beforeFlow));
    assert.equal(result.provenance.preservedAdditionCount, 3);
    assert.deepEqual(result.provenance.changedFiles, [GUARD]);
    assert.equal(result.provenance.unchangedFileCount, 12);
    const old = input.baselineFiles.get(GUARD).toString();
    assert.equal(result.candidateFiles.get(GUARD).toString(), old.replace(
      `export const LK1_UNPAID_FLOW_SHA256 = '${sha256(input.originalBeforeFlow)}';`,
      `export const LK1_UNPAID_FLOW_SHA256 = '${expected}';`));
    for (const name of files) if (name !== GUARD) assert(result.candidateFiles.get(name).equals(input.baselineFiles.get(name)));
    for (const node of JSON.parse(input.beforeFlow).filter(node => node.id.startsWith('foreign-'))) {
      assert.deepEqual(target.find(next => next.id === node.id), node);
    }
    result.candidateFiles.get(files[0]).fill(0);result.candidateFiles.get(GUARD).fill(0);
    assert.deepEqual(structuredClone(input), saved, 'Every output buffer is owned by its generation');
  }
});
test('missing/wrong independent pins and contract files cannot authorize a new baseline', () => {
  for (const mutate of [
    input => { delete input.trustedForeign; },
    input => { input.trustedForeign.extra = true; },
    input => { input.trustedForeign.contractSha256 = '0'.repeat(64); },
    input => { input.trustedForeign.sourceFlowSha256 = '0'.repeat(64); },
    input => { input.trustedForeign.candidateFlowSha256 = '0'.repeat(64); },
    input => { input.trustedForeign.additionCount++; },
    input => { input.trustedForeign.deploymentId = 'foreign-owner'; },
    input => { input.ownerContractBytes = Buffer.from('{}'); },
    input => { input.publishingSourceCommit = input.trustedBaseline.sourceCommit; },
  ]) { const input = fixture();mutate(input);assert.throws(() => build(input)); }
});
test('old-node mutations, removals and reordering fail even after superficial flow pins are recomputed', () => {
  for (const mutate of [
    flow => { flow.find(node => node.id === GATEWAY).func += '\nreturn null;'; },
    flow => { flow.find(node => node.id === 'unrelated').opaque.retained = false; },
    flow => { flow.splice(flow.findIndex(node => node.id === 'unrelated'), 1); },
    flow => { [flow[0], flow[1]] = [flow[1], flow[0]]; },
    flow => { flow.push(structuredClone(flow[0])); },
  ]) {
    const input = fixture(), flow = JSON.parse(input.beforeFlow);mutate(flow);
    input.beforeFlow = native(flow);repinCandidate(input);
    assert.throws(() => build(input));
  }
});
test('extra/replaced additions and new active edges cannot be blessed by a fresh whole-flow digest', () => {
  for (const mutate of [
    flow => { flow.push({ id: 'unreviewed', type: 'comment' }); },
    flow => { flow.find(node => node.id === 'foreign-function').func = 'return null;'; },
    flow => { flow.pop(); },
  ]) {
    const input = fixture(), flow = JSON.parse(input.beforeFlow);mutate(flow);
    input.beforeFlow = native(flow);repinCandidate(input);assert.throws(() => build(input));
  }
  for (const mutate of [node => { node.wires = [[GATEWAY]]; }, node => { node.links = [GATEWAY]; },
    node => { node.z = 'synthetic-tab'; }]) {
    const input = fixture(), flow = JSON.parse(input.beforeFlow);mutate(flow.find(node => node.id === 'foreign-function'));
    input.beforeFlow = native(flow);repinCandidate(input, contract => {
      contract.allowedAdditions.find(row => row.id === 'foreign-function').candidateNodeSha256
        = sha256(JSON.stringify(flow.find(node => node.id === 'foreign-function')));
    });
    assert.throws(() => build(input), /ADDITION_BRIDGE_ACTIVE_EDGE/);
  }
});
test('raw encoding, duplicate constants and the full13-file closure remain enforced', () => {
  for (const mutate of [
    input => { input.beforeFlow = Buffer.concat([input.beforeFlow, Buffer.from('\n')]); },
    input => { input.originalBeforeFlow = Buffer.from(JSON.stringify(JSON.parse(input.originalBeforeFlow))); },
    input => { input.ownerContractBytes = Buffer.concat([input.ownerContractBytes, Buffer.from(' ')]);
      input.trustedForeign.contractSha256 = sha256(input.ownerContractBytes); },
    input => { input.baselineFiles.set(GUARD, Buffer.concat([input.baselineFiles.get(GUARD),
      Buffer.from(`export const LK1_UNPAID_FLOW_SHA256 = '${'c'.repeat(64)}';\n`)]));baseline(input); },
    input => { input.baselineFiles.set(GUARD, Buffer.concat([Buffer.from([255]), input.baselineFiles.get(GUARD)]));baseline(input); },
    input => { input.baselineFiles.delete(files[0]);baseline(input); },
    input => { input.baselineFiles.set('foreign.mjs', Buffer.from('unreviewed'));baseline(input); },
  ]) { const input = fixture();mutate(input);assert.throws(() => build(input)); }
});
