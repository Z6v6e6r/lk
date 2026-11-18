import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { supportPhotoFixture, supportPhotoPins } from './fixtures/support-photos-release.mjs';
import { PHOTO_POLLERS, buildSupportPhotoTransition, supportPhotoOperations } from '../nodered_support_photos_release.mjs';
import { sha256 } from '../nodered_max_outbox_resume.mjs';
import { createSupportPhotosBodyPreserver, support_photosGraphHash, support_photosOrderedGraphHash } from '../nodered_reviewed_flow_deploy/support_photos_body_preserver.mjs';

const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
test('actual4.0.9 hot upload, pause2/install8+9/resume2 and paused inverse preserve unrelated instances and send nothing',
  { skip: !runtimeRoot, timeout: 60000 }, async () => {
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    assert.equal(require('node-red/package.json').version, '4.0.9');
    const RED = require('node-red'), express = require('express'), app = express(), server = http.createServer(app);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'support-photo-native-')));
    fs.chmodSync(root, 0o700); const userDir = path.join(root, 'user'); fs.mkdirSync(userDir);
    const key = 'SUPPORT_MEDIA_INTEGRATION_TOKEN', keys = [key, 'SUPPORT_MAX_MEDIA_SOURCE_HOSTS', 'SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN',
      'npm_config_ignore_scripts', 'npm_config_registry', 'npm_config_cache'];
    const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.npm_config_ignore_scripts = 'true'; process.env.npm_config_registry = 'http://127.0.0.1:1';
    process.env.npm_config_cache = path.join(root, 'npm-cache');
    const mediaFile = path.join(root, 'media.json'), queueFile = path.join(root, 'queue.env');
    fs.writeFileSync(mediaFile, JSON.stringify({ mediaToken: 'a'.repeat(64), sourceHosts: ['media.synthetic.invalid'] }), { mode: 0o600 });
    fs.writeFileSync(queueFile, 'SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN=' + 'b'.repeat(64) + '\n', { mode: 0o600 });
    const originalFetch = globalThis.fetch; let providerCalls = 0, incomingStarts = 0, starts = 0;
    const errors = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).hostname, '127.0.0.1', 'All non-loopback transport is forbidden in rehearsal');
      return originalFetch(url, options);
    };
    class Bot {
      constructor() { this.api = { sendMessageToChat: () => { providerCalls++; throw Error('NO_PROVIDER'); } }; }
      start() { incomingStarts++; throw Error('NO_INCOMING_POLLING'); }
    }
    RED.init(server, { userDir, flowFile: 'flows.json', flowFilePretty: true, httpAdminRoot: '/', httpNodeRoot: '/api',
      credentialSecret: 'synthetic-only', functionExternalModules: false, externalModules: { autoInstall: false },
      padlhubSupportMediaFile: mediaFile, padlhubMaxOutboxTokenFile: queueFile,
      logging: { console: { level: 'off' }, fixture: { level: 'error', handler: () => entry => errors.push(String(entry.msg)) } } });
    app.use(RED.httpAdmin); app.use('/api', RED.httpNode);
    const completed = new Set(); RED.events.on('runtime-event', e => { if (e.id === 'runtime-deploy') completed.add(e.payload.revision); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const admin = async (method, body) => {
      const response = await fetch(base + '/flows', { method, headers: { 'Content-Type': 'application/json',
        'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); const result = await response.json();
      if (method === 'POST') {
        for (let i = 0; i < 500 && !completed.has(result.rev); i++) await new Promise(r => setTimeout(r, 10));
        assert(completed.has(result.rev));
      }
      return result;
    };
    try {
      fs.writeFileSync(path.join(userDir, 'package.json'), JSON.stringify({ name: 'synthetic-photo-hot-upload', private: true }));
      const started = new Promise(resolve => RED.events.once('flows:started', resolve)); await RED.start(); await started;
      for (const name of ['maxbot-config', 'maxbot-send']) {
        const module = { exports: {} };
        vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(new URL('./fixtures/max-response-guard/' + name + '.js.txt', import.meta.url), 'utf8') + '\n})')(
          dependency => { assert.equal(dependency, '@maxhub/max-bot-api'); return { Bot }; }, module, module.exports);
        module.exports.default(RED);
      }
      RED.nodes.registerType('synthetic-startup', function(c) { RED.nodes.createNode(this, c); starts++; });
      const graph = supportPhotoFixture(), z = 'synthetic-tab';
      for (const node of graph) if (node.type === 'function') {
        if (node.id === 'unrelated' || node.id === 'lk_subscription_booking_router_20260804') node.func = 'return msg;';
        node.outputs = node.wires.length;
      }
      const ids = new Set(graph.map(n => n.id));
      const missing = new Set(graph.flatMap(n => (n.wires || []).flat()).filter(id => !ids.has(id)));
      graph.push(...[...missing].map(id => ({ id, type: 'function', z, func: 'return null;', outputs: 1, wires: [[]] })),
        { id: 'unrelated-startup', type: 'synthetic-startup', z, wires: [] },
        { id: 'unrelated-http', type: 'http in', z, method: 'get', url: '/synthetic-only', wires: [[]] });
      for (const node of graph) if (node.z) Object.assign(node, { x: 0, y: 0 });
      await admin('POST', { rev: (await admin('GET')).rev, flows: graph,
        credentials: { a5d5eca27e9e56da: { token: 'synthetic-bot-token' }, '55b05444842e7b84': { token: 'synthetic-bot-token' } } });
      const retainedIds = ['unrelated-startup', 'unrelated', 'unrelated-http', 'a5d5eca27e9e56da', '55b05444842e7b84', 'lk_subscription_booking_router_20260804'];
      const retained = retainedIds.map(id => RED.nodes.getNode(id));
      const adapter = fileURLToPath(new URL('../../node-red/max-outbox-adapter', import.meta.url));
      const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: adapter, encoding: 'utf8' }));
      const form = new FormData(); form.append('tarball', new Blob([fs.readFileSync(path.join(root, packed[0].filename))]), packed[0].filename);
      const upload = await fetch(base + '/nodes', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
      assert.equal(upload.status, 200, await upload.text());
      const installed = path.join(userDir, 'node_modules/node-red-contrib-padlhub-max-outbox');
      assert.deepEqual(fs.readdirSync(installed).sort(), fs.readdirSync(adapter).sort());
      for (const file of fs.readdirSync(adapter)) assert(fs.readFileSync(path.join(installed, file)).equals(fs.readFileSync(path.join(adapter, file))), file);
      assert.equal(process.env[key], 'a'.repeat(64)); assert.equal(typeof RED.nodes.getType('max-legacy-outbox-send'), 'function');
      let current = await admin('GET'); const original = Buffer.from(JSON.stringify(current.flows, null, 4)), pins = supportPhotoPins(original);
      for (const purpose of ['pause', 'install', 'resume', 'pause-photo', 'recover']) {
        const before = Buffer.from(JSON.stringify(current.flows, null, 4));
        const built = buildSupportPhotoTransition(before, original, pins, purpose), operations = supportPhotoOperations(current.flows, built.flow, purpose);
        const seal = { protocol: 'support-photos-source-preserving-v1', purpose, operations, operationsSha256: sha256(JSON.stringify(operations)),
          planSha256: 'c'.repeat(64), attemptSha256: sha256(purpose), preRevisionSha256: sha256(current.rev),
          sourceGraphSha256: await support_photosGraphHash(current.flows), sourceOrderedGraphSha256: await support_photosOrderedGraphHash(current.flows),
          editorOrderedGraphSha256: await support_photosOrderedGraphHash(current.flows), candidateGraphSha256: await support_photosGraphHash(built.flow),
          candidateOrderedGraphSha256: await support_photosOrderedGraphHash(built.flow), nativeDiskSha256: sha256(JSON.stringify(built.flow, null, 4)) };
        const preserve = await createSupportPhotosBodyPreserver(seal, current);
        const body = await preserve({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' }, postBody: current });
        await admin('POST', JSON.parse(body.postDataText)); current = await admin('GET');
        assert.deepEqual(current.flows, built.flow);
        assert.equal(fs.readFileSync(path.join(userDir, 'flows.json'), 'utf8'), JSON.stringify(built.flow, null, 4));
        for (const [index, id] of retainedIds.entries()) assert.strictEqual(RED.nodes.getNode(id), retained[index], id);
        assert.equal(starts, 1); assert.equal(providerCalls, 0); assert.equal(incomingStarts, 0);
      }
      assert.equal(current.flows.length, JSON.parse(original).length);
      assert(PHOTO_POLLERS.every(id => current.flows.find(n => n.id === id).d === true));
      assert(errors.every(error => !error.includes('a'.repeat(64)) && !error.includes('b'.repeat(64))));
    } finally {
      try { await RED.stop(); } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
        for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
