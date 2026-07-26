import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PULL_SCRIPT = path.join(REPO_ROOT, 'scripts/pull_nodered_source_from_147.sh');
const VERIFY_SCRIPT = path.join(REPO_ROOT, 'scripts/verify_nodered_source_origin.mjs');
const MODULAR_SCRIPT = path.join(REPO_ROOT, 'scripts/nodered_modular_flow.mjs');
const TEMP_ROOTS = [];

function tempRoot(prefix = 'lk-nodered-toolchain-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const canonical = fs.realpathSync(directory);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureFlow(overrides = {}) {
  const selectedLabel = overrides.selectedLabel ?? 'LK Games';
  const linkTarget = overrides.brokenLink ? 'outside-node' : 'link-in';
  return [
    { id: 'tab-games', type: 'tab', label: selectedLabel, disabled: Boolean(overrides.disabled) },
    { id: 'tab-other', type: 'tab', label: 'Other', disabled: false },
    ...(overrides.duplicateLabel
      ? [{ id: 'tab-games-duplicate', type: 'tab', label: selectedLabel, disabled: false }]
      : []),
    { id: 'http-in', type: 'http in', z: 'tab-games', method: 'get', url: '/lk/games', wires: [['fn']] },
    { id: 'fn', type: 'function', z: 'tab-games', name: 'List games', func: 'return msg;', wires: [['link-out']] },
    { id: 'link-out', type: 'link out', z: 'tab-games', links: [linkTarget], wires: [] },
    { id: 'link-in', type: 'link in', z: 'tab-games', links: ['link-out'], wires: [['http-response']] },
    { id: 'http-response', type: 'http response', z: 'tab-games', wires: [] },
    { id: 'other-node', type: 'function', z: 'tab-other', func: 'return msg;', wires: [] },
    { id: 'mongo-config', type: 'mongodb4-client', name: 'private config' },
  ];
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createVerifiedWorkspace(flow = fixtureFlow(), options = {}) {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  fs.writeFileSync(sourcePath, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  const meta = {
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost: 'lk-primary-147',
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: options.pulledAt ?? new Date().toISOString(),
    sourceSha256: sha256(sourcePath),
    nodeCount: flow.length,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, input, sourcePath, metaPath };
}

function modularArgs(command, workspace, selector = ['--source-tab-label', 'LK Games']) {
  return [MODULAR_SCRIPT, command, '--workspace', workspace, ...selector];
}

test('pull uses the exact live origin and atomically creates a private external input', () => {
  const root = tempRoot();
  const fixturePath = path.join(root, 'fixture.json');
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixtureFlow())}\n`);
  const fakeBin = path.join(root, 'bin');
  const fakeLog = path.join(root, 'scp.args');
  fs.mkdirSync(fakeBin);
  const fakeScp = path.join(fakeBin, 'scp');
  fs.writeFileSync(
    fakeScp,
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$@" > "$FAKE_SCP_LOG"\ncp "$FAKE_FLOW" "${@: -1}"\n',
  );
  fs.chmodSync(fakeScp, 0o700);
  const workspace = path.join(root, 'live-workspace');
  const beforeStatus = run('git', ['status', '--porcelain']).stdout;
  const result = run('bash', [PULL_SCRIPT, workspace], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_SCP_LOG: fakeLog,
      FAKE_FLOW: fixturePath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^sourceSha256=[a-f0-9]{64}\nnodeCount=9\n$/);
  assert.equal(run('git', ['status', '--porcelain']).stdout, beforeStatus);
  const scpArgs = fs.readFileSync(fakeLog, 'utf8').trim().split('\n');
  assert.deepEqual(
    scpArgs.slice(0, 4),
    ['-q', '-P', '22', 'root@lk-primary-147:/root/.node-red/flows.json'],
  );
  assert.match(
    scpArgs[4],
    new RegExp(`^${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.pull-stage-\\d+/source\\.flow\\.json$`),
  );
});

test('verify, build, and validate preserve only the exact selected tab nodes', () => {
  const { workspace } = createVerifiedWorkspace();
  const verify = run('node', [VERIFY_SCRIPT, '--workspace', workspace]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /^sourceSha256=[a-f0-9]{64}\nnodeCount=9\nfreshnessSeconds=\d+\n$/);

  const build = run('node', modularArgs('build', workspace));
  assert.equal(build.status, 0, build.stderr);
  assert.match(
    build.stdout,
    /^sourceSha256=[a-f0-9]{64}\ncandidateSha256=[a-f0-9]{64}\nselectedNodeCount=5\nhttpInputCount=1\nbrokenWireCount=0\nbrokenLinkCount=0\n$/,
  );
  const validate = run('node', modularArgs('validate', workspace));
  assert.equal(validate.status, 0, validate.stderr);

  const buildDirectory = path.join(workspace, 'build');
  const candidatePath = path.join(buildDirectory, 'selected-tab.nodes.json');
  const reportPath = path.join(buildDirectory, 'validation.json');
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
  assert.equal(fs.statSync(buildDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(candidatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  assert.deepEqual(candidate.map((node) => node.id), ['http-in', 'fn', 'link-out', 'link-in', 'http-response']);
  assert.equal(candidate.some((node) => node.type === 'tab'), false);
  assert.equal(candidate.some((node) => !node.z), false);
  assert.equal(candidate.some((node) => node.z !== 'tab-games'), false);

  const secondBuild = run('node', modularArgs('build', workspace));
  assert.notEqual(secondBuild.status, 0);
  assert.match(secondBuild.stderr, /build output already exists/);
});

test('validate rejects a tampered validation report', () => {
  const { workspace } = createVerifiedWorkspace();
  const build = run('node', modularArgs('build', workspace));
  assert.equal(build.status, 0, build.stderr);

  const reportPath = path.join(workspace, 'build', 'validation.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.validation.stats.httpInputCount = 999;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.chmodSync(reportPath, 0o600);

  const validate = run('node', modularArgs('validate', workspace));
  assert.notEqual(validate.status, 0);
  assert.match(validate.stderr, /validation report does not match/i);
});

test('validate redacts malformed candidate and report contents', () => {
  const malformedCandidate = createVerifiedWorkspace();
  const candidateBuild = run('node', modularArgs('build', malformedCandidate.workspace));
  assert.equal(candidateBuild.status, 0, candidateBuild.stderr);
  const candidatePath = path.join(
    malformedCandidate.workspace,
    'build',
    'selected-tab.nodes.json',
  );
  const candidateSecret = 'SECRET_CANDIDATE_729ad853';
  fs.writeFileSync(candidatePath, `[{ "${candidateSecret}": ]`);
  fs.chmodSync(candidatePath, 0o600);

  const candidateValidate = run('node', modularArgs('validate', malformedCandidate.workspace));
  assert.notEqual(candidateValidate.status, 0);
  assert.match(candidateValidate.stderr, /nodes-only candidate must contain valid JSON/);
  assert.doesNotMatch(candidateValidate.stderr + candidateValidate.stdout, new RegExp(candidateSecret));

  const malformedReport = createVerifiedWorkspace();
  const reportBuild = run('node', modularArgs('build', malformedReport.workspace));
  assert.equal(reportBuild.status, 0, reportBuild.stderr);
  const reportPath = path.join(malformedReport.workspace, 'build', 'validation.json');
  const reportSecret = 'SECRET_REPORT_21d6624b';
  fs.writeFileSync(reportPath, `{ "${reportSecret}": ]`);
  fs.chmodSync(reportPath, 0o600);

  const reportValidate = run('node', modularArgs('validate', malformedReport.workspace));
  assert.notEqual(reportValidate.status, 0);
  assert.match(reportValidate.stderr, /validation report must contain valid JSON/);
  assert.doesNotMatch(reportValidate.stderr + reportValidate.stdout, new RegExp(reportSecret));
});

test('selector must resolve to exactly one enabled tab', () => {
  const disabled = createVerifiedWorkspace(fixtureFlow({ disabled: true }));
  const disabledResult = run('node', modularArgs('build', disabled.workspace));
  assert.notEqual(disabledResult.status, 0);
  assert.match(disabledResult.stderr, /disabled/);

  const duplicate = createVerifiedWorkspace(fixtureFlow({ duplicateLabel: true }));
  const duplicateResult = run('node', modularArgs('build', duplicate.workspace));
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /matched 2/);

  const both = createVerifiedWorkspace();
  const bothResult = run('node', [
    MODULAR_SCRIPT,
    'build',
    '--workspace',
    both.workspace,
    '--source-tab-label',
    'LK Games',
    '--source-tab-id',
    'tab-games',
  ]);
  assert.notEqual(bothResult.status, 0);
  assert.match(bothResult.stderr, /Exactly one/);
});

test('stale metadata, hardlinks, partial output, and cross-tab links fail closed', () => {
  const stale = createVerifiedWorkspace(fixtureFlow(), {
    pulledAt: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
  });
  const staleResult = run('node', [VERIFY_SCRIPT, '--workspace', stale.workspace]);
  assert.notEqual(staleResult.status, 0);
  assert.match(staleResult.stderr, /stale/);

  const linked = createVerifiedWorkspace();
  const linkedCopy = path.join(linked.input, 'source.flow.hardlink.json');
  fs.linkSync(linked.sourcePath, linkedCopy);
  const hardlinkResult = run('node', [VERIFY_SCRIPT, '--workspace', linked.workspace]);
  assert.notEqual(hardlinkResult.status, 0);
  assert.match(hardlinkResult.stderr, /hard-linked/);

  const partial = createVerifiedWorkspace();
  fs.mkdirSync(path.join(partial.workspace, '.build-stage-interrupted'), { mode: 0o700 });
  const partialResult = run('node', modularArgs('build', partial.workspace));
  assert.notEqual(partialResult.status, 0);
  assert.match(partialResult.stderr, /Partial/);

  const broken = createVerifiedWorkspace(fixtureFlow({ brokenLink: true }));
  const brokenResult = run('node', modularArgs('build', broken.workspace));
  assert.notEqual(brokenResult.status, 0);
  assert.match(brokenResult.stderr, /linkTargetsPreserved/);
  assert.equal(fs.existsSync(path.join(broken.workspace, 'build')), false);
  assert.equal(
    fs.readdirSync(broken.workspace).some((name) => name.startsWith('.build-stage-')),
    false,
  );
});

test('repository and symlink workspace aliases are rejected before publication', () => {
  const insideRepo = path.join(
    REPO_ROOT,
    `.nodered-live-workspace-rejected-${process.pid}-${crypto.randomUUID()}`,
  );
  assert.equal(fs.existsSync(insideRepo), false);
  const repoResult = run('bash', [PULL_SCRIPT, insideRepo]);
  assert.notEqual(repoResult.status, 0);
  assert.match(repoResult.stderr, /outside the repository/);
  assert.equal(fs.existsSync(insideRepo), false);

  const root = tempRoot();
  const actual = path.join(root, 'actual');
  fs.mkdirSync(actual, { mode: 0o700 });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(actual, alias);
  const aliasResult = run('node', [VERIFY_SCRIPT, '--workspace', alias]);
  assert.notEqual(aliasResult.status, 0);
  assert.match(aliasResult.stderr, /real directory|canonical/);
});
