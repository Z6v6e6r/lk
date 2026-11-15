import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('Node-RED 4.0.9 loads both editor types and persists a receipt using actual flow/group env', async () => {
  const runtimePath = process.env.NODE_RED_TEST_PACKAGE;
  assert.ok(runtimePath && path.isAbsolute(runtimePath),
    'Set NODE_RED_TEST_PACKAGE to an isolated node-red@4.0.9 package directory');
  const require = createRequire(path.join(runtimePath, 'package.json'));
  const RED = require(runtimePath);
  const registry = require('@node-red/registry');
  assert.equal(require('./package.json').version, '4.0.9');
  const adapter = fileURLToPath(new URL('../../node-red/max-outbox-adapter/', import.meta.url));
  const pkg = 'node-red-contrib-padlhub-max-outbox';
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-editor-loader-'));
  const server = http.createServer(); // No listener, installed flows or real bot credentials.
  const originalFetch = globalThis.fetch;
  const mediaKeys = ['SUPPORT_MEDIA_INTEGRATION_TOKEN', 'SUPPORT_MAX_MEDIA_SOURCE_HOSTS'];
  const previousMediaEnvironment = Object.fromEntries(mediaKeys.map(key => [key, process.env[key]]));
  for (const key of mediaKeys) delete process.env[key];
  const receipt = { id: 'synthetic-command', leaseToken: randomUUID(), kind: 'ack' };
  let cupCalls = 0, resolveOutput;
  const outputs = new Promise(resolve => { resolveOutput = resolve; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    // Entirely synthetic transport. Any route outside the exact CUP fixture fails the test.
    assert.equal(String(url), 'http://127.0.0.1:3000/api/support/outbox/synthetic-command/ack');
    assert.equal(options.headers['x-integration-token'], 'synthetic-group-token');
    requests.push(options.body); cupCalls++;
    return cupCalls === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({
      id: receipt.id, status: 'SENT', lastReceipt: { token: receipt.leaseToken, kind: 'ack' }
    }));
  };
  try {
    const mediaFile = path.join(fs.realpathSync(userDir), 'media.json');
    fs.writeFileSync(mediaFile, JSON.stringify({ mediaToken: 'a'.repeat(64), sourceHosts: ['media.synthetic.invalid'] }), { mode: 0o600 });
    fs.mkdirSync(path.join(userDir, 'node_modules'));
    fs.cpSync(adapter, path.join(userDir, 'node_modules', pkg), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'package.json'), JSON.stringify({
      name: 'synthetic-max-editor-test', private: true, dependencies: { [pkg]: JSON.parse(fs.readFileSync(path.join(adapter, 'package.json'))).version }
    }));
    fs.writeFileSync(path.join(userDir, 'synthetic-flows.json'), JSON.stringify([
      { id: 'synthetic-tab', type: 'tab', label: 'Synthetic only', env: [
        { name: 'SUPPORT_API_BASE_URL', type: 'str', value: 'http://127.0.0.1:3000/api' },
        { name: 'SUPPORT_INTEGRATION_TOKEN', type: 'str', value: 'synthetic-flow-token' }
      ] },
      { id: 'synthetic-group', type: 'group', z: 'synthetic-tab', nodes: ['synthetic-receipt'], env: [
        { name: 'SUPPORT_INTEGRATION_TOKEN', type: 'str', value: 'synthetic-group-token' }
      ] },
      { id: 'synthetic-receipt', type: 'max-outbox-receipt', z: 'synthetic-tab', g: 'synthetic-group', x: 100, y: 100, wires: [['synthetic-capture']] },
      { id: 'synthetic-capture', type: 'synthetic-capture', z: 'synthetic-tab', x: 300, y: 100, wires: [] }
    ]));
    RED.init(server, {
      userDir, flowFile: 'synthetic-flows.json', credentialSecret: 'synthetic-only',
      httpAdminRoot: '/red', disableEditor: false, functionExternalModules: false,
      externalModules: { autoInstall: false }, logging: { console: { level: 'off' } },
      padlhubSupportMediaFile: mediaFile
    });
    RED.nodes.registerType('synthetic-capture', function(config) {
      RED.nodes.createNode(this, config);
      this.on('input', (msg, _send, done) => { resolveOutput(msg); done(); });
    });
    const started = new Promise(resolve => require('@node-red/util').events.once('flows:started', resolve));
    await RED.start();
    await started;
    const info = registry.getNodeInfo(`${pkg}/max-outbox-send`);
    const templates = registry.getNodeConfigs('en-US');
    assert.equal(typeof RED.nodes.getType('max-outbox-send'), 'function');
    assert.equal(process.env.SUPPORT_MEDIA_INTEGRATION_TOKEN, 'a'.repeat(64));
    assert.equal(process.env.SUPPORT_MAX_MEDIA_SOURCE_HOSTS, 'media.synthetic.invalid');
    const { validateImages } = createRequire(path.join(adapter, 'package.json'))('./max-media.js');
    assert.equal(validateImages([{ type: 'IMAGE', url: 'https://media.synthetic.invalid/cup-support/v1/' + 'b'.repeat(64) + '/' + 'c'.repeat(64) + '.jpg' }]).length, 1);
    assert.throws(() => validateImages([{ type: 'IMAGE', url: 'https://other.synthetic.invalid/cup-support/v1/' + 'b'.repeat(64) + '/' + 'c'.repeat(64) + '.jpg' }]), /URL_REFUSED/);
    assert.equal(typeof RED.nodes.getType('max-legacy-outbox-send'), 'function');
    assert.equal(typeof RED.nodes.getType('max-outbox-receipt'), 'function');
    assert.match(templates, /data-template-name=["']max-outbox-receipt/);
    assert.equal(info?.loaded, true);
    assert.equal(info?.enabled, true);
    assert.ok(!info.err);
    assert.match(templates, /data-template-name=["']max-outbox-send/);
    assert.match(templates, /data-help-name=["']max-outbox-send/);
    assert.match(templates, /data-template-name=["']max-legacy-outbox-send/);
    assert.match(templates, /data-help-name=["']max-legacy-outbox-send/);
    const runtimeSource = fs.readFileSync(path.join(adapter, 'max-outbox-send.js'), 'utf8');
    assert.ok(!templates.includes(runtimeSource), 'Editor must never receive runtime JavaScript as its template');
    assert.equal(cupCalls, 0);
    RED.nodes.getNode('synthetic-receipt').receive({ maxOutboxReceipt: receipt,
      maxOutboxLeaseUntil: new Date(Date.now() + 120000).toISOString(),
      url: 'https://invalid.test', headers: { 'x-integration-token': 'private-override' }, payload: 'private-context' });
    let timer;
    try {
      const output = await Promise.race([outputs, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('Synthetic receipt runtime did not finish')), 5000);
      })]);
      assert.deepEqual(output.maxOutboxReceiptResult, { state: 'CONFIRMED', code: 'DB_RECEIPT_CONFIRMED', attempts: 2 });
      assert.equal(cupCalls, 2); assert.equal(new Set(requests).size, 1);
      assert(!JSON.stringify(output).includes('private'));
      assert(!JSON.stringify(output).includes(receipt.leaseToken));
    } finally { clearTimeout(timer); }
  } finally {
    try { await RED.stop(); } finally {
      server.close();
      globalThis.fetch = originalFetch;
      for (const key of mediaKeys) {
        if (previousMediaEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousMediaEnvironment[key];
      }
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }
});
