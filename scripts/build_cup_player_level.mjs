import fs from 'node:fs';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw Error('New output directory required');
const provenance = readRepositoryProvenance(process.cwd());
if (provenance.sourceDirty) throw Error('Clean source required');
fs.mkdirSync(output, { mode: 0o700 });
await build({ entryPoints: ['scripts/cup_player_level_cli.mjs'], outfile: output + '/level.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
fs.chmodSync(output + '/level.mjs', 0o600);
const manifest = { sourceCommit: provenance.sourceCommit, sourceDirty: false,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(output + '/level.mjs')).digest('hex') };
fs.writeFileSync(output + '/release-manifest.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(manifest));
