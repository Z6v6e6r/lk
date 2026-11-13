/* global window, XMLHttpRequest */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { graph } from './splitLeaveCollector.test.mjs';
import { buildCollectorCandidate } from '../diagnostics/split-leave-collector.mjs';
import { collectorGraphHash, collectorOrderedGraphHash } from '../nodered_reviewed_flow_deploy/collector_body_preserver.mjs';
import { buildCollectorBrowserGuard, buildCollectorEditorReadback } from '../nodered_reviewed_flow_deploy/collector_browser_guard.mjs';
test('real native Chromium XHR preserves auth, exact candidate and actual ACK; refuses reuse; reader rejects dirty editor',
  { skip: !process.env.LK_PLAYWRIGHT_ROOT, timeout: 30000 }, async () => {
    const require = createRequire(path.join(process.env.LK_PLAYWRIGHT_ROOT, 'package.json'));
    const pw = require(process.env.LK_PLAYWRIGHT_ROOT), source = graph();
    const sha = value => createHash('sha256').update(value).digest('hex');
    const built = buildCollectorCandidate(source, { release: 'a'.repeat(40), routeHash: sha(JSON.stringify(source[1])) });
    const seal = { protocol: 'source-preserving-v2', planSha256: 'a'.repeat(64), attemptSha256: 'b'.repeat(64),
      sourceGraphSha256: await collectorGraphHash(source), candidateGraphSha256: await collectorGraphHash(built.candidate),
      sourceOrderedGraphSha256: await collectorOrderedGraphHash(source), candidateOrderedGraphSha256: await collectorOrderedGraphHash(built.candidate),
      editorOrderedGraphSha256: await collectorOrderedGraphHash(source), preRevisionSha256: sha('fixture-rev'),
      beforeRouteSha256: built.beforeRouteSha256, gateSha256: built.gateSha256, gate: built.gate,
      routeId: source[1].id, beforeWires: built.beforeWires, notAfter: new Date(Date.now() + 300000).toISOString() };
    const browser = await pw.chromium.launch({ headless: true }); let forwarded = 0;
    try {
      const context = await browser.newContext();
      await context.route('**/*', async route => {
        if (route.request().method() === 'GET') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated native fixture</title>' }); return; }
        assert.equal(route.request().url(), 'http://127.0.0.1:18801/flows');
        assert.deepEqual(route.request().postDataJSON().flows, built.candidate);
        assert.equal(route.request().headers().authorization, 'fixture-native-auth'); forwarded++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rev: 'fixture-after' }) });
      });
      const page = await context.newPage(); await page.goto('http://127.0.0.1:18801/?isolated-collector');
      const result = await page.evaluate(async ({ code, seal, source }) => {
        const guard = await eval(code)(seal, { rev: 'fixture-rev', flows: source });
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest(); xhr.open('POST', '/flows', true, undefined, undefined);
          xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('Authorization', 'fixture-native-auth');
          xhr.setRequestHeader('Node-RED-API-Version', 'v2'); xhr.setRequestHeader('Node-RED-Deployment-Type', 'nodes');
          xhr.addEventListener('load', resolve); xhr.addEventListener('error', reject);
          xhr.send(JSON.stringify({ rev: 'fixture-rev', flows: source }));
        });
        // The caller's load listener may precede the observer. Let that dispatch finish.
        await new Promise(resolve => setTimeout(resolve, 0));
        const audit = guard.status(), ack = guard.acknowledgement();
        let refused = false;
        try { const xhr = new XMLHttpRequest(); xhr.open('POST', '/flows'); xhr.send('{}'); } catch { refused = true; }
        return { audit, ack, refused };
      }, { code: buildCollectorBrowserGuard(), seal, source });
      assert.equal(forwarded, 1); assert.equal(result.audit.forwarded, 1); assert.equal(result.ack.httpStatus, 200); assert(result.refused);
      assert(!JSON.stringify(result).includes('fixture-native-auth'));
      const second = await context.newPage(); await second.goto('http://127.0.0.1:18801/?isolated-reader');
      const dirty = await second.evaluate(async code => {
        window.RED = { nodes: { dirty: () => true, createCompleteNodeSet: () => [] } };
        let reads = 0; window.jQuery = { ajax: () => { reads++; } };
        const reader = eval(code);
        try { await reader(); return { refused: false, reads }; } catch { return { refused: true, reads }; }
      }, buildCollectorEditorReadback());
      assert.equal(dirty.refused, true); assert.equal(dirty.reads, 0);
    } finally { await browser.close(); }
  });
