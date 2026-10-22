// Offline source binding only. No CLI, network, flow imports, writes or deployment.
import crypto from 'node:crypto';
import fs from 'node:fs';

const generation = JSON.parse(fs.readFileSync(new URL('./lk1_error_source_generation.json', import.meta.url)));
export const LK1_ERROR_SOURCE_TARGETS = Object.freeze(generation.targets.map(target => Object.freeze({
  id: target.id, source: target.source, before: target.preimageSha256, after: target.candidateSha256,
})));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

// Preimages belong to the historical inspected source, not an assertion of current runtime.
// The caller must separately review whole-flow identity/topology before any future release.
export function patchLk1ErrorSources(flow) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('FLOW_SHAPE_INVALID');
  const replacements = new Map();
  for (const target of LK1_ERROR_SOURCE_TARGETS) {
    const node = flow.find(n => n.id === target.id);
    if (!node || node.type !== 'function' || typeof node.func !== 'string'
      || sha(node.func) !== target.before) throw new Error('FUNCTION_PREIMAGE_CHANGED');
    const source = fs.readFileSync(new URL(target.source, import.meta.url), 'utf8');
    if (sha(source) !== target.after) throw new Error('FUNCTION_CANDIDATE_CHANGED');
    new Function('msg', 'node', 'global', 'env', source);
    replacements.set(target.id, source);
  }
  return flow.map(n => replacements.has(n.id) ? { ...n, func: replacements.get(n.id) } : n);
}
