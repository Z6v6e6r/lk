import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { composeSubscriptionBookingPagination, applyPaginationEdits, assertPrivatePaginationOutput,
  subscriptionBookingPaginationEdits, subscriptionPreviewPaginationEdits } from '../prepare_subscription_booking_pagination.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const reverse = (source, edits) => applyPaginationEdits(source, edits.slice().reverse().map(([a, b]) => [b, a]));
function fixture() {
  const booking = reverse(read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'), subscriptionBookingPaginationEdits());
  // Preview pagination gets its pure helper through the generated canonical closure.
  const preview = read('../nodered_subscription_price_preview_nodes/router.js');
  const paginationStart = preview.indexOf('// Collect pages before');
  const paginationEnd = preview.indexOf("if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {", paginationStart);
  const legacyPreview = preview.slice(0, paginationStart) + preview.slice(paginationEnd);
  const oldPreview = legacyPreview.replace('ctx.activeObservedAt ||=', 'ctx.activeObservedAt =')
    .replace('  delete ctx.bookingsPagesDeadlineAt;\n', '');
  return [
    { id: 'fixture-tab', type: 'tab' },
    { id: 'lk_subscription_booking_router_20260804', type: 'function', z: 'fixture-tab', func: booking, outputs: 7, wires: [[], [], [], [], [], [], []] },
    { id: 'lk_subscription_price_preview_20260908_router', type: 'function', z: 'fixture-tab', func: oldPreview, outputs: 6, wires: [[], [], [], [], [], []] },
    { id: 'unrelated', type: 'function', z: 'fixture-tab', func: 'return msg;', outputs: 1, wires: [[]] },
  ];
}
function options(bytes) {
  const f = JSON.parse(bytes);
  return { release: 'a'.repeat(40), expectedSourceSha256: sha(bytes),
    expectedBookingSha256: sha(f[1].func), expectedPreviewSha256: sha(f[2].func) };
}
test('offline candidate changes only the two exact function bodies and recovers all preimages', () => {
  const flow = fixture(), bytes = Buffer.from(JSON.stringify(flow));
  const result = composeSubscriptionBookingPagination(bytes, options(bytes));
  const candidate = JSON.parse(result.candidateBytes);
  assert.equal(candidate[1].func, read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'));
  for (const index of [1, 2]) {
    assert.deepEqual({ ...candidate[index], func: flow[index].func }, flow[index]);
  }
  assert.deepEqual(candidate[3], flow[3]);
  assert.equal(result.report.preimagesRecoverExactly, true);
  assert.equal(result.contract.allowedAdditions.length, 0);
  assert.match(candidate[2].func, /Object.assign\(canonical/);
  const restored = reverse(candidate[2].func, subscriptionPreviewPaginationEdits());
  assert.equal(restored, flow[2].func);
});

test('source, router, anchor, duplicate-id, disabled and repeat-apply drift stop candidate preparation', () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  const original = options(bytes);
  assert.throws(() => composeSubscriptionBookingPagination(bytes, { ...original, release: 'branch-name' }));
  assert.throws(() => composeSubscriptionBookingPagination(bytes, { ...original, expectedSourceSha256: '0'.repeat(64) }));
  for (const mutate of [f => { f[1].func += '\n// drift'; }, f => { f[1].d = true; },
    f => { f[0].disabled = true; }, f => { f.push(f[1]); }]) {
    const f = fixture(); mutate(f);
    const changed = Buffer.from(JSON.stringify(f));
    assert.throws(() => composeSubscriptionBookingPagination(changed, { ...original, expectedSourceSha256: sha(changed) }));
  }
  const f = fixture(); f[1].func = f[1].func.replace('Список активных записей Viva неполон', 'drift');
  const changed = Buffer.from(JSON.stringify(f));
  assert.throws(() => composeSubscriptionBookingPagination(changed, options(changed)), /ANCHOR_DRIFT/);
  const result = composeSubscriptionBookingPagination(bytes, original);
  assert.throws(() => composeSubscriptionBookingPagination(result.candidateBytes, options(result.candidateBytes)));
});

const privatePath = process.env.LK_BOOKING_PAGINATION_FLOW_FIXTURE;
test('private installed composition rehearses exact selective upgrade without exporting its source', {
  skip: !privatePath && 'Requires private installed flow fixture; never copied into Git',
}, () => {
  const bytes = fs.readFileSync(privatePath);
  const f = JSON.parse(bytes);
  const config = { release: 'a'.repeat(40), expectedSourceSha256: sha(bytes),
    expectedBookingSha256: sha(f.find(n => n.id === 'lk_subscription_booking_router_20260804').func),
    expectedPreviewSha256: sha(f.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func) };
  const result = composeSubscriptionBookingPagination(bytes, config);
  assert.equal(result.report.changedNodeCount, 2);
  // Replay the actual installed composed functions with synthetic provider data.
  const candidate = JSON.parse(result.candidateBytes);
  for (const [id, key, stage] of [
    ['lk_subscription_booking_router_20260804', '_subscriptionBooking', 'history_bookings'],
    ['lk_subscription_price_preview_20260908_router', '_subscriptionPricePreview', 'historyBookings'],
  ]) {
    const ctx = { step: stage, tenantKey: 'fixture', actorClientId: 'owner', auth: 'Bearer fixture', authHeader: 'Bearer fixture',
      startedAt: Date.now(), activePayload: [], activeBookingsPayload: [], ruleProductIds: [], caller: 'http',
      action: 'book', operationKey: 'fixture', clientSubscriptionId: 'fixture-subscription', planKey: 'sport', serviceDate: '2099-01-01' };
    const url = 'https://api.vivacrm.ru/end-user/api/v2/fixture/bookings/history?includeCanceled=true&size=1000';
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `synthetic-${i}`, clientId: 'owner' }));
    const msg = { [key]: ctx, statusCode: 200, method: 'GET', url, responseUrl: url,
      payload: { content: rows, number: 0, totalElements: 1001, totalPages: 2, last: false } };
    const execute = new Function('msg', 'global', 'env', 'node', candidate.find(n => n.id === id).func);
    const globals = { get: k => k === 'vivacrm_access_token' ? 'synthetic-service' : null };
    const run = () => execute(msg, globals, { get: () => undefined }, { log() {}, warn() {}, error() {} });
    assert.equal(run()[0], msg);
    assert.equal(msg.url, url + '&page=1');
    Object.assign(msg, { statusCode: 200, responseUrl: msg.url,
      payload: { content: [{ id: 'synthetic-last', clientId: 'owner' }], number: 1, totalElements: 1001, totalPages: 2, last: true } });
    assert.equal(run()[key === '_subscriptionBooking' ? 1 : 2], msg);
    assert.equal(ctx.bookingPages, undefined);
    assert.equal(msg.requestTimeout, undefined);
  }
});

test('private output must be outside repository and live workspace, even with trailing slash', () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pagination-path-')));
  try {
    const directory = name => { const p = path.join(temp, name); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p; };
    const repository = directory('repo'), workspace = directory('live');
    const output = directory('out');
    assertPrivatePaginationOutput(repository + '/', workspace, output);
    for (const p of [repository, directory('repo/ignored'), workspace, directory('live/output')]) {
      assert.throws(() => assertPrivatePaginationOutput(repository + '/', workspace, p), /PRIVATE_OUTPUT/);
    }
    const link = path.join(temp, 'link'); fs.symlinkSync(output, link);
    assert.throws(() => assertPrivatePaginationOutput(repository, workspace, link));
    fs.chmodSync(output, 0o755);
    assert.throws(() => assertPrivatePaginationOutput(repository, workspace, output));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
