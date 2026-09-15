import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READBACK_TARGET,
  composeLk1PaymentReadbackArtifacts,
  extractStep,
  patchLk1PaymentReadbackBody,
  reviewedReadbackStep,
  sha256,
} from '../patch_live_lk1_payment_readback.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the reviewed source fragment is exactly the pinned deploy postimage fragment', () => {
  const reviewed = reviewedReadbackStep(repoRoot);
  assert.equal(sha256(reviewed), READBACK_TARGET.reviewedStepSha256);
  assert.notEqual(READBACK_TARGET.liveStepSha256, READBACK_TARGET.reviewedStepSha256);
  // The reviewed fragment carries the fix: nested checkout link and every alias family.
  for (const marker of ['cardPaymentInfo?.paymentUrl', 'cardPaymentStatus?.paymentUrl',
    'collectIds(transaction?.client', 'collectIds(transaction?.bookingIds',
    'pricingDetails', 'normalizeId(clientId)', 'normalizeId(bookingId)']) {
    assert.ok(reviewed.includes(marker), marker);
  }
  // The generation is a single-function delta over one node.
  assert.equal(READBACK_TARGET.id, 'lk_subscription_booking_router_20260804');
  assert.equal(new Set([READBACK_TARGET.id]).size, 1);
});

test('step extraction fails closed on missing or duplicated anchors', () => {
  const reviewed = reviewedReadbackStep(repoRoot);
  assert.throws(() => extractStep('const x = 1;', READBACK_TARGET.step), /anchor drift/);
  assert.throws(() => extractStep(`${reviewed}\n${reviewed}`, READBACK_TARGET.step), /anchor drift/);
  assert.throws(() => extractStep(`if (ctx.step === "${READBACK_TARGET.step}") {\n  old();`, READBACK_TARGET.step), /end drift/);
});

test('preimage drift is rejected before any candidate can be produced', () => {
  const reviewed = reviewedReadbackStep(repoRoot);
  assert.throws(() => patchLk1PaymentReadbackBody('const unexpected = true;'), /preimage drift/);
  // A body with the pinned gateway hash but a different step cannot exist; a body
  // whose step no longer matches the pin is rejected on the step hash.
  const flow = [{ id: READBACK_TARGET.id, type: 'function', outputs: 1, wires: [[]], func: 'const unexpected = true;' }];
  assert.throws(() => composeLk1PaymentReadbackArtifacts(Buffer.from(`${JSON.stringify(flow, null, 2)}\n`)), /preimage drift/);
  assert.throws(() => composeLk1PaymentReadbackArtifacts(Buffer.from('{}')), /Invalid flow identity/);
  assert.throws(() => composeLk1PaymentReadbackArtifacts(Buffer.from(`${JSON.stringify([
    { id: 'other', type: 'function', outputs: 1, wires: [[]], func: reviewed }], null, 2)}\n`)), /Node contract mismatch/);
  assert.throws(() => extractStep(reviewed, READBACK_TARGET.step), /anchor drift|end drift/);
});

test('the patcher replaces exactly one step with the reviewed fragment', () => {
  const liveStep = `if (ctx.step === "${READBACK_TARGET.step}") {\n  return legacyReadback(ctx);\n}\n`;
  const reviewed = `if (ctx.step === "${READBACK_TARGET.step}") {\n  return reviewedReadback(ctx);\n}\n`;
  const liveBody = `const head = 1;\n${liveStep}\nif (ctx.step === "lk1_checkout_saved") {\n  return finish(ctx);\n}\n`;
  const expectedBody = `const head = 1;\n${reviewed}\nif (ctx.step === "lk1_checkout_saved") {\n  return finish(ctx);\n}\n`;
  const synthetic = { ...READBACK_TARGET, liveGatewaySha256: sha256(liveBody),
    liveStepSha256: sha256(liveStep), patchedGatewaySha256: sha256(expectedBody) };
  assert.equal(patchLk1PaymentReadbackBody(liveBody, synthetic, reviewed), expectedBody);
  // Reapplying the same generation is refused instead of silently rewriting again.
  assert.throws(() => patchLk1PaymentReadbackBody(expectedBody, synthetic, reviewed), /preimage drift/);
  const flow = [{ id: READBACK_TARGET.id, type: 'function', outputs: 1, wires: [[]], func: liveBody }];
  const built = composeLk1PaymentReadbackArtifacts(Buffer.from(`${JSON.stringify(flow, null, 2)}\n`), synthetic, reviewed);
  assert.equal(built.flow[0].func, expectedBody);
  assert.equal(built.candidateBytes.toString('utf8'), `${JSON.stringify(built.flow, null, 2)}\n`);
  assert.deepEqual(built.changes, [{ id: READBACK_TARGET.id, fields: ['func'] }]);
});

test('the contract file exposes the allow-list the wrapper asserts', async () => {
  const { buildFunctionOnlyContract } = await import('../nodered_reviewed_flow_deploy/runtime_contract.mjs');
  const node = (id, func) => ({ id, type: 'function', outputs: 1, wires: [[]], func });
  const live = Buffer.from(`${JSON.stringify([node('other', 'const a = 1;\n'), node('gateway', 'const a = 1;\n')], null, 2)}\n`);
  const candidate = Buffer.from(`${JSON.stringify([node('other', 'const a = 1;\n'), node('gateway', 'const a = 2;\n')], null, 2)}\n`);
  const contract = buildFunctionOnlyContract({ liveBytes: live, candidateBytes: candidate,
    deploymentId: 'fixture-readback', allowedNodeIds: ['gateway'] });
  // The count lives in the receipts, never in the contract file itself.
  assert.equal(contract.changedNodeCount, undefined);
  assert.equal(contract.allowedChanges.length, 1);
  assert.equal(contract.allowedChanges[0].id, 'gateway');
  assert.deepEqual(contract.allowedChanges[0].fields, ['func']);
  assert.equal(contract.sourceSha256, sha256(live));
  assert.equal(contract.candidateSha256, sha256(candidate));
  const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts/deploy_nodered_lk1_payment_readback_147.sh'), 'utf8');
  // The contract-file check must read the allow-list, while the preflight
  // receipt legitimately carries changedNodeCount.
  assert.ok(wrapper.includes('value.allowedChanges'));
  assert.ok(wrapper.includes('changes.some((change) => change.id !== process.argv[3]'));
});

test('the wrapper stage and backup paths satisfy the reviewed remote contract', () => {
  const helper = fs.readFileSync(
    path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs'), 'utf8');
  const stageParent = /const STAGE_PARENT = "([^"]+)";/.exec(helper)?.[1];
  const patternLiteral = /const STAGE_PATTERN = \/(.+)\/;/.exec(helper)?.[1];
  const backupDir = /const BACKUP_DIRECTORY = "([^"]+)";/.exec(helper)?.[1];
  assert.ok(stageParent && patternLiteral && backupDir, 'remote stage/backup constants');
  const stagePattern = new RegExp(patternLiteral);
  const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts/deploy_nodered_lk1_payment_readback_147.sh'), 'utf8');
  const stageLine = /^remote_stage="([^"]*)"$/m.exec(wrapper)?.[1];
  assert.ok(stageLine, 'remote_stage assignment');
  const rendered = stageLine
    .replace('$remote_stamp', '20260915T164214+0300')
    .replace(/\$\$/g, '76648');
  assert.equal(rendered.slice(0, rendered.lastIndexOf('/')), stageParent);
  assert.ok(stagePattern.test(rendered.slice(rendered.lastIndexOf('/') + 1)), rendered);
  // The helper requires these exact file names inside the stage.
  assert.ok(wrapper.includes('remote_candidate="$remote_stage/candidate.flow.json"'));
  assert.ok(wrapper.includes('remote_contract="$remote_stage/contract.json"'));
  // Recovery artifacts must satisfy the reviewed backup contract as well.
  assert.ok(wrapper.includes(`remote_backup_dir="${backupDir}"`));
  assert.ok(wrapper.includes('remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"'));
  assert.ok(wrapper.includes('remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"'));
});

test('the deploy wrapper keeps the confirmation gate, allow-list and rollback', () => {
  const wrapper = fs.readFileSync(path.join(repoRoot, 'scripts/deploy_nodered_lk1_payment_readback_147.sh'), 'utf8');
  assert.ok(wrapper.includes('NODE_RED_LK1_PAYMENT_READBACK_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes('clean main checkout'));
  assert.ok(wrapper.includes('allow_nodes=(lk_subscription_booking_router_20260804)'));
  assert.ok(wrapper.includes('expected_changed_nodes=1'));
  assert.ok(wrapper.includes('patch_live_lk1_payment_readback.mjs'));
  assert.ok(wrapper.includes('prepare_contract.mjs'));
  assert.ok(wrapper.includes('rollback --deployment-id'));
  assert.ok(wrapper.includes('sha256sum'));
  // The wrapper is preparation + apply only through the reviewed remote helper.
  assert.ok(wrapper.includes('deploy_reviewed_flow_147_remote.mjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['nodered:lk1-payment-readback:deploy-147'],
    'bash scripts/deploy_nodered_lk1_payment_readback_147.sh');
});
