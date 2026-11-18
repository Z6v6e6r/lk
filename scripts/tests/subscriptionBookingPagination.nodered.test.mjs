import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';

const bookingSource = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const previewSource = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
const roots = ['collectVivaBookingPage', 'extractItems', 'hasCompleteBookingList', 'isObj', 'bookingId',
  'bookingClientId', 'normalizeId', 'mergeBookings', 'isInactiveBooking'];
const pure = extractSubscriptionPricePreviewSource({ source: bookingSource, roots });
const canonical = new Function(`${pure.source}\nreturn {${roots.join(',')}};`)();
const collect = canonical.collectVivaBookingPage;
const base = 'https://api.vivacrm.ru/end-user/api/v2/fixture/bookings?size=1000';
const row = id => ({ id: `booking-${id}`, clientId: 'owner' });
const firstRows = Array.from({ length: 1000 }, (_, i) => row(i));
const page = (number = 0, extra = {}) => ({ content: number ? [row(1000)] : firstRows,
  number, totalElements: 1001, totalPages: 2, last: number === 1, ...extra });
const options = (number = 0, extra = {}) => ({ actorId: 'owner', binding: '[fixture,owner,active]', baseUrl: base,
  method: 'GET', requestUrl: base + (number ? `&page=${number}` : ''),
  responseUrl: base + (number ? `&page=${number}` : ''), now: 1000, deadlineAt: 26000, ...extra });

test('collector joins 1000+1 rows, preserves first receipt and has no transport dependencies', () => {
  const first = collect(page(), null, options());
  assert.equal(first.complete, false);
  const last = collect(page(1), first.state, options(1, { now: 2000 }));
  assert.equal(last.complete, true);
  assert.deepEqual(last.rows, [...firstRows, row(1000)]);
  assert.equal(last.state.observedAt, new Date(1000).toISOString());
  assert(!pure.names.some(name => ['msg', 'ctx', 'prepareUserGet', 'global'].includes(name)));
});

test('collector refuses malformed, drifting, foreign and duplicate continuation pages', () => {
  const first = collect(page(), null, options());
  const bad = [
    { number: 0 }, { totalElements: 1002 }, { totalPages: 3 }, { last: false }, { hasNext: true },
    { content: [null] }, { content: [{}] }, { content: [{ ...row(1000), clientId: 'other' }] },
    { content: [{ ...row(0), id: ' BOOKING-0 ' }] }, { content: [] },
  ];
  for (const extra of bad) assert(collect(page(1, extra), first.state, options(1)).error, JSON.stringify(extra));
  for (const extra of [{ method: 'POST' }, { requestUrl: base }, { responseUrl: base },
    { actorId: 'other' }, { binding: 'history' }, { baseUrl: base + '&foreign=1' },
    { now: 26000 }, { deadlineAt: 27000 }]) {
    assert(collect(page(1), first.state, options(1, extra)).error, JSON.stringify(extra));
  }
  for (const extra of [{ totalPages: 11 }, { totalElements: 10001 }, { number: 1 },
    { content: [] }, { content: Array.from({ length: 1001 }, (_, i) => row(i)) }]) {
    assert(collect(page(0, extra), null, options()).error);
  }
});

test('collector accepts bounded final page, legacy missing owner, and stops at ten pages', () => {
  let state;
  for (let i = 0; i < 10; i++) {
    const result = collect(page(i, { content: [{ id: `only-${i}` }], totalElements: 10,
      totalPages: 10, last: i === 9 }), state, options(i));
    assert(!result.error);
    assert.equal(result.complete, i === 9);
    state = result.state;
  }
  assert(collect(page(10), state, options(10)).error);
});

const preview = new Function('msg', 'canonical', 'global', 'node', previewSource);
const booking = new Function('msg', 'global', bookingSource);
const globals = { get: key => key === 'vivacrm_access_token' ? 'fixture-service-token' : null };
function setup(kind, stage = 'active', overrides = {}) {
  const ctx = { tenantKey: 'fixture', actorClientId: 'owner', auth: 'Bearer fixture-user',
    authHeader: 'Bearer fixture-user', startedAt: Date.now(), caller: 'http', action: 'book',
    clientSubscriptionId: 'subscription', exerciseId: 'exercise', serviceDate: '2099-01-01',
    operationKey: 'fixture-operation', planKey: 'sport', category: 'open_game', limitMode: 'shared_day',
    activePayload: [], activeBookingsPayload: [], ruleProductIds: [], ...overrides };
  ctx.step = kind === 'preview' ? (stage === 'active' ? 'activeBookings' : 'historyBookings')
    : (stage === 'active' ? 'active_bookings' : 'history_bookings');
  const url = stage === 'active' ? base : base.replace('?size=', '/history?includeCanceled=true&size=');
  const msg = { method: 'GET', url, responseUrl: url, statusCode: 200, payload: page(),
    [kind === 'preview' ? '_subscriptionPricePreview' : '_subscriptionBooking']: ctx };
  const run = () => kind === 'preview' ? preview(msg, canonical, globals, { log() {} }) : booking(msg, globals);
  return { ctx, msg, run, reply(payload, extra = {}) {
    Object.assign(msg, { payload, statusCode: 200, responseUrl: msg.url }, extra);
    return run();
  } };
}
for (const kind of ['preview', 'booking']) {
  test(`${kind}: active and history pagination finishes reads before any claim/create, matching a full snapshot`, () => {
    const flow = setup(kind);
    const initial = flow.run();
    assert.equal(initial[0], flow.msg);
    assert.equal(flow.msg.url, base + '&page=1');
    assert(flow.msg.requestTimeout > 0 && flow.msg.requestTimeout <= 10000);
    const observed = kind === 'preview' ? flow.ctx.activeObservedAt : flow.ctx.activeBookingsObservedAt;
    const history = flow.reply(page(1));
    assert.equal(history[0], flow.msg);
    assert.equal(flow.msg.url, base.replace('?size=', '/history?includeCanceled=true&size='));
    const historyRows = firstRows.map(r => ({ ...r, cancelled: true }));
    const anotherPage = flow.reply(page(0, { content: historyRows }));
    assert.equal(anotherPage[0], flow.msg);
    assert(flow.msg.url.endsWith('&page=1'));
    const end = flow.reply(page(1));
    assert.equal(flow.ctx.bookingPages, undefined);
    assert.equal(flow.ctx.bookingsPagesDeadlineAt, undefined);
    if (kind === 'preview') {
      assert.equal(end[2], flow.msg); // Read-only Mongo usage query.
      assert.equal(flow.ctx.cancellationSnapshot.active.length, 1001);
      assert.equal(flow.ctx.cancellationSnapshot.history.length, 1001);
      assert.equal(flow.ctx.cancellationSnapshot.observedAt, observed);
      assert.deepEqual(flow.ctx.bookings, canonical.mergeBookings([...firstRows, row(1000)], [...historyRows, row(1000)]));
    } else {
      assert.equal(flow.ctx.step, 'operation_find');
      assert.equal(flow.ctx.bookingsObservedAt, observed);
      assert.equal(end.filter(Boolean).length, 1);
    }
  });

  for (const stage of ['active', 'history']) {
    test(`${kind}/${stage}: invalid or late second page refuses before Mongo or provider writes`, () => {
      for (const failure of ['foreign', 'duplicate', 'url', 'deadline', 'http', 'shape']) {
        const flow = setup(kind, stage);
        flow.run();
        if (failure === 'deadline') flow.ctx.bookingsPagesDeadlineAt = Date.now() - 1;
        const payload = failure === 'shape' ? [] : page(1, failure === 'foreign'
          ? { content: [{ ...row(1000), clientId: 'other' }] }
          : failure === 'duplicate' ? { content: [row(0)] } : {});
        const output = flow.reply(payload, failure === 'url' ? { responseUrl: base + '&page=8' }
          : failure === 'http' ? { statusCode: 503 } : {});
        if (kind === 'preview') assert.equal(flow.ctx.done, true, failure);
        else assert(flow.msg.statusCode >= 400, failure);
        assert.equal(output[4], flow.msg, failure);
        assert.equal(output.filter(Boolean).length, 1);
        assert.equal(output[0], null, failure);
        assert.notEqual(flow.ctx.step, 'operation_find');
      }
    });
  }

  test(`${kind}: expired shared budget refuses a complete first history page after active pagination`, () => {
    for (const complete of [[], { content: [], totalElements: 0, last: true }]) {
      const flow = setup(kind);
      flow.run();
      flow.reply(page(1));
      flow.ctx.bookingsPagesDeadlineAt = Date.now() - 1;
      const output = flow.reply(complete);
      assert.equal(output[4], flow.msg);
      assert(flow.msg.statusCode >= 400 || flow.ctx.statusCode >= 400);
      assert.notEqual(flow.ctx.step, 'operation_find');
    }
  });

  test(`${kind}: page timeout restores the original override before any later phase`, () => {
    for (const timeout of [undefined, 45000]) {
      const flow = setup(kind, 'history');
      if (timeout !== undefined) flow.msg.requestTimeout = timeout;
      flow.run();
      const deadline = Date.now() + 500;
      flow.ctx.bookingsPagesDeadlineAt = deadline;
      flow.ctx.bookingPages.deadlineAt = deadline;
      const output = flow.reply(page(1));
      assert.equal(output[kind === 'preview' ? 2 : 1], flow.msg);
      assert.equal(flow.msg.requestTimeout, timeout);
      assert.equal(Object.hasOwn(flow.msg, 'requestTimeout'), timeout !== undefined);
      assert.equal(flow.ctx.bookingPagesRequestTimeout, undefined);
    }
  });

  test(`${kind}: single active and paginated history retain original read order`, () => {
    const flow = setup(kind);
    flow.msg.payload = [];
    flow.run();
    assert.equal(flow.reply(page())[0], flow.msg);
    assert.equal(flow.reply(page(1))[kind === 'preview' ? 2 : 1], flow.msg);
    assert.equal(flow.ctx.bookingPages, undefined);
  });

  test(`${kind}: existing complete arrays keep single-page behavior`, () => {
    const flow = setup(kind);
    flow.msg.payload = [];
    assert.equal(flow.run()[0], flow.msg);
    assert(!flow.msg.url.includes('&page='));
    assert.equal(flow.ctx.bookingPages, undefined);
  });
}

test('preview with an older canonical generation refuses an incomplete page safely', () => {
  const flow = setup('preview');
  const old = { ...canonical };
  delete old.collectVivaBookingPage;
  const output = preview(flow.msg, old, globals, { log() {} });
  assert.equal(output[4], flow.msg);
  assert.equal(flow.ctx.error, 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
});

test('managed self-leave accepts only the exact bound continuation URL', () => {
  for (const wrong of [false, true]) {
    const flow = setup('booking', 'active', { managedSelfLeave: { schemaVersion: 1 } });
    assert.equal(flow.run()[0], flow.msg);
    const output = flow.reply(page(1), wrong ? { responseUrl: base + '&page=9' } : {});
    if (wrong) {
      assert.equal(output[4], flow.msg);
      assert.equal(flow.msg.payload.details.code, 'MANAGED_SELF_LEAVE_PROVIDER_READ_INVALID');
    } else {
      assert.equal(output[0], flow.msg);
      assert.equal(flow.ctx.step, 'history_bookings');
    }
  }
});

test('a daily-limit conflict on the final history page is enforced before any claim', () => {
  const flow = setup('booking', 'history');
  flow.run();
  const last = { ...row(1000), clientSubscriptionId: 'subscription', paymentType: 'SUBSCRIPTION',
    exerciseId: 'different-exercise', serviceDate: '2099-01-01', exerciseType: { id: 1613 } };
  assert.equal(flow.reply(page(1, { content: [last] }))[4], flow.msg);
  assert.equal(flow.msg.payload.details.code, 'SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED');
});
