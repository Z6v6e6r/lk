import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { updateInstalledTournamentGenderRetry } from './lib/tournamentAdmissionSource.mjs';

const [sourcePath, expectedHash, outputPath] = process.argv.slice(2);
if (!sourcePath?.startsWith('/') || !outputPath?.startsWith('/') || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) {
  throw Error('Usage: node scripts/prepare_lk1_tournament_gender_retry.mjs /absolute/current-flow.json sha256 /absolute/candidate.json');
}
const raw = fs.readFileSync(sourcePath);
if (createHash('sha256').update(raw).digest('hex') !== expectedHash) throw Error('Source flow drift');
const flow = JSON.parse(raw);
if (!Array.isArray(flow) || new Set(flow.map(node => node.id)).size !== flow.length) throw Error('Invalid source flow');
const router = flow.find(node => node.id === 'lk_subscription_booking_router_20260804');
const finalizer = flow.find(node => node.id === 'lk_subscription_booking_finalize_20260804');
if (router?.type !== 'function' || finalizer?.type !== 'function' || finalizer.outputs !== 2
  || !router.wires?.some(wire => wire.includes(finalizer.id))) throw Error('Booking flow nodes unavailable');

// This is the tracked admission source installed on 147 before this change.
const previous = name => execFileSync('git', ['show', `06e4f335:scripts/nodered_tournament_admission_nodes/${name}`], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
});
const updated = updateInstalledTournamentGenderRetry(router.func, finalizer.func,
  previous('admission.js'), previous('level_refusal_finalize.js'));
router.func = updated.source;
finalizer.func = updated.finalizer;
new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', router.func);
new Function('msg', 'env', 'global', 'node', finalizer.func);
fs.writeFileSync(outputPath, JSON.stringify(flow, null, 2), { mode: 0o600, flag: 'wx' });
