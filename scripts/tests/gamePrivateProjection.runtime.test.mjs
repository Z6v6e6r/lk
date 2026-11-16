import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { candidateFunctions, fixture, getPublic, phone, applyFixtureUpdate } from './helpers/gamePrivateProjectionFixture.mjs';

const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
test('native Node-RED 4.0.9 PATCH pipeline preserves private data and organizer authority with only a synthetic DB',
  { skip: !runtimeRoot, timeout: 30000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express');
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-projection-runtime-'));
    const game = fixture(), counters = { writes: 0, followups: 0 };
    const app = express(), server = http.createServer(app);
    RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/', httpNodeRoot: '/api', disableEditor: true,
      functionExternalModules: false, functionGlobalContext: { game, counters, applyFixtureUpdate },
      logging: { console: { level: 'off' } } });
    app.use(RED.httpAdmin); app.use('/api', RED.httpNode);
    const deployed = new Set();
    RED.events.on('runtime-event', event => { if (event.id === 'runtime-deploy') deployed.add(event.payload.revision); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options) => fetch(base + url, { ...options, signal: AbortSignal.timeout(10000) });
    const functions = candidateFunctions();
    const flows = [
      { id: 'tab', type: 'tab', label: 'synthetic private-projection fixture', env: [{ name: 'PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED', value: 'false', type: 'str' }] },
      { id: 'entry', type: 'http in', z: 'tab', url: '/lk/games/:gameId', method: 'patch', wires: [['read']] },
      { id: 'read', type: 'function', z: 'tab', outputs: 1, func: 'msg._organizerGuardBody = msg.payload; msg.payload = [global.get("game")]; return msg;', wires: [['guard']] },
      { id: 'guard', type: 'function', z: 'tab', outputs: 2, func: functions.organizer_handoff_20260913_patch_check, wires: [['prepare'], ['response']] },
      { id: 'prepare', type: 'function', z: 'tab', outputs: 4, func: functions.e0d7883bc1a9fa8c, wires: [['db'], ['response'], [], []] },
      { id: 'db', type: 'function', z: 'tab', outputs: 1, func: 'global.get("counters").writes++; global.get("applyFixtureUpdate")(global.get("game"), msg); msg.payload = { acknowledged: true, matchedCount: 1 }; return msg;', wires: [['ack']] },
      { id: 'ack', type: 'function', z: 'tab', outputs: 2, func: functions.organizer_handoff_20260913_patch_ack, wires: [['response'], ['followup']] },
      { id: 'followup', type: 'function', z: 'tab', outputs: 0, func: 'global.get("counters").followups++; return null;', wires: [] },
      { id: 'response', type: 'http response', z: 'tab', wires: [] },
    ];
    flows.forEach(node => { if (node.type !== 'tab') Object.assign(node, { x: 0, y: 0 }); });
    try {
      await RED.start();
      const before = await (await request('/flows', { headers: { 'Node-RED-API-Version': 'v2' } })).json();
      const deploy = await request('/flows', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: JSON.stringify({ rev: before?.rev, flows }) });
      assert.equal(deploy.status, 200); const { rev } = await deploy.json();
      for (let i = 0; i < 500 && !deployed.has(rev); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(deployed.has(rev)); assert.deepEqual(counters, { writes: 0, followups: 0 });
      const patch = async body => {
        const response = await request('/api/lk/games/fixture-game', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
      };
      const projected = getPublic(game);
      assert.equal((await patch({ organizer: projected.organizer })).status, 409);
      const good = await patch({ expectedUpdatedAt: game.updatedAt, participants: projected.participants, waitlist: projected.waitlist, metadata: projected.metadata });
      assert.equal(good.status, 200); assert.ok(!JSON.stringify(good.body).includes(phone(2)));
      assert.equal(game.participants[1].phone, phone(2)); assert.equal(game.organizer.phone, phone(1));
      assert.equal((await patch({ expectedUpdatedAt: 'stale', participants: [] })).status, 409);
      assert.equal((await patch({ organizer: { id: 'foreign', phone: phone(9) } })).status, 409);
      assert.equal(counters.writes, 1);
      for (let i = 0; i < 100 && counters.followups !== 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(counters.followups, 1);
      assert.ok(flows.every(node => !['http request', 'inject', 'mongodb4'].includes(node.type)));
    } finally {
      await RED.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });
