import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REFERRAL_ATTRIBUTION_BINDING_STATE,
  REFERRAL_ATTRIBUTION_TARGETS,
  sha256
} from '../lib/referralAttributionReleaseContract.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDITOR = path.join(REPO_ROOT, 'scripts/audit_referral_attribution_release_preimages.mjs');
const BUILDER = path.join(REPO_ROOT, 'scripts/prepare_referral_attribution_release_candidate.mjs');
const UNBOUND_ERROR = /Referral attribution release candidate is unbound after Piter atomic sales; rebuild and review an exact-graph candidate before reuse/;
const roots = [];

function createWorkspace({ sourceHost = 'lk-primary-147' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'referral-attribution-candidate-')));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);

  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  const sourceText = '[]\n';
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost,
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    nodeCount: 0
  }, null, 2)}\n`, { mode: 0o600 });
  return workspace;
}

function runAudit(workspace) {
  return spawnSync(process.execPath, [AUDITOR, '--workspace', workspace], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
}

function runBuilder(workspace) {
  const contractPath = path.join(workspace, 'unbound-contract.json');
  fs.writeFileSync(contractPath, '{}\n', { mode: 0o600 });
  return spawnSync(process.execPath, [
    BUILDER,
    '--workspace', workspace,
    '--contract', contractPath,
    '--expected-contract-sha256', sha256(fs.readFileSync(contractPath)),
    '--output-dir', path.join(workspace, 'referral-attribution-candidate')
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('referral attribution function-only release contract is explicitly unbound after atomic Piter sales', () => {
  assert.equal(REFERRAL_ATTRIBUTION_BINDING_STATE, 'UNBOUND_AFTER_PITER_ATOMIC_SALES');
  assert.ok(REFERRAL_ATTRIBUTION_TARGETS.some(({ id }) => id === '91dded2dc8cfebe4'));
  assert.ok(REFERRAL_ATTRIBUTION_TARGETS.some(({ id }) => id === '566ae4b886c37ae5'));
});

test('referral audit and builder fail closed without creating review or candidate artifacts', () => {
  const auditWorkspace = createWorkspace();
  const audit = runAudit(auditWorkspace);
  assert.notEqual(audit.status, 0);
  assert.match(audit.stderr, UNBOUND_ERROR);
  assert.equal(fs.existsSync(path.join(auditWorkspace, 'referral-attribution-review')), false);

  const builderWorkspace = createWorkspace();
  const builder = runBuilder(builderWorkspace);
  assert.notEqual(builder.status, 0);
  assert.match(builder.stderr, UNBOUND_ERROR);
  assert.equal(fs.existsSync(path.join(builderWorkspace, 'referral-attribution-candidate')), false);
});

test('referral audit rejects invalid source provenance before reporting the unbound release state', () => {
  const workspace = createWorkspace({ sourceHost: 'untrusted-host' });
  const result = runAudit(workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node-RED source metadata mismatch for sourceHost/);
  assert.doesNotMatch(result.stderr, UNBOUND_ERROR);
  assert.equal(fs.existsSync(path.join(workspace, 'referral-attribution-review')), false);
});
