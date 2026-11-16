import { createHash } from 'node:crypto';
const digest = async value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort(compare).map(k => [k, canonical(value[k])])) : value;
export const support_photosGraphHash = async flow => digest(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
export const support_photosOrderedGraphHash = async flow => digest(JSON.stringify(flow.map(canonical)));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const check = (ok, code) => { if (!ok) throw Error(code); };
const fields = {
  abccacd291f24659: ['wires'], '1a27d9a916e742a0': ['wires'],
  '0006d5707259bc5b': ['func'], '47c460de0db646e6': ['func'],
  max_new_outbox_send_main: ['type'], max_new_outbox_send_academy: ['type'],
  '0b0670d7eeec9cb5': ['func', 'wires'], '6f399ab785a116d2': ['func']
};
const added = ['support_photo_prepare', 'support_photo_prepared', 'support_photo_resolve',
  'support_photo_resolved', 'support_photo_error', 'support_photo_debug',
  'support_photo_prepare_http', 'support_photo_resolve_http', 'support_photo_catch'];
const flags = purpose => ['pause', 'resume', 'pause-photo'].includes(purpose);
export async function createSupportPhotosBodyPreserver(input, sourceSnapshot) {
  const seal = structuredClone(input), operations = seal.operations;
  check(seal?.protocol === 'support-photos-source-preserving-v1' && ['pause', 'install', 'resume', 'pause-photo', 'recover'].includes(seal.purpose)
    && ['planSha256', 'attemptSha256', 'sourceGraphSha256', 'candidateGraphSha256', 'sourceOrderedGraphSha256',
      'candidateOrderedGraphSha256', 'editorOrderedGraphSha256', 'preRevisionSha256', 'operationsSha256', 'nativeDiskSha256'].every(k => hex(seal[k])), 'PHOTON_SEAL');
  check(operations && Object.keys(operations).sort().join(',') === 'additions,edits,purpose,removals'
    && operations.purpose === seal.purpose && await digest(JSON.stringify(operations)) === seal.operationsSha256, 'PHOTON_OPERATIONS');
  const expectedIds = flags(seal.purpose) ? ['e75785ffa19c2e20', 'c1ecd06ce451751b'] : Object.keys(fields);
  check(Array.isArray(operations.edits) && operations.edits.length === expectedIds.length
    && JSON.stringify(operations.edits.map(e => e.id).sort()) === JSON.stringify(expectedIds.sort()), 'PHOTON_EDIT_SET');
  for (const e of operations.edits) {
    const allowed = flags(seal.purpose) ? ['d'] : fields[e.id];
    check(Object.keys(e).sort().join(',') === 'id,set,unset' && e.set && typeof e.set === 'object' && !Array.isArray(e.set)
      && Array.isArray(e.unset) && [...Object.keys(e.set), ...e.unset].every(k => allowed.includes(k))
      && new Set([...Object.keys(e.set), ...e.unset]).size === Object.keys(e.set).length + e.unset.length, 'PHOTON_EDIT_FIELDS');
    if (flags(seal.purpose)) check(e.unset.length === 0 && Object.keys(e.set).join(',') === 'd'
      && e.set.d === (seal.purpose !== 'resume'), 'PHOTON_FLAG_VALUE');
  }
  check(Array.isArray(operations.additions) && Array.isArray(operations.removals)
    && JSON.stringify(operations.additions.map(n => n.id).sort()) === JSON.stringify(seal.purpose === 'install' ? [...added].sort() : [])
    && JSON.stringify([...operations.removals].sort()) === JSON.stringify(seal.purpose === 'recover' ? [...added].sort() : []), 'PHOTON_ADDITION_SET');
  const snapshot = structuredClone(sourceSnapshot);
  check(snapshot && Object.keys(snapshot).sort().join(',') === 'flows,rev' && Array.isArray(snapshot.flows)
    && typeof snapshot.rev === 'string' && await digest(snapshot.rev) === seal.preRevisionSha256
    && await support_photosGraphHash(snapshot.flows) === seal.sourceGraphSha256
    && await support_photosOrderedGraphHash(snapshot.flows) === seal.sourceOrderedGraphSha256, 'PHOTON_SNAPSHOT');
  if (!flags(seal.purpose)) check(['e75785ffa19c2e20','c1ecd06ce451751b'].every(id => snapshot.flows.find(n => n.id === id)?.d === true), 'PHOTON_CONSUMERS_NOT_PAUSED');
  let consumed = false;
  return async ({ request, postBody }) => {
    check(!consumed, 'PHOTON_CONSUMED'); consumed = true;
    check(request?.url === 'http://127.0.0.1:18801/flows' && request.method === 'POST'
      && request.apiVersion === 'v2' && request.deploymentType === 'nodes', 'PHOTON_REQUEST');
    check(postBody && Object.keys(postBody).sort().join(',') === 'flows,rev' && Array.isArray(postBody.flows)
      && typeof postBody.rev === 'string' && postBody.rev.length <= 512
      && await digest(postBody.rev) === seal.preRevisionSha256, 'PHOTON_REVISION');
    const ids = postBody.flows.map(n => n?.id);
    check(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'PHOTON_GRAPH_IDENTITY');
    check(await support_photosOrderedGraphHash(postBody.flows) === seal.editorOrderedGraphSha256, 'PHOTON_UNEXPECTED_EDITOR_DELTA');
    let flow = structuredClone(snapshot.flows); const by = new Map(flow.map(n => [n.id, n]));
    for (const e of operations.edits) {
      check(by.has(e.id), 'PHOTON_EDIT_ABSENT');
      for (const k of e.unset) delete by.get(e.id)[k];
      Object.assign(by.get(e.id), structuredClone(e.set));
    }
    for (const id of operations.removals) check(by.has(id), 'PHOTON_REMOVAL_ABSENT');
    flow = flow.filter(n => !operations.removals.includes(n.id));
    for (const n of operations.additions) { check(!by.has(n.id), 'PHOTON_ADDITION_OCCUPIED'); flow.push(structuredClone(n)); }
    check(await support_photosGraphHash(flow) === seal.candidateGraphSha256
      && await support_photosOrderedGraphHash(flow) === seal.candidateOrderedGraphSha256, 'PHOTON_POSTIMAGE');
    if (!flags(seal.purpose)) check(['e75785ffa19c2e20','c1ecd06ce451751b'].every(id => flow.find(n => n.id === id)?.d === true), 'PHOTON_CONSUMERS_NOT_PAUSED');
    check(await digest(JSON.stringify(flow, null, 4)) === seal.nativeDiskSha256, 'PHOTON_NATIVE_DISK_ENCODING');
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: flow });
    return { postDataText, audit: { planSha256: seal.planSha256, attemptSha256: seal.attemptSha256,
      candidateGraphSha256: seal.candidateGraphSha256, preRevisionSha256: seal.preRevisionSha256,
      sourceOrderedGraphSha256: seal.sourceOrderedGraphSha256, candidateOrderedGraphSha256: seal.candidateOrderedGraphSha256,
      editorOrderedGraphSha256: seal.editorOrderedGraphSha256, operationsSha256: seal.operationsSha256,
      forwardedBodySha256: await digest(postDataText) } };
  };
}
