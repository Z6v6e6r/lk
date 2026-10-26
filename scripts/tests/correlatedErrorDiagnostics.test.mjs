import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { sanitizeEvent, routeTemplate } from '../../src/utils/errorDiagnosticsCore.mjs';
import { createDiagnostics } from '../diagnostics/runtime.mjs';
import { composeDiagnosticSettings } from '../diagnostics/compose.mjs';
import { createCollector } from '../diagnostics/collector.mjs';
import { applySourceHooks, hooks, sha } from '../diagnostics/source-hooks.mjs';
import { addMaxObservers } from '../diagnostics/max-observers.mjs';
import { referralObserverBindings, referralObserverEdits, instrumentReferralFunction,
  referralGraphHash, referralRouteHash, scopedReferralGraphHash, assertCurrentReferralBinding,
  applyCurrentReferralObserver } from '../diagnostics/referral-observer-overlay.mjs';
const base = () => ({ schemaVersion: 1, diagnosticEventId: randomUUID(), requestId: randomUUID(), eventKind: 'client_error', source: 'browser', stage: 'api_request', code: 'CLIENT_HTTP_ERROR' });
const read = path => fs.readFileSync(path, 'utf8');
function run(path, input, observer, original = false, extra = {}) {
  let source = original ? execFileSync('git', ['show', `91b016eb84be8269abc2b21d05a791dbfb87f4c3:${path}`], { encoding: 'utf8' }) : read(path);
  if (!original && Object.hasOwn(referralObserverBindings, path)) source = instrumentReferralFunction(source, referralObserverBindings[path].stage);
  const msg = structuredClone(input);
  const globals = { get: key => key === 'lkDiagnostics' ? observer : extra[key] ?? null, set() {} };
  const node = { warn() {}, error() {}, send() {}, ...extra.node };
  return { result: new Function('msg', 'global', 'env', 'flow', 'node', 'context', source)(msg, globals,
    { get: key => extra[key] ?? null }, globals, node, globals), msg };
}
class Response extends EventEmitter {
  headers = {}; statusCode = 200;
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; }
  getHeader(key) { return this.headers[key.toLowerCase()]; }
  end(body) { this.body = body; this.emit('finish'); return this; }
}
test('schema excludes arbitrary secret/PII/control strings, objects, getters and all unlisted fields', () => {
  for (let i = 0; i < 100; i++) {
    const secret = `${randomBytes(40).toString('hex')}\r\n\u0000`;
    const event = sanitizeEvent({ ...base(), error: secret, body: { token: secret }, Authorization: secret,
      routeTemplate: secret, stage: secret, code: secret, callerBuild: secret, entityRef: secret, durationMs: secret,
      errorMessage: secret, errorStack: secret, sessionId: secret, phone: secret, user: { name: secret } });
    const out = JSON.stringify(event);
    assert(!out.includes(secret)); assert(!out.includes('Authorization')); assert(out.length <= 4096);
  }
  assert.equal(sanitizeEvent({ ...base(), requestId: { toString: () => randomUUID(), token: 'private' } }), null);
  assert.equal(sanitizeEvent({ ...base(), get code() { throw Error('secret'); } }), null);
  assert.equal(sanitizeEvent({ ...base(), schemaVersion: 2 }), null);
});
test('exact production source routes, queries and negative lookalikes map to bounded templates', () => {
  for (const path of ['/lk/subscriptions/game-price-preview', '/lk/tournaments/referral-subscription/purchase', '/lk/tournaments/referral-subscription/confirm', '/lk/tournaments/participants', '/lk/analytics/auth-consents']) {
    assert.equal(routeTemplate(path), path); assert.equal(routeTemplate(`${path}?secret=hidden`), path);
    assert.equal(routeTemplate(`${path}/wrong`), 'UNKNOWN');
  }
  assert.equal(routeTemplate('/lk/games/private?phone=hidden'), '/lk/games/:gameId');
  assert.equal(routeTemplate('/other/private'), 'UNKNOWN');
});
test('composition installs real observer; legacy/invalid request ID ignored, preflight/304/body unchanged', () => {
  const events = []; let calls = 0;
  const previous = (req, res, next) => { calls++; next(); };
  const settings = composeDiagnosticSettings({ httpNodeMiddleware: previous, functionGlobalContext: { other: true } }, { sink: event => events.push(event) });
  for (const method of ['GET', 'OPTIONS']) for (const id of [undefined, 'private\r\n', randomUUID()]) {
    const req = { path: '/lk/subscriptions/game-price-preview', method, headers: { 'x-lk-request-id': id } };
    const res = new Response(); res.setHeader('Access-Control-Allow-Origin', 'https://example.invalid');
    let next = 0; settings.httpNodeMiddleware(req, res, () => next++);
    res.setHeader('Access-Control-Expose-Headers', 'ETag'); res.statusCode = 304; res.end('unchanged');
    assert.equal(next, 1); assert.equal(res.body, 'unchanged'); assert.equal(res.statusCode, 304);
    assert.equal(res.getHeader('Access-Control-Allow-Origin'), 'https://example.invalid');
    assert(res.getHeader('Access-Control-Expose-Headers').includes('ETag'));
    assert(res.getHeader('Access-Control-Expose-Headers').includes('X-LK-Request-ID'));
    assert.notEqual(res.getHeader('X-LK-Request-ID'), id);
  }
  assert.equal(calls, 6); assert.equal(events.filter(e => e.eventKind === 'request_terminal').length, 6);
  assert(settings.functionGlobalContext.lkDiagnostics);
  let nextCalls = 0;
  assert.throws(() => settings.httpNodeMiddleware({ path: '/lk/games/x' }, new Response(), () => { nextCalls++; throw Error('business'); }));
  assert.equal(nextCalls, 1);
});
test('disconnect and late DB ACK remain independent; missing ACK is outcome_unknown', () => {
  for (const ackBefore of [true, false]) {
    const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
    const req = { path: '/lk/games/x', method: 'PATCH' }, res = new Response(), msg = { req, res };
    observer.middleware(req, res, () => {});
    if (ackBefore) observer.observe(msg, 'roster_ack', { eventKind: 'operation_result', acknowledged: true, code: 'DB_ACK' });
    res.emit('close');
    if (!ackBefore) observer.observe(msg, 'roster_ack', { eventKind: 'operation_result', acknowledged: true, code: 'DB_ACK' });
    const terminal = events.find(e => e.eventKind === 'request_terminal'), ack = events.find(e => e.code === 'DB_ACK');
    assert.equal(terminal.code, 'DISCONNECT'); assert.equal(terminal.outcome, ackBefore ? 'acknowledged' : 'outcome_unknown');
    assert.equal(terminal.requestId, ack.requestId); assert.notEqual(terminal.diagnosticEventId, ack.diagnosticEventId);
  }
});
test('no diagnostic key omits low-entropy references; domain-separated HMAC uses dedicated key', () => {
  const noKey = createDiagnostics(); assert.equal(noKey.ref('entity', 'low-entropy'), undefined);
  const keyed = createDiagnostics({ key: Buffer.alloc(32, 17) });
  assert.match(keyed.ref('entity', 'low-entropy'), /^h1:[a-f0-9]{32}$/);
  assert.notEqual(keyed.ref('entity', 'x'), keyed.ref('outbox', 'x'));
});
test('logger throws and suppression preserve accounting without altering business status/body', () => {
  const observer = createDiagnostics({ detailLimit: 1, sink() { throw Error('private'); } });
  const msg = { payload: 'unchanged', statusCode: 418 };
  observer.observe(msg, 'purchase_resolve'); observer.observe(msg, 'purchase_resolve');
  assert.deepEqual(msg, { payload: 'unchanged', statusCode: 418 });
  observer.flushSuppressed();
  assert.deepEqual(observer.snapshot(), { observed: 2, suppressed: 1, loggerFailures: 2 });
});
test('409 authorization, unknown binding, CAS matched0 and ACK preserve original outputs and writes', () => {
  const authorizer = 'scripts/nodered_partner_roster_nodes/fn_authorize.js';
  const game = { id: 'synthetic-game', _id: 'synthetic-row', revision: 2, updatedAt: 'synthetic-time' };
  for (const body of [{ participants: [] }, { expectedRevision: '2' }, { expectedRevision: 1 }, { expectedRevision: 2 }, { expectedUpdatedAt: false }]) {
    const input = { _partnerRosterPatch: { body, gameId: game.id }, payload: [game] };
    const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
    assert.deepEqual(run(authorizer, input, observer), run(authorizer, input, undefined, true));
    assert(events.some(e => 'revisionEqual' in e));
    assert.deepEqual(run(authorizer, input, { observe() { throw Error('logging'); } }), run(authorizer, input, undefined, true));
  }
  for (const input of [{ error: {}, _partnerRosterPatch: {}, payload: [] }, { _partnerRosterPatch: { gameId: 'x' }, payload: [{ id: 'y' }] }]) {
    assert.deepEqual(run(authorizer, input, createDiagnostics()), run(authorizer, input, undefined, true));
  }
  const ackPath = 'scripts/nodered_partner_roster_nodes/fn_ack.js';
  for (const result of [{ acknowledged: true, matchedCount: 0, modifiedCount: 0 }, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, {}]) {
    const input = { payload: result, _partnerRosterPatch: { response: { payload: { ok: true }, statusCode: 200 } } };
    assert.deepEqual(run(ackPath, input, createDiagnostics()), run(ackPath, input, undefined, true));
  }
});
test('purchase418 at each upstream stage/body kind preserves business response and request count', () => {
  for (const stage of ['find_owner_client', 'load_owner_subscription', 'token_owner']) for (const payload of ['denied', null, [], {}, { code: 'private', token: 'private' }]) {
    const file = 'scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js';
    const input = { statusCode: 418, payload, _referralSubscriptionCtx: { action: 'purchase', step: stage } };
    const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
    assert.deepEqual(run(file, input, observer), run(file, input, undefined, true));
    assert(events.some(e => e.upstreamStatus === 418 && e.stage === stage));
    assert(!JSON.stringify(events).includes('private'));
  }
  const file = 'scripts/nodered_games_nodes/fn_referral_subscription_purchase_resolve.js';
  const input = { statusCode: 418, payload: 'denied', _referralSubscriptionCtx: { action: 'purchase', step: 'create_transaction' } };
  assert.deepEqual(run(file, input, createDiagnostics()), run(file, input, undefined, true));
});
test('auth403/text with and without allowlisted provider reason has no refresh/claims dumps', () => {
  const file = 'scripts/nodered_auth_consent_nodes/fn_auth_consent_build_upsert.js';
  for (const payload of ['private text', { error: 'insufficient_scope', access_token: 'private token' }]) {
    const input = { statusCode: 403, payload, _authConsent: {}, headers: { 'content-type': 'text/plain' } };
    const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
    assert.deepEqual(run(file, input, observer), run(file, input, undefined, true));
    assert(!JSON.stringify(events).includes('private'));
    assert(events.some(e => e.httpStatus === 401 && e.upstreamStatus === 403));
    const throws = run(file, input, observer, false, { node: { warn() { throw Error('logger'); } } });
    assert.equal(throws.msg.statusCode, 401);
  }
});

// Reproduce only the observed structural difference with an explicitly synthetic
// auth body. No installed function body or auth literal is a repository fixture.
function syntheticCurrentReferral(path) {
  let source = execFileSync('git', ['show', `91b016eb84be8269abc2b21d05a791dbfb87f4c3:${path}`], { encoding: 'utf8' });
  const start = source.indexOf('const readVivaServiceEnv =');
  const end = source.indexOf(path.includes('purchase_prepare') ? 'const toInt =' : 'const normalizePhone =', start);
  assert(start > 0 && end > start);
  source = source.slice(0, start) + source.slice(end);
  const authStart = source.indexOf('msg.payload = buildVivaServiceTokenRequestBody();');
  const authEnd = source.indexOf('\n}', authStart) + 2;
  assert(authStart > 0 && authEnd > authStart);
  return source.slice(0, authStart) + 'msg.payload = "SYNTHETIC_OPAQUE_AUTH_BODY";' + source.slice(authEnd);
}
function executeReferral(source, input, observer) {
  const msg = structuredClone(input);
  const globals = { get: key => key === 'lkDiagnostics' ? observer : null, set() {} };
  class FixedDate extends Date { static now() { return 1792713600000; } }
  const result = new Function('msg', 'global', 'env', 'Date', source)(msg, globals,
    { get() { assert.fail('current synthetic preimage must not acquire credentials'); } }, FixedDate);
  return { msg, result };
}
test('current referral overlay preserves every opaque business byte and synthetic outcome on logger failure', () => {
  for (const [path, binding] of Object.entries(referralObserverBindings)) {
    const source = syntheticCurrentReferral(path), candidate = instrumentReferralFunction(source, binding.stage);
    const edits = referralObserverEdits(binding.stage, sha(source));
    assert(candidate.startsWith(edits.prefix));
    assert.equal(candidate.slice(edits.prefix.length).replace(edits.needle + edits.addition, edits.needle), source);
    assert(candidate.includes('SYNTHETIC_OPAQUE_AUTH_BODY'));
    const inputs = binding.stage === 'purchase_prepare' ? [
      { payload: { paymentRef: 'synthetic-operation' } },
      { payload: { inviteId: 'synthetic-invite', clientPhone: '7' + '0'.repeat(10), planKey: 'academy', paymentRef: 'synthetic-operation' } },
      { payload: { ownerPhone: '7' + '0'.repeat(10), ownerSubscriptionId: 'synthetic-subscription',
        clientPhone: '7' + '0'.repeat(10), planKey: 'academy', paymentRef: 'synthetic-operation' } },
    ] : ['token_owner', 'find_owner_client', 'load_owner_subscription'].map(step => ({
      statusCode: 418, payload: { error: 'SYNTHETIC_PRIVATE_RESPONSE', token: 'SYNTHETIC_PRIVATE_RESPONSE' },
      _referralSubscriptionCtx: { action: 'purchase', step },
    }));
    for (const input of inputs) {
      const events = [], observer = createDiagnostics({ sink: event => events.push(event) });
      const original = executeReferral(source, input);
      assert.deepEqual(executeReferral(candidate, input, observer), original);
      assert.deepEqual(executeReferral(candidate, input, { observe() { throw Error('sink'); }, upstream() { throw Error('sink'); } }), original);
      assert(events.length > 0);
      assert(!JSON.stringify(events).includes('SYNTHETIC_'));
      if (binding.stage === 'owner_resolve') assert(events.some(event => event.upstreamStatus === 418));
    }
    assert.throws(() => instrumentReferralFunction(candidate, binding.stage), /SOURCE_DRIFT/);
    assert.throws(() => instrumentReferralFunction(source + edits.needle, binding.stage), /SOURCE_DRIFT/);
    assert.throws(() => instrumentReferralFunction(source, 'arbitrary-stage'), /SCOPE_INVALID/);
  }
});
test('scoped receipt binds both opaque preimages and exact candidate hashes without exporting function/config values', () => {
  const receipt = JSON.parse(read('docs/diagnostics/referral-preimages.20261023.json'));
  assert.equal(receipt.readStable, true); assert.equal(receipt.tabDisabled, false);
  assert.equal(receipt.loadedRuntimeParity, 'UNKNOWN');
  assert.equal(receipt.routeHash, referralRouteHash);
  assert.equal(receipt.graphHash, referralGraphHash);
  assert.equal(scopedReferralGraphHash(receipt.graph), referralGraphHash);
  for (const binding of Object.values(referralObserverBindings)) {
    const target = receipt.targets.find(target => target.id === binding.id);
    assert.equal(target.preimageHash, binding.preimageHash); assert.equal(target.candidateHash, binding.candidateHash);
    assert.equal(target.recoveredPreimageMatches, true);
    assert.equal(target.observerEditsHash, sha(JSON.stringify(referralObserverEdits(binding.stage, binding.preimageHash))));
  }
  assert(!/"(?:func|payload|headers|uri|password|username|credentials)"\s*:/.test(JSON.stringify(receipt)));
  const drift = structuredClone(receipt.graph); drift[2].wires = [[]];
  assert.notEqual(scopedReferralGraphHash(drift), referralGraphHash);
});
test('current referral application refuses stale tracked replacement, synthetic lookalikes and topology drift without mutation', () => {
  const receipt = JSON.parse(read('docs/diagnostics/referral-preimages.20261023.json'));
  for (const [path, binding] of Object.entries(referralObserverBindings)) {
    const flow = [...structuredClone(receipt.graph), { id: 'ac5d37d8ebd616ca', type: 'tab', disabled: false }];
    flow[0].url = '/lk/tournaments/referral-subscription/purchase'; flow[0].method = 'post';
    const old = execFileSync('git', ['show', `91b016eb84be8269abc2b21d05a791dbfb87f4c3:${path}`], { encoding: 'utf8' });
    flow.find(node => node.id === binding.id).func = old;
    const original = structuredClone(flow);
    const attestation = { id: binding.id, path, routeId: flow[0].id, routeHash: sha(JSON.stringify(flow[0])),
      preimageHash: sha(old), candidateHash: sha(read(path)) };
    assert.throws(() => applySourceHooks(flow, [attestation]), /SOURCE_DRIFT/);
    assert.deepEqual(flow, original);
    assert.throws(() => applySourceHooks(flow, [{ ...attestation, ...binding }]), /SOURCE_DRIFT/);
    flow[2].wires = [[]];
    assert.throws(() => applySourceHooks(flow, [{ ...attestation, ...binding }]), /BINDING|SOURCE_DRIFT/);
  }
});
test('current referral metadata admission accepts only exact observed identities, hashes and active scoped graph', () => {
  const receipt = JSON.parse(read('docs/diagnostics/referral-preimages.20261023.json'));
  for (const [path, binding] of Object.entries(referralObserverBindings)) {
    const flow = [...structuredClone(receipt.graph), { id: 'ac5d37d8ebd616ca', type: 'tab', disabled: false }];
    const attestation = { path, id: binding.id, routeId: receipt.graph[0].id, routeHash: receipt.routeHash,
      preimageHash: binding.preimageHash, candidateHash: binding.candidateHash };
    assert.doesNotThrow(() => assertCurrentReferralBinding(flow, attestation, binding.preimageHash));
    for (const delta of [{ id: 'other' }, { routeId: 'other' }, { routeHash: '0'.repeat(64) },
      { preimageHash: '0'.repeat(64) }, { candidateHash: '0'.repeat(64) }, { path: 'unregistered' }]) {
      assert.throws(() => assertCurrentReferralBinding(flow, { ...attestation, ...delta }, binding.preimageHash), /SOURCE_DRIFT/);
    }
    assert.throws(() => assertCurrentReferralBinding(flow, attestation, '0'.repeat(64)), /SOURCE_DRIFT/);
    assert.throws(() => applyCurrentReferralObserver(flow, attestation, syntheticCurrentReferral(path)), /SOURCE_DRIFT/);
    const disabled = structuredClone(flow); disabled.at(-1).disabled = true;
    assert.throws(() => assertCurrentReferralBinding(disabled, attestation, binding.preimageHash), /SOURCE_DRIFT/);
    const rewired = structuredClone(flow); rewired[2].wires = [[]];
    assert.throws(() => assertCurrentReferralBinding(rewired, attestation, binding.preimageHash), /SOURCE_DRIFT/);
    assert.throws(() => assertCurrentReferralBinding([...flow, flow[1]], attestation, binding.preimageHash), /SOURCE_DRIFT/);
    assert.throws(() => assertCurrentReferralBinding([...flow, { id: flow.at(-1).id, type: 'function' }], attestation, binding.preimageHash), /SOURCE_DRIFT/);
  }
});
test('guarded source application rejects drift/ambiguous identity without modifying supplied flow', () => {
  const path = Object.keys(hooks)[0], func = execFileSync('git', ['show', `91b016eb84be8269abc2b21d05a791dbfb87f4c3:${path}`], { encoding: 'utf8' }), flow = [{ id: 'synthetic', type: 'function', z: 'tab', func, wires: [['unchanged']] }, { id: 'route', type: 'http in', z: 'tab', url: '/lk/games/split/create', wires: [['synthetic']] }];
  const attestation = { id: 'synthetic', path, preimageHash: sha(func), candidateHash: sha(read(path)), routeId: 'route', routeHash: sha(JSON.stringify(flow[1])) };
  const candidate = applySourceHooks(flow, [attestation]);
  assert.equal(flow[0].func, func); assert.deepEqual(candidate[0].wires, flow[0].wires);
  assert.throws(() => applySourceHooks(flow, [{ ...attestation, preimageHash: 'wrong' }]), /DRIFT/);
  assert.throws(() => applySourceHooks([...flow, ...flow], [attestation]), /DIAGNOSTIC_ROUTE_BINDING_REQUIRED/);
  assert.throws(() => applySourceHooks(flow, [{ ...attestation, routeId: 'missing' }]), /BINDING/);
});
test('MAX both bot routes observe SDK output/errors without extra send/ACK/retry wires', () => {
  for (const connector of ['MAX_BOT', 'MAX_ACADEMY_BOT']) {
    const send = { id: 'synthetic', type: 'maxbot-send', z: 'tab', wires: [['existing_ack']] };
    const candidate = addMaxObservers([send], [{ id: send.id, hash: sha(JSON.stringify(send)), connector }]);
    assert.deepEqual(send.wires, [['existing_ack']]); assert.equal(candidate.filter(n => n.type === 'maxbot-send').length, 1);
    assert.equal(candidate[0].wires[0].filter(id => id === 'existing_ack').length, 1);
    const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
    const output = candidate.find(n => n.name === 'MAX diagnostic SDK output');
    assert.equal(new Function('msg', 'global', output.func)({}, { get: () => observer }), null);
    observer.transport({}, 'max_sdk_result', { code: 'chat_not_found', message: 'private', cause: { code: 'ECONNRESET' } });
    assert(events.some(e => e.configuredConnector === connector)); assert(events.some(e => e.code === 'chat_not_found'));
    assert(!JSON.stringify(events).includes('private'));
  }
});
test('collector restart/replay, legacy/skew, rotation/truncation/gap and unavailable never report false zero', () => {
  const event = { ...base(), deviceEventTime: '2000-01-01T00:00:00.000Z', deviceClockTrusted: false };
  const batch = { source: 'persisted_client_error', available: true, inode: '1', offset: 0, nextOffset: 100,
    fromUtc: '2026-10-22T10:00:00.000Z', toUtc: '2026-10-22T10:01:00.000Z', serverIngestTime: '2026-10-22T10:01:00.000Z', records: [{ payload: event }, { payload: {} }] };
  const collector = createCollector(); const first = collector.ingest(batch);
  assert.equal(first.records, 2); assert.equal(first.distinctDeliveredEventIds, 1); assert.equal(first.legacyRecords, 1); assert.equal(first.lateRecords, 0);
  const restarted = createCollector(collector.checkpoint());
  const replay = restarted.ingest({ ...batch, offset: 100, nextOffset: 200 }); assert.equal(replay.replayedRecords, 1);
  const rotation = restarted.ingest({ ...batch, inode: '2' }); assert.equal(rotation.availability, 'UNKNOWN'); assert(rotation.rotation);
  const truncation = restarted.ingest({ ...batch, inode: '2' }); assert(truncation.truncation);
  const missing = restarted.ingest({ ...batch, available: false }); assert.equal(missing.records, null); assert.equal(missing.rate, null);
});
test('preview cleanup labels scope_disposed and keeps serverTime + monotonic freshness', () => {
  const source = read('src/components/games/useSubscriptionPricePreview.ts');
  assert(source.includes('controller.abort("deadline")')); assert(source.includes('controller.abort("scope_disposed")'));
  assert(!source.includes('user_cancel')); assert(!source.includes('Date.now()')); assert(source.includes('serverTimeMs + elapsedMs'));
});

test('client ingest applies server allowlist to legacy/new events with distinct trusted ingest time', () => {
  const observer = createDiagnostics(), req = { path: '/lk/analytics/events', method: 'POST', body: { event: 'client_error', timestamp: '2000-01-01T00:00:00.000Z', user: { phone: 'private' }, payload: { errorStack: 'private' } } };
  observer.ingestClient({ req });
  assert.equal(req.body.payload.deviceEventTime, '2000-01-01T00:00:00.000Z');
  assert(req.body.payload.serverIngestTime); assert.equal(req.body.payload.legacyEvent, true);
  assert(!JSON.stringify(req.body).includes('private')); assert.equal(req.body.payload.serverTimeUtc, undefined);
  const id = req.body.payload.diagnosticEventId;
  observer.ingestClient({ req }); assert.equal(req.body.payload.diagnosticEventId, id);
});
test('media, app cache, onboarding JSON, no-res and nested transport fixtures never export source data', () => {
  const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
  observer.media({ payload: [{ logoUrl: 'https://example.invalid/private', logoThumbUrl: 'private', logoLegacyDataUrl: 'private' }], req: { protocol: 'https', headers: { host: 'example.invalid' } } }, 'media_asset');
  assert(events.some(e => e.branch === 'media_asset' && e.originEqual === true && e.logoUrlPresent === true));
  observer.transport({}, 'telegram_transport', { code: 'ETIMEDOUT', message: 'private', cause: { code: 'ECONNRESET', cause: { code: 'ENOTFOUND' } } });
  assert(events.some(e => e.transportCode3 === 'ENOTFOUND' && e.outcome === 'outcome_unknown'));
  const onboarding = 'scripts/nodered_onboarding_nodes/fn_onboarding_level_capture_viva_result.js';
  const input = { payload: 'private', statusCode: 204, headers: { 'content-type': 'text/plain' } };
  assert.deepEqual(run(onboarding, input, observer), run(onboarding, input, undefined, true));
  assert(events.some(e => e.contentTypeClass === 'text' && e.parseOk === false));
  observer.observe({}, 'participants_cache', { markerAgeMs: 12, inflightPresent: true, cacheUsable: false, code: 'in_progress', httpStatus: 429 });
  observer.observe({}, 'response_attempted'); assert(events.some(e => e.resPresent === false && e.reqPresent === false));
  assert(!JSON.stringify(events).includes('private'));
});
test('membership audit timestamps/admission flags stay separate from HTTP/client counts', async () => {
  const { buildMembershipDiagnosticLogFormat, parseMembershipDiagnostic } = await import('../diagnostics/membership-audit.mjs');
  assert(buildMembershipDiagnosticLogFormat().includes('$msec'));
  const event = parseMembershipDiagnostic({ diagnosticEventId: 'a'.repeat(32), requestId: 'a'.repeat(32), serverEpoch: '1792670473.123', admitted: '0', clientVerified: '0', routeValid: '1', framingInvalid: '0', clientBound: '0', httpStatus: '400', raw: 'private' }, sanitizeEvent);
  assert.equal(event.admitted, false); assert.equal(event.clientVerified, false); assert.equal(event.httpStatus, 400); assert.equal(event.code, 'UNKNOWN');
  assert(event.serverTimeUtc); assert(!JSON.stringify(event).includes('private'));
  assert.equal(parseMembershipDiagnostic({ serverEpoch: 'private' }, sanitizeEvent), null);
});
test('collector source gate preserves HTTP response and existing write cardinality; safe post-parse storage only', async () => {
  const { addClientCollectorGate } = await import('../diagnostics/client-collector.mjs');
  const route = { id: 'route', type: 'http in', z: 'tab', url: '/lk/analytics/events', wires: [['response', 'storage', 'debug']] };
  const flow = [route, { id: 'response', type: 'http response' }, { id: 'storage', type: 'mongodb4' }, { id: 'debug', type: 'debug' }];
  const candidate = addClientCollectorGate(flow, { routeId: 'route', routeHash: sha(JSON.stringify(route)), responseId: 'response', persistenceId: 'storage', debugIds: ['debug'] });
  const gate = candidate.at(-1), execute = new Function('msg', 'global', gate.func);
  const msg = { payload: { event: 'client_error', timestamp: '2000-01-01T00:00:00.000Z', user: 'private', payload: { raw: 'private' } } };
  const result = execute(msg, { get: () => createDiagnostics() });
  assert.equal(result[0], msg); assert.equal(result[0].payload.user, 'private');
  assert(!JSON.stringify(result[1].payload).includes('private'));
  assert.deepEqual(gate.wires, [['response'], ['storage', 'debug']]);
  assert.equal(candidate.filter(n => n.type === 'mongodb4').length, 1);
  assert.equal(execute(msg, { get: () => undefined })[0], msg);
  assert.equal(execute(msg, { get: () => undefined })[1], null);
  assert.deepEqual(route.wires, [['response', 'storage', 'debug']]);
});
test('MAX request context survives message clones through SDK/catch/ACK; lease retries share only the pseudonymous operation', () => {
  for (const connector of ['MAX_BOT', 'MAX_ACADEMY_BOT']) {
    const events = [], observer = createDiagnostics({ key: Buffer.alloc(32, 17), sink: e => events.push(e) });
    const operations = [], attempts = [];
    for (const attempt of [1, 2]) {
      const command = { id: 'private-command', connector, attempts: attempt, leasedUntil: '2030-01-01T00:00:00.000Z', targetExternalChatId: 'private-target', text: 'private-text' };
      const result = run('scripts/nodered_max_nodes/fn_max_outbox_dispatch_prepare.js', { payload: command }, observer).result;
      const send = result[0];
      assert.equal(send.payload, command.text); assert.equal(send.chatId, command.targetExternalChatId);
      const before = events.length;
      const sdk = structuredClone(send);
      observer.observe(sdk, 'max_sdk_result', { connector, sdkOutputPresent: true, executionObserved: true });
      observer.transport(structuredClone(send), 'max_sdk_result', { code: 'chat_not_found' }, false, { connector });
      run('scripts/nodered_max_nodes/fn_max_outbox_ack_prepare.js', send, observer);
      const chain = events.slice(before);
      assert(chain.length >= 3); assert(chain.every(e => e.connector === connector));
      assert.equal(new Set(chain.map(e => e.requestId)).size, 1);
      assert.equal(new Set(chain.map(e => e.attemptReference)).size, 1);
      operations.push(chain[0].outboxRef); attempts.push(chain[0].attemptReference);
    }
    assert.equal(operations[0], operations[1]); assert.notEqual(attempts[0], attempts[1]);
    assert(!JSON.stringify(events).includes('private'));
  }
});
test('collector rejects bad limits and treats lost checkpoint/nonzero offset as UNKNOWN', () => {
  for (const capacity of [-1, 0, NaN, 1.5, 100001]) assert.throws(() => createCollector({}, { capacity }), /LIMIT/);
  for (const ttlMs of [0, -1, NaN, 30 * 86400000 + 1]) assert.throws(() => createCollector({}, { ttlMs }), /LIMIT/);
  const input = { source: 'node_red_events', available: true, inode: '7', offset: 50, nextOffset: 100, fromUtc: '2026-10-22T10:00:00.000Z', toUtc: '2026-10-22T10:01:00.000Z', serverIngestTime: '2026-10-22T10:01:00.000Z', records: [] };
  for (const state of [{}, { cursors: { node_red_events: { inode: 'private', nextOffset: 'invalid' } } }]) {
    const result = createCollector(state).ingest(input); assert.equal(result.availability, 'UNKNOWN'); assert.equal(result.rate, null); assert(result.gap);
  }
});
test('burst output is bounded while exact suppression totals are retained', () => {
  const emitted = [], observer = createDiagnostics({ detailLimit: 2, sink: e => emitted.push(e) });
  const owner = {};
  for (let i = 0; i < 10000; i++) observer.observe(owner, 'patch', { httpStatus: 409, code: 'GAME_PATCH_VERSION_CONFLICT' });
  assert.equal(emitted.length, 2); observer.flushSuppressed();
  assert.equal(emitted.length, 3); assert.equal(emitted[2].suppressedCount, 9998); assert.equal(emitted[2].aggregate, true);
  assert.equal(emitted[2].requestId, undefined); assert.equal(emitted[2].httpStatus, undefined);
  assert.equal(observer.snapshot().observed, 10000); assert.equal(observer.snapshot().suppressed, 9998);
});
test('Telegram scoped exception observer changes no sender wiring and emits no payload or warning text', async () => {
  const { addTelegramObservers } = await import('../diagnostics/telegram-observers.mjs');
  const sender = { id: 'synthetic', type: 'telegram sender', z: 'tab', wires: [['existing']] };
  const candidate = addTelegramObservers([sender], [{ id: sender.id, hash: sha(JSON.stringify(sender)) }]);
  assert.deepEqual(candidate[0], sender); assert.equal(candidate.filter(n => n.type === 'telegram sender').length, 1);
  const events = [], observer = createDiagnostics({ sink: e => events.push(e) });
  new Function('msg', 'global', candidate.at(-1).func)({ payload: 'private', error: { code: 'ETIMEDOUT', message: 'private', cause: { code: 'ECONNRESET' } } }, { get: () => observer });
  assert.equal(events[0].transportCode2, 'ECONNRESET'); assert.equal(events[0].diagnosticWarning, false);
  assert(!JSON.stringify(events).includes('private'));
});
test('published schema matches the executable allowlist; all changed function bodies compile without a flow rebuild', async () => {
  const { schemaV1 } = await import('../diagnostics/schema.mjs');
  assert.deepEqual(JSON.parse(read('docs/diagnostics/schema.v1.json')), schemaV1());
  for (const path of Object.keys(hooks)) new Function('msg', 'global', 'env', 'node', 'flow', 'context', read(path).replace('__LIVE_SOURCE__', 'return [null, null, null, null];'));
});
test('missing MAX target provenance never produces a shared empty-identifier HMAC', () => {
 const events = [], observer = createDiagnostics({ key: Buffer.alloc(32, 17), sink: e => events.push(e) });
 assert.equal(observer.ref('binding', ''), undefined); assert.equal(observer.ref('binding', '   '), undefined);
 run('scripts/nodered_max_nodes/fn_max_client_lookup_prepare.js', { maxUpdate: { sender: {}, recipient: {} } }, observer);
 assert(events.every(e => e.bindingRef === undefined)); assert(events.every(e => e.refUnavailable === false));
 assert(events.some(e => e.targetPresent === false));
});
test('operation/attempt units without actual references never become zero/success or request totals', () => {
 const batch = { available: true, inode: '7', offset: 0, nextOffset: 100, fromUtc: '2026-10-22T10:00:00.000Z', toUtc: '2026-10-22T10:01:00.000Z', serverIngestTime: '2026-10-22T10:01:00.000Z', records: [base()] };
 const collector = createCollector();
 const unknown = collector.ingest({ ...batch, source: 'logical_operations' });
 assert.equal(unknown.distinctObservedOperations, null); assert.equal(unknown.rate, null);
 const known = collector.ingest({ ...batch, source: 'attempts', records: [{ ...base(), logicalOperation: randomUUID(), attempt: 1 }] });
 assert.equal(known.distinctObservedAttemptContexts, 1); assert.equal(known.rate, 1 / 60);
});
