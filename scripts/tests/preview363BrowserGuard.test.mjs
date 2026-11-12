import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildPreview363BrowserGuard, buildPreview363EditorReadback } from '../nodered_reviewed_flow_deploy/preview363_browser_guard.mjs';
import { preview363GraphHash, preview363OrderedGraphHash, createPreview363BodyPreserver } from '../nodered_reviewed_flow_deploy/preview363_body_preserver.mjs';
import { patchPreview363Flow, sha256, buildPreview363Artifact } from '../lib/preview363_activation.mjs';

async function fixture(storage = new Map(), clock = performance, reverse = false, installImmediately = true) {
  const source = "const ctx=msg.ctx;const tariffDetails=()=>({});const reason='empty_tariff_list';const lkDiagnostic=()=>{};\n    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');\nreturn msg;";
  const bundle = 'module.exports.createScopedEmptyTariffObserver=()=>({observe(){},dispose(){}});';
  const commit = 'c'.repeat(40), artifact = buildPreview363Artifact(commit, bundle);
  const flow = [{ id: 'tab', type: 'tab', disabled: false },
    { id: 'lk_subscription_price_preview_20260908_router', type: 'function', name: 'Subscription price preview router', z: 'tab', func: source, initialize: '', finalize: '', libs: [{var:'preview350Crypto',module:'crypto'},{var:'preview350Performance',module:'perf_hooks'}], wires: [['http', 'debug']] },
    { id: 'http', type: 'http request', method: 'GET', url: '' }, { id: 'debug', type: 'debug', active: false }];
  const patched = patchPreview363Flow(flow, { sourceCommit: commit, bundle, expectedNodeCount: 4, expectedFunctionSha256: sha256(source), expectedInitializeSha256: sha256(''), expectedFinalizeSha256: sha256('') });
  const seal = { protocol: 'source-preserving-v2', planSha256: 'a'.repeat(64), attemptSha256: 'b'.repeat(64), sourceGraphSha256: await preview363GraphHash(flow),
    candidateGraphSha256: await preview363GraphHash(patched.candidate),
    sourceOrderedGraphSha256: await preview363OrderedGraphHash(flow), candidateOrderedGraphSha256: await preview363OrderedGraphHash(patched.candidate),
    editorOrderedGraphSha256: await preview363OrderedGraphHash(reverse ? patched.candidate : flow), preRevisionSha256: sha256('synthetic-revision'),
    beforeFunctionSha256: patched.beforeFunctionSha256, afterFunctionSha256: patched.afterFunctionSha256,
    notAfter: new Date(Date.now() + 290000).toISOString() };
  if (reverse) {
    [seal.sourceGraphSha256, seal.candidateGraphSha256] = [seal.candidateGraphSha256, seal.sourceGraphSha256];
    [seal.sourceOrderedGraphSha256, seal.candidateOrderedGraphSha256] = [seal.candidateOrderedGraphSha256, seal.sourceOrderedGraphSha256];
    [seal.beforeFunctionSha256, seal.afterFunctionSha256] = [seal.afterFunctionSha256, seal.beforeFunctionSha256];
    seal.reverse = true; seal.attemptSha256 = 'd'.repeat(64);
  }
  const sent = [], headers = [];
  class XHR {
    open(...args) { this.openArgs = args; }
    setRequestHeader(...args) { headers.push(args); }
    send(body) { sent.push(body); }
    abort() { this.aborted = true; }
  }
  const view = { XMLHttpRequest: XHR, location: { origin: 'http://127.0.0.1:18801', href: 'http://127.0.0.1:18801/' },
    crypto: webcrypto, fetch: () => Promise.resolve('native-fetch'),
    navigator: { locks: { request: async (_name, _options, callback) => callback({}) } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }; view.top = view;
  const install = vm.runInNewContext(`(${buildPreview363BrowserGuard(artifact)})`, { window: view, performance: clock, Date, URL, TextEncoder, structuredClone });
  const snapshot = { rev: 'synthetic-revision', flows: reverse ? patched.candidate : flow };
  const guard = installImmediately ? await install(seal, snapshot) : null;
  const request = (body = { rev: 'synthetic-revision', flows: reverse ? patched.candidate : flow }, mode = 'nodes') => {
    const xhr = new XHR(); xhr.open('POST', '/flows', true);
    xhr.setRequestHeader('Node-RED-API-Version', 'v2'); xhr.setRequestHeader('Node-RED-Deployment-Type', mode);
    xhr.send(JSON.stringify(body)); return xhr;
  };
  const settled = async () => {
    for (let i = 0; i < 100 && guard.status().status === 'VALIDATING'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    return guard.status();
  };
  return { flow, seal, patched, artifact, sent, headers, XHR, view, guard, request, settled, install, snapshot };
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
test('snapshot custody preserves fields dropped by the editor and original node order', async () => {
  const f = await fixture(), source = structuredClone(f.flow);
  source[2].requestTimeout = '25000'; source[0].nativeOnly = { synthetic: true };
  const candidate = structuredClone(f.patched.candidate);
  candidate[2].requestTimeout = '25000'; candidate[0].nativeOnly = { synthetic: true };
  const editor = structuredClone(f.flow).reverse(); editor[0].x = 0; editor[0].y = 0;
  const seal = { ...f.seal, sourceGraphSha256: await preview363GraphHash(source), candidateGraphSha256: await preview363GraphHash(candidate),
    sourceOrderedGraphSha256: await preview363OrderedGraphHash(source), candidateOrderedGraphSha256: await preview363OrderedGraphHash(candidate),
    editorOrderedGraphSha256: await preview363OrderedGraphHash(editor) };
  const snapshot = { rev: 'synthetic-revision', flows: structuredClone(source) };
  const run = await createPreview363BodyPreserver(seal, f.artifact, snapshot);
  snapshot.flows[0].nativeOnly.synthetic = false; // Caller mutation cannot change the captured copy.
  const request = { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' };
  const result = await run({ request, postBody: { rev: 'synthetic-revision', flows: editor } });
  assert.deepEqual(JSON.parse(result.postDataText).flows, candidate);
  const negative = await createPreview363BodyPreserver(seal, f.artifact, { rev: 'synthetic-revision', flows: source });
  await assert.rejects(negative({ request, postBody: { rev: 'synthetic-revision', flows: [...editor].reverse() } }), /EDITOR_DELTA/);
  await assert.rejects(createPreview363BodyPreserver(seal, f.artifact, { rev: 'other', flows: source }), /SNAPSHOT/);
});
test('guard blocks every sibling admin write through XHR and fetch', async () => {
  for (const url of ['/flow/synthetic', '/flows/state', '/inject/synthetic']) {
    const f = await fixture(), xhr = new f.XHR(); xhr.open('POST', url, true);
    assert.throws(() => xhr.send('{}'), /UNRELATED_WRITE/); assert.equal(xhr.aborted, true); assert.equal(f.sent.length, 0);
    await assert.rejects(f.view.fetch(url, { method: 'DELETE' }), /FORBIDDEN/);
  }
});
test('readback retains native snapshot privately and exports only fresh hashes with independent editor serialization', async () => {
  const f = await fixture(new Map(), performance, false, false); let options;
  f.view.jQuery = { ajax: o => { options = o; o.success({ rev: 'synthetic-revision', flows: f.flow }); } };
  const editor = structuredClone(f.flow); editor[2].x = 0;
  f.view.RED = { nodes: { dirty: () => false, version: () => 'synthetic-revision', createCompleteNodeSet: () => editor } };
  const readback = vm.runInNewContext(buildPreview363EditorReadback(f.artifact), { window: f.view, Date, TextEncoder, performance, structuredClone, URL });
  const result = await readback(); assert.equal(options.method, 'GET'); assert.equal(options.url, 'flows');
  assert.equal(result.revisionSha256, f.seal.preRevisionSha256); assert.equal(result.graphSha256, f.seal.sourceGraphSha256);
  assert.equal(result.editorOrderedGraphSha256, await preview363OrderedGraphHash(editor));
  assert.deepEqual(Object.keys(result).sort(), ['editorOrderedGraphSha256','graphSha256','observedAt','orderedGraphSha256','origin','requestedAt','revisionSha256']);
  assert.equal(JSON.stringify(result).includes('flows'), false);
  f.view.RED.nodes.dirty = () => true; await assert.rejects(readback(), /EDITOR_NOT_CLEAN/);
  f.view.RED.nodes.dirty = () => false;
  f.view.RED.nodes.version = () => 'old-revision'; await assert.rejects(readback(), /EDITOR_REVISION_DRIFT/);
  f.view.RED.nodes.version = () => 'synthetic-revision';
  f.view.jQuery.ajax = o => o.error(); await assert.rejects(readback(), /READBACK_REFUSED/);
  f.view.jQuery.ajax = o => o.success({ rev: 'synthetic-revision', flows: f.flow });
  const fresh = await readback();
  const guard = await readback.install({ ...f.seal, editorOrderedGraphSha256: fresh.editorOrderedGraphSha256 });
  await assert.rejects(readback.install(f.seal), /CAPTURE_NOT_FRESH/);
  f.request({ rev: 'synthetic-revision', flows: editor });
  for (let i = 0; i < 100 && guard.status().status === 'VALIDATING'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(guard.status().forwarded, 1);
  assert.deepEqual(JSON.parse(f.sent[0]).flows, f.patched.candidate);
});
test('a consumed attempt cannot be reinstalled after a dedicated-tab reload', async () => {
  const storage = new Map(); await fixture(storage);
  await assert.rejects(fixture(storage), /ATTEMPT_CONSUMED/);
});
test('expired monotonic deadline aborts without forwarding even if wall clock remains valid', async () => {
  let elapsed = 0; const f = await fixture(new Map(), { now: () => elapsed }); elapsed = 300001;
  assert.throws(() => f.request(), /EXPIRED/); assert.equal(f.sent.length, 0);
});
test('inverse native request restores source in fresh realm; mis-arming old realm does not burn its nonce', async () => {
  const storage = new Map(), forward = await fixture(storage);
  const inverseAttempt = 'd'.repeat(64);
  await assert.rejects(forward.install({ ...forward.seal, attemptSha256: inverseAttempt }, forward.snapshot), /INSTALLED/);
  assert.equal(storage.has('padlhub.preview363.attempt.' + inverseAttempt), false);
  const inverse = await fixture(storage, performance, true);
  inverse.request(); assert.equal((await inverse.settled()).forwarded, 1);
  assert.deepEqual(JSON.parse(inverse.sent[0]).flows, inverse.flow);
});
