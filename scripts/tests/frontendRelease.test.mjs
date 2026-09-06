import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { deploy, files } from '../frontend-release.mjs';

const old = { source: '1'.repeat(40), version: 'old', hashes: {} };
const next = { source: '2'.repeat(40), version: 'new', hashes: {} };
test('frontend release uploads once, publishes whole set, observes and finishes', async () => {
  const calls = [];
  const result = await deploy({ previous: old, expected: next, token: 'a'.repeat(32),
    remote: request => { calls.push(request.op); return { destination: '/static/candidate' }; },
    upload: destination => calls.push('upload:' + destination), smoke: async () => calls.push('smoke'),
  });
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(calls, ['acquire', 'upload:/static/candidate', 'publish', 'smoke', 'finish']);
});

test('failed smoke restores previous set; ambiguous recovery retains blocking lease', async () => {
  const calls = [];
  await assert.rejects(deploy({ previous: old, expected: next, token: 'a'.repeat(32),
    remote: request => { calls.push(request.op); return {}; }, upload: () => {},
    smoke: async state => { if (state === next) throw new Error('broken load'); },
  }), /previous complete set restored/);
  assert.deepEqual(calls, ['acquire', 'publish', 'rollback', 'finish']);
  await assert.rejects(deploy({ previous: old, expected: next, token: 'a'.repeat(32),
    remote: request => { if (request.op === 'rollback') throw new Error('drift'); return {}; },
    upload: () => { throw new Error('upload failed'); }, smoke: async () => {},
  }), /recovery incomplete, lease retained/);
});

test('remote helper rehearses real filesystem publication, drift and guarded rollback', t => {
  const root = mkdtempSync(join(tmpdir(), 'lk-static-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location('release', 'scripts/frontend-release-remote.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root = pathlib.Path(sys.argv[1]).resolve(); releases = root / 'lk-frontend-releases'; releases.mkdir()
a = releases / ('1'*40 + '-' + 'a'*16); a.mkdir()
def fill(path, sha):
    (path/'fonts').mkdir()
    for name in m.FILES:
        (path/name).write_text('synthetic ' + name)
    (path/'release.json').write_text(json.dumps({'sourceCommit':sha,'sourceDirty':False,'version':sha}))
legacy=root/'lk'; legacy.mkdir()
for name in ['index.html','ffc-academy-lk.js','ffc-academy-lk-dev.js','release-dev.json']:
    (legacy/name).write_text('legacy ' + name)
legacy_before={p.name:p.read_bytes() for p in legacy.iterdir()}
fill(a, '1'*40); (root/'lk-frontend-current').symlink_to(a)
old = m.run({'op':'inspect'}, root); token='b'*32
for extra in ['bundle-dev.js', 'release-dev.json', 'index.html', 'ffc-academy-lk.js']:
    (a/extra).write_text('unrelated')
    try: m.run({'op':'inspect'}, root); raise AssertionError('foreign namespace accepted')
    except ValueError: pass
    (a/extra).unlink()
req={'op':'acquire','token':token,'previous':old,'candidate':'2'*40+'-'+'b'*16}
destination=pathlib.Path(m.run(req, root)['destination'])
try: m.run(req, root); raise AssertionError('concurrent acquisition allowed')
except ValueError: pass
fill(destination, '2'*40); expected=m.inventory(destination)
try: m.run({'op':'publish','token':token,'expected':old}, root); raise AssertionError('bad hash allowed')
except ValueError: pass
m.run({'op':'publish','token':token,'expected':expected}, root)
assert (root/'lk-frontend-current').resolve() == destination
(destination/'bundle.js').write_text('drift')
try: m.run({'op':'rollback','token':token}, root); raise AssertionError('unknown bytes overwritten')
except ValueError: pass
assert (releases/'.lease.json').exists()
(destination/'bundle.js').write_text('synthetic bundle.js')
m.run({'op':'rollback','token':token}, root)
m.run({'op':'finish','token':token,'rolledBack':True}, root)
assert m.run({'op':'inspect'}, root) == old
assert a.exists() and destination.exists()
assert legacy.is_dir() and not legacy.is_symlink()
assert {p.name:p.read_bytes() for p in legacy.iterdir()} == legacy_before
print('atomic publication, lease, hash drift, rollback and retention PASS')
`;
  const result = spawnSync('python3', ['-B', '-c', script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('existing upload command remains static-only and never prunes opposite channel in standard delivery', () => {
  const source = readFileSync('scripts/frontend-release.mjs', 'utf8');
  assert.match(source, /\['scripts\/deploy-lk.sh', 'prod'\]/);
  assert.match(source, /DEPLOY_PRUNE_OPPOSITE_CHANNEL: '0'/);
  assert.match(source, /package:upload:prod/);
  for (const path of ['scripts/frontend-release.mjs', 'scripts/frontend-release-remote.py', 'scripts/deploy-lk.sh']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:pm2|systemctl|mongosh|mongodb|flows\.json|nodered|node-red)/i);
  }
  assert.equal(files.length, 16);
  execFileSync('bash', ['-n', 'scripts/deploy-lk.sh']);
});

test('automation defaults off, PR checks have no production secrets and release is protected-source only', () => {
  const text = readFileSync('.github/workflows/lk-frontend-delivery.yml', 'utf8');
  const w = load(text);
  assert.deepEqual(Object.keys(w.on), ['workflow_run']);
  assert.equal(w.concurrency['cancel-in-progress'], false);
  for (const job of Object.values(w.jobs)) assert.match(job.if, /vars.LK_STANDARD_FRONTEND_ENABLED == 'true'/);
  assert.equal(w.jobs['ready-pr'].steps[0].with.ref, 'main');
  assert.equal(w.jobs['frontend-production'].environment, 'frontend-production');
  assert.match(w.jobs['frontend-production'].steps[0].with.ref, /workflow_run.head_sha/);
  assert.doesNotMatch(readFileSync('.github/workflows/lk1-subscription-enforcement.yml', 'utf8'), /secrets\./);
  const guard = readFileSync('scripts/frontend-delivery-github.mjs', 'utf8');
  for (const invariant of ['branch.protected', "run.event !== 'push'", "run.head_branch !== 'main'", "run.head_sha !== source", "step.conclusion === 'success'"]) assert.ok(guard.includes(invariant));
});

test('GitHub release gate rejects failed, cancelled, skipped, missing final check and unprotected source', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'lk-github-gate-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture', 'commit', '--allow-empty', '-qm', 'fixture']);
  const source = git(['rev-parse', 'HEAD']);
  const event = { workflow_run: { id: 1, repository: { full_name: 'Z6v6e6r/lk' }, name: 'LK1 Subscription Enforcement', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: source } };
  writeFileSync(join(cwd, 'event.json'), JSON.stringify(event));
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, 'bin/gh'), '#!/usr/bin/env node\nconst p=process.argv[3]; process.stdout.write(p.includes("/branches/") ? process.env.FIXTURE_BRANCH : process.env.FIXTURE_JOBS);\n', { mode: 0o755 });
  const invoke = (outcome, protectedBranch = true) => spawnSync(process.execPath, [new URL('../frontend-delivery-github.mjs', import.meta.url).pathname, 'release'], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}`, GITHUB_REPOSITORY: 'Z6v6e6r/lk', GITHUB_EVENT_PATH: join(cwd, 'event.json'), LK_FRONTEND_POLICY_SHA: source,
      FIXTURE_BRANCH: JSON.stringify({ protected: protectedBranch, commit: { sha: source } }),
      FIXTURE_JOBS: JSON.stringify({ jobs: [{ name: 'LK1 exact-head enforcement gate', conclusion: 'success', steps: outcome === 'missing' ? [] : [{ name: 'Required delivery result', conclusion: outcome }] }] }),
    },
  });
  assert.equal(invoke('success').status, 0);
  for (const outcome of ['failure', 'cancelled', 'skipped', 'missing']) {
    const result = invoke(outcome);
    assert.notEqual(result.status, 0, outcome);
    assert.match(result.stderr, /Mandatory delivery check did not succeed/);
  }
  assert.match(invoke('success', false).stderr, /Owner must protect main/);
});

test('nginx candidate redirects only exact standard paths and preserves every other source byte', async () => {
  const { buildFrontendStaticCandidate, sha256, CURRENT_ROOT } = await import('../nginx/prepare_frontend_static_bootstrap.mjs');
  const { legacyStaticServer, legacyReleaseLocation } = await import('./fixtures/frontendStaticNginx.mjs');
  const result = buildFrontendStaticCandidate(legacyStaticServer, sha256(legacyStaticServer));
  assert.equal(result.candidate.replace(result.fragment, legacyReleaseLocation), legacyStaticServer);
  assert.deepEqual(result.paths, files.map(name => `/lk/${name}`));
  assert.equal((result.fragment.match(/location = /g) || []).length, 16);
  assert.equal((result.fragment.match(/open_file_cache off;/g) || []).length, 16);
  assert.equal((result.fragment.match(/limit_except GET HEAD OPTIONS/g) || []).length, 16);
  assert.match(result.candidate, /alias \/var\/www\/html\/lk\/;/);
  assert.ok(result.fragment.includes(`alias ${CURRENT_ROOT}/bundle.js;`));
  assert.doesNotMatch(result.fragment, /bundle-dev|academy|index\.html|subscription-bookings|assets\//);
  assert.throws(() => buildFrontendStaticCandidate(legacyStaticServer, '0'.repeat(64)), /SHA mismatch/);
  assert.throws(() => buildFrontendStaticCandidate(result.candidate, result.candidateSha), /already present/);
  // An inline manifest closing brace must not consume the next backend block.
  const inline = legacyStaticServer.replace('    server_name fixture.invalid;', '    server_name fixture.invalid;\n    location ~ ^/invite/([^/?#]+)/?$ { return 200; }').replace('    }\n', '        # ignored brace }\n        add_header X-Fixture "quoted { }"; }\n')
    .replace('    location = /lk/subscription-bookings { return 200 "backend-contract-preserved"; }',
      '    location = /lk/subscription-bookings {\n        return 200 "backend-contract-preserved";\n    }');
  const inlineResult = buildFrontendStaticCandidate(inline, sha256(inline));
  const originalInline = inline.slice(inline.indexOf('    location = /lk/release.json'), inline.indexOf('\n    location = /lk/subscription-bookings'));
  assert.equal(inlineResult.candidate.replace(inlineResult.fragment + '\n', originalInline + '\n'), inline);
  assert.match(inlineResult.candidate, /location = \/lk\/subscription-bookings \{\n {8}return 200 "backend-contract-preserved";\n {4}\}/);
  const duplicate = legacyStaticServer.replace('    location ^~ /lk/', '    location = "/lk/bundle.js" { return 404; }\n    location ^~ /lk/');
  assert.throws(() => buildFrontendStaticCandidate(duplicate, sha256(duplicate)), /Existing exact route/);
  const crossed = legacyStaticServer.replace('    location ^~ /lk/', '}\nserver {\n    location ^~ /lk/');
  assert.throws(() => buildFrontendStaticCandidate(crossed, sha256(crossed)), /same server/);
});

test('offline bootstrap binds exact preimages, preserves source identity and refuses drift or overwrite', async t => {
  const fs = await import('node:fs');
  const { prepareBootstrap, sha256 } = await import('../nginx/prepare_frontend_static_bootstrap.mjs');
  const { legacyStaticServer } = await import('./fixtures/frontendStaticNginx.mjs');
  const root = mkdtempSync(join(tmpdir(), 'lk-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const distDir = join(root, 'dist'), fontsDir = join(root, 'fonts');
  mkdirSync(distDir); mkdirSync(fontsDir);
  const installed = { source: '1'.repeat(40), version: 'fixture-v1', hashes: {} };
  for (const name of files) {
    const value = name === 'release.json' ? JSON.stringify({ sourceCommit: installed.source, sourceDirty: false, version: installed.version }) : `fixture ${name}`;
    const destination = name.startsWith('fonts/') ? join(fontsDir, name.slice(6)) : join(distDir, name);
    writeFileSync(destination, value); installed.hashes[name] = sha256(value);
  }
  writeFileSync(join(distDir, 'index.html'), 'unrelated');
  const sourceNginx = join(root, 'nginx.conf'); writeFileSync(sourceNginx, legacyStaticServer);
  const args = { sourceNginx, expectedSourceSha: sha256(legacyStaticServer), installed, distDir, fontsDir, outDir: join(root, 'candidate') };
  const plan = prepareBootstrap(args);
  assert.equal(plan.installed.source, installed.source);
  assert.equal(plan.legacyDirectoryMutationAllowed, false);
  assert.equal(plan.liveMutationAuthorized, false);
  assert.equal(plan.activePath, '/var/www/html/lk-frontend-current');
  assert.equal(readFileSync(join(args.outDir, 'release/release.json'), 'utf8'), readFileSync(join(distDir, 'release.json'), 'utf8'));
  assert.equal(fs.existsSync(join(args.outDir, 'release/index.html')), false);
  assert.equal(fs.statSync(join(args.outDir, 'nginx.source.conf')).mode & 0o777, 0o600);
  assert.throws(() => prepareBootstrap(args), /EEXIST/);
  writeFileSync(join(distDir, 'bundle.js'), 'drift');
  assert.throws(() => prepareBootstrap({ ...args, outDir: join(root, 'drift') }), /artifact hash mismatch/);
  assert.equal(fs.existsSync(join(root, 'drift')), false);
});


test('real nginx rehearsal is a mandatory release-mechanism check', () => {
  const workflow = load(readFileSync('.github/workflows/lk1-subscription-enforcement.yml', 'utf8'));
  const gate = workflow.jobs['lk1-exact-head'].steps.find(step => step.id === 'check_static_nginx');
  assert.ok(gate);
  assert.equal(gate.if, "steps.route.outputs.profile == 'release'");
  assert.equal(gate.env.DELIVERY_CATEGORY, 'release');
  assert.equal(gate['continue-on-error'], undefined);
  assert.match(gate.run, /npm run test:frontend-static-nginx/);
  assert.match(gate.run, /docker pull nginx@sha256:[a-f0-9]{64}/);
});
