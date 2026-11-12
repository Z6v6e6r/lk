import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as perf from 'node:perf_hooks';
import { buildSync } from 'esbuild';
import { createScopedEmptyTariffObserver } from '../diagnostics/preview-empty-tariff-scoped.mjs';
import { buildPreview363Artifact, sha256 } from '../lib/preview363_activation.mjs';
import { applyPreview363Body, PREVIEW363_HOOK } from '../lib/preview363_body_patch.mjs';
const release = 'a'.repeat(40), sourceHash = 'b'.repeat(64);
const fields = { code: 'PREVIEW_EMPTY_TARIFF_OBSERVED', reason: 'empty_tariff_list', tariffEventIdentityMatch: true };
const req = () => ({ path: '/lk/subscriptions/game-price-preview', method: 'POST', headers: { authorization: 'private-marker' } });
const message = (payload = [], request = req()) => ({ req: request, _msgid: 'private-marker',
  method: 'GET', url: 'https://api.vivacrm.ru/end-user/api/v2/private-marker/products/one-times?exerciseId=private-marker',
  responseUrl: 'https://api.vivacrm.ru/end-user/api/v2/private-marker/products/one-times?exerciseId=private-marker',
  _lkDiagnosticContext: { requestId: 'private-marker', token: 'private-marker' }, payload,
  _subscriptionPricePreview: { step: 'groupTariff', tenantKey: 'private-marker', exerciseId: 'private-marker' }, statusCode: 200 });
test('scoped projection preserves original shadowing facts, server correlation and no raw context', () => {
  const events = [], observer = createScopedEmptyTariffObserver({ release, sourceHash, sink: e => events.push(e) });
  const request = req(), m = message({ content: [], data: { content: [{ secret: 'private-marker' }] } }, request);
  observer.observe(m, 'preview_router', { ...fields, token: 'private-marker' });
  observer.observe(message([], request), 'preview_router', fields);
  observer.observe(message(), 'preview_router', fields);
  assert.equal(events.length, 3); assert.equal(events[0].tariffShadowedNonemptyArray, true);
  assert.equal(events[0].responseKind, 'object'); assert.equal(events[0].upstreamStatus, 200);
  assert.equal(events[0].operationStage, 'groupTariff'); assert.equal(events[0].tariffEventIdentityMatch, true);
  assert.equal(events[0].correlationHash, events[1].correlationHash);
  assert.notEqual(events[0].correlationHash, events[2].correlationHash);
  assert.equal(events[0].correlationHash, 'c1:' + sha256(`lk-preview-request-v1\0${events[0].requestId}`));
  assert(!JSON.stringify(events).includes('private-marker'));
  observer.dispose(); observer.observe(m, 'preview_router', fields); assert.equal(events.length, 3);
});
test('scoped observer filters before budget, bounds detail and survives both sink failure kinds', async () => {
  const events = [], observer = createScopedEmptyTariffObserver({ release, sourceHash, detailLimit: 1, sink: e => events.push(e) });
  observer.observe(message(), 'preview_router', { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' });
  observer.observe(message(), 'preview_router', fields); observer.observe(message(), 'preview_router', fields);
  observer.dispose(); assert.equal(events[0].code, fields.code); assert.equal(events[1].suppressedCount, 1);
  for (const sink of [() => { throw Error('private-marker'); }, () => Promise.reject(Error('private-marker'))]) {
    const broken = createScopedEmptyTariffObserver({ release, sourceHash, sink });
    assert.doesNotThrow(() => broken.observe(message(), 'preview_router', fields)); broken.dispose();
  }
  await new Promise(resolve => setImmediate(resolve));
});
test('func-only bootstrap preserves old observer ownership, dispatch and disposal', () => {
  const bundle = buildSync({ entryPoints: ['scripts/diagnostics/preview-empty-tariff-scoped.mjs'], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', write: false, legalComments: 'none', external: ['node:crypto', 'node:perf_hooks'] }).outputFiles[0].text;
  const artifact = buildPreview363Artifact(release, bundle);
  const source = "const ctx={};const tariffDetails=()=>({});const reason='other';const lkDiagnostic=()=>{};\n    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');\nreturn msg;";
  const patched = applyPreview363Body(source, artifact);
  assert.equal(applyPreview363Body(patched, artifact, true), source);
  const tracked = fs.readFileSync('scripts/nodered_subscription_price_preview_nodes/router.js', 'utf8');
  assert(tracked.includes(PREVIEW363_HOOK), 'the installed hook must be the reviewed PR363 hook verbatim');
  const warnings = []; let oldObserved = 0, oldDisposed = 0;
  const prior = Object.freeze({ owner: 'preview-cross-day-v1', observe() { oldObserved++; }, dispose() { oldDisposed++; }, snapshot: () => ({ old: true }) });
  const context = vm.createContext({ __lkPreview350Observer: prior, setTimeout, clearTimeout });
  const run = vm.compileFunction(patched, ['msg', 'node', 'preview350Crypto', 'preview350Performance'], { parsingContext: context });
  const node = { warn: s => warnings.push(s) };
  const msg = { unchanged: true }; assert.strictEqual(run(msg, node, crypto, perf), msg);
  const own = context.__lkPreview350Observer; assert.equal(own.owner, prior.owner); assert.equal(own.preview363, true);
  own.observe(message(), 'preview_router', { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' }); assert.equal(oldObserved, 1);
  own.observe(message(), 'preview_router', fields); assert.equal(oldObserved, 1);
  assert(warnings.some(s => s.includes('preview_empty_tariff_guard_diagnostic')));
  const diagnostic = warnings.find(s => s.includes('preview_empty_tariff_guard_diagnostic'));
  const event = JSON.parse(diagnostic.slice(diagnostic.indexOf('{')));
  assert.equal(event.tariffRequestScopeMatch, true);
  assert.equal(event.tariffTenantScopeMatch, true, 'no URL global is needed for a proven exact request match');
  assert.equal(event.tariffExerciseScopeMatch, true);
  run(msg, node, crypto, perf); assert.strictEqual(context.__lkPreview350Observer, own);
  own.dispose(); assert.equal(oldDisposed, 1);
  assert(!warnings.some(s => s.includes('private-marker')));
});
test('broken bundle and absent/foreign observer keep original business result and never print private errors', () => {
  const artifact = buildPreview363Artifact(release, "throw Error('private-marker');");
  const source = "const ctx={};const tariffDetails=()=>({});const reason='other';const lkDiagnostic=()=>{};\n    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');\nreturn msg;";
  for (const owner of ['preview-cross-day-v1', 'foreign', undefined]) {
    let observed = 0, disposed = 0; const logs = [];
    const prior = owner ? Object.freeze({ owner, observe() { observed++; }, dispose() { disposed++; }, snapshot: () => ({}) }) : undefined;
    const context = vm.createContext({ __lkPreview350Observer: prior });
    const run = vm.compileFunction(applyPreview363Body(source, artifact), ['msg', 'node'], { parsingContext: context });
    const msg = { unchanged: true }; assert.strictEqual(run(msg, { warn: s => logs.push(s) }), msg);
    if (owner === 'preview-cross-day-v1') {
      context.__lkPreview350Observer.observe(message(), 'preview_router', { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' });
      assert.equal(observed, 1); context.__lkPreview350Observer.dispose(); assert.equal(disposed, 1);
      assert(logs.some(s => s.includes('preview_empty_tariff_observer_unavailable')));
    } else assert.strictEqual(context.__lkPreview350Observer, prior);
    assert(!logs.some(s => s.includes('private-marker')));
  }
});
