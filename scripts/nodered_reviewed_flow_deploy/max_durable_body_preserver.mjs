import { createHash } from 'node:crypto';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const max_durableGraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
export const max_durableOrderedGraphHash = async flow => digest(JSON.stringify(flow.map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw Error(code); };
const fields = {
  e75785ffa19c2e20: ['d', 'once', 'repeat'], c1ecd06ce451751b: ['d', 'once', 'repeat'],
  '47c460de0db646e6': ['func', 'wires'], '0006d5707259bc5b': ['func', 'wires'],
  '41be3d2c95b57295': ['func'], '2e547e998eee631f': ['func'],
  max_new_outbox_send_academy: ['d'], max_new_outbox_send_main: ['d']
};
const added = ['max_outbox_fenced_send_academy', 'max_outbox_durable_receipt_academy',
  'max_outbox_fenced_send_main', 'max_outbox_durable_receipt_main'];
export async function createMaxDurableBodyPreserver(input, sourceSnapshot) {
  const seal = structuredClone(input), operations = seal.operations;
  check(seal?.protocol === 'max-durable-source-preserving-v1' && ['pause', 'activate', 'recover'].includes(seal.purpose)
    && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256', 'sourceOrderedGraphSha256',
      'candidateOrderedGraphSha256', 'editorOrderedGraphSha256', 'preRevisionSha256', 'operationsSha256'].every(k => hex(seal[k])), 'MAXD_SEAL');
  check(operations && Object.keys(operations).sort().join(',') === 'additions,edits,purpose,removals'
    && operations.purpose === seal.purpose && await digest(JSON.stringify(operations)) === seal.operationsSha256, 'MAXD_OPERATIONS');
  const expectedIds = seal.purpose === 'pause' ? ['e75785ffa19c2e20', 'c1ecd06ce451751b'] : Object.keys(fields);
  check(Array.isArray(operations.edits) && operations.edits.length === expectedIds.length
    && JSON.stringify(operations.edits.map(e => e.id).sort()) === JSON.stringify(expectedIds.sort()), 'MAXD_EDIT_SET');
  for (const e of operations.edits) {
    const allowed = seal.purpose === 'pause' ? ['d'] : fields[e.id];
    check(Object.keys(e).sort().join(',') === 'id,set,unset' && e.set && typeof e.set === 'object' && !Array.isArray(e.set)
      && Array.isArray(e.unset) && [...Object.keys(e.set), ...e.unset].every(k => allowed.includes(k))
      && new Set([...Object.keys(e.set), ...e.unset]).size === Object.keys(e.set).length + e.unset.length, 'MAXD_EDIT_FIELDS');
  }
  check(Array.isArray(operations.additions) && Array.isArray(operations.removals)
    && JSON.stringify(operations.additions.map(n => n.id).sort()) === JSON.stringify(seal.purpose === 'activate' ? [...added].sort() : [])
    && JSON.stringify([...operations.removals].sort()) === JSON.stringify(seal.purpose === 'recover' ? [...added].sort() : []), 'MAXD_ADDITION_SET');
  const snapshot = structuredClone(sourceSnapshot);
  check(snapshot && Object.keys(snapshot).sort().join(',') === 'flows,rev' && Array.isArray(snapshot.flows)
    && typeof snapshot.rev === 'string' && await digest(snapshot.rev) === seal.preRevisionSha256
    && await max_durableGraphHash(snapshot.flows) === seal.sourceGraphSha256
    && await max_durableOrderedGraphHash(snapshot.flows) === seal.sourceOrderedGraphSha256, 'MAXD_SNAPSHOT');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'MAXD_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'MAXD_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'MAXD_REVISION');
    const ids = postBody.flows.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'MAXD_GRAPH_IDENTITY');
    check(await max_durableOrderedGraphHash(postBody.flows) === seal.editorOrderedGraphSha256, 'MAXD_UNEXPECTED_EDITOR_DELTA');
    let flow = structuredClone(snapshot.flows); const by = new Map(flow.map(n => [n.id, n]));
    for (const e of operations.edits) {
      check(by.has(e.id), 'MAXD_EDIT_ABSENT');
      for (const k of e.unset) delete by.get(e.id)[k];
      Object.assign(by.get(e.id), structuredClone(e.set));
    }
    for (const id of operations.removals) check(by.has(id), 'MAXD_REMOVAL_ABSENT');
    flow = flow.filter(n => !operations.removals.includes(n.id));
    for (const n of operations.additions) { check(!by.has(n.id), 'MAXD_ADDITION_OCCUPIED'); flow.push(structuredClone(n)); }
    check(await max_durableGraphHash(flow) === seal.candidateGraphSha256
      && await max_durableOrderedGraphHash(flow) === seal.candidateOrderedGraphSha256, 'MAXD_POSTIMAGE');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      sourceOrderedGraphSha256: seal.sourceOrderedGraphSha256, candidateOrderedGraphSha256: seal.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: seal.editorOrderedGraphSha256, operationsSha256: seal.operationsSha256,
      forwardedBodySha256: await digest(postDataText) } };
  };
}
