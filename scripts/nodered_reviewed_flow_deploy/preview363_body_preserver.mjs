import { createHash } from 'node:crypto';
import { applyPreview363Body, PREVIEW363_TARGET } from '../lib/preview363_body_patch.mjs';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const preview363GraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
export const preview363OrderedGraphHash = async flow => digest(JSON.stringify(flow.map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw new Error(code); };

export async function createPreview363BodyPreserver(input, artifact, sourceSnapshot) {
  const seal = structuredClone(input);
  check(seal?.protocol === 'source-preserving-v2' && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256',
    'sourceOrderedGraphSha256', 'candidateOrderedGraphSha256', 'editorOrderedGraphSha256', 'preRevisionSha256',
    'beforeFunctionSha256', 'afterFunctionSha256'].every(k => hex(seal[k])), 'P363_SEAL');
  const snapshot = structuredClone(sourceSnapshot);
  check(snapshot && Object.keys(snapshot).sort().join(',') === 'flows,rev' && Array.isArray(snapshot.flows)
    && typeof snapshot.rev === 'string' && await digest(snapshot.rev) === seal.preRevisionSha256
    && await preview363GraphHash(snapshot.flows) === seal.sourceGraphSha256
    && await preview363OrderedGraphHash(snapshot.flows) === seal.sourceOrderedGraphSha256, 'P363_SNAPSHOT');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'P363_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'P363_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'P363_REVISION');
    const ids = postBody.flows.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'P363_GRAPH_IDENTITY');
    check(await preview363OrderedGraphHash(postBody.flows) === seal.editorOrderedGraphSha256, 'P363_UNEXPECTED_EDITOR_DELTA');
    // The exact native GET snapshot owns every forwarded field and node order.
    // The editor's serialization is checked but never merged into production.
    const flow = structuredClone(snapshot.flows);
    const targets = flow.filter(n => n.type === 'function' && n.id === PREVIEW363_TARGET);
    check(targets.length === 1, 'P363_TARGET'); const target = targets[0];
    check(await digest(target.func) === seal.beforeFunctionSha256, 'P363_PREIMAGE');
    target.func = applyPreview363Body(target.func, artifact, seal.reverse === true);
    check(await digest(target.func) === seal.afterFunctionSha256 && await preview363GraphHash(flow) === seal.candidateGraphSha256
      && await preview363OrderedGraphHash(flow) === seal.candidateOrderedGraphSha256, 'P363_POSTIMAGE');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      sourceOrderedGraphSha256: seal.sourceOrderedGraphSha256, candidateOrderedGraphSha256: seal.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: seal.editorOrderedGraphSha256,
      forwardedBodySha256: await digest(postDataText) } };
  };
}
