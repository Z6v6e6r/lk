// Explicit owner-run DEV adaptation of the existing atomic static publisher.
// No bootstrap, routing, backend, font or opposite-channel mutations here.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploy } from './frontend-release.mjs';
import { releaseArtifactNames } from './lib/build-env.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';

export const devFiles = Object.freeze([...releaseArtifactNames('release-dev.json'), 'release-dev.json']);
export const DEV_CURRENT_ROOT = '/var/www/html/lk-frontend-dev-current';
export const DEV_RELEASES_ROOT = '/var/www/html/lk-frontend-dev-releases';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const run = (command, args, options = {}) => execFileSync(command, args,
  { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });

export function devInventory(directory) {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) throw new Error('Canonical external DEV directory required');
  const hashes = Object.fromEntries(devFiles.map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('DEV artifact must be regular and unaliased');
    return [name, hash(fs.readFileSync(file))];
  }));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-dev.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') || manifest.sourceDirty !== false
    || !/^[A-Za-z0-9._-]{1,100}$/.test(manifest.version || '')) throw new Error('DEV provenance unavailable');
  return { source: manifest.sourceCommit, version: manifest.version, hashes };
}

export function devUploadEnvironment(directory, destination, expected, token) {
  if (!/^[a-f0-9]{32}$/.test(token) || !/^[a-f0-9]{40}$/.test(expected.source)
    || destination !== `${DEV_RELEASES_ROOT}/${expected.source}-${token.slice(0, 16)}`) {
    throw new Error('DEV upload destination differs from acquired immutable identity');
  }
  return { DEPLOY_TARGETS: `lk-reserve-89:${destination}`, DEPLOY_DIST_DIR: directory,
    DEPLOY_DEV_ISOLATED: '1', DEPLOY_PRUNE_OPPOSITE_CHANNEL: '0', DEPLOY_USE_SUDO: '0' };
}

async function readback(expected) {
  for (const name of devFiles) {
    const response = await fetch(`https://lk-reserve.tsup.space/lk/${name}?v=${encodeURIComponent(expected.version)}`,
      { signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store' });
    if (!response.ok || hash(Buffer.from(await response.arrayBuffer())) !== expected.hashes[name]) throw new Error(`DEV public bytes mismatch: ${name}`);
    if (name === 'release-dev.json' && !/no-store|no-cache/.test(response.headers.get('cache-control') || '')) throw new Error('DEV manifest cache guard missing');
  }
}

async function main() {
  const provenance = readRepositoryProvenance(repo);
  if (process.argv.length !== 3 || provenance.sourceDirty
    || process.env.LK1_DEV_FRONTEND_APPLY !== 'CONFIRM_RESERVE_89'
    || process.env.LK1_DEV_APPROVED_SOURCE !== provenance.sourceCommit) throw new Error('Exact clean source and explicit reserve DEV owner grant required');
  if (process.env.LK_FRONTEND_SMOKE_URL !== 'https://padlhub.ru/lk_dev') throw new Error('Approved LK1 DEV UI smoke required');
  for (const key of ['LK_FRONTEND_SMOKE_SELECTOR', 'LK_FRONTEND_SMOKE_OPEN_SELECTOR', 'LK_FRONTEND_SMOKE_RESULT_SELECTOR']) {
    if (!process.env[key]) throw new Error('DEV UI smoke selector missing');
  }
  const directory = process.argv[2];
  run(process.execPath, ['scripts/assert-clean-deploy.mjs', path.join(directory, 'release-dev.json')]);
  const expected = devInventory(directory);
  if (expected.source !== provenance.sourceCommit) throw new Error('DEV artifact source mismatch');
  const remoteCode = fs.readFileSync(path.join(repo, 'scripts/frontend-release-remote.py'), 'utf8');
  const remote = request => JSON.parse(run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    'lk-reserve-89', `python3 -c ${quote(remoteCode)} --dev-only`], { input: JSON.stringify(request) }));
  const previous = remote({ op: 'inspect' });
  await readback(previous);
  const token = randomBytes(16).toString('hex');
  const result = await deploy({ remote, previous, expected, token,
    upload: destination => {
      if (JSON.stringify(devInventory(directory)) !== JSON.stringify(expected)) throw new Error('DEV local bytes drifted');
      run('bash', ['scripts/deploy-lk.sh', 'dev'], { stdio: 'inherit', env: { ...process.env,
        ...devUploadEnvironment(directory, destination, expected, token) } });
    },
    smoke: async state => {
      await readback(state);
      run(process.execPath, ['scripts/frontend-smoke.mjs'], { stdio: 'inherit', env: { ...process.env,
        LK_SMOKE_VERSION: state.version, LK_SMOKE_CHANNEL: 'dev' } });
    },
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
