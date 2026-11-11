import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const BOOKING_HTTP_ID = 'lk_subscription_booking_http_20260804';
export const BOOKING_ROUTER_ID = 'lk_subscription_booking_router_20260804';
export const BOOKING_TRANSPORT_CATCH_ID = 'lk_subscription_booking_transport_catch_v1';
export const BOOKING_TRANSPORT_RECOVERY_ID = 'lk_subscription_booking_transport_recovery_v1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

// HTTP node 4.0.9 invokes Catch BEFORE overwriting the original request payload
// and stale upstream status. Never let those values masquerade as a response.
// Keep the owner's context and req/res: the owner decides whether a write may
// already have happened. This node performs no request, release or persistence.
export const BOOKING_TRANSPORT_RECOVERY = `msg.statusCode = 503;
msg.payload = null;
msg.headers = {};
delete msg.responseUrl;
delete msg.responseCookies;
delete msg.error;
return msg;`;

// Pure source delta, deliberately separate from historical whole-flow composers.
// A reviewed fresh snapshot and its exact router hash are required from the caller.
// Existing wrappers, authority checks, leases and worker pins are never rewritten.
export function prepareBookingTransportRecovery(source, { sourceSha256, routerSha256 } = {}) {
  if (!Buffer.isBuffer(source) || sha256(source) !== sourceSha256
    || !/^[a-f0-9]{64}$/.test(routerSha256 || '')) throw new Error('BOOKING_TRANSPORT_PREIMAGE_REQUIRED');
  let flow;
  try { flow = JSON.parse(source); } catch { throw new Error('BOOKING_TRANSPORT_INVALID_JSON'); }
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('BOOKING_TRANSPORT_NODE_ID_DRIFT');
  const byId = new Map(flow.map(n => [n.id, n]));
  const http = byId.get(BOOKING_HTTP_ID), router = byId.get(BOOKING_ROUTER_ID);
  const tab = byId.get(http?.z);
  if (http?.type !== 'http request' || http.d === true || http.senderr !== true
    || http.method !== 'use' || http.ret !== 'obj'
    || !isDeepStrictEqual(http.wires, [[BOOKING_ROUTER_ID]])
    || tab?.type !== 'tab' || tab.disabled === true
    || router?.type !== 'function' || router.d === true || router.z !== http.z
    || sha256(router.func || '') !== routerSha256) throw new Error('BOOKING_TRANSPORT_OWNER_DRIFT');
  const entries = flow.filter(n => n.type === 'http in' && n.d !== true
    && byId.get(n.z)?.disabled !== true && n.method === 'post' && n.url === '/lk/subscription-bookings');
  if (entries.length !== 1 || entries[0].z !== http.z) throw new Error('BOOKING_TRANSPORT_INGRESS_DRIFT');
  if ([BOOKING_TRANSPORT_CATCH_ID, BOOKING_TRANSPORT_RECOVERY_ID].some(id => byId.has(id))) {
    throw new Error('BOOKING_TRANSPORT_ALREADY_PRESENT');
  }
  // A broad or second scoped Catch can deliver the same message to two owners.
  if (flow.some(n => n.type === 'catch' && n.d !== true && n.z === http.z
    && (!Array.isArray(n.scope) || n.scope.length === 0 || n.scope.includes(http.id)))) {
    throw new Error('BOOKING_TRANSPORT_CATCH_OVERLAP');
  }
  const added = [
    { id: BOOKING_TRANSPORT_CATCH_ID, type: 'catch', z: http.z,
      name: 'Catch subscription booking HTTP transport failures',
      scope: [http.id], uncaught: false, wires: [[BOOKING_TRANSPORT_RECOVERY_ID]] },
    { id: BOOKING_TRANSPORT_RECOVERY_ID, type: 'function', z: http.z,
      name: 'Restore subscription booking owner after transport failure',
      func: BOOKING_TRANSPORT_RECOVERY, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
      wires: [[router.id]] },
  ];
  const candidate = Buffer.from(JSON.stringify([...flow, ...added], null, 2) + '\n');
  return { candidate, sourceSha256, candidateSha256: sha256(candidate), routerSha256,
    addedNodeIds: added.map(n => n.id), readyForDeployment: false,
    activationBlockers: ['REVIEW_CURRENT_OWNER_CONTRACT', 'REBUILD_WHOLE_FLOW_PINNED_WORKER_GENERATIONS'] };
}
