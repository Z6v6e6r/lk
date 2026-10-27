import crypto from 'node:crypto';

const IDS = Object.freeze(['e75785ffa19c2e20', 'c1ecd06ce451751b']);
const HTTP_ID = 'lk_booked_operation_provider_request_20261021';
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  return value;
};
export const codePointGraphSha256 = (flow) => hash(JSON.stringify([...flow].sort((a, b) => compare(a.id, b.id)).map(canonical)));
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function createMaxPauseBodyPreserver({ sourceGraph, expectedSourceCodePointSha256, expectedPreRevisionSha256, operationId }) {
  let consumed = false;
  if (!Array.isArray(sourceGraph) || !hex(expectedSourceCodePointSha256) || !hex(expectedPreRevisionSha256) || typeof operationId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(operationId)) throw new Error('MAX_PRESERVER_SEAL_INVALID');
  const source = structuredClone(sourceGraph);
  const sourceById = new Map(source.map((node) => [node?.id, node]));
  if (source.length !== 4857 || sourceById.size !== 4857 || [...sourceById.keys()].some((id) => typeof id !== 'string' || !id) || codePointGraphSha256(source) !== expectedSourceCodePointSha256) throw new Error('MAX_PRESERVER_SOURCE_INVALID');
  for (const id of IDS) { const node = sourceById.get(id); if (node?.type !== 'inject' || ![undefined, false].includes(node.d) || node.once !== true || node.repeat !== '5') throw new Error('MAX_PRESERVER_SOURCE_INJECT_INVALID'); }
  const sourceHttp = sourceById.get(HTTP_ID);
  if (sourceHttp?.type !== 'http request' || sourceHttp.requestTimeout !== '15000') throw new Error('MAX_PRESERVER_SOURCE_HTTP_INVALID');

  return ({ request, postBody }) => {
    if (consumed) throw new Error('MAX_PRESERVER_CONSUMED');
    consumed = true;
    if (!request || request.url !== 'http://127.0.0.1:18801/flows' || request.method !== 'POST' || request.apiVersion !== 'v2' || request.deploymentType !== 'nodes') throw new Error('MAX_PRESERVER_REQUEST_INVALID');
    if (!postBody || typeof postBody !== 'object' || Array.isArray(postBody) || !equal(Object.keys(postBody).sort(compare), ['flows', 'rev']) || typeof postBody.rev !== 'string' || !postBody.rev || postBody.rev.length > 512 || hash(postBody.rev) !== expectedPreRevisionSha256 || !Array.isArray(postBody.flows)) throw new Error('MAX_PRESERVER_BODY_INVALID');
    const body = structuredClone(postBody.flows); const byId = new Map(body.map((node) => [node?.id, node]));
    if (body.length !== 4857 || byId.size !== 4857 || byId.size !== sourceById.size || [...sourceById.keys()].some((id) => !byId.has(id))) throw new Error('MAX_PRESERVER_GRAPH_INVALID');
    const http = byId.get(HTTP_ID);
    if (!http || http.type !== 'http request') throw new Error('MAX_PRESERVER_HTTP_INVALID');
    let restored = 0;
    if (!Object.hasOwn(http, 'requestTimeout')) { http.requestTimeout = '15000'; restored = 1; }
    else if (http.requestTimeout !== '15000') throw new Error('MAX_PRESERVER_HTTP_OVERRIDE');
    for (const [id, before] of sourceById) {
      const after = byId.get(id); const expected = structuredClone(before);
      if (IDS.includes(id)) expected.d = true;
      if (!equal(expected, after)) throw new Error('MAX_PRESERVER_UNEXPECTED_DELTA');
    }
    const postDataText = JSON.stringify({ rev: postBody.rev, flows: body });
    return { postDataText, audit: { operationId, sourceCodePointSha256: expectedSourceCodePointSha256, preRevisionSha256: expectedPreRevisionSha256, nodeCount: 4857, pausedInjectIds: [...IDS], restoredRequestTimeoutCount: restored, postBodyCodePointSha256: codePointGraphSha256(body), forwardedBodySha256: hash(postDataText) } };
  };
}
