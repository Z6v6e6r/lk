import vm from 'node:vm';
import { BOOKING_HTTP_ID, BOOKING_ROUTER_ID, BOOKING_TRANSPORT_RECOVERY,
  prepareBookingTransportRecovery, sha256 } from './subscriptionBookingTransportRecovery.mjs';
import { buildExactGraphContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const TRANSPORT_CASES = Object.freeze([
  ['profile', 'http', 502],
  ['booking_create', 'http', 202],
  ['booking_create', 'split', 202],
  ['confirmation_bookings', 'http', 202],
  ['lk1_transaction_create', 'http', 202],
]);
export const NATIVE_CANCEL_TRANSPORT_CASES = Object.freeze([
  ['booking', false, 503],
  ['dispatch_ack', true, 202],
  ['cancelled_booking', true, 202],
  ['returned_subscription', true, 202],
]);
export const BOOKING_HTTP_CONSUMER_SHA256 = '173baaaea541b5a8c00e2aeabfe25fbd1cf899946b53fe785c3fa54abbfacced';

// Exercise the installed body with synthetic messages and no runtime context,
// database, credentials, transport, timers or process objects. Never execute
// the service launcher or a business HTTP operation during inspection.
function executeFailure(body, step, caller, expectedStatus, extra = {}, singleQuoted = false) {
  if (typeof body !== 'string') throw new Error('OWNER_BODY_REQUIRED');
  const marker = singleQuoted ? `if (ctx.step === '${step}') {` : `if (ctx.step === "${step}") {`;
  if (body.split(marker).length !== 2) throw new Error('OWNER_BRANCH_DRIFT');
  const source = body.replace(marker, marker + '__entered.push(' + JSON.stringify(step) + ');');
  const msg = { req: { method: 'POST', headers: {}, query: {} }, res: {},
    _subscriptionBooking: { step, caller, operationId: 'fixture-transport-operation',
      operationKey: 'fixture-transport-key', lk1: {}, actorClientId: 'fixture-actor', ...extra },
    statusCode: 200, headers: { Authorization: 'PRIVATE_FIXTURE' },
    payload: { id: 'PRIVATE_REQUEST_NOT_A_RESPONSE' }, error: { message: 'PRIVATE_TRANSPORT_ERROR' } };
  const forbidden = () => { throw new Error('OWNER_SIDE_EFFECT_FORBIDDEN'); };
  const entered = [], sent = [];
  const sandbox = vm.createContext({ msg, __entered: entered,
    global: { get() { return undefined; }, set: forbidden },
    env: { get() { return undefined; } }, context: { get() {}, set: forbidden },
    flow: { get() {}, set: forbidden }, RED: {},
    node: { warn() {}, error: forbidden, send: value => sent.push(value), done() {} },
    fetch: forbidden, require: forbidden, setTimeout: forbidden, setInterval: forbidden,
  }, { codeGeneration: { strings: false, wasm: false } });
  const nativeState = extra.lk1FreeCancellation, nativeSnapshot = JSON.stringify(nativeState);
  let ports;
  try {
    new vm.Script(`(function(msg){${BOOKING_TRANSPORT_RECOVERY}\n})(msg)`).runInContext(sandbox, { timeout: 1000 });
    ports = new vm.Script(`(function(msg){${source}\n})(msg)`).runInContext(sandbox, { timeout: 1000 });
  } catch { throw new Error('OWNER_TRANSPORT_CONTRACT_FAILED'); }
  if (sent.length || entered.join() !== step || !Array.isArray(ports)
    || ports.some((value, index) => index !== 4 && value != null)
    || ports[4]?.statusCode !== expectedStatus
    || (expectedStatus === 202 && ports[4].payload?.state !== 'PENDING_CONFIRMATION')
    || (nativeState && (JSON.stringify(nativeState) !== nativeSnapshot
      || ports[4].payload?.details?.code !== 'LK1_FREE_CANCEL_READ_UNAVAILABLE'
      || (expectedStatus === 202 && ports[4].payload.accepted !== true)))
    || JSON.stringify(ports[4]?.payload).includes('PRIVATE_')) throw new Error('OWNER_TRANSPORT_CONTRACT_FAILED');
  return { step, caller, status: expectedStatus, branchReached: true,
    httpDispatches: 0, persistenceDispatches: 0, asynchronousSends: 0 };
}
export function proveOwnerTransportContract(body) {
  return TRANSPORT_CASES.map(([step, caller, status]) => executeFailure(body, step, caller, status));
}
export function proveNativeCancellationTransportContract(body) {
  return NATIVE_CANCEL_TRANSPORT_CASES.map(([nativeStage, accepted, status]) => ({
    ...executeFailure(body, 'lk1_free_cancel_effect', 'http', status, {
      action: 'cancel-free',
      lk1FreeExpectedHttp: { method: 'GET', url: 'https://fixture.invalid/expected' },
      lk1FreeCancellation: { stage: nativeStage, accepted, bookingId: 'fixture-booking',
        binding: { operationId: 'fixture-operation' }, job: { phase: accepted ? 'CANCEL_INTENT' : 'QUEUED' } },
    }, true), nativeStage, durablyAccepted: accepted, protocolStatePreserved: true,
  }));
}

export function inspectBookingSource(bytes) {
  let flow;
  try { flow = JSON.parse(bytes); } catch { throw new Error('SOURCE_JSON_INVALID'); }
  const owner = flow.find(n => n.id === BOOKING_ROUTER_ID);
  const prepared = prepareBookingTransportRecovery(bytes, { sourceSha256: sha256(bytes), routerSha256: sha256(owner?.func || '') });
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes: prepared.candidate,
    deploymentId: 'lk1-booking-transport-v1', allowedChanges: [], allowedAdditionIds: prepared.addedNodeIds });
  const cases = proveOwnerTransportContract(owner.func);
  return { sourceSha256: prepared.sourceSha256, candidateSha256: prepared.candidateSha256,
    routerSha256: prepared.routerSha256, ownerCases: cases,
    nativeCancellationCases: proveNativeCancellationTransportContract(owner.func), exactGraphContract: contract,
    additions: JSON.parse(prepared.candidate).slice(flow.length),
    sourceNodeCount: flow.length, candidateNodeCount: flow.length + 2,
    unchangedExistingNodes: true, httpNodeId: BOOKING_HTTP_ID };
}
