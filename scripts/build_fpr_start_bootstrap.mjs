import fs from 'node:fs';import crypto from 'node:crypto';import {build} from 'esbuild';
import {readRepositoryProvenance} from './lib/release-provenance.mjs';
const output=process.argv[2];if(!output||fs.existsSync(output))throw Error('New output directory required');
const provenance=readRepositoryProvenance(process.cwd());if(provenance.sourceDirty)throw Error('Clean source required');
const files=['scripts/lib/fprLevelLedger.mjs','scripts/lib/fprLevelIdentity.mjs','scripts/lib/tournamentFinalization.mjs',
 'src/services/player-rating/fprRatingReplay.ts','src/services/player-rating/ledger.ts','src/services/player-rating/fprTournamentRating.ts',
 'src/services/player-rating/fprLevelResults.ts','src/services/player-rating/tournamentExclusionGuard.ts','src/components/tournaments/fpr6x25.ts'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const workerModules=Object.fromEntries(files.map(file=>[file,hash(fs.readFileSync(file))]));
fs.mkdirSync(output,{mode:0o700});
await build({entryPoints:['scripts/fpr_start_bootstrap_cli.mjs'],outfile:output+'/bootstrap.mjs',bundle:true,platform:'node',format:'esm',packages:'external',
 define:{__FPR_START_WORKER_HASHES__:JSON.stringify(workerModules)}});
fs.chmodSync(output+'/bootstrap.mjs',0o600);
const manifest={sourceCommit:provenance.sourceCommit,sourceDirty:false,bootstrapSha256:hash(fs.readFileSync(output+'/bootstrap.mjs')),workerModules};
fs.writeFileSync(output+'/release-manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(manifest));
