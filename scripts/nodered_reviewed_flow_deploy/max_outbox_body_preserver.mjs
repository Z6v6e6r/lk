import { createHash } from 'node:crypto';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const max_outboxGraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
export const max_outboxOrderedGraphHash = async flow => digest(JSON.stringify(flow.map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw new Error(code); };

// Root preparation independently pins and validates the complete source with the
// source patcher. This browser half changes only the same fixed four fields and
// two cloned senders, then requires the root-pinned complete candidate hashes.
export async function createMaxOutboxBodyPreserver(input, sourceSnapshot) {
  const seal = structuredClone(input);
  check(seal?.protocol === 'source-preserving-v2' && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256',
    'sourceOrderedGraphSha256', 'candidateOrderedGraphSha256', 'editorOrderedGraphSha256', 'preRevisionSha256'].every(k => hex(seal[k])), 'MAXO_SEAL');
  const snapshot = structuredClone(sourceSnapshot);
  check(snapshot && Object.keys(snapshot).sort().join(',') === 'flows,rev' && Array.isArray(snapshot.flows)
    && typeof snapshot.rev === 'string' && await digest(snapshot.rev) === seal.preRevisionSha256
    && await max_outboxGraphHash(snapshot.flows) === seal.sourceGraphSha256
    && await max_outboxOrderedGraphHash(snapshot.flows) === seal.sourceOrderedGraphSha256, 'MAXO_SNAPSHOT');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'MAXO_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'MAXO_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'MAXO_REVISION');
    const ids = postBody.flows.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'MAXO_GRAPH_IDENTITY');
    check(await max_outboxOrderedGraphHash(postBody.flows) === seal.editorOrderedGraphSha256, 'MAXO_UNEXPECTED_EDITOR_DELTA');
    const flow = structuredClone(snapshot.flows), by = new Map(flow.map(n => [n.id, n]));
    for (const r of [
      { poller:'e75785ffa19c2e20', dispatch:'47c460de0db646e6', sender:'f64e5818bc8d7aa6', add:'max_new_outbox_send_academy', name:'MAX new outbox only — academy' },
      { poller:'c1ecd06ce451751b', dispatch:'0006d5707259bc5b', sender:'466e8a3ac76c2fab', add:'max_new_outbox_send_main', name:'MAX new outbox only — main' },
    ]) {
      const poller=by.get(r.poller), dispatch=by.get(r.dispatch), sender=by.get(r.sender);
      check(poller?.type==='inject' && poller.d===true && dispatch?.type==='function'
        && sender?.type==='maxbot-send' && sender.d===true && !by.has(r.add), 'MAXO_PREIMAGE');
      poller.d=false; dispatch.wires[0]=[r.add];
      flow.push({...structuredClone(sender),id:r.add,name:r.name,d:false});
    }
    check(await max_outboxGraphHash(flow) === seal.candidateGraphSha256
      && await max_outboxOrderedGraphHash(flow) === seal.candidateOrderedGraphSha256, 'MAXO_POSTIMAGE');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      sourceOrderedGraphSha256: seal.sourceOrderedGraphSha256, candidateOrderedGraphSha256: seal.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: seal.editorOrderedGraphSha256, forwardedBodySha256: await digest(postDataText) } };
  };
}
