// Offline binding only: no CLI, network, live imports or business operations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const r03Generation = JSON.parse(fs.readFileSync(new URL('./lk1_r03_response_generation.json', import.meta.url)));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const fail = code => { throw Error(code); };
export function patchR03ResponseSources(flow, { sourceTexts = null } = {}) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) fail('FLOW_SHAPE_INVALID');
  const by = new Map(flow.map(n => [n.id, n]));
  const response = by.get(r03Generation.response.id);
  if (!response || response.type !== 'http response' || response.d === true) fail('RESPONSE_NODE_DRIFT');
  const tab = by.get(response.z);
  if (!tab || tab.type !== 'tab' || tab.disabled === true) fail('RESPONSE_TAB_DRIFT');
  const incoming = flow.filter(n => n.wires?.some(w => w.includes(response.id))).map(n => n.id).sort();
  if (!isDeepStrictEqual(incoming, r03Generation.responseParents.map(t => t.id).sort())) fail('RESPONSE_PARENTS_DRIFT');
  for (const target of [...r03Generation.responseParents, ...r03Generation.backgroundAnchors]) {
    const node = by.get(target.id);
    if (!node || node.type !== 'function' || node.d === true || typeof node.func !== 'string'
      || sha(node.func) !== target.preimageSha256) fail('FUNCTION_PREIMAGE_CHANGED');
    if (node.z !== response.z || node.outputs !== target.outputs || !isDeepStrictEqual(node.wires, target.wires)) fail('FUNCTION_GRAPH_CHANGED');
  }
  const replacements = new Map();
  for (const target of r03Generation.targets) {
    const text = sourceTexts === null
      ? fs.readFileSync(new URL(target.source, import.meta.url), 'utf8') : sourceTexts[target.source];
    if (typeof text !== 'string' || sha(text) !== target.candidateSha256) fail('FUNCTION_CANDIDATE_CHANGED');
    new Function('msg', 'node', 'context', 'global', 'env', text);
    replacements.set(target.id, text);
  }
  return flow.map(n => replacements.has(n.id) ? { ...n, func: replacements.get(n.id) } : n);
}
