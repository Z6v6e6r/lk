import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildFunction98BrowserGuard, buildFunction98EditorReadback } from '../nodered_reviewed_flow_deploy/function98_browser_guard.mjs';
import { function98GraphHash, function98OrderedGraphHash, createFunction98BodyPreserver } from '../nodered_reviewed_flow_deploy/function98_body_preserver.mjs';
import { patchFunction98Flow, sha256 } from '../lib/function98_safe_diagnostic.mjs';

async function fixture(storage = new Map(), clock = performance, serialize = structuredClone, arm = true) {
  const source = 'const endpoint=msg.inputUrl;\nnode.warn(endpoint);\nmsg.url = endpoint;\nreturn msg;';
  const flow = [{ id: 'tab', type: 'tab', disabled: false },
    { id: 'target', type: 'function', name: 'function 98', z: 'tab', func: source, wires: [['http', 'debug']] },
    { id: 'http', type: 'http request', method: 'GET', url: '', requestTimeout: '120000', customRuntimeOption: 'synthetic-preserve' },
    { id: 'debug', type: 'debug', active: false }];
  const editor = serialize(flow);
  const patched = patchFunction98Flow(flow, { expectedFunctionSha256: sha256(source) });
  const seal = { protocol: 'source-preserving-v2', planSha256: 'a'.repeat(64), attemptSha256: 'b'.repeat(64), sourceGraphSha256: await function98GraphHash(flow),
    sourceOrderedGraphSha256: await function98OrderedGraphHash(flow), candidateOrderedGraphSha256: await function98OrderedGraphHash(patched.candidate),
    editorOrderedGraphSha256: await function98OrderedGraphHash(editor),
    candidateGraphSha256: await function98GraphHash(patched.candidate), preRevisionSha256: sha256('synthetic-revision'),
    beforeFunctionSha256: patched.beforeFunctionSha256, afterFunctionSha256: patched.afterFunctionSha256,
    notAfter: new Date(Date.now() + 290000).toISOString() };
  const sent = [], headers = [];
  class XHR {
    open(...args) { this.openArgs = args; }
    setRequestHeader(...args) { headers.push(args); }
    send(body) { sent.push(body); }
    abort() { this.aborted = true; }
  }
  const view = { XMLHttpRequest: XHR, location: { origin: 'http://127.0.0.1:18801', href: 'http://127.0.0.1:18801/' },
    crypto: webcrypto, fetch: () => Promise.resolve('native-fetch'), RED: { nodes: { createCompleteNodeSet: () => structuredClone(editor) } },
    navigator: { locks: { request: async (_name, _options, callback) => callback({}) } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }; view.top = view;
  const install = vm.runInNewContext(`(${buildFunction98BrowserGuard()})`, { window: view, performance: clock, Date, URL, TextEncoder, structuredClone });
  const guard = arm ? await install(seal, { rev: 'synthetic-revision', flows: flow }) : null;
  const request = (body = { rev: 'synthetic-revision', flows: editor }, mode = 'nodes') => {
    const xhr = new XHR(); xhr.open('POST', '/flows', true);
    xhr.setRequestHeader('Node-RED-API-Version', 'v2'); xhr.setRequestHeader('Node-RED-Deployment-Type', mode);
    xhr.send(JSON.stringify(body)); return xhr;
  };
  const settled = async () => {
    for (let i = 0; i < 100 && guard.status().status === 'VALIDATING'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    return guard.status();
  };
  return { flow, editor, seal, patched, sent, headers, XHR, view, guard, request, settled, install };
}

test('guard forwards original XHR once with exact candidate, preserves native auth without inspecting it', async () => {
  const f = await fixture(), xhr = new f.XHR(); xhr.open('POST', '/flows', true, undefined, undefined);
  const secret = { toString() { throw new Error('authentication value must not be inspected'); } };
  xhr.setRequestHeader('Authorization', secret);
  xhr.setRequestHeader('Node-RED-API-Version', 'v2'); xhr.setRequestHeader('Node-RED-Deployment-Type', 'nodes');
  xhr.send(JSON.stringify({ rev: 'synthetic-revision', flows: f.flow }));
  const audit = await f.settled(); assert.equal(audit.forwarded, 1);
  assert.strictEqual(f.headers[0][1], secret);
  assert.deepEqual(JSON.parse(f.sent[0]).flows, f.patched.candidate);
  assert.equal(JSON.stringify(audit).includes('Authorization'), false);
  assert.throws(() => f.request(), /CONSUMED/); assert.equal(f.sent.length, 1);
});
for (const variant of ['stale', 'full', 'extra-delta', 'credentials', 'second-warning']) test(`guard blocks ${variant} with no native send`, async () => {
  const f = await fixture(), body = { rev: 'synthetic-revision', flows: structuredClone(f.flow) };
  if (variant === 'stale') body.rev = 'old-revision';
  if (variant === 'extra-delta') body.flows[2].method = 'POST';
  if (variant === 'credentials') body.credentials = { synthetic: true };
  if (variant === 'second-warning') body.flows[1].func += '\nnode.warn(msg.url);';
  const xhr = f.request(body, variant === 'full' ? 'full' : 'nodes');
  await f.settled(); assert.equal(f.sent.length, 0); assert.equal(xhr.aborted, true);
});
test('abort/open cancellation during async validation cannot forward later; fetch cannot bypass guard', async () => {
  const f = await fixture(), xhr = f.request(); xhr.abort();
  await f.settled(); assert.equal(f.sent.length, 0);
  await assert.rejects(f.view.fetch('/flows', { method: 'POST' }), /FORBIDDEN/);
  assert.equal(await f.view.fetch('/settings'), 'native-fetch');
});
test('pure preserver refuses an unsealed already-patched editor graph', async () => {
  const f = await fixture(), run = await createFunction98BodyPreserver(f.seal, { rev: 'synthetic-revision', flows: f.flow });
  await assert.rejects(run({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-revision', flows: f.patched.candidate } }), /UNEXPECTED_EDITOR_DELTA/);
});
test('guard blocks every sibling admin write through XHR and fetch', async () => {
  for (const url of ['/flow/synthetic', '/flows/state', '/inject/synthetic']) {
    const f = await fixture(), xhr = new f.XHR(); xhr.open('POST', url, true);
    assert.throws(() => xhr.send('{}'), /UNRELATED_WRITE/); assert.equal(xhr.aborted, true); assert.equal(f.sent.length, 0);
    await assert.rejects(f.view.fetch(url, { method: 'DELETE' }), /FORBIDDEN/);
  }
});
test('readback uses native editor AJAX and exports only fresh hashes', async () => {
  const f = await fixture(); let options;
  f.view.jQuery = { ajax: o => { options = o; o.success({ rev: 'synthetic-revision', flows: f.flow }); } };
  const readback = vm.runInNewContext(`(${buildFunction98EditorReadback()})`, { window: f.view, Date, TextEncoder, structuredClone, performance });
  const result = await readback(); assert.equal(options.method, 'GET'); assert.equal(options.url, 'flows');
  assert.equal(result.revisionSha256, f.seal.preRevisionSha256); assert.equal(result.graphSha256, f.seal.sourceGraphSha256);
  assert.equal(options.timeout, 120000);
  assert.deepEqual(Object.keys(result).sort(), ['editorOrderedGraphSha256', 'graphSha256', 'observedAt', 'orderedGraphSha256', 'origin', 'requestedAt', 'revisionSha256']);
  f.view.jQuery.ajax = o => o.error(); await assert.rejects(readback(), /READBACK_REFUSED/);
});
test('a consumed attempt cannot be reinstalled after a dedicated-tab reload', async () => {
  const storage = new Map(); await fixture(storage);
  await assert.rejects(fixture(storage), /ATTEMPT_CONSUMED/);
});
test('expired monotonic deadline aborts without forwarding even if wall clock remains valid', async () => {
  let elapsed = 0; const f = await fixture(new Map(), { now: () => elapsed }); elapsed = 300001;
  assert.throws(() => f.request(), /EXPIRED/); assert.equal(f.sent.length, 0);
});

const lossyEditor = source => {
  const editor = structuredClone(source);
  delete editor[2].requestTimeout; delete editor[2].customRuntimeOption;
  for (const node of editor) { node.x = 0; node.y = 0; }
  return editor;
};
test('pinned native snapshot preserves omitted unknown fields and discards editor-added coordinates', async () => {
  const f = await fixture(new Map(), performance, lossyEditor);
  assert.notEqual(f.seal.editorOrderedGraphSha256, f.seal.sourceOrderedGraphSha256);
  f.request(); const audit = await f.settled(); assert.equal(audit.forwarded, 1);
  assert.deepEqual(JSON.parse(f.sent[0]).flows, f.patched.candidate);
  assert.equal(audit.editorOrderedGraphSha256, f.seal.editorOrderedGraphSha256);
  assert.equal(audit.candidateOrderedGraphSha256, f.seal.candidateOrderedGraphSha256);
});
test('an editor change or node reorder after sealing sends nothing', async () => {
  for (const change of [g => { g[2].method = 'POST'; }, g => g.reverse()]) {
    const f = await fixture(new Map(), performance, lossyEditor), editor = structuredClone(f.editor);
    change(editor); const xhr = f.request({ rev: 'synthetic-revision', flows: editor });
    await f.settled(); assert.equal(xhr.aborted, true); assert.equal(f.sent.length, 0);
  }
});
test('snapshot revision, unknown field, order, and protocol drift are refused before arming', async () => {
  for (const change of [s => { s.rev = 'other'; }, s => { delete s.flows[2].customRuntimeOption; }, s => s.flows.reverse()]) {
    const f = await fixture(new Map(), performance, structuredClone, false), snapshot = { rev: 'synthetic-revision', flows: structuredClone(f.flow) };
    change(snapshot); await assert.rejects(f.install(f.seal, snapshot), /SNAPSHOT/); assert.equal(f.sent.length, 0);
  }
  const f = await fixture(new Map(), performance, structuredClone, false);
  await assert.rejects(f.install({ ...f.seal, protocol: undefined }, { rev: 'synthetic-revision', flows: f.flow }), /SEAL/);
});
test('snapshot and seal are cloned before caller mutation', async () => {
  const f = await fixture(), snapshot = { rev: 'synthetic-revision', flows: structuredClone(f.flow) }, seal = structuredClone(f.seal);
  const run = await createFunction98BodyPreserver(seal, snapshot);
  snapshot.flows.reverse(); snapshot.flows[0].customRuntimeOption = 'mutated'; seal.candidateGraphSha256 = '0'.repeat(64);
  const out = await run({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
    postBody: { rev: 'synthetic-revision', flows: f.flow } });
  assert.deepEqual(JSON.parse(out.postDataText).flows, f.patched.candidate);
});
test('reader keeps raw GET in a private snapshot and installs the exact source-preserving guard', async () => {
  const f = await fixture(new Map(), performance, lossyEditor, false), native = { rev: 'synthetic-revision', flows: structuredClone(f.flow) };
  f.view.jQuery = { ajax: o => o.success(native) };
  const reader = vm.runInNewContext(`(${buildFunction98EditorReadback()})`, { window: f.view, Date, TextEncoder, structuredClone, performance, URL });
  const evidence = await reader(); assert.equal(evidence.editorOrderedGraphSha256, f.seal.editorOrderedGraphSha256);
  native.flows[2].requestTimeout = 'mutated-after-capture';
  const guard = await reader.install(f.seal); f.request();
  for (let i = 0; i < 100 && guard.status().status === 'VALIDATING'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(guard.status().forwarded, 1); assert.deepEqual(JSON.parse(f.sent[0]).flows, f.patched.candidate);
  await assert.rejects(reader.install(f.seal), /CAPTURE_NOT_FRESH/);
  assert.equal(JSON.stringify(evidence).includes('synthetic-preserve'), false);
});
test('slow successful GET stamps observation after hashing; stale or in-flight captures cannot arm', async () => {
  let now = Date.now(), complete; const clock = { now: () => now };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const f = await fixture(new Map(), clock, structuredClone, false);
  f.view.jQuery = { ajax: o => { complete = o.success; } };
  const reader = vm.runInNewContext(`(${buildFunction98EditorReadback()})`, { window: f.view, Date: ClockDate, TextEncoder, structuredClone, performance: clock, URL });
  const waiting = reader(); await assert.rejects(reader.install(f.seal), /CAPTURE_NOT_FRESH/);
  const requested = now; now += 65000; complete({ rev: 'synthetic-revision', flows: f.flow });
  const result = await waiting; assert.equal(Date.parse(result.requestedAt), requested); assert.equal(Date.parse(result.observedAt), now);
  now += 30001; await assert.rejects(reader.install(f.seal), /CAPTURE_NOT_FRESH/); assert.equal(f.sent.length, 0);
});
