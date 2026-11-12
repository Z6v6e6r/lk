import crypto from 'node:crypto';

export const FUNCTION98_SOURCE_SHA256 =
  '79d7f45efbf0325f8ad495c853f1613be43215a976ed41fd2279934c76bc0f4d';
export const FUNCTION98_SAFE_DIAGNOSTIC = JSON.stringify({
  event: 'bitrix_deal_list_request_prepared',
  provider: 'bitrix',
  operation: 'deal_list',
  phase: 'request_preparation',
});
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// The hash gate belongs to the caller. This narrow splice is separately exercised
// with synthetic inputs, so no credential-bearing production source enters Git.
export function replaceFunction98Warning(source) {
  if (typeof source !== 'string') throw new Error('Function source must be a string');
  const calls = [...source.matchAll(/node\.warn\s*\(/g)];
  const statements = [...source.matchAll(/^([\t ]*)node\.warn\(\s*([A-Za-z_$][\w$]*)\s*\);?[\t ]*$/gm)];
  if (calls.length !== 1 || statements.length !== 1) {
    throw new Error('Function warning anchor drift');
  }
  const match = statements[0];
  const assigned = new RegExp(`msg\\.url\\s*=\\s*${match[2].replace(/[$]/g, '\\$&')}\\s*;`);
  if (!assigned.test(source)) throw new Error('Function request URL assignment drift');
  const replacement = `${match[1]}node.warn(${JSON.stringify(FUNCTION98_SAFE_DIAGNOSTIC)});`;
  const candidate = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  try {
    new Function('msg', 'node', candidate);
  } catch {
    // Native parser messages may quote credential-bearing source fragments.
    throw new Error('Candidate function syntax invalid');
  }
  return candidate;
}

export function patchFunction98Flow(flow, { expectedFunctionSha256 = FUNCTION98_SOURCE_SHA256 } = {}) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) {
    throw new Error('Invalid flow identity');
  }
  const targets = flow.filter(n => n.type === 'function' && n.name === 'function 98');
  if (targets.length !== 1) throw new Error('Function target must be unique');
  const target = targets[0];
  const tab = flow.find(n => n.id === target.z);
  if (target.d === true || target.disabled === true || !tab || tab.type !== 'tab'
    || tab.disabled === true || typeof target.func !== 'string'
    || sha256(target.func) !== expectedFunctionSha256) {
    throw new Error('Function preimage drift');
  }
  if (!Array.isArray(target.wires) || target.wires.some(w => !Array.isArray(w))) {
    throw new Error('Function wiring drift');
  }
  const outgoing = target.wires.flat().map(id => flow.find(n => n.id === id));
  const http = outgoing.filter(n => n?.type === 'http request');
  const debug = outgoing.filter(n => n?.type === 'debug');
  if (outgoing.length !== 2 || http.length !== 1 || debug.length !== 1
    || http[0].method !== 'GET' || http[0].url
    || debug[0].active !== false) {
    throw new Error('Function diagnostic or HTTP boundary drift');
  }
  const candidate = structuredClone(flow);
  candidate.find(n => n.id === target.id).func = replaceFunction98Warning(target.func);
  return { candidate, targetId: target.id,
    beforeFunctionSha256: sha256(target.func),
    afterFunctionSha256: sha256(candidate.find(n => n.id === target.id).func) };
}
