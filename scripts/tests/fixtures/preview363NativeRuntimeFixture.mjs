import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { patchPreview363Flow, sha256, buildPreview363Artifact } from '../../lib/preview363_activation.mjs';
import { createPreview363BodyPreserver, preview363GraphHash, preview363OrderedGraphHash } from '../../nodered_reviewed_flow_deploy/preview363_body_preserver.mjs';
const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
export async function runPreview363Rehearsal() {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview363-runtime-'));
    const logs = []; let providerCalls = 0, dbCalls = 0, injectInputs = 0, outputs = 0;
    const provider = http.createServer((_req, res) => { providerCalls++; res.end('unused'); });
    const app = express(), server = http.createServer(app);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/', httpNodeRoot: '/api', disableEditor: true,
      functionExternalModules: true, externalModules: { modules: { allowInstall: false } },
      logging: { console: { level: 'off' }, fixture: { level: 'warn', handler: () => entry => logs.push({ ...entry }) } } });
    RED.nodes.registerType('preview363-fixture', 'fixture-db', function(config) { RED.nodes.createNode(this, config); this.on('input', () => dbCalls++); });
    RED.nodes.registerType('preview363-fixture', 'fixture-sink', function(config) { RED.nodes.createNode(this, config); this.on('input', msg => {
      assert.equal(msg.statusCode, 503); assert.equal(msg._subscriptionPricePreview.error, 'LK1_EVENT_TARIFF_AMBIGUOUS'); outputs++;
    }); });
    app.use(RED.httpAdmin); app.use('/api', RED.httpNode);
    const deployed = new Set();
    RED.events.on('runtime-event', e => { if (e.id === 'runtime-deploy') deployed.add(e.payload.revision); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const admin = async (method, body) => {
      const response = await new Promise((resolve, reject) => {
        const request = http.request(base + '/flows', { method, agent: false,
          headers: { 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes', Connection: 'close' } }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        request.setTimeout(10000, () => request.destroy(Error('ISOLATED_ADMIN_TIMEOUT')));
        request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
      });
      assert.equal(response.status, 200); const result = JSON.parse(response.text);
      if (method === 'POST') {
        for (let i = 0; i < 500 && !deployed.has(result.rev); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert(deployed.has(result.rev), 'ACK is followed by actual node start');
      }
      return result;
    };
    try {
      await RED.start();
      const source = `const ctx=msg._subscriptionPricePreview; const reason='empty_tariff_list'; const rows=msg.payload;
const tariffDetails=()=>({reason}); const lkDiagnostic=fields=>globalThis.__lkPreview350Observer.observe(msg,'preview_router',fields);
    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');
ctx.error='LK1_EVENT_TARIFF_AMBIGUOUS';msg.statusCode=503;return msg;`;
      const initialize = `globalThis.__lkPreview350Observer=Object.freeze({owner:'preview-cross-day-v1',observe(){node.warn('SYNTHETIC_CROSS_DAY');},snapshot(){return{};},dispose(){node.warn('SYNTHETIC_CROSS_DAY_DISPOSE');}});`;
      const finalize = `const own=globalThis.__lkPreview350Observer;if(own?.owner==='preview-cross-day-v1'){delete globalThis.__lkPreview350Observer;own.dispose();}`;
      const libs = [{ var: 'preview350Crypto', module: 'crypto' }, { var: 'preview350Performance', module: 'perf_hooks' }];
      const flow = [{ id: 'tab', type: 'tab', label: 'synthetic isolated preview fixture' },
        { id: 'inject', type: 'inject', z: 'tab', once: false, crontab: '0 0 1 1 *', wires: [[]] },
        { id: 'http', type: 'http request', z: 'tab', method: 'GET', ret: 'txt', requestTimeout: '25000', url: `http://127.0.0.1:${provider.address().port}`, wires: [[]] },
        { id: 'db', nativeOnly: true, type: 'fixture-db', z: 'tab', wires: [] },
        { id: 'sink', type: 'fixture-sink', z: 'tab', wires: [] },
        { id: 'lk_subscription_price_preview_20260908_router', type: 'function', name: 'Subscription price preview router',
          z: 'tab', func: source, initialize, finalize, libs, outputs: 1, wires: [['sink']] }];
      for (const n of flow) if (n.type !== 'tab') Object.assign(n, { x: 0, y: 0 });
      await admin('POST', { rev: (await admin('GET'))?.rev, flows: flow });
      const untouched = Object.fromEntries(['inject', 'http', 'db', 'sink'].map(id => [id, RED.nodes.getNode(id)]));
      for (const instance of Object.values(untouched)) assert.ok(instance);
      untouched.inject.on('input', () => injectInputs++);
      const bundle = buildSync({ entryPoints: ['scripts/diagnostics/preview-empty-tariff-scoped.mjs'], bundle: true,
        platform: 'node', format: 'cjs', target: 'node22', write: false, legalComments: 'none', external: ['node:crypto', 'node:perf_hooks'] }).outputFiles[0].text;
      const pre = await admin('GET');
      const built = patchPreview363Flow(pre.flows, { sourceCommit: 'a'.repeat(40), bundle, expectedNodeCount: flow.length,
        expectedFunctionSha256: sha256(source), expectedInitializeSha256: sha256(initialize), expectedFinalizeSha256: sha256(finalize) });
      const guarded = async (snapshot, candidate, reverse = false) => {
        const editor = structuredClone(snapshot.flows).reverse();
        for (const n of editor) { delete n.requestTimeout; delete n.nativeOnly; }
        const before = snapshot.flows.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func;
        const after = candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func;
        const seal = { protocol: 'source-preserving-v2', planSha256: 'b'.repeat(64), attemptSha256: 'c'.repeat(64),
          sourceGraphSha256: await preview363GraphHash(snapshot.flows), candidateGraphSha256: await preview363GraphHash(candidate),
          sourceOrderedGraphSha256: await preview363OrderedGraphHash(snapshot.flows), candidateOrderedGraphSha256: await preview363OrderedGraphHash(candidate),
          editorOrderedGraphSha256: await preview363OrderedGraphHash(editor), preRevisionSha256: sha256(snapshot.rev),
          beforeFunctionSha256: sha256(before), afterFunctionSha256: sha256(after), reverse };
        const preserve = await createPreview363BodyPreserver(seal, buildPreview363Artifact('a'.repeat(40), bundle), snapshot);
        const result = await preserve({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
          postBody: { rev: snapshot.rev, flows: editor } });
        assert.deepEqual(JSON.parse(result.postDataText).flows, candidate);
        return JSON.parse(result.postDataText);
      };
      await admin('POST', await guarded(pre, built.candidate));
      for (const [id, original] of Object.entries(untouched)) assert.strictEqual(RED.nodes.getNode(id), original, id);
      assert.equal(providerCalls, 0); assert.equal(dbCalls, 0); assert.equal(injectInputs, 0);
      const url = 'https://api.vivacrm.ru/end-user/api/v2/synthetic/products/one-times?exerciseId=synthetic';
      RED.nodes.getNode('lk_subscription_price_preview_20260908_router').receive({ payload: [], statusCode: 200,
        method: 'GET', url, responseUrl: url, req: { method: 'POST', path: '/lk/subscriptions/game-price-preview' },
        _subscriptionPricePreview: { step: 'groupTariff', tenantKey: 'synthetic', exerciseId: 'synthetic' } });
      for (let i = 0; i < 100 && outputs < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(outputs, 1, JSON.stringify(logs.map(l => typeof l.msg === 'string' ? l.msg.slice(0, 240) : 'NON_STRING_FIXTURE_LOG')));
      const emitted = logs.map(l => l.msg).find(s => typeof s === 'string' && s.includes('preview_empty_tariff_guard_diagnostic'));
      assert.ok(emitted); const event = JSON.parse(emitted.slice(emitted.indexOf('{')));
      assert.equal(event.tariffRequestScopeMatch, true); assert.equal(event.tariffTenantScopeMatch, true);
      assert.equal(event.tariffExerciseScopeMatch, true); assert.equal(event.tariffCount, 0);
      assert.equal(providerCalls, 0); assert.equal(dbCalls, 0); assert.equal(injectInputs, 0);
      await admin('POST', await guarded(await admin('GET'), pre.flows, true));
      const restored = await admin('GET');
      assert.equal(restored.flows.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func, source);
      for (const [id, original] of Object.entries(untouched)) assert.strictEqual(RED.nodes.getNode(id), original, id);
      assert(logs.filter(l => l.msg === 'SYNTHETIC_CROSS_DAY_DISPOSE').length >= 2);
      assert.equal(providerCalls, 0); assert.equal(dbCalls, 0); assert.equal(injectInputs, 0);
      return { protocol: 'preview363-rehearsal-v1', runtimeVersion: '4.0.9', providerCalls, dbCalls, injectInputs, outputs, unchangedNodeInstances: 4, sourceRestored: true };
    } finally {
      await RED.stop(); server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
      fs.rmSync(userDir, { recursive: true, force: true });
    }}

if (typeof process.send === 'function') {
  let failed = false;
  const failure = error => { failed = true; process.send?.({ protocol: 'preview363-rehearsal-failure-v1', error: String(error?.message || 'FIXTURE_ERROR').slice(0, 2000) }); };
  process.on('uncaughtException', failure); process.on('unhandledRejection', failure);
  try { const result = await runPreview363Rehearsal(); if (!failed) process.send(result); }
  catch (error) { failure(error); }
}
