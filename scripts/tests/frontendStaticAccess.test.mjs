import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('static-only release account is confined by a real Linux sshd', { timeout: 330000 }, t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lk-static-sshd-'));
  const tag = `lk-static-access-fixture:${process.pid}-${Date.now()}`;
  const name = `lk-static-access-${process.pid}-${Date.now()}`;
  t.after(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
    spawnSync('docker', ['image', 'rm', tag], { stdio: 'ignore', timeout: 10000 });
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Never send the repository or any private/local artifacts as Docker context.
  for (const [source, name] of [
    ['scripts/tests/fixtures/frontend_static_access.Dockerfile', 'Dockerfile'],
    ['scripts/tests/fixtures/frontend_static_access.py', 'test.py'],
    ['scripts/frontend-release-remote.py', 'frontend-release-remote.py'],
    ['scripts/ssh/lk-frontend.conf', 'lk-frontend.conf'],
  ]) fs.copyFileSync(source, join(root, name));
  const build = spawnSync('docker', ['build', '--platform', 'linux/amd64', '-t', tag, root], { encoding: 'utf8', timeout: 180000 });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync('docker', ['run', '--platform', 'linux/amd64', '--name', name, '--network', 'none', '--read-only', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var/www/html', '--tmpfs', '/etc/ssh/authorized_keys',
    '-v', `${root}:/fixture:ro`, '--entrypoint', 'python3', tag, '-B', '/fixture/test.py'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stdout + run.stderr + (run.error?.message ?? ""));
  assert.match(run.stdout, /PASS: real forced SSH/);
});
