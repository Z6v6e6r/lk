import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { patchFunction98Flow, sha256, FUNCTION98_SAFE_DIAGNOSTIC } from '../lib/function98_safe_diagnostic.mjs';
import { createFunction98BodyPreserver, function98GraphHash, function98OrderedGraphHash } from '../nodered_reviewed_flow_deploy/function98_body_preserver.mjs';

const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
test('real Node-RED 4.0.9 modified-nodes preserves inject/HTTP instances and makes zero startup provider calls',
  { skip: !runtimeRoot, timeout: 30000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'function98-runtime-'));
    const logs = []; let providerCalls = 0, injectInputs = 0;
    const provider = http.createServer((req, res) => {
      providerCalls++; assert.equal(req.url, '/?probe=synthetic-query-marker'); res.end('provider-ok');
    });
    const app = express(), server = http.createServer(app);
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/', httpNodeRoot: '/api', disableEditor: true,
      functionExternalModules: false, logging: { console: { level: 'off' }, fixture: { level: 'warn', handler: () => entry => logs.push(entry) } } });
    app.use(RED.httpAdmin); app.use('/api', RED.httpNode);
    const deployed = new Set();
    RED.events.on('runtime-event', event => { if (event.id === 'runtime-deploy') deployed.add(event.payload.revision); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    const admin = async (method, body) => {
      const response = await request(base + '/flows', { method, headers: { 'Content-Type': 'application/json',
        'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200); const result = await response.json();
      if (method === 'POST') {
        // Native v2 ACK precedes the asynchronous start. Observe its completion,
        // rather than treating ACK or disk bytes as a running-node proof.
        for (let i = 0; i < 500 && !deployed.has(result.rev); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(deployed.has(result.rev), true);
      }
      return result;
    };
    try {
      await RED.start();
      const source = `const endpoint = 'http://127.0.0.1:${provider.address().port}/?probe=synthetic-query-marker';\nnode.warn(endpoint);\nmsg.url = endpoint;\nreturn msg;`;
      const flow = [{ id: 'tab', type: 'tab', label: 'synthetic isolated function98 fixture', disabled: false },
        { id: 'inject', type: 'inject', z: 'tab', once: false, repeat: '', crontab: '0 0 1 1 *', wires: [['target']] },
        { id: 'entry', type: 'http in', z: 'tab', url: '/probe', method: 'get', wires: [['target']] },
        { id: 'target', type: 'function', z: 'tab', name: 'function 98', func: source, outputs: 1, wires: [['http', 'debug']] },
        { id: 'http', type: 'http request', z: 'tab', method: 'GET', ret: 'txt', url: '', requestTimeout: '120000', customRuntimeOption: 'synthetic-preserve', wires: [['response']] },
        { id: 'debug', type: 'debug', z: 'tab', active: false, complete: 'true', wires: [] },
        { id: 'response', type: 'http response', z: 'tab', wires: [] }];
      // Node-RED distinguishes runtime nodes from config nodes by coordinates.
      for (const node of flow) if (node.type !== 'tab') Object.assign(node, { x: 0, y: 0 });
      await admin('POST', { rev: (await admin('GET'))?.rev, flows: flow });
      const inject = RED.nodes.getNode('inject'), httpNode = RED.nodes.getNode('http'), fn = RED.nodes.getNode('target');
      const syntheticCredentials = { user: 'fixture-user', password: 'fixture-password' };
      RED.nodes.addCredentials('http', syntheticCredentials);
      inject.on('input', () => injectInputs++);
      await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(providerCalls, 0);
      assert.equal(await (await request(base + '/api/probe')).text(), 'provider-ok'); assert.equal(providerCalls, 1);
      const warningsBefore = logs.length, before = await admin('GET');
      const patched = patchFunction98Flow(flow, { expectedFunctionSha256: sha256(source) }).candidate;
      const editor = structuredClone(before.flows);
      delete editor.find(n => n.id === 'http').requestTimeout; delete editor.find(n => n.id === 'http').customRuntimeOption;
      editor.find(n => n.id === 'tab').x = 0; editor.find(n => n.id === 'tab').y = 0;
      const seal = { protocol: 'source-preserving-v2', planSha256: 'a'.repeat(64), attemptSha256: 'b'.repeat(64),
        sourceGraphSha256: await function98GraphHash(before.flows), candidateGraphSha256: await function98GraphHash(patched),
        sourceOrderedGraphSha256: await function98OrderedGraphHash(before.flows), candidateOrderedGraphSha256: await function98OrderedGraphHash(patched),
        editorOrderedGraphSha256: await function98OrderedGraphHash(editor), preRevisionSha256: sha256(before.rev),
        beforeFunctionSha256: sha256(source), afterFunctionSha256: sha256(patched.find(n => n.id === 'target').func) };
      const preserve = await createFunction98BodyPreserver(seal, before);
      const output = await preserve({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' }, postBody: { rev: before.rev, flows: editor } });
      assert.deepEqual(JSON.parse(output.postDataText).flows, patched);
      const result = await admin('POST', JSON.parse(output.postDataText));
      assert.deepEqual((await admin('GET')).flows, patched);
      assert.notEqual(result.rev, before.rev);
      assert.strictEqual(RED.nodes.getNode('inject'), inject);
      assert.strictEqual(RED.nodes.getNode('http'), httpNode);
      assert.deepEqual(RED.nodes.getCredentials('http'), syntheticCredentials);
      assert.notStrictEqual(RED.nodes.getNode('target'), fn);
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(providerCalls, 1); assert.equal(injectInputs, 0);
      assert.equal(await (await request(base + '/api/probe')).text(), 'provider-ok'); assert.equal(providerCalls, 2);
      const afterWarnings = logs.slice(warningsBefore).filter(entry => entry.id === 'target').map(entry => entry.msg);
      assert.deepEqual(afterWarnings, [FUNCTION98_SAFE_DIAGNOSTIC]);
      const stale = await request(base + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: JSON.stringify({ rev: before.rev, flows: flow }) });
      assert.equal(stale.status, 409); assert.equal((await admin('GET')).rev, result.rev);
    } finally {
      await RED.stop(); server.closeAllConnections(); provider.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });
