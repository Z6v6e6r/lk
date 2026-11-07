// Bundle a server-private runner, pinning the exact worker formula/replay closure.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const out=process.argv[2];
if(!out||fs.existsSync(out))throw Error('New output required');
const files=['scripts/lib/fprLevelLedger.mjs','scripts/lib/fprLevelIdentity.mjs','scripts/lib/tournamentFinalization.mjs','src/services/player-rating/fprRatingReplay.ts',
  'src/services/player-rating/ledger.ts','src/services/player-rating/fprTournamentRating.ts','src/services/player-rating/fprLevelResults.ts',
  'src/services/player-rating/tournamentExclusionGuard.ts','src/components/tournaments/fpr6x25.ts'];
const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
await build({entryPoints:['scripts/apply_fpr_canonical_correction.mjs'],outfile:out,bundle:true,platform:'node',format:'esm',packages:'external',
  define:{__FPR_CORRECTION_RUNTIME_HASHES__:JSON.stringify(hashes)}});
fs.chmodSync(out,0o600);
console.log(JSON.stringify({ok:true,runnerSha256:crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'),runtimeFiles:files.length}));
