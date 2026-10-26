import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LIVE_ENGINE_VERSION, LIVE_SYNC } from '../src/components/padel-jump/live-contract.ts';

const hash = createHash('sha256');
for (const name of ['campaign.ts', 'level-layout.ts', 'engine.ts']) hash.update(name + '\0').update(readFileSync('src/components/padel-jump/' + name));
if (hash.digest('hex') !== LIVE_ENGINE_VERSION) throw new Error('Campaign replay closure drift');
const root = 'dist/padel-jump-live'; mkdirSync(root, { recursive: true });
await build({ entryPoints: ['games/padel-jump/live/server.mjs'], outfile: root + '/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: false });
const data = readFileSync(root + '/server.mjs');
writeFileSync(root + '/release.json', JSON.stringify({ schema: 1, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), engine: LIVE_ENGINE_VERSION, sync: LIVE_SYNC,
  files: { 'server.mjs': { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') } } }, null, 2) + '\n');
console.log('Isolated Jump companion built; no service installation or activation.');
