import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const build = args => execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/build_padel_jump_live.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
test('exhibition backend artifact pins canonical admission and event retention; default team contract stays unchanged', () => {
  try {
    build(['--instance', 'exhibition']);
    const bytes = readFileSync('dist/padel-jump-live/release.json');
    const release = JSON.parse(bytes);
    assert.equal(release.instance, 'exhibition'); assert.equal(release.admissionContract, 'canonical-event-v1');
    assert.equal(release.resultStoragePolicy, 'event-retention-v1'); assert.equal(release.lives, 5);
    assert.equal(release.files['server.mjs'].sha256, createHash('sha256').update(readFileSync('dist/padel-jump-live/server.mjs')).digest('hex'));
    for (const args of [['--instance', 'other'], ['--instance', 'exhibition', '--unknown'], ['--unknown']]) assert.throws(() => build(args));
    assert.deepEqual(readFileSync('dist/padel-jump-live/release.json'), bytes);
  } finally { build([]); }
  const team = JSON.parse(readFileSync('dist/padel-jump-live/release.json', 'utf8'));
  assert.equal(team.resultStoragePolicy, 'permanent-v1'); assert.ok(!('admissionContract' in team));
});
