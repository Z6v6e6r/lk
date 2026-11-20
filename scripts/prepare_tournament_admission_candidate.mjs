import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { patchTournamentAdmissionSource } from './lib/tournamentAdmissionSource.mjs';
export function composeTournamentAdmissionCandidate(raw, expectedSha) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || crypto.createHash('sha256').update(raw).digest('hex') !== expectedSha) throw Error('Source preimage mismatch');
  const flow = JSON.parse(raw);
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('Invalid source flow');
  const node = flow.find(n => n.id === 'lk_subscription_booking_router_20260804');
  if (node?.type !== 'function' || node.outputs < 4) throw Error('Booking owner graph unavailable');
  // Preserve the composed function and its existing bindings. The Function VM does not expose URL.
  const libs = node.libs ?? [];
  if (!Array.isArray(libs) || libs.some(lib => lib?.var === 'tournamentOwnerUrl')) throw Error('Tournament URL binding conflict');
  node.func = patchTournamentAdmissionSource(node.func);
  node.libs = [...libs, { var: 'tournamentOwnerUrl', module: 'url' }];
  new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', node.func);
  return flow;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, expectedSha, output] = process.argv.slice(2);
  if (!source?.startsWith('/') || !output?.startsWith('/') || source === output || fs.existsSync(output)) throw Error('New absolute local output required');
  fs.writeFileSync(output, JSON.stringify(composeTournamentAdmissionCandidate(fs.readFileSync(source), expectedSha), null, 2), { mode: 0o600, flag: 'wx' });
}
