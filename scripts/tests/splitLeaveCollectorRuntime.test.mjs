import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { graph } from './splitLeaveCollector.test.mjs';
import { buildCollectorCandidate, ROUTE_ID } from '../diagnostics/split-leave-collector.mjs';
const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
test('real isolated Node-RED native nodes deploy and exact inverse preserve unrelated instances and store only safe diagnostics',
  { skip: !runtimeRoot, timeout: 45000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-leave-runtime-'));
    const app = express(), server = http.createServer(app), stored = [];
    let sentinelStarts = 0, unexpectedInputs = 0;
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/', httpNodeRoot: '/api', disableEditor: true,
      functionExternalModules: false, logging: { console: { level: 'off' } } });
    RED.nodes.registerType('mongodb4', function (config) {
      RED.nodes.createNode(this, config); this.on('input', msg => stored.push(msg));
    });
    RED.nodes.registerType('collector-sentinel', function (config) {
      RED.nodes.createNode(this, config); sentinelStarts++; this.on('input', () => unexpectedInputs++);
    });
    app.use(RED.httpAdmin); app.use('/api', RED.httpNode);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, deployed = new Set();
    RED.events.on('runtime-event', event => { if (event.id === 'runtime-deploy') deployed.add(event.payload.revision); });
    const request = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(15000) });
    const get = async () => (await request('/flows', { headers: { 'Node-RED-API-Version': 'v2' } })).json();
    const deploy = async snapshot => {
      const response = await request('/flows', { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: JSON.stringify(snapshot) });
      assert.equal(response.status, 200); const ack = await response.json();
      for (let i = 0; i < 1000 && !deployed.has(ack.rev); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(deployed.has(ack.rev)); return ack;
    };
    try {
      await RED.start();
      const initial = await get();
      await deploy({ rev: initial?.rev, flows: [...graph(), { id: 'unrelated', type: 'collector-sentinel', z: 'tab', wires: [] }].map((node, i) => node.type === 'tab' ? node : { ...node, x: 100, y: 80 + i * 40 }) });
      const source = await get(), sentinel = RED.nodes.getNode('unrelated');
      const built = buildCollectorCandidate(source.flows, { release: 'a'.repeat(40),
        routeHash: createHash('sha256').update(JSON.stringify(source.flows.find(node => node.id === ROUTE_ID))).digest('hex') });
      await deploy({ rev: source.rev, flows: built.candidate });
      const active = await get(); assert.deepEqual(active.flows, built.candidate);
      assert.equal(RED.nodes.getNode('unrelated'), sentinel); assert.equal(sentinelStarts, 1); assert.equal(unexpectedInputs, 0);
      const secret = 'SENSITIVE_TEST_SENTINEL';
      const payload = { schemaVersion: 1, diagnosticEventId: randomUUID(), requestId: randomUUID(), eventKind: 'client_error',
        source: 'browser', method: 'POST', routeTemplate: '/lk/games/:gameId/split/leave', stage: 'leave_initiator',
        code: 'SPLIT_LEAVE_INITIATED', deviceEventTime: new Date().toISOString(), token: secret,
        leaveTrace: { frames: [{ asset: 'games.js', line: 1, column: 42, url: secret }],
          actions: [{ action: 'GAME_LEAVE', kind: 'click', ageMs: 3, trusted: true, text: secret }] } };
      const response = await request('/api/lk/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'client_error', payload, session: secret }) });
      assert.equal(response.status, 200); await response.text();
      for (let i = 0; i < 100 && !stored.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(stored.length, 1); assert(!JSON.stringify(stored).includes(secret));
      assert.equal(stored[0].req, undefined); assert.equal(stored[0].res, undefined);
      assert.equal(stored[0].payload.payload.leaveTrace.frames[0].column, 42);
      assert(stored[0].payload.payload.serverIngestTime);
      // Restore exact source graph via native nodes deployment; no business state is touched.
      await deploy({ rev: active.rev, flows: source.flows });
      assert.deepEqual((await get()).flows, source.flows);
      assert.equal(RED.nodes.getNode('unrelated'), sentinel); assert.equal(sentinelStarts, 1); assert.equal(unexpectedInputs, 0);
    } finally { await RED.stop(); await new Promise(resolve => server.close(resolve)); fs.rmSync(userDir, { recursive: true, force: true }); }
  });
