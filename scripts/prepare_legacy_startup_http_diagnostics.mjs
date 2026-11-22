import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const approved = JSON.parse(fs.readFileSync(new URL('./legacy_startup_http/bindings.json', import.meta.url), 'utf8'));
const template = fs.readFileSync(new URL('./nodered_legacy_startup_nodes/fn_http_observe.js', import.meta.url), 'utf8');
const TYPES = { http: 'http request', builder: 'function', manual: 'inject', startup: 'start-up-trigger', debug: 'debug', tab: 'tab' };
const NEW_IDS = ['lk_legacy_http_observation_v1_response', 'lk_legacy_http_observation_v1_catch', 'lk_legacy_http_observation_v1_transport'];
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const startupHttpNodeHash = node => sha(JSON.stringify(canonical(node)));
const fail = code => { throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function renderStartupHttpObserver(stage, binding = approved.http) {
  if (!['response', 'transport_error'].includes(stage) || !digest(binding.identityHash) || !digest(binding.nodeSha256)) fail('HTTP_OBSERVER_BINDING_INVALID');
  const markers = ['const observationStage = "response";', `const nodeIdentityHash = "${approved.http.identityHash}";`, `const sourceFingerprint = "${approved.http.nodeSha256}";`];
  if (markers.some(marker => template.split(marker).length !== 2)) fail('HTTP_OBSERVER_TEMPLATE_DRIFT');
  return template.replace(markers[0], `const observationStage = ${JSON.stringify(stage)};`)
    .replace(markers[1], `const nodeIdentityHash = ${JSON.stringify(binding.identityHash)};`)
    .replace(markers[2], `const sourceFingerprint = ${JSON.stringify(binding.nodeSha256)};`);
}

// Offline composition only. The scoped catch is refused if this tab already has any catch.
// No HTTP request, authentication, payload/return-mode, headers, cache or retry change.
export function composeStartupHttpDiagnostics(sourceBytes, deploymentId, { expectedSourceSha256, bindings = approved } = {}) {
  if (!digest(expectedSourceSha256) || sha(sourceBytes) !== expectedSourceSha256) fail('HTTP_OBSERVER_SOURCE_DRIFT');
  let flow;
  try { flow = JSON.parse(Buffer.from(sourceBytes).toString('utf8')); } catch { fail('HTTP_OBSERVER_INVALID_FLOW'); }
  if (!Array.isArray(flow) || flow.some(n => !n || Array.isArray(n) || typeof n.id !== 'string' || !n.id.trim())
    || new Set(flow.map(n => n.id)).size !== flow.length) fail('HTTP_OBSERVER_INVALID_FLOW');
  if (!bindings || Object.keys(bindings).sort().join(',') !== Object.keys(TYPES).sort().join(',')) fail('HTTP_OBSERVER_BINDING_SET');
  const selected = {}, seen = new Set();
  for (const [role, type] of Object.entries(TYPES)) {
    const pin = bindings[role];
    if (!pin || pin.type !== type || !digest(pin.identityHash) || !digest(pin.nodeSha256) || seen.has(pin.identityHash)) fail('HTTP_OBSERVER_BINDING_INVALID');
    seen.add(pin.identityHash);
    const matches = flow.filter(n => sha(n.id) === pin.identityHash);
    if (matches.length !== 1 || matches[0].type !== type || startupHttpNodeHash(matches[0]) !== pin.nodeSha256) fail('HTTP_OBSERVER_NODE_DRIFT');
    selected[role] = matches[0];
  }
  const { http, tab, debug, builder, startup, manual } = selected;
  if (tab.disabled || [http, debug, builder, startup, manual].some(n => n.z !== tab.id || n.d)
    || http.ret !== 'obj' || JSON.stringify(http.wires) !== JSON.stringify([[debug.id]])) fail('HTTP_OBSERVER_GRAPH_DRIFT');
  if (flow.some(n => n.type === 'catch' && n.z === tab.id)) fail('HTTP_OBSERVER_EXISTING_CATCH_REVIEW_REQUIRED');
  if (flow.some(n => NEW_IDS.includes(n.id))) fail('HTTP_OBSERVER_ID_COLLISION');
  const makeFunction = (id, stage, wires) => ({
    id, type: 'function', z: tab.id, name: `Legacy HTTP observation: ${stage}`, outputs: 1, noerr: 0,
    func: renderStartupHttpObserver(stage, bindings.http), initialize: '', finalize: '', libs: [], wires,
  });
  const response = makeFunction(NEW_IDS[0], 'response', [[debug.id]]);
  const catcher = { id: NEW_IDS[1], type: 'catch', z: tab.id, name: 'Legacy HTTP transport observation', scope: [http.id], uncaught: false, wires: [[NEW_IDS[2]]] };
  const transport = makeFunction(NEW_IDS[2], 'transport_error', [[]]);
  http.wires = [[response.id]];
  const candidate = [...flow, response, catcher, transport];
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: sourceBytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: http.id, fields: ['wires'] }], allowedAdditionIds: NEW_IDS });
  validateReviewedFlowContract({ liveBytes: sourceBytes, candidateBytes, contract });
  return {
    candidate, candidateBytes, contract,
    receipt: { formatVersion: 1, operation: 'legacy-startup-http-observation', sourceSha256: expectedSourceSha256,
      candidateSha256: sha(candidateBytes), observerSourceSha256: sha(template), nodeIdentityHash: bindings.http.identityHash,
      changedExistingNodeCount: 1, addedNodeCount: 3, requestConfigurationUnchanged: true, deploymentAuthorized: false },
  };
}
