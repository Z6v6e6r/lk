import { createHash } from 'node:crypto';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const function98GraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw new Error(code); };

export async function createFunction98BodyPreserver(input) {
  const seal = structuredClone(input);
  check(seal && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256', 'preRevisionSha256',
    'beforeFunctionSha256', 'afterFunctionSha256'].every(k => hex(seal[k])), 'F98_SEAL');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'F98_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'F98_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'F98_REVISION');
    const flow = structuredClone(postBody.flows), ids = flow.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'F98_GRAPH_IDENTITY');
    const observed = await function98GraphHash(flow);
    check(observed === seal.sourceGraphSha256 || observed === seal.candidateGraphSha256, 'F98_UNEXPECTED_EDITOR_DELTA');
    const targets = flow.filter(n => n.type === 'function' && n.name === 'function 98');
    check(targets.length === 1, 'F98_TARGET'); const target = targets[0];
    if (observed === seal.sourceGraphSha256) {
      check(await digest(target.func) === seal.beforeFunctionSha256, 'F98_PREIMAGE');
      const matches = [...target.func.matchAll(/^([\t ]*)node\.warn\(\s*([A-Za-z_$][\w$]*)\s*\);?[\t ]*$/gm)];
      check(matches.length === 1 && [...target.func.matchAll(/node\.warn\s*\(/g)].length === 1, 'F98_ANCHOR');
      const m = matches[0];
      const diagnostic = '{"event":"bitrix_deal_list_request_prepared","provider":"bitrix","operation":"deal_list","phase":"request_preparation"}';
      target.func = target.func.slice(0, m.index) + m[1] + 'node.warn(' + JSON.stringify(diagnostic) + ');'
        + target.func.slice(m.index + m[0].length);
    }
    check(await digest(target.func) === seal.afterFunctionSha256 && await function98GraphHash(flow) === seal.candidateGraphSha256, 'F98_POSTIMAGE');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      forwardedBodySha256: await digest(postDataText) } };
  };
}
