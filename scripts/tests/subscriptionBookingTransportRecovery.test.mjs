import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BOOKING_HTTP_ID as httpId, BOOKING_ROUTER_ID as routerId,
  BOOKING_TRANSPORT_CATCH_ID as catchId, BOOKING_TRANSPORT_RECOVERY_ID as recoveryId,
  BOOKING_TRANSPORT_RECOVERY, prepareBookingTransportRecovery, sha256,
} from '../lib/subscriptionBookingTransportRecovery.mjs';
import { prepareArtifacts } from '../prepare_subscription_booking_transport.mjs';
import { routeTemplate, sanitizeEvent } from '../../src/utils/errorDiagnosticsCore.mjs';

const fixture = () => [
  { id: 'tab', type: 'tab', label: 'LK Games' },
  { id: 'entry', type: 'http in', z: 'tab', method: 'post', url: '/lk/subscription-bookings', wires: [['prepare']] },
  { id: httpId, type: 'http request', z: 'tab', method: 'use', ret: 'obj', senderr: true, wires: [[routerId]] },
  { id: routerId, type: 'function', z: 'tab', func: '// installed wrappers retained\nreturn msg;', outputs: 8, wires: [[httpId]] },
  { id: 'mongo-catch', type: 'catch', z: 'tab', scope: ['mongo'], wires: [['mongo-error']] },
];
const build = flow => {
  const bytes = Buffer.from(JSON.stringify(flow));
  return prepareBookingTransportRecovery(bytes, { sourceSha256: sha256(bytes), routerSha256: sha256(flow.find(n => n.id === routerId).func) });
};
test('candidate adds exactly one HTTP owner and preserves every installed node/wrapper/pin', () => {
  const source = fixture(), result = build(source), candidate = JSON.parse(result.candidate);
  assert.deepEqual(candidate.slice(0, source.length), source);
  assert.deepEqual(candidate.slice(source.length).map(n => n.id), [catchId, recoveryId]);
  assert.deepEqual(candidate.find(n => n.id === catchId).scope, [httpId]);
  assert.deepEqual(candidate.find(n => n.id === recoveryId).wires, [[routerId]]);
  assert.equal(result.readyForDeployment, false);
  assert(result.activationBlockers.includes('REBUILD_WHOLE_FLOW_PINNED_WORKER_GENERATIONS'));
  assert.throws(() => build(candidate), /ALREADY_PRESENT/);
});
test('reject source, owner, ingress, duplicate IDs and overlapping error custody', () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  assert.throws(() => prepareBookingTransportRecovery(bytes, { sourceSha256: '0'.repeat(64), routerSha256: '1'.repeat(64) }), /PREIMAGE/);
  assert.throws(() => prepareBookingTransportRecovery(bytes, { sourceSha256: sha256(bytes), routerSha256: '1'.repeat(64) }), /OWNER_DRIFT/);
  for (const mutate of [
    f => { f[2].wires.push(['foreign']); },
    f => { f[2].senderr = false; },
    f => { f[0].disabled = true; },
    f => { f.push({ ...f[1], id: 'duplicate-route' }); },
    f => { f.push({ ...f[1] }); },
    f => { f.push({ id: 'all', z: 'tab', type: 'catch', scope: null }); },
    f => { f.push({ id: 'all', z: 'tab', type: 'catch', scope: [] }); },
    f => { f.push({ id: 'second', z: 'tab', type: 'catch', scope: [httpId] }); },
  ]) {
    const flow = fixture(); mutate(flow); assert.throws(() => build(flow), /DRIFT|OVERLAP/);
  }
});
test('official 4.0.9 HTTP transport exception reaches owner once with no stale status or private request body', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules',
    fileURLToPath(new URL('./fixtures/noderedHttpDeadlineRuntime.mjs', import.meta.url)), 'booking-transport'],
  { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.productionAccess, false); assert.equal(evidence.providerCalls, 0);
  assert.equal(evidence.nativeErrors, 1); assert.equal(evidence.nativeErrorSends, 0);
  assert.equal(evidence.prewriteStatus, 502); assert.equal(evidence.postwriteStatus, 202);
});
test('real owner returns failure before writing and preserves ambiguous booking without new POST, FAILED or release', () => {
  const source = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const run = new Function('msg', 'global', 'env', source);
  for (const step of ['profile', 'booking_create', 'confirmation_bookings']) {
    const req = {}, res = {}, ctx = { step, operationId: 'fixture-operation', operationKey: 'fixture-key', caller: 'http' };
    const msg = { req, res, _subscriptionBooking: ctx, statusCode: 200,
      payload: { id: 'PRIVATE_REQUEST_NOT_A_BOOKING' }, error: { message: 'PRIVATE_TRANSPORT' } };
    new Function('msg', BOOKING_TRANSPORT_RECOVERY)(msg);
    const ports = run(msg, { get() {} }, { get() {} });
    assert(ports.slice(0, 4).every(n => n === null), 'no HTTP dispatch or Mongo transition');
    const reply = ports[4]; assert.equal(reply.req, req); assert.equal(reply.res, res);
    if (step === 'profile') assert.equal(reply.statusCode, 502);
    else { assert.equal(reply.statusCode, 202); assert.equal(reply.payload.state, 'PENDING_CONFIRMATION'); }
    assert(!JSON.stringify(reply.payload).includes('PRIVATE_'));
  }
});
test('real LK1 checkout branch preserves ambiguity after transaction POST', () => {
  const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (ctx.step === "lk1_transaction_create") {');
  const end = source.indexOf('if (ctx.step === "lk1_transaction_id_saved") {', start);
  assert(start > 0 && end > start);
  let stops = 0;
  const msg = { statusCode: 200, payload: { id: 'PRIVATE_REQUEST' }, error: { message: 'PRIVATE_ERROR' } };
  new Function('msg', BOOKING_TRANSPORT_RECOVERY)(msg);
  const ctx = { step: 'lk1_transaction_create', lk1: {} };
  const result = new Function('msg', 'ctx', 'unwrapRecord', 'isHttpOk', 'lk1Stop', 'prepareMongoUpdate', source.slice(start, end))(
    msg, ctx, value => value, s => s >= 200 && s < 300,
    (owner, code) => { stops++; assert.equal(owner, ctx); return { statusCode: 202, code }; },
    () => assert.fail('ambiguous transaction must not advance persistence'));
  assert.deepEqual(result, { statusCode: 202, code: 'LK1_TRANSACTION_OUTCOME_UNKNOWN' });
  assert.equal(stops, 1); assert.deepEqual(ctx.lk1, {});
});
test('purchase route survives safe telemetry normalization while query values and unknown suffixes do not', () => {
  const route = '/lk/tournaments/summer-subscription/purchase';
  assert.equal(routeTemplate(route + '?client=PRIVATE&token=PRIVATE'), route);
  assert.equal(routeTemplate(route + '/PRIVATE'), 'UNKNOWN');
  const event = sanitizeEvent({ schemaVersion: 1, diagnosticEventId: randomUUID(), requestId: randomUUID(), source: 'browser', routeTemplate: route,
    stage: 'api_request', code: 'CLIENT_HTTP_ERROR', httpStatus: 502, payload: 'PRIVATE' });
  assert.equal(event.routeTemplate, route); assert(!JSON.stringify(event).includes('PRIVATE'));
});
test('artifact preparation refuses stale sources and preserves existing outputs; fresh local fixture remains not deployable', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'booking-transport-test-')));
  try {
    const input = path.join(dir, 'input'); fs.mkdirSync(input, { mode: 0o700 });
    const source = path.join(input, 'source.flow.json'), output = path.join(dir, 'prepared');
    const flow = fixture(), bytes = Buffer.from(JSON.stringify(flow)); fs.writeFileSync(source, bytes, { mode: 0o600 });
    const meta = { formatVersion: 1, localSourcePath: source, nodeCount: flow.length,
      sourceKind: 'live-147', sourceHost: 'lk-primary-147', sourceUser: 'root', sourcePort: '22',
      remoteFlowPath: '/root/.node-red/flows.json', sourceSha256: sha256(bytes), pulledAt: new Date(Date.now() - 31 * 60000).toISOString() };
    const metadata = path.join(input, 'source.flow.meta.json'); fs.writeFileSync(metadata, JSON.stringify(meta), { mode: 0o600 });
    const hash = sha256(flow[3].func);
    assert.throws(() => prepareArtifacts(dir, output, hash), /stale/); assert(!fs.existsSync(output));
    meta.pulledAt = new Date().toISOString(); fs.writeFileSync(metadata, JSON.stringify(meta));
    const report = prepareArtifacts(dir, output, hash);
    assert.equal(report.readyForDeployment, false);
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(output, 'candidate.flow.json')).mode & 0o777, 0o600);
    assert.throws(() => prepareArtifacts(dir, output, hash), /OUTPUT_MUST_NOT_EXIST/);
    assert(fs.existsSync(path.join(output, 'candidate.flow.json')));
    assert.throws(() => prepareArtifacts(dir, path.resolve('private-flow-must-not-exist'), hash), /OUTSIDE_GIT/);
    fs.chmodSync(source, 0o644);
    assert.throws(() => prepareArtifacts(dir, path.join(dir, 'wrong-mode'), hash), /mode 600/);
    fs.chmodSync(source, 0o600);
    fs.linkSync(source, path.join(dir, 'hard-link'));
    assert.throws(() => prepareArtifacts(dir, path.join(dir, 'linked'), hash), /hard-linked/);
    fs.unlinkSync(path.join(dir, 'hard-link'));
    fs.writeFileSync(metadata, '{"PRIVATE_SOURCE_SENTINEL":');
    const failure = spawnSync(process.execPath, ['scripts/prepare_subscription_booking_transport.mjs', dir, path.join(dir, 'malformed'), hash], { encoding: 'utf8' });
    assert.equal(failure.status, 1); assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.trim(), 'BOOKING_TRANSPORT_PREPARATION_FAILED');
    assert(!fs.existsSync(path.join(dir, 'malformed')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
