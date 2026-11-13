import { createHash } from 'node:crypto';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const collectorGraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
export const collectorOrderedGraphHash = async flow => digest(JSON.stringify(flow.map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw new Error(code); };

export async function createCollectorBodyPreserver(input, sourceSnapshot) {
  const seal = structuredClone(input);
  check(seal?.protocol === 'source-preserving-v2' && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256',
    'sourceOrderedGraphSha256', 'candidateOrderedGraphSha256', 'editorOrderedGraphSha256', 'preRevisionSha256',
    'beforeRouteSha256', 'gateSha256'].every(k => hex(seal[k])), 'LCI_SEAL');
  // Capture before arming. Never merge, normalize, or trust fields serialized by
  // the editor: the forwarded graph comes entirely from the pinned native GET.
  const snapshot = structuredClone(sourceSnapshot);
  check(snapshot && Object.keys(snapshot).sort().join(',') === 'flows,rev' && Array.isArray(snapshot.flows)
    && typeof snapshot.rev === 'string' && await digest(snapshot.rev) === seal.preRevisionSha256
    && await collectorGraphHash(snapshot.flows) === seal.sourceGraphSha256
    && await collectorOrderedGraphHash(snapshot.flows) === seal.sourceOrderedGraphSha256, 'LCI_SNAPSHOT');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'LCI_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'LCI_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'LCI_REVISION');
    const ids = postBody.flows.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'LCI_GRAPH_IDENTITY');
    check(await collectorOrderedGraphHash(postBody.flows) === seal.editorOrderedGraphSha256, 'LCI_UNEXPECTED_EDITOR_DELTA');
    const flow = structuredClone(snapshot.flows);
    const target = flow.find(node => node.id === seal.routeId);
    check(target?.type === 'http in' && target.url === '/lk/analytics/events' && target.method === 'post'
      && await digest(JSON.stringify(target)) === seal.beforeRouteSha256, 'LCI_PREIMAGE');
    check(seal.gate?.id === `diag_ingest_${seal.routeId}` && seal.gate.type === 'function'
      && seal.gate.z === target.z && await digest(JSON.stringify(seal.gate)) === seal.gateSha256, 'LCI_GATE');
    if (seal.inverse === true) {
      check(flow.at(-1)?.id === seal.gate.id && await digest(JSON.stringify(flow.at(-1))) === seal.gateSha256
        && JSON.stringify(target.wires) === JSON.stringify([[seal.gate.id]])
        && Array.isArray(seal.beforeWires), 'LCI_INVERSE_PREIMAGE');
      flow.pop(); target.wires = structuredClone(seal.beforeWires);
    } else {
      check(!flow.some(node => node.id === seal.gate.id), 'LCI_ALREADY_INSTALLED');
      target.wires = [[seal.gate.id]];
      flow.push(structuredClone(seal.gate));
    }
    check(await collectorGraphHash(flow) === seal.candidateGraphSha256
      && await collectorOrderedGraphHash(flow) === seal.candidateOrderedGraphSha256, 'LCI_POSTIMAGE');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      sourceOrderedGraphSha256: seal.sourceOrderedGraphSha256, candidateOrderedGraphSha256: seal.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: seal.editorOrderedGraphSha256,
      forwardedBodySha256: await digest(postDataText) } };
  };
}
