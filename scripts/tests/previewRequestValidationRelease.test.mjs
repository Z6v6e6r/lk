import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createPreviewRequestValidationObserver } from '../diagnostics/preview-request-validation-observer.mjs';
import { diagnosticContract } from '../../src/utils/errorDiagnosticsCore.mjs';
import { composePreviewRequestValidationRelease, previewValidationLifecycle } from '../prepare_preview_request_validation_release.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const release = 'a'.repeat(40), sourceHash = 'b'.repeat(64), entryHash = 'c'.repeat(64);
const request = () => ({ statusCode: 400, _msgid: 'SYNTHETIC_PRIVATE',
  req: { path: '/SYNTHETIC_PRIVATE', headers: { authorization: 'SYNTHETIC_PRIVATE' }, query: { private: 'SYNTHETIC_PRIVATE' } },
  payload: { private: 'SYNTHETIC_PRIVATE' },
  _lkDiagnosticContext: { requestId: 'SYNTHETIC_PRIVATE' },
  _subscriptionPricePreview: { done: true, statusCode: 400, error: 'PRICE_PREVIEW_REQUEST_INVALID',
    firstFailedValidationPredicate: 'BODY_EXTRA_KEYS', validationFieldShape: 'OBJECT', target: 'SYNTHETIC_PRIVATE' } });

test('validation-only observer filters before budget and sends only bounded fields through the bundled runtime', () => {
  const events = [];
  const observer = createPreviewRequestValidationObserver({ sink: event => events.push(event), release, sourceHash, detailLimit: 1 });
  for (let i = 0; i < 1000; i++) observer.observe(request(), 'preview_router');
  for (const [field, value] of [['done', false], ['error', 'PRICE_PREVIEW_AUTH_REQUIRED']]) {
    const msg = request(); msg._subscriptionPricePreview[field] = value; observer.observe(msg, 'preview_final');
  }
  const wrongStatus = request(); wrongStatus.statusCode = 503; observer.observe(wrongStatus, 'preview_final');
  assert.equal(observer.snapshot().observed, 0);
  observer.observe(request(), 'preview_final');
  assert.equal(events.length, 1);
  assert.equal(events[0].firstFailedValidationPredicate, 'BODY_EXTRA_KEYS');
  assert.equal(events[0].validationFieldShape, 'OBJECT');
  assert.equal(events[0].sourceHash, sourceHash);
  assert.equal(events[0].httpStatus, 400);
  assert(!JSON.stringify(events).includes('SYNTHETIC_PRIVATE'));
  for (const field of ['entityRef', 'operationRef', 'bindingRef', 'outboxRef']) assert.equal(events[0][field], undefined);
  observer.observe(request(), 'preview_final');
  assert.equal(events.length, 1); assert.equal(observer.snapshot().suppressed, 1);
  observer.dispose();
});

test('observer accepts all reviewed predicate/shape enums and bounds forged values', () => {
  const events = [];
  const observer = createPreviewRequestValidationObserver({ sink: e => events.push(e), release, sourceHash });
  for (const predicate of diagnosticContract.enums.firstFailedValidationPredicate) {
    const msg = request(); msg._subscriptionPricePreview.firstFailedValidationPredicate = predicate;
    observer.observe(msg, 'preview_final'); assert.equal(events.at(-1).firstFailedValidationPredicate, predicate);
  }
  for (const shape of diagnosticContract.enums.validationFieldShape) {
    const msg = request(); msg._subscriptionPricePreview.validationFieldShape = shape;
    observer.observe(msg, 'preview_final'); assert.equal(events.at(-1).validationFieldShape, shape);
  }
  const forged = request(); Object.assign(forged._subscriptionPricePreview, {
    firstFailedValidationPredicate: 'SYNTHETIC_PRIVATE', validationFieldShape: 'SYNTHETIC_PRIVATE' });
  observer.observe(forged, 'preview_final');
  assert.equal(events.at(-1).firstFailedValidationPredicate, 'UNKNOWN');
  assert.equal(events.at(-1).validationFieldShape, 'UNKNOWN');
  assert(!JSON.stringify(events).includes('SYNTHETIC_PRIVATE')); observer.dispose();
  assert.doesNotThrow(() => createPreviewRequestValidationObserver({ sink() { throw Error('private'); }, sourceHash }).observe(request(), 'preview_final'));
});

function lifecycleVm(lifecycle, extra = {}) {
  const events = [];
  const context = vm.createContext({ Buffer, preview389Crypto: crypto, preview389Performance: { performance },
    setTimeout, clearTimeout, ...extra });
  const node = { warn: text => events.push(JSON.parse(text.slice(text.indexOf('{')))) };
  const execute = field => vm.compileFunction(lifecycle[field], ['node'], { parsingContext: context })(node);
  return { context, events, node, execute };
}
test('final VM lifecycle initializes matching schema/bundle, disposes own observer and preserves foreign slots', () => {
  const lifecycle = previewValidationLifecycle(release, sourceHash, entryHash);
  const run = lifecycleVm(lifecycle);
  run.execute('initialize'); assert.deepEqual(run.events[0], lifecycle.marker);
  assert.equal(run.context.__lkPreview389Observer.owner, 'preview-request-validation-v1');
  const first = run.context.__lkPreview389Observer;
  run.execute('initialize'); assert.notEqual(run.context.__lkPreview389Observer, first);
  run.context.__lkPreview389Observer.observe(request(), 'preview_final');
  assert.equal(run.events.at(-1).event, 'preview_request_validation_guard_diagnostic');
  assert.equal(run.events.at(-1).validationFieldShape, 'OBJECT');
  run.execute('finalize'); run.execute('finalize'); assert.equal(run.context.__lkPreview389Observer, undefined);
  const foreign = { owner: 'foreign', dispose() { assert.fail('Foreign observer must survive'); } };
  run.context.__lkPreview389Observer = foreign; run.execute('initialize'); run.execute('finalize');
  assert.equal(run.context.__lkPreview389Observer, foreign);
  assert.equal(run.events.at(-1).event, 'preview_request_validation_observer_unavailable');
  for (const extra of [{ preview389Crypto: {} }, { preview389Performance: {} }]) {
    const broken = lifecycleVm(lifecycle, extra); broken.execute('initialize');
    assert.equal(broken.events.at(-1).event, 'preview_request_validation_observer_unavailable');
    assert.equal(broken.context.__lkPreview389Observer, undefined);
  }
});

test('activation rejects source drift before parsing or candidate construction', () => {
  assert.throws(() => composePreviewRequestValidationRelease(Buffer.from('[]'), release), /FLOW_DRIFT/);
  assert.throws(() => composePreviewRequestValidationRelease(Buffer.from('[]'), 'invalid'), /COMMIT_REQUIRED/);
});

const fixture = process.env.PREVIEW389_LIVE_FIXTURE;
test('exact private live candidate changes only two nodes and preserves final legacy response/warning', { skip: !fixture && 'Requires private fresh live preimage; never commit full flows' }, () => {
  const raw = fs.readFileSync(fixture), before = JSON.parse(raw);
  const packet = composePreviewRequestValidationRelease(raw, release), after = JSON.parse(packet.candidateBytes);
  assert.equal(packet.report.changedNodeCount, 2);
  const changed = after.filter((n, i) => JSON.stringify(n) !== JSON.stringify(before[i]));
  assert.equal(changed.length, 2);
  const final = changed.find(n => n.id.endsWith('_final'));
  const entry = changed.find(n => n.id.endsWith('_entry'));
  assert.equal(hash(final.func), packet.marker.sourceHash); assert.equal(hash(entry.func), packet.marker.entryHash);
  const original = before.find(n => n.id === final.id);
  const sandbox = lifecycleVm({ initialize: final.initialize, finalize: final.finalize });
  sandbox.execute('initialize');
  const runFinal = vm.compileFunction(final.func, ['msg', 'node'], { parsingContext: sandbox.context });
  const runOriginal = new Function('msg', 'node', original.func);
  for (const code of ['PRICE_PREVIEW_REQUEST_INVALID', 'PRICE_PREVIEW_AUTH_REQUIRED', 'PRICE_PREVIEW_UNAVAILABLE']) {
    const msg = request(); msg._subscriptionPricePreview.error = code;
    const baseline = structuredClone(msg), expectedWarnings = [], actualWarnings = [];
    runOriginal(baseline, { warn: x => expectedWarnings.push(x) });
    const start = sandbox.events.length;
    runFinal(msg, { warn: x => actualWarnings.push(x) });
    // Node warn is VM-local during initialization; compare only the unchanged legacy warning here.
    assert.deepEqual(structuredClone(msg), baseline); assert.deepEqual(actualWarnings, expectedWarnings);
    assert.equal(sandbox.events.length - start, code === 'PRICE_PREVIEW_REQUEST_INVALID' ? 1 : 0);
  }
  const missing = new Function('msg', 'node', final.func), msg = request(), baseline = structuredClone(msg);
  missing(msg, { warn() {} }); runOriginal(baseline, { warn() {} }); assert.deepEqual(msg, baseline);
  sandbox.execute('finalize');
  assert.throws(() => composePreviewRequestValidationRelease(Buffer.concat([raw, Buffer.from('\n')]), release), /FLOW_DRIFT/);
});
