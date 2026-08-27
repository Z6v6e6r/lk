import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REFERRAL_ATTRIBUTION_DEBUG_GUARDS,
  REFERRAL_ATTRIBUTION_TARGETS,
  sha256
} from '../lib/referralAttributionReleaseContract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDITOR = path.join(REPO_ROOT, 'scripts/audit_referral_attribution_release_preimages.mjs');
const BUILDER = path.join(REPO_ROOT, 'scripts/prepare_referral_attribution_release_candidate.mjs');
const roots = [];

function vulnerableCredentialBody(name) {
  return `const tokenBody = "grant_type=password&username=REDACTED_${name}&password=REDACTED_PASSWORD";\nmsg.payload = tokenBody;\nreturn msg;`;
}

function vulnerableObjectCredentialBody(name) {
  return `msg.payload = { grant_type: "password", username: "REDACTED_${name}", password: "REDACTED_PASSWORD" };\nreturn msg;`;
}

function createWorkspace({ activeDebug = false, unexpectedEnabledTarget = false, disabledTarget = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'referral-attribution-candidate-')));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const flow = [
    { id: 'f9575c8726e29196', type: 'tab', label: 'LK Tournaments', disabled: false },
    { id: 'ac5d37d8ebd616ca', type: 'tab', label: 'LK Referral Subscriptions', disabled: false },
    { id: '8ccb70ac6befff79', type: 'tab', label: 'Media2', disabled: true },
    { id: 'credential-subflow', type: 'subflow', name: 'Credential subflow' },
    { id: 'credential-subflow-instance', type: 'subflow:credential-subflow', z: 'f9575c8726e29196', name: 'Credential subflow instance', wires: [[]] },
    ...REFERRAL_ATTRIBUTION_TARGETS.map((target) => ({
      id: target.id,
      type: 'function',
      z: target.tabId,
      name: target.name,
      func: target.purposes.includes('credential')
        ? vulnerableCredentialBody(target.id)
        : 'msg.legacyAttribution = true;\nreturn msg;',
      d: disabledTarget && target.id === '8fe574816fd8bfd7',
      outputs: 3,
      wires: [[], [], []]
    })),
    ...REFERRAL_ATTRIBUTION_DEBUG_GUARDS.map((guard, index) => ({
      id: guard.id,
      type: 'debug',
      z: guard.tabId,
      name: guard.name,
      active: activeDebug && index === 0,
      wires: []
    })),
    {
      id: 'unmanaged-active-token',
      type: 'function',
      z: 'f9575c8726e29196',
      name: 'Unmanaged active token',
      func: vulnerableCredentialBody('unmanaged'),
      wires: [[]]
    },
    {
      id: 'unmanaged-object-token',
      type: 'function',
      z: 'ac5d37d8ebd616ca',
      name: 'Unmanaged object token',
      func: vulnerableObjectCredentialBody('object-unmanaged'),
      wires: [[]]
    },
    {
      id: 'unmanaged-subflow-token',
      type: 'function',
      z: 'credential-subflow',
      name: 'Unmanaged subflow token',
      func: vulnerableCredentialBody('subflow-unmanaged'),
      wires: [[]]
    },
    {
      id: 'disabled-unmanaged-token',
      type: 'function',
      z: 'ac5d37d8ebd616ca',
      name: 'Disabled unmanaged token',
      func: vulnerableCredentialBody('disabled-unmanaged'),
      d: true,
      wires: [[]]
    },
    {
      id: 'disabled-duplicate',
      type: 'function',
      z: '8ccb70ac6befff79',
      name: 'Prepare tournament subscription purchase',
      func: vulnerableCredentialBody('disabled'),
      wires: [[]]
    },
    ...(unexpectedEnabledTarget ? [{
      id: 'unexpected-enabled-target',
      type: 'function',
      z: 'f9575c8726e29196',
      name: 'Prepare referral subscription status',
      func: vulnerableCredentialBody('unexpected'),
      wires: [[]]
    }] : []),
    { id: 'unrelated', type: 'function', z: 'f9575c8726e29196', name: 'Unrelated', func: 'return msg;', wires: [[]] }
  ];
  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost: 'lk-primary-147',
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    nodeCount: flow.length
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { workspace, flow };
}

function runAudit(workspace) {
  return spawnSync(process.execPath, [AUDITOR, '--workspace', workspace], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
}

function approveContract(workspace) {
  const contractPath = path.join(
    workspace,
    'referral-attribution-review/referral-attribution.preimage-audit.json'
  );
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.approvalState = 'APPROVED';
  contract.providerRotationDecision = contract.providerRotationBlocked
    ? 'ROTATION_REMAINS_BLOCKED'
    : 'ROTATION_REQUIRES_SEPARATE_APPROVAL';
  for (const target of contract.targets) target.reviewDecision = 'APPROVED';
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(contractPath, 0o600);
  return { contractPath, contract, contractSha256: sha256(fs.readFileSync(contractPath)) };
}

function runBuilder(workspace, contractPath, contractSha256) {
  return spawnSync(process.execPath, [
    BUILDER,
    '--workspace', workspace,
    '--contract', contractPath,
    '--expected-contract-sha256', contractSha256,
    '--output-dir', path.join(workspace, 'referral-attribution-candidate')
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('reviewed contract builds an exact function-only candidate and keeps provider rotation blocked', () => {
  const { workspace, flow } = createWorkspace();
  const audit = runAudit(workspace);
  assert.equal(audit.status, 0, audit.stderr);
  const unboundAuditPath = path.join(
    workspace,
    'referral-attribution-review/referral-attribution.preimage-audit.json'
  );
  const unboundAuditText = fs.readFileSync(unboundAuditPath, 'utf8');
  assert.doesNotMatch(unboundAuditText, /REDACTED_PASSWORD/);
  assert.equal(fs.lstatSync(unboundAuditPath).mode & 0o777, 0o600);
  const { contractPath, contract, contractSha256 } = approveContract(workspace);
  assert.equal(contract.unmanagedActivePasswordGrantConsumerCount, 3);
  assert.equal(contract.activePasswordGrantConsumers.length, 10);
  assert.equal(
    contract.activePasswordGrantConsumers.find((item) => item.id === 'unmanaged-object-token')
      .hasInlineCredentialLiteral,
    true
  );
  assert.equal(
    contract.activePasswordGrantConsumers.find((item) => item.id === 'f8679e53edadc39b')
      .hasInlineCredentialLiteral,
    true
  );
  assert.equal(
    contract.targets.find((item) => item.id === 'f8679e53edadc39b')
      .candidateObservations.hasInlineCredentialLiteral,
    false
  );
  assert.equal(contract.providerRotationBlocked, true);

  const result = runBuilder(workspace, contractPath, contractSha256);
  assert.equal(result.status, 0, result.stderr);
  const output = path.join(workspace, 'referral-attribution-candidate');
  const candidate = JSON.parse(fs.readFileSync(path.join(output, 'referral-attribution.candidate.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.join(output, 'referral-attribution.report.json'), 'utf8'));
  assert.equal(report.changedNodeCount, REFERRAL_ATTRIBUTION_TARGETS.length);
  assert.equal(report.providerRotationBlocked, true);
  assert.equal(report.providerRotationDecision, 'ROTATION_REMAINS_BLOCKED');
  assert.equal(report.deployAuthorized, false);
  const sourceById = new Map(flow.map((node) => [node.id, node]));
  const changed = candidate.filter((node) => JSON.stringify(node) !== JSON.stringify(sourceById.get(node.id)));
  assert.deepEqual(changed.map((node) => node.id), REFERRAL_ATTRIBUTION_TARGETS.map((target) => target.id));
  for (const node of changed) {
    const source = node.func;
    const target = REFERRAL_ATTRIBUTION_TARGETS.find((item) => item.id === node.id);
    if (target.purposes.includes('credential')) {
      assert.match(source, /VIVACRM_TOKEN_REQUEST_BODY/);
      assert.doesNotMatch(source, /REDACTED_PASSWORD/);
    }
    if (target.purposes.includes('attribution')) {
      assert.match(source, /referralToken/);
      assert.match(source, /referralVisitId/);
    }
  }
  assert.match(candidate.find((node) => node.id === 'unmanaged-active-token').func, /REDACTED_PASSWORD/);
  assert.match(candidate.find((node) => node.id === 'unmanaged-object-token').func, /REDACTED_PASSWORD/);
});

test('builder refuses an unbound audit contract', () => {
  const { workspace } = createWorkspace();
  const audit = runAudit(workspace);
  assert.equal(audit.status, 0, audit.stderr);
  const contractPath = path.join(
    workspace,
    'referral-attribution-review/referral-attribution.preimage-audit.json'
  );
  const result = runBuilder(workspace, contractPath, sha256(fs.readFileSync(contractPath)));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approval contract identity mismatch/);
  assert.equal(fs.existsSync(path.join(workspace, 'referral-attribution-candidate')), false);
});

test('audit fails closed on active debug, disabled target and unexpected enabled target identity', () => {
  const active = createWorkspace({ activeDebug: true });
  const activeResult = runAudit(active.workspace);
  assert.notEqual(activeResult.status, 0);
  assert.match(activeResult.stderr, /debug guard mismatch/);

  const disabled = createWorkspace({ disabledTarget: true });
  const disabledResult = runAudit(disabled.workspace);
  assert.notEqual(disabledResult.status, 0);
  assert.match(disabledResult.stderr, /target identity mismatch/);

  const unexpected = createWorkspace({ unexpectedEnabledTarget: true });
  const unexpectedResult = runAudit(unexpected.workspace);
  assert.notEqual(unexpectedResult.status, 0);
  assert.match(unexpectedResult.stderr, /Unexpected enabled referral attribution target ids/);
});

test('builder refuses source drift after approval even when metadata is refreshed', () => {
  const { workspace } = createWorkspace();
  const audit = runAudit(workspace);
  assert.equal(audit.status, 0, audit.stderr);
  const { contractPath, contractSha256 } = approveContract(workspace);
  const sourcePath = path.join(workspace, 'input/source.flow.json');
  const metaPath = path.join(workspace, 'input/source.flow.meta.json');
  const flow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  flow.find((node) => node.id === '8fe574816fd8bfd7').func += '\n// drift';
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.sourceSha256 = sha256(sourceText);
  meta.nodeCount = flow.length;
  meta.pulledAt = new Date().toISOString();
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  const result = runBuilder(workspace, contractPath, contractSha256);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approval contract identity mismatch/);
});
