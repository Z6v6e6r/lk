import {
  FUNCTION98_SAFE_DIAGNOSTIC,
  replaceFunction98Warning,
  sha256,
} from './function98_safe_diagnostic.mjs';

export const FUNCTION296_SOURCE_SHA256 =
  '863743918bd3e57e584ed7085e575ca73dd9bdabc647093d0c50ce047e8ae93f';
export const FUNCTION296_NODE_SHA256 =
  'd23470a05aae7131da74d6282c6b5a57a39e6c65734923be300a00f59a5f8d99';

// Both diagnosed functions prepare the same provider operation. Reuse its
// constant diagnostic and narrow warning splice; never commit live URL source.
export const FUNCTION296_SAFE_DIAGNOSTIC = FUNCTION98_SAFE_DIAGNOSTIC;
export const replaceFunction296Warning = replaceFunction98Warning;

export function patchFunction296Flow(flow, {
  expectedFunctionSha256 = FUNCTION296_SOURCE_SHA256,
  expectedNodeSha256 = FUNCTION296_NODE_SHA256,
} = {}) {
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) {
    throw new Error('Invalid flow identity');
  }
  const targets = flow.filter(n => n.type === 'function' && n.name === 'function 296');
  if (targets.length !== 1) throw new Error('Function target must be unique');
  const target = targets[0];
  const tab = flow.find(n => n.id === target.z);
  if (sha256(target.id) !== expectedNodeSha256 || typeof target.func !== 'string'
    || sha256(target.func) !== expectedFunctionSha256 || target.d === true
    || target.disabled === true || !tab || tab.type !== 'tab' || tab.disabled === true) {
    throw new Error('Function preimage drift');
  }
  const incoming = flow.filter(n => Array.isArray(n.wires)
    && n.wires.some(w => Array.isArray(w) && w.includes(target.id)));
  const trigger = incoming[0];
  if (incoming.length !== 1 || trigger.type !== 'inject'
    || trigger.crontab !== '30 18 * * *' || trigger.once !== false
    || (trigger.repeat !== '' && trigger.repeat != null)
    || trigger.d === true || trigger.disabled === true || trigger.z !== target.z) {
    throw new Error('Function schedule boundary drift');
  }
  if (!Array.isArray(target.wires) || target.wires.some(w => !Array.isArray(w))) {
    throw new Error('Function wiring drift');
  }
  const outgoing = target.wires.flat().map(id => flow.find(n => n.id === id));
  const http = outgoing.filter(n => n?.type === 'http request');
  const debug = outgoing.filter(n => n?.type === 'debug');
  if (outgoing.length !== 2 || http.length !== 1 || debug.length !== 1
    || http[0].method !== 'GET' || http[0].url || http[0].ret !== 'obj'
    || http[0].d === true || http[0].disabled === true || debug[0].active !== false) {
    throw new Error('Function diagnostic or HTTP boundary drift');
  }
  const candidate = structuredClone(flow);
  candidate.find(n => n.id === target.id).func = replaceFunction296Warning(target.func);
  return { candidate, targetId: target.id,
    beforeFunctionSha256: sha256(target.func),
    afterFunctionSha256: sha256(candidate.find(n => n.id === target.id).func) };
}
