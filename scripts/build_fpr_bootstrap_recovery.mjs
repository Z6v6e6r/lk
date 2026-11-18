import fs from 'node:fs';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
const output = process.argv[2];
if (!output || fs.existsSync(output)) throw Error('New output required');
const provenance = readRepositoryProvenance(process.cwd());
if (provenance.sourceDirty) throw Error('Clean source required');
const files = ['scripts/lib/fprLevelLedger.mjs', 'scripts/lib/fprLevelIdentity.mjs', 'scripts/lib/tournamentFinalization.mjs',
  'src/services/player-rating/fprRatingReplay.ts', 'src/services/player-rating/ledger.ts', 'src/services/player-rating/fprTournamentRating.ts',
  'src/services/player-rating/fprLevelResults.ts', 'src/services/player-rating/tournamentExclusionGuard.ts', 'src/components/tournaments/fpr6x25.ts'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(file))]));
await build({ entryPoints: ['scripts/repair_fpr_unrated_bootstrap.mjs'], outfile: output, bundle: true,
  platform: 'node', format: 'esm', packages: 'external', define: { __FPR_RECOVERY_WORKER_HASHES__: JSON.stringify(hashes) } });
fs.chmodSync(output, 0o600);
console.log(JSON.stringify({ ...provenance, runnerSha256: hash(fs.readFileSync(output)), workerModules: hashes }));
