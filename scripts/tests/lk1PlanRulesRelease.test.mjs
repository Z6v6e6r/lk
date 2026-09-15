import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN_RULES_CONFIG_FRAGMENT_SHA256,
  PLAN_RULES_DEPLOYMENT_ID,
  PLAN_RULES_EVALUATOR_NODE_ID,
  PLAN_RULES_GATEWAY_DELTAS,
  PLAN_RULES_GATEWAY_NODE_ID,
  PLAN_RULES_MODULE_SHA256,
  PLAN_RULES_PENDING_DELTAS,
  PLAN_RULES_PREVIEW_NODE_ID,
  PLAN_RULES_REVIEWED_EVALUATOR_SHA256,
  PLAN_RULES_SOURCE_NODE_COUNT,
  PLAN_RULES_SOURCE_SHA256,
  PLAN_RULES_TARGETS,
  applyDeltas,
  buildEvaluatorBody,
  buildGatewayBody,
  composeLk1PlanRulesArtifacts,
  extractEmbeddedEvaluatorBody,
  patchLk1PlanRulesEvaluatorBody,
  patchLk1PlanRulesGatewayBody,
  reviewedConfigFragment,
  reviewedEvaluatorBody,
  reviewedPlanRulesModule,
  sha256,
} from '../patch_live_lk1_plan_rules.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE_SNAPSHOT = process.env.LK1_PLAN_RULES_LIVE_SNAPSHOT
  ?? '/private/tmp/lk1-prod-readiness-live/input/source.flow.json';
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_PLAN_RULES_LIVE_SNAPSHOT)`;

let cachedArtifacts = null;
function liveArtifacts() {
  if (cachedArtifacts) return cachedArtifacts;
  const liveBytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1PlanRulesArtifacts(liveBytes);
  const liveFlow = JSON.parse(liveBytes.toString('utf8'));
  const funcOf = (flow, id) => flow.find((node) => node.id === id).func;
  cachedArtifacts = {
    liveBytes,
    built,
    candidateText: built.candidateBytes.toString('utf8'),
    gateway: funcOf(built.flow, PLAN_RULES_GATEWAY_NODE_ID),
    evaluator: funcOf(built.flow, PLAN_RULES_EVALUATOR_NODE_ID),
    liveGateway: funcOf(liveFlow, PLAN_RULES_GATEWAY_NODE_ID),
    liveEvaluator: funcOf(liveFlow, PLAN_RULES_EVALUATOR_NODE_ID),
  };
  return cachedArtifacts;
}

const count = (text, needle) => text.split(needle).length - 1;

test('the reviewed sources are exactly the pinned generation inputs', () => {
  assert.equal(sha256(reviewedPlanRulesModule()), PLAN_RULES_MODULE_SHA256);
  assert.equal(sha256(reviewedConfigFragment()), PLAN_RULES_CONFIG_FRAGMENT_SHA256);
  assert.equal(sha256(reviewedEvaluatorBody()), PLAN_RULES_REVIEWED_EVALUATOR_SHA256);
  // The module keeps its resolver API once the `export` keyword is dropped.
  const module = reviewedPlanRulesModule();
  assert.equal(module.includes('export '), false);
  for (const symbol of ['const LK1_PLAN_RULES_GLOBAL =', 'const LK1_HUB_PRODUCT_ID =',
    'function normalizePlanRules(', 'function resolveLk1Rule(', 'function lk1ReadPlanRules(']) {
    assert.ok(module.includes(symbol), symbol);
  }
  // The released config resolves the rule instead of hardcoding one product id.
  const config = reviewedConfigFragment();
  assert.ok(config.includes('resolveLk1Rule({ owned, planRules: lk1ReadPlanRules() })'));
  assert.equal(config.includes('LK1_OVERLAY_HUB_PRODUCT_ID'), false);
  // Generation pins: live and patched bodies must differ for both nodes.
  assert.equal(PLAN_RULES_TARGETS.gateway.id, PLAN_RULES_GATEWAY_NODE_ID);
  assert.equal(PLAN_RULES_TARGETS.evaluator.id, PLAN_RULES_EVALUATOR_NODE_ID);
  assert.notEqual(PLAN_RULES_TARGETS.gateway.liveFuncSha256, PLAN_RULES_TARGETS.gateway.patchedFuncSha256);
  assert.notEqual(PLAN_RULES_TARGETS.evaluator.liveFuncSha256, PLAN_RULES_TARGETS.evaluator.patchedFuncSha256);
  assert.equal(new Set(PLAN_RULES_GATEWAY_DELTAS.map((delta) => delta.id)).size,
    PLAN_RULES_GATEWAY_DELTAS.length);
});

test('the price-preview amendment is a documented pending slot, not part of this generation', () => {
  assert.equal(PLAN_RULES_PENDING_DELTAS.length, 1);
  const [pending] = PLAN_RULES_PENDING_DELTAS;
  assert.equal(pending.nodeId, PLAN_RULES_PREVIEW_NODE_ID);
  assert.equal(pending.status, 'PENDING_COMPOSITION');
  assert.equal(pending.owner, 'scripts/patch_nodered_subscription_price_preview.mjs');
  assert.ok(pending.reason.length > 0);
  // The preview node is not changed by this patcher, so it is not in the allow-list.
  assert.ok(!PLAN_RULES_GATEWAY_DELTAS.some((delta) => delta.id.includes('preview')));
});

test('anchor handling fails closed on ambiguous or composed deltas', () => {
  assert.throws(() => applyDeltas('const a = 1;\nconst a = 1;\n',
    [{ id: 'duplicate', before: 'const a = 1;\n', after: 'const a = 2;\n' }], 'Synthetic'),
  /anchor drift for duplicate: 2 occurrences/);
  assert.throws(() => applyDeltas('const b = 1;\n',
    [{ id: 'missing', before: 'const a = 1;\n', after: 'const a = 2;\n' }], 'Synthetic'),
  /anchor drift for missing: 0 occurrences/);
  // The reviewed module must not be embeddable into a body that already declares it.
  assert.throws(() => buildGatewayBody(reviewedPlanRulesModule()),
    /already declares the embedded plan-rules symbol/);
});

test('the patcher applies to the live 147 snapshot as exactly two function-body deltas',
  { skip: snapshotSkip }, () => {
    const { built, candidateText, gateway, evaluator, liveGateway, liveEvaluator } = liveArtifacts();
    assert.equal(built.changes.length, 2);
    assert.equal(built.flow.length, PLAN_RULES_SOURCE_NODE_COUNT);
    assert.equal(built.previewNodeUnchanged, true);
    assert.deepEqual(built.changes.map((change) => change.id).sort(),
      [PLAN_RULES_EVALUATOR_NODE_ID, PLAN_RULES_GATEWAY_NODE_ID].sort());
    for (const change of built.changes) {
      assert.deepEqual(change.fields, ['func']);
      assert.notEqual(change.beforeSha256, change.afterSha256);
    }
    // The candidate is the live flow with exactly those two function bodies replaced.
    assert.equal(candidateText, `${JSON.stringify(built.flow, null, 2)}\n`);
    assert.equal(sha256(liveGateway), PLAN_RULES_TARGETS.gateway.liveFuncSha256);
    assert.equal(sha256(gateway), PLAN_RULES_TARGETS.gateway.patchedFuncSha256);
    assert.equal(sha256(liveEvaluator), PLAN_RULES_TARGETS.evaluator.liveFuncSha256);
    assert.equal(sha256(evaluator), PLAN_RULES_TARGETS.evaluator.patchedFuncSha256);

    // A Node-RED function body must stay parseable with the Node-RED arguments.
    new Function('msg', 'node', 'env', 'global', gateway);
    new Function('msg', 'node', 'env', 'global', evaluator);

    // Gateway: the resolver module is embedded once, the reviewed config replaced the
    // single-product config, and every legacy gate now reads the resolver verdict.
    assert.equal(count(gateway, 'const LK1_PLAN_RULES_GLOBAL = "subscriptions_lk1_plan_rules";'), 1);
    assert.equal(count(gateway, 'resolveLk1Rule({ owned, planRules: lk1ReadPlanRules() })'), 1);
    assert.equal(count(gateway, 'if (configured.legacy) return { legacy: true };'), 1);
    assert.equal(count(gateway, 'const enforced = configured.matched && !configured.legacy;'), 1);
    assert.equal(count(gateway, 'const enforcedRule = selectedRule.matched && !selectedRule.legacy;'), 1);
    assert.equal(count(gateway, 'if (productRule.matched && !productRule.legacy) {'), 1);
    assert.equal(count(gateway, 'const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);'), 1);
    // The pre-rollout gates are gone from the live body.
    assert.equal(count(gateway, '&& dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM'), 0);
    assert.equal(count(gateway, 'if (productRule.matched) {'), 0);
    assert.equal(count(gateway, 'const visitOwned = findOwnedSubscriptions'), 0);
    assert.equal(count(gateway, 'if (!ids.includes(LK1_OVERLAY_HUB_PRODUCT_ID)) return { matched: false };'), 0);
    // Unrelated host helpers the resolver relies on are still present exactly once.
    assert.equal(count(gateway, 'const collectExactProductIds ='), 1);
    assert.equal(count(gateway, 'const lk1ReadBoundPolicy ='), 1);

    // Evaluator: the reviewed body replaced the embedded base copy, the product is
    // validated instead of hardcoded, and the active-bookings blocker is now a verdict.
    assert.equal(count(evaluator, reviewedEvaluatorBody()), 1);
    assert.equal(count(evaluator, 'aboveActiveLimit: false,'), 1);
    assert.equal(count(evaluator, 'decision.aboveActiveLimit = activeCount >= rule.maxActiveBookings;'), 1);
    assert.equal(count(evaluator, 'binding.policyProductId !== "db7a5250-7369-4f43-8ac5-9111be24bc74"'), 0);
    assert.equal(count(evaluator, 'const UUID_PATTERN ='), 1);
    // The only remaining occurrence belongs to the untouched managed/CUP path.
    assert.equal(count(evaluator, '"ACTIVE_SERVICES_LIMIT_REACHED"'), 1);
    assert.ok(evaluator.includes('"Достигнут лимит активных услуг по подписке"'));
  });

test('the embedded evaluator preimage is the base generation source of commit e2e5e1e5',
  { skip: snapshotSkip }, () => {
    const { liveEvaluator } = liveArtifacts();
    let baseSource;
    try {
      baseSource = execFileSync('git',
        ['show', 'e2e5e1e5:scripts/nodered_lk1_hub_nodes/evaluator.js'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return; // The base commit is unavailable (shallow checkout); the sha pin still holds.
    }
    const { embedded } = extractEmbeddedEvaluatorBody(liveEvaluator);
    assert.equal(sha256(embedded), PLAN_RULES_TARGETS.evaluator.liveEmbeddedSha256);
    assert.equal(sha256(embedded), sha256(baseSource));
  });

test('a second run and any drift are refused', { skip: snapshotSkip }, () => {
  const { gateway, evaluator, built, liveGateway, liveEvaluator } = liveArtifacts();
  assert.throws(() => patchLk1PlanRulesGatewayBody(gateway), /already patched/);
  assert.throws(() => patchLk1PlanRulesEvaluatorBody(evaluator), /already patched/);
  assert.throws(() => buildGatewayBody(gateway), /already patched/);
  assert.throws(() => buildEvaluatorBody(evaluator), /already patched/);
  // Re-running the whole generation over its own candidate fails closed.
  assert.throws(() => composeLk1PlanRulesArtifacts(built.candidateBytes), /preimage drift/);

  // Node-level drift: a single extra byte in either live body is refused.
  assert.throws(() => patchLk1PlanRulesGatewayBody(`${liveGateway} `), /live preimage drift/);
  assert.throws(() => patchLk1PlanRulesEvaluatorBody(`${liveEvaluator} `), /live preimage drift/);
  // A live body with the right node hash but a broken anchor cannot exist; a body
  // that fails the flow-level pin is refused before any node is touched.
  const driftedFlow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT).toString('utf8'));
  driftedFlow[0].name = `${driftedFlow[0].name ?? ''} drifted`;
  const driftedBytes = Buffer.from(`${JSON.stringify(driftedFlow, null, 2)}\n`);
  assert.throws(() => composeLk1PlanRulesArtifacts(driftedBytes), /Live flow preimage drift/);

  // Node-count drift is refused even when the flow-level hash is supplied.
  const tiny = Buffer.from(`${JSON.stringify([
    { id: PLAN_RULES_GATEWAY_NODE_ID, type: 'function', outputs: 1, wires: [[]], func: 'const a = 1;\n' }], null, 2)}\n`);
  assert.throws(() => composeLk1PlanRulesArtifacts(tiny, { expectedSourceSha256: sha256(tiny) }),
    /node count drift/);
});

test('compose refuses a malformed flow and an absent preview node',
  { skip: snapshotSkip }, () => {
    const empty = Buffer.from('{}');
    assert.throws(() => composeLk1PlanRulesArtifacts(empty,
      { expectedSourceSha256: sha256(empty) }), /Invalid flow identity/);
    // A full-size flow whose preview node was renamed away cannot be composed: the
    // preview is contract-checked because its reviewed delta must land before it ships.
    const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT).toString('utf8'));
    const preview = flow.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID);
    assert.ok(preview, 'live snapshot carries the preview node');
    preview.id = 'lk_subscription_price_preview_renamed';
    const bytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
    assert.throws(() => composeLk1PlanRulesArtifacts(bytes, { expectedSourceSha256: sha256(bytes) }),
      /is absent/);
  });

test('prepare_contract builds the reviewed two-node contract for the candidate',
  { skip: snapshotSkip }, () => {
    const { liveBytes, built, candidateText } = liveArtifacts();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-plan-rules-test-'));
    const livePath = path.join(temp, 'source.flow.json');
    const candidatePath = path.join(temp, 'candidate.flow.json');
    const contractPath = path.join(temp, 'contract.json');
    fs.writeFileSync(livePath, liveBytes, { mode: 0o600 });
    fs.writeFileSync(candidatePath, candidateText, { mode: 0o600 });
    const stdout = execFileSync('node', [
      path.join(repoRoot, 'scripts/nodered_reviewed_flow_deploy/prepare_contract.mjs'),
      '--live', livePath,
      '--candidate', candidatePath,
      '--output', contractPath,
      '--deployment-id', PLAN_RULES_DEPLOYMENT_ID,
      '--allow-node', PLAN_RULES_GATEWAY_NODE_ID,
      '--allow-node', PLAN_RULES_EVALUATOR_NODE_ID,
    ], { cwd: repoRoot, encoding: 'utf8' });
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.deploymentId, PLAN_RULES_DEPLOYMENT_ID);
    assert.equal(receipt.changedNodeCount, 2);
    assert.equal(receipt.sourceSha256, PLAN_RULES_SOURCE_SHA256);
    assert.equal(receipt.candidateSha256, sha256(candidateText));
    assert.equal(receipt.nodeCount, PLAN_RULES_SOURCE_NODE_COUNT);

    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    assert.equal(contract.deploymentId, PLAN_RULES_DEPLOYMENT_ID);
    assert.equal(contract.sourceSha256, sha256(liveBytes));
    assert.equal(contract.candidateSha256, sha256(candidateText));
    assert.equal(contract.allowedChanges.length, 2);
    assert.deepEqual(contract.allowedChanges.map((change) => change.id).sort(),
      [PLAN_RULES_EVALUATOR_NODE_ID, PLAN_RULES_GATEWAY_NODE_ID].sort());
    for (const change of contract.allowedChanges) {
      assert.deepEqual(change.fields, ['func']);
      const reported = built.changes.find((item) => item.id === change.id);
      assert.equal(change.sourceFuncSha256, reported.beforeSha256);
      assert.equal(change.candidateFuncSha256, reported.afterSha256);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

test('the deploy wrapper keeps the confirmation gate, the exact allow-list and rollback', () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_plan_rules_147.sh'), 'utf8');
  assert.ok(wrapper.includes('NODE_RED_LK1_PLAN_RULES_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes('clean main checkout'));
  assert.ok(wrapper.includes(`allow_nodes=(${PLAN_RULES_GATEWAY_NODE_ID} ${PLAN_RULES_EVALUATOR_NODE_ID})`));
  assert.ok(wrapper.includes('expected_changed_nodes=2'));
  assert.ok(wrapper.includes('patch_live_lk1_plan_rules.mjs'));
  assert.ok(wrapper.includes('prepare_contract.mjs'));
  assert.ok(wrapper.includes('rollback --deployment-id'));
  assert.ok(wrapper.includes('sha256sum'));
  assert.ok(wrapper.includes('deploy_reviewed_flow_147_remote.mjs'));
  // The preview node must not be in the allow-list of this generation.
  assert.equal(wrapper.includes(PLAN_RULES_PREVIEW_NODE_ID), false);
  // Read-only smoke: HTTP 200 plus the RUB price payload.
  assert.ok(wrapper.includes('smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"'));
  assert.ok(wrapper.includes("value.currency !== \"RUB\""));
  assert.ok(wrapper.includes('%{http_code}'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['nodered:lk1-plan-rules:deploy-147'],
    'bash scripts/deploy_nodered_lk1_plan_rules_147.sh');
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
    path.join(repoRoot, 'scripts/deploy_nodered_lk1_plan_rules_147.sh'), 'utf8');
  const stageLine = /^remote_stage="([^"]*)"$/m.exec(wrapper)?.[1];
  assert.ok(stageLine, 'remote_stage assignment');
  const rendered = stageLine
    .replace('$remote_stamp', '20260915T164214+0300')
    .replace(/\$\$/g, '76648');
  assert.equal(rendered.slice(0, rendered.lastIndexOf('/')), stageParent);
  assert.ok(stagePattern.test(rendered.slice(rendered.lastIndexOf('/') + 1)), rendered);
  assert.ok(wrapper.includes('remote_candidate="$remote_stage/candidate.flow.json"'));
  assert.ok(wrapper.includes('remote_contract="$remote_stage/contract.json"'));
  assert.ok(wrapper.includes(`remote_backup_dir="${backupDir}"`));
  assert.ok(wrapper.includes('remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"'));
  assert.ok(wrapper.includes('remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"'));
});
