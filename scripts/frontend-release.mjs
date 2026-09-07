import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyRange } from './delivery-policy.mjs';
import { releaseArtifactNames } from './lib/build-env.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';

export const files = [...releaseArtifactNames('release.json'), 'release.json', ...[
  'rf-dewi-ultrabold', 'rf-dewi-expanded-ultrabold-italic', 'SourceCodePro-Medium', 'SourceCodePro-Regular',
].map(name => `fonts/${name}.woff2`)];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });

export function remoteRequest(request) {
  const codeHash = hash(readFileSync(new URL('./frontend-release-remote.py', import.meta.url)));
  return JSON.parse(run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'lk-primary-147', `lk-frontend-v1 ${codeHash}`], { input: JSON.stringify(request) }));
}

export function assertStandardRange(previous, source, policySha) {
  if (!/^[a-f0-9]{40}$/.test(policySha || '')) throw new Error('Owner activation commit is missing');
  run('git', ['merge-base', '--is-ancestor', policySha, source]);
  const policyDiff = classifyRange(policySha, source);
  if (policyDiff.entries.some(entry => entry.profile === 'release')) throw new Error('Release mechanism changed since owner activation');
  const result = classifyRange(previous.source, source);
  if (!result.frontendEligible) throw new Error(`Accumulated release requires ${result.profile} review; standard frontend release blocked`);
  return result;
}

export function localInventory() {
  const manifest = JSON.parse(readFileSync('dist/release.json', 'utf8'));
  return { source: manifest.sourceCommit, version: manifest.version,
    hashes: Object.fromEntries(files.map(name => [name, hash(readFileSync(name.startsWith('fonts/') ? `src/${name}` : `dist/${name}`))])) };
}

export async function publicReadback(base, expected) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Public HTTPS asset base required');
  for (const name of files) {
    const response = await fetch(`${base.replace(/\/$/, '')}/${name}?v=${encodeURIComponent(expected.version)}`, { signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'error' });
    if (!response.ok || hash(Buffer.from(await response.arrayBuffer())) !== expected.hashes[name]) throw new Error(`Public artifact mismatch: ${name}`);
    if (name === 'release.json' && !/no-store|no-cache/.test(response.headers.get('cache-control') || '')) throw new Error('Release manifest must bypass Safari cache');
  }
}

export async function deploy({ remote, upload, smoke, previous, expected, token }) {
  let acquired = false;
  try {
    const { destination } = remote({ op: 'acquire', token, previous, candidate: `${expected.source}-${token.slice(0, 16)}` });
    acquired = true;
    upload(destination);
    remote({ op: 'publish', token, expected });
    await smoke(expected);
    remote({ op: 'finish', token });
    return { status: 'SUCCESS', source: expected.source, previous: previous.source };
  } catch (error) {
    if (acquired) {
      try {
        remote({ op: 'rollback', token });
        await smoke(previous);
        remote({ op: 'finish', token, rolledBack: true });
      } catch {
        throw new Error(`Release failed; recovery incomplete, lease retained: ${error.message}`);
      }
    }
    throw new Error(`Release stopped${acquired ? '; previous complete set restored and verified' : ''}: ${error.message}`);
  }
}

async function main() {
  const repository = readRepositoryProvenance(process.cwd());
  if (repository.sourceDirty || repository.sourceCommit !== process.env.RELEASE_SOURCE_SHA
    || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.LK_STANDARD_FRONTEND_ENABLED !== 'true') throw new Error('Trusted clean main source and owner enablement required');
  for (const key of ['LK_FRONTEND_ASSET_BASE', 'LK_FRONTEND_SMOKE_URL', 'LK_FRONTEND_SMOKE_SELECTOR', 'LK_FRONTEND_SMOKE_OPEN_SELECTOR', 'LK_FRONTEND_SMOKE_RESULT_SELECTOR']) {
    if (!process.env[key]) throw new Error(`Owner smoke configuration missing: ${key}`);
  }
  if (new URL(process.env.LK_FRONTEND_SMOKE_URL).protocol !== 'https:') throw new Error('HTTPS smoke URL required');
  // Workflow separately checks server-owned branch protection, CI event and exact source.
  const remote = remoteRequest;
  const previous = remote({ op: 'inspect' });
  const range = assertStandardRange(previous, repository.sourceCommit, process.env.LK_FRONTEND_POLICY_SHA);
  await publicReadback(process.env.LK_FRONTEND_ASSET_BASE, previous);
  run('npm', ['run', 'build:prod'], { stdio: 'inherit' });
  run('npm', ['run', 'release:preflight:prod'], { stdio: 'inherit' });
  run('npm', ['run', 'package:upload:prod'], { stdio: 'inherit' });
  const expected = localInventory();
  const token = randomBytes(16).toString('hex');
  const smoke = async state => {
    await publicReadback(process.env.LK_FRONTEND_ASSET_BASE, state);
    run('node', ['scripts/frontend-smoke.mjs'], { stdio: 'inherit', env: { ...process.env, LK_SMOKE_VERSION: state.version } });
  };
  const result = await deploy({ previous, expected, token, remote, smoke,
    upload: destination => run('bash', ['scripts/deploy-lk.sh', 'prod'], { stdio: 'inherit', env: { ...process.env,
      DEPLOY_TARGETS: `lk-primary-147:${destination}`, DEPLOY_PRUNE_OPPOSITE_CHANNEL: '0', DEPLOY_USE_SUDO: '0',
      DEPLOY_FRONTEND_TRANSPORT: 'forced-command-v1', DEPLOY_FRONTEND_LEASE_TOKEN: token,
    } }),
  });
  writeFileSync(`${process.env.RUNNER_TEMP}/frontend-release-result.json`, JSON.stringify({ ...result, range, observedAt: new Date().toISOString() }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); if (process.env.RUNNER_TEMP) writeFileSync(`${process.env.RUNNER_TEMP}/frontend-release-result.json`, JSON.stringify({ status: 'BLOCKED_OR_FAILED', reason: error.message, source: process.env.RELEASE_SOURCE_SHA, observedAt: new Date().toISOString() })); process.exitCode = 1; });
