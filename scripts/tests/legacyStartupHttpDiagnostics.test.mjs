import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { composeStartupHttpDiagnostics, renderStartupHttpObserver, startupHttpNodeHash } from '../prepare_legacy_startup_http_diagnostics.mjs';
const sha = x => createHash('sha256').update(x).digest('hex');
const approved = JSON.parse(fs.readFileSync(new URL('../legacy_startup_http/bindings.json', import.meta.url), 'utf8'));
function fixture() {
  const byRole = Object.fromEntries(Object.entries(approved).map(([r, x]) => [r, { id: `fixture-${r}`, type: x.type }]));
  for (const [r, n] of Object.entries(byRole)) if (r !== 'tab') Object.assign(n, { z: byRole.tab.id, wires: [[]] });
  byRole.tab.disabled = false;
  Object.assign(byRole.http, { ret: 'obj', method: 'use', url: '', senderr: false, wires: [[byRole.debug.id]] });
  byRole.builder.func = 'return msg;'; byRole.builder.wires = [[byRole.http.id]];
  byRole.startup.wires = [[byRole.builder.id]]; byRole.manual.wires = [[byRole.builder.id]];
  const bindings = Object.fromEntries(Object.entries(byRole).map(([r, n]) => [r, { identityHash: sha(n.id), nodeSha256: startupHttpNodeHash(n), type: n.type }]));
  return { flow: [...Object.values(byRole), { id: 'fixture-other-http', type: 'http request', ret: 'obj', wires: [[]] }], bindings };
}
function compose(flow, bindings, sourceHash) {
  const bytes = Buffer.from(JSON.stringify(flow));
  return composeStartupHttpDiagnostics(bytes, 'legacy-http-observation-test', { bindings, expectedSourceSha256: sourceHash ?? sha(bytes) });
}
function observer(stage = 'response', options = {}) {
  const events = []; const stored = new Map(); let clock = 100000;
  const context = options.context ?? { get: k => stored.get(k), set: (k, v) => stored.set(k, v) };
  const sandbox = vm.createContext({ Buffer, Date: { now: () => clock }, context, node: { warn: options.warn ?? (s => events.push(JSON.parse(s))) } });
  const script = new vm.Script(`(function(){${renderStartupHttpObserver(stage)}})()`);
  return { events, advance: t => { clock += t; }, run: msg => { sandbox.msg = msg; return script.runInContext(sandbox, { timeout: 1000 }); } };
}
test('only rewires the pinned HTTP output and appends three scoped observation nodes', () => {
  const { flow, bindings } = fixture(); const before = structuredClone(flow); const result = compose(flow, bindings);
  assert.deepEqual(flow, before); assert.equal(result.candidate.length, flow.length + 3);
  const next = result.candidate.slice(0, flow.length);
  const previousHttp = before.find(n => n.type === 'http request'); const afterHttp = next.find(n => n.id === previousHttp.id);
  assert.deepEqual({ ...afterHttp, wires: previousHttp.wires }, previousHttp);
  for (const n of before.filter(n => n.id !== previousHttp.id)) assert.deepEqual(next.find(x => x.id === n.id), n);
  const catchNode = result.candidate.find(n => n.type === 'catch'); assert.deepEqual(catchNode.scope, [previousHttp.id]);
  const response = result.candidate.find(n => n.id === afterHttp.wires[0][0]); assert.deepEqual(response.wires, previousHttp.wires);
  assert.equal(result.contract.contractKind, 'exact-graph'); assert.equal(result.receipt.deploymentAuthorized, false);
  assert.equal(JSON.stringify(result.receipt).includes('fixture-'), false);
});
test('holds source/target drift, ambiguous IDs, collisions, missing/duplicate bindings and existing catches', () => {
  const { flow, bindings } = fixture();
  assert.throws(() => compose(flow, bindings, '0'.repeat(64)), /SOURCE_DRIFT/);
  const changed = structuredClone(flow); changed[0].ret = 'txt'; assert.throws(() => compose(changed, bindings), /NODE_DRIFT/);
  assert.throws(() => compose([...flow, flow[0]], bindings), /INVALID_FLOW/);
  assert.throws(() => compose(flow.slice(1), bindings), /NODE_DRIFT/);
  assert.throws(() => compose([...flow, { id: 'fixture-catch', type: 'catch', z: 'fixture-tab' }], bindings), /EXISTING_CATCH/);
  assert.throws(() => compose([...flow, { id: 'lk_legacy_http_observation_v1_response', type: 'debug' }], bindings), /ID_COLLISION/);
  assert.throws(() => compose(flow, { ...bindings, extra: bindings.http }), /BINDING_SET/);
  assert.throws(() => compose(flow, { ...bindings, debug: bindings.http }), /BINDING_INVALID/);
});
const canary = 'SYNTHETIC_PRIVATE_CANARY';
for (const [name, payload, contentType, status, kind, outcome] of [
  ['object JSON', { access_token: canary }, 'application/json', 200, 'object', 'object_payload'],
  ['JSON array error', [{ error: canary }], 'application/json', 500, 'array', 'object_payload'],
  ['HTML error', `<html>${canary}</html>`, 'text/html', 502, 'string', 'string_payload_ambiguous'],
  ['malformed JSON', '{'+canary, 'application/json', 200, 'string', 'string_payload_ambiguous'],
  ['valid JSON string result', canary, 'application/json', 200, 'string', 'string_payload_ambiguous'],
  ['empty/204', '', '', 204, 'empty', 'empty_payload'],
  ['redirect body', canary, 'text/plain', 302, 'string', 'string_payload_ambiguous'],
  ['primitive JSON', 1, 'application/json', 200, 'number', 'primitive_payload'],
  ['buffer', Buffer.from(canary), 'application/octet-stream', 200, 'buffer', 'primitive_payload'],
]) test(`${name}: forwards the exact same msg without inferring business success or exposing private values`, () => {
  const o = observer(); const msg = { payload, statusCode: status, headers: { 'content-type': contentType, authorization: canary }, url: canary, _msgid: canary };
  assert.equal(o.run(msg), msg); assert.equal(msg.payload, payload);
  assert.equal(o.events.length, 1); assert.equal(o.events[0].payloadKind, kind); assert.equal(o.events[0].decodeOutcome, outcome);
  assert.equal(JSON.stringify(o.events).includes(canary), false);
  assert.equal('payload' in o.events[0] || 'headers' in o.events[0] || 'url' in o.events[0], false);
});
test('real HTTP error-code status and Catch message DTOs are safe and classified conservatively', () => {
  const response = observer(); const msg = { statusCode: 'ETIMEDOUT', payload: canary };
  assert.equal(response.run(msg), msg); assert.equal(response.events[0].transportClass, 'timeout');
  assert.equal(response.events[0].httpStatus, null); assert.equal(response.events[0].decodeOutcome, 'not_observed');
  const caught = observer('transport_error');
  assert.equal(caught.run({ error: { message: canary, source: { id: canary } }, payload: canary }), null);
  assert.equal(caught.events[0].transportClass, 'other'); assert.equal(JSON.stringify(caught.events).includes(canary), false);
});
for (const [code, expected] of [['ENOTFOUND', 'dns'], ['ECONNRESET', 'connection'], ['CERT_HAS_EXPIRED', 'tls'], [canary, 'other']]) test(`transport code allowlisting: ${expected}`, () => {
  const o = observer('transport_error'); assert.equal(o.run({ error: { code, message: canary }, payload: canary }), null);
  assert.equal(o.events[0].transportClass, expected); assert.equal(JSON.stringify(o.events).includes(canary), false);
});
test('limits details to 10 per minute and reports only a bounded suppression count', () => {
  const o = observer(); const msg = { payload: canary };
  for (let i = 0; i < 15; i++) assert.equal(o.run(msg), msg);
  assert.equal(o.events.length, 10); o.advance(60000); o.run(msg);
  assert.equal(o.events.length, 11); assert.equal(o.events.at(-1).suppressedPriorWindow, 5);
});
test('context, logger and hostile metadata errors never change response delivery', () => {
  const msg = { payload: canary };
  assert.equal(observer('response', { context: { get: () => { throw Error(canary); } } }).run(msg), msg);
  assert.equal(observer('response', { warn: () => { throw Error(canary); } }).run(msg), msg);
  const hostile = { get payload() { throw Error(canary); } }; assert.equal(observer().run(hostile), hostile);
  assert.equal(observer('transport_error', { warn: () => { throw Error(canary); } }).run(msg), null);
});
test('does not serialize or coerce provider objects to estimate length', () => {
  const payload = { toJSON() { throw Error(canary); }, toString() { throw Error(canary); } };
  const o = observer(); assert.equal(o.run({ payload }).payload, payload);
  assert.equal(o.events[0].observedPayloadLengthBucket, 'unknown');
});
test('untrusted numeric-looking status and unknown error codes never escape allowlists', () => {
  const o = observer(); o.run({ statusCode: '535 '+canary, headers: { 'content-type': canary }, error: { code: canary } });
  assert.equal(o.events[0].httpStatus, null); assert.equal(o.events[0].contentTypeClass, 'other');
  assert.equal(o.events[0].transportClass, 'other'); assert.equal(JSON.stringify(o.events).includes(canary), false);
});
for (const [header, expected] of [
  ['text/html; name=error.json', 'html'], ['application/octet-stream; name=error.json', 'other'],
  ['text/plain; profile=json', 'text'], ['application/problem+json; charset=utf-8', 'json'],
  [' Application/JSON ; charset=utf-8', 'json'], ['application/not-json', 'other'],
]) test(`Content-Type parameters do not masquerade as the media type: ${expected}`, () => {
  const o = observer(); o.run({ headers: { 'content-type': header } });
  assert.equal(o.events[0].contentTypeClass, expected);
});
