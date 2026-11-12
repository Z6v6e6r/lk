// Source-only exact successor. No CLI, network, flow import, DB or provider access.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const generation = JSON.parse(fs.readFileSync(new URL('./subscription_stale_release_generation.json', import.meta.url)));
const target = generation.targets[0];
const digest = value => createHash('sha256').update(value).digest('hex');
const expectedWires = [['piter_ledger_find_20260903'], ['piter_ledger_update_20260903'],
  ['piter_sale_update_20260903'], ['10fe94a32b8adc35'], ['fdc3f25f39199546']];
export function patchStaleAnnualRelease(flow) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('FLOW_SHAPE_INVALID');
  const node = flow.find(n => n.id === target.id);
  if (!node || node.type !== 'function' || digest(node.func || '') !== target.preimageSha256
    || node.outputs !== 5 || JSON.stringify(node.wires) !== JSON.stringify(expectedWires)) {
    throw Error('STALE_RELEASE_PREIMAGE_CHANGED');
  }
  const source = fs.readFileSync(new URL(target.source, import.meta.url), 'utf8');
  if (digest(source) !== target.candidateSha256) throw Error('STALE_RELEASE_CANDIDATE_CHANGED');
  new Function('msg', 'node', 'global', 'env', source);
  return flow.map(n => n.id === target.id ? { ...n, func: source } : n);
}
