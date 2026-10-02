import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { compose, replaceExact, TARGET, BOOKING_ID, PREVIEW_ID, sha256 } from '../patch_live_lk1_pro_training_discount.mjs';

const fixture = process.env.LK_PRO_TRAINING_DISCOUNT_LIVE_SNAPSHOT;
const raw = fixture ? fs.readFileSync(fixture) : null;
const result = raw ? compose(raw) : null;
const candidate = result ? JSON.parse(result.candidate) : null;
const run = (name, fn) => test(name, { skip: !candidate && 'Requires private exact live source snapshot' }, fn);
test('PRO release rejects a changed source and absent or duplicated anchors', () => {
  assert.throws(() => compose(Buffer.from('[]')), /source drift/);
  assert.throws(() => replaceExact('missing', 'old', 'new'), /anchor drift/);
  assert.throws(() => replaceExact('old old', 'old', 'new'), /anchor drift/);
  assert.equal(replaceExact('before old after', 'old', 'new'), 'before new after');
});
run('the release is deterministic and changes exactly two function fields', () => {
  assert.equal(sha256(raw), TARGET.source);
  assert.equal(sha256(compose(raw).candidate), sha256(result.candidate));
  const previewBody = candidate.find(node => node.id === PREVIEW_ID).func;
  const restriction = "if (eventRoute && eventRoute.category === 'group_training' && isTopokratyExercise(exercise))";
  assert.ok(previewBody.includes(restriction));
  assert.ok(previewBody.indexOf(restriction) < previewBody.indexOf('if (!available.length)'));
  const original = JSON.parse(raw);
  const changes = candidate.filter((node, i) => JSON.stringify(node) !== JSON.stringify(original[i]));
  assert.deepEqual(changes.map(node => node.id).sort(), [BOOKING_ID, PREVIEW_ID].sort());
  for (const changed of changes) {
    const before = original.find(node => node.id === changed.id);
    assert.deepEqual({ ...changed, func: before.func }, before);
    new Function('msg', 'node', 'global', changed.func);
  }
});
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = uuid(1), sub = uuid(2), exerciseId = uuid(3), room = uuid(4), studio = uuid(5), oneTime = uuid(6);
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const ACADEMY = '9eb8a7a4-c195-492a-95e4-3fb82899ac10';
const key = (kind, ...ids) => JSON.stringify([kind, 'iSkq6G', ...ids]);
const execute = (source, msg, globals) => vm.runInNewContext(`(function(){${source}\n})()`, {
  msg, global: { get: name => globals[name] }, Date, Intl, Set, Map, JSON, Buffer,
});
function preview(productId, options = {}) {
  const node = name => candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_' + name).func;
  const rule = { productId, planKey: 'ra', enforceFrom: '2026-09-01', maxActiveBookings: 4,
    freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const globals = { subscriptions_lk1_plan_rules: { formatVersion: 1, rules: [rule] } };
  const exercise = { id: exerciseId, type: { id: 605 }, direction: { id: 5507, name: 'Тренировка ПРО C' },
    room: { id: room }, studio: { id: studio }, timeFrom: '2099-09-21T08:00:00+03:00', timeTo: '2099-09-21T09:00:00+03:00',
    availableClientSubscriptions: [], ...options.exercise };
  const owned = { id: sub, subscriptionId: sub, clientId: actor, productId, product: { id: productId },
    status: 'ACTIVE', purchaseDate: '2026-09-02', activationDate: '2026-09-02', expirationDate: '2100-01-01', visitsLeft: options.visitsLeft ?? 40 };
  let msg = { payload: { target: { targetKind: 'GROUP_TRAINING', exerciseId } }, req: { headers: { authorization: 'Bearer fixture' } } };
  execute(node('entry'), msg, globals);
  const decisions = [];
  for (let hop = 0; hop < 80; hop++) {
    const outputs = execute(node('router'), msg, globals);
    const output = outputs.findIndex(Boolean);
    assert.ok(output >= 0);
    msg = outputs[output];
    const ctx = msg._subscriptionPricePreview;
    if (output === 4) return { ctx, decisions };
    if (output === 3) {
      execute(node('evaluate'), msg, globals);
      decisions.push(structuredClone(msg._managedSubscriptionPolicyDecision));
    } else if (output === 0) {
      assert.equal(msg.method, 'GET', 'advisory preview must never mutate a provider');
      const responses = { profile: { id: actor }, groupExercise: exercise,
        subscriptions: { content: [owned], totalElements: 1, last: true }, activeBookings: [], historyBookings: [],
        groupTariff: [{ id: oneTime, name: 'Разовая', cost: 550000, productType: 'SERVICE' }] };
      assert.ok(ctx.step in responses, 'unexpected provider step: ' + ctx.step);
      msg.statusCode = 200; msg.responseUrl = msg.url; msg.payload = responses[ctx.step];
    } else if (output === 1) {
      msg.payload = ctx.step === 'metadata'
        ? [{ _id: key('instance', actor, sub), kind: 'instance', tenantKey: 'iSkq6G', actorClientId: actor, subscriptionId: sub, productId }]
        : [{ _id: key('product', productId), kind: 'product', tenantKey: 'iSkq6G', productId, name: 'Fixture subscription' }];
    } else if (output === 2) msg.payload = [];
    else assert.fail('unexpected output');
  }
  assert.fail('preview did not terminate');
}
run('the actual composed preview quotes 2750 for RA and Academy without consuming a visit', () => {
  for (const productId of [RA, ACADEMY]) for (const visitsLeft of [0, 40]) {
    const { ctx, decisions } = preview(productId, { visitsLeft });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.quotes.length, 1);
    assert.equal(ctx.quotes[0].amountMinor, 275000);
    assert.equal(ctx.quotes[0].discountPercent, 50);
    assert.equal(decisions[0].subscriptionVisitCount, 0);
  }
});
run('the actual composed preview retains ordinary first-free and Topokraty exclusions', () => {
  const ordinary = preview(RA, { exercise: { direction: { id: 1001, name: 'Обычная тренировка' } } });
  assert.equal(ordinary.ctx.error, undefined);
  assert.equal(ordinary.ctx.quotes[0].amountMinor, 0);
  assert.equal(ordinary.decisions[0].subscriptionVisitCount, 1);
  const topokraty = preview(RA, { exercise: { direction: { id: 6233, name: 'Топократы' }, type: { id: 2349 } } });
  assert.ok(topokraty.ctx.error || topokraty.ctx.quotes.every(q => q.status !== 'AVAILABLE'));
});
