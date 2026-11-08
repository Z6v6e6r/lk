import {
  providerAccountAttestationSource,
  providerAccountSelectorSha256,
} from './lib/providerAccountAttestationSource.mjs';
import {
  buildExactGraphContract,
  validateReviewedFlowContract,
} from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const PROVIDER_ACCOUNT_ROUTE = '/lk/integrations/v1/provider-account-attestations';
export const providerAccountAttestationIds = Object.freeze(
  Object.fromEntries(
    ['tab', 'in', 'probe_in', 'verify', 'router', 'http', 'probe', 'sanitize', 'response'].map((k) => [
      k,
      'lk_provider_account_attestation_' + k + '_20261108',
    ]),
  ),
);

// Pure additive candidate construction (lk2 ADR 0028). Never installs, enables the flag or
// changes an existing node or wire.
export function composeProviderAccountAttestation(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  const ids = providerAccountAttestationIds;
  if (!Array.isArray(flow) || flow.some((n) => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map((n) => n.id)).size !== flow.length) throw new Error('PROVIDER_ACCOUNT_GRAPH_INVALID');
  const reserved = new Set(Object.values(ids));
  if (flow.some((n) => reserved.has(n.id) || (n.type === 'http in' && typeof n.url === 'string'
    && n.url.replace(/^\/*/, '/').replace(/\/+$/, '').toLowerCase() === PROVIDER_ACCOUNT_ROUTE))) {
    throw new Error('PROVIDER_ACCOUNT_ROUTE_COLLISION');
  }
  // A formerly dangling edge must not become an unauthenticated route into the new nodes.
  if (flow.some((n) => reserved.has(n.z) || [n.wires, n.links, n.scope]
    .some((value) => Array.isArray(value) && value.flat().some((id) => reserved.has(id))))) {
    throw new Error('PROVIDER_ACCOUNT_FOREIGN_EDGE_COLLISION');
  }
  const fn = (id, name, label, outputs, wires) => ({
    id, type: 'function', z: ids.tab, name: 'Provider account ' + label,
    func: providerAccountAttestationSource(name), outputs, wires,
    libs: [{ var: 'nodeCrypto', module: 'crypto' }], initialize: '', finalize: '',
  });
  const additions = [
    { id: ids.tab, type: 'tab', label: 'Provider account attestation (read-only, lk2 ADR 0028)', disabled: false,
      info: 'Signed lk2 delegation + actor token -> GET profile/subscriptions/exercise. No writes.' },
    { id: ids.in, type: 'http in', z: ids.tab, name: 'Provider account attestation', url: PROVIDER_ACCOUNT_ROUTE,
      method: 'post', upload: false, wires: [[ids.verify]] },
    { id: ids.probe_in, type: 'http in', z: ids.tab, name: 'Provider account attestation probe',
      url: PROVIDER_ACCOUNT_ROUTE, method: 'get', upload: false, wires: [[ids.probe]] },
    fn(ids.verify, 'verify', 'verify', 2, [[ids.router], [ids.sanitize]]),
    fn(ids.router, 'router', 'router', 2, [[ids.http], [ids.sanitize]]),
    // senderr:false forwards transport errors and every status to the router exactly once, so
    // there is no catch node (a catch would route the same failure a second time).
    { id: ids.http, type: 'http request', z: ids.tab, name: 'Provider account actor-token GET', method: 'use',
      ret: 'obj', url: '', paytoqs: 'ignore', requestTimeout: '10000', senderr: false, persist: false,
      authType: '', insecureHTTPParser: false, wires: [[ids.router]] },
    fn(ids.probe, 'probe', 'probe', 1, [[ids.sanitize]]),
    fn(ids.sanitize, 'response', 'response', 1, [[ids.response]]),
    { id: ids.response, type: 'http response', z: ids.tab, name: 'Provider account response', statusCode: '',
      headers: {}, wires: [] },
  ];
  for (const n of additions.filter((x) => x.type === 'function')) {
    new Function('msg', 'env', 'global', 'context', 'nodeCrypto', n.func);
  }
  const candidate = [...flow, ...additions];
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges: [],
    allowedAdditionIds: Object.values(ids) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, selectorRevision: providerAccountSelectorSha256 };
}
