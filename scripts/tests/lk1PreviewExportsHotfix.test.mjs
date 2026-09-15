// Focused generation for the 2026-09-15 preview incident: the released preview body
// stopped publishing the three event-route helpers, so every group-training and
// tournament quote answered 503 `*_DISCOUNT_BACKEND_NOT_READY`. This suite pins the
// reviewed preimage/postimage of the fix, the fail-closed preimage gates and the
// deploy wrapper contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_EVENT_HELPER_NAMES,
  PREVIEW_EXPORTS_BOOKING_NODE_ID,
  PREVIEW_EXPORTS_EVALUATOR_NODE_ID,
  PREVIEW_EXPORTS_INSTALLED_GENERATION,
  PREVIEW_EXPORTS_NODE_ID,
  PREVIEW_EXPORTS_SOURCE_NODE_COUNT,
  PREVIEW_EXPORTS_SOURCE_SHA256,
  PREVIEW_EXPORTS_TARGETS,
  assertEventHelpersPublished,
  composeLk1PreviewExportsArtifacts,
  sha256,
} from '../patch_live_lk1_preview_exports_hotfix.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The live flow of the incident, pulled from lk-primary-147. Optional: the suite
// skips the snapshot-dependent half when the operator has not kept a copy.
const LIVE_SNAPSHOT = process.env.LK1_PREVIEW_EXPORTS_LIVE_SNAPSHOT
  ?? '/private/tmp/lk1-hotfix-live/source.flow.json';
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_PREVIEW_EXPORTS_LIVE_SNAPSHOT)`;

test('the generation pins the incident flow and one node field', () => {
  assert.match(PREVIEW_EXPORTS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(PREVIEW_EXPORTS_SOURCE_NODE_COUNT, 4804);
  assert.equal(PREVIEW_EXPORTS_NODE_ID, 'lk_subscription_price_preview_20260908_router');
  assert.match(PREVIEW_EXPORTS_TARGETS.preview.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(PREVIEW_EXPORTS_TARGETS.preview.patchedFuncSha256, /^[0-9a-f]{64}$/);
  // The preimage is the generation that produced the outage, the postimage is the fix.
  assert.equal(PREVIEW_EXPORTS_TARGETS.preview.liveFuncSha256,
    '64f67bad58bd3add870bd3c6012c5f1c9c9256338b23c5a6295cefefc5811856');
  assert.notEqual(PREVIEW_EXPORTS_TARGETS.preview.liveFuncSha256,
    PREVIEW_EXPORTS_TARGETS.preview.patchedFuncSha256);
  // The installed generation the composition must be fed: the plan-rules gateway and
  // evaluator, the split-nominal-share split/join bodies and the installed allowance.
  assert.deepEqual(Object.keys(PREVIEW_EXPORTS_INSTALLED_GENERATION).sort(),
    ['allowanceBlockSha256', 'bookingFuncSha256', 'evaluatorFuncSha256', 'joinFuncSha256', 'splitFuncSha256']);
  for (const [label, digest] of Object.entries(PREVIEW_EXPORTS_INSTALLED_GENERATION)) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${label} must be a sha256`);
  }
  assert.deepEqual([...PREVIEW_EVENT_HELPER_NAMES],
    ['identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId']);
});

test('the composition publishes the event helpers, not only the plan-rules resolver', () => {
  // The exact defect: definitions inside the closure, no names in the return object.
  // The trailing router-shaped references sit behind the `const pricing` boundary the
  // helper uses to isolate the closure, exactly like the generated node.
  const broken = 'const canonical = (() => {\nconst isObj = () => 1;\n'
    + 'const identityMoneyOwned = () => 1;\nreturn {isObj};\n})();\nconst pricing = 1;\n'
    + 'canonical.identityMoneyOwned(1);';
  assert.throws(() => assertEventHelpersPublished(broken, ['isObj']),
    /Composed preview does not publish canonical\.identityMoneyOwned/);
  const fixed = 'const canonical = (() => {\nconst isObj = () => 1;\n'
    + 'const unpublished = () => 1;\nconst identityMoneyOwned = () => 1;\n'
    + 'const lk1LifecycleInstant = () => 1;\nconst managedExternalEventTypeId = () => 1;\n'
    + 'return {isObj,identityMoneyOwned,lk1LifecycleInstant,managedExternalEventTypeId};\n})();\nconst pricing = 1;\n'
    + 'canonical.isObj(1); canonical.identityMoneyOwned(1); canonical.lk1LifecycleInstant(1); canonical.managedExternalEventTypeId(1);';
  const scope = assertEventHelpersPublished(fixed,
    ['isObj', 'identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId']);
  for (const name of PREVIEW_EVENT_HELPER_NAMES) assert.equal(typeof scope[name], 'function');
  // A reference the closure does not publish is a build failure, not a 503.
  assert.throws(() => assertEventHelpersPublished(
    fixed.replace('canonical.isObj(1);', 'canonical.unpublished(1);'),
    ['isObj', 'identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId']),
  /missing referenced helpers: unpublished/);
});

test('the generation refuses any preimage that is not the incident flow', () => {
  const flow = [{ id: 'x', type: 'function', func: '', initialize: '', outputs: 1, wires: [[]] }];
  assert.throws(() => composeLk1PreviewExportsArtifacts(flow, 'probe'),
    /Live flow preimage drift/);
  if (snapshotSkip) return;
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const drifted = JSON.parse(bytes.toString('utf8'));
  drifted.find((node) => node.id === PREVIEW_EXPORTS_BOOKING_NODE_ID).func += '\n// drift';
  assert.throws(() => composeLk1PreviewExportsArtifacts(drifted, 'probe'),
    /Live flow preimage drift/);
});

test('the generation composes exactly the reviewed postimage', { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1PreviewExportsArtifacts(bytes, 'lk1-preview-event-helpers');
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, PREVIEW_EXPORTS_NODE_ID);
  assert.deepEqual(built.changes[0].fields, ['func']);
  assert.equal(built.changes[0].func.beforeSha256, PREVIEW_EXPORTS_TARGETS.preview.liveFuncSha256);
  assert.equal(built.changes[0].func.afterSha256, PREVIEW_EXPORTS_TARGETS.preview.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.previewNode.otherFieldsUnchanged, true);
  assert.equal(built.previewNode.initializeUnchanged, true);
  assert.equal(built.previewNode.resolverReachable, true);
  assert.deepEqual(built.eventHelpers, [...PREVIEW_EVENT_HELPER_NAMES]);
  // The candidate keeps the exact contract shape the remote helper accepts.
  assert.equal(built.contract.contractKind, 'exact-graph');
  assert.deepEqual(built.contract.allowedChanges.map((change) => [change.id, change.fields]),
    [[PREVIEW_EXPORTS_NODE_ID, ['func']]]);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString('utf8'));
  const live = JSON.parse(bytes.toString('utf8'));
  assert.equal(candidate.length, live.length);
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [PREVIEW_EXPORTS_NODE_ID]);
  // Every other node is byte-identical, including the gateway, the evaluator and the
  // plan-rules activation initialize.
  for (const id of [PREVIEW_EXPORTS_BOOKING_NODE_ID, PREVIEW_EXPORTS_EVALUATOR_NODE_ID]) {
    const before = live.find((node) => node.id === id);
    const after = candidate.find((node) => node.id === id);
    assert.equal(sha256(after.func), sha256(before.func));
    assert.equal(after.initialize, before.initialize);
  }
});

test('the deploy wrapper keeps the confirmation gate, the exact allowance and rollback', () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_preview_exports_hotfix_147.sh'), 'utf8');
  assert.ok(wrapper.includes('NODE_RED_LK1_PREVIEW_EXPORTS_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes('clean main checkout'));
  assert.ok(wrapper.includes(`allow_nodes=(${PREVIEW_EXPORTS_NODE_ID})`));
  assert.ok(wrapper.includes(`"${PREVIEW_EXPORTS_NODE_ID}:func"`));
  assert.ok(wrapper.includes('expected_changed_nodes=1'));
  assert.ok(wrapper.includes('patch_live_lk1_preview_exports_hotfix.mjs'));
  assert.ok(wrapper.includes('prepare_exact_graph_contract.mjs'));
  assert.equal(wrapper.includes('nodered_reviewed_flow_deploy/prepare_contract.mjs'), false);
  assert.ok(wrapper.includes('rollback --deployment-id'));
  assert.ok(wrapper.includes('sha256sum'));
  assert.ok(wrapper.includes('deploy_reviewed_flow_147_remote.mjs'));
  assert.ok(wrapper.includes('value.previewNode?.otherFieldsUnchanged !== true'));
  assert.ok(wrapper.includes('value.eventHelpers'));
  assert.ok(wrapper.includes('smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"'));
  assert.ok(wrapper.includes("value.currency !== \"RUB\""));
  assert.ok(wrapper.includes('%{http_code}'));
  // The wrapper must not carry the three-node plan-rules allowance any more.
  assert.equal(wrapper.includes('lk_subscription_booking_router_20260804:func,initialize'), false);
  assert.equal(wrapper.includes('lk_subscription_managed_policy_20260820:func'), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['nodered:lk1-preview-exports:deploy-147'],
    'bash scripts/deploy_nodered_lk1_preview_exports_hotfix_147.sh');
});

test('the wrapper stage and backup paths satisfy the reviewed remote contract', () => {
  const helper = fs.readFileSync(
    path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs'), 'utf8');
  const stageParent = /const STAGE_PARENT = "([^"]+)";/.exec(helper)?.[1];
  const patternLiteral = /const STAGE_PATTERN = \/(.+)\/;/.exec(helper)?.[1];
  const backupDir = /const BACKUP_DIRECTORY = "([^"]+)";/.exec(helper)?.[1];
  assert.ok(stageParent && patternLiteral && backupDir, 'remote stage/backup constants');
  const stagePattern = new RegExp(patternLiteral);
  const wrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_preview_exports_hotfix_147.sh'), 'utf8');
  const stageLine = /^remote_stage="([^"]*)"$/m.exec(wrapper)?.[1];
  assert.ok(stageLine, 'remote_stage assignment');
  const rendered = stageLine
    .replace('$remote_stamp', '20260915T214500+0300')
    .replace(/\$\$/g, '4242');
  assert.equal(rendered.slice(0, rendered.lastIndexOf('/')), stageParent);
  assert.ok(stagePattern.test(rendered.slice(rendered.lastIndexOf('/') + 1)), rendered);
  assert.ok(wrapper.includes('remote_candidate="$remote_stage/candidate.flow.json"'));
  assert.ok(wrapper.includes('remote_contract="$remote_stage/contract.json"'));
  assert.ok(wrapper.includes(`remote_backup_dir="${backupDir}"`));
  assert.ok(wrapper.includes('remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"'));
  assert.ok(wrapper.includes('remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"'));
});
