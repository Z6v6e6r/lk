import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('Node-RED 4.0.9 editor loads adapter HTML rather than CommonJS runtime source', async () => {
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
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw Error('External calls prohibited in editor test'); };
  try {
    fs.mkdirSync(path.join(userDir, 'node_modules'));
    fs.cpSync(adapter, path.join(userDir, 'node_modules', pkg), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'package.json'), JSON.stringify({
      name: 'synthetic-max-editor-test', private: true, dependencies: { [pkg]: '1.0.0' }
    }));
    RED.init(server, {
      userDir, flowFile: 'synthetic-flows.json', credentialSecret: 'synthetic-only',
      httpAdminRoot: '/red', disableEditor: false, functionExternalModules: false,
      externalModules: { autoInstall: false }, logging: { console: { level: 'off' } }
    });
    await RED.start();
    const info = registry.getNodeInfo(`${pkg}/max-outbox-send`);
    const templates = registry.getNodeConfigs('en-US');
    assert.equal(typeof RED.nodes.getType('max-outbox-send'), 'function');
    assert.equal(info?.loaded, true);
    assert.equal(info?.enabled, true);
    assert.ok(!info.err);
    assert.match(templates, /data-template-name=["']max-outbox-send/);
    assert.match(templates, /data-help-name=["']max-outbox-send/);
    const runtimeSource = fs.readFileSync(path.join(adapter, 'max-outbox-send.js'), 'utf8');
    assert.ok(!templates.includes(runtimeSource), 'Editor must never receive runtime JavaScript as its template');
    assert.equal(providerCalls, 0);
  } finally {
    try { await RED.stop(); } finally {
      server.close();
      globalThis.fetch = originalFetch;
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }
});
